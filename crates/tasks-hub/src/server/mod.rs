//! The local HTTP server: loopback only, every request checked before any
//! route sees it (concept 5.5).
//!
//! The order inside [`guard`] is the contract, and each step has a test in
//! `hub-testkit/tests/security.rs`:
//!
//! 1. `Host` is one of our three loopback names (DNS rebinding);
//! 2. a declared body over the limit is refused unread;
//! 3. `Origin` (if sent) and `Sec-Fetch-Site` (if sent) are ours;
//! 4. the method is one the route knows;
//! 5. a mutation without `Origin` is a program client: it needs a bearer
//!    credential and must not look like a browser;
//! 6. the rate limit for mutations (`ops` has a coarse one of its own here, dry
//!    runs included, and its writes are counted again by the handler: only the
//!    body tells a write from a dry run);
//! 7. the credential the route needs (none, the control secret, a session);
//! 8. a mutation carries `application/json`.
//!
//! The data routes (`snapshot`, `task`, `next`, `areas`) sit under `/api/`,
//! so they are closed to anything without a session. A route added later
//! is closed the same way until it is deliberately opened.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use std::task::{Context, Poll};
use std::time::Duration;

use app_core::authn::{
    fetch_site_ok, Clock, HostPolicy, PairingStore, RateLimiter, Secret, SessionStore, CODE_BYTES,
    TOKEN_BYTES,
};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, RawQuery, Request, State};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_core::Stream;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, watch, Semaphore};
use tokio::task::JoinHandle;

use crate::classes::{AreaPolicy, Shown};
use crate::editor::FileOpener;
use crate::engine::{Engine, EngineError, Method as EngineMethod};
use crate::search::{self, SearchIndex};
use crate::store::{self, RefreshOptions, SnapshotStore, StoreOptions};
use crate::ui::UiFiles;
use crate::usage::UsageLog;
use crate::watch::{self as fswatch, Hint};

mod access;
mod answer;
mod check;
mod events;
mod guard;
mod routes;
mod runtime;
mod settings;
mod vaults;

pub use self::guard::GuardRules;
pub use self::settings::{HubStatus, Limits, ServerConfig, WatchConfig};
pub use self::vaults::{BoxFuture, VaultAdmin, VaultInfo, VaultList, VaultTarget};

use self::access::*;
use self::answer::*;
use self::check::*;
use self::events::*;
use self::guard::*;
use self::routes::*;
use self::runtime::*;
use self::vaults::*;

/// The name the hub gives itself in `hello` and in `hub.json`.
pub const APP_NAME: &str = crate::IDENTITY.app;

/// The default port. It is part of the origin, so it is fixed (concept 3.3);
/// below the ephemeral ranges of Windows (49152) and Linux (32768).
pub const DEFAULT_PORT: u16 = crate::IDENTITY.default_port;

/// The event streams that are open, by session token.
#[derive(Default)]
struct StreamCounter {
    by_token: StdMutex<HashMap<String, usize>>,
}

/// One open stream; the place is given back when it is dropped.
struct StreamGuard {
    counter: Arc<StreamCounter>,
    token: String,
}

impl StreamCounter {
    fn acquire(self: &Arc<Self>, token: &str, max: usize) -> Option<StreamGuard> {
        let mut map = self
            .by_token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let open = map.entry(token.to_owned()).or_insert(0);
        if *open >= max {
            return None;
        }
        *open += 1;
        Some(StreamGuard {
            counter: Arc::clone(self),
            token: token.to_owned(),
        })
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        let mut map = self
            .counter
            .by_token
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(open) = map.get_mut(&self.token) {
            *open = open.saturating_sub(1);
            if *open == 0 {
                map.remove(&self.token);
            }
        }
    }
}

/// What a hub keeps for the vault it reads, as the core sees it: its status for `hello` and the
/// way to stop what it started. Everything else about it belongs to the app.
pub trait Runtime: Send + Sync + 'static {
    /// What `hello` says about the engine. A short code, never a path.
    fn status(&self) -> &HubStatus;
    /// Stop what the runtime started; called when another vault is chosen and when the server ends.
    fn stop(&self);
}

/// How the app makes the runtime of a vault the person chose.
pub type BuildRuntime<R> = Arc<dyn Fn(VaultTarget) -> R + Send + Sync>;

/// The state of a hub that does not depend on the app: the guard and its secrets, the pairing and
/// the sessions, the limits, the page, and the vault that is read (whatever `R` the app keeps for it).
pub struct Core<R: Runtime> {
    policy: HostPolicy,
    pairing: PairingStore,
    sessions: SessionStore,
    control: Secret,
    post_limit: RateLimiter,
    ops_limit: RateLimiter,
    exchange_limit: RateLimiter,
    limits: Limits,
    instance: String,
    guard_rules: GuardRules,
    streams: Arc<StreamCounter>,
    ui: UiFiles,
    usage: Option<Arc<UsageLog>>,
    /// What belongs to the vault that is read; replaced when another is chosen.
    runtime: StdRwLock<Arc<R>>,
    /// Makes the runtime of a vault that was chosen.
    build: BuildRuntime<R>,
    /// The vaults the person may choose from; none in a hub that has only one.
    vaults: Option<Arc<dyn VaultAdmin>>,
    /// One change of vault at a time, from the choice to the swap: two that overlap would leave the hub reading one
    /// vault while the settings name the other.
    switching: tokio::sync::Mutex<()>,
}

impl<R: Runtime> Core<R> {
    /// The state of the vault that is read now. A request keeps the one it
    /// took, so a change of vault never splits one answer in two.
    fn rt(&self) -> Arc<R> {
        Arc::clone(
            &self
                .runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

/// The core with the runtime of this app.
type Shared = Core<VaultRuntime>;

/// A started server.
pub struct RunningServer {
    addr: SocketAddr,
    instance: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
    shared: Arc<Shared>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shared.rt().stop();
    }
}

impl RunningServer {
    /// The address that was really bound.
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The instance id (hex), as `hello` reports it.
    #[must_use]
    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// Stop accepting, let open requests end, wait for the accept loop.
    pub async fn shutdown(mut self) {
        let _ = self.stop.send(true);
        self.shared.rt().stop();
        let task = std::mem::replace(&mut self.task, tokio::spawn(async {}));
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    }
}

/// Bind and serve.
///
/// # Errors
///
/// An I/O error of binding, or `InvalidInput` for an address that is not
/// loopback.
pub async fn start(cfg: ServerConfig) -> std::io::Result<RunningServer> {
    start_with(cfg, Extras::default()).await
}

/// What a hub may have besides the data routes.
#[derive(Default)]
pub struct Extras {
    /// The list of vaults the page may choose from.
    pub vaults: Option<Arc<dyn VaultAdmin>>,
    /// How a task file is shown in Neovim.
    pub opener: Option<Arc<dyn FileOpener>>,
}

/// Bind and serve, with a list of vaults the page may choose from.
///
/// # Errors
///
/// As [`start`].
pub async fn start_with(cfg: ServerConfig, extras: Extras) -> std::io::Result<RunningServer> {
    let Extras { vaults, opener } = extras;
    if !cfg.addr.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the server binds loopback addresses only",
        ));
    }
    let listener = TcpListener::bind(cfg.addr).await?;
    let addr = listener.local_addr()?;
    let instance = cfg.instance.to_hex();
    let limits = cfg.limits.clone();
    let (vault, refresh) = match cfg.watch {
        Some(w) => (Some(w.vault), w.refresh),
        None => (None, RefreshOptions::default()),
    };
    let parts = AppParts {
        classes: cfg.policy,
        opener,
    };
    let runtime = build_runtime(
        cfg.engine,
        cfg.status,
        vault,
        limits.snapshot_max_age,
        refresh.clone(),
        &parts,
    );
    let max_age = limits.snapshot_max_age;
    let build: BuildRuntime<VaultRuntime> = Arc::new(move |target: VaultTarget| {
        build_runtime(
            target.engine,
            target.status,
            target.vault,
            max_age,
            refresh.clone(),
            &parts,
        )
    });
    let shared = Arc::new(Shared {
        policy: HostPolicy::loopback(addr.port()),
        pairing: PairingStore::new(Arc::clone(&cfg.clock), cfg.pairing_ttl),
        sessions: SessionStore::new(limits.max_sessions),
        control: cfg.control_secret,
        post_limit: RateLimiter::new(Arc::clone(&cfg.clock), limits.post_max, limits.post_window),
        ops_limit: RateLimiter::new(Arc::clone(&cfg.clock), limits.ops_max, limits.ops_window),
        exchange_limit: RateLimiter::new(cfg.clock, limits.exchange_max, limits.exchange_window),
        limits: limits.clone(),
        instance: instance.clone(),
        guard_rules: guard_rules(),
        streams: Arc::new(StreamCounter::default()),
        ui: cfg.ui,
        usage: cfg.usage,
        runtime: StdRwLock::new(Arc::new(runtime)),
        build,
        vaults,
        switching: tokio::sync::Mutex::new(()),
    });

    let app = router(Arc::clone(&shared));
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(accept_loop(listener, app, limits, stop_rx));
    Ok(RunningServer {
        addr,
        instance,
        stop,
        task,
        shared,
    })
}

fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/", get(shell))
        .route("/index.html", get(shell))
        .route("/assets/{name}", get(shell))
        .route("/api/tasks/hello", get(hello))
        .route("/api/tasks/snapshot", get(snapshot))
        .route("/api/tasks/task", get(task))
        .route("/api/tasks/next", get(next))
        .route("/api/tasks/areas", get(areas))
        .route("/api/tasks/events", get(events))
        .route("/api/tasks/search", get(search_route))
        .route("/api/tasks/rescan", post(rescan))
        .route("/api/tasks/done_preview", get(done_preview))
        .route("/api/tasks/finished", get(finished))
        .route("/api/tasks/links", get(links))
        .route("/api/tasks/plan_for", get(plan_for))
        .route("/api/tasks/check", get(check_state))
        .route(
            "/api/tasks/check",
            post(check_start).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .route("/api/tasks/ops", post(ops))
        .route("/api/tasks/estimate", post(estimate))
        .route(
            "/api/tasks/open",
            post(open_file).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .route("/api/vaults", get(vaults_list))
        .route(
            "/api/vaults/add",
            post(vaults_add).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .route(
            "/api/vaults/remove",
            post(vaults_remove).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .route(
            "/api/vaults/select",
            post(vaults_select).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .route(
            "/auth/exchange",
            post(exchange).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .route(
            "/api/control/pair",
            post(control_pair).layer(DefaultBodyLimit::max(shared.limits.small_body_bytes)),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(shared.limits.max_body_bytes))
        .layer(middleware::from_fn_with_state(Arc::clone(&shared), guard))
        .with_state(shared)
}

async fn accept_loop(
    listener: TcpListener,
    app: Router,
    limits: Limits,
    mut stop: watch::Receiver<bool>,
) {
    let slots = Arc::new(Semaphore::new(limits.max_connections));
    loop {
        let (stream, _peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                // A failed accept (a reset while queued, or no file
                // handle left) is not the end; do not spin on it either.
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
            _ = stop.changed() => break,
        };
        // Over the limit the connection is closed at once, unread.
        let Ok(slot) = Arc::clone(&slots).try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let _ = stream.set_nodelay(true);
        let service = TowerToHyperService::new(app.clone());
        let mut conn_stop = stop.clone();
        let head_bytes = limits.max_head_bytes.max(8 * 1024);
        let header_timeout = limits.header_timeout;
        tokio::spawn(async move {
            let _slot = slot;
            let conn = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(header_timeout)
                .max_buf_size(head_bytes)
                .keep_alive(true)
                .serve_connection(TokioIo::new(stream), service);
            tokio::pin!(conn);
            tokio::select! {
                _ = conn.as_mut() => {}
                _ = conn_stop.changed() => {
                    conn.as_mut().graceful_shutdown();
                    let _ = tokio::time::timeout(Duration::from_secs(5), conn).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids_are_two_plain_names() {
        for good in [
            "lib.nvim/alpha",
            "wkdbook-tasks.nvim/tasks-app-p2",
            "ALL/x_y.z",
        ] {
            assert!(valid_task_id(good), "{good}");
        }
        for bad in [
            "", "a", "a/", "/b", "a/b/c", "../b", "a/..", "a/.b", ".a/b", "a b/c", "a/b c",
            "a\\b/c", "a/b?c", "a/b%2e", "a/b\n",
        ] {
            assert!(!valid_task_id(bad), "{bad:?}");
        }
        assert!(!valid_task_id(&format!("a/{}", "b".repeat(129))));
    }

    #[test]
    fn a_query_is_plain_or_refused() {
        let ok = parse_query(Some("id=lib.nvim/alpha&n=2"), &["id", "n"]).unwrap();
        assert_eq!(ok.get("id").map(String::as_str), Some("lib.nvim/alpha"));
        assert!(parse_query(None, &["id"]).unwrap().is_empty());
        assert!(parse_query(Some(""), &["id"]).unwrap().is_empty());
        for bad in [
            "id",
            "id=",
            "x=1",
            "id=a&id=b",
            "id=a%20b",
            "id=a+b",
            "id=a b",
            "id=a;b",
        ] {
            assert!(parse_query(Some(bad), &["id"]).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn if_none_match_is_read_the_way_http_says() {
        let tag = "sha256:00aa";
        assert!(etag_matches("\"sha256:00aa\"", tag));
        assert!(etag_matches("W/\"sha256:00aa\"", tag));
        assert!(etag_matches("*", tag));
        assert!(etag_matches("\"x\" , \"sha256:00aa\"", tag));
        assert!(!etag_matches("sha256:00aa", tag));
        assert!(!etag_matches("\"sha256:00ab\"", tag));
        assert!(!etag_matches("", tag));
    }

    #[tokio::test]
    async fn a_refusal_is_cut_to_a_word_and_a_line() {
        use crate::engine::EngineRefusal;
        let refusal = EngineRefusal {
            code: "../../etc".to_owned(),
            message: format!("line one\nline two\u{1b}[31m{}", "x".repeat(10_000)),
            retryable: true,
            text: String::new(),
        };
        let response = engine_failure(EngineError::Refused(refusal));
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let doc: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(doc["error"]["code"], "engine_failed");
        let message = doc["error"]["message"].as_str().unwrap();
        assert!(message.chars().count() <= 512, "{}", message.len());
        assert!(!message.contains(|c: char| c.is_control()));
        assert_eq!(doc["error"]["retryable"], true);
    }

    /// An engine that answers `tasks.check` after a moment, and counts the questions.
    struct SlowCheck(std::sync::atomic::AtomicUsize);

    impl Engine for SlowCheck {
        fn call<'a>(
            &'a self,
            _method: EngineMethod,
            _params: Option<&'a serde_json::Value>,
        ) -> crate::engine::CallFuture<'a> {
            Box::pin(async move {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(150)).await;
                Ok(crate::engine::Reply {
                    kind: "tasks.check".to_owned(),
                    text: r#"{"kind":"tasks.check","findings":[]}"#.to_owned(),
                })
            })
        }
    }

    fn bare_runtime() -> Arc<VaultRuntime> {
        let status = HubStatus {
            engine_ready: true,
            problem: None,
            capabilities: Vec::new(),
        };
        Arc::new(build_runtime(
            None,
            status,
            None,
            None,
            RefreshOptions::default(),
            &AppParts {
                classes: Arc::new(AreaPolicy::default()),
                opener: None,
            },
        ))
    }

    #[tokio::test]
    async fn a_check_is_started_once_and_ends_with_the_engine_s_document() {
        let rt = bare_runtime();
        let engine = Arc::new(SlowCheck(std::sync::atomic::AtomicUsize::new(0)));
        let first = start_check_job(&rt, engine.clone(), serde_json::Map::new()).unwrap();
        assert_eq!(first["job"]["state"], "running");
        // A second start answers the job that runs and asks the engine nothing more.
        let again = start_check_job(&rt, engine.clone(), serde_json::Map::new()).unwrap();
        assert_eq!(again["job"]["id"], first["job"]["id"]);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let state = rt.check.lock().unwrap().to_json();
        assert_eq!(state["job"]["state"], "done", "{state}");
        assert_eq!(state["job"]["result"]["kind"], "tasks.check");
        assert_eq!(engine.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn no_check_is_started_in_a_runtime_that_was_retired() {
        let rt = bare_runtime();
        let engine = Arc::new(SlowCheck(std::sync::atomic::AtomicUsize::new(0)));
        // Another vault was chosen: the old runtime is stopped ...
        rt.stop();
        // ... and a start that was on its way (it took the runtime before the swap) is refused.
        let refused = start_check_job(&rt, engine.clone(), serde_json::Map::new());
        assert_eq!(refused.unwrap_err(), CheckStart::Retired);
        assert_eq!(rt.check.lock().unwrap().to_json()["job"]["state"], "idle");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            engine.0.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no process was asked"
        );
    }

    #[tokio::test]
    async fn a_check_that_is_running_when_the_runtime_is_stopped_is_stopped_with_it() {
        let rt = bare_runtime();
        let engine = Arc::new(SlowCheck(std::sync::atomic::AtomicUsize::new(0)));
        start_check_job(&rt, engine, serde_json::Map::new()).unwrap();
        rt.stop();
        tokio::time::sleep(Duration::from_millis(400)).await;
        // The job was aborted before it set its end: the state is still the running one of the retired runtime,
        // which nobody reads any more.
        assert_eq!(
            rt.check.lock().unwrap().to_json()["job"]["state"],
            "running"
        );
    }

    fn change(seq: u64) -> Arc<store::Change> {
        Arc::new(store::Change {
            seq,
            rev: None,
            cause: "fs",
            changed: Vec::new(),
            added: Vec::new(),
            removed: Vec::new(),
            truncated: false,
        })
    }

    const FAST: AutoCheckTiming = AutoCheckTiming {
        quiet: Duration::from_millis(100),
        gap: Duration::from_millis(600),
        poll: Duration::from_millis(20),
    };

    /// A follower on a channel of its own; `listening` and the switch of the runtime are the ones given.
    fn follower(
        listening: bool,
        auto: bool,
    ) -> (
        Arc<VaultRuntime>,
        Arc<SlowCheck>,
        broadcast::Sender<Arc<store::Change>>,
        JoinHandle<()>,
    ) {
        let rt = bare_runtime();
        rt.auto_check
            .store(auto, std::sync::atomic::Ordering::SeqCst);
        let engine = Arc::new(SlowCheck(std::sync::atomic::AtomicUsize::new(0)));
        let (tx, rx) = broadcast::channel(16);
        let handle = tokio::spawn(follow_changes(
            Arc::downgrade(&rt),
            engine.clone(),
            rx,
            FAST,
            move || listening,
        ));
        (rt, engine, tx, handle)
    }

    fn asked(engine: &SlowCheck) -> usize {
        engine.0.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[tokio::test]
    async fn the_check_runs_again_once_after_a_burst_of_changes_has_gone_quiet() {
        let (rt, engine, tx, _handle) = follower(true, true);
        for seq in 1..=5 {
            tx.send(change(seq)).unwrap();
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        // Still inside the quiet time of the last change: nothing yet.
        assert_eq!(asked(&engine), 0);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(asked(&engine), 1, "one check for the whole burst");
        assert_eq!(rt.check.lock().unwrap().to_json()["job"]["state"], "done");
    }

    #[tokio::test]
    async fn two_starts_are_at_least_a_gap_apart_however_the_vault_changes() {
        let (_rt, engine, tx, _handle) = follower(true, true);
        tx.send(change(1)).unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(asked(&engine), 1);
        // A change right after: its quiet time passes, the gap (600 ms since the first start) has not.
        tx.send(change(2)).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(asked(&engine), 1, "the gap holds the second one back");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(asked(&engine), 2);
    }

    #[tokio::test]
    async fn no_check_runs_without_a_client_and_none_after_a_check_with_refs() {
        let (_rt, engine, tx, _handle) = follower(false, true);
        tx.send(change(1)).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(asked(&engine), 0, "nobody is listening");
        let (_rt, engine, tx, _handle) = follower(true, false);
        tx.send(change(1)).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(asked(&engine), 0, "the last check was one with refs");
    }

    #[tokio::test]
    async fn a_check_that_runs_is_not_joined_by_another_and_the_change_is_checked_after_it() {
        let (rt, engine, tx, _handle) = follower(true, true);
        start_check_job(&rt, engine.clone(), serde_json::Map::new()).unwrap();
        tx.send(change(1)).unwrap();
        // Quiet and gap pass while the first still runs? The gap holds it back past its end (150 ms): it then starts one.
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(asked(&engine), 2);
    }

    /// An engine that keeps what it was asked.
    struct Recording(StdMutex<Vec<Option<serde_json::Value>>>);

    impl Engine for Recording {
        fn call<'a>(
            &'a self,
            _method: EngineMethod,
            params: Option<&'a serde_json::Value>,
        ) -> crate::engine::CallFuture<'a> {
            Box::pin(async move {
                self.0.lock().unwrap().push(params.cloned());
                Ok(crate::engine::Reply {
                    kind: "tasks.check".to_owned(),
                    text: r#"{"kind":"tasks.check","findings":[]}"#.to_owned(),
                })
            })
        }
    }

    #[tokio::test]
    async fn the_check_of_the_hub_asks_for_the_area_the_person_asked_for() {
        let rt = bare_runtime();
        rt.auto_check
            .store(true, std::sync::atomic::Ordering::SeqCst);
        rt.check_params
            .lock()
            .unwrap()
            .insert("area".to_owned(), serde_json::json!("lib.nvim"));
        let engine = Arc::new(Recording(StdMutex::new(Vec::new())));
        let (tx, rx) = broadcast::channel(16);
        let _handle = tokio::spawn(follow_changes(
            Arc::downgrade(&rt),
            engine.clone(),
            rx,
            FAST,
            || true,
        ));
        tx.send(change(1)).unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let asked = engine.0.lock().unwrap().clone();
        assert_eq!(asked, vec![Some(serde_json::json!({ "area": "lib.nvim" }))]);
    }

    #[tokio::test]
    async fn the_follower_ends_with_the_runtime() {
        let (rt, _engine, tx, handle) = follower(true, true);
        rt.stop();
        drop(rt);
        let _ = tx.send(change(1));
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("the follower ended")
            .unwrap();
    }

    #[test]
    fn a_failed_check_says_one_sentence_without_hidden_characters_or_paths() {
        use crate::engine::EngineRefusal;
        let refused = EngineError::Refused(EngineRefusal {
            code: "invalid_argument".to_owned(),
            message: format!("unknown area{}x{}y\u{202e}z", '\u{200b}', '\u{7}'),
            retryable: false,
            text: String::new(),
        });
        let (code, message) = check_failure(&refused);
        assert_eq!(code, "engine_refused");
        assert_eq!(message, "unknown areaxyz");
        // A process that failed holds paths in its error output: the page gets a fixed sentence.
        let failed = EngineError::Failed {
            code: Some(1),
            detail: "E:/repos/secret/vault exploded".to_owned(),
        };
        let (code, message) = check_failure(&failed);
        assert_eq!(code, "engine_failed");
        assert!(!message.contains("secret"), "{message}");
    }

    #[test]
    fn engine_failures_become_the_right_status_and_tell_no_detail() {
        use crate::engine::EngineRefusal;
        let refusal = |code: &str| {
            EngineError::Refused(EngineRefusal {
                code: code.to_owned(),
                message: "m".to_owned(),
                retryable: false,
                text: String::new(),
            })
        };
        let cases = [
            (refusal("invalid_argument"), 400),
            (refusal("not_found"), 404),
            (refusal("conflict"), 409),
            (refusal("forbidden"), 403),
            (refusal("locked"), 503),
            (refusal("internal"), 502),
            (EngineError::Busy, 503),
            (EngineError::Timeout, 504),
            (EngineError::BadRequest("x".to_owned()), 400),
            (EngineError::OutcomeUnknown("x".to_owned()), 502),
            (
                EngineError::Failed {
                    code: Some(1),
                    detail: "C:\\Users\\someone\\secret".to_owned(),
                },
                502,
            ),
            (EngineError::Spawn("C:\\x".to_owned()), 502),
            (EngineError::Protocol("x".to_owned()), 502),
        ];
        for (error, status) in cases {
            let shown = error.to_string();
            let r = engine_failure(error);
            assert_eq!(r.status().as_u16(), status, "{shown}");
        }
        assert_eq!(
            engine_failure(EngineError::Busy)
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
            Some("1")
        );
    }

    /// A runtime that is not the tasks hub's: the core must serve and swap it all the same.
    struct OtherRuntime {
        status: HubStatus,
        stopped: std::sync::atomic::AtomicBool,
    }

    impl OtherRuntime {
        fn new(status: HubStatus) -> Self {
            Self {
                status,
                stopped: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    impl Runtime for OtherRuntime {
        fn status(&self) -> &HubStatus {
            &self.status
        }

        fn stop(&self) {
            self.stopped
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct TwoVaults;

    impl VaultAdmin for TwoVaults {
        fn list(&self) -> VaultList {
            VaultList {
                active: "a".to_owned(),
                vaults: Vec::new(),
            }
        }
        fn add<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { Err("no".to_owned()) })
        }
        fn remove<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { Err("no".to_owned()) })
        }
        fn select<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<VaultTarget, String>> {
            Box::pin(async {
                Ok(VaultTarget {
                    engine: None,
                    status: HubStatus {
                        engine_ready: true,
                        problem: None,
                        capabilities: vec!["second".to_owned()],
                    },
                    vault: None,
                })
            })
        }
    }

    fn core_with(first: &Arc<OtherRuntime>) -> Arc<Core<OtherRuntime>> {
        use app_core::authn::{Secret, SystemClock, CODE_BYTES, TOKEN_BYTES};
        let clock: Arc<dyn app_core::authn::Clock> = Arc::new(SystemClock::new());
        let limits = Limits::default();
        let ttl = Duration::from_secs(60);
        Arc::new(Core {
            policy: HostPolicy::loopback(1),
            pairing: PairingStore::new(Arc::clone(&clock), ttl),
            sessions: SessionStore::new(4),
            control: Secret::generate(TOKEN_BYTES).unwrap(),
            post_limit: RateLimiter::new(Arc::clone(&clock), 10, ttl),
            ops_limit: RateLimiter::new(Arc::clone(&clock), 10, ttl),
            exchange_limit: RateLimiter::new(clock, 10, ttl),
            limits,
            instance: Secret::generate(CODE_BYTES).unwrap().to_hex(),
            guard_rules: GuardRules::new("/api/other/hello", []),
            streams: Arc::new(StreamCounter::default()),
            ui: UiFiles::none(),
            usage: None,
            runtime: StdRwLock::new(Arc::clone(first)),
            build: Arc::new(|target: VaultTarget| OtherRuntime::new(target.status)),
            vaults: Some(Arc::new(TwoVaults)),
            switching: tokio::sync::Mutex::new(()),
        })
    }

    async fn json_of(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn the_core_says_hello_for_and_swaps_a_runtime_that_is_not_ours() {
        let first = Arc::new(OtherRuntime::new(HubStatus {
            engine_ready: false,
            problem: Some("engine_unreachable"),
            capabilities: Vec::new(),
        }));
        let core = core_with(&first);

        let before = json_of(hello(State(Arc::clone(&core))).await).await;
        assert_eq!(before["engine"]["ready"], false);
        assert_eq!(before["engine"]["problem"], "engine_unreachable");

        let done = vaults_select(
            State(Arc::clone(&core)),
            Bytes::from_static(br#"{"name":"b"}"#),
        )
        .await;
        assert_eq!(done.status(), StatusCode::OK);
        // The old runtime was stopped, and the one the app's callback made is read now.
        assert!(first.stopped.load(std::sync::atomic::Ordering::SeqCst));
        let after = json_of(hello(State(core)).await).await;
        assert_eq!(after["engine"]["ready"], true);
        assert_eq!(after["engine"]["capabilities"][0], "second");
    }
}
