//! The whole chain against the real engine: a change to a task file in a
//! (copy of the) fixture vault reaches an open event stream. The concept's
//! bound is two seconds from the change to the event.
//!
//! A folder task is moved as a whole (`move_area`, `done`): the system reports
//! the folder, not the files in it, and on Linux inotify tells a rename in two
//! halves. What pins the WATCHER is a change the hub did not make itself: the
//! engine called beside the hub (as Neovim does) for `move_area` and `done`, and
//! a plain rename of the folder. The hub's own write route refreshes the
//! snapshot before it answers, so a test through it proves the route, not the
//! watcher; it is here for that (the event and the snapshot follow a write).
//!
//! The two seconds are those of an idle machine. Most of the time to an event is the engine's read of the vault (a
//! Neovim process, after the debounce of 300 ms), and on a busy machine only that part grows (measured 2026-10-23: the
//! event in 0.6 to 0.75 s and one read in 0.45 to 0.5 s alone; with the five tests at once 1 to 2.4 s and 0.85 to 2.3 s).
//! So the bound is two seconds plus what the engine is slower than idle, as measured beside the change: the hub's own
//! part keeps its bound, and a busy machine does not make the test red by chance. A write through the route is bound
//! from its answer (the time before it is the engine's write and read).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use appkit_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use hub_testkit::scratch::Scratch;
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::{Env, FileConfig, TasksSettings};
use tasks_hub::discovery::{discover, SetupProblem};
use tasks_hub::engine::{probe, Calls, CliEngine, Engine};
use tasks_hub::server::{start, HubStatus, Limits, RunningServer, ServerConfig, WatchConfig};
use tasks_hub::store::RefreshOptions;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

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

/// How long one read of the vault by the engine takes on an idle machine (the fixture: about 0.5 s, 2026-10-23).
const ENGINE_IDLE: Duration = Duration::from_millis(500);

/// The bound of the concept (two seconds from the change to the event) when one read of the engine takes `engine` now:
/// what it is slower than idle is added (the hub reads the vault once between the change and the event).
fn bound(engine: Duration) -> Duration {
    Duration::from_secs(2) + engine.saturating_sub(ENGINE_IDLE)
}

#[test]
fn the_bound_grows_only_by_what_the_engine_is_slower_than_idle() {
    assert_eq!(bound(Duration::from_millis(300)), Duration::from_secs(2));
    assert_eq!(bound(ENGINE_IDLE), Duration::from_secs(2));
    assert_eq!(bound(Duration::from_millis(1500)), Duration::from_secs(3));
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

/// A hub over a copy of the fixture vault with the real engine, paired, with
/// an open event stream that said hello.
struct Rig {
    /// The engine the hub reads with. Called directly it is a writer beside the hub: the hub learns of the change
    /// only from the files, as it does when Neovim runs the engine.
    engine: Arc<dyn Engine>,
    server: RunningServer,
    vault: PathBuf,
    token: String,
    sse: Sse,
    // Last: the folder is removed after the hub and the engine, which have the vault open.
    _dir: Scratch,
}

/// The rig, or None when no engine is usable here (red when
/// `TASKS_DESKTOP_REQUIRE_ENGINE` is set). `prepare` changes the copy of the
/// vault before the hub reads it.
async fn rig(name: &str, prepare: impl FnOnce(&Path)) -> Option<Rig> {
    let dir = Scratch::new(&format!("real-events-{name}"));
    let vault = dir.to_path_buf();
    copy_dir(&fixture(), &vault);
    prepare(&vault);

    let env = Env::from_process();
    let file = FileConfig {
        vault: Some(vault.clone()),
        app: TasksSettings {
            extra_areas: ["ALL", "nvim-config", "docmap-desktop", "migrate.nvim"]
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            ..TasksSettings::default()
        },
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
            return None;
        }
        Err(other) => panic!("{other}"),
    };
    let engine = CliEngine::new(tasks_hub::engine::cli_config_from_setup(&setup, env));
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
            capabilities: Vec::new(),
        },
        engine: Some(Arc::clone(&engine)),
        policy: Arc::new(AreaPolicy::default()),
        usage: None,
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
    Some(Rig {
        engine,
        server,
        vault,
        token,
        sse,
        _dir: dir,
    })
}

impl Rig {
    async fn get(&self, path: &str, headers: &[(&str, &str)]) -> client::Reply {
        let auth = format!("Bearer {}", self.token);
        let mut all = vec![("Authorization", auth.as_str())];
        all.extend_from_slice(headers);
        client::request(self.server.addr().port(), "GET", path, &all, "")
            .await
            .unwrap()
    }

    /// A write through the hub's route. Not with `client::request`: its 5 s are those of the hub's own programs (hello,
    /// a pairing code), and a write is two Neovim processes, which a busy machine makes longer than that.
    async fn post_ops(&self, body: &str) -> Value {
        let port = self.server.addr().port();
        let request = format!(
            "POST /api/tasks/ops HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
             Authorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            self.token,
            body.len()
        );
        let exchange = async {
            let mut stream = TcpStream::connect(self.server.addr()).await?;
            stream.write_all(request.as_bytes()).await?;
            let mut reply = Vec::new();
            stream.read_to_end(&mut reply).await?;
            Ok::<_, std::io::Error>(reply)
        };
        let reply = tokio::time::timeout(Duration::from_secs(30), exchange)
            .await
            .expect("the hub answers the write within 30 s")
            .expect("the write is sent and its answer read");
        let reply = String::from_utf8(reply).expect("the answer is text");
        let (head, body) = reply.split_once("\r\n\r\n").expect("a head and a body");
        assert!(head.starts_with("HTTP/1.1 200 "), "{head}\n{body}");
        serde_json::from_str(body).unwrap()
    }

    /// A request to the engine beside the hub (not through its write route): the document of the answer.
    async fn outside(&self, method: tasks_hub::engine::Method, params: &Value) -> Value {
        let reply = self
            .engine
            .call(method, Some(params))
            .await
            .expect("the engine answers");
        serde_json::from_str(&reply.text).unwrap()
    }

    /// How long one read of the whole vault by the engine takes now, under the load the change is made in.
    async fn engine_read(&self) -> Duration {
        let started = Instant::now();
        self.engine
            .call(Calls::Snapshot, None)
            .await
            .expect("the engine reads the vault");
        started.elapsed()
    }

    /// The bound for an event: by the slower of a read of the engine before the change (`before`) and one now.
    async fn bound(&self, before: Duration) -> Duration {
        bound(before.max(self.engine_read().await))
    }

    /// The ids of the open tasks the hub's snapshot holds now.
    async fn ids(&self) -> Vec<String> {
        let snap = self.get("/api/tasks/snapshot", &[]).await;
        let doc: Value = serde_json::from_str(&snap.body).unwrap();
        doc["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["id"].as_str().map(str::to_owned))
            .collect()
    }

    /// Events until one names `id` (anywhere in it), within `within`; the
    /// time it took. None when none came.
    async fn change_naming(&mut self, id: &str, within: Duration) -> Option<(Value, Duration)> {
        let started = Instant::now();
        loop {
            let left = within.checked_sub(started.elapsed())?;
            let change = self.sse.next_change(left).await?;
            if change.to_string().contains(&format!("\"{id}\"")) {
                return Some((change, started.elapsed()));
            }
        }
    }
}

/// A folder task in `lib.nvim` with a file beside its task file.
fn folder_task(vault: &Path, slug: &str) {
    let dir = vault
        .join("lib.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join(slug);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{slug}.md")),
        format!("---\ntitle: Folder task {slug}\nstatus: open\nprio: 2\n---\n\nA folder task.\n"),
    )
    .unwrap();
    std::fs::write(dir.join("asset.txt"), "beside the task").unwrap();
}

#[tokio::test]
async fn an_edit_of_a_task_file_reaches_the_stream_within_two_seconds() {
    let Some(mut r) = rig("edit", |_| {}).await else {
        return;
    };

    // The snapshot a client holds before the change.
    let before = r.get("/api/tasks/snapshot", &[]).await;
    let before_etag = before.header("etag").expect("an ETag").to_owned();

    // Change a task file the way an editor does: write it in place.
    let path = r
        .vault
        .join("lib.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join("alpha.md");
    let text = std::fs::read_to_string(&path).unwrap();
    let edited = text.replacen("status: open", "status: doing", 1);
    assert_ne!(text, edited, "the fixture task has no status: open");
    let engine = r.engine_read().await;
    let started = Instant::now();
    std::fs::write(&path, edited).unwrap();

    let change = r
        .sse
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
    let limit = r.bound(engine).await;
    assert!(took < limit, "took {took:?}, bound {limit:?}");

    // The ETag moved, and a client that sends the old one gets the new document.
    let after = r
        .get("/api/tasks/snapshot", &[("If-None-Match", &before_etag)])
        .await;
    assert_eq!(after.status, 200, "{:?}", after.status);
    assert_ne!(after.header("etag"), Some(before_etag.as_str()));
}

#[tokio::test]
async fn a_folder_task_moved_through_the_write_route_is_in_the_event_and_the_snapshot_when_it_is_answered(
) {
    let slug = "folio-route";
    let Some(mut r) = rig("move-route", |v| folder_task(v, slug)).await else {
        return;
    };
    let old = format!("lib.nvim/{slug}");
    let new = format!("cascade.nvim/{slug}");
    assert!(r.ids().await.contains(&old), "the hub sees the folder task");

    let doc = r
        .post_ops(&format!(
            r#"{{"ops":[{{"op":"move_area","id":"{old}","to_area":"cascade.nvim"}}]}}"#
        ))
        .await;
    // The time to the answer is the engine's (it writes, then the route reads the vault again: two Neovim processes, as
    // slow as the machine). What the route promises is what holds at the answer: the snapshot and the event.
    let ids = r.ids().await;
    assert!(ids.contains(&new), "{ids:?}");
    assert!(!ids.contains(&old), "{ids:?}");
    assert_eq!(doc["results"][0]["outcome"], "moved", "{doc}");
    assert_eq!(doc["results"][0]["new_id"], new.as_str(), "{doc}");
    let moved = r
        .vault
        .join("cascade.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join(slug);
    assert_eq!(
        std::fs::read_to_string(moved.join("asset.txt")).unwrap(),
        "beside the task",
        "the folder moved as a whole"
    );

    // The route refreshes the snapshot itself before it answers: the event is there already. Which of the two scans
    // gets to say its cause first is a race (the watcher of Linux is quick): "ops" from the route, or "fs".
    let (change, after) = r
        .change_naming(&new, Duration::from_secs(10))
        .await
        .expect("an event that names the new id");
    assert!(
        matches!(change["cause"].as_str(), Some("ops" | "fs")),
        "{change}"
    );
    // Sent before the answer: it is read at once, not after a scan of the watcher.
    assert!(
        after < Duration::from_secs(1),
        "the event came {after:?} after the answer"
    );
}

#[tokio::test]
async fn a_folder_task_moved_by_the_engine_beside_the_hub_reaches_the_stream_through_the_watcher() {
    // The engine is called beside the hub, as Neovim does: the hub's own write route is not involved, so the only way
    // the hub can learn of the move is the watcher. Without it the event never comes (the periodic scan is slower).
    let slug = "folio-engine-move";
    let Some(mut r) = rig("engine-move", |v| folder_task(v, slug)).await else {
        return;
    };
    let old = format!("lib.nvim/{slug}");
    let new = format!("cascade.nvim/{slug}");
    assert!(r.ids().await.contains(&old), "the hub sees the folder task");

    // Measured before the change: a read after it would run beside the hub's own read of the change and slow both.
    let engine = r.engine_read().await;
    let doc = r
        .outside(
            Calls::Ops,
            &serde_json::json!({ "ops": [{ "op": "move_area", "id": old, "to_area": "cascade.nvim" }] }),
        )
        .await;
    // The clock starts when the engine has moved the folder: the watcher may see it from then on.
    let started = Instant::now();
    assert_eq!(doc["results"][0]["outcome"], "moved", "{doc}");
    let (change, _) = r
        .change_naming(&new, Duration::from_secs(10))
        .await
        .expect("an event that names the new id");
    assert_eq!(change["cause"], "fs", "{change}");
    let took = started.elapsed();
    let limit = r.bound(engine).await;
    assert!(took < limit, "took {took:?}, bound {limit:?}");
    let ids = r.ids().await;
    assert!(ids.contains(&new), "{ids:?}");
    assert!(!ids.contains(&old), "the old id is gone: {ids:?}");
}

#[tokio::test]
async fn a_folder_task_finished_by_the_engine_beside_the_hub_reaches_the_stream_through_the_watcher(
) {
    // `done` moves the folder task into the Backlog as a whole; the open id goes.
    let slug = "folio-engine-done";
    let Some(mut r) = rig("engine-done", |v| folder_task(v, slug)).await else {
        return;
    };
    let id = format!("lib.nvim/{slug}");
    assert!(r.ids().await.contains(&id), "the hub sees the folder task");

    let preview = r
        .outside(Calls::DonePreview, &serde_json::json!({ "id": id }))
        .await;
    let confirm = preview["confirm"]
        .as_str()
        .expect("a confirm token")
        .to_owned();
    let engine = r.engine_read().await;
    let doc = r
        .outside(
            Calls::Ops,
            &serde_json::json!({ "ops": [{ "op": "done", "id": id, "confirm": confirm }] }),
        )
        .await;
    let started = Instant::now();
    assert_eq!(doc["results"][0]["outcome"], "done", "{doc}");
    let (change, _) = r
        .change_naming(&id, Duration::from_secs(10))
        .await
        .expect("an event that names the finished id");
    assert_eq!(change["cause"], "fs", "{change}");
    let took = started.elapsed();
    let limit = r.bound(engine).await;
    assert!(took < limit, "took {took:?}, bound {limit:?}");
    let ids = r.ids().await;
    assert!(!ids.contains(&id), "the open id is gone: {ids:?}");
}

#[tokio::test]
async fn a_folder_task_renamed_from_outside_reaches_the_stream_as_a_whole_within_two_seconds() {
    // The engine run from Neovim moves the folder; the hub only watches. The
    // system reports the folder (on Linux: a rename in two halves, from and
    // to), never the task file in it.
    let slug = "folio-outside";
    let Some(mut r) = rig("move-outside", |v| folder_task(v, slug)).await else {
        return;
    };
    let old = format!("lib.nvim/{slug}");
    let new = format!("cascade.nvim/{slug}");
    assert!(r.ids().await.contains(&old), "the hub sees the folder task");

    let from = r
        .vault
        .join("lib.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join(slug);
    let to = r
        .vault
        .join("cascade.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join(slug);
    let engine = r.engine_read().await;
    let started = Instant::now();
    std::fs::rename(&from, &to).unwrap();

    let (change, _) = r
        .change_naming(&new, Duration::from_secs(10))
        .await
        .expect("an event that names the new id");
    let took = started.elapsed();
    assert_eq!(change["cause"], "fs", "{change}");
    let limit = r.bound(engine).await;
    assert!(took < limit, "took {took:?}, bound {limit:?}");
    let ids = r.ids().await;
    assert!(ids.contains(&new), "{ids:?}");
    assert!(!ids.contains(&old), "the old id is gone: {ids:?}");
}
