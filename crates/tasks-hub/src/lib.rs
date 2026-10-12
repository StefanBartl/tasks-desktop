//! The hub: talks to the tasks.nvim engine and serves its documents.
//!
//! The engine is the only thing that reads or writes task files; nothing in
//! this crate parses frontmatter (concept 3.2). The engine is reached
//! through a trait so the one-process-per-call `CliEngine` of P2 can later
//! give way to a persistent host without touching the routes.

pub mod app;
pub mod classes;
pub mod client;
pub mod config;
pub mod discovery;
pub mod engine;
pub mod search;
pub mod server;
pub mod store;
pub mod ui;
pub mod usage;
pub mod watch;

/// Version of this hub, as reported by `hello`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
