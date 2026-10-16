//! The limits and the status of a server (concept 5.5 Nr. 7).

use crate::*;

/// Size and time limits (concept 5.5 Nr. 7).
#[derive(Debug, Clone)]
pub struct Limits {
    /// Request line and headers together. hyper cannot go below 8 KiB.
    pub max_head_bytes: usize,
    pub max_body_bytes: usize,
    /// The body of the routes that take a few bytes (a code, nothing).
    /// What is not logged in yet must not be able to make the hub buffer
    /// a megabyte per connection.
    pub small_body_bytes: usize,
    /// How long a client may take to send the request head.
    pub header_timeout: Duration,
    /// How long a request may take from its head to its answer.
    pub request_timeout: Duration,
    pub max_connections: usize,
    /// Mutations (POST) per window, over all clients.
    pub post_max: usize,
    pub post_window: Duration,
    /// POSTs to `ops` per window, dry runs included (the wizard asks once per key a person types):
    /// the coarse limit of that route, in the guard before any credential. The writes among them
    /// are counted again, strictly, by `post_max`.
    pub ops_max: usize,
    pub ops_window: Duration,
    /// Pairing exchanges per window: a code is guessable only by trying.
    pub exchange_max: usize,
    pub exchange_window: Duration,
    /// Open sessions; the oldest is closed beyond this.
    pub max_sessions: usize,
    /// How old a held snapshot may get before it is fetched again. `None`:
    /// only a change (the watcher, the timer, a rescan) replaces it.
    pub snapshot_max_age: Option<Duration>,
    /// Open event streams one session may hold.
    pub max_streams_per_session: usize,
    /// How often an idle event stream says it is alive.
    pub heartbeat: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_head_bytes: 8 * 1024,
            max_body_bytes: 1024 * 1024,
            small_body_bytes: 1024,
            header_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(30),
            max_connections: 64,
            post_max: 60,
            post_window: Duration::from_secs(10),
            ops_max: 300,
            ops_window: Duration::from_secs(10),
            exchange_max: 10,
            exchange_window: Duration::from_secs(60),
            max_sessions: 16,
            snapshot_max_age: Some(Duration::from_secs(1)),
            max_streams_per_session: 4,
            heartbeat: Duration::from_secs(15),
        }
    }
}

/// What `hello` says about the engine. A short code, never a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubStatus {
    pub engine_ready: bool,
    pub problem: Option<&'static str>,
    /// What the engine can do, so that the page offers only that.
    pub capabilities: Vec<String>,
}
