//! Start the hub with the login, and a launcher entry, on Linux and macOS:
//! plain files in the places the desktops read. (Windows uses the registry,
//! see `background`.)
//!
//! The functions take the app, the platform and the environment as arguments so that
//! the files can be tested on any system, and so that no name of an app is in here.

use std::path::{Path, PathBuf};

use app_core::identity::AppIdentity;

use crate::env::Env;

/// What the entries say about the app: its names and one line on what it is.
#[derive(Debug, Clone, Copy)]
pub struct LoginApp<'a> {
    pub identity: &'a AppIdentity,
    /// The comment of a desktop entry after the name of the app, such as "the task overview".
    pub summary: &'a str,
}

/// The system whose files are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Macos,
}

impl Platform {
    /// The platform this program runs on, if it is one of these.
    #[must_use]
    pub fn current() -> Option<Self> {
        match std::env::consts::OS {
            "linux" => Some(Self::Linux),
            "macos" => Some(Self::Macos),
            _ => None,
        }
    }
}

/// What to do with the login entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    On,
    Off,
    Status,
}

/// A value of the `Exec` key: in double quotes, with the characters the
/// desktop entry specification names escaped.
fn exec_quote(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        // A backslash is escaped by the quoting rule and that escape again by
        // the general rule for strings: four of them in the file.
        if c == '\\' {
            out.push_str("\\\\\\");
        }
        if matches!(c, '"' | '`' | '$') {
            out.push('\\');
        }
        // The `%` of a field code is doubled.
        if c == '%' {
            out.push('%');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// A freedesktop entry that runs `exe` with `args`.
#[must_use]
pub fn desktop_entry(app: &LoginApp<'_>, exe: &Path, args: &str, autostart: bool) -> String {
    let mut text = format!(
        "[Desktop Entry]\nType=Application\nName={}\nComment={}: {}\n\
         Exec={} {}\nTerminal=false\nCategories=Office;\n",
        app.identity.title,
        app.identity.app,
        app.summary,
        exec_quote(&exe.to_string_lossy()),
        args
    );
    if autostart {
        text.push_str("X-GNOME-Autostart-enabled=true\n");
    }
    text
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A launchd agent that runs `exe start` at login.
#[must_use]
pub fn launch_agent(app: &LoginApp<'_>, exe: &Path) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n\
         \t<key>Label</key>\n\t<string>{}</string>\n\
         \t<key>ProgramArguments</key>\n\t<array>\n\
         \t\t<string>{}</string>\n\t\t<string>start</string>\n\t</array>\n\
         \t<key>RunAtLoad</key>\n\t<true/>\n\
         \t<key>AbandonProcessGroup</key>\n\t<true/>\n\
         </dict>\n</plist>\n",
        app.identity.agent_label(),
        xml_escape(&exe.to_string_lossy())
    )
}

/// A path that can stand in one line of a desktop entry or in a plist: a line
/// break or another control character would start a key of its own.
fn plain_path(exe: &Path) -> Result<(), String> {
    if exe.to_string_lossy().chars().any(char::is_control) {
        return Err("the path of the program holds a control character".to_owned());
    }
    Ok(())
}

fn home(env: &Env) -> Result<PathBuf, String> {
    env.path("HOME")
        .filter(|h| h.is_absolute())
        .ok_or_else(|| "no HOME".to_owned())
}

/// The file of the login entry.
fn login_file(app: &LoginApp<'_>, platform: Platform, env: &Env) -> Result<PathBuf, String> {
    match platform {
        Platform::Linux => {
            let base = match env.path("XDG_CONFIG_HOME").filter(|p| p.is_absolute()) {
                Some(x) => x,
                None => home(env)?.join(".config"),
            };
            Ok(base.join("autostart").join(app.identity.desktop_file()))
        }
        Platform::Macos => Ok(home(env)?
            .join("Library")
            .join("LaunchAgents")
            .join(app.identity.agent_file())),
    }
}

/// The file of the launcher entry (Linux only).
fn launcher_file(app: &LoginApp<'_>, env: &Env) -> Result<PathBuf, String> {
    let base = match env.path("XDG_DATA_HOME").filter(|p| p.is_absolute()) {
        Some(x) => x,
        None => home(env)?.join(".local").join("share"),
    };
    Ok(base.join("applications").join(app.identity.desktop_file()))
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    // Beside, then over: a cut-short write leaves the old file.
    let part = path.with_extension("part");
    std::fs::write(&part, text).map_err(|e| format!("cannot write {}: {e}", part.display()))?;
    std::fs::rename(&part, path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("cannot write {}: {e}", path.display())
    })
}

/// Switch the login entry for `exe`; returns what to print.
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn login_entry(
    app: &LoginApp<'_>,
    platform: Platform,
    action: Action,
    exe: &Path,
    env: &Env,
) -> Result<String, String> {
    plain_path(exe)?;
    let file = login_file(app, platform, env)?;
    match action {
        Action::On => {
            let text = match platform {
                Platform::Linux => desktop_entry(app, exe, "start", true),
                Platform::Macos => launch_agent(app, exe),
            };
            write(&file, &text)?;
            Ok(format!(
                "the hub starts with your login: {} (entry {})\n",
                exe.display(),
                file.display()
            ))
        }
        Action::Off => {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                // Nothing there is what was asked for.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("cannot remove {}: {e}", file.display())),
            }
            Ok("the hub does not start with your login\n".to_owned())
        }
        Action::Status => {
            if file.is_file() {
                Ok(format!("on: {}\n", file.display()))
            } else {
                Ok("off\n".to_owned())
            }
        }
    }
}

/// A launcher entry (named by the title of the app) that starts the hub and opens the page.
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn launcher(
    app: &LoginApp<'_>,
    platform: Platform,
    exe: &Path,
    env: &Env,
) -> Result<String, String> {
    plain_path(exe)?;
    match platform {
        Platform::Linux => {
            let file = launcher_file(app, env)?;
            write(&file, &desktop_entry(app, exe, "start --open", false))?;
            Ok(format!(
                "a launcher \"{}\" is in {}\n",
                app.identity.title,
                file.display()
            ))
        }
        Platform::Macos => Err(
            "a launcher for macOS is not built: open the program from the install folder"
                .to_owned(),
        ),
    }
}

/// Take the launcher entry away (nothing there is what was asked for).
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn remove_launcher(
    app: &LoginApp<'_>,
    platform: Platform,
    env: &Env,
) -> Result<String, String> {
    match platform {
        Platform::Linux => {
            let file = launcher_file(app, env)?;
            match std::fs::remove_file(&file) {
                Ok(()) => Ok(format!("the launcher {} is removed\n", file.display())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    Ok("no launcher was there\n".to_owned())
                }
                Err(e) => Err(format!("cannot remove {}: {e}", file.display())),
            }
        }
        // None is ever made for macOS.
        Platform::Macos => Ok("no launcher was there\n".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An app that is not the one this kit was made from: nothing in the files may say "tasks".
    const IDENTITY: AppIdentity = AppIdentity {
        app: "rules-desktop",
        binary: "rules-hub",
        env_prefix: "RULES_DESKTOP",
        title: "Rules",
        default_port: 17616,
        route_ns: "rules",
    };
    const APP: LoginApp<'static> = LoginApp {
        identity: &IDENTITY,
        summary: "the rule overview",
    };

    fn desktop_file() -> String {
        IDENTITY.desktop_file()
    }
    fn agent_file() -> String {
        IDENTITY.agent_file()
    }
    fn login_entry(
        platform: Platform,
        action: Action,
        exe: &Path,
        env: &Env,
    ) -> Result<String, String> {
        super::login_entry(&APP, platform, action, exe, env)
    }
    fn launcher(platform: Platform, exe: &Path, env: &Env) -> Result<String, String> {
        super::launcher(&APP, platform, exe, env)
    }
    fn remove_launcher(platform: Platform, env: &Env) -> Result<String, String> {
        super::remove_launcher(&APP, platform, env)
    }

    #[test]
    fn the_files_say_the_name_of_the_app_and_nothing_of_another() {
        let home = temp("names");
        let env = Env::from_pairs([("HOME", home.as_os_str().to_owned())]);
        let exe = Path::new("/x/rules-hub");
        login_entry(Platform::Linux, Action::On, exe, &env).unwrap();
        let said = launcher(Platform::Linux, exe, &env).unwrap();
        assert!(said.contains("\"Rules\""), "{said}");
        let entry = std::fs::read_to_string(
            home.join(".config")
                .join("autostart")
                .join("rules-desktop.desktop"),
        )
        .unwrap();
        assert!(
            entry.contains("Name=Rules\nComment=rules-desktop: the rule overview\n"),
            "{entry}"
        );
        let plist = launch_agent(&APP, exe);
        assert!(
            plist.contains("<string>dev.rules-desktop.hub</string>"),
            "{plist}"
        );
        // The message names the file it wrote, and the folder of the test is the temp folder of the
        // machine: a person whose temp folder has "tasks" in its path must not fail the test.
        let said_clean = said.replace(&*home.to_string_lossy(), "");
        for text in [&said_clean, &entry, &plist] {
            assert!(!text.to_lowercase().contains("tasks"), "{text}");
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hub-kit-login-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_exec_value_is_quoted_and_escaped() {
        assert_eq!(exec_quote("/home/a b/tasks-hub"), "\"/home/a b/tasks-hub\"");
        // `\` is four backslashes in the file (quoting rule, then string rule).
        assert_eq!(
            exec_quote("/x/a\"b$c`d\\e%f"),
            "\"/x/a\\\"b\\$c\\`d\\\\\\\\e%%f\""
        );
    }

    #[test]
    fn a_linux_login_entry_is_written_read_and_removed() {
        let home = temp("linux");
        let env = Env::from_pairs([("HOME", home.as_os_str().to_owned())]);
        let exe = Path::new("/opt/tasks desk/tasks-hub");
        assert_eq!(
            login_entry(Platform::Linux, Action::Status, exe, &env).unwrap(),
            "off\n"
        );
        let said = login_entry(Platform::Linux, Action::On, exe, &env).unwrap();
        assert!(said.contains("starts with your login"), "{said}");
        let file = home.join(".config").join("autostart").join(desktop_file());
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(
            text.contains("Exec=\"/opt/tasks desk/tasks-hub\" start\n"),
            "{text}"
        );
        assert!(text.contains("Terminal=false"));
        assert!(login_entry(Platform::Linux, Action::Status, exe, &env)
            .unwrap()
            .starts_with("on"));
        login_entry(Platform::Linux, Action::Off, exe, &env).unwrap();
        assert!(!file.exists());
        // Off again is not an error.
        login_entry(Platform::Linux, Action::Off, exe, &env).unwrap();
    }

    #[test]
    fn xdg_config_home_wins_over_home() {
        let home = temp("xdg-home");
        let cfg = temp("xdg-cfg");
        let env = Env::from_pairs([
            ("HOME", home.as_os_str().to_owned()),
            ("XDG_CONFIG_HOME", cfg.as_os_str().to_owned()),
        ]);
        login_entry(Platform::Linux, Action::On, Path::new("/x/tasks-hub"), &env).unwrap();
        assert!(cfg.join("autostart").join(desktop_file()).is_file());
        assert!(!home.join(".config").exists());
    }

    #[test]
    fn a_macos_agent_runs_start_at_load() {
        let home = temp("mac");
        let env = Env::from_pairs([("HOME", home.as_os_str().to_owned())]);
        login_entry(
            Platform::Macos,
            Action::On,
            Path::new("/Applications/T & C/tasks-hub"),
            &env,
        )
        .unwrap();
        let file = home.join("Library").join("LaunchAgents").join(agent_file());
        let text = std::fs::read_to_string(file).unwrap();
        assert!(
            text.contains("<string>/Applications/T &amp; C/tasks-hub</string>"),
            "{text}"
        );
        assert!(text.contains("<string>start</string>"));
        assert!(text.contains("<key>RunAtLoad</key>"));
    }

    #[test]
    fn the_launcher_opens_the_page() {
        let home = temp("launcher");
        let env = Env::from_pairs([("HOME", home.as_os_str().to_owned())]);
        launcher(Platform::Linux, Path::new("/x/tasks-hub"), &env).unwrap();
        let text = std::fs::read_to_string(
            home.join(".local")
                .join("share")
                .join("applications")
                .join(desktop_file()),
        )
        .unwrap();
        assert!(text.contains("Exec=\"/x/tasks-hub\" start --open"));
        assert!(!text.contains("X-GNOME-Autostart"));
        assert!(launcher(Platform::Macos, Path::new("/x"), &env).is_err());
    }

    #[test]
    fn a_path_with_a_line_break_is_refused() {
        let home = temp("control");
        let env = Env::from_pairs([("HOME", home.as_os_str().to_owned())]);
        let bad = Path::new("/x/tasks-hub\nExec=/bin/evil");
        assert!(login_entry(Platform::Linux, Action::On, bad, &env).is_err());
        assert!(launcher(Platform::Linux, bad, &env).is_err());
        assert!(!home.join(".config").exists());
    }

    #[test]
    fn the_launcher_is_taken_away_and_nothing_there_is_fine() {
        let home = temp("unlauncher");
        let env = Env::from_pairs([("HOME", home.as_os_str().to_owned())]);
        let file = home
            .join(".local")
            .join("share")
            .join("applications")
            .join(desktop_file());
        launcher(Platform::Linux, Path::new("/x/tasks-hub"), &env).unwrap();
        assert!(file.is_file());
        let text = remove_launcher(Platform::Linux, &env).unwrap();
        assert!(text.contains("is removed"), "{text}");
        assert!(!file.exists());
        assert!(remove_launcher(Platform::Linux, &env)
            .unwrap()
            .contains("no launcher"));
        assert!(remove_launcher(Platform::Macos, &env)
            .unwrap()
            .contains("no launcher"));
    }

    #[test]
    fn without_a_home_nothing_is_written() {
        let env = Env::from_pairs([("PATH", "x")]);
        assert!(login_entry(Platform::Linux, Action::On, Path::new("/x"), &env).is_err());
    }
}
