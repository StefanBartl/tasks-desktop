//! A second hub next to the first: another port, its own `hub.json`, its own login entry. The two
//! apps are the tasks hub and `Demo`, which share nothing but `hub-kit`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use app_core::identity::AppIdentity;
use app_core::registry::{self, HubRecord};
use hub_kit::background::{installed_program, Background};
use hub_kit::config::config_dir;
use hub_kit::env::Env;
use hub_kit::loginitems::LoginApp;
use hub_kit::{instance, HubStatus, Limits, RunningServer};
use hub_testkit::subject::{StartConfig, Subject};
use hub_testkit::subjects::{Demo, Tasks, DEMO_IDENTITY};
use hub_testkit::wire::{request, send, Reply};

/// A running hub, and the secret that lets a program ask it for a pairing code.
struct Running {
    server: RunningServer,
    control: String,
}

async fn start(subject: &dyn Subject) -> Running {
    let control = Secret::generate(TOKEN_BYTES).unwrap();
    let server = subject
        .start(StartConfig {
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
        })
        .await
        .expect("the hub starts");
    Running {
        server,
        control: control.to_hex(),
    }
}

impl Running {
    fn addr(&self) -> SocketAddr {
        self.server.addr()
    }

    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.addr().port())
    }

    async fn get(&self, path: &str, auth: Option<&str>) -> Reply {
        let host = self.host();
        let mut headers = vec![("Host", host.as_str())];
        let bearer = auth.map(|t| format!("Bearer {t}"));
        if let Some(b) = &bearer {
            headers.push(("Authorization", b.as_str()));
        }
        send(self.addr(), request("GET", path, &headers, b"")).await
    }

    async fn post(&self, path: &str, extra: &[(&str, &str)], body: &str) -> Reply {
        let host = self.host();
        let len = body.len().to_string();
        let mut headers = vec![
            ("Host", host.as_str()),
            ("Content-Type", "application/json"),
            ("Content-Length", len.as_str()),
        ];
        headers.extend_from_slice(extra);
        send(
            self.addr(),
            request("POST", path, &headers, body.as_bytes()),
        )
        .await
    }

    /// A pairing code, asked for with the control secret of this hub.
    async fn mint_code(&self) -> String {
        let auth = format!("Bearer {}", self.control);
        let r = self
            .post("/api/control/pair", &[("Authorization", &auth)], "{}")
            .await;
        assert_eq!(r.status, 200, "{r:?}");
        r.json()["code"].as_str().unwrap().to_owned()
    }

    /// What this hub says to a code: the reply of the exchange.
    async fn exchange(&self, code: &str) -> Reply {
        let origin = format!("http://{}", self.host());
        let body = format!(r#"{{"code":"{code}"}}"#);
        self.post("/auth/exchange", &[("Origin", &origin)], &body)
            .await
    }

    /// A session of this hub.
    async fn session(&self) -> String {
        let code = self.mint_code().await;
        let r = self.exchange(&code).await;
        assert_eq!(r.status, 200, "{r:?}");
        r.json()["token"].as_str().unwrap().to_owned()
    }
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hub-testkit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn two_hubs_run_side_by_side_and_share_no_credential() {
    let tasks = start(&Tasks).await;
    let demo = start(&Demo).await;
    assert_ne!(tasks.addr().port(), demo.addr().port());

    // Each says who it is, and the instance of each is its own.
    let a = tasks.get("/api/tasks/hello", None).await.json();
    let b = demo.get("/api/demo/hello", None).await.json();
    assert_eq!(a["app"], "tasks-desktop");
    assert_eq!(b["app"], "demo-desktop");
    assert_ne!(a["instance"], b["instance"]);

    // A code of one is no code of the other, and a session of one is no session of the other.
    let code = tasks.mint_code().await;
    assert_eq!(demo.exchange(&code).await.status, 401);
    let token = tasks.session().await;
    assert_eq!(demo.get("/api/demo/items", Some(&token)).await.status, 401);
    // The control secret of one mints nothing at the other.
    let auth = format!("Bearer {}", tasks.control);
    let r = demo
        .post("/api/control/pair", &[("Authorization", &auth)], "{}")
        .await;
    assert_eq!(r.status, 401, "{r:?}");

    // And each still serves its own.
    let own = demo.session().await;
    assert_eq!(demo.get("/api/demo/items", Some(&own)).await.status, 200);
    assert_eq!(
        tasks
            .get("/api/tasks/not-built-yet", Some(&token))
            .await
            .status,
        404
    );
}

/// Every name that lands on the disk, in the registry or in the environment of a person.
fn names(id: &AppIdentity) -> Vec<(&'static str, String)> {
    vec![
        ("app", id.app.to_owned()),
        ("program file", id.program_file()),
        ("config dir variable", id.var("CONFIG_DIR")),
        ("install dir variable", id.var("INSTALL_DIR")),
        ("port variable", id.var("PORT")),
        ("no-login-sync variable", id.var("NO_LOGIN_SYNC")),
        ("desktop file", id.desktop_file()),
        ("agent file", id.agent_file()),
        ("agent label", id.agent_label()),
        ("route of hello", id.route("hello")),
        ("default port", id.default_port.to_string()),
    ]
}

#[test]
fn no_name_of_one_app_is_a_name_of_the_other() {
    let a = names(&tasks_hub::IDENTITY);
    let b = names(&DEMO_IDENTITY);
    assert_eq!(a.len(), b.len());
    for ((what, x), (_, y)) in a.iter().zip(&b) {
        assert_ne!(x, y, "{what} is the same for both apps: {x}");
    }
}

#[test]
fn the_folders_of_two_apps_are_two_folders() {
    // The same machine: the same APPDATA, XDG folders and HOME.
    let root = temp("two-folders");
    let env = Env::from_pairs([
        ("APPDATA", root.join("roaming")),
        ("LOCALAPPDATA", root.join("local")),
        ("XDG_CONFIG_HOME", root.join("xdg-config")),
        ("XDG_DATA_HOME", root.join("xdg-data")),
        ("HOME", root.join("home")),
    ]);
    let (a, b) = (&tasks_hub::IDENTITY, &DEMO_IDENTITY);
    let (ca, cb) = (config_dir(&env, a).unwrap(), config_dir(&env, b).unwrap());
    assert_ne!(ca, cb);
    // Neither folder is inside the other: a purge of one cannot reach the files of the other.
    assert!(
        !ca.starts_with(&cb) && !cb.starts_with(&ca),
        "{ca:?} {cb:?}"
    );

    let app = |identity| Background {
        login: LoginApp {
            identity,
            summary: "",
        },
        extra_files: &[],
        uninstall_script: "",
    };
    let (pa, pb) = (
        installed_program(&app(a), &env).unwrap(),
        installed_program(&app(b), &env).unwrap(),
    );
    assert_ne!(pa, pb);
    assert!(!pa.starts_with(pb.parent().unwrap()), "{pa:?} {pb:?}");
}

#[tokio::test]
async fn a_hub_json_is_believed_only_by_the_app_that_wrote_it_and_only_while_it_answers() {
    let demo = start(&Demo).await;
    let record = |app: &str, server: &RunningServer| HubRecord {
        app: app.to_owned(),
        port: server.addr().port(),
        pid: std::process::id(),
        version: "0.0.0".to_owned(),
        instance: server.instance().to_owned(),
    };
    let dir = temp("hub-json");

    // The record of the demo hub, in the folder of the demo hub: believed by the demo app.
    registry::write_record(&dir, &record(DEMO_IDENTITY.app, &demo.server)).unwrap();
    assert!(instance::running_hub(&dir, &DEMO_IDENTITY).await.is_some());
    // The tasks hub finds the same file and does not believe it: it is another app's.
    assert!(instance::running_hub(&dir, &tasks_hub::IDENTITY)
        .await
        .is_none());

    // A record that claims to be the tasks hub's but points at the demo hub's port: the program
    // there answers as the demo, so the tasks side does not believe it either.
    registry::write_record(&dir, &record(tasks_hub::IDENTITY.app, &demo.server)).unwrap();
    assert!(instance::running_hub(&dir, &tasks_hub::IDENTITY)
        .await
        .is_none());
    // Nor does the demo side believe a record that carries the other name.
    assert!(instance::running_hub(&dir, &DEMO_IDENTITY).await.is_none());

    // Two records in two folders do not touch each other.
    let (one, two) = (temp("hub-json-one"), temp("hub-json-two"));
    registry::write_record(&one, &record(DEMO_IDENTITY.app, &demo.server)).unwrap();
    registry::write_record(&two, &record(tasks_hub::IDENTITY.app, &demo.server)).unwrap();
    assert_eq!(
        registry::read_record(&one).unwrap().unwrap().app,
        DEMO_IDENTITY.app
    );
    assert_eq!(
        registry::read_record(&two).unwrap().unwrap().app,
        tasks_hub::IDENTITY.app
    );
}
