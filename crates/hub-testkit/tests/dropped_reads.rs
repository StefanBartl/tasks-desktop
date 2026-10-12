//! A read that nobody waits for any more is not started: a client that
//! passes over tasks (j j j j) must not leave the engine reading each of
//! them. Seen at the server, through real connections and the one engine
//! that runs one question at a time.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::Env;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{start, HubStatus, Limits, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[tokio::test]
async fn a_request_that_is_dropped_while_it_waits_never_reaches_the_engine() {
    let vault = std::env::temp_dir().join(format!("tasks-desktop-dropped-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&vault);
    std::fs::create_dir_all(&vault).unwrap();
    // Every `task` read takes 400 ms and is counted when it starts.
    std::fs::write(vault.join(".fake-task-ms"), "400").unwrap();

    let engine: Arc<dyn Engine> = Arc::new(CliEngine::new(CliEngineConfig {
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: vault.join("scripts").join("tasks.lua"),
        vault: vault.clone(),
        lib_dir: None,
        extra_areas: vec![],
        env: Env::from_process(),
        timeout: Duration::from_secs(10),
        max_queue: 16,
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
        },
        engine: Some(engine),
        policy: Arc::new(AreaPolicy::default()),
        usage: None,
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

    // Five reads at once: the first starts, the others wait their turn.
    let mut streams = Vec::new();
    for i in 0..5 {
        let mut s = TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET /api/tasks/task?id=alpha.nvim/t{i} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n"
        );
        s.write_all(request.as_bytes()).await.unwrap();
        streams.push(s);
        // In this order into the queue.
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    // The three in the middle are passed over.
    tokio::time::sleep(Duration::from_millis(60)).await;
    for _ in 0..3 {
        drop(streams.remove(1));
    }
    // The first and the last are waited for, and answered.
    for mut s in streams {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        let got = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let n = s.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n")
                    && String::from_utf8_lossy(&buf).contains("\"task\"")
                {
                    break;
                }
            }
        })
        .await;
        assert!(got.is_ok(), "no answer");
        assert!(
            String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 200"),
            "{}",
            String::from_utf8_lossy(&buf)
        );
    }

    let calls =
        std::fs::read_to_string(vault.join(".fake-task-calls")).map_or(0, |t| t.lines().count());
    assert_eq!(calls, 2, "reads that nobody waited for were started");
    let _ = std::fs::remove_dir_all(&vault);
}
