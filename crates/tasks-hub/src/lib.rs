//! The hub: talks to the tasks.nvim engine and serves its documents.
//!
//! The engine is the only thing that reads or writes task files; nothing in
//! this crate parses frontmatter (concept 3.2). The engine is reached
//! through a trait so the one-process-per-call `CliEngine` of P2 can later
//! give way to a persistent host without touching the routes.

pub mod app;
pub mod background;
pub mod classes;
pub mod client;
pub mod config;
pub mod discovery;
pub mod editor;
pub mod engine;
pub mod loginitems;
pub mod search;
pub mod server;
pub mod setup;
pub mod store;
pub mod ui;
pub mod usage;
pub mod watch;

/// Version of this hub, as reported by `hello`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What a build that is not a release says about itself (the commit it was made from): set by the
/// workflow of the rolling build through `TASKS_HUB_BUILD`, absent in a release and in a local build.
pub const BUILD: Option<&str> = option_env!("TASKS_HUB_BUILD");

/// The line `--version` prints: `tasks-hub 0.0.0`, and `tasks-hub 0.0.0 (build abc1234)` for a rolling build.
/// A release is exactly the first form (the release workflow compares it with the tag).
#[must_use]
pub fn version_line() -> String {
    match BUILD {
        Some(build) if !build.is_empty() => format!("tasks-hub {VERSION} (build {build})"),
        _ => format!("tasks-hub {VERSION}"),
    }
}
