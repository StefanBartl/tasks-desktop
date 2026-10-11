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
    let path = dir.join("config.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FileConfig::default()),
        Err(e) => return Err(ConfigError::Unreadable(path, e)),
    };
    serde_json::from_str(&text).map_err(|e| ConfigError::Invalid(path, e.to_string()))
}

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
}
