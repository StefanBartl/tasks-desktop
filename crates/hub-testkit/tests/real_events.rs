//! The whole chain against the real engine: a change to a task file in a
//! (copy of the) fixture vault reaches an open event stream. The concept's
//! bound is two seconds from the change to the event.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::{Env, FileConfig};
use tasks_hub::discovery::{discover, SetupProblem};
use tasks_hub::engine::{probe, CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{start, HubStatus, Limits, ServerConfig, WatchConfig};
use tasks_hub::store::RefreshOptions;

mod common;
use common::Sse;

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("e2e")
        .join("fixture")
        .join("vault")
}

async fn session(addr: SocketAddr, control: &str) -> String {
    let auth = format!("Bearer {control}");
    let port = addr.port();
    let reply = client::request(
        port,
        "POST",
        "/api/control/pair",
        &[
            ("Content-Type", "application/json"),
            ("Authorization", &auth),
        ],
        "{}",
    )
    .await
    .unwrap();
    let code = serde_json::from_str::<Value>(&reply.body).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let origin = format!("http://127.0.0.1:{port}");
    let reply = client::request(
        port,
        "POST",
        "/auth/exchange",
        &[("Content-Type", "application/json"), ("Origin", &origin)],
        &format!(r#"{{"code":"{code}"}}"#),
    )
    .await
    .unwrap();
    serde_json::from_str::<Value>(&reply.body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn an_edit_of_a_task_file_reaches_the_stream_within_two_seconds() {
    let vault =
        std::env::temp_dir().join(format!("tasks-desktop-real-events-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&vault);
    copy_dir(&fixture(), &vault);

    let env = Env::from_process();
    let file = FileConfig {
        vault: Some(vault.clone()),
        extra_areas: ["ALL", "nvim-config", "docmap-desktop", "migrate.nvim"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
        ..FileConfig::default()
    };
    let setup = match discover(&file, &env).await {
        Ok(s) => s,
        Err(
            p @ (SetupProblem::NvimNotFound { .. }
            | SetupProblem::NvimTooOld { .. }
            | SetupProblem::NvimProbeFailed(_)
            | SetupProblem::EngineNotFound { .. }
            | SetupProblem::LibNotFound { .. }),
        ) => {
            assert!(
                std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_none(),
                "the engine is required but not usable: {p}"
            );
            eprintln!("skipped: {p}");
            return;
        }
        Err(other) => panic!("{other}"),
    };
    let engine = CliEngine::new(CliEngineConfig::from_setup(&setup, env));
    probe(&engine).await.expect("the engine answers hello");
    let engine: Arc<dyn Engine> = Arc::new(engine);

    let control = Secret::generate(TOKEN_BYTES).unwrap();
    let server = start(ServerConfig {
        addr: "127.0.0.1:0".parse().unwrap(),
        limits: Limits {
            snapshot_max_age: None,
            ..Limits::default()
        },
        clock: Arc::new(ManualClock::new()),
        pairing_ttl: Duration::from_secs(60),
        control_secret: control.clone(),
        instance: Secret::generate(CODE_BYTES).unwrap(),
        status: HubStatus {
            engine_ready: true,
            problem: None,
        },
        engine: Some(engine),
        policy: Arc::new(AreaPolicy::default()),
        ui: tasks_hub::ui::UiFiles::none(),
        watch: Some(WatchConfig {
            vault: vault.clone(),
            refresh: RefreshOptions::default(),
        }),
    })
    .await
    .unwrap();
    let addr = server.addr();
    let token = session(addr, &control.to_hex()).await;

    let mut sse = Sse::open(addr, Some(&token)).await.unwrap();
    let hello = sse.next(Duration::from_secs(20)).await.expect("a hello");
    assert!(hello.starts_with("event: hello"), "{hello:?}");

    // The snapshot a client holds before the change.
    let auth = format!("Bearer {token}");
    let before = client::request(
        addr.port(),
        "GET",
        "/api/tasks/snapshot",
        &[("Authorization", &auth)],
        "",
    )
    .await
    .unwrap();
    let before_etag = before.header("etag").expect("an ETag").to_owned();

    // Change a task file the way an editor does: write it in place.
    let path = vault
        .join("lib.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join("alpha.md");
    let text = std::fs::read_to_string(&path).unwrap();
    let edited = text.replacen("status: open", "status: doing", 1);
    assert_ne!(text, edited, "the fixture task has no status: open");
    let started = Instant::now();
    std::fs::write(&path, edited).unwrap();

    let change = sse
        .next_change(Duration::from_secs(10))
        .await
        .expect("an event");
    let took = started.elapsed();
    assert!(
        change["changed_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "lib.nvim/alpha"),
        "{change}"
    );
    assert_eq!(change["cause"], "fs");
    assert!(took < Duration::from_secs(2), "took {took:?}");

    // The ETag moved, and a client that sends the old one gets the new document.
    let after = client::request(
        addr.port(),
        "GET",
        "/api/tasks/snapshot",
        &[("Authorization", &auth), ("If-None-Match", &before_etag)],
        "",
    )
    .await
    .unwrap();
    assert_eq!(after.status, 200, "{:?}", after.status);
    assert_ne!(after.header("etag"), Some(before_etag.as_str()));
    let _ = std::fs::remove_dir_all(&vault);
}
