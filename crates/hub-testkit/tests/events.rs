//! The event stream and what feeds it: the file watcher, the debounce, the
//! timer that catches lost events, the rescan request and the held snapshot.
//!
//! The engine is the fake one. It builds its snapshot from `<vault>/.fake-n`
//! (a number: how many tasks there are), so a test changes "the vault" by
//! writing that file, and it counts its calls in `<vault>/.fake-calls`. The
//! watcher is the real one, on a real folder.

use std::path::{Path, PathBuf};
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

mod common;
use common::Sse;

struct Rig {
    server: RunningServer,
    vault: PathBuf,
    control: String,
    token: String,
}

struct Timing {
    debounce: Duration,
    interval: Duration,
    heartbeat: Duration,
    max_age: Option<Duration>,
    sessions: usize,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(100),
            interval: Duration::from_secs(300),
            heartbeat: Duration::from_secs(15),
            max_age: None,
            sessions: 16,
        }
    }
}

fn unique(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tasks-desktop-events-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos())
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("a.nvim").join("ROADMAP").join("tasks")).unwrap();
    dir
}

fn set_n(vault: &Path, n: u64) {
    std::fs::write(vault.join(".fake-n"), n.to_string()).unwrap();
}

fn calls(vault: &Path) -> usize {
    std::fs::read_to_string(vault.join(".fake-calls")).map_or(0, |t| t.lines().count())
}

fn touch_task(vault: &Path, file: &str) {
    let path = vault
        .join("a.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join(file);
    std::fs::write(path, "---\ntitle: x\nstatus: open\n---\n").unwrap();
}

async fn rig(name: &str, timing: Timing) -> Rig {
    let vault = unique(name);
    set_n(&vault, 0);
    let engine: Arc<dyn Engine> = Arc::new(CliEngine::new(CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: vault.join("scripts").join("tasks.lua"),
        vault: vault.clone(),
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
        limits: Limits {
            snapshot_max_age: timing.max_age,
            heartbeat: timing.heartbeat,
            max_sessions: timing.sessions,
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
                debounce: timing.debounce,
                max_wait: Duration::from_secs(1),
                interval: timing.interval,
            },
        }),
    })
    .await
    .unwrap();
    let mut r = Rig {
        server,
        vault,
        control: control.to_hex(),
        token: String::new(),
    };
    r.token = session(&r).await;
    r
}

fn port(r: &Rig) -> u16 {
    r.server.addr().port()
}

async fn session(r: &Rig) -> String {
    let auth = format!("Bearer {}", r.control);
    let reply = client::request(
        port(r),
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
    let origin = format!("http://127.0.0.1:{}", port(r));
    let reply = client::request(
        port(r),
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

async fn get(r: &Rig, path: &str) -> client::Reply {
    let auth = format!("Bearer {}", r.token);
    client::request(port(r), "GET", path, &[("Authorization", &auth)], "")
        .await
        .unwrap()
}

const WAIT: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(900);

#[tokio::test]
async fn a_stream_starts_with_where_it_stands() {
    let r = rig("hello", Timing::default()).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let first = sse.next(WAIT).await.expect("a hello");
    let data = first
        .strip_prefix("event: hello\ndata: ")
        .unwrap_or_else(|| panic!("{first:?}"));
    let doc: Value = serde_json::from_str(data.trim_end()).unwrap();
    assert_eq!(doc["seq"], 0);
    assert_eq!(doc["rev"], "rev:000000");
    assert_eq!(doc["instance"], r.server.instance());
}

#[tokio::test]
async fn a_change_in_the_vault_is_an_event_with_ids_only() {
    let r = rig("change", Timing::default()).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();

    set_n(&r.vault, 1);
    touch_task(&r.vault, "new-task.md");
    let change = sse.next_change(WAIT).await.expect("a change event");
    assert_eq!(change["cause"], "fs");
    assert_eq!(change["seq"], 1);
    assert_eq!(change["added"], serde_json::json!(["alpha.nvim/t1"]));
    assert_eq!(change["changed_ids"], serde_json::json!([]));
    assert_eq!(change["removed"], serde_json::json!([]));
    // A hint carries ids, never a title or a path.
    assert!(!change.to_string().contains("title"));

    // The snapshot a client then reads is the new one, from memory.
    let snap = get(&r, "/api/tasks/snapshot").await;
    let doc: Value = serde_json::from_str(&snap.body).unwrap();
    assert_eq!(doc["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(snap.header("etag"), Some("\"sha256:0000000000000001\""));
}

#[tokio::test]
async fn a_burst_of_changes_is_one_scan() {
    let r = rig("burst", Timing::default()).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    let before = calls(&r.vault);

    set_n(&r.vault, 3);
    for i in 0..20 {
        touch_task(&r.vault, &format!("t{i}.md"));
    }
    let change = sse.next_change(WAIT).await.expect("one event");
    assert_eq!(change["added"].as_array().unwrap().len(), 3);
    assert!(sse.next_change(QUIET).await.is_none(), "a second event");
    // The engine was asked once for the whole burst.
    assert_eq!(calls(&r.vault) - before, 1);
}

#[tokio::test]
async fn what_tools_leave_behind_does_not_wake_the_scan() {
    let r = rig("leftovers", Timing::default()).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    set_n(&r.vault, 5);
    for name in [
        "x.md~",
        ".x.md.lock",
        "4913",
        "x.tasks-tmp.1.md",
        "x.frontmatter.md",
        "x.md.swp",
        "x.txt",
    ] {
        touch_task(&r.vault, name);
    }
    assert!(
        sse.next_change(QUIET).await.is_none(),
        "a leftover woke the scan"
    );
    // The watcher is alive: a real task file does.
    touch_task(&r.vault, "real.md");
    let change = sse.next_change(WAIT).await.expect("an event");
    assert_eq!(change["cause"], "fs");
}

#[tokio::test]
async fn the_timer_catches_what_the_watcher_did_not_see() {
    let r = rig(
        "timer",
        Timing {
            interval: Duration::from_millis(400),
            ..Timing::default()
        },
    )
    .await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    // Not a file the watcher cares about: only the full scan can see it.
    set_n(&r.vault, 2);
    let change = sse.next_change(WAIT).await.expect("an event");
    assert_eq!(change["cause"], "timer");
    assert_eq!(change["added"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn the_timer_does_not_scan_for_nobody() {
    let r = rig(
        "idle",
        Timing {
            interval: Duration::from_millis(200),
            ..Timing::default()
        },
    )
    .await;
    // Several periods with no stream open: the vault is not scanned.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(calls(&r.vault), 0, "scanned with nobody listening");

    // Once someone listens the net is back.
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    set_n(&r.vault, 2);
    let change = sse.next_change(WAIT).await.expect("an event");
    assert_eq!(change["cause"], "timer");
}

#[tokio::test]
async fn a_folder_task_moved_as_a_whole_is_seen() {
    let r = rig("folder-move", Timing::default()).await;
    let a = r.vault.join("a.nvim");
    let from = a.join("ROADMAP").join("tasks").join("folder-task");
    let backlog = a.join("Backlog").join("TASKS");
    std::fs::create_dir_all(&from).unwrap();
    std::fs::create_dir_all(&backlog).unwrap();
    std::fs::write(from.join("folder-task.md"), "---\ntitle: x\n---\n").unwrap();
    // Let the scan of what was just made pass before the stream is opened.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();

    // What `done` does: the folder is renamed into the backlog. The system
    // reports the folder, not the file in it; the timer is minutes away.
    set_n(&r.vault, 1);
    std::fs::rename(&from, backlog.join("folder-task")).unwrap();
    let change = sse.next_change(WAIT).await.expect("an event");
    assert_eq!(change["cause"], "fs");
}

#[tokio::test]
async fn a_stream_ends_with_its_session() {
    let r = rig(
        "session",
        Timing {
            heartbeat: Duration::from_millis(200),
            sessions: 2,
            ..Timing::default()
        },
    )
    .await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    // The session of the stream is the oldest; two newer ones close it.
    let _second = session(&r).await;
    let _third = session(&r).await;
    assert!(
        sse.ended(Duration::from_secs(3)).await,
        "the stream outlived its session"
    );
    // The session that is still open is not touched.
    let mut other = Sse::open(r.server.addr(), Some(&_third)).await.unwrap();
    let _hello = other.next(WAIT).await.unwrap();
    assert!(!other.ended(Duration::from_millis(700)).await);
}

#[tokio::test]
async fn a_client_can_ask_for_a_scan() {
    let r = rig("rescan", Timing::default()).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    set_n(&r.vault, 4);
    let auth = format!("Bearer {}", r.token);
    let reply = client::request(
        port(&r),
        "POST",
        "/api/tasks/rescan",
        &[
            ("Content-Type", "application/json"),
            ("Authorization", &auth),
        ],
        "{}",
    )
    .await
    .unwrap();
    assert_eq!(reply.status, 202, "{reply:?}");
    let change = sse.next_change(WAIT).await.expect("an event");
    assert_eq!(change["cause"], "rescan");
}

#[tokio::test]
async fn a_state_in_the_middle_of_a_change_is_read_again_before_it_is_shown() {
    let r = rig("transient", Timing::default()).await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    let before = calls(&r.vault);

    // The next answer of the engine has a duplicate id in it, once.
    std::fs::write(r.vault.join(".fake-transient"), "").unwrap();
    set_n(&r.vault, 1);
    touch_task(&r.vault, "moved.md");
    let _change = sse.next_change(WAIT).await.expect("an event");

    assert_eq!(calls(&r.vault) - before, 2, "no second read");
    let snap = get(&r, "/api/tasks/snapshot").await;
    let doc: Value = serde_json::from_str(&snap.body).unwrap();
    assert!(!snap.body.contains("duplicate-id"), "{doc}");
}

#[tokio::test]
async fn the_snapshot_is_served_from_memory() {
    let r = rig("memory", Timing::default()).await;
    set_n(&r.vault, 2);
    for _ in 0..5 {
        let snap = get(&r, "/api/tasks/snapshot").await;
        assert_eq!(snap.status, 200);
    }
    assert_eq!(calls(&r.vault), 1);
    // And a change that nothing noticed is not seen: that is the timer's job.
    set_n(&r.vault, 3);
    let snap = get(&r, "/api/tasks/snapshot").await;
    let doc: Value = serde_json::from_str(&snap.body).unwrap();
    assert_eq!(doc["tasks"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn a_session_holds_four_streams_and_gets_the_place_back() {
    let r = rig("limit", Timing::default()).await;
    let mut open = Vec::new();
    for _ in 0..4 {
        let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
        let _hello = sse.next(WAIT).await.unwrap();
        open.push(sse);
    }
    assert_eq!(
        Sse::open(r.server.addr(), Some(&r.token)).await.err(),
        Some(429)
    );
    // Another session is not counted against this one.
    let other = session(&r).await;
    assert!(Sse::open(r.server.addr(), Some(&other)).await.is_ok());
    // One closes; its place comes back.
    drop(open.pop());
    let mut got = false;
    for _ in 0..40 {
        if Sse::open(r.server.addr(), Some(&r.token)).await.is_ok() {
            got = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(got, "the place was not given back");
}

#[tokio::test]
async fn an_idle_stream_says_it_is_alive() {
    let r = rig(
        "ping",
        Timing {
            heartbeat: Duration::from_millis(200),
            ..Timing::default()
        },
    )
    .await;
    let mut sse = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    let _hello = sse.next(WAIT).await.unwrap();
    let ping = sse.next(Duration::from_secs(2)).await.expect("a heartbeat");
    assert_eq!(ping, ": ping\n\n");
}

#[tokio::test]
async fn a_stream_needs_a_session_and_takes_no_query() {
    let r = rig("auth", Timing::default()).await;
    assert_eq!(Sse::open(r.server.addr(), None).await.err(), Some(401));
    let wrong = Secret::generate(TOKEN_BYTES).unwrap().to_hex();
    assert_eq!(
        Sse::open(r.server.addr(), Some(&wrong)).await.err(),
        Some(401)
    );
    // A code is no session either.
    assert_eq!(
        Sse::open(r.server.addr(), Some(&r.control)).await.err(),
        Some(401)
    );
    let reply = get(&r, "/api/tasks/events?since=3").await;
    assert_eq!(reply.status, 400, "{reply:?}");
}
