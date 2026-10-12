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
//! 6. the rate limit for mutations;
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
use crate::engine::{Engine, EngineError, Method as EngineMethod};
use crate::search::{self, SearchIndex};
use crate::store::{self, RefreshOptions, SnapshotStore, StoreOptions};
use crate::ui::UiFiles;
use crate::usage::UsageLog;
use crate::watch::{self as fswatch, Hint};

/// The name the hub gives itself in `hello` and in `hub.json`.
pub const APP_NAME: &str = "tasks-desktop";

/// The default port. It is part of the origin, so it is fixed (concept 3.3);
/// below the ephemeral ranges of Windows (49152) and Linux (32768).
pub const DEFAULT_PORT: u16 = 17615;

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
}

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

struct Shared {
    policy: HostPolicy,
    pairing: PairingStore,
    sessions: SessionStore,
    control: Secret,
    post_limit: RateLimiter,
    exchange_limit: RateLimiter,
    limits: Limits,
    instance: String,
    status: HubStatus,
    engine: Option<Arc<dyn Engine>>,
    classes: Arc<AreaPolicy>,
    store: Arc<SnapshotStore>,
    streams: Arc<StreamCounter>,
    ui: UiFiles,
    usage: Option<Arc<UsageLog>>,
    search: Option<Arc<SearchIndex>>,
    details: StdMutex<Details>,
}

/// The most task documents kept.
const DETAILS_KEPT: usize = 64;

/// The documents of `task` the hub has answered for one state of the vault.
/// A document holds the blockers in both directions, so it is true for the
/// `rev` it was made for and for no other: a change of the vault empties
/// the whole table.
#[derive(Default)]
struct Details {
    rev: Option<String>,
    docs: HashMap<String, Bytes>,
    order: std::collections::VecDeque<String>,
}

impl Details {
    fn get(&mut self, rev: &str, id: &str) -> Option<Bytes> {
        if self.rev.as_deref() != Some(rev) {
            return None;
        }
        self.docs.get(id).cloned()
    }

    fn put(&mut self, rev: &str, id: &str, doc: Bytes) {
        if self.rev.as_deref() != Some(rev) {
            self.rev = Some(rev.to_owned());
            self.docs.clear();
            self.order.clear();
        }
        if self.docs.insert(id.to_owned(), doc).is_none() {
            self.order.push_back(id.to_owned());
            while self.order.len() > DETAILS_KEPT {
                if let Some(old) = self.order.pop_front() {
                    self.docs.remove(&old);
                }
            }
        }
    }
}

/// A started server.
pub struct RunningServer {
    addr: SocketAddr,
    instance: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
    refresher: Option<JoinHandle<()>>,
    indexer: Option<JoinHandle<()>>,
    // Kept alive: the refresher ends when every sender of hints is gone, and
    // the timer must keep running even if the file watcher could not start.
    _hints: Option<mpsc::UnboundedSender<Hint>>,
    _watcher: Option<fswatch::Watcher>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(r) = &self.refresher {
            r.abort();
        }
        if let Some(i) = &self.indexer {
            i.abort();
        }
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
        if let Some(r) = self.refresher.take() {
            r.abort();
        }
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
    let store = SnapshotStore::new(
        cfg.engine.clone(),
        StoreOptions {
            max_age: limits.snapshot_max_age,
            ..StoreOptions::default()
        },
    );
    // The text of the tasks, for the search: kept by the hub, read by the engine.
    let search = cfg.engine.clone().map(SearchIndex::new);
    let indexer = search
        .as_ref()
        .map(|index| search::spawn_indexer(Arc::clone(index), &store));
    let shared = Arc::new(Shared {
        policy: HostPolicy::loopback(addr.port()),
        pairing: PairingStore::new(Arc::clone(&cfg.clock), cfg.pairing_ttl),
        sessions: SessionStore::new(limits.max_sessions),
        control: cfg.control_secret,
        post_limit: RateLimiter::new(Arc::clone(&cfg.clock), limits.post_max, limits.post_window),
        exchange_limit: RateLimiter::new(cfg.clock, limits.exchange_max, limits.exchange_window),
        limits: limits.clone(),
        instance: instance.clone(),
        status: cfg.status,
        engine: cfg.engine.clone(),
        classes: cfg.policy,
        store: Arc::clone(&store),
        streams: Arc::new(StreamCounter::default()),
        ui: cfg.ui,
        usage: cfg.usage,
        search: search.clone(),
        details: StdMutex::new(Details::default()),
    });

    // The watcher only says "look again"; the refresher does the looking.
    let (mut hints, mut watcher, mut refresher) = (None, None, None);
    if let Some(w) = cfg.watch {
        let (tx, rx) = mpsc::unbounded_channel();
        match fswatch::start(&w.vault, tx.clone()) {
            Ok(started) => watcher = Some(started),
            // Not fatal: the timer and the rescan request still work.
            Err(e) => {
                eprintln!("note: the vault cannot be watched ({e}); scanning on a timer only")
            }
        }
        refresher = Some(store::spawn_refresher(Arc::clone(&store), rx, w.refresh));
        hints = Some(tx);
    }

    let app = router(shared);
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(accept_loop(listener, app, limits, stop_rx));
    Ok(RunningServer {
        addr,
        instance,
        stop,
        task,
        refresher,
        indexer,
        _hints: hints,
        _watcher: watcher,
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

// ── the guard ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    /// The static page of the app, no credential.
    Shell,
    /// `hello`: version and abilities, no credential and no data.
    Hello,
    /// Pairing code for a session token.
    Exchange,
    /// Mints a pairing code, for a local program with the control secret.
    ControlPair,
    /// Everything else under `/api/`: a session is needed.
    Api,
    /// Not ours.
    Other,
}

fn classify(path: &str) -> Class {
    match path {
        "/" | "/index.html" => Class::Shell,
        p if p.starts_with("/assets/") => Class::Shell,
        "/api/tasks/hello" => Class::Hello,
        "/auth/exchange" => Class::Exchange,
        "/api/control/pair" => Class::ControlPair,
        p if p.starts_with("/api/") => Class::Api,
        _ => Class::Other,
    }
}

fn method_allowed(class: Class, method: &Method) -> bool {
    match class {
        Class::Shell | Class::Hello => method == Method::GET,
        Class::Exchange | Class::ControlPair => method == Method::POST,
        Class::Api => method == Method::GET || method == Method::POST,
        // The fallback answers 404 to anything.
        Class::Other => true,
    }
}

fn error_body(status: StatusCode, code: &str, message: &str) -> Response {
    let body = json!({ "error": { "code": code, "message": message } });
    (status, axum::Json(body)).into_response()
}

/// A header that must be there at most once and be plain ASCII.
fn single(headers: &HeaderMap, name: &HeaderName) -> Result<Option<String>, ()> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    first.to_str().map(|s| Some(s.to_owned())).map_err(|_| ())
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = single(headers, &header::AUTHORIZATION).ok()??;
    value.strip_prefix("Bearer ").map(str::to_owned)
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    let Ok(Some(value)) = single(headers, &header::CONTENT_TYPE) else {
        return false;
    };
    let value = value.to_ascii_lowercase();
    let mut parts = value.split(';').map(str::trim);
    if parts.next() != Some("application/json") {
        return false;
    }
    parts.all(|p| p == "charset=utf-8")
}

static SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");

async fn guard(State(st): State<Arc<Shared>>, req: Request, next: Next) -> Response {
    let class = classify(req.uri().path());
    let mut response = judge(&st, class, req, next).await;
    set_security_headers(&mut response, class);
    response
}

async fn judge(st: &Shared, class: Class, req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    let headers = &parts.headers;

    // 1. Host
    match single(headers, &header::HOST) {
        Ok(Some(host)) if st.policy.host_ok(&host) => {}
        Ok(_) => return error_body(StatusCode::FORBIDDEN, "bad_host", "unknown host"),
        Err(()) => return error_body(StatusCode::BAD_REQUEST, "bad_header", "invalid Host header"),
    }

    let mutation = parts.method != Method::GET;

    // 2. Declared body size
    // (No header at all is fine: a GET, or a chunked body that the body
    // limit of the extractor bounds while it is read.)
    let body_limit = match class {
        Class::Exchange | Class::ControlPair => st.limits.small_body_bytes,
        _ => st.limits.max_body_bytes,
    };
    match single(headers, &header::CONTENT_LENGTH) {
        Ok(None) => {}
        Ok(Some(len)) => match len.parse::<usize>() {
            Ok(n) if n <= body_limit => {}
            Ok(_) => {
                let mut r =
                    error_body(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "body too large");
                r.headers_mut()
                    .insert(header::CONNECTION, HeaderValue::from_static("close"));
                return r;
            }
            Err(_) => {
                return error_body(
                    StatusCode::BAD_REQUEST,
                    "bad_header",
                    "invalid Content-Length",
                );
            }
        },
        Err(()) => {
            return error_body(
                StatusCode::BAD_REQUEST,
                "bad_header",
                "invalid Content-Length",
            );
        }
    }

    // 3. Origin and Fetch Metadata
    let origin = match single(headers, &header::ORIGIN) {
        Ok(o) => o,
        Err(()) => {
            return error_body(
                StatusCode::BAD_REQUEST,
                "bad_header",
                "invalid Origin header",
            )
        }
    };
    if origin.as_deref().is_some_and(|o| !st.policy.origin_ok(o)) {
        return error_body(StatusCode::FORBIDDEN, "bad_origin", "unknown origin");
    }
    let fetch_site = match single(headers, &SEC_FETCH_SITE) {
        Ok(v) => v,
        Err(()) => {
            return error_body(
                StatusCode::BAD_REQUEST,
                "bad_header",
                "invalid Sec-Fetch-Site header",
            );
        }
    };
    if !fetch_site_ok(fetch_site.as_deref()) {
        return error_body(
            StatusCode::FORBIDDEN,
            "bad_fetch_site",
            "cross-site request",
        );
    }

    // 4. Method (after Origin: a foreign origin is told so whatever it tried)
    if !method_allowed(class, &parts.method) {
        return error_body(
            StatusCode::METHOD_NOT_ALLOWED,
            "bad_method",
            "method not allowed",
        );
    }

    // What is not one of our routes ends here, so that a route which is
    // later added to the router outside `/api/` cannot be open by accident.
    if class == Class::Other {
        return error_body(StatusCode::NOT_FOUND, "not_found", "no such route");
    }

    // 5. A mutation without an Origin is a program client, never a browser.
    if mutation && origin.is_none() && (fetch_site.is_some() || class == Class::Exchange) {
        return error_body(
            StatusCode::FORBIDDEN,
            "origin_required",
            "an Origin is required",
        );
    }

    // 6. Rate limit for mutations
    if mutation && !st.post_limit.allow() {
        return error_body(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many requests",
        );
    }

    // 7. The credential the route needs
    match class {
        Class::Shell | Class::Hello | Class::Exchange | Class::Other => {}
        Class::ControlPair => {
            let ok = bearer(headers)
                .and_then(|t| Secret::from_hex(&t, TOKEN_BYTES))
                .is_some_and(|t| t.matches(&st.control));
            if !ok {
                return error_body(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "credential required",
                );
            }
        }
        Class::Api => {
            let ok = bearer(headers).is_some_and(|t| st.sessions.check(&t));
            if !ok {
                return error_body(StatusCode::UNAUTHORIZED, "unauthorized", "session required");
            }
        }
    }

    // 8. A mutation carries JSON
    if mutation && !is_json_content_type(headers) {
        return error_body(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "bad_content_type",
            "application/json required",
        );
    }

    let req = Request::from_parts(parts, body);
    match tokio::time::timeout(st.limits.request_timeout, next.run(req)).await {
        Ok(response) => response,
        Err(_) => error_body(
            StatusCode::REQUEST_TIMEOUT,
            "timeout",
            "the request took too long",
        ),
    }
}

fn set_security_headers(response: &mut Response, class: Class) {
    let h = response.headers_mut();
    h.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    if class == Class::Shell {
        // Nothing is allowed that the page does not name. Scripts and styles
        // come from this origin only (no inline), and a sink that takes a
        // string as HTML or script (`innerHTML`, `eval`) is refused unless
        // the one policy of the page made it: Svelte's own, which wraps
        // nothing a task's text could reach (the body is drawn as elements).
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'none'; script-src 'self'; style-src 'self'; \
                 img-src 'self'; connect-src 'self'; base-uri 'none'; \
                 object-src 'none'; frame-ancestors 'none'; form-action 'none'; \
                 require-trusted-types-for 'script'; trusted-types svelte-trusted-html",
            ),
        );
        h.insert(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        );
        h.insert(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static(
                "camera=(), microphone=(), geolocation=(), payment=(), usb=(), \
                 clipboard-read=(), clipboard-write=()",
            ),
        );
    }
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn shell(State(st): State<Arc<Shared>>, uri: axum::http::Uri) -> Response {
    if let Some(file) = st.ui.get(uri.path()) {
        return (
            [(header::CONTENT_TYPE, file.content_type)],
            Body::from(file.bytes.clone()),
        )
            .into_response();
    }
    // Under /assets/ only what the build holds; the page itself is the
    // placeholder until an interface is there.
    if uri.path().starts_with("/assets/") || st.ui.has_index() {
        return error_body(StatusCode::NOT_FOUND, "not_found", "no such file");
    }
    let html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>tasks-desktop</title></head><body><p>tasks-desktop hub is running. The interface is not built yet.</p></body></html>";
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        Body::from(html),
    )
        .into_response()
}

async fn hello(State(st): State<Arc<Shared>>) -> Response {
    // Version and abilities only: no task, no area, no path, no vault name.
    let body = json!({
        "schema": 1,
        "kind": "hub.hello",
        "app": APP_NAME,
        "version": crate::VERSION,
        "instance": st.instance,
        "engine": { "ready": st.status.engine_ready, "problem": st.status.problem },
        "capabilities": ["pairing"],
    });
    axum::Json(body).into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeRequest {
    code: String,
}

async fn exchange(State(st): State<Arc<Shared>>, body: Bytes) -> Response {
    if !st.exchange_limit.allow() {
        return error_body(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many attempts",
        );
    }
    let Ok(request) = serde_json::from_slice::<ExchangeRequest>(&body) else {
        return error_body(StatusCode::BAD_REQUEST, "bad_body", "invalid request body");
    };
    // The same answer for an unknown, a spent and an expired code.
    if !st.pairing.redeem(&request.code) {
        return error_body(
            StatusCode::UNAUTHORIZED,
            "bad_code",
            "the code is not valid",
        );
    }
    match st.sessions.create() {
        Ok(token) => axum::Json(json!({ "token": token.to_hex() })).into_response(),
        Err(_) => error_body(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "no session could be made",
        ),
    }
}

async fn control_pair(State(st): State<Arc<Shared>>) -> Response {
    match st.pairing.mint() {
        Ok(code) => {
            debug_assert_eq!(code.to_hex().len(), CODE_BYTES * 2);
            axum::Json(json!({ "code": code.to_hex() })).into_response()
        }
        Err(_) => error_body(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "no code could be made",
        ),
    }
}

// ── data routes ─────────────────────────────────────────────────────────────
//
// Each of these is under `/api/`, so the guard has asked for a session
// before the handler runs. The documents of the engine are passed on as the
// engine wrote them; the hub adds only the class of an area (`hub.areas`).

/// Does an `If-None-Match` header name this ETag (or `*`)?
fn etag_matches(header: &str, etag: &str) -> bool {
    let quoted = format!("\"{etag}\"");
    header.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == quoted
    })
}

fn json_response(status: StatusCode, text: impl Into<Body>, etag: Option<&str>) -> Response {
    let body: Body = text.into();
    let mut response = (status, [(header::CONTENT_TYPE, "application/json")], body).into_response();
    if let Some(value) = etag.and_then(|e| HeaderValue::from_str(&format!("\"{e}\"")).ok()) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

fn not_modified(etag: &str) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NOT_MODIFIED;
    if let Ok(value) = HeaderValue::from_str(&format!("\"{etag}\"")) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

/// What a request without an engine gets: the hub is up, the engine is not.
fn engine_unavailable(st: &Shared) -> Response {
    let body = json!({ "error": {
        "code": "engine_unavailable",
        "message": "the engine is not ready",
        "problem": st.status.problem,
    }});
    (StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response()
}

/// Map what went wrong with a question to an answer. The engine's own
/// refusals keep their code and their message (the contract promises that
/// they hold no path of this machine); everything else is told in one word,
/// and the detail goes to the terminal of whoever runs the hub.
fn engine_failure(error: EngineError) -> Response {
    match error {
        EngineError::Refused(r) => {
            let status = match r.code.as_str() {
                "invalid_argument" | "unsupported_schema" => StatusCode::BAD_REQUEST,
                "not_found" => StatusCode::NOT_FOUND,
                "conflict" | "exists" => StatusCode::CONFLICT,
                "forbidden" => StatusCode::FORBIDDEN,
                "locked" => StatusCode::SERVICE_UNAVAILABLE,
                // The engine could not do its job: that is the server's side.
                _ => StatusCode::BAD_GATEWAY,
            };
            // The engine is trusted to hold no path, not to be short or
            // plain: a code is a lowercase word, a message is one short line.
            let code_ok = !r.code.is_empty()
                && r.code.len() <= 48
                && r.code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
            let code = if code_ok {
                r.code
            } else {
                "engine_failed".to_owned()
            };
            let message: String = r
                .message
                .chars()
                .filter(|c| !c.is_control())
                .take(512)
                .collect();
            let body = json!({ "error": {
                "code": code,
                "message": message,
                "retryable": r.retryable,
            }});
            (status, axum::Json(body)).into_response()
        }
        EngineError::BadRequest(message) => {
            error_body(StatusCode::BAD_REQUEST, "bad_request", &message)
        }
        EngineError::Busy => {
            let mut r = error_body(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "the engine is busy, try again",
            );
            r.headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            r
        }
        EngineError::Timeout => error_body(
            StatusCode::GATEWAY_TIMEOUT,
            "engine_timeout",
            "the engine did not answer in time",
        ),
        EngineError::OutcomeUnknown(_) => error_body(
            StatusCode::BAD_GATEWAY,
            "outcome_unknown",
            "the outcome is unknown, read again before you trust the state",
        ),
        other => {
            eprintln!("engine: {other}");
            error_body(
                StatusCode::BAD_GATEWAY,
                "engine_failed",
                "the engine could not answer",
            )
        }
    }
}

async fn ask(
    st: &Shared,
    method: EngineMethod,
    params: Option<&serde_json::Value>,
) -> Result<crate::engine::Reply, Response> {
    let Some(engine) = &st.engine else {
        return Err(engine_unavailable(st));
    };
    engine.call(method, params).await.map_err(engine_failure)
}

/// A route that takes no query says so, instead of ignoring one.
fn no_query(query: Option<&str>) -> Option<Response> {
    match query {
        None | Some("") => None,
        Some(_) => Some(error_body(
            StatusCode::BAD_REQUEST,
            "bad_query",
            "this route takes no query",
        )),
    }
}

async fn snapshot(
    State(st): State<Arc<Shared>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = no_query(query.as_deref()) {
        return response;
    }
    if !st.store.has_engine() {
        return engine_unavailable(&st);
    }
    let cached = match st.store.current().await {
        Ok(c) => c,
        Err(error) => return engine_failure(error),
    };
    if let Some(etag) = &cached.etag {
        let seen = single(&headers, &header::IF_NONE_MATCH).ok().flatten();
        if seen.is_some_and(|h| etag_matches(&h, etag)) {
            return not_modified(etag);
        }
    }
    json_response(StatusCode::OK, cached.text.clone(), cached.etag.as_deref())
}

/// The query of a request as pairs, refusing what is not plain: a key that
/// is not listed, a key twice, a value with anything but letters, digits,
/// `.`, `_`, `-` and `/` (no escapes: nothing here needs them; what a
/// value may be is for the handler of its parameter to say).
fn parse_query(
    query: Option<&str>,
    allowed: &[&str],
) -> Result<std::collections::HashMap<String, String>, &'static str> {
    let mut out = std::collections::HashMap::new();
    let Some(query) = query.filter(|q| !q.is_empty()) else {
        return Ok(out);
    };
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').ok_or("a query part has no value")?;
        if !allowed.contains(&key) {
            return Err("unknown query parameter");
        }
        let plain = !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'));
        if !plain {
            return Err("a query value is not plain text");
        }
        if out.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err("a query parameter is given twice");
        }
    }
    Ok(out)
}

/// `<area>/<slug>`: two plain names. The engine says whether the task is
/// there; this only keeps anything else from ever reaching it.
fn valid_task_id(id: &str) -> bool {
    let Some((area, slug)) = id.split_once('/') else {
        return false;
    };
    let plain = |t: &str| {
        t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    crate::config::valid_area_name(area).is_ok()
        && plain(area)
        && !slug.is_empty()
        && slug.len() <= 128
        && !slug.starts_with('.')
        && plain(slug)
}

async fn task(State(st): State<Arc<Shared>>, RawQuery(query): RawQuery) -> Response {
    let params = match parse_query(query.as_deref(), &["id"]) {
        Ok(p) => p,
        Err(why) => return error_body(StatusCode::BAD_REQUEST, "bad_query", why),
    };
    let Some(id) = params.get("id").filter(|id| valid_task_id(id)) else {
        return error_body(
            StatusCode::BAD_REQUEST,
            "bad_id",
            "id must be <area>/<slug>",
        );
    };
    // The state of the vault the answer is for: from the held snapshot, so a
    // repeated look at a task costs no engine question.
    let rev = st.store.current().await.ok().and_then(|c| c.rev.clone());
    if let Some(rev) = &rev {
        let hit = st.details.lock().ok().and_then(|mut d| d.get(rev, id));
        if let Some(doc) = hit {
            return json_response(StatusCode::OK, doc, None);
        }
    }
    match ask(&st, EngineMethod::Task, Some(&json!({ "id": id }))).await {
        Ok(reply) => {
            // Kept only when the engine made it for the state we hold: a
            // document of another state would be served for the wrong one.
            if let Some(rev) = &rev {
                let made_for = serde_json::from_str::<RevOnly>(&reply.text)
                    .ok()
                    .and_then(|d| d.rev);
                let same_state = made_for.as_deref() == Some(rev.as_str());
                let table = st.details.lock().ok().filter(|_| same_state);
                if let Some(mut details) = table {
                    details.put(rev, id, Bytes::from(reply.text.clone()));
                }
            }
            json_response(StatusCode::OK, reply.text, None)
        }
        Err(response) => response,
    }
}

#[derive(Deserialize)]
struct RevOnly {
    rev: Option<String>,
}

async fn next(State(st): State<Arc<Shared>>, RawQuery(query): RawQuery) -> Response {
    let params = match parse_query(query.as_deref(), &["n", "actor", "area"]) {
        Ok(p) => p,
        Err(why) => return error_body(StatusCode::BAD_REQUEST, "bad_query", why),
    };
    let mut request = serde_json::Map::new();
    if let Some(n) = params.get("n") {
        match n.parse::<u8>() {
            Ok(n) if n <= 10 => {
                request.insert("n".to_owned(), json!(n));
            }
            _ => return error_body(StatusCode::BAD_REQUEST, "bad_query", "n is 0 to 10"),
        }
    }
    if let Some(actor) = params.get("actor") {
        request.insert("actor".to_owned(), json!(actor));
    }
    if let Some(area) = params.get("area") {
        if crate::config::valid_area_name(area).is_err() {
            return error_body(StatusCode::BAD_REQUEST, "bad_query", "area is not a name");
        }
        request.insert("area".to_owned(), json!(area));
    }
    let request = serde_json::Value::Object(request);
    match ask(&st, EngineMethod::Next, Some(&request)).await {
        Ok(reply) => json_response(StatusCode::OK, reply.text, None),
        Err(response) => response,
    }
}

/// The areas, each with the class it is shown with. An area the file does
/// not name is `unclassified`; so the list tells a person what still needs
/// a decision.
async fn areas(State(st): State<Arc<Shared>>, RawQuery(query): RawQuery) -> Response {
    if let Some(response) = no_query(query.as_deref()) {
        return response;
    }
    let reply = match ask(&st, EngineMethod::Areas, None).await {
        Ok(r) => r,
        Err(response) => return response,
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&reply.text) else {
        return error_body(
            StatusCode::BAD_GATEWAY,
            "engine_failed",
            "the engine could not answer",
        );
    };
    let mut out = Vec::new();
    let mut unclassified = Vec::new();
    let mut private = Vec::new();
    for area in doc["areas"].as_array().map_or(&[][..], Vec::as_slice) {
        let Some(name) = area["name"].as_str() else {
            continue;
        };
        let shown = st.classes.shown(name);
        match shown {
            Shown::Unclassified => unclassified.push(name.to_owned()),
            Shown::Private => private.push(name.to_owned()),
            Shown::Public | Shown::Internal => {}
        }
        let mut entry = area.clone();
        entry["data_class"] = json!(shown);
        out.push(entry);
    }
    let body = json!({
        "schema": 1,
        "kind": "hub.areas",
        "areas": out,
        "unclassified": unclassified,
        "private": private,
    });
    json_response(StatusCode::OK, body.to_string(), None)
}

/// One open event stream in the usage log; ends with the stream.
struct VisitGuard(Option<Arc<UsageLog>>);

impl VisitGuard {
    fn new(log: Option<Arc<UsageLog>>) -> Self {
        if let Some(log) = &log {
            log.stream_opened();
        }
        Self(log)
    }
}

impl Drop for VisitGuard {
    fn drop(&mut self) {
        if let Some(log) = &self.0 {
            log.stream_closed();
        }
    }
}

/// The body of an event stream: what the task of the connection sends.
struct EventStream {
    rx: mpsc::Receiver<Bytes>,
}

impl Stream for EventStream {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|item| item.map(Ok))
    }
}

/// `GET /api/tasks/events`: server-sent events (concept 3.4). A `hello`
/// first (with where the stream stands), then one `tasks` event per change.
/// An event is a hint: what changed, as ids; the client reads again. There
/// is no replay: a client that connects reads the snapshot first.
async fn events(
    State(st): State<Arc<Shared>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = no_query(query.as_deref()) {
        return response;
    }
    if !st.store.has_engine() {
        return engine_unavailable(&st);
    }
    // The guard has checked the session; the token is the key of the count.
    let token = bearer(&headers).unwrap_or_default();
    let Some(guard) = st
        .streams
        .acquire(&token, st.limits.max_streams_per_session)
    else {
        return error_body(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_streams",
            "this session has too many open event streams",
        );
    };
    // Start from a known state: the snapshot is held before the stream is.
    if let Err(error) = st.store.current().await {
        return engine_failure(error);
    }
    let (mut changes, seq, rev) = st.store.subscribe();
    let (tx, rx) = mpsc::channel::<Bytes>(16);
    let heartbeat = st.limits.heartbeat;
    let instance = st.instance.clone();
    let shared = Arc::clone(&st);
    // The visit is counted while the stream lives, and ends with it.
    let visit = VisitGuard::new(st.usage.clone());
    tokio::spawn(async move {
        let _guard = guard;
        let _visit = visit;
        let hello = format!(
            "event: hello\ndata: {}\n\n",
            json!({ "rev": rev, "seq": seq, "instance": instance })
        );
        if tx.send(Bytes::from(hello)).await.is_err() {
            return;
        }
        let mut ticker =
            tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let message = tokio::select! {
                change = changes.recv() => match change {
                    Ok(c) => c.to_sse(),
                    // This client was too slow for the buffer: it must read again.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        "event: resync\ndata: {}\n\n".to_owned()
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = ticker.tick() => ": ping\n\n".to_owned(),
                () = tx.closed() => return,
            };
            // The session was checked when the stream was opened. One that
            // was closed since (the oldest is closed when newer ones open)
            // takes its streams with it: no id goes to a token that is no
            // longer one.
            if !shared.sessions.check(&token) {
                return;
            }
            if tx.send(Bytes::from(message)).await.is_err() {
                return;
            }
        }
    });
    let mut response = Response::new(Body::from_stream(EventStream { rx }));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
}

/// `GET /api/tasks/search?q=<escaped text>&limit=<1..50>`: the tasks whose
/// text holds every word of the query, best first, each with a piece of the
/// text around the match (marks in UTF-16 units). The text comes from the
/// index the hub keeps; while there is none, `status` says so.
async fn search_route(State(st): State<Arc<Shared>>, RawQuery(query): RawQuery) -> Response {
    let Some(index) = &st.search else {
        return engine_unavailable(&st);
    };
    let (text, limit) = match search::parse_request(query.as_deref()) {
        Ok(parsed) => parsed,
        Err(why) => return error_body(StatusCode::BAD_REQUEST, "bad_query", why),
    };
    let query = match search::Query::parse(&text) {
        Ok(q) => q,
        Err(why) => return error_body(StatusCode::BAD_REQUEST, "bad_query", why),
    };
    let (status, tasks, partial, outcome) = match index.status() {
        search::Status::Ready { tasks, partial } => {
            ("ready", tasks, partial, index.search(&query, limit))
        }
        search::Status::Building => ("building", 0, false, None),
        search::Status::Failed => ("failed", 0, false, None),
    };
    let hits: Vec<serde_json::Value> = outcome
        .as_ref()
        .map(|o| {
            o.hits
                .iter()
                .map(|h| {
                    json!({
                        "id": h.id,
                        "score": h.score,
                        "snippet": {
                            "text": h.snippet.text,
                            "marks": h.snippet.marks,
                            "more_before": h.snippet.more_before,
                            "more_after": h.snippet.more_after,
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let body = json!({
        "schema": 1,
        "kind": "hub.search",
        "status": status,
        "indexed": tasks,
        "partial": partial,
        "total": outcome.as_ref().map_or(0, |o| o.total),
        "hits": hits,
    });
    json_response(StatusCode::OK, body.to_string(), None)
}

/// `POST /api/tasks/rescan`: a client that got the focus again asks for a
/// full scan. Many asks while one runs are one scan.
async fn rescan(State(st): State<Arc<Shared>>) -> Response {
    if !st.store.has_engine() {
        return engine_unavailable(&st);
    }
    st.store.request_rescan();
    // The page asks for this when its window gets the focus back.
    if let Some(usage) = &st.usage {
        usage.touched();
    }
    (StatusCode::ACCEPTED, axum::Json(json!({ "ok": true }))).into_response()
}

async fn not_found() -> Response {
    error_body(StatusCode::NOT_FOUND, "not_found", "no such route")
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
