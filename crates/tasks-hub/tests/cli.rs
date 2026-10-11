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

    // The session is a session: past the guard, a route that is not there.
    let auth = format!("Bearer {token}");
    let r = client::request(
        port,
        "GET",
        "/api/tasks/snapshot",
        &[("Authorization", &auth)],
        "",
    )
    .await
    .unwrap();
    assert_eq!(r.status, 404, "{r:?}");
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
