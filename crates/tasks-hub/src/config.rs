//! Where the hub gets its settings from, and why it picked a value.
//!
//! Every value that is resolved carries its [`Source`], so a setup page can
//! say "the vault is X because the setting says so" instead of guessing
//! (concept 3.4, "Vault-Findung"). Nothing is read from the personal Neovim
//! configuration, and no setting names an executable value other than the
//! path of Neovim itself, which is set on this machine and never over HTTP
//! (concept 5.5 Nr. 9).

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The process environment, copied once. Tests hand in their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    vars: HashMap<String, OsString>,
}

impl Env {
    #[must_use]
    pub fn from_process() -> Self {
        Self {
            vars: std::env::vars_os()
                .filter_map(|(k, v)| k.into_string().ok().map(|k| (key(&k), v)))
                .collect(),
        }
    }

    #[must_use]
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: Into<OsString>,
    {
        Self {
            vars: pairs
                .into_iter()
                .map(|(k, v)| (key(k.as_ref()), v.into()))
                .collect(),
        }
    }

    /// A variable that is set and not empty.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&OsString> {
        self.vars.get(&key(name)).filter(|v| !v.is_empty())
    }

    #[must_use]
    pub fn path(&self, name: &str) -> Option<PathBuf> {
        self.get(name).map(PathBuf::from)
    }
}

/// Variable names are case-insensitive on Windows only.
fn key(name: &str) -> String {
    if cfg!(windows) {
        name.to_ascii_uppercase()
    } else {
        name.to_owned()
    }
}

/// Where a resolved value came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// The settings file of this device.
    Setting,
    /// An environment variable of the hub process.
    Env(&'static str),
    /// A search, with what was searched.
    Search(String),
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Setting => f.write_str("the settings file"),
            Self::Env(name) => write!(f, "the environment variable {name}"),
            Self::Search(what) => write!(f, "a search ({what})"),
        }
    }
}

/// A value and the reason for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved<T> {
    pub value: T,
    pub source: Source,
}

/// The settings file, `config.json` in the config folder. Unknown keys are
/// refused, so a typo is told instead of ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileConfig {
    /// The vault folder (the root that holds the areas).
    pub vault: Option<PathBuf>,
    /// The Neovim executable.
    pub nvim: Option<PathBuf>,
    /// A checkout of tasks.nvim (the folder with `scripts/tasks.lua`).
    pub engine_dir: Option<PathBuf>,
    /// A checkout of lib.nvim.
    pub lib_dir: Option<PathBuf>,
    /// Folders that are areas although they have no `ROADMAP/` or `Backlog/`.
    #[serde(default)]
    pub extra_areas: Vec<String>,
}

/// The longest name of an area the hub accepts.
const MAX_AREA_NAME: usize = 128;

impl FileConfig {
    /// Check the values that become part of a path or of a list the engine
    /// splits itself: an area name is one plain folder name, nothing that
    /// could climb out of the vault or break the comma separated list.
    ///
    /// # Errors
    ///
    /// The reason, as text, for the first value that is not acceptable.
    pub fn validate(&self) -> Result<(), String> {
        for name in &self.extra_areas {
            let bad = |why: &str| Err(format!("extra_areas: {name:?} {why}"));
            if name.is_empty() || name.chars().count() > MAX_AREA_NAME {
                return bad("must have 1 to 128 characters");
            }
            if name.starts_with('.') || name.ends_with([' ', '.']) {
                return bad("must not start with a dot or end with a dot or a space");
            }
            if name
                .chars()
                .any(|c| c.is_control() || "/\\,:*?\"<>|".contains(c))
            {
                return bad("holds a character that is not allowed in a folder name");
            }
        }
        Ok(())
    }
}

/// Why the settings file could not be used.
#[derive(Debug)]
pub enum ConfigError {
    /// The file exists but cannot be read.
    Unreadable(PathBuf, std::io::Error),
    /// The file is not valid for this version.
    Invalid(PathBuf, String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(p, e) => write!(f, "cannot read {}: {e}", p.display()),
            Self::Invalid(p, e) => write!(f, "invalid settings file {}: {e}", p.display()),
        }
    }
}

impl std::error::Error for ConfigError {}

/// The config folder of this app on this device.
///
/// `TASKS_DESKTOP_CONFIG_DIR` overrides it; otherwise `%APPDATA%`,
/// `$XDG_CONFIG_HOME` or `~/.config` (and `~/Library/Application Support`
/// on macOS, which is not a promised platform, concept 13.9).
#[must_use]
pub fn config_dir(env: &Env) -> Option<PathBuf> {
    if let Some(dir) = env.path("TASKS_DESKTOP_CONFIG_DIR") {
        return Some(dir);
    }
    let base = if cfg!(windows) {
        env.path("APPDATA")
    } else if cfg!(target_os = "macos") {
        env.path("HOME")
            .map(|h| h.join("Library").join("Application Support"))
    } else {
        env.path("XDG_CONFIG_HOME")
            .or_else(|| env.path("HOME").map(|h| h.join(".config")))
    };
    base.map(|b| b.join("tasks-desktop"))
}

/// Load `config.json` from `dir`. A missing file is an empty config.
///
/// # Errors
///
/// [`ConfigError`] when the file exists and cannot be read or is not valid.
pub fn load_file(dir: &Path) -> Result<FileConfig, ConfigError> {
    use std::io::Read;

    let path = dir.join("config.json");
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FileConfig::default()),
        Err(e) => return Err(ConfigError::Unreadable(path, e)),
    };
    // A settings file is a few lines; a device or a huge file is not one.
    let mut text = String::new();
    if let Err(e) = file.take(MAX_FILE_BYTES + 1).read_to_string(&mut text) {
        return Err(ConfigError::Unreadable(path, e));
    }
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err(ConfigError::Invalid(
            path,
            format!("larger than {} KiB", MAX_FILE_BYTES / 1024),
        ));
    }
    let cfg: FileConfig = serde_json::from_str(&text)
        .map_err(|e| ConfigError::Invalid(path.clone(), e.to_string()))?;
    cfg.validate()
        .map_err(|why| ConfigError::Invalid(path, why))?;
    Ok(cfg)
}

/// The largest settings file that is read.
const MAX_FILE_BYTES: u64 = 64 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_for_the_config_dir() {
        let env = Env::from_pairs([
            ("TASKS_DESKTOP_CONFIG_DIR", "C:/x/cfg"),
            ("APPDATA", "C:/a"),
        ]);
        assert_eq!(config_dir(&env), Some(PathBuf::from("C:/x/cfg")));
    }

    #[test]
    fn an_empty_variable_is_not_set() {
        let env = Env::from_pairs([("TASKS_VAULT", "")]);
        assert!(env.get("TASKS_VAULT").is_none());
    }

    #[test]
    fn unknown_keys_in_the_file_are_refused() {
        let err = serde_json::from_str::<FileConfig>(r#"{"vault":"x","vualt":"y"}"#);
        assert!(err.is_err());
    }

    #[test]
    fn a_missing_file_is_an_empty_config() {
        let dir = std::env::temp_dir().join("tasks-desktop-no-such-config-dir");
        let cfg = load_file(&dir).expect("missing file is fine");
        assert!(cfg.vault.is_none() && cfg.extra_areas.is_empty());
    }

    fn areas(names: &[&str]) -> FileConfig {
        FileConfig {
            extra_areas: names.iter().map(|s| (*s).to_owned()).collect(),
            ..FileConfig::default()
        }
    }

    #[test]
    fn plain_area_names_are_accepted() {
        assert!(
            areas(&["ALL", "nvim-config", "docmap-desktop", "migrate.nvim"])
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn area_names_that_could_leave_the_vault_or_split_the_list_are_refused() {
        for bad in [
            "", "..", ".", "a/b", "a\\b", "a,b", "../x", ".hidden", "a:b", "a\nb", "trail.",
            "C:\\x",
        ] {
            assert!(areas(&[bad]).validate().is_err(), "{bad:?} was accepted");
        }
    }

    fn temp_config(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tasks-desktop-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), bytes).unwrap();
        dir
    }

    #[test]
    fn a_settings_file_with_a_bad_area_is_refused_on_load() {
        let dir = temp_config("bad-area", br#"{"extra_areas":["../outside"]}"#);
        assert!(matches!(load_file(&dir), Err(ConfigError::Invalid(..))));
    }

    #[test]
    fn a_huge_settings_file_is_refused() {
        let mut text = String::from("{\"extra_areas\":[");
        text.push_str(&"\"a\",".repeat(40_000));
        text.push_str("\"b\"]}");
        let dir = temp_config("huge", text.as_bytes());
        assert!(matches!(load_file(&dir), Err(ConfigError::Invalid(..))));
    }
}
