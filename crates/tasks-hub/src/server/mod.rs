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
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll};
use std::time::Duration;

use app_core::authn::{Clock, Secret};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, RawQuery, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_core::Stream;
use serde_json::json;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use hub_kit::{
    bearer, error_body, etag_matches, json_response, no_query, not_modified, parse_query, single,
    too_many, vault_request, vault_text, BuildRuntime, ServeParts,
};

use crate::classes::{AreaPolicy, Shown};
use crate::editor::FileOpener;
use crate::engine::{Calls, Engine, EngineError, Method};
use crate::search::{self, SearchIndex};
use crate::store::{self, RefreshOptions, SnapshotStore, StoreOptions};
use crate::ui::UiFiles;
use crate::usage::UsageLog;
use crate::watch::{self as fswatch, Hint};

mod answer;
mod check;
mod events;
mod routes;
mod runtime;
mod settings;
mod vaults;

pub use self::settings::{ServerConfig, WatchConfig};
pub use self::vaults::VaultTarget;
pub use hub_kit::{
    BoxFuture, GuardRules, HubStatus, Limits, RunningServer, Runtime, VaultAdmin, VaultInfo,
    VaultList,
};

use self::answer::*;
use self::check::*;
use self::events::*;
use self::routes::*;
use self::runtime::*;

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

/// The core of the hub with the runtime of this app.
type Shared = hub_kit::Core<VaultRuntime>;

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
    pub vaults: Option<Arc<dyn VaultAdmin<VaultTarget>>>,
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
    let (vault, refresh) = match cfg.watch {
        Some(w) => (Some(w.vault), w.refresh),
        None => (None, RefreshOptions::default()),
    };
    let parts = AppParts {
        classes: cfg.policy,
        opener,
        usage: cfg.usage,
        streams: Arc::new(StreamCounter::default()),
    };
    let max_age = cfg.limits.snapshot_max_age;
    let runtime = build_runtime(
        cfg.engine,
        cfg.status,
        vault,
        max_age,
        refresh.clone(),
        &parts,
    );
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
    hub_kit::serve(
        ServeParts {
            addr: cfg.addr,
            limits: cfg.limits,
            clock: cfg.clock,
            pairing_ttl: cfg.pairing_ttl,
            control_secret: cfg.control_secret,
            instance: cfg.instance,
            app: APP_NAME,
            version: crate::VERSION,
            guard_rules: guard_rules(),
            ui: Arc::new(cfg.ui),
            runtime,
            build,
            vaults,
        },
        app_routes,
    )
    .await
}

/// The routes of this app, under `/api/tasks/`. The page, `hello`, the pairing and the list of
/// vaults are the core's; the guard is in front of both.
fn app_routes(core: &Arc<Shared>) -> Router<Arc<Shared>> {
    let small = core.limits.small_body_bytes;
    let r = |name: &str| crate::IDENTITY.route(name);
    Router::new()
        .route(&r("snapshot"), get(snapshot))
        .route(&r("task"), get(task))
        .route(&r("next"), get(next))
        .route(&r("areas"), get(areas))
        .route(&r("events"), get(events))
        .route(&r("search"), get(search_route))
        .route(&r("rescan"), post(rescan))
        .route(&r("done_preview"), get(done_preview))
        .route(&r("finished"), get(finished))
        .route(&r("links"), get(links))
        .route(&r("plan_for"), get(plan_for))
        .route(&r("check"), get(check_state))
        .route(
            &r("check"),
            post(check_start).layer(DefaultBodyLimit::max(small)),
        )
        .route(&r("ops"), post(ops))
        .route(&r("estimate"), post(estimate))
        .route(
            &r("open"),
            post(open_file).layer(DefaultBodyLimit::max(small)),
        )
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
            _method: Method,
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
                usage: None,
                streams: Arc::new(StreamCounter::default()),
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
            _method: Method,
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
}
