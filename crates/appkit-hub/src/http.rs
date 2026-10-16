//! Plain helpers of the answers: a JSON document with its ETag, a route that takes no query, a query that is plain.

use crate::*;

/// Does an `If-None-Match` header name this ETag (or `*`)?
pub fn etag_matches(header: &str, etag: &str) -> bool {
    let quoted = format!("\"{etag}\"");
    header.split(',').map(str::trim).any(|candidate| {
        candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == quoted
    })
}

pub fn json_response(status: StatusCode, text: impl Into<Body>, etag: Option<&str>) -> Response {
    let body: Body = text.into();
    let mut response = (status, [(header::CONTENT_TYPE, "application/json")], body).into_response();
    if let Some(value) = etag.and_then(|e| HeaderValue::from_str(&format!("\"{e}\"")).ok()) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

pub fn not_modified(etag: &str) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NOT_MODIFIED;
    if let Ok(value) = HeaderValue::from_str(&format!("\"{etag}\"")) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

/// A route that takes no query says so, instead of ignoring one.
pub fn no_query(query: Option<&str>) -> Option<Response> {
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
pub fn parse_query(
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
