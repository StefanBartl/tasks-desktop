//! The commands of the program: `serve`, `open` and `areas`.
//!
//! They live in the library so that their parts can be tested; `main.rs`
//! only reads the arguments.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use app_core::authn::{Secret, SystemClock, CODE_BYTES, TOKEN_BYTES};
use app_core::registry::{self, HubRecord};
use serde_json::Value;

use crate::classes::{self, AreaPolicy};
use crate::client;
use crate::config::{self, Env, FileConfig};
use crate::discovery::discover;
use crate::editor::TerminalOpener;
use crate::engine::{probe, CliEngine, CliEngineConfig, Engine, Method};
use crate::server::{
    self, BoxFuture, Extras, HubStatus, Limits, ServerConfig, VaultAdmin, VaultInfo, VaultList,
    VaultTarget, WatchConfig, APP_NAME, DEFAULT_PORT,
};
use crate::store::RefreshOptions;

/// What to do when the hub is started.
#[derive(Debug, Clone, Default)]
pub struct ServeOptions {
    /// Overrides the settings file and the environment.
    pub port: Option<u16>,
}

/// The folder for `hub.json` and `control.secret`.
/// The config folder, for the commands of the other modules.
pub(crate) fn config_folder(env: &Env) -> Result<PathBuf, String> {
    app_dir(env)
}

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
pub(crate) async fn running_hub(dir: &std::path::Path) -> Option<HubRecord> {
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

/// What the start found out about the engine.
struct EngineState {
    status: HubStatus,
    /// Only when the engine answered `hello` as this app needs.
    engine: Option<Arc<dyn Engine>>,
    /// A longer text for the terminal of whoever started the hub (it may
    /// hold paths; `hello` gets only the short code of `status`).
    note: Option<String>,
    /// The vault to watch, once the engine is known to be there.
    vault: Option<PathBuf>,
    /// The Neovim that was found, for opening a file in it.
    nvim: Option<PathBuf>,
}

/// Find the engine and ask it `hello`.
async fn engine_state(file: &FileConfig, env: &Env) -> EngineState {
    let failed = |code: &'static str, note: String| EngineState {
        status: HubStatus {
            engine_ready: false,
            problem: Some(code),
            capabilities: Vec::new(),
        },
        engine: None,
        note: Some(note),
        vault: None,
        nvim: None,
    };
    let setup = match discover(file, env).await {
        Ok(setup) => setup,
        Err(problem) => return failed(problem.code(), problem.to_string()),
    };
    let cfg = CliEngineConfig::from_setup(&setup, env.clone());
    // A persistent engine process answers in milliseconds where a process per
    // question needs a second; `TASKS_HUB_ENGINE=process` asks for the
    // one-process-per-question way (a bug hunt, an old engine).
    let one_process = env
        .get("TASKS_HUB_ENGINE")
        .is_some_and(|v| v.to_string_lossy() == "process");
    let engine = if one_process {
        CliEngine::new(cfg)
    } else {
        CliEngine::with_host(cfg)
    };
    match probe(&engine).await {
        // A vault without one area is nearly always the wrong folder: say it
        // instead of showing an empty list that looks like a working app.
        Ok(_) if matches!(area_names(&engine).await, Ok(names) if names.is_empty()) => failed(
            "vault_empty",
            format!(
                "no area with ROADMAP/tasks or Backlog was found in {} (is this the right vault?)",
                setup.vault.value.display()
            ),
        ),
        Ok(info) => EngineState {
            status: HubStatus {
                engine_ready: true,
                problem: None,
                capabilities: info.capabilities,
            },
            engine: Some(Arc::new(engine)),
            vault: Some(setup.vault.value.clone()),
            nvim: Some(setup.nvim.value.clone()),
            note: setup
                .lib_problem
                .as_ref()
                .map(|p| format!("note: {p} (the engine may still find it)")),
        },
        Err(problem) => failed(problem.code(), problem.to_string()),
    }
}

/// The vaults of the settings file, as the routes under `/api/vaults` use
/// them: the file is the only place the list lives, and every change of it is
/// one atomic write.
struct ConfigVaults {
    dir: PathBuf,
    env: Env,
    file: StdMutex<FileConfig>,
    /// One change at a time: choosing a vault starts an engine, which takes a while.
    gate: tokio::sync::Mutex<()>,
}

impl ConfigVaults {
    fn new(dir: PathBuf, env: Env, file: FileConfig) -> Self {
        Self {
            dir,
            env,
            file: StdMutex::new(file),
            gate: tokio::sync::Mutex::new(()),
        }
    }

    fn current(&self) -> FileConfig {
        self.file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The settings as they are on disk now: a person may have edited the file since the hub started, and a change of
    /// the list must not write the old text back over that. A file that cannot be read stops the change.
    fn fresh(&self) -> Result<FileConfig, String> {
        config::load_file(&self.dir).map_err(|_| "the settings file cannot be read".to_owned())
    }

    /// Write `next` and keep it, or leave both as they are. The vault the hub reads is the one it holds in memory:
    /// only a choice (`adopt_active`) moves it, an add or a remove keeps it even when the file on disk, edited by hand
    /// meanwhile, names another (the file keeps what the person wrote).
    fn keep(&self, next: FileConfig, adopt_active: bool) -> Result<(), String> {
        config::save_file(&self.dir, &next)?;
        let mut held = next;
        if !adopt_active {
            let reading = self.current();
            held.active = reading.active.clone();
            // The vault that is read is the one the hub holds, whatever the file says of it now (gone, or with
            // another folder): the list the page sees keeps its entry.
            if let Some(entry) = reading
                .active
                .as_deref()
                .and_then(|name| reading.vaults.iter().find(|v| v.name == name))
            {
                match held.vaults.iter_mut().find(|v| v.name == entry.name) {
                    Some(slot) => *slot = entry.clone(),
                    None => held.vaults.push(entry.clone()),
                }
            }
        }
        *self
            .file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = held;
        Ok(())
    }
}

/// Whether a path names anything but a plain drive or mount: a network share, a device, a verbatim or an NT form.
/// Windows reads `/` and `\` alike, so the separators are made one before the start is looked at (`/\host\share` is
/// a share too). Every prefix but a drive letter (a share, a device, a verbatim or an NT form) begins with two
/// separators, or with `/??/` once they are one, so this is the whole test.
fn is_remote_path(text: &str) -> bool {
    let flat = text.replace('\\', "/");
    flat.starts_with("//") || flat.starts_with("/??/")
}

/// The last part of a folder: what the page may show of it.
fn label_of(path: &Path, fallback: &str) -> String {
    path.file_name()
        .map_or_else(|| fallback.to_owned(), |n| n.to_string_lossy().into_owned())
}

impl VaultAdmin for ConfigVaults {
    fn list(&self) -> VaultList {
        let file = self.current();
        let mut vaults = Vec::new();
        let main = file.vault.clone().or_else(|| self.env.path("TASKS_VAULT"));
        if let Some(path) = main {
            vaults.push(VaultInfo {
                name: config::MAIN_VAULT.to_owned(),
                label: label_of(&path, config::MAIN_VAULT),
                main: true,
            });
        }
        vaults.extend(file.vaults.iter().map(|v| VaultInfo {
            name: v.name.clone(),
            label: label_of(&v.path, &v.name),
            main: false,
        }));
        VaultList {
            active: file.active_name().to_owned(),
            vaults,
        }
    }

    fn add<'a>(&'a self, name: &'a str, path: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let _one = self.gate.lock().await;
            config::valid_vault_name(name).map_err(|why| format!("the name {why}"))?;
            // A network share is not looked at: opening `\\host\share` makes Windows sign in to that host, and a
            // page that asks for it could point the machine at one it does not own. A drive or a mount is fine.
            if is_remote_path(path) {
                return Err(
                    "a network folder is not accepted: use a drive or a mounted folder".to_owned(),
                );
            }
            let folder = PathBuf::from(path);
            if !folder.is_absolute() {
                return Err("the folder must be given with its whole path".to_owned());
            }
            if !folder.is_dir() {
                return Err("there is no such folder".to_owned());
            }
            let mut next = self.fresh()?;
            // The vault the hub reads keeps its entry in memory whatever the file says: its name is taken too, and it
            // counts against the limit.
            let reading = self.current();
            let held = reading
                .active
                .as_deref()
                .and_then(|active| reading.vaults.iter().find(|v| v.name == active))
                .filter(|v| !next.vaults.iter().any(|n| n.name == v.name));
            if next.vaults.iter().any(|v| v.name == name) || held.is_some_and(|v| v.name == name) {
                return Err("a vault of this name is there already".to_owned());
            }
            if next.vaults.len() + usize::from(held.is_some()) >= config::MAX_VAULTS {
                return Err(format!("at most {} vaults", config::MAX_VAULTS));
            }
            if next.vaults.len() >= config::MAX_VAULTS {
                return Err(format!("at most {} vaults", config::MAX_VAULTS));
            }
            next.vaults.push(config::VaultEntry {
                name: name.to_owned(),
                path: folder,
            });
            self.keep(next, false)
        })
    }

    fn remove<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let _one = self.gate.lock().await;
            let mut next = self.fresh()?;
            // The vault the hub reads now, not only the one the file names: a hand edit may have moved `active`.
            if next.active_name() == name || self.current().active_name() == name {
                return Err("the vault that is read cannot be removed".to_owned());
            }
            let before = next.vaults.len();
            next.vaults.retain(|v| v.name != name);
            if next.vaults.len() == before {
                return Err("there is no vault of this name".to_owned());
            }
            self.keep(next, false)
        })
    }

    fn select<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<VaultTarget, String>> {
        Box::pin(async move {
            let _one = self.gate.lock().await;
            let mut next = self.fresh()?;
            if name == config::MAIN_VAULT {
                next.active = None;
            } else if next.vaults.iter().any(|v| v.name == name) {
                next.active = Some(name.to_owned());
            } else {
                return Err("there is no vault of this name".to_owned());
            }
            let state = engine_state(&next.effective(), &self.env).await;
            let Some(engine) = state.engine else {
                // The terminal of whoever runs the hub gets the whole reason (it may hold paths).
                if let Some(note) = &state.note {
                    eprintln!("note: vault {name:?} cannot be read: {note}");
                }
                return Err(format!(
                    "this vault cannot be read ({})",
                    state.status.problem.unwrap_or("engine_unavailable")
                ));
            };
            self.keep(next, true)?;
            Ok(VaultTarget {
                engine: Some(engine),
                status: state.status,
                vault: state.vault,
            })
        })
    }
}

/// The names of the areas the engine knows.
async fn area_names(engine: &dyn Engine) -> Result<Vec<String>, String> {
    let reply = engine
        .call(Method::Areas, None)
        .await
        .map_err(|e| e.to_string())?;
    let doc: Value = serde_json::from_str(&reply.text).map_err(|e| e.to_string())?;
    Ok(doc["areas"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|a| a["name"].as_str().map(str::to_owned))
        .collect())
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

    // A file that cannot be read stops the start: a typo must not turn
    // into "everything unclassified" without anyone seeing it.
    let policy = Arc::new(AreaPolicy::load(&dir).map_err(|e| e.to_string())?);

    let state = engine_state(&file.effective(), &env).await;
    if let Some(note) = &state.note {
        eprintln!("{note}");
    }
    if let Some(engine) = &state.engine {
        match area_names(engine.as_ref()).await {
            Ok(names) => {
                let open = policy.unclassified(names.iter().map(String::as_str));
                if !open.is_empty() {
                    eprintln!(
                        "note: {} of {} areas have no data class and are treated as unclassified \
                         (run `tasks-hub areas propose`): {}",
                        open.len(),
                        names.len(),
                        open.join(", ")
                    );
                }
            }
            Err(e) => eprintln!("note: could not list the areas: {e}"),
        }
    }
    let status = state.status.clone();

    // Counts per day of how the interface is used (see `tasks-hub usage`).
    let usage = Arc::new(crate::usage::UsageLog::open(Some(dir.join("usage.json"))));

    // The interface is part of the binary. `TASKS_HUB_UI_DIR` names a built
    // folder to use instead (development: no rebuild of the binary).
    let ui = match env.path("TASKS_HUB_UI_DIR") {
        Some(dir) => match crate::ui::UiFiles::load(&dir) {
            Ok(files) => files,
            Err(e) => {
                eprintln!(
                    "note: the interface in {} cannot be used: {e}",
                    dir.display()
                );
                crate::ui::UiFiles::embedded()
            }
        },
        None => crate::ui::UiFiles::embedded(),
    };

    let control = Secret::generate(TOKEN_BYTES).map_err(|e| e.to_string())?;
    let instance = Secret::generate(CODE_BYTES).map_err(|e| e.to_string())?;
    let make_cfg = |port: u16| ServerConfig {
        addr: std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        // A watcher replaces the one-second life of a snapshot; the age that
        // is left is a net, not the way a change is seen.
        limits: Limits {
            snapshot_max_age: state.vault.as_ref().map(|_| Duration::from_secs(120)),
            ..Limits::default()
        },
        clock: Arc::new(SystemClock::new()),
        pairing_ttl: Duration::from_secs(60),
        control_secret: control.clone(),
        instance: instance.clone(),
        status: status.clone(),
        engine: state.engine.clone(),
        policy: Arc::clone(&policy),
        watch: state.vault.clone().map(|vault| WatchConfig {
            vault,
            refresh: RefreshOptions::default(),
        }),
        ui: ui.clone(),
        usage: Some(Arc::clone(&usage)),
    };
    // The port is part of the origin, so the wanted one is tried first. When
    // it is taken the server still starts, on another port, and says so:
    // the page then has another origin and its stored state does not carry over.
    let nvim = state.nvim.clone();
    let vaults: Arc<dyn VaultAdmin> = Arc::new(ConfigVaults::new(dir.clone(), env.clone(), file));
    let extras = || Extras {
        vaults: Some(Arc::clone(&vaults)),
        opener: nvim.clone().map(|n| {
            Arc::new(TerminalOpener::new(n, env.clone())) as Arc<dyn crate::editor::FileOpener>
        }),
    };
    let running = match server::start_with(make_cfg(want), extras()).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Two hubs that start at the same moment both passed the check
            // above; the bind is what decides. Another hub of this app on
            // the port is "already running", not a reason for a second one.
            if hello_of(want).await.is_some() {
                return Err(format!("a hub is already running on port {want}"));
            }
            eprintln!("note: port {want} is in use, using a free port; the origin changes");
            server::start_with(make_cfg(0), extras())
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

/// What `tasks-hub areas ...` is asked to do.
#[derive(Debug, Clone)]
pub enum AreasCommand {
    /// Print a proposal; with `write` also keep it next to the real file.
    Propose { private: Vec<String>, write: bool },
    /// List the areas that have no data class.
    Check,
}

/// Run an `areas` command and return what to print.
///
/// # Errors
///
/// How often the interface was opened on each of the last `days` days: the
/// answer to "is it used every day".
///
/// # Errors
///
/// No config folder.
pub fn usage(days: u32) -> Result<String, String> {
    let env = Env::from_process();
    let dir = app_dir(&env)?;
    let path = dir.join("usage.json");
    if !path.is_file() {
        return Ok("no usage yet (nothing was opened while a hub ran)\n".to_owned());
    }
    let counted = crate::usage::read_days(&path);
    Ok(crate::usage::report(
        &counted,
        &crate::usage::today(),
        days.clamp(1, 366),
    ))
}

/// Is this the link `open` prints: the loopback address, a port, `/#pair=` and
/// hex, and nothing else a program could take as an option or a path?
#[must_use]
pub fn is_own_link(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Some((port, code)) = rest.split_once("/#pair=") else {
        return false;
    };
    !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|b| b.is_ascii_digit())
        && !code.is_empty()
        && code.len() <= 128
        && code.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Open a link of `open` in the default browser. The link is the hub's own
/// (`http://127.0.0.1:<port>/#pair=<hex>`), and nothing else is passed.
///
/// # Errors
///
/// The link is not the hub's own, or the program that opens links could not
/// be started.
pub fn launch(url: &str) -> Result<(), String> {
    if !is_own_link(url) {
        return Err("the link is not the hub's own: not opened".to_owned());
    }
    // An absolute program: a bare name would be looked for along a PATH that
    // may hold a folder of somebody else's.
    let mut command = if cfg!(windows) {
        let root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("windir"))
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or("no Windows folder: the link is not opened")?;
        let mut c = std::process::Command::new(root.join("System32").join("rundll32.exe"));
        c.arg("url.dll,FileProtocolHandler");
        c
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("/usr/bin/open")
    } else {
        std::process::Command::new("/usr/bin/xdg-open")
    };
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start the browser: {e}"))
}

/// A text for the person at the terminal. `Check` fails when an area has
/// no data class, so a script can rely on the exit status.
pub async fn areas(command: AreasCommand) -> Result<String, String> {
    let env = Env::from_process();
    let dir = app_dir(&env)?;
    let file = config::load_file(&dir).map_err(|e| e.to_string())?;
    let state = engine_state(&file.effective(), &env).await;
    let Some(engine) = state.engine else {
        return Err(format!(
            "the engine is not ready: {}",
            state.note.unwrap_or_default()
        ));
    };
    let names = area_names(engine.as_ref()).await?;
    match command {
        AreasCommand::Propose { private, write } => {
            for name in &private {
                config::valid_area_name(name)
                    .map_err(|why| format!("--private {name:?}: {why}"))?;
            }
            let unknown: Vec<&str> = private
                .iter()
                .map(String::as_str)
                .filter(|p| !names.iter().any(|n| n == p))
                .collect();
            if !unknown.is_empty() {
                return Err(format!(
                    "--private names no area of the vault: {}",
                    unknown.join(", ")
                ));
            }
            let repos = env.path("REPOS_DIR");
            let exists =
                |candidate: &str| repos.as_ref().is_some_and(|r| r.join(candidate).is_dir());
            // What is decided in the active file stays decided.
            let existing = AreaPolicy::load(&dir).map_err(|e| e.to_string())?;
            let fresh = existing
                .unclassified(names.iter().map(String::as_str))
                .len();
            eprintln!(
                "{} areas keep their entry from areas.json, {fresh} are new",
                names.len() - fresh
            );
            let text = classes::propose(
                names.iter().map(String::as_str),
                &private,
                &existing,
                &exists,
            )?;
            if write {
                let target = classes::proposal_path(&dir);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                std::fs::write(&target, &text).map_err(|e| e.to_string())?;
                eprintln!(
                    "written: {} (read it, then rename it to areas.json; the hub reads only that name)",
                    target.display()
                );
            }
            Ok(text)
        }
        AreasCommand::Check => {
            let policy = AreaPolicy::load(&dir).map_err(|e| e.to_string())?;
            let open = policy.unclassified(names.iter().map(String::as_str));
            if open.is_empty() {
                Ok(format!("all {} areas have a data class", names.len()))
            } else {
                Err(format!(
                    "{} of {} areas have no data class: {}",
                    open.len(),
                    names.len(),
                    open.join(", ")
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_hubs_own_link_is_opened() {
        assert!(super::is_own_link(
            "http://127.0.0.1:17615/#pair=00ff00ff00ff00ff00ff00ff00ff00ff"
        ));
        for bad in [
            "",
            "https://127.0.0.1:17615/#pair=ab",
            "http://localhost:17615/#pair=ab",
            "http://127.0.0.1:17615/#pair=",
            "http://127.0.0.1:17615/#pair=ab cd",
            "http://127.0.0.1:17615/#pair=ab&x=1",
            "http://127.0.0.1:17615/path#pair=ab",
            "http://127.0.0.1:1/../#pair=ab",
            "http://127.0.0.1:17615@evil.example/#pair=ab",
            "--help",
            "file:///C:/Windows/System32/calc.exe",
            "http://127.0.0.1:17615/#pair=zz",
        ] {
            assert!(!super::is_own_link(bad), "{bad:?}");
        }
    }

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

#[cfg(test)]
mod vault_tests {
    use super::*;

    fn admin(name: &str) -> (ConfigVaults, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("tasks-desktop-cv-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let cfg = base.join("cfg");
        let vault = base.join("vault-two");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&cfg).unwrap();
        let main = base.join("main-vault");
        std::fs::create_dir_all(&main).unwrap();
        let file = FileConfig {
            vault: Some(main),
            ..FileConfig::default()
        };
        // The hub starts from the file on disk, and a change reads it again.
        config::save_file(&cfg, &file).unwrap();
        (
            ConfigVaults::new(cfg.clone(), Env::default(), file),
            cfg,
            vault,
        )
    }

    #[tokio::test]
    async fn adding_checks_the_name_the_folder_and_writes_the_file_once() {
        let (admin, cfg, vault) = admin("add");
        let path = vault.to_string_lossy().into_owned();
        // A share is refused for what it is, before anything looks at it (a lookup is what makes Windows sign in).
        for share in [
            "//host/share/vault",
            r"\\host\share\vault",
            r"/\host\share\vault",
            r"\/host/share/vault",
            r"\\?\UNC\host\share\vault",
            r"\\.\pipe\vault",
            r"\??\UNC\host\share\vault",
            "/??/UNC/host/share/vault",
        ] {
            let why = admin.add("two", share).await.unwrap_err();
            assert!(why.contains("network folder"), "{share}: {why}");
        }
        let before = std::fs::read(cfg.join("config.json")).unwrap();
        for (name, folder) in [
            ("main", path.as_str()),
            ("a b", path.as_str()),
            ("two", "relative/folder"),
            ("two", "/no/such/folder/anywhere"),
            // a network share is never looked at (Windows would sign in to it)
            ("two", "//host/share/vault"),
            ("two", r"\\host\share\vault"),
        ] {
            assert!(admin.add(name, folder).await.is_err(), "{name} {folder}");
        }
        assert_eq!(
            std::fs::read(cfg.join("config.json")).unwrap(),
            before,
            "a refused add wrote"
        );
        admin.add("two", &path).await.unwrap();
        assert!(admin.add("two", &path).await.is_err(), "twice");
        let saved = config::load_file(&cfg).unwrap();
        assert_eq!(saved.vaults.len(), 1);
        assert_eq!(saved.vaults[0].name, "two");
        let list = admin.list();
        assert_eq!(list.active, "main");
        let names: Vec<_> = list.vaults.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, ["main", "two"]);
        assert_eq!(list.vaults[1].label, "vault-two", "the last part only");
    }

    #[tokio::test]
    async fn a_setting_changed_by_hand_meanwhile_is_not_written_over() {
        let (admin, cfg, vault) = admin("hand");
        // The person edits the file while the hub runs: the port is new.
        let mut edited = config::load_file(&cfg).unwrap();
        edited.port = Some(23456);
        config::save_file(&cfg, &edited).unwrap();
        admin.add("two", &vault.to_string_lossy()).await.unwrap();
        let saved = config::load_file(&cfg).unwrap();
        assert_eq!(saved.port, Some(23456), "the edit was undone");
        assert_eq!(saved.vaults.len(), 1);
        // A file that cannot be read now stops the change instead of replacing it.
        std::fs::write(cfg.join("config.json"), "{ not json").unwrap();
        assert!(admin.remove("two").await.is_err());
        assert_eq!(
            std::fs::read_to_string(cfg.join("config.json")).unwrap(),
            "{ not json"
        );
    }

    #[tokio::test]
    async fn the_vault_that_is_read_cannot_be_removed_and_an_unknown_one_cannot_be_chosen() {
        let (admin, cfg, vault) = admin("remove");
        admin.add("two", &vault.to_string_lossy()).await.unwrap();
        assert!(admin.remove("main").await.is_err(), "the active vault");
        assert!(admin.remove("nope").await.is_err());
        assert!(admin.select("nope").await.is_err());
        admin.remove("two").await.unwrap();
        assert!(config::load_file(&cfg).unwrap().vaults.is_empty());
    }

    #[tokio::test]
    async fn the_vault_the_hub_reads_cannot_be_removed_even_if_the_file_names_another() {
        let (admin, cfg, vault) = admin("remove-read");
        admin.add("two", &vault.to_string_lossy()).await.unwrap();
        // The hub reads "two" (as kept in memory) ...
        let mut reading = admin.current();
        reading.active = Some("two".to_owned());
        *admin.file.lock().unwrap() = reading;
        // ... while a hand edit moved `active` on disk back to the main vault.
        let mut edited = config::load_file(&cfg).unwrap();
        edited.active = None;
        config::save_file(&cfg, &edited).unwrap();
        let why = admin.remove("two").await.unwrap_err();
        assert!(why.contains("is read"), "{why}");
        assert_eq!(config::load_file(&cfg).unwrap().vaults.len(), 1);
    }

    #[tokio::test]
    async fn a_hand_edit_of_the_active_vault_does_not_move_the_one_the_hub_reads_over_several_changes(
    ) {
        let (admin, cfg, vault) = admin("remove-twice");
        let path = vault.to_string_lossy().into_owned();
        admin.add("two", &path).await.unwrap();
        admin.add("three", &path).await.unwrap();
        // The hub reads "two" ...
        let mut reading = admin.current();
        reading.active = Some("two".to_owned());
        *admin.file.lock().unwrap() = reading;
        // ... a hand edit puts `active` back to the main vault on disk.
        let mut edited = config::load_file(&cfg).unwrap();
        edited.active = None;
        config::save_file(&cfg, &edited).unwrap();
        // A change of the list passes, and must not take the memory over from the disk.
        admin.remove("three").await.unwrap();
        assert_eq!(
            admin.list().active,
            "two",
            "the page names the vault that is read"
        );
        let why = admin.remove("two").await.unwrap_err();
        assert!(why.contains("is read"), "{why}");
        admin.add("four", &path).await.unwrap();
        assert_eq!(admin.list().active, "two");
        assert!(admin.remove("two").await.is_err());
        // The file keeps what the person wrote.
        assert_eq!(config::load_file(&cfg).unwrap().active, None);
    }

    #[tokio::test]
    async fn the_vault_that_is_read_keeps_its_entry_when_the_file_forgets_or_moves_it() {
        let (admin, cfg, vault) = admin("entry");
        let path = vault.to_string_lossy().into_owned();
        admin.add("two", &path).await.unwrap();
        let mut reading = admin.current();
        reading.active = Some("two".to_owned());
        *admin.file.lock().unwrap() = reading;
        // A hand edit drops the entry of the vault that is read ...
        let mut edited = config::load_file(&cfg).unwrap();
        edited.vaults.clear();
        config::save_file(&cfg, &edited).unwrap();
        admin.add("three", &path).await.unwrap();
        let names: Vec<_> = admin.list().vaults.iter().map(|v| v.name.clone()).collect();
        assert_eq!(names, ["main", "three", "two"].map(String::from));
        assert_eq!(admin.list().active, "two");
        // ... or gives it another folder: the entry the hub reads from stays.
        let mut edited = config::load_file(&cfg).unwrap();
        edited.vaults = vec![config::VaultEntry {
            name: "two".to_owned(),
            path: std::env::temp_dir().join("tasks-desktop-elsewhere"),
        }];
        config::save_file(&cfg, &edited).unwrap();
        admin.add("five", &path).await.unwrap();
        let held = admin.current();
        let two = held.vaults.iter().find(|v| v.name == "two").unwrap();
        assert_eq!(two.path, vault);
    }

    /// A choice is the one change that moves the vault the hub reads: it needs a real engine on the fixture vault,
    /// so it is skipped without one (CI sets `TASKS_DESKTOP_REQUIRE_ENGINE` and makes that a failure).
    #[tokio::test]
    async fn a_choice_moves_the_vault_that_is_read_and_a_later_change_does_not_move_it_back() {
        let base =
            std::env::temp_dir().join(format!("tasks-desktop-cv-choice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let cfg = base.join("cfg");
        let main = base.join("main-vault");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::create_dir_all(&main).unwrap();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("e2e")
            .join("fixture")
            .join("vault");
        let file = FileConfig {
            vault: Some(main),
            extra_areas: ["ALL", "nvim-config", "docmap-desktop", "migrate.nvim"]
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            ..FileConfig::default()
        };
        config::save_file(&cfg, &file).unwrap();
        let admin = ConfigVaults::new(cfg.clone(), Env::from_process(), file);
        admin.add("two", &fixture.to_string_lossy()).await.unwrap();
        if let Err(why) = admin.select("two").await {
            // Only a vault the engine cannot read is a reason to skip; any other refusal is a bug of the choice.
            assert!(
                why.starts_with("this vault cannot be read"),
                "the choice was refused for another reason: {why}"
            );
            assert!(
                std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_none(),
                "the engine is required but not usable: {why}"
            );
            eprintln!("skipped: {why}");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        // The choice moved the vault that is read, in memory and in the file.
        assert_eq!(admin.list().active, "two");
        assert_eq!(
            config::load_file(&cfg).unwrap().active.as_deref(),
            Some("two")
        );
        assert!(admin.remove("two").await.is_err(), "the vault that is read");
        // A hand edit puts `active` back on disk; a later add leaves the vault that is read alone.
        let mut edited = config::load_file(&cfg).unwrap();
        edited.active = None;
        config::save_file(&cfg, &edited).unwrap();
        admin
            .add("three", &fixture.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(admin.list().active, "two");
        assert!(admin.remove("two").await.is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_vault_the_file_forgot_that_is_not_read_may_be_added_again() {
        let (admin, cfg, vault) = admin("ghost");
        let path = vault.to_string_lossy().into_owned();
        admin.add("two", &path).await.unwrap();
        // A hand edit drops "two" from the file; the hub reads the main vault, so "two" is no vault of the hub's.
        let mut edited = config::load_file(&cfg).unwrap();
        edited.vaults.clear();
        config::save_file(&cfg, &edited).unwrap();
        admin.add("two", &path).await.unwrap();
        assert_eq!(config::load_file(&cfg).unwrap().vaults.len(), 1);
    }

    #[tokio::test]
    async fn a_name_the_hub_reads_from_is_taken_even_when_the_file_forgot_it() {
        let (admin, cfg, vault) = admin("taken");
        let path = vault.to_string_lossy().into_owned();
        admin.add("two", &path).await.unwrap();
        let mut reading = admin.current();
        reading.active = Some("two".to_owned());
        *admin.file.lock().unwrap() = reading;
        // A hand edit drops the entry; adding the name again, with another folder, must not take the place of the
        // vault that is read (the page would claim a folder the engine does not read).
        let mut edited = config::load_file(&cfg).unwrap();
        edited.vaults.clear();
        config::save_file(&cfg, &edited).unwrap();
        let why = admin.add("two", &path).await.unwrap_err();
        assert!(why.contains("there already"), "{why}");
        assert!(
            config::load_file(&cfg).unwrap().vaults.is_empty(),
            "nothing was written"
        );
    }
}
