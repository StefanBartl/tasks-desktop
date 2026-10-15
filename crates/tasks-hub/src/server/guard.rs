//! The guard: every request passes these eight steps, in this order, before any route runs.

use super::*;

// ── the guard ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Class {
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

/// What an app tells the guard about its routes: paths and nothing else. The checks, their order
/// and the classes are the guard's own, so an app cannot loosen one.
#[derive(Debug, Clone)]
pub struct GuardRules {
    /// The path of `hello`: version and abilities, no credential and no data.
    hello_path: String,
    /// POST paths that are counted by the coarse limit of `ops` (a read that is a POST, or a write
    /// that only its body tells from a dry run) and not by the strict one of the other mutations.
    coarse_post_paths: Vec<String>,
}

impl GuardRules {
    #[must_use]
    pub fn new(
        hello_path: impl Into<String>,
        coarse_post_paths: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            hello_path: hello_path.into(),
            coarse_post_paths: coarse_post_paths.into_iter().collect(),
        }
    }

    fn is_coarse(&self, path: &str) -> bool {
        self.coarse_post_paths.iter().any(|p| p == path)
    }
}

pub(super) fn classify(path: &str, rules: &GuardRules) -> Class {
    match path {
        "/" | "/index.html" => Class::Shell,
        p if p.starts_with("/assets/") => Class::Shell,
        p if p == rules.hello_path => Class::Hello,
        "/auth/exchange" => Class::Exchange,
        "/api/control/pair" => Class::ControlPair,
        p if p.starts_with("/api/") => Class::Api,
        _ => Class::Other,
    }
}

pub(super) fn method_allowed(class: Class, method: &Method) -> bool {
    match class {
        Class::Shell | Class::Hello => method == Method::GET,
        Class::Exchange | Class::ControlPair => method == Method::POST,
        Class::Api => method == Method::GET || method == Method::POST,
        // The fallback answers 404 to anything.
        Class::Other => true,
    }
}

pub(super) fn error_body(status: StatusCode, code: &str, message: &str) -> Response {
    let body = json!({ "error": { "code": code, "message": message } });
    (status, axum::Json(body)).into_response()
}

/// A header that must be there at most once and be plain ASCII.
pub(super) fn single(headers: &HeaderMap, name: &HeaderName) -> Result<Option<String>, ()> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    first.to_str().map(|s| Some(s.to_owned())).map_err(|_| ())
}

pub(super) fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = single(headers, &header::AUTHORIZATION).ok()??;
    value.strip_prefix("Bearer ").map(str::to_owned)
}

pub(super) fn is_json_content_type(headers: &HeaderMap) -> bool {
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

pub(super) static SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");

pub(super) async fn guard(State(st): State<Arc<Shared>>, req: Request, next: Next) -> Response {
    let class = classify(req.uri().path(), &st.guard_rules);
    let mut response = judge(&st, class, req, next).await;
    set_security_headers(&mut response, class);
    response
}

pub(super) async fn judge(st: &Shared, class: Class, req: Request, next: Next) -> Response {
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

    // 6. Rate limit for mutations, before any credential. Only the body of `ops` tells a write
    // from a dry run, so the route has a coarse limit here for everything sent to it, and its
    // writes are counted again, strictly, once the handler has read the body.
    if mutation {
        let limit = if st.guard_rules.is_coarse(parts.uri.path()) {
            &st.ops_limit
        } else {
            &st.post_limit
        };
        if !limit.allow() {
            return too_many();
        }
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

pub(super) fn too_many() -> Response {
    error_body(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "too many requests",
    )
}

pub(super) fn set_security_headers(response: &mut Response, class: Class) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> GuardRules {
        GuardRules::new(
            "/api/rules/hello",
            [
                "/api/rules/apply".to_owned(),
                "/api/rules/preview".to_owned(),
            ],
        )
    }

    #[test]
    fn only_the_hello_of_the_rules_is_open() {
        let r = rules();
        assert!(matches!(classify("/api/rules/hello", &r), Class::Hello));
        // The hello of another app is one more route that needs a session.
        assert!(matches!(classify("/api/tasks/hello", &r), Class::Api));
    }

    #[test]
    fn what_an_app_names_never_leaves_the_api_prefix_or_the_classes() {
        let r = GuardRules::new("/hello", ["/ops".to_owned()]);
        // A hello outside /api/ would be an open route the guard did not mean: it is open only
        // because the app said so, and the other paths outside /api/ stay "not ours".
        assert!(matches!(classify("/ops", &r), Class::Other));
        assert!(matches!(classify("/auth/exchange", &r), Class::Exchange));
        assert!(matches!(
            classify("/api/control/pair", &r),
            Class::ControlPair
        ));
        assert!(matches!(classify("/assets/app.js", &r), Class::Shell));
    }

    #[test]
    fn the_coarse_limit_is_for_the_listed_paths_only() {
        let r = rules();
        assert!(r.is_coarse("/api/rules/apply"));
        assert!(r.is_coarse("/api/rules/preview"));
        assert!(!r.is_coarse("/api/rules/other"));
        assert!(!r.is_coarse("/api/rules/apply/"));
    }
}
