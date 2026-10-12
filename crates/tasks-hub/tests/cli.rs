//! The real `tasks-hub` binary: `serve`, `open`, pairing, a second start.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;
use tasks_hub::client;

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_tasks-hub"))
}

fn fixture_vault() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("e2e")
        .join("fixture")
        .join("vault")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tasks-desktop-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A port nobody uses right now (best effort: it is released again).
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn command(config: &Path) -> Command {
    let mut cmd = Command::new(binary());
    cmd.env("TASKS_DESKTOP_CONFIG_DIR", config)
        .env("TASKS_VAULT", fixture_vault())
        .env("TASKS_EXTRA_AREAS", "ALL")
        .env_remove("TASKS_DESKTOP_PORT");
    cmd
}

struct Hub {
    child: Child,
    port: u16,
}

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_hub(config: &Path, port: u16) -> Hub {
    let child = command(config)
        .args(["serve", "--port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("tasks-hub starts");
    let hub = Hub { child, port };
    let record = config.join("hub.json");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !record.exists() {
        assert!(Instant::now() < deadline, "the hub never wrote hub.json");
        std::thread::sleep(Duration::from_millis(50));
    }
    hub
}

async fn get_hello(port: u16) -> Value {
    let r = client::request(port, "GET", "/api/tasks/hello", &[], "")
        .await
        .expect("hello");
    assert_eq!(r.status, 200);
    serde_json::from_str(&r.body).unwrap()
}

#[tokio::test]
async fn serve_open_and_pair() {
    let config = temp_dir("pair");
    let port = free_port();
    let hub = start_hub(&config, port);

    // hub.json says who runs where and holds no secret.
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(config.join("hub.json")).unwrap()).unwrap();
    assert_eq!(record["port"], port);
    assert_eq!(record["app"], "tasks-desktop");
    let secret = std::fs::read_to_string(config.join("control.secret")).unwrap();
    let secret = secret.trim();
    assert_eq!(secret.len(), 64);
    assert!(!std::fs::read_to_string(config.join("hub.json"))
        .unwrap()
        .contains(secret));

    // The hub knows its engine (when the machine has one).
    let hello = get_hello(hub.port).await;
    assert_eq!(hello["instance"], record["instance"]);
    if std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_some() {
        assert_eq!(hello["engine"]["ready"], true, "{hello}");
    }

    // `open` prints a link with the pairing code in the fragment.
    let out = command(&config).arg("open").output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let url = String::from_utf8(out.stdout).unwrap();
    let url = url.trim();
    let prefix = format!("http://127.0.0.1:{port}/#pair=");
    let code = url.strip_prefix(&prefix).expect("a pairing link");
    assert_eq!(code.len(), 32);

    // The browser's side: exchange the code, with the page's Origin.
    let origin = format!("http://127.0.0.1:{port}");
    let body = format!(r#"{{"code":"{code}"}}"#);
    let headers = [("Content-Type", "application/json"), ("Origin", &origin)];
    let first = client::request(port, "POST", "/auth/exchange", &headers, &body)
        .await
        .unwrap();
    assert_eq!(first.status, 200, "{first:?}");
    let token = serde_json::from_str::<Value>(&first.body).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let second = client::request(port, "POST", "/auth/exchange", &headers, &body)
        .await
        .unwrap();
    assert_eq!(second.status, 401);

    // With the session the data routes answer, through the real engine.
    let auth = format!("Bearer {token}");
    let get = |path: &'static str, extra: Vec<(&'static str, String)>| {
        let auth = auth.clone();
        async move {
            let mut headers = vec![("Authorization", auth)];
            headers.extend(extra);
            let headers: Vec<(&str, &str)> =
                headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
            client::request(port, "GET", path, &headers, "")
                .await
                .unwrap()
        }
    };
    if hello["engine"]["ready"] != true {
        // No engine on this machine: the routes say so and do not crash.
        let r = get("/api/tasks/snapshot", vec![]).await;
        assert_eq!(r.status, 503, "{r:?}");
        return;
    }

    let snap = get("/api/tasks/snapshot", vec![]).await;
    assert_eq!(snap.status, 200, "{snap:?}");
    let etag = snap.header("etag").expect("an ETag").to_owned();
    let doc: Value = serde_json::from_str(&snap.body).unwrap();
    assert_eq!(doc["kind"], "tasks.snapshot");
    assert!(doc["tasks"].as_array().is_some_and(|t| !t.is_empty()));
    // No path of this machine in the document.
    let vault = fixture_vault().canonicalize().unwrap();
    let vault = vault.display().to_string().replace('\\', "/");
    assert!(!snap.body.replace("\\\\", "/").contains(&vault));

    let again = get("/api/tasks/snapshot", vec![("If-None-Match", etag.clone())]).await;
    assert_eq!(again.status, 304, "{again:?}");
    assert!(again.body.is_empty());
    let other = get(
        "/api/tasks/snapshot",
        vec![("If-None-Match", "\"nope\"".to_owned())],
    )
    .await;
    assert_eq!(other.status, 200);

    let areas = get("/api/tasks/areas", vec![]).await;
    assert_eq!(areas.status, 200, "{areas:?}");
    let areas: Value = serde_json::from_str(&areas.body).unwrap();
    assert_eq!(areas["kind"], "hub.areas");
    // There is no areas.json in this config folder: nothing is classified.
    for area in areas["areas"].as_array().unwrap() {
        assert_eq!(area["data_class"], "unclassified", "{area}");
    }
    assert_eq!(
        areas["unclassified"].as_array().unwrap().len(),
        areas["areas"].as_array().unwrap().len()
    );

    let one = get("/api/tasks/task?id=lib.nvim/alpha", vec![]).await;
    assert_eq!(one.status, 200, "{one:?}");
    let one: Value = serde_json::from_str(&one.body).unwrap();
    assert_eq!(one["task"]["id"], "lib.nvim/alpha");

    let missing = get("/api/tasks/task?id=lib.nvim/no-such-task", vec![]).await;
    assert_eq!(missing.status, 404, "{missing:?}");
    for bad in [
        "/api/tasks/task",
        "/api/tasks/task?id=..%2Fx",
        "/api/tasks/task?id=../x/y",
        "/api/tasks/task?id=a/b/c",
        "/api/tasks/task?id=alpha",
        "/api/tasks/task?id=a/b&id=c/d",
        "/api/tasks/task?id=a/b&x=1",
    ] {
        let r = get(bad, vec![]).await;
        assert_eq!(r.status, 400, "{bad}: {r:?}");
    }

    let next = get("/api/tasks/next?n=2", vec![]).await;
    assert_eq!(next.status, 200, "{next:?}");
    assert_eq!(
        serde_json::from_str::<Value>(&next.body).unwrap()["kind"],
        "tasks.next"
    );
    assert_eq!(get("/api/tasks/next?n=99", vec![]).await.status, 400);
}

#[tokio::test]
async fn a_second_hub_does_not_start_and_a_stale_record_is_replaced() {
    let config = temp_dir("second");
    let port = free_port();
    let mut hub = start_hub(&config, port);

    // A second `serve` against the same config refuses.
    let again = command(&config)
        .args(["serve", "--port", &free_port().to_string()])
        .output()
        .unwrap();
    assert!(!again.status.success(), "{again:?}");
    assert!(String::from_utf8_lossy(&again.stderr).contains("already running"));

    // The hub dies without cleaning up: hub.json is stale now.
    hub.child.kill().unwrap();
    hub.child.wait().unwrap();
    assert!(config.join("hub.json").exists());
    let stale_open = command(&config).arg("open").output().unwrap();
    assert!(!stale_open.status.success(), "open talked to a dead hub");

    // A new hub starts over the stale record.
    let next_port = free_port();
    let _next = start_hub_after_stale(&config, next_port);
    let hello = get_hello(next_port).await;
    assert_eq!(hello["app"], "tasks-desktop");
}

/// Like `start_hub`, but the record already exists, so wait for the new port.
fn start_hub_after_stale(config: &Path, port: u16) -> Hub {
    let child = command(config)
        .args(["serve", "--port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("tasks-hub starts");
    let hub = Hub { child, port };
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let text = std::fs::read_to_string(config.join("hub.json")).unwrap_or_default();
        if serde_json::from_str::<Value>(&text).is_ok_and(|v| v["port"] == port) {
            return hub;
        }
        assert!(
            Instant::now() < deadline,
            "the new hub never wrote hub.json"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn bad_arguments_are_told() {
    let config = temp_dir("args");
    for args in [
        vec![],
        vec!["serve", "--port"],
        vec!["serve", "--port", "80"],
        vec!["serve", "--port", "abc"],
        vec!["serve", "--bind", "0.0.0.0"],
        vec!["open", "extra"],
        vec!["frobnicate"],
    ] {
        let out = command(&config).args(&args).output().unwrap();
        assert!(!out.status.success(), "{args:?} was accepted");
        assert!(!out.stderr.is_empty(), "{args:?} said nothing");
    }
    let out = command(&config).arg("--version").output().unwrap();
    assert!(out.status.success());
}

#[test]
fn open_without_a_hub_says_so() {
    let config = temp_dir("nohub");
    let out = command(&config).arg("open").output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no hub"));
}

#[tokio::test]
async fn a_hub_on_a_taken_port_that_is_this_app_is_already_running() {
    // Two config folders: the record check passes for the second hub, so only
    // the bind can tell it that the port belongs to a hub of this app.
    let first_config = temp_dir("taken-a");
    let port = free_port();
    let _first = start_hub(&first_config, port);

    let second_config = temp_dir("taken-b");
    let second = command(&second_config)
        .args(["serve", "--port", &port.to_string()])
        .output()
        .unwrap();
    assert!(!second.status.success(), "{second:?}");
    assert!(
        String::from_utf8_lossy(&second.stderr).contains("already running"),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    // It did not take over the record of the first.
    assert!(!second_config.join("hub.json").exists());
    let hello = get_hello(port).await;
    assert_eq!(hello["app"], "tasks-desktop");
}

#[test]
fn areas_propose_check_and_the_active_file() {
    let config = temp_dir("areas");
    let out = command(&config)
        .args(["areas", "propose", "--private=lib.nvim", "--write"])
        .output()
        .unwrap();
    if !out.status.success()
        && String::from_utf8_lossy(&out.stderr).contains("not ready")
        && std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_none()
    {
        eprintln!("skipped: no engine on this machine");
        return;
    }
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The proposal is a file for a person; the hub does not read it.
    let doc: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(doc["schema"], 1);
    assert_eq!(doc["areas"]["lib.nvim"]["class"], "private");
    assert_eq!(doc["areas"]["cascade.nvim"]["class"], "internal");
    assert!(config.join("areas.proposed.json").is_file());
    assert!(!config.join("areas.json").exists());

    // Nothing is classified yet, so the check says so and fails.
    let check = command(&config).args(["areas", "check"]).output().unwrap();
    assert!(!check.status.success());
    assert!(String::from_utf8_lossy(&check.stderr).contains("no data class"));

    // Once a person has renamed it, the check passes.
    std::fs::rename(
        config.join("areas.proposed.json"),
        config.join("areas.json"),
    )
    .unwrap();
    let check = command(&config).args(["areas", "check"]).output().unwrap();
    assert!(check.status.success(), "{check:?}");

    // A new proposal must not undo what the active file decided: lib.nvim was
    // private and stays private, with no --private on the command line.
    let again = command(&config)
        .args(["areas", "propose"])
        .output()
        .unwrap();
    assert!(again.status.success(), "{again:?}");
    let doc: Value = serde_json::from_slice(&again.stdout).unwrap();
    assert_eq!(doc["areas"]["lib.nvim"]["class"], "private");

    // A name that is not an area of the vault, and a name that is no name.
    for bad in ["--private=no-such-area", "--private=../x"] {
        let out = command(&config)
            .args(["areas", "propose", bad])
            .output()
            .unwrap();
        assert!(!out.status.success(), "{bad} was accepted");
    }
}

#[test]
fn a_broken_areas_file_stops_the_hub_instead_of_classifying_nothing() {
    let config = temp_dir("badareas");
    std::fs::write(
        config.join("areas.json"),
        r#"{"schema":1,"areas":{"a":{"clas":"private"}}}"#,
    )
    .unwrap();
    let out = command(&config)
        .args(["serve", "--port", &free_port().to_string()])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("areas.json"));
    assert!(!config.join("hub.json").exists());
}

/// Stops a hub that `start` left behind, also when the test fails.
struct Background(PathBuf);

impl Drop for Background {
    fn drop(&mut self) {
        let _ = command(&self.0).arg("stop").output();
    }
}

#[test]
fn start_runs_the_hub_in_the_background_and_stop_ends_it() {
    let config = temp_dir("background");
    let port = free_port();
    let _guard = Background(config.clone());

    let started = command(&config)
        .env("TASKS_DESKTOP_PORT", port.to_string())
        .arg("start")
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    let text = String::from_utf8_lossy(&started.stdout).into_owned();
    assert!(text.contains("runs in the background"), "{text}");

    // A second start finds the first one and starts nothing.
    let again = command(&config).arg("start").output().unwrap();
    assert!(again.status.success());
    assert!(
        String::from_utf8_lossy(&again.stdout).contains("already running"),
        "{}",
        String::from_utf8_lossy(&again.stdout)
    );

    // The log of the hub is in the config folder.
    assert!(config.join("hub.log").is_file());

    let stopped = command(&config).arg("stop").output().unwrap();
    assert!(
        stopped.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped.stderr)
    );
    assert!(String::from_utf8_lossy(&stopped.stdout).contains("is stopped"));
    let none = command(&config).arg("stop").output().unwrap();
    assert!(String::from_utf8_lossy(&none.stdout).contains("no hub is running"));
}

#[test]
fn install_copies_the_program_and_brings_a_running_hub_back_from_there() {
    let config = temp_dir("install");
    let bin = temp_dir("install-bin");
    let port = free_port();
    let _guard = Background(config.clone());
    let with_dir = |cmd: &mut Command| {
        cmd.env("TASKS_DESKTOP_INSTALL_DIR", &bin);
    };

    // Without a hub: the program is copied, and it runs from there.
    let mut first = command(&config);
    with_dir(&mut first);
    let out = first.arg("install").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let name = binary().file_name().unwrap().to_owned();
    let installed = bin.join(&name);
    assert!(
        installed.is_file(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let version = Command::new(&installed).arg("--version").output().unwrap();
    assert!(String::from_utf8_lossy(&version.stdout).contains("tasks-hub"));
    assert!(!bin.join(format!("{}.new", name.to_string_lossy())).exists());

    // With a hub: it is stopped, the program is replaced, the hub is back.
    let started = command(&config)
        .env("TASKS_DESKTOP_PORT", port.to_string())
        .arg("start")
        .output()
        .unwrap();
    assert!(started.status.success());
    let before = std::fs::read_to_string(config.join("hub.json")).unwrap();
    let mut second = command(&config);
    with_dir(&mut second);
    second.env("TASKS_DESKTOP_PORT", port.to_string());
    let out = second.arg("install").output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        out.status.success(),
        "{text}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(text.contains("is stopped"), "{text}");
    assert!(text.contains("runs in the background"), "{text}");
    let after = std::fs::read_to_string(config.join("hub.json")).unwrap();
    assert_ne!(before, after, "a new hub: another instance");

    // A flag that is none is a usage error.
    let bad = command(&config)
        .args(["install", "--nope"])
        .output()
        .unwrap();
    assert!(!bad.status.success());
}

#[test]
fn start_works_in_a_config_folder_with_a_non_ascii_name() {
    // The script host reads the path of the program and the log from a
    // script: a name with an umlaut must not turn into something else.
    let base = temp_dir("umlaut-base");
    let config = base.join("Müller äöü");
    std::fs::create_dir_all(&config).unwrap();
    let _guard = Background(config.clone());
    let port = free_port();
    let started = command(&config)
        .env("TASKS_DESKTOP_PORT", port.to_string())
        .arg("start")
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "{}{}",
        String::from_utf8_lossy(&started.stdout),
        String::from_utf8_lossy(&started.stderr)
    );
    assert!(config.join("hub.log").is_file());
    let _ = command(&config).arg("stop").output();
}
