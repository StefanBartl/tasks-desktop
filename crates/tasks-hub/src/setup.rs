//! The first start by a double click: where the vault is, and whether to install the program. The
//! questions are the kit's; this module states what the tasks hub calls its vault.

use std::path::{Path, PathBuf};

use appkit_hub::setup::SetupApp;
pub use appkit_hub::setup::{Console, Io};

use crate::config::{Env, TasksSettings};

/// What the questions say about this app.
const APP: SetupApp<'static> = SetupApp {
    background: &crate::background::APP,
    vault_var: "TASKS_VAULT",
    vault_explained:
        "No task vault is set yet. It is the folder that holds one folder per area (tasks.nvim).",
};

/// Whether there is a person to ask.
#[must_use]
pub fn interactive(env: &Env) -> bool {
    appkit_hub::setup::interactive(&APP, env)
}

/// The questions of a first start. Returns the installed program to start the hub from, when there is one.
///
/// # Errors
///
/// A text for the person at the console (the settings cannot be read or written, the install failed).
pub async fn run(io: &mut dyn Io, env: &Env) -> Result<Option<PathBuf>, String> {
    appkit_hub::setup::run::<TasksSettings>(&APP, io, env).await
}

/// The settings as they are now (for the tests of the vault step).
#[must_use]
pub fn vault_in_settings(dir: &Path) -> Option<PathBuf> {
    appkit_hub::setup::vault_in_settings::<TasksSettings>(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A person sees these words and has these variables: they stay as they were.
    #[test]
    fn the_hub_names_its_vault_the_way_it_always_did() {
        assert_eq!(APP.vault_var, "TASKS_VAULT");
        assert!(APP.vault_explained.starts_with("No task vault is set yet."));
        let off = Env::from_pairs([("TASKS_DESKTOP_NO_SETUP", "1")]);
        assert!(!interactive(&off));
        let piped = Env::from_pairs([("TASKS_DESKTOP_ASSUME_TERMINAL", "1")]);
        assert!(interactive(&piped));
    }
}
