//! The configuration the tasks hub starts a server with.

use super::*;

/// Everything the server needs to start.
pub struct ServerConfig {
    /// Must be a loopback address; port 0 picks a free port.
    pub addr: SocketAddr,
    pub limits: Limits,
    pub clock: Arc<dyn Clock>,
    pub pairing_ttl: Duration,
    /// What lets a local program ask for a pairing code.
    pub control_secret: Secret,
    /// Changes with every start.
    pub instance: Secret,
    pub status: HubStatus,
    /// The engine; `None` while it is not set up (the data routes answer
    /// "engine unavailable").
    pub engine: Option<Arc<dyn Engine>>,
    /// The data classes of the areas.
    pub policy: Arc<AreaPolicy>,
    /// Watch the vault for changes. `None`: the snapshot is only replaced by
    /// its age and by a request for a rescan (what tests without a vault do).
    pub watch: Option<WatchConfig>,
    /// The built interface, served at `/` and `/assets/`. None: a placeholder.
    pub ui: UiFiles,
    /// How often the interface is used (counts per day), if kept.
    pub usage: Option<Arc<UsageLog>>,
}

/// What to watch and how patiently.
#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub vault: PathBuf,
    pub refresh: RefreshOptions,
}
