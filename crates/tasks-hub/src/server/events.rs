//! The event stream of one session.

use super::*;

/// One open event stream in the usage log; ends with the stream.
pub(super) struct VisitGuard(Option<Arc<UsageLog>>);

impl VisitGuard {
    pub(super) fn new(log: Option<Arc<UsageLog>>) -> Self {
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
pub(super) struct EventStream {
    pub(super) rx: mpsc::Receiver<Bytes>,
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
pub(super) async fn events(
    State(st): State<Arc<Shared>>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = no_query(query.as_deref()) {
        return response;
    }
    let rt = st.rt();
    if !rt.store.has_engine() {
        return engine_unavailable(&st);
    }
    // The guard has checked the session; the token is the key of the count.
    let token = bearer(&headers).unwrap_or_default();
    let Some(guard) = rt
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
    if let Err(error) = rt.store.current().await {
        return engine_failure(error);
    }
    let (mut changes, seq, rev) = rt.store.subscribe();
    let (tx, rx) = mpsc::channel::<Bytes>(16);
    let heartbeat = st.limits.heartbeat;
    let instance = st.instance.clone();
    let shared = Arc::clone(&st);
    // The visit is counted while the stream lives, and ends with it.
    let visit = VisitGuard::new(rt.usage.clone());
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
                    Ok(c) => c.to_sse(crate::store::SHAPE.event),
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
