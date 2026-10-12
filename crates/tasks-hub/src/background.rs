//! The hub as a background program: `start`, `stop` and the start with the
//! login (`autostart`).
//!
//! `start` runs `serve` again as a program of its own that has no window and
//! does not end with the terminal; its output goes to `hub.log` in the config
//! folder. A hub is only believed (and only stopped) when the process on its
//! port says the instance of `hub.json`: a stale file never makes `stop` kill
//! a process that merely got the same number.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::app;
use crate::config::Env;

/// The name of the value under the `Run` key of the registry.
const RUN_VALUE: &str = "tasks-desktop";
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
pub async fn start() -> Result<String, String> {
    let env = Env::from_process();
    let dir = app::config_folder(&env)?;
    if let Some(record) = app::running_hub(&dir).await {
        return Ok(format!(
            "a hub is already running (port {}, process {})\n",
            record.port, record.pid
        ));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the config folder: {e}"))?;
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
        if let Some(record) = app::running_hub(&dir).await {
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
/// directly keeps a pipe of the caller (`tasks-hub start | ...`) open for as
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
pub async fn stop() -> Result<String, String> {
    let env = Env::from_process();
    let dir = app::config_folder(&env)?;
    let Some(record) = app::running_hub(&dir).await else {
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
        if app::running_hub(&dir).await.is_none() {
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

/// Start the hub with the login of the user (Windows: the `Run` key).
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn autostart(what: Autostart) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    autostart_for(what, &exe)
}

/// [`autostart`] for the program at `exe` (what `install` registers).
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn autostart_for(what: Autostart, exe: &Path) -> Result<String, String> {
    if !cfg!(windows) {
        return Err(
            "autostart is only built for Windows so far (put `tasks-hub start` into the \
             login items of your system)"
                .to_owned(),
        );
    }
    let reg = system_program("reg.exe")?;
    match what {
        Autostart::On => {
            let ok = Command::new(reg)
                .args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d"])
                .arg(run_command(exe))
                .arg("/f")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| format!("reg.exe did not run: {e}"))?
                .success();
            if ok {
                Ok(format!(
                    "the hub starts with your login: {}\n",
                    run_command(exe)
                ))
            } else {
                Err("the entry could not be written".to_owned())
            }
        }
        Autostart::Off => {
            // A missing value is not an error: it is what was asked for.
            let _ = Command::new(reg)
                .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| format!("reg.exe did not run: {e}"))?;
            Ok("the hub does not start with your login\n".to_owned())
        }
        Autostart::Status => {
            let out = Command::new(reg)
                .args(["query", RUN_KEY, "/v", RUN_VALUE])
                .output()
                .map_err(|e| format!("reg.exe did not run: {e}"))?;
            if out.status.success() {
                Ok(format!(
                    "on: {}\n",
                    String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .find(|l| l.contains(RUN_VALUE))
                        .unwrap_or("")
                        .trim()
                ))
            } else {
                Ok("off\n".to_owned())
            }
        }
    }
}

/// Where `install` puts the program: a folder of this user that is not
/// roaming (the settings are; a program is not).
fn install_dir(env: &Env) -> Result<PathBuf, String> {
    if let Some(dir) = env.path("TASKS_DESKTOP_INSTALL_DIR") {
        // A relative folder would mean whatever the working folder is.
        if !dir.is_absolute() {
            return Err("TASKS_DESKTOP_INSTALL_DIR must be an absolute path".to_owned());
        }
        return Ok(dir);
    }
    let base = if cfg!(windows) {
        env.path("LOCALAPPDATA")
            .ok_or("no LOCALAPPDATA: set TASKS_DESKTOP_INSTALL_DIR")?
    } else if let Some(x) = env.path("XDG_DATA_HOME") {
        x
    } else {
        env.path("HOME")
            .map(|h| h.join(".local").join("share"))
            .ok_or("no HOME: set TASKS_DESKTOP_INSTALL_DIR")?
    };
    Ok(base.join("tasks-desktop").join("bin"))
}

/// What `install` was asked for.
#[derive(Debug, Clone, Copy, Default)]
pub struct InstallOptions {
    /// Register the installed program with the login of the user.
    pub autostart: bool,
    /// Put a link "Tasks" on the desktop (Windows).
    pub shortcut: bool,
}

/// Copy this program to a fixed place, so that a build in the repository
/// does not fight the running hub for the file, and start the hub from there
/// again when one was running.
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn install(opts: InstallOptions) -> Result<String, String> {
    let env = Env::from_process();
    let dir = install_dir(&env)?;
    let from = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    let name = from
        .file_name()
        .ok_or("the program has no file name")?
        .to_owned();
    let target = dir.join(&name);
    let mut out = String::new();

    // A program that is the one being installed (run from the install
    // folder) has nothing to copy.
    let same = match (std::fs::canonicalize(&from), std::fs::canonicalize(&target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    let config = app::config_folder(&env)?;
    let was_running = app::running_hub(&config).await.is_some();
    if !same {
        if was_running {
            out.push_str(&stop().await?);
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        // Copy beside, then move over: a copy that is cut short never
        // replaces a program that works.
        let part = dir.join(format!("{}.new", name.to_string_lossy()));
        std::fs::copy(&from, &part)
            .map_err(|e| format!("cannot copy to {}: {e}", part.display()))?;
        std::fs::rename(&part, &target).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!(
                "cannot replace {} (is a hub running from it? `tasks-hub stop`): {e}",
                target.display()
            )
        })?;
    }
    out.push_str(&format!("installed: {}\n", target.display()));

    if opts.autostart {
        out.push_str(&autostart_for(Autostart::On, &target)?);
    } else if cfg!(windows) && autostart_is_on() {
        // It was registered for another copy: point it here.
        out.push_str(&autostart_for(Autostart::On, &target)?);
    }
    if opts.shortcut {
        out.push_str(&shortcut(&target)?);
    }
    if was_running && !same {
        // The hub comes back from the installed program.
        let started = Command::new(&target)
            .arg("start")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("the installed program did not start: {e}"))?;
        out.push_str(&String::from_utf8_lossy(&started.stdout));
    }
    Ok(out)
}

fn autostart_is_on() -> bool {
    matches!(autostart(Autostart::Status), Ok(text) if text.starts_with("on"))
}

/// A link "Tasks" on the desktop that starts the hub and opens the page.
fn shortcut(exe: &Path) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("a desktop link is only built for Windows so far".to_owned());
    }
    let text = exe.to_string_lossy();
    if text.contains(['"', '\r', '\n']) {
        return Err("the path of the program cannot be put in a link".to_owned());
    }
    let script = format!(
        "Set link = CreateObject(\"WScript.Shell\").CreateShortcut(\
CreateObject(\"WScript.Shell\").SpecialFolders(\"Desktop\") & \"\\Tasks.lnk\")\r\n\
link.TargetPath = \"{text}\"\r\n\
link.Arguments = \"start --open\"\r\n\
link.WindowStyle = 7\r\n\
link.Description = \"tasks-desktop: start the hub and open the page\"\r\n\
link.Save\r\n"
    );
    let dir = std::env::temp_dir();
    let path = dir.join(format!("tasks-desktop-link-{}.vbs", std::process::id()));
    std::fs::write(&path, vbs_bytes(&script)).map_err(|e| format!("cannot write a script: {e}"))?;
    let ok = Command::new(system_program("wscript.exe")?)
        .args(["//B", "//Nologo"])
        .arg(&path)
        .status()
        .is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&path);
    if ok {
        Ok("a link \"Tasks\" is on the desktop\n".to_owned())
    } else {
        Err("the desktop link could not be made".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn the_registered_command_quotes_the_program() {
        let cmd = run_command(Path::new(r"C:\Program Files\tasks\tasks-hub.exe"));
        assert_eq!(cmd, r#""C:\Program Files\tasks\tasks-hub.exe" start"#);
    }
}
