//! The detail of a task is kept for one state of the vault: a second look
//! costs no engine question, a change of the vault empties the table.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use appkit_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::Env;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{start, HubStatus, Limits, RunningServer, ServerConfig, WatchConfig};
use tasks_hub::store::RefreshOptions;

struct Rig {
    server: RunningServer,
    vault: PathBuf,
    token: String,
}

async fn rig(name: &str) -> Rig {
    let vault = std::env::temp_dir().join(format!(
        "tasks-desktop-detail-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&vault);
    std::fs::create_dir_all(vault.join("alpha.nvim").join("ROADMAP").join("tasks")).unwrap();
    std::fs::write(vault.join(".fake-n"), "2").unwrap();
    let engine: Arc<dyn Engine> = Arc::new(CliEngine::new(CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: vault.join("scripts").join("tasks.lua"),
        vault: vault.clone(),
        lib_dir: None,
        extra_areas: vec![],
        env: Env::from_process(),
        timeout: Duration::from_secs(10),
        max_queue: 16,
        max_reply_bytes: 4 * 1024 * 1024,
    }));
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
            capabilities: Vec::new(),
        },
        engine: Some(engine),
        policy: Arc::new(AreaPolicy::default()),
        usage: None,
        ui: tasks_hub::ui::UiFiles::none(),
        watch: Some(WatchConfig {
            vault: vault.clone(),
            refresh: RefreshOptions {
                debounce: Duration::from_millis(100),
                max_wait: Duration::from_secs(1),
                interval: Duration::from_secs(300),
            },
        }),
    })
    .await
    .unwrap();
    let addr: SocketAddr = server.addr();
    let port = addr.port();
    let auth = format!("Bearer {}", control.to_hex());
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
    let token = serde_json::from_str::<Value>(&reply.body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    Rig {
        server,
        vault,
        token,
    }
}

async fn task(r: &Rig, id: &str) -> (u16, Value) {
    let auth = format!("Bearer {}", r.token);
    let reply = client::request(
        r.server.addr().port(),
        "GET",
        &format!("/api/tasks/task?id={id}"),
        &[("Authorization", &auth)],
        "",
    )
    .await
    .unwrap();
    let doc = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
    (reply.status, doc)
}

fn calls(vault: &Path) -> usize {
    std::fs::read_to_string(vault.join(".fake-task-calls"))
        .map(|t| t.lines().count())
        .unwrap_or(0)
}

fn touch(vault: &Path, file: &str) {
    std::fs::write(
        vault
            .join("alpha.nvim")
            .join("ROADMAP")
            .join("tasks")
            .join(file),
        "---
title: x
status: open
---
",
    )
    .unwrap();
}

#[tokio::test]
async fn a_second_look_at_a_task_costs_no_engine_question_until_the_vault_changes() {
    let r = rig("kept").await;
    // Every `task` question is counted (and takes no time).
    std::fs::write(r.vault.join(".fake-task-ms"), "0").unwrap();

    // The page has its list before it opens a task; the hub holds that state.
    let auth = format!("Bearer {}", r.token);
    let reply = client::request(
        r.server.addr().port(),
        "GET",
        "/api/tasks/snapshot",
        &[("Authorization", &auth)],
        "",
    )
    .await
    .unwrap();
    assert_eq!(reply.status, 200);

    let (status, first) = task(&r, "alpha.nvim/t1").await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(calls(&r.vault), 1);
    let (_, again) = task(&r, "alpha.nvim/t1").await;
    assert_eq!(again, first);
    assert_eq!(calls(&r.vault), 1, "the second look came from the table");

    // Another task is another question.
    task(&r, "alpha.nvim/t2").await;
    assert_eq!(calls(&r.vault), 2);

    // The vault changes: the table is emptied with the state it was for.
    std::fs::write(r.vault.join(".fake-n"), "3").unwrap();
    touch(&r.vault, "new-task.md");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (_, doc) = task(&r, "alpha.nvim/t1").await;
        if doc["rev"] != first["rev"] {
            break;
        }
        assert!(Instant::now() < deadline, "the new state was not seen");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(calls(&r.vault) >= 3, "asked again for the new state");
}

#[tokio::test]
async fn a_hub_that_holds_no_snapshot_keeps_nothing_and_fetches_no_scan_for_a_task() {
    let r = rig("cold").await;
    std::fs::write(r.vault.join(".fake-task-ms"), "0").unwrap();
    std::fs::write(r.vault.join(".fake-calls"), "").ok();
    task(&r, "alpha.nvim/t1").await;
    task(&r, "alpha.nvim/t1").await;
    // Both looks went to the engine: there was no state to key them by.
    assert_eq!(calls(&r.vault), 2);
    // And asking for a task did not make the hub scan the whole vault.
    let scans = std::fs::read_to_string(r.vault.join(".fake-calls"))
        .map(|t| t.lines().count())
        .unwrap_or(0);
    assert_eq!(scans, 0, "no snapshot was fetched for a task");
}
