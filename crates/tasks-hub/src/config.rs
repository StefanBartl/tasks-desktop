//! The settings of the hub: the keys every app has come from `appkit-hub`, the two keys of the tasks
//! engine are [`TasksSettings`].

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use appkit_hub::config::{
    valid_vault_name, AppSettings, ConfigError, Resolved, Source, VaultEntry, MAIN_VAULT,
    MAX_VAULTS,
};
pub use appkit_hub::env::Env;

/// The keys of `config.json` that only the tasks engine has.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TasksSettings {
    /// A checkout of lib.nvim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lib_dir: Option<PathBuf>,
    /// Folders that are areas although they have no `ROADMAP/` or `Backlog/`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_areas: Vec<String>,
}

impl AppSettings for TasksSettings {
    /// An area name is one plain folder name, nothing that could climb out of the vault or break
    /// the comma separated list the engine splits itself.
    fn validate(&self) -> Result<(), String> {
        for name in &self.extra_areas {
            valid_area_name(name).map_err(|why| format!("extra_areas: {name:?} {why}"))?;
        }
        Ok(())
    }
}

/// The settings file of the tasks hub.
pub type FileConfig = appkit_hub::config::FileConfig<TasksSettings>;

/// The longest name of an area the hub accepts.
const MAX_AREA_NAME: usize = 128;

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

/// The config folder of this app on this device (see [`appkit_hub::config::config_dir`]).
#[must_use]
pub fn config_dir(env: &Env) -> Option<PathBuf> {
    appkit_hub::config::config_dir(env, &crate::IDENTITY)
}

/// Load `config.json` from `dir`. A missing file is an empty config.
///
/// # Errors
///
/// [`ConfigError`] when the file exists and cannot be read or is not valid.
pub fn load_file(dir: &Path) -> Result<FileConfig, ConfigError> {
    appkit_hub::config::load_file(dir)
}

/// Write `config.json` into `dir` in one step.
///
/// # Errors
///
/// The reason, as text.
pub fn save_file(dir: &Path, cfg: &FileConfig) -> Result<(), String> {
    appkit_hub::config::save_file(dir, cfg)
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
        assert!(serde_json::from_str::<FileConfig>(r#"{"vault":"x","vualt":"y"}"#).is_err());
        assert!(serde_json::from_str::<FileConfig>(r#"{"extra_areas":[],"lib_dir":"x"}"#).is_ok());
    }

    /// The file on disk keeps its keys: the two of the tasks engine are read from, and written
    /// to, the same level as the others.
    #[test]
    fn the_keys_of_the_tasks_engine_stay_in_the_one_flat_file() {
        let text =
            r#"{"vault":"V","engine_dir":"E","lib_dir":"L","extra_areas":["ALL"],"port":20000}"#;
        let cfg: FileConfig = serde_json::from_str(text).unwrap();
        assert_eq!(cfg.app.lib_dir, Some(PathBuf::from("L")));
        assert_eq!(cfg.app.extra_areas, ["ALL"]);
        // The text, not the values: a file that is saved keeps the order it always had, so a
        // person who keeps it in git sees no move of `port`.
        assert_eq!(serde_json::to_string(&cfg).unwrap(), text);
    }

    #[test]
    fn a_missing_file_is_an_empty_config() {
        let dir = std::env::temp_dir().join("tasks-desktop-no-such-config-dir");
        let cfg = load_file(&dir).expect("missing file is fine");
        assert!(cfg.vault.is_none() && cfg.app.extra_areas.is_empty());
    }

    fn areas(names: &[&str]) -> FileConfig {
        FileConfig {
            app: TasksSettings {
                extra_areas: names.iter().map(|s| (*s).to_owned()).collect(),
                ..TasksSettings::default()
            },
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
}
