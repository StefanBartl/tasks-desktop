//! The two commands of the program: `serve` and `open`.
//!
//! They live in the library so that their parts can be tested; `main.rs`
//! only reads the arguments.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{Secret, SystemClock, CODE_BYTES, TOKEN_BYTES};
use app_core::registry::{self, HubRecord};
use serde_json::Value;

use crate::client;
use crate::config::{self, Env, FileConfig};
use crate::discovery::discover;
use crate::engine::{probe, CliEngine, CliEngineConfig};
use crate::server::{self, HubStatus, Limits, ServerConfig, APP_NAME, DEFAULT_PORT};

/// What to do when the hub is started.
#[derive(Debug, Clone, Default)]
pub struct ServeOptions {
    /// Overrides the settings file and the environment.
    pub port: Option<u16>,
}

/// The folder for `hub.json` and `control.secret`.
fn app_dir(env: &Env) -> Result<PathBuf, String> {
    config::config_dir(env).ok_or_else(|| {
        "no config folder: set TASKS_DESKTOP_CONFIG_DIR (APPDATA, XDG_CONFIG_HOME or HOME is missing)"
            .to_owned()
    })
}

/// The port to try first: the option, the environment, the settings file,
/// then the default.
fn wanted_port(opts: &ServeOptions, file: &FileConfig, env: &Env) -> Result<u16, String> {
    if let Some(p) = opts.port {
        return Ok(p);
    }
    if let Some(v) = env.get("TASKS_DESKTOP_PORT") {
        let text = v.to_string_lossy();
        return text
            .parse::<u16>()
            .ok()
            .filter(|p| *p >= 1024)
            .ok_or_else(|| {
                format!("TASKS_DESKTOP_PORT is not a port from 1024 to 65535: {text:?}")
            });
    }
    Ok(file.port.unwrap_or(DEFAULT_PORT))
}

/// Is a hub of this app running according to `hub.json`? It is only
/// believed when the process on that port says the same instance.
async fn running_hub(dir: &std::path::Path) -> Option<HubRecord> {
    let record = registry::read_record(dir).ok().flatten()?;
    if record.app != APP_NAME {
        return None;
    }
    let doc = hello_of(record.port).await?;
    (doc["instance"].as_str() == Some(record.instance.as_str())).then_some(record)
}

/// What the program on `port` says to `hello`, if it is a hub of this app.
async fn hello_of(port: u16) -> Option<Value> {
    let reply = client::request(port, "GET", "/api/tasks/hello", &[], "")
        .await
        .ok()?;
    let doc: Value = serde_json::from_str(&reply.body).ok()?;
    (reply.status == 200 && doc["app"] == APP_NAME).then_some(doc)
}

/// Wait for Ctrl-C, or for SIGTERM where there is one.
async fn wait_for_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Find the engine and ask it `hello`. The answer is a short code for
/// `hello` and a longer text for the terminal of whoever started the hub.
async fn engine_status(file: &FileConfig, env: &Env) -> (HubStatus, Option<String>) {
    let setup = match discover(file, env).await {
        Ok(setup) => setup,
        Err(problem) => {
            return (
                HubStatus {
                    engine_ready: false,
                    problem: Some(problem.code()),
                },
                Some(problem.to_string()),
            );
        }
    };
    let engine = CliEngine::new(CliEngineConfig::from_setup(&setup, env.clone()));
    match probe(&engine).await {
        Ok(_) => {
            let note = setup
                .lib_problem
                .as_ref()
                .map(|p| format!("note: {p} (the engine may still find it)"));
            (
                HubStatus {
                    engine_ready: true,
                    problem: None,
                },
                note,
            )
        }
        Err(problem) => (
            HubStatus {
                engine_ready: false,
                problem: Some(problem.code()),
            },
            Some(problem.to_string()),
        ),
    }
}

/// Run the server until Ctrl-C.
///
/// # Errors
///
/// A text for the person at the terminal: what is missing or in the way.
pub async fn serve(opts: ServeOptions) -> Result<(), String> {
    let env = Env::from_process();
    let dir = app_dir(&env)?;
    let file = config::load_file(&dir).map_err(|e| e.to_string())?;
    let want = wanted_port(&opts, &file, &env)?;

    if let Some(other) = running_hub(&dir).await {
        return Err(format!(
            "a hub is already running (port {}, process {})",
            other.port, other.pid
        ));
    }

    let (status, note) = engine_status(&file, &env).await;
    if let Some(note) = &note {
        eprintln!("{note}");
    }

    let control = Secret::generate(TOKEN_BYTES).map_err(|e| e.to_string())?;
    let instance = Secret::generate(CODE_BYTES).map_err(|e| e.to_string())?;
    let make_cfg = |port: u16| ServerConfig {
        addr: std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        limits: Limits::default(),
        clock: Arc::new(SystemClock::new()),
        pairing_ttl: Duration::from_secs(60),
        control_secret: control.clone(),
        instance: instance.clone(),
        status: status.clone(),
    };
    // The port is part of the origin, so the wanted one is tried first. When
    // it is taken the server still starts, on another port, and says so:
    // the page then has another origin and its stored state does not carry over.
    let running = match server::start(make_cfg(want)).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Two hubs that start at the same moment both passed the check
            // above; the bind is what decides. Another hub of this app on
            // the port is "already running", not a reason for a second one.
            if hello_of(want).await.is_some() {
                return Err(format!("a hub is already running on port {want}"));
            }
            eprintln!("note: port {want} is in use, using a free port; the origin changes");
            server::start(make_cfg(0))
                .await
                .map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };
    let port = running.addr().port();

    let record = HubRecord {
        app: APP_NAME.to_owned(),
        port,
        pid: std::process::id(),
        version: crate::VERSION.to_owned(),
        instance: running.instance().to_owned(),
    };
    let written = registry::write_secret(&dir, &control.to_hex())
        .and_then(|()| registry::write_record(&dir, &record));
    if let Err(e) = written {
        // Leave nothing half written behind, and do not serve unannounced.
        registry::remove_secret(&dir);
        registry::remove_record(&dir);
        running.shutdown().await;
        return Err(e.to_string());
    }

    println!(
        "tasks-desktop hub {} on http://127.0.0.1:{port}/",
        crate::VERSION
    );
    println!("run `tasks-hub open` for a pairing link; Ctrl-C stops the hub");

    wait_for_stop().await;
    registry::remove_record(&dir);
    registry::remove_secret(&dir);
    running.shutdown().await;
    Ok(())
}

/// Ask the running hub for a pairing code and return the link for it.
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn open() -> Result<String, String> {
    let env = Env::from_process();
    let dir = app_dir(&env)?;
    let record = registry::read_record(&dir)
        .map_err(|e| e.to_string())?
        .ok_or("no hub is running (no hub.json)")?;
    if record.app != APP_NAME {
        return Err("hub.json is not from this app".to_owned());
    }
    let secret = registry::read_secret(&dir)
        .map_err(|e| e.to_string())?
        .ok_or("no control secret: the hub is not running")?;

    // The secret goes only to the process that says it is this hub.
    let hello = client::request(record.port, "GET", "/api/tasks/hello", &[], "")
        .await
        .map_err(|e| format!("the hub does not answer on port {}: {e}", record.port))?;
    let doc: Value = serde_json::from_str(&hello.body).map_err(|_| "not a hub on that port")?;
    if doc["app"] != APP_NAME || doc["instance"].as_str() != Some(record.instance.as_str()) {
        return Err(format!(
            "port {} is not the hub of hub.json (a stale file, or another program)",
            record.port
        ));
    }

    let auth = format!("Bearer {secret}");
    let reply = client::request(
        record.port,
        "POST",
        "/api/control/pair",
        &[
            ("Content-Type", "application/json"),
            ("Authorization", &auth),
        ],
        "{}",
    )
    .await
    .map_err(|e| e.to_string())?;
    if reply.status != 200 {
        return Err(format!(
            "the hub refused the request (HTTP {})",
            reply.status
        ));
    }
    let doc: Value = serde_json::from_str(&reply.body).map_err(|e| e.to_string())?;
    let code = doc["code"].as_str().ok_or("the hub sent no code")?;
    Ok(format!("http://127.0.0.1:{}/#pair={code}", record.port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_comes_from_the_option_then_the_environment_then_the_file() {
        let file = FileConfig {
            port: Some(20000),
            ..FileConfig::default()
        };
        let env = Env::from_pairs([("TASKS_DESKTOP_PORT", "30000")]);
        let opts = ServeOptions { port: Some(40000) };
        assert_eq!(wanted_port(&opts, &file, &env).unwrap(), 40000);
        let none = ServeOptions::default();
        assert_eq!(wanted_port(&none, &file, &env).unwrap(), 30000);
        assert_eq!(wanted_port(&none, &file, &Env::default()).unwrap(), 20000);
        assert_eq!(
            wanted_port(&none, &FileConfig::default(), &Env::default()).unwrap(),
            DEFAULT_PORT
        );
    }

    #[test]
    fn a_bad_port_in_the_environment_is_an_error() {
        let none = ServeOptions::default();
        for bad in ["abc", "80", "70000", "-1", ""] {
            let env = Env::from_pairs([("TASKS_DESKTOP_PORT", bad)]);
            let got = wanted_port(&none, &FileConfig::default(), &env);
            // An empty variable counts as unset.
            if bad.is_empty() {
                assert_eq!(got.unwrap(), DEFAULT_PORT);
            } else {
                assert!(got.is_err(), "{bad:?}");
            }
        }
    }
}
