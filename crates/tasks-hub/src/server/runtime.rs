//! What the hub keeps for the vault it reads: the engine, the snapshot, the search and the caches.

use super::*;

/// What the hub keeps for the vault it reads: the engine and the answers
/// that depend on it. Dropping it stops the watching and the indexing.
pub(super) struct VaultRuntime {
    /// The folder of the vault, when the engine is there.
    pub(super) vault: Option<PathBuf>,
    pub(super) status: HubStatus,
    /// The data classes of the areas.
    pub(super) classes: Arc<AreaPolicy>,
    /// Shows a task file in an editor; none in a hub that cannot.
    pub(super) opener: Option<Arc<dyn FileOpener>>,
    /// How often the interface is used (counts per day), if kept.
    pub(super) usage: Option<Arc<UsageLog>>,
    /// The event streams that are open, by session token.
    pub(super) streams: Arc<StreamCounter>,
    /// The folders `attach` may take the newest screenshot from (the hub's settings, never the page).
    pub(super) attach_dirs: Arc<Vec<String>>,
    /// The folder of the plugin checkouts the snapshots of the test sheets are read from.
    pub(super) snapshot_root: Option<Arc<PathBuf>>,
    pub(super) engine: Option<Arc<dyn Engine>>,
    pub(super) store: Arc<SnapshotStore>,
    pub(super) search: Option<Arc<SearchIndex>>,
    pub(super) details: StdMutex<Details>,
    /// The check of the vault, run as a job: at most one at a time, and gone with the vault.
    pub(super) check: StdMutex<CheckJob>,
    /// When the last check was started, by a person or by the hub itself.
    pub(super) check_started: StdMutex<Option<std::time::Instant>>,
    /// Whether the hub runs the check again after the vault was changed (see `follow_changes`): on once a person
    /// started a check without `refs`, off when one with `refs` was started (running it again would take those out).
    pub(super) auto_check: std::sync::atomic::AtomicBool,
    /// The parameters of the last check a person started (the area), which the hub's own runs repeat.
    pub(super) check_params: StdMutex<serde_json::Map<String, serde_json::Value>>,
    /// The follower of the changes is started once for a runtime.
    pub(super) auto_check_started: std::sync::atomic::AtomicBool,
    /// Set when the runtime is retired (another vault was chosen): nothing is started in it any more.
    pub(super) retired: std::sync::atomic::AtomicBool,
    pub(super) jobs: StdMutex<Vec<JoinHandle<()>>>,
    // Kept alive: the refresher ends when every sender of hints is gone, and
    // the timer must keep running even if the file watcher could not start.
    pub(super) _hints: Option<mpsc::UnboundedSender<Hint>>,
    pub(super) _watcher: Option<fswatch::Watcher>,
}

impl Runtime for VaultRuntime {
    type Target = VaultTarget;

    fn status(&self) -> &HubStatus {
        &self.status
    }

    fn stop(&self) {
        VaultRuntime::stop(self);
    }

    fn setup_required(&self) -> Option<&'static str> {
        setup_reason(self.status.problem)
    }
}

/// The problems of the start that only a person can fix by setting the app up (no vault, or one
/// that is not a folder): `hello` reports them as `setup_required`. A missing Neovim or engine is
/// a problem of the machine, not of the first start.
fn setup_reason(problem: Option<&'static str>) -> Option<&'static str> {
    problem.filter(|p| matches!(*p, "no_vault" | "vault_not_a_directory"))
}

#[cfg(test)]
mod setup_tests {
    use super::setup_reason;

    #[test]
    fn only_a_missing_or_unusable_vault_asks_for_the_setup() {
        for (problem, reason) in [
            (Some("no_vault"), Some("no_vault")),
            (Some("vault_not_a_directory"), Some("vault_not_a_directory")),
            (Some("nvim_not_found"), None),
            (Some("engine_not_found"), None),
            (None, None),
        ] {
            assert_eq!(setup_reason(problem), reason, "{problem:?}");
        }
    }
}

/// What does not change when another vault is chosen but belongs to the state of one vault.
#[derive(Clone)]
pub(super) struct AppParts {
    pub(super) classes: Arc<AreaPolicy>,
    pub(super) opener: Option<Arc<dyn FileOpener>>,
    pub(super) usage: Option<Arc<UsageLog>>,
    pub(super) streams: Arc<StreamCounter>,
    pub(super) attach_dirs: Arc<Vec<String>>,
    pub(super) snapshot_root: Option<Arc<PathBuf>>,
}

impl VaultRuntime {
    /// Stop the refresher and the indexer.
    pub(super) fn stop(&self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            // Under the lock the jobs are kept in: a start that took the lock first has its handle drained below, one
            // that takes it after sees the flag.
            self.retired
                .store(true, std::sync::atomic::Ordering::Release);
            for job in jobs.drain(..) {
                job.abort();
            }
        }
    }
}

impl Drop for VaultRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The state for one vault, with the watcher and the jobs that keep it fresh.
pub(super) fn build_runtime(
    engine: Option<Arc<dyn Engine>>,
    status: HubStatus,
    vault: Option<PathBuf>,
    max_age: Option<Duration>,
    refresh: RefreshOptions,
    app: &AppParts,
) -> VaultRuntime {
    let store = SnapshotStore::new(
        engine.clone(),
        crate::store::SHAPE,
        StoreOptions {
            max_age,
            ..StoreOptions::default()
        },
    );
    // The text of the tasks, for the search: kept by the hub, read by the engine.
    let search = engine
        .clone()
        .map(|engine| SearchIndex::new(engine, crate::engine::Calls::Bodies));
    let folder = vault.clone();
    let mut jobs = Vec::new();
    if let Some(index) = &search {
        jobs.push(search::spawn_indexer(Arc::clone(index), &store));
    }
    // The watcher only says "look again"; the refresher does the looking.
    let (mut hints, mut watcher) = (None, None);
    if let Some(vault) = vault {
        let (tx, rx) = mpsc::unbounded_channel();
        match fswatch::start(&vault, tx.clone()) {
            Ok(started) => watcher = Some(started),
            // Not fatal: the timer and the rescan request still work.
            Err(e) => {
                eprintln!("note: the vault cannot be watched ({e}); scanning on a timer only");
            }
        }
        jobs.push(store::spawn_refresher(Arc::clone(&store), rx, refresh));
        hints = Some(tx);
    }
    VaultRuntime {
        vault: folder,
        status,
        classes: Arc::clone(&app.classes),
        opener: app.opener.clone(),
        usage: app.usage.clone(),
        streams: Arc::clone(&app.streams),
        attach_dirs: Arc::clone(&app.attach_dirs),
        snapshot_root: app.snapshot_root.clone(),
        engine,
        store,
        search,
        details: StdMutex::new(Details::default()),
        check: StdMutex::new(CheckJob::default()),
        check_started: StdMutex::new(None),
        auto_check: std::sync::atomic::AtomicBool::new(false),
        check_params: StdMutex::new(serde_json::Map::new()),
        auto_check_started: std::sync::atomic::AtomicBool::new(false),
        retired: std::sync::atomic::AtomicBool::new(false),
        jobs: StdMutex::new(jobs),
        _hints: hints,
        _watcher: watcher,
    }
}

/// The most task documents kept.
pub(super) const DETAILS_KEPT: usize = 64;
/// How long one is believed even when no change was seen: the watcher is the
/// way a change is noticed, and this bounds the harm of a notice that was lost.
pub(super) const DETAILS_TTL: Duration = Duration::from_secs(30);

/// The documents of `task` the hub has answered for one state of the vault.
/// A document holds the blockers in both directions, so it is true for the
/// `rev` it was made for and for no other: a change of the vault empties
/// the whole table.
#[derive(Default)]
pub(super) struct Details {
    pub(super) rev: Option<String>,
    pub(super) docs: HashMap<String, (std::time::Instant, Bytes)>,
    pub(super) order: std::collections::VecDeque<String>,
}

impl Details {
    pub(super) fn get(&mut self, rev: &str, id: &str) -> Option<Bytes> {
        if self.rev.as_deref() != Some(rev) {
            return None;
        }
        self.docs
            .get(id)
            .filter(|(at, _)| at.elapsed() < DETAILS_TTL)
            .map(|(_, doc)| doc.clone())
    }

    pub(super) fn put(&mut self, rev: &str, id: &str, doc: Bytes) {
        if self.rev.as_deref() != Some(rev) {
            self.rev = Some(rev.to_owned());
            self.docs.clear();
            self.order.clear();
        }
        let entry = (std::time::Instant::now(), doc);
        if self.docs.insert(id.to_owned(), entry).is_none() {
            self.order.push_back(id.to_owned());
            while self.order.len() > DETAILS_KEPT {
                if let Some(old) = self.order.pop_front() {
                    self.docs.remove(&old);
                }
            }
        }
    }
}
