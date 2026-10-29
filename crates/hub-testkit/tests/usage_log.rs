//! The usage log, seen from a real event stream: one visit, the minutes it
//! was open, and nothing else in the file.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use appkit_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use hub_testkit::scratch::Scratch;
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::Env;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{start, HubStatus, Limits, ServerConfig};
use tasks_hub::usage::UsageLog;

mod common;
use common::Sse;

#[tokio::test]
async fn a_stream_is_a_visit_and_the_file_holds_counts_only() {
    let dir = Scratch::new("usage-it");
    let log_path = dir.join("usage.json");

    let engine: Arc<dyn Engine> = Arc::new(CliEngine::new(CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: dir.join("scripts").join("tasks.lua"),
        vault: dir.to_path_buf(),
        lib_dir: None,
        extra_areas: vec![],
        env: Env::from_process(),
        timeout: Duration::from_secs(10),
        max_queue: 8,
        max_reply_bytes: 1024 * 1024,
    }));
    let control = Secret::generate(TOKEN_BYTES).unwrap();
    let server = start(ServerConfig {
        addr: "127.0.0.1:0".parse().unwrap(),
        limits: Limits::default(),
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
        usage: Some(Arc::new(UsageLog::open(Some(log_path.clone())))),
        ui: tasks_hub::ui::UiFiles::none(),
        watch: None,
    })
    .await
    .unwrap();
    let addr = server.addr();
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

    // No stream, no visit.
    assert!(!log_path.exists());

    let mut first = Sse::open(addr, Some(&token)).await.unwrap();
    let _hello = first.next(Duration::from_secs(5)).await.unwrap();
    // A reload: the second stream is the same visit.
    let mut second = Sse::open(addr, Some(&token)).await.unwrap();
    let _hello = second.next(Duration::from_secs(5)).await.unwrap();
    drop(first);
    drop(second);

    // The streams end with their connections; the file is written then.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let text = std::fs::read_to_string(&log_path).expect("a usage file");
    let doc: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(doc["schema"], 1);
    let days = doc["days"].as_object().unwrap();
    assert_eq!(days.len(), 1);
    let day = days.values().next().unwrap().as_object().unwrap();
    assert_eq!(day["visits"], 1);
    assert_eq!(day.len(), 2, "{day:?}");
    // Nothing of the vault, the areas or the session.
    let text = doc.to_string();
    assert!(!text.contains(&token) && !text.contains("lib.nvim"));
}
