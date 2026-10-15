//! How a question to the engine is answered: the documents, the caches and the refusals.

use super::*;

/// Does an `If-None-Match` header name this ETag (or `*`)?
pub(super) fn etag_matches(header: &str, etag: &str) -> bool {
    let quoted = format!("\"{etag}\"");
    header.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == quoted
    })
}

pub(super) fn json_response(
    status: StatusCode,
    text: impl Into<Body>,
    etag: Option<&str>,
) -> Response {
    let body: Body = text.into();
    let mut response = (status, [(header::CONTENT_TYPE, "application/json")], body).into_response();
    if let Some(value) = etag.and_then(|e| HeaderValue::from_str(&format!("\"{e}\"")).ok()) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

pub(super) fn not_modified(etag: &str) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NOT_MODIFIED;
    if let Ok(value) = HeaderValue::from_str(&format!("\"{etag}\"")) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

/// What a request without an engine gets: the hub is up, the engine is not.
pub(super) fn engine_unavailable(st: &Shared) -> Response {
    let body = json!({ "error": {
        "code": "engine_unavailable",
        "message": "the engine is not ready",
        "problem": st.rt().status.problem,
    }});
    (StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response()
}

/// Map what went wrong with a question to an answer. The engine's own
/// refusals keep their code and their message (the contract promises that
/// they hold no path of this machine); everything else is told in one word,
/// and the detail goes to the terminal of whoever runs the hub.
pub(super) fn engine_failure(error: EngineError) -> Response {
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

// The error is the answer to send, as everywhere in this file: a response is large, and rare.
#[allow(clippy::result_large_err)]
pub(super) async fn ask(
    st: &Shared,
    method: EngineMethod,
    params: Option<&serde_json::Value>,
) -> Result<crate::engine::Reply, Response> {
    let rt = st.rt();
    let Some(engine) = &rt.engine else {
        return Err(engine_unavailable(st));
    };
    engine.call(method, params).await.map_err(engine_failure)
}

/// A route that takes no query says so, instead of ignoring one.
pub(super) fn no_query(query: Option<&str>) -> Option<Response> {
    match query {
        None | Some("") => None,
        Some(_) => Some(error_body(
            StatusCode::BAD_REQUEST,
            "bad_query",
            "this route takes no query",
        )),
    }
}

/// The query of a request as pairs, refusing what is not plain: a key that
/// is not listed, a key twice, a value with anything but letters, digits,
/// `.`, `_`, `-` and `/` (no escapes: nothing here needs them; what a
/// value may be is for the handler of its parameter to say).
pub(super) fn parse_query(
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
