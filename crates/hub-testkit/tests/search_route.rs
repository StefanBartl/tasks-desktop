//! The text search through the server: the index is built in the
//! background, answers a query with where the words are, and follows a
//! change of the vault.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
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
        "tasks-desktop-search-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&vault);
    std::fs::create_dir_all(vault.join("alpha.nvim").join("ROADMAP").join("tasks")).unwrap();
    std::fs::write(vault.join(".fake-n"), "2").unwrap();
    let engine: Arc<dyn Engine> = Arc::new(CliEngine::new(CliEngineConfig {
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

async fn search(r: &Rig, query: &str) -> (u16, Value) {
    let auth = format!("Bearer {}", r.token);
    let reply = client::request(
        r.server.addr().port(),
        "GET",
        &format!("/api/tasks/search?{query}"),
        &[("Authorization", &auth)],
        "",
    )
    .await
    .unwrap();
    let doc = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
    (reply.status, doc)
}

/// Ask until the index says it is there (it is built a moment after start).
async fn until_ready(r: &Rig) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (status, doc) = search(r, "q=zebra").await;
        assert_eq!(status, 200, "{doc}");
        if doc["status"] == "ready" {
            return doc;
        }
        assert!(Instant::now() < deadline, "the index was not built: {doc}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn touch(vault: &Path, file: &str) {
    std::fs::write(
        vault
            .join("alpha.nvim")
            .join("ROADMAP")
            .join("tasks")
            .join(file),
        "---\ntitle: x\nstatus: open\n---\n",
    )
    .unwrap();
}

#[tokio::test]
async fn the_text_is_searched_in_the_hub_and_the_hit_says_where() {
    let r = rig("hits").await;
    let doc = until_ready(&r).await;
    // Three tasks (t0..t2) all hold the shared word.
    assert_eq!(doc["total"], 3, "{doc}");
    assert_eq!(doc["indexed"], 3);

    let (_, one) = search(&r, "q=NEEDLE1").await;
    assert_eq!(one["total"], 1, "{one}");
    let hit = &one["hits"][0];
    assert_eq!(hit["id"], "alpha.nvim/t1");
    let text = hit["snippet"]["text"].as_str().unwrap();
    let units: Vec<u16> = text.encode_utf16().collect();
    let [a, b] = [
        hit["snippet"]["marks"][0][0].as_u64().unwrap() as usize,
        hit["snippet"]["marks"][0][1].as_u64().unwrap() as usize,
    ];
    assert_eq!(String::from_utf16(&units[a..b]).unwrap(), "needle1");
    // The text of the snippet holds no line break.
    assert!(!text.contains('\n'));

    // Words in any order, all of them; and an escaped query.
    let (_, two) = search(&r, "q=zebra%20needle2").await;
    assert_eq!(two["total"], 1);
    let (_, none) = search(&r, "q=zebra%20nothing-like-this").await;
    assert_eq!(none["total"], 0);
    let (_, limited) = search(&r, "q=zebra&limit=2").await;
    assert_eq!(limited["hits"].as_array().unwrap().len(), 2);
    assert_eq!(limited["total"], 3);
}

#[tokio::test]
async fn the_index_follows_a_change_of_the_vault() {
    let r = rig("follow").await;
    until_ready(&r).await;
    // Two more tasks exist from now on, and a file the watcher sees changed.
    std::fs::write(r.vault.join(".fake-n"), "4").unwrap();
    touch(&r.vault, "new-task.md");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (_, doc) = search(&r, "q=needle4").await;
        if doc["total"] == 1 {
            assert_eq!(doc["hits"][0]["id"], "alpha.nvim/t4");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the new text was not found: {doc}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (_, all) = search(&r, "q=zebra").await;
    assert_eq!(all["total"], 5);
}

#[tokio::test]
async fn a_bad_query_is_refused_and_a_session_is_needed() {
    let r = rig("bad").await;
    for q in [
        "",
        "q=",
        "q=a",
        "q=%00%01",
        "q=%E4",
        "q=ab&limit=0",
        "q=ab&x=1",
        "q=a%20b%20c%20d%20e%20f%20g%20h%20i",
    ] {
        let (status, doc) = search(&r, q).await;
        assert_eq!(status, 400, "{q:?}: {doc}");
    }
    let reply = client::request(
        r.server.addr().port(),
        "GET",
        "/api/tasks/search?q=zebra",
        &[],
        "",
    )
    .await
    .unwrap();
    assert_eq!(reply.status, 401);
}
