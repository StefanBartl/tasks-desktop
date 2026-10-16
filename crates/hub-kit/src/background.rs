//! The hub as a background program: `start`, `stop` and the start with the
//! login (`autostart`).
//!
//! `start` runs `serve` again as a program of its own that has no window and
//! does not end with the terminal; its output goes to `hub.log` in the config
//! folder. A hub is only believed (and only stopped) when the process on its
//! port says the instance of `hub.json`: a stale file never makes `stop` kill
//! a process that merely got the same number.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use app_core::identity::AppIdentity;

use crate::env::Env;
use crate::instance;
use crate::loginitems::{self, LoginApp};

/// What the commands need to know about the app: its names and the files it keeps besides the kit's.
#[derive(Debug, Clone, Copy)]
pub struct Background<'a> {
    pub login: LoginApp<'a>,
    /// The files of the app in the config folder that `uninstall --purge-settings` removes in
    /// addition to those of the kit (`config.json`, `usage.json`, `hub.json`, `control.secret`,
    /// `hub.log`). Nothing else is ever removed there.
    pub extra_files: &'a [&'a str],
}

impl Background<'_> {
    fn identity(&self) -> &AppIdentity {
        self.login.identity
    }

    /// The name of the value under the `Run` key of the registry.
    fn run_value(&self) -> &str {
        self.identity().app
    }
}

/// The `Run` key of the current user (no administrator rights needed).
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// The log is cut at the start when it is larger than this.
const LOG_LIMIT: u64 = 256 * 1024;

/// `autostart on | off | status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Autostart {
    On,
    Off,
    Status,
}

/// The command that is registered: the program (quoted) and `start`.
#[must_use]
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" start", exe.display())
}

fn log_file(dir: &Path) -> Result<std::fs::File, String> {
    let path = dir.join("hub.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Start a hub in the background unless one runs. Returns what to print.
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn start(app: &Background<'_>) -> Result<String, String> {
    let env = Env::from_process();
    let dir = instance::config_folder(&env, app.identity())?;
    if let Some(record) = instance::running_hub(&dir, app.identity()).await {
        return Ok(format!(
            "a hub is already running (port {}, process {})\n",
            record.port, record.pid
        ));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the config folder: {e}"))?;
    if let Some(warning) = private_storage_warning(&env, &dir) {
        eprintln!("{warning}");
    }
    let exe = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    // The log is created (and cut when it is large) before the hub writes.
    drop(log_file(&dir)?);
    if !spawn_hidden(&exe, &dir) {
        let log = log_file(&dir)?;
        let err = log
            .try_clone()
            .map_err(|e| format!("cannot write the log: {e}"))?;
        let mut command = Command::new(&exe);
        command
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err));
        detach(&mut command);
        let child = command
            .spawn()
            .map_err(|e| format!("the hub could not be started: {e}"))?;
        drop(child);
    }

    // The hub says it is there by its record and its answer.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(record) = instance::running_hub(&dir, app.identity()).await {
            return Ok(format!(
                "the hub runs in the background (port {}, process {})\n",
                record.port, record.pid
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err(format!(
        "the hub did not come up within 20 seconds; see {}",
        dir.join("hub.log").display()
    ))
}

/// The bytes of a script for the script host: UTF-16 with a byte order
/// mark, the one form it reads whatever the code page of the system is (a
/// profile named `Müller` is a path in the script).
fn vbs_bytes(text: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// The command line that runs the hub with its output in the log. `None`
/// for a path `cmd.exe` would read as something else.
fn hidden_command_line(exe: &Path, log: &Path) -> Option<String> {
    let plain = |p: &Path| {
        let t = p.to_string_lossy();
        !t.is_empty() && !t.contains(['"', '%', '\r', '\n'])
    };
    (plain(exe) && plain(log)).then(|| {
        format!(
            r#"cmd.exe /d /c ""{}" serve >>"{}" 2>&1""#,
            exe.display(),
            log.display()
        )
    })
}

/// The text of a script that starts `command` with no window and does not
/// wait for it.
fn script_text(command: &str) -> String {
    format!(
        "CreateObject(\"WScript.Shell\").Run \"{}\", 0, False\r\n",
        command.replace('"', "\"\"")
    )
}

/// Start the hub through the script host. A program started from here
/// inherits every handle this process holds, so one that is started
/// directly keeps a pipe of the caller (`<program> start | ...`) open for as
/// long as it runs; the script host starts it without them. Returns whether
/// that worked (otherwise the caller starts the program itself).
fn spawn_hidden(exe: &Path, dir: &Path) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let Some(line) = hidden_command_line(exe, &dir.join("hub.log")) else {
        return false;
    };
    let Ok(host) = system_program("wscript.exe") else {
        return false;
    };
    let script = dir.join("start-hub.vbs");
    if std::fs::write(&script, vbs_bytes(&script_text(&line))).is_err() {
        return false;
    }
    let ran = Command::new(host)
        .args(["//B", "//Nologo"])
        .arg(&script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&script);
    ran
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    command.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Its own process group: a Ctrl-C of the terminal does not reach it.
    command.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn detach(_command: &mut Command) {}

/// Stop the hub that runs (the one `hub.json` names and that answers as it).
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn stop(app: &Background<'_>) -> Result<String, String> {
    let env = Env::from_process();
    let dir = instance::config_folder(&env, app.identity())?;
    let Some(record) = instance::running_hub(&dir, app.identity()).await else {
        return Ok("no hub is running\n".to_owned());
    };
    let pid = record.pid.to_string();
    let status = if cfg!(windows) {
        Command::new(system_program("taskkill.exe")?)
            .args(["/PID", &pid, "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        Command::new("/bin/kill")
            .args(["-TERM", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    }
    .map_err(|e| format!("could not stop the hub: {e}"))?;
    if !status.success() {
        return Err(format!("the process {pid} could not be stopped"));
    }
    // The record of a hub that was killed stays behind; take it away.
    for _ in 0..25 {
        if instance::running_hub(&dir, app.identity()).await.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = std::fs::remove_file(dir.join("hub.json"));
    let _ = std::fs::remove_file(dir.join("control.secret"));
    Ok(format!("the hub (process {pid}) is stopped\n"))
}

/// An absolute path of a program of the system folder (never one found
/// along a PATH).
fn system_program(name: &str) -> Result<PathBuf, String> {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("no Windows folder found")?;
    Ok(root.join("System32").join(name))
}

/// Start the hub with the login of the user (Windows: the `Run` key; Linux: an
/// autostart entry; macOS: a launch agent).
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn autostart(app: &Background<'_>, what: Autostart) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    let env = Env::from_process();
    // The login entry is in the registry, which a packaged app redirects whatever
    // the config folder is; the folder of AppData always exists to be probed.
    if let Some(warning) = env
        .path("LOCALAPPDATA")
        .and_then(|local| private_storage_warning(&env, &local))
    {
        eprintln!("{warning}");
    }
    autostart_for(app, what, &exe)
}

/// [`autostart`] for the program at `exe` (what `install` registers).
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn autostart_for(app: &Background<'_>, what: Autostart, exe: &Path) -> Result<String, String> {
    if !cfg!(windows) {
        let platform = loginitems::Platform::current().ok_or_else(|| {
            format!(
                "autostart is not built for this system (put `{} start` into its login items)",
                app.identity().binary
            )
        })?;
        let action = match what {
            Autostart::On => loginitems::Action::On,
            Autostart::Off => loginitems::Action::Off,
            Autostart::Status => loginitems::Action::Status,
        };
        return loginitems::login_entry(&app.login, platform, action, exe, &Env::from_process());
    }
    run_key(
        app.run_value(),
        what,
        exe,
        &RegExe(system_program("reg.exe")?),
    )
}

/// What one call of `reg.exe` came to: whether it succeeded, what it printed and what it complained of.
struct RegOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl RegOutput {
    /// `": <the first line of the complaint>"`, or nothing. The reason of a refusal (rule RS-06) is
    /// not thrown away; it goes to the terminal of the person only, cleaned of control characters.
    fn reason(&self) -> String {
        let line = self
            .stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let clean: String = line
            .trim()
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(200)
            .collect();
        if clean.is_empty() {
            String::new()
        } else {
            format!(": {clean}")
        }
    }
}

/// The registry, as far as the login entry needs it: one call of `reg.exe` with
/// these arguments. The seam lets the tests stand in for the real registry,
/// which they must never change.
trait Registry {
    /// # Errors
    ///
    /// The program could not be run at all (a refusal of `reg.exe` is no error here).
    fn run(&self, args: &[OsString]) -> Result<RegOutput, String>;
}

/// The real thing: `reg.exe` of the system folder.
struct RegExe(PathBuf);

impl Registry for RegExe {
    fn run(&self, args: &[OsString]) -> Result<RegOutput, String> {
        let out = Command::new(&self.0)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("reg.exe did not run: {e}"))?;
        Ok(RegOutput {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

/// The login entry in the `Run` key: on, off or its state.
fn run_key(value: &str, what: Autostart, exe: &Path, reg: &dyn Registry) -> Result<String, String> {
    match what {
        Autostart::On => {
            let mut add = args(&["add", RUN_KEY, "/v", value, "/t", "REG_SZ", "/d"]);
            add.push(OsString::from(run_command(exe)));
            add.push(OsString::from("/f"));
            let added = reg.run(&add)?;
            if added.success {
                Ok(format!(
                    "the hub starts with your login: {}\n",
                    run_command(exe)
                ))
            } else {
                Err(format!("the entry could not be written{}", added.reason()))
            }
        }
        Autostart::Off => {
            let deleted = reg.run(&args(&["delete", RUN_KEY, "/v", value, "/f"]))?;
            // A missing value is not an error: it is what was asked for. One that
            // is still there is (a policy or an ACL on the key). `reg delete` exits
            // the same for both, so the key is asked.
            if !deleted.success && login_value_present(value, reg)? {
                return Err(format!(
                    "the entry could not be removed{}",
                    deleted.reason()
                ));
            }
            Ok("the hub does not start with your login\n".to_owned())
        }
        Autostart::Status => {
            let out = reg.run(&args(&["query", RUN_KEY, "/v", value]))?;
            if out.success {
                Ok(format!(
                    "on: {}\n",
                    out.stdout
                        .lines()
                        .find(|l| l.contains(value))
                        .unwrap_or("")
                        .trim()
                ))
            } else {
                Ok("off\n".to_owned())
            }
        }
    }
}

/// Whether the `Run` key holds the value of the hub (`reg query` finds it).
fn login_value_present(value: &str, reg: &dyn Registry) -> Result<bool, String> {
    Ok(reg.run(&args(&["query", RUN_KEY, "/v", value]))?.success)
}

/// Windows keeps what a *packaged* app (an MSIX, like the Claude app) and its
/// child processes write below `AppData`, and into the registry, in a private
/// store of that app. A terminal of the user does not see any of it: the
/// program, the settings and the login entry would be there for the app and
/// missing for the person. Nothing in the environment says so, so a probe
/// file is written and looked for in the stores of the packages.
///
/// Returns the folder of the package that holds the probe.
fn private_storage_of(env: &Env, dir: &Path) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let local = env.path("LOCALAPPDATA")?;
    let roaming = env.path("APPDATA");
    let (kind, rel) = if let Some(rel) = strip_prefix_ignore_case(dir, &local) {
        ("Local", rel)
    } else {
        let rel = roaming
            .as_deref()
            .and_then(|r| strip_prefix_ignore_case(dir, r))?;
        ("Roaming", rel)
    };
    let name = format!(".probe-{}", std::process::id());
    let probe = dir.join(&name);
    std::fs::write(&probe, b"").ok()?;
    let found = find_in_packages(&local, kind, &rel, &name);
    let _ = std::fs::remove_file(&probe);
    found
}

/// `path` below `base`, the way Windows compares names (case does not matter).
fn strip_prefix_ignore_case(path: &Path, base: &Path) -> Option<PathBuf> {
    let mut rest = path.components();
    for part in base.components() {
        let own = rest.next()?;
        let same = |c: Component| c.as_os_str().to_string_lossy().to_lowercase();
        if same(own) != same(part) {
            return None;
        }
    }
    Some(rest.as_path().to_path_buf())
}

/// The package whose private store holds `<kind>/<rel>/<name>`.
fn find_in_packages(local: &Path, kind: &str, rel: &Path, name: &str) -> Option<PathBuf> {
    std::fs::read_dir(local.join("Packages"))
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|pkg| {
            pkg.join("LocalCache")
                .join(kind)
                .join(rel)
                .join(name)
                .exists()
        })
}

/// A line to put in front of the person when this program runs inside a
/// packaged app.
fn private_storage_warning(env: &Env, dir: &Path) -> Option<String> {
    let package = private_storage_of(env, dir)?;
    Some(format!(
        "warning: this program runs inside a packaged app ({}). What it writes below AppData \
         and into the registry (the program, the settings, the login entry) stays in that \
         app's private storage, and a terminal of your own does not see it. Run this command \
         in a normal terminal.",
        package.display()
    ))
}

/// Where `install` puts the program: a folder of this user that is not
/// roaming (the settings are; a program is not).
fn install_dir(app: &Background<'_>, env: &Env) -> Result<PathBuf, String> {
    let var = app.identity().var("INSTALL_DIR");
    if let Some(dir) = env.path(&var) {
        // A relative folder would mean whatever the working folder is.
        if !dir.is_absolute() {
            return Err(format!("{var} must be an absolute path"));
        }
        return Ok(dir);
    }
    let base = if cfg!(windows) {
        env.path("LOCALAPPDATA")
            .ok_or_else(|| format!("no LOCALAPPDATA: set {var}"))?
    } else if let Some(x) = env.path("XDG_DATA_HOME") {
        x
    } else {
        env.path("HOME")
            .map(|h| h.join(".local").join("share"))
            .ok_or_else(|| format!("no HOME: set {var}"))?
    };
    Ok(base.join(app.identity().app).join("bin"))
}

/// Where `install` puts this program: the install folder and the file name of the running program.
///
/// # Errors
///
/// The reason there is no install folder (no `LOCALAPPDATA`, `HOME`, or a relative `<PREFIX>_INSTALL_DIR`).
pub fn installed_program(app: &Background<'_>, env: &Env) -> Result<PathBuf, String> {
    Ok(install_dir(app, env)?.join(app.identity().program_file()))
}

/// What `install` was asked for.
#[derive(Debug, Clone, Copy, Default)]
pub struct InstallOptions {
    /// Register the installed program with the login of the user.
    pub autostart: bool,
    /// Put a link (named by the title of the app) on the desktop (Windows).
    pub shortcut: bool,
}

/// With this variable set, `install` leaves an existing login entry alone
/// (it does not point it at the installed copy). The tests of the program set
/// it: the entry of the machine they run on is not theirs to change.
fn no_login_sync(app: &Background<'_>) -> String {
    app.identity().var("NO_LOGIN_SYNC")
}

/// Copy this program to a fixed place, so that a build in the repository
/// does not fight the running hub for the file, and start the hub from there
/// again when one was running.
///
/// # Errors
///
/// A text for the person at the terminal. What was done before it is printed
/// (the caller prints a text only when all went well).
pub async fn install(app: &Background<'_>, opts: InstallOptions) -> Result<String, String> {
    let mut out = String::new();
    match install_steps(app, opts, &mut out).await {
        Ok(()) => Ok(out),
        Err(e) => {
            print!("{out}");
            Err(e)
        }
    }
}

/// How often the program file is moved over the old one, and the pause between the tries.
const RENAME_TRIES: u32 = 3;
const RENAME_PAUSE: Duration = Duration::from_millis(200);

/// Whether a failed rename is the file being held for a moment (a virus scanner or the indexer after the program
/// ended): "access denied" (5) or "in use" (32, 33) on Windows. Nothing else is tried again, and no other system.
fn file_is_held(error: &std::io::Error) -> bool {
    cfg!(windows)
        && (error.kind() == std::io::ErrorKind::PermissionDenied
            || matches!(error.raw_os_error(), Some(5 | 32 | 33)))
}

/// Run `attempt` up to `tries` times, `pause` apart, again only while `held` says the error is a moment's. On failure
/// the error comes back with the number of tries made.
async fn retry_while_held<F>(
    mut attempt: F,
    held: fn(&std::io::Error) -> bool,
    tries: u32,
    pause: Duration,
) -> Result<(), (std::io::Error, u32)>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut made = 0;
    loop {
        made += 1;
        match attempt() {
            Ok(()) => return Ok(()),
            Err(e) if made < tries && held(&e) => tokio::time::sleep(pause).await,
            Err(e) => return Err((e, made)),
        }
    }
}

/// What `install` says when the new program could not be moved over the old one: the tries, if more than one was
/// made, and the hint that fits.
fn replace_failure(target: &Path, made: u32, hint: &str, error: &std::io::Error) -> String {
    let tries = if made > 1 {
        format!(" after {made} tries")
    } else {
        String::new()
    };
    format!("cannot replace {}{tries}{hint}: {error}", target.display())
}

async fn install_steps(
    app: &Background<'_>,
    opts: InstallOptions,
    out: &mut String,
) -> Result<(), String> {
    let env = Env::from_process();
    let dir = install_dir(app, &env)?;
    let from = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    let name = std::ffi::OsString::from(app.identity().program_file());
    let target = dir.join(&name);

    // A program that is the one being installed (run from the install
    // folder) has nothing to copy.
    let same = match (std::fs::canonicalize(&from), std::fs::canonicalize(&target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    let config = instance::config_folder(&env, app.identity())?;
    let was_running = instance::running_hub(&config, app.identity())
        .await
        .is_some();
    if !same {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        // Copy beside, then move over: a copy that is cut short never
        // replaces a program that works. The hub runs until the move: nothing
        // before it needs it stopped.
        let part = dir.join(format!("{}.new", name.to_string_lossy()));
        if let Err(e) = std::fs::copy(&from, &part) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("cannot copy to {}: {e}", part.display()));
        }
        if was_running {
            match stop(app).await {
                Ok(text) => out.push_str(&text),
                Err(e) => {
                    let _ = std::fs::remove_file(&part);
                    return Err(e);
                }
            }
        }
        if let Err((e, made)) = retry_while_held(
            || std::fs::rename(&part, &target),
            file_is_held,
            RENAME_TRIES,
            RENAME_PAUSE,
        )
        .await
        {
            let _ = std::fs::remove_file(&part);
            // A hub that was stopped for this is not left down: it comes back
            // from the old installed program, or from this one.
            let hint = if was_running {
                String::new()
            } else {
                format!(
                    " (is a hub running from it? `{} stop`)",
                    app.identity().binary
                )
            };
            let mut message = replace_failure(&target, made, &hint, &e);
            if was_running {
                let back = if target.is_file() {
                    start_from(&target)
                } else {
                    start(app).await
                };
                match back {
                    Ok(text) => out.push_str(&text),
                    Err(e) => message.push_str(&format!("; the hub is down: {e}")),
                }
            }
            return Err(message);
        }
    }
    out.push_str(&format!("installed: {}\n", target.display()));
    if let Some(warning) = private_storage_warning(&env, &dir) {
        // On stderr and at once: a later error must not take it away.
        eprintln!("{warning}");
    }
    if was_running && !same {
        // The hub comes back from the installed program, before the steps that
        // do not need it: one of them failing must not leave it down.
        out.push_str(&start_from(&target)?);
    }

    if opts.autostart {
        out.push_str(&autostart_for(app, Autostart::On, &target)?);
    } else if env.get(&no_login_sync(app)).is_none() && autostart_is_on(app) {
        // It was registered for another copy: point it here.
        out.push_str(&autostart_for(app, Autostart::On, &target)?);
    }
    if opts.shortcut {
        out.push_str(&shortcut(app, &target)?);
    }
    Ok(())
}

/// Run `<program> start` and return what it printed. Its complaint (on
/// stderr, a warning included) goes to the terminal as it is.
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn start_from(program: &Path) -> Result<String, String> {
    let started = Command::new(program)
        .arg("start")
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| format!("the installed program did not start: {e}"))?;
    if started.status.success() {
        Ok(String::from_utf8_lossy(&started.stdout).into_owned())
    } else {
        Err("the hub did not come back from the installed program (see above)".to_owned())
    }
}

fn autostart_is_on(app: &Background<'_>) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    matches!(autostart_for(app, Autostart::Status, &exe), Ok(text) if text.starts_with("on"))
}

/// What `uninstall` was asked for.
#[derive(Debug, Clone, Copy, Default)]
pub struct UninstallOptions {
    /// Also remove the settings of the app in the config folder (never the vault).
    pub purge_settings: bool,
}

/// The files every hub keeps in the config folder; those of the app are added by [`Background`].
/// Nothing else is ever removed there.
const KIT_FILES: [&str; 5] = [
    "config.json",
    "usage.json",
    "hub.json",
    "control.secret",
    "hub.log",
];

/// Remove the files of the app from the config folder, and the folder when nothing else is in it.
fn purge_settings(app: &Background<'_>, dir: &Path) -> Result<String, String> {
    let mut removed = Vec::new();
    for name in KIT_FILES.iter().chain(app.extra_files) {
        let file = dir.join(name);
        match std::fs::remove_file(&file) {
            Ok(()) => removed.push(*name),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot remove {}: {e}", file.display())),
        }
    }
    let mut text = if removed.is_empty() {
        format!("no settings were in {}\n", dir.display())
    } else {
        format!(
            "settings removed from {}: {}\n",
            dir.display(),
            removed.join(", ")
        )
    };
    // `remove_dir` takes an empty folder only: a folder with other files stays.
    match std::fs::remove_dir(dir) {
        Ok(()) => text.push_str("the settings folder is removed\n"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => text.push_str("the settings folder holds other files and stays\n"),
    }
    Ok(text)
}

/// Take the integration of the program with the system away: stop the hub, the login entry, the
/// link or launcher, and (when asked) the settings. The program file itself is left: it is the
/// one that runs, and a running program cannot delete itself on every system; the scripts
/// `scripts/uninstall.*` remove the install folder after this program has ended. The vault and
/// the tasks are never touched.
///
/// # Errors
///
/// A text for the person at the terminal. Every step is tried; the steps that failed are named
/// together at the end (what went right is printed first).
pub fn uninstall<'a>(
    app: &'a Background<'a>,
    opts: UninstallOptions,
) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
    // On the heap, and made here: the future of the steps is large, and in a debug build a large
    // future that is made in the `match` of `main` takes room in the stack of the main thread for
    // every command (it overflowed it, `serve` included).
    Box::pin(uninstall_steps(app, opts))
}

async fn uninstall_steps(app: &Background<'_>, opts: UninstallOptions) -> Result<String, String> {
    let env = Env::from_process();
    let mut out = String::new();
    let mut failed: Vec<String> = Vec::new();
    let mut step = |result: Result<String, String>, out: &mut String| match result {
        Ok(text) => out.push_str(&text),
        Err(e) => failed.push(e),
    };

    step(stop(app).await, &mut out);
    let exe = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    if env.get(&no_login_sync(app)).is_some() {
        // The tests of the program: the login entry and the link of the machine are not theirs.
        out.push_str(&format!(
            "the login entry and the link are left alone ({})\n",
            no_login_sync(app)
        ));
    } else {
        step(autostart(app, Autostart::Off), &mut out);
        step(remove_shortcut(app, &env), &mut out);
    }
    if opts.purge_settings {
        match instance::config_folder(&env, app.identity()) {
            Ok(dir) => step(purge_settings(app, &dir), &mut out),
            Err(e) => failed.push(e),
        }
    } else if let Ok(dir) = instance::config_folder(&env, app.identity()) {
        out.push_str(&format!(
            "your settings stay in {} (`uninstall --purge-settings` removes them)\n",
            dir.display()
        ));
    }
    out.push_str(&format!(
        "the program file is left at {}: delete it (scripts/uninstall does)\n",
        exe.display()
    ));
    if failed.is_empty() {
        Ok(out)
    } else {
        print!("{out}");
        Err(failed.join("; "))
    }
}

/// Take the link of the desktop (named by the title of the app) away (Windows), or the launcher (Linux).
fn remove_shortcut(app: &Background<'_>, env: &Env) -> Result<String, String> {
    if !cfg!(windows) {
        let Some(platform) = loginitems::Platform::current() else {
            return Ok(String::new());
        };
        return loginitems::remove_launcher(&app.login, platform, env);
    }
    // Only a link of that name whose target is this program: a link of the person's own
    // that happens to have the same name is not ours to delete.
    let title = app.identity().title;
    let program = app.identity().program_file();
    let len = program.len();
    let script = format!(
        "Set shell = CreateObject(\"WScript.Shell\")\r\n\
Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n\
path = shell.SpecialFolders(\"Desktop\") & \"\\{title}.lnk\"\r\n\
If fso.FileExists(path) Then\r\n\
  If LCase(Right(shell.CreateShortcut(path).TargetPath, {len})) = \"{program}\" Then fso.DeleteFile path, True\r\n\
End If\r\n"
    );
    let path = std::env::temp_dir().join(format!(
        "{}-unlink-{}.vbs",
        app.identity().app,
        std::process::id()
    ));
    std::fs::write(&path, vbs_bytes(&script)).map_err(|e| format!("cannot write a script: {e}"))?;
    let ok = Command::new(system_program("wscript.exe")?)
        .args(["//B", "//Nologo"])
        .arg(&path)
        .status()
        .is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&path);
    if ok {
        // A link of the person's own with that name is not ours and stays: the text does not
        // claim that the desktop is free of any link of that name.
        Ok(format!(
            "no link \"{title}\" of ours is on the desktop (one that was is removed)\n"
        ))
    } else {
        Err("the link on the desktop could not be checked".to_owned())
    }
}

/// A link on the desktop (named by the title of the app) that starts the hub and opens the page.
fn shortcut(app: &Background<'_>, exe: &Path) -> Result<String, String> {
    if !cfg!(windows) {
        let platform =
            loginitems::Platform::current().ok_or("a launcher is not built for this system")?;
        return loginitems::launcher(&app.login, platform, exe, &Env::from_process());
    }
    let text = exe.to_string_lossy();
    if text.contains(['"', '\r', '\n']) {
        return Err("the path of the program cannot be put in a link".to_owned());
    }
    let title = app.identity().title;
    let app = app.identity().app;
    let script = format!(
        "Set link = CreateObject(\"WScript.Shell\").CreateShortcut(\
CreateObject(\"WScript.Shell\").SpecialFolders(\"Desktop\") & \"\\{title}.lnk\")\r\n\
link.TargetPath = \"{text}\"\r\n\
link.Arguments = \"start --open\"\r\n\
link.WindowStyle = 7\r\n\
link.Description = \"{app}: start the hub and open the page\"\r\n\
link.Save\r\n"
    );
    let dir = std::env::temp_dir();
    let path = dir.join(format!("{app}-link-{}.vbs", std::process::id()));
    std::fs::write(&path, vbs_bytes(&script)).map_err(|e| format!("cannot write a script: {e}"))?;
    let ok = Command::new(system_program("wscript.exe")?)
        .args(["//B", "//Nologo"])
        .arg(&path)
        .status()
        .is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&path);
    if ok {
        Ok(format!("a link \"{title}\" is on the desktop\n"))
    } else {
        Err("the desktop link could not be made".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An app that is not the one this kit was made from.
    const IDENTITY: AppIdentity = AppIdentity {
        app: "rules-desktop",
        binary: "rules-hub",
        env_prefix: "RULES_DESKTOP",
        title: "Rules",
        default_port: 17616,
        route_ns: "rules",
    };
    const EXTRA: [&str; 2] = ["rules.json", "waivers.json"];
    const APP: Background<'static> = Background {
        login: LoginApp {
            identity: &IDENTITY,
            summary: "the rule overview",
        },
        extra_files: &EXTRA,
    };
    const RUN_VALUE: &str = "rules-desktop";

    fn run_key(what: Autostart, exe: &Path, reg: &dyn Registry) -> Result<String, String> {
        super::run_key(RUN_VALUE, what, exe, reg)
    }

    fn purge_settings(dir: &Path) -> Result<String, String> {
        super::purge_settings(&APP, dir)
    }

    #[test]
    fn the_names_come_from_the_app_and_nothing_says_tasks() {
        assert_eq!(APP.run_value(), "rules-desktop");
        let env = Env::from_pairs([
            (
                "RULES_DESKTOP_INSTALL_DIR",
                if cfg!(windows) { "C:/i" } else { "/i" },
            ),
            ("TASKS_DESKTOP_INSTALL_DIR", "/wrong"),
        ]);
        let program = installed_program(&APP, &env).unwrap();
        assert!(program.ends_with(IDENTITY.program_file()), "{program:?}");
        assert!(!program.to_string_lossy().to_lowercase().contains("tasks"));
        assert_eq!(no_login_sync(&APP), "RULES_DESKTOP_NO_LOGIN_SYNC");
        // The error names the variable of this app, not another.
        let bad = Env::from_pairs([("RULES_DESKTOP_INSTALL_DIR", "relative")]);
        let why = installed_program(&APP, &bad).unwrap_err();
        assert!(why.contains("RULES_DESKTOP_INSTALL_DIR"), "{why}");
    }

    fn io_error(code: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code)
    }

    #[tokio::test]
    async fn a_held_file_is_tried_again_and_the_tries_are_counted() {
        let held = |_: &std::io::Error| true;
        let mut calls = 0;
        // Held twice, free the third time.
        let ok = retry_while_held(
            || {
                calls += 1;
                if calls < 3 {
                    Err(io_error(5))
                } else {
                    Ok(())
                }
            },
            held,
            3,
            Duration::from_millis(1),
        )
        .await;
        assert!(ok.is_ok());
        assert_eq!(calls, 3);
        // Held every time: it gives up after the tries and says how many.
        let mut calls = 0;
        let (_, made) = retry_while_held(
            || {
                calls += 1;
                Err(io_error(5))
            },
            held,
            3,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert_eq!((calls, made), (3, 3));
        // Another error is reported at once.
        let mut calls = 0;
        let (_, made) = retry_while_held(
            || {
                calls += 1;
                Err(io_error(2))
            },
            |e| e.raw_os_error() == Some(5),
            3,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert_eq!((calls, made), (1, 1));
    }

    #[test]
    fn the_failure_names_the_tries_when_there_were_several() {
        let e = io_error(5);
        let once = replace_failure(Path::new("p"), 1, " (hint)", &e);
        assert!(once.starts_with("cannot replace p (hint): "), "{once}");
        assert!(!once.contains("tries"), "{once}");
        let three = replace_failure(Path::new("p"), 3, "", &e);
        assert!(
            three.starts_with("cannot replace p after 3 tries: "),
            "{three}"
        );
    }

    #[test]
    fn only_a_held_file_on_windows_is_a_moment() {
        if cfg!(windows) {
            assert!(file_is_held(&io_error(5)));
            assert!(file_is_held(&io_error(32)));
            assert!(!file_is_held(&io_error(2)));
        } else {
            assert!(!file_is_held(&io_error(13)));
        }
    }

    #[test]
    fn the_hidden_command_line_is_one_quoted_command() {
        let line = hidden_command_line(
            Path::new(r"C:\Program Files\t\tasks-hub.exe"),
            Path::new(r"C:\Users\a b\hub.log"),
        )
        .unwrap();
        assert_eq!(
            line,
            r#"cmd.exe /d /c ""C:\Program Files\t\tasks-hub.exe" serve >>"C:\Users\a b\hub.log" 2>&1""#
        );
        assert!(script_text(&line).contains(r#"/c """"C:\Program"#));
        // A name `cmd.exe` would expand is not used.
        assert!(hidden_command_line(Path::new(r"C:\%X%\h.exe"), Path::new("l")).is_none());
    }

    #[test]
    fn a_script_is_utf16_with_a_mark_so_a_non_ascii_path_survives() {
        let bytes = vbs_bytes("\"C:\\Users\\Müller\\h.exe\"");
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(
            String::from_utf16(&units).unwrap(),
            "\"C:\\Users\\Müller\\h.exe\""
        );
    }

    #[test]
    fn a_probe_is_found_in_the_store_of_a_package_and_only_there() {
        let base = std::env::temp_dir().join(format!("hub-kit-pkg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let rel = Path::new("hub-kit");
        let store = base
            .join("Packages")
            .join("Some_pkg")
            .join("LocalCache")
            .join("Roaming")
            .join(rel);
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(base.join("Packages").join("Other_pkg")).unwrap();
        assert_eq!(find_in_packages(&base, "Roaming", rel, ".probe-1"), None);
        std::fs::write(store.join(".probe-1"), b"").unwrap();
        let found = find_in_packages(&base, "Roaming", rel, ".probe-1").unwrap();
        assert!(found.ends_with("Some_pkg"));
        // Another kind of store is not this one.
        assert_eq!(find_in_packages(&base, "Local", rel, ".probe-1"), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_prefix_is_taken_off_whatever_the_case() {
        let base = Path::new("a").join("Users").join("Me");
        let path = Path::new("a").join("users").join("me").join("x").join("y");
        assert_eq!(
            strip_prefix_ignore_case(&path, &base),
            Some(Path::new("x").join("y"))
        );
        // Not only ASCII: a name with an umlaut is the same in any case.
        assert_eq!(
            strip_prefix_ignore_case(
                &Path::new("a").join("MÜLLER").join("x"),
                &Path::new("a").join("müller")
            ),
            Some(PathBuf::from("x"))
        );
        assert_eq!(
            strip_prefix_ignore_case(&path, &Path::new("b").join("users")),
            None
        );
        // The base itself: nothing is left (the folder of AppData that
        // `autostart` probes).
        assert_eq!(strip_prefix_ignore_case(&base, &base), Some(PathBuf::new()));
    }

    #[cfg(windows)]
    #[test]
    fn a_packaged_app_is_noticed_in_the_local_and_the_roaming_store() {
        let base = std::env::temp_dir().join(format!("hub-kit-warn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let local = base.join("Local");
        let config = base.join("Roaming").join("hub-kit");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        let env = Env::from_pairs([
            ("LOCALAPPDATA", local.clone()),
            ("APPDATA", base.join("Roaming")),
        ]);
        let probe = format!(".probe-{}", std::process::id());

        // No package holds the probe: no warning (and no probe is left behind).
        assert_eq!(private_storage_warning(&env, &local), None);
        assert_eq!(private_storage_warning(&env, &config), None);
        assert!(!local.join(&probe).exists());

        // The folder of AppData itself (what `autostart` probes: the rest is
        // empty) is looked for in the Local store of the package.
        let store = local.join("Packages").join("P_one").join("LocalCache");
        std::fs::create_dir_all(store.join("Local")).unwrap();
        std::fs::write(store.join("Local").join(&probe), b"").unwrap();
        let warning = private_storage_warning(&env, &local).unwrap();
        assert!(warning.contains("P_one"), "{warning}");
        assert!(!local.join(&probe).exists());

        // A folder below the roaming AppData in the Roaming store.
        let store = local.join("Packages").join("Q_two").join("LocalCache");
        std::fs::create_dir_all(store.join("Roaming").join("hub-kit")).unwrap();
        std::fs::write(store.join("Roaming").join("hub-kit").join(&probe), b"").unwrap();
        let warning = private_storage_warning(&env, &config).unwrap();
        assert!(warning.contains("Q_two"), "{warning}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_registered_command_quotes_the_program() {
        let cmd = run_command(Path::new(r"C:\Program Files\tasks\tasks-hub.exe"));
        assert_eq!(cmd, r#""C:\Program Files\tasks\tasks-hub.exe" start"#);
    }

    fn settings_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-kit-purge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn purging_removes_the_files_of_the_app_and_the_folder_when_it_is_empty() {
        let dir = settings_dir("empty");
        for name in KIT_FILES.iter().chain(&EXTRA) {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let text = purge_settings(&dir).unwrap();
        assert!(
            text.contains("config.json") && text.contains("usage.json"),
            "{text}"
        );
        // The files the app names go too, and no other app's file is in the list.
        assert!(
            text.contains("rules.json") && text.contains("waivers.json"),
            "{text}"
        );
        assert!(!text.contains("areas.json"), "{text}");
        assert!(text.contains("folder is removed"), "{text}");
        assert!(!dir.exists());
        // Nothing there at all: told, and no error.
        assert!(purge_settings(&dir).unwrap().contains("no settings"));
    }

    #[test]
    fn purging_leaves_a_file_that_is_not_the_apps_and_so_the_folder() {
        let dir = settings_dir("other");
        std::fs::write(dir.join("config.json"), "x").unwrap();
        std::fs::write(dir.join("notes.txt"), "mine").unwrap();
        let text = purge_settings(&dir).unwrap();
        assert!(text.contains("holds other files"), "{text}");
        assert!(!dir.join("config.json").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("notes.txt")).unwrap(),
            "mine"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A registry that holds one value in memory and says what it was asked.
    struct FakeRegistry {
        value: std::cell::RefCell<Option<String>>,
        calls: std::cell::RefCell<Vec<Vec<String>>>,
        /// A policy or an ACL: `add` and `delete` fail and change nothing.
        locked: bool,
        /// `reg.exe` is not there.
        missing: bool,
    }

    impl FakeRegistry {
        fn new(value: Option<&str>) -> Self {
            Self {
                value: std::cell::RefCell::new(value.map(str::to_owned)),
                calls: std::cell::RefCell::new(Vec::new()),
                locked: false,
                missing: false,
            }
        }
        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.borrow().clone()
        }
    }

    impl Registry for FakeRegistry {
        fn run(&self, args: &[OsString]) -> Result<RegOutput, String> {
            let args: Vec<String> = args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            self.calls.borrow_mut().push(args.clone());
            if self.missing {
                return Err("reg.exe did not run: not found".to_owned());
            }
            let answer = |success: bool, stdout: String| {
                Ok(RegOutput {
                    success,
                    stdout,
                    // What reg.exe says when a policy or an ACL refuses.
                    stderr: if !success && self.locked {
                        "
ERROR: Access is denied.
"
                        .to_owned()
                    } else {
                        String::new()
                    },
                })
            };
            match args.first().map(String::as_str) {
                Some("add") if !self.locked => {
                    let at = args.iter().position(|a| a == "/d").unwrap_or(0) + 1;
                    *self.value.borrow_mut() = args.get(at).cloned();
                    answer(true, String::new())
                }
                Some("delete") if !self.locked => {
                    let had = self.value.borrow_mut().take().is_some();
                    answer(had, String::new())
                }
                Some("query") => match self.value.borrow().as_deref() {
                    Some(v) => answer(
                        true,
                        format!("\r\nHKEY_CURRENT_USER\\Software\r\n    {RUN_VALUE}    REG_SZ    {v}\r\n\r\n"),
                    ),
                    None => answer(false, String::new()),
                },
                _ => answer(false, String::new()),
            }
        }
    }

    const EXE: &str = r"C:\Program Files\tasks\tasks-hub.exe";

    #[test]
    fn turning_it_on_writes_the_quoted_command_under_the_run_key_of_the_user() {
        let reg = FakeRegistry::new(None);
        let text = run_key(Autostart::On, Path::new(EXE), &reg).unwrap();
        let wanted: Vec<String> = [
            "add",
            RUN_KEY,
            "/v",
            RUN_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            &run_command(Path::new(EXE)),
            "/f",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        assert_eq!(reg.calls(), vec![wanted]);
        assert!(
            RUN_KEY.starts_with(r"HKCU\"),
            "the key of the user needs no administrator"
        );
        assert!(text.contains("starts with your login"), "{text}");
        assert_eq!(
            reg.value.borrow().as_deref(),
            Some(run_command(Path::new(EXE)).as_str())
        );
    }

    #[test]
    fn the_reason_reg_gives_for_a_refusal_is_in_the_error() {
        let mut reg = FakeRegistry::new(Some("x"));
        reg.locked = true;
        let written = run_key(Autostart::On, Path::new(EXE), &reg).unwrap_err();
        assert_eq!(
            written,
            "the entry could not be written: ERROR: Access is denied."
        );
        let removed = run_key(Autostart::Off, Path::new(EXE), &reg).unwrap_err();
        assert_eq!(
            removed,
            "the entry could not be removed: ERROR: Access is denied."
        );
        // A control character in the complaint does not reach the terminal.
        let odd = RegOutput {
            success: false,
            stdout: String::new(),
            stderr: format!("bad{}thing", char::from(0x1b)),
        };
        assert_eq!(odd.reason(), ": bad thing");
    }

    #[test]
    fn a_refused_write_is_an_error_and_a_missing_program_too() {
        let mut reg = FakeRegistry::new(None);
        reg.locked = true;
        assert!(run_key(Autostart::On, Path::new(EXE), &reg)
            .unwrap_err()
            .starts_with("the entry could not be written"));
        let mut gone = FakeRegistry::new(None);
        gone.missing = true;
        for what in [Autostart::On, Autostart::Off, Autostart::Status] {
            let error = run_key(what, Path::new(EXE), &gone).unwrap_err();
            assert!(error.contains("did not run"), "{what:?}: {error}");
        }
    }

    #[test]
    fn turning_it_off_removes_the_value_and_a_missing_one_is_what_was_asked_for() {
        let reg = FakeRegistry::new(Some("x"));
        let first = run_key(Autostart::Off, Path::new(EXE), &reg).unwrap();
        assert!(first.contains("does not start"), "{first}");
        assert!(reg.value.borrow().is_none());
        // Again: the delete fails (nothing there), the key is asked, and that is fine.
        let again = run_key(Autostart::Off, Path::new(EXE), &reg).unwrap();
        assert!(again.contains("does not start"), "{again}");
        let last = reg.calls().last().cloned().unwrap();
        assert_eq!(
            last[0], "query",
            "a failed delete is followed by a look at the key"
        );
    }

    #[test]
    fn a_value_that_cannot_be_removed_is_an_error() {
        let mut reg = FakeRegistry::new(Some("x"));
        reg.locked = true;
        assert!(run_key(Autostart::Off, Path::new(EXE), &reg)
            .unwrap_err()
            .starts_with("the entry could not be removed"));
        assert!(reg.value.borrow().is_some());
    }

    #[test]
    fn the_status_names_the_value_or_says_off() {
        let reg = FakeRegistry::new(Some(r#""C:\x\tasks-hub.exe" start"#));
        let on = run_key(Autostart::Status, Path::new(EXE), &reg).unwrap();
        assert!(on.starts_with("on: "), "{on}");
        assert!(
            on.contains(RUN_VALUE) && on.contains("tasks-hub.exe"),
            "{on}"
        );
        assert!(
            !on.contains('\r'),
            "no line ending of reg.exe is left in it: {on:?}"
        );
        let off = run_key(Autostart::Status, Path::new(EXE), &FakeRegistry::new(None)).unwrap();
        assert_eq!(off, "off\n");
    }
}
