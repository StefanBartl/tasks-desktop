//! The state of a hub that does not depend on the app, and the server that serves it.

use super::*;

/// What a hub keeps for the vault it reads, as the core sees it: its status for `hello` and the
/// way to stop what it started. Everything else about it belongs to the app.
pub trait Runtime: Send + Sync + 'static {
    /// What the app makes a runtime from when a vault is chosen.
    type Target: Send + 'static;

    /// What `hello` says about the engine. A short code, never a path.
    fn status(&self) -> &HubStatus;

    /// Stop what the runtime started; called when another vault is chosen and when the server ends.
    fn stop(&self);
}

/// How the app makes the runtime of a vault that was chosen.
pub type BuildRuntime<R> = Arc<dyn Fn(<R as Runtime>::Target) -> R + Send + Sync>;

/// One file of the page.
#[derive(Clone)]
pub struct Page {
    pub bytes: Bytes,
    pub content_type: &'static str,
}

/// The files of the page the app serves at `/` and `/assets/`.
pub trait Pages: Send + Sync {
    /// The file the page asks for by this path, if there is one.
    fn page(&self, request_path: &str) -> Option<Page>;

    /// Is there a page to serve at all (or only the placeholder)?
    fn has_index(&self) -> bool;
}

/// The state of a hub that does not depend on the app: the guard and its secrets, the pairing and
/// the sessions, the limits, the page, and the vault that is read (whatever `R` the app keeps for it).
pub struct Core<R: Runtime> {
    pub policy: HostPolicy,
    pub pairing: PairingStore,
    pub sessions: SessionStore,
    pub control: Secret,
    pub post_limit: RateLimiter,
    pub ops_limit: RateLimiter,
    pub exchange_limit: RateLimiter,
    pub limits: Limits,
    /// Changes with every start.
    pub instance: String,
    /// What the hub says it is in `hello`, and its version.
    pub app: &'static str,
    pub version: &'static str,
    pub guard_rules: GuardRules,
    pub ui: Arc<dyn Pages>,
    /// What belongs to the vault that is read; replaced when another is chosen.
    pub runtime: StdRwLock<Arc<R>>,
    /// Makes the runtime of a vault that was chosen.
    pub build: BuildRuntime<R>,
    /// The vaults the person may choose from; none in a hub that has only one.
    pub vaults: Option<Arc<dyn VaultAdmin<R::Target>>>,
    /// One change of vault at a time, from the choice to the swap: two that overlap would leave the hub reading one
    /// vault while the settings name the other.
    pub switching: tokio::sync::Mutex<()>,
}

impl<R: Runtime> Core<R> {
    /// The state of the vault that is read now. A request keeps the one it
    /// took, so a change of vault never splits one answer in two.
    pub fn rt(&self) -> Arc<R> {
        Arc::clone(
            &self
                .runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

/// Everything the core needs to start, besides the routes of the app.
pub struct ServeParts<R: Runtime> {
    /// Must be a loopback address; port 0 picks a free port.
    pub addr: SocketAddr,
    pub limits: Limits,
    pub clock: Arc<dyn Clock>,
    pub pairing_ttl: Duration,
    /// What lets a local program ask for a pairing code.
    pub control_secret: Secret,
    /// Changes with every start.
    pub instance: Secret,
    pub app: &'static str,
    pub version: &'static str,
    pub guard_rules: GuardRules,
    pub ui: Arc<dyn Pages>,
    pub runtime: R,
    pub build: BuildRuntime<R>,
    pub vaults: Option<Arc<dyn VaultAdmin<R::Target>>>,
}

/// A started server.
pub struct RunningServer {
    addr: SocketAddr,
    instance: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
    stop_runtime: Arc<dyn Fn() + Send + Sync>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        (self.stop_runtime)();
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
        (self.stop_runtime)();
        let task = std::mem::replace(&mut self.task, tokio::spawn(async {}));
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    }
}

/// Bind and serve: the routes of the core (the page, `hello`, the pairing, the list of vaults) and
/// the routes of the app, behind the guard.
///
/// `routes` gets the core, so that a route can name a limit of its own.
///
/// # Errors
///
/// An I/O error of binding, or `InvalidInput` for an address that is not loopback.
pub async fn serve<R, F>(parts: ServeParts<R>, routes: F) -> std::io::Result<RunningServer>
where
    R: Runtime,
    F: FnOnce(&Arc<Core<R>>) -> Router<Arc<Core<R>>>,
{
    if !parts.addr.ip().is_loopback() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the server binds loopback addresses only",
        ));
    }
    let listener = TcpListener::bind(parts.addr).await?;
    let addr = listener.local_addr()?;
    let instance = parts.instance.to_hex();
    let limits = parts.limits.clone();
    let core = Arc::new(Core {
        policy: HostPolicy::loopback(addr.port()),
        pairing: PairingStore::new(Arc::clone(&parts.clock), parts.pairing_ttl),
        sessions: SessionStore::new(limits.max_sessions),
        control: parts.control_secret,
        post_limit: RateLimiter::new(
            Arc::clone(&parts.clock),
            limits.post_max,
            limits.post_window,
        ),
        ops_limit: RateLimiter::new(Arc::clone(&parts.clock), limits.ops_max, limits.ops_window),
        exchange_limit: RateLimiter::new(parts.clock, limits.exchange_max, limits.exchange_window),
        limits: limits.clone(),
        instance: instance.clone(),
        app: parts.app,
        version: parts.version,
        guard_rules: parts.guard_rules,
        ui: parts.ui,
        runtime: StdRwLock::new(Arc::new(parts.runtime)),
        build: parts.build,
        vaults: parts.vaults,
        switching: tokio::sync::Mutex::new(()),
    });

    let app = router(&core, routes(&core));
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(accept_loop(listener, app, limits, stop_rx));
    let for_stop = Arc::clone(&core);
    Ok(RunningServer {
        addr,
        instance,
        stop,
        task,
        stop_runtime: Arc::new(move || for_stop.rt().stop()),
    })
}

/// The routes of the core, the routes of the app, and the guard in front of both.
fn router<R: Runtime>(core: &Arc<Core<R>>, app: Router<Arc<Core<R>>>) -> Router {
    let small = core.limits.small_body_bytes;
    Router::new()
        .route("/", get(shell::<R>))
        .route("/index.html", get(shell::<R>))
        .route("/assets/{name}", get(shell::<R>))
        .route(core.guard_rules.hello_path(), get(hello::<R>))
        .route("/api/vaults", get(vaults_list::<R>))
        .route(
            "/api/vaults/add",
            post(vaults_add::<R>).layer(DefaultBodyLimit::max(small)),
        )
        .route(
            "/api/vaults/remove",
            post(vaults_remove::<R>).layer(DefaultBodyLimit::max(small)),
        )
        .route(
            "/api/vaults/select",
            post(vaults_select::<R>).layer(DefaultBodyLimit::max(small)),
        )
        .route(
            "/auth/exchange",
            post(exchange::<R>).layer(DefaultBodyLimit::max(small)),
        )
        .route(
            "/api/control/pair",
            post(control_pair::<R>).layer(DefaultBodyLimit::max(small)),
        )
        .merge(app)
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(core.limits.max_body_bytes))
        .layer(middleware::from_fn_with_state(Arc::clone(core), guard::<R>))
        .with_state(Arc::clone(core))
}

async fn not_found() -> Response {
    error_body(StatusCode::NOT_FOUND, "not_found", "no such route")
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

    /// A runtime that is nobody's in particular: the core must serve and swap it all the same.
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
        type Target = HubStatus;

        fn status(&self) -> &HubStatus {
            &self.status
        }

        fn stop(&self) {
            self.stopped
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct TwoVaults;

    impl VaultAdmin<HubStatus> for TwoVaults {
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
        fn select<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<HubStatus, String>> {
            Box::pin(async {
                Ok(HubStatus {
                    engine_ready: true,
                    problem: None,
                    capabilities: vec!["second".to_owned()],
                })
            })
        }
    }

    struct NoPages;

    impl Pages for NoPages {
        fn page(&self, _: &str) -> Option<Page> {
            None
        }
        fn has_index(&self) -> bool {
            false
        }
    }

    fn core_with(first: &Arc<OtherRuntime>) -> Arc<Core<OtherRuntime>> {
        use app_core::authn::SystemClock;
        let clock: Arc<dyn Clock> = Arc::new(SystemClock::new());
        let ttl = Duration::from_secs(60);
        Arc::new(Core {
            policy: HostPolicy::loopback(1),
            pairing: PairingStore::new(Arc::clone(&clock), ttl),
            sessions: SessionStore::new(4),
            control: Secret::generate(TOKEN_BYTES).unwrap(),
            post_limit: RateLimiter::new(Arc::clone(&clock), 10, ttl),
            ops_limit: RateLimiter::new(Arc::clone(&clock), 10, ttl),
            exchange_limit: RateLimiter::new(clock, 10, ttl),
            limits: Limits::default(),
            instance: Secret::generate(CODE_BYTES).unwrap().to_hex(),
            app: "other-app",
            version: "9.9.9",
            guard_rules: GuardRules::new("/api/other/hello", []),
            ui: Arc::new(NoPages),
            runtime: StdRwLock::new(Arc::clone(first)),
            build: Arc::new(OtherRuntime::new),
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
        assert_eq!(before["app"], "other-app");
        assert_eq!(before["version"], "9.9.9");
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

    #[tokio::test]
    async fn the_placeholder_names_the_app_that_runs() {
        let first = Arc::new(OtherRuntime::new(HubStatus {
            engine_ready: true,
            problem: None,
            capabilities: Vec::new(),
        }));
        let core = core_with(&first);
        let page = shell(State(core), "/".parse().unwrap()).await;
        let bytes = axum::body::to_bytes(page.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("other-app hub is running"), "{text}");
        assert!(!text.contains("tasks-desktop"), "{text}");
    }
}
