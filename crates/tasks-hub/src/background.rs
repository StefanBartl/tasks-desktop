//! The hub as a background program (`start`, `stop`, `autostart`, `install`, `uninstall`): the
//! work is the kit's, this module states what is the tasks hub's own and keeps the names the
//! other modules and the tests use.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use hub_kit::background::Background;
pub use hub_kit::background::{
    run_command, start_from, Autostart, InstallOptions, UninstallOptions,
};

use crate::config::Env;

/// The files of the tasks hub in the config folder besides those every hub has.
const EXTRA_FILES: [&str; 3] = ["setup.json", "areas.json", "areas.proposed.json"];

/// What the background commands know about this app.
pub(crate) const APP: Background<'static> = Background {
    login: crate::LOGIN,
    extra_files: &EXTRA_FILES,
};

/// Start a hub in the background unless one runs. Returns what to print.
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn start() -> Result<String, String> {
    hub_kit::background::start(&APP).await
}

/// Stop the hub that runs (the one `hub.json` names and that answers as it).
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn stop() -> Result<String, String> {
    hub_kit::background::stop(&APP).await
}

/// Start the hub with the login of the user.
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn autostart(what: Autostart) -> Result<String, String> {
    hub_kit::background::autostart(&APP, what)
}

/// [`autostart`] for the program at `exe` (what `install` registers).
///
/// # Errors
///
/// A text for the person at the terminal.
pub fn autostart_for(what: Autostart, exe: &Path) -> Result<String, String> {
    hub_kit::background::autostart_for(&APP, what, exe)
}

/// Where `install` puts this program.
///
/// # Errors
///
/// The reason there is no install folder.
pub fn installed_program(env: &Env) -> Result<PathBuf, String> {
    hub_kit::background::installed_program(&APP, env)
}

/// The file name the program has once installed.
#[must_use]
pub fn program_file() -> String {
    crate::IDENTITY.program_file()
}

/// Copy this program to a fixed place and start the hub from there again when one was running.
///
/// # Errors
///
/// A text for the person at the terminal.
pub async fn install(opts: InstallOptions) -> Result<String, String> {
    hub_kit::background::install(&APP, opts).await
}

/// Take the integration of the program with the system away.
pub fn uninstall(
    opts: UninstallOptions,
) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> {
    hub_kit::background::uninstall(&APP, opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `uninstall --purge-settings` removes these files and nothing else: a file of the app that
    /// is not named here would stay behind, one that is named here and is not the app's is lost.
    #[test]
    fn the_files_of_the_tasks_hub_besides_the_kits_are_named() {
        assert_eq!(
            APP.extra_files,
            ["setup.json", "areas.json", "areas.proposed.json"]
        );
        assert_eq!(APP.login.summary, "the task overview");
        assert!(program_file().starts_with("tasks-hub"));
    }
}
