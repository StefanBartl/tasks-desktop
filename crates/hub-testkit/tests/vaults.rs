//! The vault routes: the list shows names and the last part of a folder, adding
//! must be confirmed, choosing a vault swaps what the hub reads (the snapshot,
//! the streams that were open), and a vault that does not work changes nothing.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use appkit_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use common::Sse;
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::Env;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{
    start, start_with, BoxFuture, Extras, HubStatus, Limits, RunningServer, ServerConfig,
    VaultAdmin, VaultInfo, VaultList, VaultTarget, WatchConfig,
};
use tasks_hub::store::RefreshOptions;

fn engine_for(vault: &Path) -> Arc<dyn Engine> {
    Arc::new(CliEngine::new(CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: vault.join("scripts").join("tasks.lua"),
        vault: vault.to_path_buf(),
        lib_dir: None,
        extra_areas: vec![],
        env: Env::from_process(),
        timeout: Duration::from_secs(10),
        max_queue: 16,
        max_reply_bytes: 4 * 1024 * 1024,
    }))
}

/// The classes of `alpha.nvim` in a vault: the same name in both vaults, `internal` in one and `private` in the other.
fn classes_of(vault: &str) -> Arc<AreaPolicy> {
    let class = if vault == "b" {
        tasks_hub::classes::Class::Private
    } else {
        tasks_hub::classes::Class::Internal
    };
    let entry = tasks_hub::classes::Entry { class, repo: None };
    Arc::new(
        AreaPolicy::new(std::collections::BTreeMap::from([(
            "alpha.nvim".to_owned(),
            entry,
        )]))
        .unwrap(),
    )
}

/// A list of vaults kept in memory: `a` is read first, `b` is a second vault
/// with more tasks, `broken` cannot be read.
struct Fake {
    a: PathBuf,
    b: PathBuf,
    active: Mutex<String>,
    added: Mutex<Vec<String>>,
    moved: Mutex<Vec<String>>,
}

impl VaultAdmin<VaultTarget> for Fake {
    fn list(&self) -> VaultList {
        let mut vaults = vec![
            VaultInfo {
                name: "main".to_owned(),
                label: self.a.file_name().unwrap().to_string_lossy().into_owned(),
                main: true,
            },
            VaultInfo {
                name: "b".to_owned(),
                label: self.b.file_name().unwrap().to_string_lossy().into_owned(),
                main: false,
            },
        ];
        for name in self.added.lock().unwrap().iter() {
            vaults.push(VaultInfo {
                name: name.clone(),
                label: name.clone(),
                main: false,
            });
        }
        VaultList {
            active: self.active.lock().unwrap().clone(),
            vaults,
        }
    }

    fn add<'a>(&'a self, name: &'a str, _path: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if name == "bad" {
                return Err("the name is not fit".to_owned());
            }
            self.added.lock().unwrap().push(name.to_owned());
            Ok(())
        })
    }

    fn remove<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if *self.active.lock().unwrap() == name {
                return Err("the vault that is read cannot be removed".to_owned());
            }
            self.added.lock().unwrap().retain(|n| n != name);
            Ok(())
        })
    }

    // The vault that is read "moves" to the folder of b (so the page reads other tasks afterwards); another
    // vault only has its folder noted.
    fn update<'a>(
        &'a self,
        name: &'a str,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Option<VaultTarget>, String>> {
        Box::pin(async move {
            if path.ends_with("nowhere") {
                return Err("this vault cannot be read there (vault_empty)".to_owned());
            }
            self.moved.lock().unwrap().push(name.to_owned());
            if *self.active.lock().unwrap() != name {
                return Ok(None);
            }
            Ok(Some(VaultTarget {
                engine: Some(engine_for(&self.b)),
                status: HubStatus {
                    engine_ready: true,
                    problem: None,
                    capabilities: Vec::new(),
                },
                vault: Some(self.b.clone()),
                policy: None,
            }))
        })
    }

    fn select<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<VaultTarget, String>> {
        Box::pin(async move {
            // The vault b takes a while to start, as an engine does.
            if name == "b" {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let vault = match name {
                "main" => &self.a,
                "b" => &self.b,
                _ => return Err("this vault cannot be read (vault_empty)".to_owned()),
            };
            *self.active.lock().unwrap() = name.to_owned();
            Ok(VaultTarget {
                engine: Some(engine_for(vault)),
                status: HubStatus {
                    engine_ready: true,
                    problem: None,
                    capabilities: Vec::new(),
                },
                vault: Some(vault.clone()),
                policy: Some(classes_of(name)),
            })
        })
    }
}

struct Rig {
    server: RunningServer,
    token: String,
    fake: Arc<Fake>,
    folder: String,
}

fn vault(name: &str, n: u32) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tasks-desktop-vaults-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("alpha.nvim").join("ROADMAP").join("tasks")).unwrap();
    std::fs::write(dir.join(".fake-n"), n.to_string()).unwrap();
    dir
}

async fn rig(name: &str, with_admin: bool) -> Rig {
    let a = vault(&format!("{name}-a"), 1);
    let b = vault(&format!("{name}-b"), 4);
    let fake = Arc::new(Fake {
        a: a.clone(),
        b,
        active: Mutex::new("main".to_owned()),
        added: Mutex::new(Vec::new()),
        moved: Mutex::new(Vec::new()),
    });
    let control = Secret::generate(TOKEN_BYTES).unwrap();
    let cfg = ServerConfig {
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
        engine: Some(engine_for(&a)),
        policy: classes_of("main"),
        usage: None,
        ui: tasks_hub::ui::UiFiles::none(),
        watch: Some(WatchConfig {
            vault: a.clone(),
            refresh: RefreshOptions {
                debounce: Duration::from_millis(100),
                max_wait: Duration::from_secs(1),
                interval: Duration::from_secs(300),
            },
        }),
    };
    let server = if with_admin {
        let admin: Arc<dyn VaultAdmin<VaultTarget>> =
            Arc::clone(&fake) as Arc<dyn VaultAdmin<VaultTarget>>;
        start_with(
            cfg,
            Extras {
                attach_dirs: Vec::new(),
                vaults: Some(admin),
                opener: None,
            },
        )
        .await
        .unwrap()
    } else {
        start(cfg).await.unwrap()
    };
    let port = server.addr().port();
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
    let folder = a.parent().unwrap().to_string_lossy().into_owned();
    Rig {
        server,
        token,
        fake,
        folder,
    }
}

const JSON: &str = "application/json";

async fn post(r: &Rig, path: &str, body: &str, session: bool) -> (u16, Value) {
    let auth = format!("Bearer {}", r.token);
    let origin = format!("http://127.0.0.1:{}", r.server.addr().port());
    let mut headers: Vec<(&str, &str)> = vec![("Content-Type", JSON), ("Origin", &origin)];
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

async fn get(r: &Rig, path: &str) -> (u16, String) {
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
    (reply.status, reply.body)
}

async fn listed(r: &Rig) -> usize {
    let (status, body) = get(r, "/api/tasks/snapshot").await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str::<Value>(&body).unwrap()["tasks"]
        .as_array()
        .unwrap()
        .len()
}

#[tokio::test]
async fn a_hub_without_a_list_of_vaults_says_so() {
    let r = rig("none", false).await;
    let (status, body) = get(&r, "/api/vaults").await;
    assert_eq!(status, 404, "{body}");
    assert!(body.contains("vaults_unavailable"));
    assert_eq!(
        post(&r, "/api/vaults/select", r#"{"name":"b"}"#, true)
            .await
            .0,
        404
    );
}

#[tokio::test]
async fn the_list_names_the_vaults_and_shows_no_path() {
    let r = rig("list", true).await;
    let (status, body) = get(&r, "/api/vaults").await;
    assert_eq!(status, 200, "{body}");
    let doc: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(doc["active"], "main");
    let names: Vec<&str> = doc["vaults"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["main", "b"]);
    assert!(!body.contains(&r.folder), "the list names a folder: {body}");
    // No session, no list.
    let reply = client::request(r.server.addr().port(), "GET", "/api/vaults", &[], "")
        .await
        .unwrap();
    assert_eq!(reply.status, 401);
}

#[tokio::test]
async fn choosing_a_vault_changes_what_is_read_and_ends_the_streams_of_the_old_one() {
    let r = rig("select", true).await;
    assert_eq!(listed(&r).await, 2, "vault a has the tasks 0 and 1");
    let mut stream = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    assert!(
        stream.next(Duration::from_secs(5)).await.is_some(),
        "the hello of the stream"
    );

    let (status, doc) = post(&r, "/api/vaults/select", r#"{"name":"b"}"#, true).await;
    assert_eq!((status, doc["active"].as_str()), (200, Some("b")), "{doc}");
    assert_eq!(listed(&r).await, 5, "vault b has the tasks 0 to 4");
    assert!(
        stream.ended(Duration::from_secs(5)).await,
        "the stream of the old vault is still open"
    );
    // The new vault has a stream of its own.
    let mut again = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    assert!(again.next(Duration::from_secs(5)).await.is_some());
    let (_, body) = get(&r, "/api/vaults").await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["active"], "b");
}

#[tokio::test]
async fn a_vault_that_cannot_be_read_is_refused_and_the_old_one_stays() {
    let r = rig("refuse", true).await;
    let (status, doc) = post(&r, "/api/vaults/select", r#"{"name":"nowhere"}"#, true).await;
    assert_eq!(status, 400);
    assert_eq!(doc["error"]["code"], "vault_refused");
    assert_eq!(listed(&r).await, 2, "still the first vault");
}

#[tokio::test]
async fn adding_must_be_confirmed_and_the_form_is_checked() {
    let r = rig("add", true).await;
    let folder = r.folder.replace('\\', "/");
    let body = |extra: &str| format!(r#"{{"name":"n1","path":"{folder}"{extra}}}"#);
    // Without the confirmation nothing is added.
    for bad in [
        body(""),
        body(r#","confirm":false"#),
        body(r#","confirm":"yes""#),
        body(r#","confirm":true,"surprise":1"#),
        r#"[1]"#.to_owned(),
        "{not json".to_owned(),
        format!(r#"{{"name":"","path":"{folder}","confirm":true}}"#),
        format!(r#"{{"name":"a\u0007b","path":"{folder}","confirm":true}}"#),
    ] {
        let (status, _) = post(&r, "/api/vaults/add", &bad, true).await;
        assert_eq!(status, 400, "{bad}");
    }
    assert!(
        r.fake.added.lock().unwrap().is_empty(),
        "something was added"
    );
    // No session: the credential comes before everything else.
    let (status, _) = post(&r, "/api/vaults/add", &body(r#","confirm":true"#), false).await;
    assert_eq!(status, 401);
    // The program refuses a name: its reason is told, nothing is added.
    let refused = format!(r#"{{"name":"bad","path":"{folder}","confirm":true}}"#);
    let (status, doc) = post(&r, "/api/vaults/add", &refused, true).await;
    assert_eq!(
        (status, doc["error"]["code"].as_str()),
        (400, Some("vault_refused"))
    );
    // Confirmed: added, and the list has it.
    let (status, _) = post(&r, "/api/vaults/add", &body(r#","confirm":true"#), true).await;
    assert_eq!(status, 200);
    let (_, list) = get(&r, "/api/vaults").await;
    assert!(list.contains("\"n1\""), "{list}");
    // Removing the vault that is read is refused, another one goes.
    let (status, _) = post(&r, "/api/vaults/remove", r#"{"name":"main"}"#, true).await;
    assert_eq!(status, 400);
    let (status, _) = post(&r, "/api/vaults/remove", r#"{"name":"n1"}"#, true).await;
    assert_eq!(status, 200);
    let (_, list) = get(&r, "/api/vaults").await;
    assert!(!list.contains("\"n1\""), "{list}");
}

#[tokio::test]
async fn moving_the_vault_that_is_read_reads_the_new_folder_and_ends_the_old_streams() {
    let r = rig("move", true).await;
    let folder = r.folder.replace('\\', "/");
    let body = |name: &str, path: &str, extra: &str| {
        format!(r#"{{"name":"{name}","path":"{path}"{extra}}}"#)
    };
    // Not confirmed, or with a field the route does not know: nothing moves.
    for bad in [
        body("main", &folder, ""),
        body("main", &folder, r#","confirm":false"#),
        body("main", &folder, r#","confirm":true,"surprise":1"#),
    ] {
        let (status, _) = post(&r, "/api/vaults/update", &bad, true).await;
        assert_eq!(status, 400, "{bad}");
    }
    // No session: the credential comes first.
    let ok = body("main", &folder, r#","confirm":true"#);
    assert_eq!(post(&r, "/api/vaults/update", &ok, false).await.0, 401);
    assert!(r.fake.moved.lock().unwrap().is_empty(), "something moved");
    // A folder that does not work is refused, the old one is still read.
    let refused = body("main", "/nowhere", r#","confirm":true"#);
    let (status, doc) = post(&r, "/api/vaults/update", &refused, true).await;
    assert_eq!(
        (status, doc["error"]["code"].as_str()),
        (400, Some("vault_refused"))
    );
    assert_eq!(listed(&r).await, 2);

    // Another vault moves: nothing is read again.
    let mut stream = Sse::open(r.server.addr(), Some(&r.token)).await.unwrap();
    assert!(stream.next(Duration::from_secs(5)).await.is_some());
    let other = body("b", &folder, r#","confirm":true"#);
    let (status, doc) = post(&r, "/api/vaults/update", &other, true).await;
    assert_eq!(
        (status, doc["reread"].as_bool()),
        (200, Some(false)),
        "{doc}"
    );
    assert_eq!(listed(&r).await, 2);

    // The vault that is read moves: the hub reads the new folder, the old streams end.
    let (status, doc) = post(&r, "/api/vaults/update", &ok, true).await;
    assert_eq!(
        (status, doc["reread"].as_bool()),
        (200, Some(true)),
        "{doc}"
    );
    assert_eq!(listed(&r).await, 5, "the new folder has the tasks 0 to 4");
    assert!(
        stream.ended(Duration::from_secs(5)).await,
        "the stream of the old folder is still open"
    );
}

#[tokio::test]
async fn two_choices_that_overlap_end_with_the_one_that_was_made_last() {
    let r = rig("overlap", true).await;
    // b is chosen first and is slow; main is chosen while b still starts. The hub must not end up reading b
    // while the settings say main.
    let slow = post(&r, "/api/vaults/select", r#"{"name":"b"}"#, true);
    let fast = async {
        tokio::time::sleep(Duration::from_millis(60)).await;
        post(&r, "/api/vaults/select", r#"{"name":"main"}"#, true).await
    };
    let (a, b) = tokio::join!(slow, fast);
    assert_eq!((a.0, b.0), (200, 200), "{a:?} {b:?}");
    let (_, body) = get(&r, "/api/vaults").await;
    let active = serde_json::from_str::<Value>(&body).unwrap()["active"]
        .as_str()
        .unwrap()
        .to_owned();
    let read = listed(&r).await;
    // The vault a has 2 tasks, b has 5: the list and what is read say the same, and it is the choice made last.
    assert_eq!((active.as_str(), read), ("main", 2));
}

#[tokio::test]
async fn the_check_job_belongs_to_the_vault_that_is_read() {
    let r = rig("check-vault", true).await;
    // A slow check of the first vault is running ...
    std::fs::write(r.fake.a.join(".fake-check-ms"), "800").unwrap();
    let (status, started) = post(&r, "/api/tasks/check", "{}", true).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["job"]["state"], "running");
    // ... another vault is chosen: its state is its own, idle.
    let (status, doc) = post(&r, "/api/vaults/select", r#"{"name":"b"}"#, true).await;
    assert_eq!(status, 200, "{doc}");
    let (_, body) = get(&r, "/api/tasks/check").await;
    let state: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(state["job"]["state"], "idle", "{body}");
    // The job of the old vault ends without setting anything in the new one.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let (_, body) = get(&r, "/api/tasks/check").await;
    let state: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(state["job"]["state"], "idle", "{body}");
}

#[tokio::test]
async fn the_classes_follow_the_vault_that_is_read() {
    let r = rig("classes", true).await;
    let class_of_alpha = |body: &str| {
        let doc: Value = serde_json::from_str(body).unwrap();
        doc["areas"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == "alpha.nvim")
            .unwrap()["data_class"]
            .clone()
    };
    let (status, body) = get(&r, "/api/tasks/areas").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(class_of_alpha(&body), "internal");
    // The vault b has an area of the same name that its owner made private: it is not released as the first one was.
    let (status, _) = post(&r, "/api/vaults/select", r#"{"name":"b"}"#, true).await;
    assert_eq!(status, 200);
    let (_, body) = get(&r, "/api/tasks/areas").await;
    assert_eq!(class_of_alpha(&body), "private");
    let (status, _) = post(&r, "/api/vaults/select", r#"{"name":"main"}"#, true).await;
    assert_eq!(status, 200);
    let (_, body) = get(&r, "/api/tasks/areas").await;
    assert_eq!(class_of_alpha(&body), "internal");
}
