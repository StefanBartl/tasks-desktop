//! The check of the vault as a job: one at a time, started by a person or by the hub itself.

use super::*;

/// The check of the vault as a job. It reads every task file and asks git for the refs, which takes longer than
/// a question; so the page starts it, goes on, and asks for the state. At most one runs; a start while one runs is
/// told that one. The state belongs to the vault that is read: choosing another vault drops it.
#[derive(Default)]
pub(super) enum CheckJob {
    #[default]
    Idle,
    Running {
        id: u64,
    },
    Done {
        id: u64,
        result: serde_json::Value,
    },
    Failed {
        id: u64,
        code: String,
        message: String,
    },
}

/// The ids of the jobs, one after the other for the life of the hub.
pub(super) static CHECK_JOB_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl CheckJob {
    pub(super) fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Idle => json!({ "job": { "state": "idle" } }),
            Self::Running { id } => json!({ "job": { "id": id, "state": "running" } }),
            Self::Done { id, result } => {
                json!({ "job": { "id": id, "state": "done", "result": result } })
            }
            Self::Failed { id, code, message } => json!({ "job": {
                "id": id,
                "state": "failed",
                "error": { "code": code, "message": message },
            } }),
        }
    }
}

/// What a failed check says: the engine's own refusal in its words, or a fixed sentence (a process failure holds
/// paths, which a page does not get).
pub(super) fn check_failure(error: &EngineError) -> (String, String) {
    match error {
        EngineError::Refused(r) => (
            "engine_refused".to_owned(),
            r.message
                .chars()
                .filter(|c| !crate::engine::is_unprintable(*c))
                .take(300)
                .collect(),
        ),
        EngineError::Timeout => (
            "timeout".to_owned(),
            "the engine did not answer in time".to_owned(),
        ),
        EngineError::Busy => ("busy".to_owned(), "the engine queue is full".to_owned()),
        _ => (
            "engine_failed".to_owned(),
            "the engine could not do the check".to_owned(),
        ),
    }
}

/// `GET /api/tasks/check`: the state of the check job (`idle`, `running`, `done` with the engine's `tasks.check`
/// document, or `failed`).
pub(super) async fn check_state(
    State(st): State<Arc<Shared>>,
    RawQuery(query): RawQuery,
) -> Response {
    if let Some(response) = no_query(query.as_deref()) {
        return response;
    }
    let rt = st.rt();
    let body = match rt.check.lock() {
        Ok(job) => job.to_json(),
        Err(poisoned) => poisoned.into_inner().to_json(),
    };
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// `POST /api/tasks/check`: start the check as a job and answer at once. `{ "stale": "refs", "area": "<area>" }`,
/// both optional. A start while a job runs does not start another: it answers that one.
pub(super) async fn check_start(State(st): State<Arc<Shared>>, body: Bytes) -> Response {
    let map = match vault_request(&body, &["stale", "area"]) {
        Ok(m) => m,
        Err(response) => return response,
    };
    let mut params = serde_json::Map::new();
    if let Some(stale) = map.get("stale") {
        if stale.as_str() != Some("refs") {
            return error_body(StatusCode::BAD_REQUEST, "bad_request", "stale must be refs");
        }
        params.insert("stale".to_owned(), stale.clone());
    }
    if let Some(area) = map.get("area") {
        let ok = area
            .as_str()
            .is_some_and(|a| crate::config::valid_area_name(a).is_ok());
        if !ok {
            return error_body(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "area must be the name of an area",
            );
        }
        params.insert("area".to_owned(), area.clone());
    }
    let rt = st.rt();
    let Some(engine) = rt.engine.clone() else {
        return engine_unavailable(&st);
    };
    let with_refs = params.contains_key("stale");
    let asked = params.clone();
    match start_check_job(&rt, engine.clone(), params) {
        Ok(state) => {
            *rt.check_params
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = asked;
            rt.auto_check
                .store(!with_refs, std::sync::atomic::Ordering::Release);
            if !with_refs {
                keep_check_fresh(&rt, engine, AutoCheckTiming::default());
            }
            (StatusCode::OK, axum::Json(state)).into_response()
        }
        Err(CheckStart::Retired) => error_body(
            StatusCode::CONFLICT,
            "vault_changed",
            "another vault is read now: ask again",
        ),
        Err(CheckStart::Unavailable) => engine_unavailable(&st),
    }
}

/// Why a check was not started.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum CheckStart {
    /// The runtime was retired (another vault is read now): nothing is started in it.
    Retired,
    /// The jobs of the runtime cannot be reached (a lock that a panic poisoned).
    Unavailable,
}

/// How the hub runs the check again by itself.
#[derive(Clone, Copy)]
pub(super) struct AutoCheckTiming {
    /// No change for this long before the check runs again.
    pub(super) quiet: Duration,
    /// At least this long between two starts of a check (by a person or by the hub).
    pub(super) gap: Duration,
    /// How often a check that still runs is looked at before the next is started.
    pub(super) poll: Duration,
}

impl Default for AutoCheckTiming {
    fn default() -> Self {
        Self {
            quiet: Duration::from_secs(10),
            gap: Duration::from_secs(30),
            poll: Duration::from_secs(2),
        }
    }
}

/// Start the follower that runs the check again after the vault changed: once for a runtime, and only after a
/// person asked for a check (so nobody pays for one they never looked at).
pub(super) fn keep_check_fresh(
    rt: &Arc<VaultRuntime>,
    engine: Arc<dyn Engine>,
    timing: AutoCheckTiming,
) {
    if rt
        .auto_check_started
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return;
    }
    let Ok(mut jobs) = rt.jobs.lock() else {
        return;
    };
    if rt.retired.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let store = Arc::clone(&rt.store);
    let changes = store.subscribe_quiet();
    let handle = tokio::spawn(follow_changes(
        Arc::downgrade(rt),
        engine,
        changes,
        timing,
        move || store.has_listeners(),
    ));
    jobs.retain(|j| !j.is_finished());
    jobs.push(handle);
}

/// After a change and a quiet time (and the gap since the last start) run the check again, without `refs`: only while
/// a client holds an event stream, never while another check runs, never in a runtime that was retired. A vault that
/// changes all the time (a sync tool) is held to one check per gap, because every change within the quiet time or the
/// gap is folded into the next one.
pub(super) async fn follow_changes(
    runtime: std::sync::Weak<VaultRuntime>,
    engine: Arc<dyn Engine>,
    mut changes: broadcast::Receiver<Arc<store::Change>>,
    timing: AutoCheckTiming,
    listening: impl Fn() -> bool + Send,
) {
    use broadcast::error::{RecvError, TryRecvError};
    loop {
        match changes.recv().await {
            Ok(_) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
        // Quiet: until nothing changed for `quiet`.
        loop {
            match tokio::time::timeout(timing.quiet, changes.recv()).await {
                Err(_) => break,
                Ok(Ok(_) | Err(RecvError::Lagged(_))) => {}
                Ok(Err(RecvError::Closed)) => return,
            }
        }
        // The gap since the last start (a person's too).
        let wait = {
            let Some(rt) = runtime.upgrade() else {
                return;
            };
            let started = *rt
                .check_started
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            started.and_then(|at| timing.gap.checked_sub(at.elapsed()))
        };
        if let Some(wait) = wait {
            tokio::time::sleep(wait).await;
        }
        // What changed during the gap is in the check that starts now.
        loop {
            match changes.try_recv() {
                Ok(_) | Err(TryRecvError::Lagged(_)) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Closed) => return,
            }
        }
        loop {
            let Some(rt) = runtime.upgrade() else {
                return;
            };
            if rt.retired.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            if !listening() || !rt.auto_check.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            let running = matches!(
                *rt.check
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
                CheckJob::Running { .. }
            );
            if !running {
                // A refusal (retired, lock) ends the round; the next change tries again.
                let again = rt
                    .check_params
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                let _ = start_check_job(&rt, Arc::clone(&engine), again);
                break;
            }
            drop(rt);
            tokio::time::sleep(timing.poll).await;
        }
    }
}

/// Start the check as a job of `rt`, or answer the one that runs. The state it returns is the one to send.
pub(super) fn start_check_job(
    rt: &Arc<VaultRuntime>,
    engine: Arc<dyn Engine>,
    params: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, CheckStart> {
    // The handle goes into the jobs under the lock the retiring of the runtime takes, so that a start never slips
    // in after it: a job of a vault that is no longer read is not started.
    let Ok(mut jobs) = rt.jobs.lock() else {
        return Err(CheckStart::Unavailable);
    };
    if rt.retired.load(std::sync::atomic::Ordering::Acquire) {
        if let Ok(mut job) = rt.check.lock() {
            *job = CheckJob::Idle;
        }
        return Err(CheckStart::Retired);
    }
    let id = {
        let mut job = rt
            .check
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(*job, CheckJob::Running { .. }) {
            return Ok(job.to_json());
        }
        let id = CHECK_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *job = CheckJob::Running { id };
        *rt.check_started
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(std::time::Instant::now());
        id
    };
    let runtime = Arc::clone(rt);
    let handle = tokio::spawn(async move {
        let request = serde_json::Value::Object(params);
        let outcome = engine.call(Calls::Check, Some(&request)).await;
        let next = match outcome {
            Ok(reply) => match serde_json::from_str::<serde_json::Value>(&reply.text) {
                Ok(result) => CheckJob::Done { id, result },
                Err(_) => CheckJob::Failed {
                    id,
                    code: "engine_failed".to_owned(),
                    message: "the engine answered with something that is not a document".to_owned(),
                },
            },
            Err(error) => {
                // The page gets a sentence; whoever runs the hub gets the cause (already scrubbed of paths).
                // (a refusal holds the engine's words as they are: controls and hidden characters are taken out of the
                // log line too, a file name in a hostile vault must not write into a terminal)
                let line: String = error
                    .to_string()
                    .chars()
                    .map(|c| {
                        if crate::engine::is_unprintable(c) {
                            ' '
                        } else {
                            c
                        }
                    })
                    .collect();
                eprintln!("engine check: {line}");
                let (code, message) = check_failure(&error);
                CheckJob::Failed { id, code, message }
            }
        };
        let mut job = runtime
            .check
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Only the job that is still the one asked for sets its end.
        if matches!(*job, CheckJob::Running { id: running } if running == id) {
            *job = next;
        }
    });
    jobs.retain(|j| !j.is_finished());
    jobs.push(handle);
    drop(jobs);
    Ok(rt
        .check
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .to_json())
}
