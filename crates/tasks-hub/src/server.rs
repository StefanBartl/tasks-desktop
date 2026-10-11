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
//! In this stage the server has no route that returns task data. The
//! credential check for `/api/**` is already in place, so a route added
//! later is closed until it is deliberately opened.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{
    fetch_site_ok, Clock, HostPolicy, PairingStore, RateLimiter, Secret, SessionStore, CODE_BYTES,
    TOKEN_BYTES,
};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinHandle;

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
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_head_bytes: 8 * 1024,
            max_body_bytes: 1024 * 1024,
            header_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(30),
            max_connections: 64,
            post_max: 60,
            post_window: Duration::from_secs(10),
            exchange_max: 10,
            exchange_window: Duration::from_secs(60),
            max_sessions: 16,
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
}

/// A started server.
pub struct RunningServer {
    addr: SocketAddr,
    instance: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
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
    pub async fn shutdown(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), self.task).await;
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
    });
    let app = router(shared);
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(accept_loop(listener, app, limits, stop_rx));
    Ok(RunningServer {
        addr,
        instance,
        stop,
        task,
    })
}

fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/", get(shell))
        .route("/index.html", get(shell))
        .route("/api/tasks/hello", get(hello))
        .route("/auth/exchange", post(exchange))
        .route("/api/control/pair", post(control_pair))
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
                // A failed accept (a reset while queued) is not the end.
                Err(_) => continue,
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
    match single(headers, &header::CONTENT_LENGTH) {
        Ok(None) => {}
        Ok(Some(len)) => match len.parse::<usize>() {
            Ok(n) if n <= st.limits.max_body_bytes => {}
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
        // The strict policy with Trusted Types comes with the UI (package 6);
        // this is the floor that already holds for the placeholder page.
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'none'; object-src 'none'; \
                 frame-ancestors 'none'; form-action 'none'",
            ),
        );
    }
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn shell() -> Response {
    let html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<title>tasks-desktop</title></head><body><p>tasks-desktop hub is running. \
The interface is not built yet.</p></body></html>";
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

async fn not_found() -> Response {
    error_body(StatusCode::NOT_FOUND, "not_found", "no such route")
}
