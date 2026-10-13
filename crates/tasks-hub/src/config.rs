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

use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FileConfig {
    /// The vault folder (the root that holds the areas). The vault called
    /// [`MAIN_VAULT`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault: Option<PathBuf>,
    /// More vaults (roots that hold areas), by name. The hub reads one at a
    /// time: the one `active` names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vaults: Vec<VaultEntry>,
    /// The name of the vault that is read (`main` or an entry of `vaults`);
    /// none means `main`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    /// The Neovim executable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nvim: Option<PathBuf>,
    /// A checkout of tasks.nvim (the folder with `scripts/tasks.lua`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_dir: Option<PathBuf>,
    /// A checkout of lib.nvim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lib_dir: Option<PathBuf>,
    /// Folders that are areas although they have no `ROADMAP/` or `Backlog/`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_areas: Vec<String>,
    /// The port the hub tries first (it is part of the origin).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// The name of the vault that `vault` (or `TASKS_VAULT`) names.
pub const MAIN_VAULT: &str = "main";
/// The most vaults in the settings.
pub const MAX_VAULTS: usize = 16;

/// One more vault: a name and the folder that holds its areas.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VaultEntry {
    pub name: String,
    pub path: PathBuf,
}

/// Is this a name for a vault: 1 to 40 letters, digits, dot, dash, underscore,
/// not starting with a dot, and not the name of the main vault.
///
/// # Errors
///
/// What is wrong with the name.
pub fn valid_vault_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() || name.chars().count() > 40 {
        return Err("must have 1 to 40 characters");
    }
    if name.starts_with('.')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(
            "may hold letters, digits, dot, dash and underscore, and does not start with a dot",
        );
    }
    if name == MAIN_VAULT {
        return Err("is the name of the main vault");
    }
    Ok(())
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
        if self.port.is_some_and(|p| p < 1024) {
            return Err("port: must be 1024 or higher".to_owned());
        }
        for name in &self.extra_areas {
            valid_area_name(name).map_err(|why| format!("extra_areas: {name:?} {why}"))?;
        }
        if self.vaults.len() > MAX_VAULTS {
            return Err(format!("vaults: at most {MAX_VAULTS}"));
        }
        for (i, v) in self.vaults.iter().enumerate() {
            valid_vault_name(&v.name).map_err(|why| format!("vaults: {:?} {why}", v.name))?;
            if !v.path.is_absolute() {
                return Err(format!("vaults: {:?} needs an absolute path", v.name));
            }
            if self.vaults[..i].iter().any(|o| o.name == v.name) {
                return Err(format!("vaults: the name {:?} is there twice", v.name));
            }
        }
        if let Some(active) = self
            .active
            .as_ref()
            .filter(|a| *a != MAIN_VAULT && !self.vaults.iter().any(|v| &v.name == *a))
        {
            return Err(format!("active: there is no vault {active:?}"));
        }
        Ok(())
    }

    /// The settings as they are for the vault that is read: `vault` is the
    /// folder of the active vault.
    #[must_use]
    pub fn effective(&self) -> Self {
        let mut out = self.clone();
        if let Some(entry) = self
            .active
            .as_ref()
            .and_then(|a| self.vaults.iter().find(|v| &v.name == a))
        {
            out.vault = Some(entry.path.clone());
        }
        out
    }

    /// The name of the vault that is read.
    #[must_use]
    pub fn active_name(&self) -> &str {
        self.active.as_deref().unwrap_or(MAIN_VAULT)
    }
}

/// Is this one plain folder name, fit to be an area (or a repository)?
/// Nothing that could climb out of a folder, name a drive, hide itself or
/// break a comma separated list.
///
/// # Errors
///
/// What is wrong with the name.
pub fn valid_area_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() || name.chars().count() > MAX_AREA_NAME {
        return Err("must have 1 to 128 characters");
    }
    if name.starts_with('.') || name.ends_with([' ', '.']) {
        return Err("must not start with a dot or end with a dot or a space");
    }
    if name
        .chars()
        .any(|c| c.is_control() || "/\\,:*?\"<>|".contains(c))
    {
        return Err("holds a character that is not allowed in a folder name");
    }
    Ok(())
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

/// Write `config.json` into `dir` in one step (a temporary file, then a
/// rename): a crash leaves the old file or the new one.
///
/// # Errors
///
/// The reason, as text.
pub fn save_file(dir: &Path, cfg: &FileConfig) -> Result<(), String> {
    cfg.validate()?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot make the config folder: {e}"))?;
    let tmp = dir.join(format!("config.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, format!("{text}\n"))
        .map_err(|e| format!("cannot write the settings: {e}"))?;
    std::fs::rename(&tmp, dir.join("config.json")).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot replace the settings: {e}")
    })
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

    fn with_vaults(entries: &[(&str, &str)], active: Option<&str>) -> FileConfig {
        FileConfig {
            vaults: entries
                .iter()
                .map(|(n, p)| VaultEntry {
                    name: (*n).to_owned(),
                    path: PathBuf::from(p),
                })
                .collect(),
            active: active.map(str::to_owned),
            ..FileConfig::default()
        }
    }

    fn abs() -> &'static str {
        if cfg!(windows) {
            "C:/v"
        } else {
            "/v"
        }
    }

    #[test]
    fn vaults_have_plain_names_absolute_paths_and_an_active_one_that_exists() {
        assert!(with_vaults(&[("native", abs())], Some("native"))
            .validate()
            .is_ok());
        assert!(with_vaults(&[], Some("main")).validate().is_ok());
        for (entries, active) in [
            (vec![("main", abs())], None),
            (vec![("../x", abs())], None),
            (vec![("a b", abs())], None),
            (vec![(".h", abs())], None),
            (vec![("a", "rel/path")], None),
            (vec![("a", abs()), ("a", abs())], None),
            (vec![("a", abs())], Some("b")),
        ] {
            assert!(
                with_vaults(&entries, active).validate().is_err(),
                "{entries:?} {active:?} was accepted"
            );
        }
    }

    #[test]
    fn the_active_vault_decides_which_folder_is_read() {
        let mut cfg = with_vaults(&[("native", abs())], Some("native"));
        cfg.vault = Some(PathBuf::from("/main"));
        assert_eq!(cfg.effective().vault, Some(PathBuf::from(abs())));
        assert_eq!(cfg.active_name(), "native");
        cfg.active = None;
        assert_eq!(cfg.effective().vault, Some(PathBuf::from("/main")));
        assert_eq!(cfg.active_name(), MAIN_VAULT);
    }

    #[test]
    fn saving_writes_what_loading_reads_and_refuses_what_is_not_valid() {
        let dir = std::env::temp_dir().join(format!("tasks-desktop-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut cfg = with_vaults(&[("native", abs())], Some("native"));
        cfg.port = Some(20000);
        save_file(&dir, &cfg).unwrap();
        let back = load_file(&dir).unwrap();
        assert_eq!(back.vaults, cfg.vaults);
        assert_eq!(
            (back.active, back.port),
            (Some("native".to_owned()), Some(20000))
        );
        let bad = with_vaults(&[("a b", abs())], None);
        assert!(save_file(&dir, &bad).is_err());
        assert!(
            load_file(&dir).is_ok(),
            "a refused save leaves the file as it was"
        );
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
