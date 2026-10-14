//! The first start by a double click: where the vault is, and whether to install the program.
//!
//! Asked in the console that the double click opened, one question at a time, each only once: what was
//! answered (or declined) is remembered in `setup.json` in the config folder, so a second click asks
//! nothing. Without a person at the console (a pipe, a script, a service) nothing is asked and nothing is
//! installed: [`interactive`] is false and the program only starts the hub. The questions change no file
//! but the settings of the app, the install folder of the user and, when it is said yes to, the login entry
//! and the desktop link (everything `tasks-hub install` does, which this calls).

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::background::{self, InstallOptions};
use crate::config::{self, Env, FileConfig};

/// Where the questions go and the answers come from. The console in the program; a script in the tests.
pub trait Io {
    /// Show `question` and read one line. `None` when there is no more input (the end of a pipe).
    fn ask(&mut self, question: &str) -> Option<String>;
    /// Tell something.
    fn say(&mut self, text: &str);
}

/// The console of the process.
pub struct Console;

impl Io for Console {
    fn ask(&mut self, question: &str) -> Option<String> {
        print!("{question} ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        match std::io::stdin().lock().read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim().to_owned()),
        }
    }

    fn say(&mut self, text: &str) {
        println!("{text}");
    }
}

/// With this set, the questions are asked although there is no terminal (the tests pipe the answers in).
const ASSUME_TERMINAL: &str = "TASKS_DESKTOP_ASSUME_TERMINAL";
/// With this set, nothing is asked, whatever the console is.
const NO_SETUP: &str = "TASKS_DESKTOP_NO_SETUP";

/// Whether there is a person to ask.
#[must_use]
pub fn interactive(env: &Env) -> bool {
    env.get(NO_SETUP).is_none()
        && (env.get(ASSUME_TERMINAL).is_some() || std::io::stdin().is_terminal())
}

/// What was asked already. A missing or unreadable file is "nothing yet": the worst case is a question twice.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Asked {
    vault: bool,
    install_declined: bool,
}

fn asked_path(dir: &Path) -> PathBuf {
    dir.join("setup.json")
}

fn load_asked(dir: &Path) -> Asked {
    std::fs::read_to_string(asked_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_asked(dir: &Path, asked: &Asked) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot make the config folder: {e}"))?;
    let text = serde_json::to_string_pretty(asked).map_err(|e| e.to_string())?;
    std::fs::write(asked_path(dir), format!("{text}\n"))
        .map_err(|e| format!("cannot write the setup notes: {e}"))
}

/// A yes or a no; an empty line (or anything else) is the default.
fn yes_no(io: &mut dyn Io, question: &str, default_yes: bool) -> bool {
    let hint = if default_yes { "[Y/n]" } else { "[y/N]" };
    match io.ask(&format!("{question} {hint}")) {
        Some(answer) => match answer.to_lowercase().as_str() {
            "y" | "yes" | "j" | "ja" => true,
            "n" | "no" | "nein" => false,
            _ => default_yes,
        },
        None => false,
    }
}

/// How often a wrong folder is asked again.
const VAULT_TRIES: usize = 3;

/// Ask for the vault folder when none is set (settings or `TASKS_VAULT`), and write it to the settings.
/// An empty line skips; the page then says what is missing.
fn ask_vault(io: &mut dyn Io, env: &Env, dir: &Path) -> Result<(), String> {
    let mut file = config::load_file(dir).map_err(|e| e.to_string())?;
    if file.vault.is_some() || env.path("TASKS_VAULT").is_some() {
        return Ok(());
    }
    io.say(
        "No task vault is set yet. It is the folder that holds one folder per area (tasks.nvim).",
    );
    for _ in 0..VAULT_TRIES {
        let Some(answer) = io.ask("Path of your vault (empty line: later):") else {
            return Ok(());
        };
        let answer = answer.trim().trim_matches('"').trim();
        if answer.is_empty() {
            return Ok(());
        }
        let path = PathBuf::from(answer);
        if !path.is_dir() {
            io.say(&format!("{} is not a folder.", path.display()));
            continue;
        }
        file.vault = Some(path.clone());
        config::save_file(dir, &file)?;
        io.say(&format!(
            "The vault is {} (kept in the settings).",
            path.display()
        ));
        return Ok(());
    }
    io.say("No vault set. Set it later in the settings file or with TASKS_VAULT.");
    Ok(())
}

/// Whether two files hold the same bytes.
fn same_bytes(a: &Path, b: &Path) -> bool {
    matches!((std::fs::read(a), std::fs::read(b)), (Ok(x), Ok(y)) if x == y)
}

/// The install question: install, replace an older copy, or leave it. Returns the program to start the hub from
/// when it is the installed copy.
async fn ask_install(
    io: &mut dyn Io,
    env: &Env,
    asked: &mut Asked,
) -> Result<Option<PathBuf>, String> {
    let target = background::installed_program(env)?;
    let from = std::env::current_exe().map_err(|e| format!("own program not found: {e}"))?;
    if matches!(
        (std::fs::canonicalize(&from), std::fs::canonicalize(&target)),
        (Ok(a), Ok(b)) if a == b
    ) {
        return Ok(None); // this is the installed copy
    }
    let folder = target
        .parent()
        .map_or_else(String::new, |p| p.display().to_string());
    if target.is_file() {
        if same_bytes(&from, &target) {
            return Ok(Some(target));
        }
        if asked.install_declined
            || !yes_no(
                io,
                &format!("A different version is installed in {folder}. Replace it with this one?"),
                true,
            )
        {
            return Ok(None);
        }
        io.say(&background::install(InstallOptions::default()).await?);
        return Ok(Some(target));
    }
    if asked.install_declined {
        return Ok(None);
    }
    if !yes_no(
        io,
        &format!("Install the program to {folder} (no administrator rights needed)?"),
        true,
    ) {
        asked.install_declined = true;
        return Ok(None);
    }
    let opts = InstallOptions {
        autostart: yes_no(io, "Start it when you log in?", false),
        shortcut: yes_no(io, "Put a link on the desktop?", true),
    };
    io.say(&background::install(opts).await?);
    Ok(Some(target))
}

/// The questions of a first start. Returns the installed program to start the hub from, when there is one.
///
/// # Errors
///
/// A text for the person at the console (the settings cannot be read or written, the install failed).
pub async fn run(io: &mut dyn Io, env: &Env) -> Result<Option<PathBuf>, String> {
    let dir = config::config_dir(env)
        .ok_or("no config folder: set TASKS_DESKTOP_CONFIG_DIR (APPDATA, XDG_CONFIG_HOME or HOME is missing)")?;
    let mut asked = load_asked(&dir);
    if !asked.vault {
        ask_vault(io, env, &dir)?;
        asked.vault = true;
        save_asked(&dir, &asked)?;
    }
    let program = ask_install(io, env, &mut asked).await?;
    save_asked(&dir, &asked)?;
    Ok(program)
}

/// The settings as they are now (for the tests of the vault step).
#[must_use]
pub fn vault_in_settings(dir: &Path) -> Option<PathBuf> {
    config::load_file(dir)
        .ok()
        .and_then(|f: FileConfig| f.vault)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Answers from a list, and what was asked and said.
    struct Script {
        answers: Vec<&'static str>,
        asked: Vec<String>,
        said: Vec<String>,
    }

    impl Script {
        fn new(answers: &[&'static str]) -> Self {
            let mut answers = answers.to_vec();
            answers.reverse();
            Self {
                answers,
                asked: Vec::new(),
                said: Vec::new(),
            }
        }
    }

    impl Io for Script {
        fn ask(&mut self, question: &str) -> Option<String> {
            self.asked.push(question.to_owned());
            self.answers.pop().map(str::to_owned)
        }
        fn say(&mut self, text: &str) {
            self.said.push(text.to_owned());
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tasks-desktop-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_yes_or_no_reads_the_answer_and_falls_back_to_the_default() {
        for (answer, default, expected) in [
            ("y", false, true),
            ("Yes", false, true),
            ("ja", false, true),
            ("n", true, false),
            ("NO", true, false),
            ("", true, true),
            ("", false, false),
            ("maybe", true, true),
        ] {
            let mut io = Script::new(&[answer]);
            assert_eq!(yes_no(&mut io, "q", default), expected, "{answer:?}");
        }
        // The end of the input is a no, never a yes.
        assert!(!yes_no(&mut Script::new(&[]), "q", true));
    }

    #[test]
    fn the_vault_is_asked_for_checked_and_kept_in_the_settings() {
        let dir = temp("vault");
        let vault = temp("vault-folder");
        let env = Env::from_pairs([("TASKS_DESKTOP_CONFIG_DIR", dir.display().to_string())]);
        let wrong = dir.join("nothing-here").display().to_string();
        let right = vault.display().to_string();
        let mut io = Script::new(&[
            Box::leak(wrong.into_boxed_str()),
            Box::leak(right.into_boxed_str()),
        ]);
        ask_vault(&mut io, &env, &dir).unwrap();
        assert_eq!(io.asked.len(), 2, "a wrong folder is asked again");
        assert!(io.said.iter().any(|s| s.contains("is not a folder")));
        assert_eq!(vault_in_settings(&dir), Some(vault));
    }

    #[test]
    fn an_empty_line_skips_and_a_known_vault_is_not_asked() {
        let dir = temp("vault-skip");
        let env = Env::from_pairs([("TASKS_DESKTOP_CONFIG_DIR", dir.display().to_string())]);
        let mut io = Script::new(&[""]);
        ask_vault(&mut io, &env, &dir).unwrap();
        assert_eq!(vault_in_settings(&dir), None);

        let known = Env::from_pairs([
            ("TASKS_DESKTOP_CONFIG_DIR", dir.display().to_string()),
            ("TASKS_VAULT", dir.display().to_string()),
        ]);
        let mut none = Script::new(&[]);
        ask_vault(&mut none, &known, &dir).unwrap();
        assert!(none.asked.is_empty(), "TASKS_VAULT is a vault");
    }

    #[test]
    fn three_wrong_folders_end_the_question() {
        let dir = temp("vault-three");
        let env = Env::from_pairs([("TASKS_DESKTOP_CONFIG_DIR", dir.display().to_string())]);
        let mut io = Script::new(&["/no/1", "/no/2", "/no/3", "/no/4"]);
        ask_vault(&mut io, &env, &dir).unwrap();
        assert_eq!(io.asked.len(), VAULT_TRIES);
        assert_eq!(vault_in_settings(&dir), None);
    }

    #[test]
    fn what_was_asked_is_remembered_and_a_broken_note_is_nothing_yet() {
        let dir = temp("asked");
        assert!(!load_asked(&dir).vault);
        save_asked(
            &dir,
            &Asked {
                vault: true,
                install_declined: true,
            },
        )
        .unwrap();
        let back = load_asked(&dir);
        assert!(back.vault && back.install_declined);
        std::fs::write(asked_path(&dir), "{ not json").unwrap();
        assert!(!load_asked(&dir).vault);
    }

    #[test]
    fn nothing_is_asked_without_a_person_or_when_it_is_switched_off() {
        let off = Env::from_pairs([(NO_SETUP, "1"), (ASSUME_TERMINAL, "1")]);
        assert!(!interactive(&off));
        let piped = Env::from_pairs([(ASSUME_TERMINAL, "1")]);
        assert!(interactive(&piped));
    }
}
