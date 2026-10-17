//! The data routes behind the guard, with the fake engine: what they pass
//! on, what they add (the class of an area), what they refuse.
//! The real engine is exercised end to end in `tasks-hub/tests/cli.rs`.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use appkit_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use serde_json::Value;
use tasks_hub::classes::{AreaPolicy, Class, Entry};
use tasks_hub::client;
use tasks_hub::config::Env;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{start, HubStatus, Limits, RunningServer, ServerConfig};

struct Hub {
    server: RunningServer,
    control: String,
    token: Option<String>,
}

fn fake_engine() -> Arc<dyn Engine> {
    let dir = std::env::temp_dir();
    Arc::new(CliEngine::new(CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: dir.join("scripts").join("tasks.lua"),
        vault: dir,
        lib_dir: None,
        extra_areas: vec![],
        env: Env::from_process(),
        timeout: Duration::from_secs(10),
        max_queue: 8,
        max_reply_bytes: 1024 * 1024,
    }))
}

fn policy() -> Arc<AreaPolicy> {
    let mut map = BTreeMap::new();
    map.insert(
        "alpha.nvim".to_owned(),
        Entry {
            class: Class::Internal,
            repo: Some("alpha.nvim".to_owned()),
        },
    );
    map.insert(
        "secret-area".to_owned(),
        Entry {
            class: Class::Private,
            repo: None,
        },
    );
    Arc::new(AreaPolicy::new(map).unwrap())
}

async fn hub(engine: Option<Arc<dyn Engine>>, status: HubStatus) -> Hub {
    let control = Secret::generate(TOKEN_BYTES).unwrap();
    let cfg = ServerConfig {
        addr: "127.0.0.1:0".parse().unwrap(),
        limits: Limits {
            snapshot_max_age: Some(Duration::ZERO),
            ..Limits::default()
        },
        clock: Arc::new(ManualClock::new()),
        pairing_ttl: Duration::from_secs(60),
        control_secret: control.clone(),
        instance: Secret::generate(CODE_BYTES).unwrap(),
        status,
        engine,
        policy: policy(),
        usage: None,
        ui: tasks_hub::ui::UiFiles::none(),
        watch: None,
    };
    let server = start(cfg).await.unwrap();
    let mut h = Hub {
        server,
        control: control.to_hex(),
        token: None,
    };
    h.token = Some(session(&h).await);
    h
}

fn ready() -> HubStatus {
    HubStatus {
        engine_ready: true,
        problem: None,
        capabilities: Vec::new(),
    }
}

fn port(h: &Hub) -> u16 {
    let addr: SocketAddr = h.server.addr();
    addr.port()
}

async fn session(h: &Hub) -> String {
    let auth = format!("Bearer {}", h.control);
    let r = client::request(
        port(h),
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
    let code = serde_json::from_str::<Value>(&r.body).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    let origin = format!("http://127.0.0.1:{}", port(h));
    let r = client::request(
        port(h),
        "POST",
        "/auth/exchange",
        &[("Content-Type", "application/json"), ("Origin", &origin)],
        &format!(r#"{{"code":"{code}"}}"#),
    )
    .await
    .unwrap();
    serde_json::from_str::<Value>(&r.body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn get(h: &Hub, path: &str, extra: &[(&str, &str)]) -> client::Reply {
    let auth = format!("Bearer {}", h.token.as_ref().unwrap());
    let mut headers = vec![("Authorization", auth.as_str())];
    headers.extend_from_slice(extra);
    client::request(port(h), "GET", path, &headers, "")
        .await
        .unwrap()
}

#[tokio::test]
async fn areas_say_what_class_they_are_shown_with() {
    let h = hub(Some(fake_engine()), ready()).await;
    let r = get(&h, "/api/tasks/areas", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    let doc: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(doc["kind"], "hub.areas");
    let class_of = |name: &str| {
        doc["areas"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .unwrap_or_else(|| panic!("{name} missing: {doc}"))["data_class"]
            .clone()
    };
    assert_eq!(class_of("alpha.nvim"), "internal");
    assert_eq!(class_of("secret-area"), "private");
    // beta.nvim is in the vault and not in the file: marked, not hidden.
    assert_eq!(class_of("beta.nvim"), "unclassified");
    assert_eq!(doc["unclassified"], serde_json::json!(["beta.nvim"]));
    assert_eq!(doc["private"], serde_json::json!(["secret-area"]));
    // The engine's own fields are still there.
    assert!(doc["areas"][0]["open"].is_number());
}

#[tokio::test]
async fn without_an_engine_the_data_routes_say_so_and_hello_still_answers() {
    let status = HubStatus {
        engine_ready: false,
        problem: Some("no_vault"),
        capabilities: Vec::new(),
    };
    let h = hub(None, status).await;
    for path in [
        "/api/tasks/snapshot",
        "/api/tasks/areas",
        "/api/tasks/task?id=a/b",
        "/api/tasks/next",
    ] {
        let r = get(&h, path, &[]).await;
        assert_eq!(r.status, 503, "{path}: {r:?}");
        let doc: Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(doc["error"]["code"], "engine_unavailable");
        assert_eq!(doc["error"]["problem"], "no_vault");
    }
    let hello = client::request(port(&h), "GET", "/api/tasks/hello", &[], "")
        .await
        .unwrap();
    assert_eq!(hello.status, 200);
    let hello: Value = serde_json::from_str(&hello.body).unwrap();
    assert_eq!(hello["engine"]["ready"], false);
    assert_eq!(hello["engine"]["problem"], "no_vault");
}

#[tokio::test]
async fn hello_tells_what_the_engine_can_do() {
    let status = HubStatus {
        engine_ready: true,
        problem: None,
        capabilities: vec!["hello".to_owned(), "reorder".to_owned()],
    };
    let h = hub(None, status).await;
    let hello = client::request(port(&h), "GET", "/api/tasks/hello", &[], "")
        .await
        .unwrap();
    let hello: Value = serde_json::from_str(&hello.body).unwrap();
    assert_eq!(
        hello["engine"]["capabilities"],
        serde_json::json!(["hello", "reorder"])
    );
}

#[tokio::test]
async fn a_refusal_of_the_engine_keeps_its_code() {
    let h = hub(Some(fake_engine()), ready()).await;
    let r = get(&h, "/api/tasks/task?id=alpha.nvim/missing", &[]).await;
    assert_eq!(r.status, 404, "{r:?}");
    let doc: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(doc["error"]["code"], "not_found");
    assert_eq!(doc["error"]["message"], "no such task");
    assert_eq!(doc["error"]["retryable"], false);
}

#[tokio::test]
async fn the_snapshot_has_an_etag_and_answers_not_modified() {
    let h = hub(Some(fake_engine()), ready()).await;
    let first = get(&h, "/api/tasks/snapshot", &[]).await;
    assert_eq!(first.status, 200, "{first:?}");
    assert_eq!(first.header("etag"), Some("\"sha256:00000000000000aa\""));
    assert_eq!(first.header("cache-control"), Some("no-store"));
    let doc: Value = serde_json::from_str(&first.body).unwrap();
    assert_eq!(doc["tasks"][0]["id"], "alpha.nvim/one");

    for seen in [
        "\"sha256:00000000000000aa\"",
        "W/\"sha256:00000000000000aa\"",
        "*",
        "\"other\", \"sha256:00000000000000aa\"",
    ] {
        let r = get(&h, "/api/tasks/snapshot", &[("If-None-Match", seen)]).await;
        assert_eq!(r.status, 304, "{seen}: {r:?}");
        assert!(r.body.is_empty());
        assert_eq!(r.header("etag"), Some("\"sha256:00000000000000aa\""));
    }
    for seen in ["\"other\"", "sha256:00000000000000aa", ""] {
        let r = get(&h, "/api/tasks/snapshot", &[("If-None-Match", seen)]).await;
        assert_eq!(r.status, 200, "{seen:?}: {r:?}");
    }
}

#[tokio::test]
async fn next_passes_only_what_was_asked_and_with_the_right_types() {
    let h = hub(Some(fake_engine()), ready()).await;
    let r = get(&h, "/api/tasks/next?n=3&actor=cdx&area=alpha.nvim", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    let doc: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        doc["echoed"],
        serde_json::json!({ "n": 3, "actor": "cdx", "area": "alpha.nvim" })
    );
    let r = get(&h, "/api/tasks/next", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(
        serde_json::from_str::<Value>(&r.body).unwrap()["echoed"],
        serde_json::json!({})
    );
}

#[tokio::test]
async fn queries_that_are_not_plain_are_refused_before_the_engine() {
    let h = hub(Some(fake_engine()), ready()).await;
    for path in [
        "/api/tasks/next?n=-1",
        "/api/tasks/next?n=11",
        "/api/tasks/next?n=1.5",
        "/api/tasks/next?n=1&n=2",
        "/api/tasks/next?area=..",
        "/api/tasks/next?area=a/b",
        "/api/tasks/next?unknown=1",
        "/api/tasks/next?n",
        "/api/tasks/next?n=%31",
        "/api/tasks/next?actor=a+b",
        "/api/tasks/task?id=",
        "/api/tasks/task?id=a/.hidden",
        "/api/tasks/task?id=a/b%2fc",
        "/api/tasks/task?id=/b",
        "/api/tasks/task?id=a/",
        "/api/tasks/areas?x=1",
        "/api/tasks/links?x=1",
        "/api/tasks/links?area=a",
        "/api/tasks/finished?x=1",
        "/api/tasks/finished?limit=abc",
        "/api/tasks/finished?offset=-1",
        "/api/tasks/finished?area=a&area=b",
        "/api/tasks/snapshot?x=1",
    ] {
        let r = get(&h, path, &[]).await;
        assert_eq!(r.status, 400, "{path}: {r:?}");
    }
}

#[tokio::test]
async fn about_names_the_build_and_the_engine_and_no_path() {
    let h = hub(Some(fake_engine()), ready()).await;
    let r = get(&h, "/api/tasks/about", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    let doc: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(doc["kind"], "hub.about");
    assert_eq!(doc["app"], "tasks-desktop");
    assert!(doc["version"].as_str().is_some_and(|v| !v.is_empty()));
    assert!(doc["os"].as_str().is_some_and(|v| !v.is_empty()));
    assert!(doc["arch"].as_str().is_some_and(|v| !v.is_empty()));
    // The three words of the engine's hello, as the fake engine says them.
    assert_eq!(doc["engine"]["version"], "0.0.0-fake");
    assert_eq!(doc["engine"]["git"], "0000000");
    assert_eq!(doc["engine"]["nvim"], "0.12.2");
    assert_eq!(doc["pinned"]["engine"].as_str().map(str::len), Some(40));
    assert_eq!(doc["pinned"]["lib"].as_str().map(str::len), Some(40));
    // The fake engine runs in the temp folder; no part of that path may leave the hub (ENG-06).
    let temp = std::env::temp_dir().to_string_lossy().replace('\\', "/");
    assert!(
        !r.body
            .replace('\\', "/")
            .contains(temp.trim_end_matches('/')),
        "{}",
        r.body
    );
    assert!(!r.body.contains("vault"), "{}", r.body);
    // A query is refused like on every other data route.
    let r = get(&h, "/api/tasks/about?x=1", &[]).await;
    assert_eq!(r.status, 400, "{r:?}");
}

#[tokio::test]
async fn about_without_an_engine_still_names_the_build() {
    let status = HubStatus {
        engine_ready: false,
        problem: Some("no_vault"),
        capabilities: Vec::new(),
    };
    let h = hub(None, status).await;
    let r = get(&h, "/api/tasks/about", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    let doc: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(doc["kind"], "hub.about");
    assert!(doc["engine"].is_null(), "{doc}");
    assert!(doc["version"].as_str().is_some_and(|v| !v.is_empty()));
    assert_eq!(doc["pinned"]["engine"].as_str().map(str::len), Some(40));
}
