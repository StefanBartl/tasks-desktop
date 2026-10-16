//! Opening a task in Neovim: the page names the task, the engine names the file, the hub checks that it is a plain
//! file inside the vault and starts the editor with that one argument. Here the editor is the test seam: the file it
//! would have opened is written to a log.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use serde_json::Value;
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::config::Env;
use tasks_hub::editor::TerminalOpener;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine};
use tasks_hub::server::{
    start_with, Extras, HubStatus, Limits, RunningServer, ServerConfig, WatchConfig,
};
use tasks_hub::store::RefreshOptions;

struct Rig {
    server: RunningServer,
    vault: PathBuf,
    log: PathBuf,
    token: String,
}

async fn rig(name: &str, with_opener: bool) -> Rig {
    let base =
        std::env::temp_dir().join(format!("tasks-desktop-open-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let vault = base.join("vault");
    let tasks = vault.join("alpha.nvim").join("ROADMAP").join("tasks");
    std::fs::create_dir_all(&tasks).unwrap();
    std::fs::write(tasks.join("t1.md"), "---\ntitle: t1\n---\n").unwrap();
    std::fs::write(base.join("outside.md"), "x").unwrap();
    std::fs::write(vault.join(".fake-n"), "1").unwrap();
    std::fs::write(
        vault.join(".fake-task-file"),
        "alpha.nvim/ROADMAP/tasks/t1.md",
    )
    .unwrap();
    let log = base.join("opened.log");
    let engine: Arc<dyn Engine> = Arc::new(CliEngine::new(CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
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
    };
    let opener: Option<Arc<dyn tasks_hub::editor::FileOpener>> = with_opener.then(|| {
        Arc::new(TerminalOpener::new(
            PathBuf::from("nvim"),
            Env::from_pairs([(
                "TASKS_DESKTOP_EDITOR_LOG",
                log.to_string_lossy().into_owned(),
            )]),
        )) as Arc<dyn tasks_hub::editor::FileOpener>
    });
    let server = start_with(
        cfg,
        Extras {
            vaults: None,
            opener,
        },
    )
    .await
    .unwrap();
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
    Rig {
        server,
        vault,
        log,
        token,
    }
}

async fn open(r: &Rig, body: &str, session: bool) -> (u16, Value) {
    let auth = format!("Bearer {}", r.token);
    let origin = format!("http://127.0.0.1:{}", r.server.addr().port());
    let mut headers: Vec<(&str, &str)> =
        vec![("Content-Type", "application/json"), ("Origin", &origin)];
    if session {
        headers.push(("Authorization", &auth));
    }
    let reply = client::request(
        r.server.addr().port(),
        "POST",
        "/api/tasks/open",
        &headers,
        body,
    )
    .await
    .unwrap();
    (
        reply.status,
        serde_json::from_str(&reply.body).unwrap_or(Value::Null),
    )
}

fn opened(r: &Rig) -> Vec<String> {
    std::fs::read_to_string(&r.log)
        .map(|t| t.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn the_file_the_engine_names_is_opened_and_nothing_else() {
    let r = rig("ok", true).await;
    let (status, doc) = open(&r, r#"{"id":"alpha.nvim/t1"}"#, true).await;
    assert_eq!(status, 200, "{doc}");
    let seen = opened(&r);
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(seen[0].ends_with("t1.md"), "{seen:?}");
    // The answer does not hold a path.
    assert!(!doc.to_string().contains("t1.md"));
}

#[tokio::test]
async fn a_name_that_leads_out_of_the_vault_is_refused_and_nothing_is_started() {
    let r = rig("out", true).await;
    for name in [
        "../outside.md",
        "/etc/passwd",
        "alpha.nvim/ROADMAP/tasks/nope.md",
        "alpha.nvim",
    ] {
        std::fs::write(r.vault.join(".fake-task-file"), name).unwrap();
        let (status, doc) = open(&r, r#"{"id":"alpha.nvim/t1"}"#, true).await;
        assert_eq!(
            (status, doc["error"]["code"].as_str()),
            (400, Some("open_refused")),
            "{name}"
        );
    }
    assert!(opened(&r).is_empty(), "something was started");
}

#[tokio::test]
async fn the_form_the_credential_and_a_hub_without_an_editor() {
    let r = rig("form", true).await;
    for bad in [
        "{}",
        r#"{"id":"../x"}"#,
        r#"{"id":"alpha.nvim/t1","path":"/etc/passwd"}"#,
        r#"{"id":5}"#,
        "{not json",
    ] {
        let (status, _) = open(&r, bad, true).await;
        assert_eq!(status, 400, "{bad}");
    }
    let (status, _) = open(&r, r#"{"id":"alpha.nvim/t1"}"#, false).await;
    assert_eq!(status, 401, "the credential comes first");
    assert!(opened(&r).is_empty());
    let none = rig("none", false).await;
    let (status, doc) = open(&none, r#"{"id":"alpha.nvim/t1"}"#, true).await;
    assert_eq!(
        (status, doc["error"]["code"].as_str()),
        (404, Some("open_unavailable"))
    );
}
