//! What the security matrix needs to know about an app.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use appkit_core::authn::{ManualClock, Secret};
use appkit_core::identity::AppIdentity;
use appkit_hub::{BoxFuture, HubStatus, Limits, RunningServer};

/// How a test wants the hub started.
pub struct StartConfig {
    /// Must be loopback for the hub to start; the tests also try addresses that are not.
    pub addr: SocketAddr,
    pub limits: Limits,
    /// The clock of the pairing and of the limits: a test moves it.
    pub clock: Arc<ManualClock>,
    pub pairing_ttl: Duration,
    pub control_secret: Secret,
    pub instance: Secret,
    /// What `hello` says about the engine.
    pub status: HubStatus,
}

/// An app whose hub the matrix is run against.
pub trait Subject: Send + Sync {
    /// The names of the app: the matrix reads the paths of its routes from here.
    fn identity(&self) -> &'static AppIdentity;

    /// Start the hub of the app, with no engine and no page, on the address the test names.
    fn start(&self, cfg: StartConfig) -> BoxFuture<'_, std::io::Result<RunningServer>>;

    /// The names (below the namespace of the app) of the routes that answer a GET and need a
    /// session. The matrix asks each of them without one, and with every wrong kind of one.
    fn data_routes(&self) -> Vec<&'static str>;
}
