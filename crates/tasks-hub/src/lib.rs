//! The hub: talks to the tasks.nvim engine and serves its documents.
//!
//! The engine is the only thing that reads or writes task files; nothing in
//! this crate parses frontmatter (concept 3.2). The engine is reached
//! through a trait so the one-process-per-call `CliEngine` of P2 can later
//! give way to a persistent host without touching the routes.

pub mod app;
pub mod background;
pub mod classes;
pub mod config;
pub mod discovery;
pub mod editor;
pub mod engine;
pub mod search;
pub mod server;
pub mod setup;
pub mod store;
pub mod ui;
pub mod watch;

pub use appkit_hub::{client, loginitems, usage};

/// The names this app gives itself: config folder, environment variables, login entries, program
/// file, port and route namespace all come from here.
pub const IDENTITY: appkit_core::identity::AppIdentity = appkit_core::identity::AppIdentity {
    app: "tasks-desktop",
    binary: "tasks-hub",
    env_prefix: "TASKS_DESKTOP",
    title: "Tasks",
    default_port: 17615,
    route_ns: "tasks",
};

/// What the login entries and the launcher say about this app.
pub const LOGIN: appkit_hub::loginitems::LoginApp<'static> = appkit_hub::loginitems::LoginApp {
    identity: &IDENTITY,
    summary: "the task overview",
};

/// Version of this hub, as reported by `hello`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What a build that is not a release says about itself (the commit it was made from): set by the
/// workflow of the rolling build through `TASKS_HUB_BUILD`, absent in a release and in a local build.
pub const BUILD: Option<&str> = option_env!("TASKS_HUB_BUILD");

/// The line `--version` prints: `tasks-hub 0.0.0`, and `tasks-hub 0.0.0 (build abc1234)` for a rolling build.
/// A release is exactly the first form (the release workflow compares it with the tag).
#[must_use]
pub fn version_line() -> String {
    version_line_for(BUILD)
}

/// [`version_line`] for a given build (so that both forms are testable: `BUILD` is fixed at compile time).
#[must_use]
pub fn version_line_for(build: Option<&str>) -> String {
    match build {
        Some(build) if !build.is_empty() => format!("tasks-hub {VERSION} (build {build})"),
        _ => format!("tasks-hub {VERSION}"),
    }
}

#[cfg(test)]
mod tests {
    use super::IDENTITY;

    /// The names are on disk and in people's environments (the config folder, the `Run` value,
    /// `TASKS_DESKTOP_*`): a rename is a migration, not a refactor.
    #[test]
    fn the_names_on_disk_and_in_the_environment_do_not_move() {
        assert_eq!(IDENTITY.app, "tasks-desktop");
        assert_eq!(IDENTITY.binary, "tasks-hub");
        assert_eq!(IDENTITY.var("CONFIG_DIR"), "TASKS_DESKTOP_CONFIG_DIR");
        assert_eq!(IDENTITY.var("NO_LOGIN_SYNC"), "TASKS_DESKTOP_NO_LOGIN_SYNC");
        assert_eq!(IDENTITY.default_port, 17615);
        assert_eq!(IDENTITY.route("hello"), "/api/tasks/hello");
        assert_eq!(IDENTITY.agent_label(), "dev.tasks-desktop.hub");
        assert_eq!(IDENTITY.desktop_file(), "tasks-desktop.desktop");
    }
}
