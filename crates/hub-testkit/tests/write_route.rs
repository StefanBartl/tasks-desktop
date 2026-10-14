//! The write route: the form is checked at the door, the engine does the
//! work, a write is followed by a scan before the answer, and a dry run is
//! none.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

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
    rig_with(name, Limits::default()).await
}

async fn rig_with(name: &str, limits: Limits) -> Rig {
    let vault =
        std::env::temp_dir().join(format!("tasks-desktop-write-{name}-{}", std::process::id()));
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
            ..limits
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

async fn post(r: &Rig, path: &str, body: &str, content_type: &str, session: bool) -> (u16, Value) {
    let auth = format!("Bearer {}", r.token);
    let origin = format!("http://127.0.0.1:{}", r.server.addr().port());
    let mut headers: Vec<(&str, &str)> = vec![("Content-Type", content_type), ("Origin", &origin)];
    if session {
        headers.push(("Authorization", &auth));
    }
    let reply = client::request(r.server.addr().port(), "POST", path, &headers, body)
        .await
        .unwrap();
    (
        reply.status,
        serde_json::from_str(&reply.body).unwrap_or(Value::Null),
    )
}

async fn get(r: &Rig, path: &str) -> (u16, Value) {
    let auth = format!("Bearer {}", r.token);
    let reply = client::request(
        r.server.addr().port(),
        "GET",
        path,
        &[("Authorization", &auth)],
        "",
    )
    .await
    .unwrap();
    (
        reply.status,
        serde_json::from_str(&reply.body).unwrap_or(Value::Null),
    )
}

const JSON: &str = "application/json";

#[tokio::test]
async fn a_write_goes_through_and_the_next_read_is_the_new_state() {
    let r = rig("write").await;
    let (_, before) = get(&r, "/api/tasks/snapshot").await;

    let body = r#"{"client_op_id":"c-1","ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"status":"doing"}}]}"#;
    let (status, doc) = post(&r, "/api/tasks/ops", body, JSON, true).await;
    assert_eq!(status, 200, "{doc}");
    assert_eq!(doc["kind"], "tasks.result");
    assert_eq!(doc["client_op_id"], "c-1");
    assert_eq!(doc["results"][0]["outcome"], "changed");

    // The scan ran before the answer: the very next read is the new state.
    let (_, after) = get(&r, "/api/tasks/snapshot").await;
    assert_ne!(
        before["rev"], after["rev"],
        "the hub answered from the old state"
    );
}

#[tokio::test]
async fn a_dry_run_changes_and_scans_nothing() {
    let r = rig("dry").await;
    let (_, before) = get(&r, "/api/tasks/snapshot").await;
    let calls_before = std::fs::read_to_string(r.vault.join(".fake-calls"))
        .unwrap_or_default()
        .lines()
        .count();
    let body =
        r#"{"dry_run":true,"ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"status":"doing"}}]}"#;
    let (status, doc) = post(&r, "/api/tasks/ops", body, JSON, true).await;
    assert_eq!(status, 200, "{doc}");
    assert_eq!(doc["dry_run"], true);
    assert_eq!(doc["results"][0]["outcome"], "would_change");
    let (_, after) = get(&r, "/api/tasks/snapshot").await;
    assert_eq!(before["rev"], after["rev"]);
    let calls_after = std::fs::read_to_string(r.vault.join(".fake-calls"))
        .unwrap_or_default()
        .lines()
        .count();
    assert_eq!(calls_before, calls_after, "a dry run made the hub scan");
}

#[tokio::test]
async fn a_dry_run_costs_the_writes_nothing() {
    // The pairing of the rig takes two of the mutations: two writes are left.
    let r = rig_with(
        "dry-free",
        Limits {
            post_max: 4,
            ops_max: 100,
            ..Limits::default()
        },
    )
    .await;
    let dry =
        r#"{"dry_run":true,"ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"status":"doing"}}]}"#;
    let write = r#"{"ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"status":"doing"}}]}"#;
    for _ in 0..10 {
        assert_eq!(post(&r, "/api/tasks/ops", dry, JSON, true).await.0, 200);
    }
    for _ in 0..2 {
        assert_eq!(post(&r, "/api/tasks/ops", write, JSON, true).await.0, 200);
    }
    let (status, doc) = post(&r, "/api/tasks/ops", write, JSON, true).await;
    assert_eq!(
        (status, doc["error"]["code"].as_str()),
        (429, Some("rate_limited"))
    );
    // A request that is none is a write, too.
    assert_eq!(post(&r, "/api/tasks/ops", "{}", JSON, true).await.0, 429);
    // The dry runs are still free of the limit of the writes.
    assert_eq!(post(&r, "/api/tasks/ops", dry, JSON, true).await.0, 200);
}

#[tokio::test]
async fn the_ops_route_has_a_limit_of_its_own_in_the_guard_before_the_credential() {
    // Everything sent to `ops`, dry runs included, counts: three, then the limit. The pairing of the
    // rig went to other routes and did not count here.
    let r = rig_with(
        "ops-limit",
        Limits {
            ops_max: 3,
            ..Limits::default()
        },
    )
    .await;
    let dry =
        r#"{"dry_run":true,"ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"status":"doing"}}]}"#;
    // Without a session: the limit comes before the credential (rule SRV-02), so it counts them too.
    assert_eq!(post(&r, "/api/tasks/ops", dry, JSON, false).await.0, 401);
    for _ in 0..2 {
        assert_eq!(post(&r, "/api/tasks/ops", dry, JSON, true).await.0, 200);
    }
    let (status, doc) = post(&r, "/api/tasks/ops", dry, JSON, true).await;
    assert_eq!(
        (status, doc["error"]["code"].as_str()),
        (429, Some("rate_limited"))
    );
    assert_eq!(post(&r, "/api/tasks/ops", dry, JSON, false).await.0, 429);
}

#[tokio::test]
async fn a_plan_may_be_asked_for_and_an_unknown_operation_is_not() {
    let r = rig("plan").await;
    let body = r#"{"dry_run":true,"ops":[{"op":"plan_new","area":"alpha.nvim","title":"A plan"}]}"#;
    let (status, doc) = post(&r, "/api/tasks/ops", body, JSON, true).await;
    assert_eq!(status, 200, "the door refused plan_new: {doc}");
    // The two that change the text of a task are let through as well (the engine judges them).
    for body in [
        r#"{"dry_run":true,"ops":[{"op":"tick_step","id":"alpha.nvim/t1","n":1}]}"#,
        r#"{"dry_run":true,"ops":[{"op":"append_note","id":"alpha.nvim/t1","text":"a note"}]}"#,
        r#"{"dry_run":true,"ops":[{"op":"reopen","id":"alpha.nvim/t1"}]}"#,
    ] {
        let (status, doc) = post(&r, "/api/tasks/ops", body, JSON, true).await;
        assert_eq!(status, 200, "the door refused {body}: {doc}");
    }
    // An operation the door does not know is still refused.
    let unknown = r#"{"ops":[{"op":"plan_delete","id":"alpha.nvim/p"}]}"#;
    let (status, _) = post(&r, "/api/tasks/ops", unknown, JSON, true).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn a_request_that_is_plainly_not_one_is_refused_at_the_door() {
    let r = rig("form").await;
    let many: String = (0..101)
        .map(|i| format!(r#"{{"op":"set","id":"alpha.nvim/t{i}","patch":{{}}}}"#))
        .collect::<Vec<_>>()
        .join(",");
    let too_many = format!(r#"{{"ops":[{many}]}}"#);
    let cases: Vec<(&str, String)> = vec![
        ("not json", "{not json".to_owned()),
        ("a list", "[]".to_owned()),
        ("no ops", "{}".to_owned()),
        ("empty ops", r#"{"ops":[]}"#.to_owned()),
        ("ops not a list", r#"{"ops":{}}"#.to_owned()),
        (
            "unknown field",
            r#"{"ops":[{"op":"set"}],"x":1}"#.to_owned(),
        ),
        (
            "unknown op",
            r#"{"ops":[{"op":"rm","id":"a/b"}]}"#.to_owned(),
        ),
        ("op missing", r#"{"ops":[{"id":"a/b"}]}"#.to_owned()),
        (
            "a bad op id",
            r#"{"client_op_id":"a b","ops":[{"op":"set"}]}"#.to_owned(),
        ),
        (
            "dry_run text",
            r#"{"dry_run":"yes","ops":[{"op":"set"}]}"#.to_owned(),
        ),
        ("more than 100", too_many),
    ];
    for (name, body) in cases {
        let (status, doc) = post(&r, "/api/tasks/ops", &body, JSON, true).await;
        assert_eq!(status, 400, "{name}: {doc}");
        assert_eq!(doc["error"]["code"], "bad_request", "{name}");
    }
    // Nothing of that reached the engine.
    assert!(
        !r.vault.join(".fake-n").exists()
            || std::fs::read_to_string(r.vault.join(".fake-n")).unwrap() == "2"
    );
}

#[tokio::test]
async fn a_write_needs_a_session_and_json() {
    let r = rig("door").await;
    let body = r#"{"ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"prio":1}}]}"#;
    let (status, _) = post(&r, "/api/tasks/ops", body, JSON, false).await;
    assert_eq!(status, 401);
    let (status, _) = post(&r, "/api/tasks/ops", body, "text/plain", true).await;
    assert_eq!(status, 415);
    // A read is not a write: the route takes no GET with a body of its own.
    let (status, _) = get(&r, "/api/tasks/ops").await;
    assert_eq!(status, 405);
    // The vault stayed as it was.
    assert_eq!(
        std::fs::read_to_string(r.vault.join(".fake-n")).unwrap(),
        "2"
    );
}

#[tokio::test]
async fn the_preview_of_finishing_a_task_is_read_only_and_checks_the_id() {
    let r = rig("preview").await;
    let (status, doc) = get(&r, "/api/tasks/done_preview?id=alpha.nvim/t1").await;
    assert_eq!(status, 200, "{doc}");
    assert_eq!(doc["kind"], "tasks.donepreview");
    assert_eq!(doc["confirm"], "confirm-fake");
    for bad in ["", "?id=", "?id=../x", "?id=a", "?id=a/b/c", "?x=1"] {
        let (status, _) = get(&r, &format!("/api/tasks/done_preview{bad}")).await;
        assert_eq!(status, 400, "{bad:?}");
    }
    assert_eq!(
        std::fs::read_to_string(r.vault.join(".fake-n")).unwrap(),
        "2"
    );
}

#[tokio::test]
async fn the_estimate_route_refuses_what_is_plainly_not_a_question_and_asks_the_engine_otherwise() {
    let r = rig("estimate").await;
    let many: String = (0..1001)
        .map(|i| format!(r#""alpha.nvim/t{i}""#))
        .collect::<Vec<_>>()
        .join(",");
    let cases: Vec<(&str, String)> = vec![
        ("not json", "{not json".to_owned()),
        ("a list", "[]".to_owned()),
        ("unknown field", r#"{"colour":1}"#.to_owned()),
        ("ids not a list", r#"{"ids":"alpha.nvim/t1"}"#.to_owned()),
        ("a bad id", r#"{"ids":["not an id"]}"#.to_owned()),
        ("an id that is no text", r#"{"ids":[1]}"#.to_owned()),
        ("too many ids", format!(r#"{{"ids":[{many}]}}"#)),
        ("assume not a list", r#"{"assume":{}}"#.to_owned()),
        ("assume entry not an object", r#"{"assume":[1]}"#.to_owned()),
        (
            "assume without an id",
            r#"{"assume":[{"value":3}]}"#.to_owned(),
        ),
        (
            "assume with an unknown field",
            r#"{"assume":[{"id":"alpha.nvim/t1","colour":"red"}]}"#.to_owned(),
        ),
        (
            "an effort that is no short word",
            r#"{"assume":[{"id":"alpha.nvim/t1","effort":"a very long word indeed"}]}"#.to_owned(),
        ),
        (
            "a value that is no whole number",
            r#"{"assume":[{"id":"alpha.nvim/t1","value":2.5}]}"#.to_owned(),
        ),
    ];
    for (name, body) in cases {
        let (status, doc) = post(&r, "/api/tasks/estimate", &body, JSON, true).await;
        assert_eq!(status, 400, "{name}: {doc}");
        assert_eq!(doc["error"]["code"], "bad_request", "{name}");
    }
    // A question the form allows goes to the engine and its document comes back as it is.
    let body =
        r#"{"ids":["alpha.nvim/t1"],"assume":[{"id":"alpha.nvim/t1","effort":"M","value":4}]}"#;
    let (status, doc) = post(&r, "/api/tasks/estimate", body, JSON, true).await;
    assert_eq!(status, 200, "{doc}");
    assert_eq!(doc["kind"], "tasks.estimate");
    // It needs a session and JSON, like every route that takes a body, and a GET is no question.
    assert_eq!(
        post(&r, "/api/tasks/estimate", body, JSON, false).await.0,
        401
    );
    assert_eq!(
        post(&r, "/api/tasks/estimate", body, "text/plain", true)
            .await
            .0,
        415
    );
    assert_eq!(get(&r, "/api/tasks/estimate").await.0, 405);
}

#[tokio::test]
async fn a_question_of_estimate_costs_the_writes_nothing() {
    let r = rig("estimate-limit").await;
    // More questions than the strict limit of the writes (60 in the window) are answered ...
    for i in 0..80 {
        let (status, doc) = post(&r, "/api/tasks/estimate", "{}", JSON, true).await;
        assert_eq!(status, 200, "question {i}: {doc}");
    }
    // ... and a write still goes through.
    let body = r#"{"ops":[{"op":"set","id":"alpha.nvim/t1","patch":{"prio":1}}]}"#;
    let (status, doc) = post(&r, "/api/tasks/ops", body, JSON, true).await;
    assert_eq!(status, 200, "{doc}");
}
