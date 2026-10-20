//! The vault the hub reads, as the app's runtime is made from it.

use super::*;

/// The vault the hub reads and what it needs: an engine that answered, or
/// the reason it did not.
pub struct VaultTarget {
    pub engine: Option<Arc<dyn Engine>>,
    pub status: HubStatus,
    /// The folder to watch, once the engine is known to be there.
    pub vault: Option<PathBuf>,
    /// The data classes of the areas of this vault; none keeps the ones the hub has.
    pub policy: Option<Arc<AreaPolicy>>,
}
