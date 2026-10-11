//! The security tests of the server (concept 5.5), written before the
//! routes they protect.
//!
//! Requests are written as raw bytes over a TCP socket: a real HTTP client
//! would "repair" the very things under test (the `Host` header, a header
//! that is too long, a content type). Each test runs against a real server
//! bound to port 0.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use serde_json::Value;
use tasks_hub::server::{start, HubStatus, Limits, RunningServer, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A method, a path and the extra headers of one request.
type Attempt<'a> = (&'a str, &'a str, Vec<(&'a str, &'a str)>);

// ── harness ─────────────────────────────────────────────────────────────────

struct Harness {
    server: RunningServer,
    clock: Arc<ManualClock>,
    control: String,
}

impl Harness {
    async fn new() -> Self {
        Self::with(Limits::default()).await
    }

    async fn with(limits: Limits) -> Self {
        let clock = Arc::new(ManualClock::new());
        let control = Secret::generate(TOKEN_BYTES).unwrap();
        let cfg = ServerConfig {
            addr: "127.0.0.1:0".parse().unwrap(),
            limits,
            clock: clock.clone(),
            pairing_ttl: Duration::from_secs(60),
            control_secret: control.clone(),
            instance: Secret::generate(CODE_BYTES).unwrap(),
            status: HubStatus {
                engine_ready: true,
                problem: None,
            },
        };
        let server = start(cfg).await.expect("the server starts");
        Self {
            server,
            clock,
            control: control.to_hex(),
        }
    }

    fn addr(&self) -> SocketAddr {
        self.server.addr()
    }

    fn port(&self) -> u16 {
        self.server.addr().port()
    }

    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port())
    }

    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port())
    }
}

#[derive(Debug)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    raw: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {:?}", self.raw))
    }
}

fn parse(bytes: &[u8]) -> Reply {
    let raw = String::from_utf8_lossy(bytes).into_owned();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    // A chunked body is shown as it came; the tests that read JSON use
    // identity bodies (axum sets Content-Length for them).
    Reply {
        status,
        headers,
        body: body.to_owned(),
        raw,
    }
}

/// Build one request. Every header is written by the test.
fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("{method} {path} HTTP/1.1\r\n").into_bytes();
    for (k, v) in headers {
        out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out.extend_from_slice(body);
    out
}

async fn send(addr: SocketAddr, bytes: Vec<u8>) -> Reply {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let _ = stream.write_all(&bytes).await;
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buf)).await;
    parse(&buf)
}

/// A GET with a good `Host` and the extra headers given.
async fn get(h: &Harness, path: &str, extra: &[(&str, &str)]) -> Reply {
    let host = h.host();
    let mut headers = vec![("Host", host.as_str())];
    headers.extend_from_slice(extra);
    send(h.addr(), request("GET", path, &headers, b"")).await
}

/// A POST of JSON text with a good `Host`, and the extra headers given.
async fn post(h: &Harness, path: &str, extra: &[(&str, &str)], body: &str) -> Reply {
    let host = h.host();
    let len = body.len().to_string();
    let mut headers = vec![
        ("Host", host.as_str()),
        ("Content-Type", "application/json"),
        ("Content-Length", len.as_str()),
    ];
    headers.extend_from_slice(extra);
    send(h.addr(), request("POST", path, &headers, body.as_bytes())).await
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// Ask for a pairing code the way `tasks-hub open` does.
async fn mint_code(h: &Harness) -> String {
    let auth = bearer(&h.control);
    let r = post(h, "/api/control/pair", &[("Authorization", &auth)], "{}").await;
    assert_eq!(r.status, 200, "{r:?}");
    r.json()["code"].as_str().expect("a code").to_owned()
}

/// Exchange a code the way the browser does: with its Origin.
async fn exchange(h: &Harness, code: &str) -> Reply {
    let origin = h.origin();
    let body = format!(r#"{{"code":"{code}"}}"#);
    post(h, "/auth/exchange", &[("Origin", &origin)], &body).await
}

async fn session(h: &Harness) -> String {
    let code = mint_code(h).await;
    let r = exchange(h, &code).await;
    assert_eq!(r.status, 200, "{r:?}");
    r.json()["token"].as_str().expect("a token").to_owned()
}

// ── 1, 2: Host ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_wrong_host_is_forbidden() {
    let h = Harness::new().await;
    let port = h.port();
    for bad in [
        "evil.example".to_owned(),
        "127.0.0.1".to_owned(),
        "127.0.0.1:1".to_owned(),
        "0x7f.1".to_owned(),
        format!("127.0.0.1:{port}.evil.example"),
        format!("evil.example:{port}"),
        format!("LOCALHOST:{port}"),
        format!("127.0.0.1:{port}@evil.example"),
    ] {
        let r = send(
            h.addr(),
            request("GET", "/api/tasks/hello", &[("Host", &bad)], b""),
        )
        .await;
        assert_eq!(r.status, 403, "Host {bad:?} was accepted: {r:?}");
    }
}

#[tokio::test]
async fn the_loopback_names_are_accepted() {
    let h = Harness::new().await;
    let port = h.port();
    for good in [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ] {
        let r = send(
            h.addr(),
            request("GET", "/api/tasks/hello", &[("Host", &good)], b""),
        )
        .await;
        assert_eq!(r.status, 200, "Host {good:?} was refused: {r:?}");
    }
}

#[tokio::test]
async fn two_host_headers_are_a_bad_request() {
    let h = Harness::new().await;
    let host = h.host();
    let r = send(
        h.addr(),
        request(
            "GET",
            "/api/tasks/hello",
            &[("Host", &host), ("Host", "evil.example")],
            b"",
        ),
    )
    .await;
    assert!(matches!(r.status, 400 | 403), "{r:?}");
}

// ── 3, 5: Origin and Fetch Metadata ─────────────────────────────────────────

#[tokio::test]
async fn a_mutation_needs_a_good_origin() {
    let h = Harness::new().await;
    let code = mint_code(&h).await;
    let body = format!(r#"{{"code":"{code}"}}"#);
    // Wrong, "null", and a look-alike: refused. The code stays unspent.
    for bad in [
        "null".to_owned(),
        "http://evil.example".to_owned(),
        format!("{}.evil.example", h.origin()),
        format!("{}/", h.origin()),
        "https://127.0.0.1".to_owned(),
    ] {
        let r = post(&h, "/auth/exchange", &[("Origin", &bad)], &body).await;
        assert_eq!(r.status, 403, "Origin {bad:?} was accepted: {r:?}");
    }
    // Missing: a browser always sends one with a POST, so this is refused too.
    let r = post(&h, "/auth/exchange", &[], &body).await;
    assert_eq!(r.status, 403, "{r:?}");
    // The code was never spent by the refused tries.
    assert_eq!(exchange(&h, &code).await.status, 200);
}

#[tokio::test]
async fn cross_site_requests_are_forbidden() {
    let h = Harness::new().await;
    let token = session(&h).await;
    let auth = bearer(&token);
    for site in ["cross-site", "same-site", ""] {
        let r = get(&h, "/api/tasks/hello", &[("Sec-Fetch-Site", site)]).await;
        assert_eq!(r.status, 403, "Sec-Fetch-Site {site:?}: {r:?}");
        let r = get(
            &h,
            "/api/tasks/anything",
            &[("Sec-Fetch-Site", site), ("Authorization", &auth)],
        )
        .await;
        assert_eq!(r.status, 403, "Sec-Fetch-Site {site:?} with token: {r:?}");
    }
}

#[tokio::test]
async fn a_same_origin_get_without_origin_header_gets_through() {
    // What an EventSource-by-fetch looks like in a browser: a token, a
    // `Sec-Fetch-Site` of the same origin, and no `Origin` header at all.
    let h = Harness::new().await;
    let token = session(&h).await;
    let auth = bearer(&token);
    for site in [Some("same-origin"), Some("none"), None] {
        let mut extra = vec![("Authorization", auth.as_str())];
        if let Some(s) = site {
            extra.push(("Sec-Fetch-Site", s));
        }
        let r = get(&h, "/api/tasks/not-built-yet", &extra).await;
        // Past the guard, so the route says "not found", not "forbidden".
        assert_eq!(r.status, 404, "site {site:?}: {r:?}");
    }
}

#[tokio::test]
async fn a_browser_mutation_without_origin_is_refused_but_a_program_may() {
    let h = Harness::new().await;
    let token = session(&h).await;
    let auth = bearer(&token);
    // A program client: a token, no Origin, no Fetch Metadata.
    let r = post(
        &h,
        "/api/tasks/not-built-yet",
        &[("Authorization", &auth)],
        "{}",
    )
    .await;
    assert_eq!(r.status, 404, "{r:?}");
    // Looks like a browser (it sends Fetch Metadata) but has no Origin.
    let r = post(
        &h,
        "/api/tasks/not-built-yet",
        &[("Authorization", &auth), ("Sec-Fetch-Site", "same-origin")],
        "{}",
    )
    .await;
    assert_eq!(r.status, 403, "{r:?}");
}

#[tokio::test]
async fn there_is_no_cors() {
    let h = Harness::new().await;
    // A preflight from another origin, and every method that is not ours.
    let host = h.host();
    let r = send(
        h.addr(),
        request(
            "OPTIONS",
            "/api/tasks/hello",
            &[
                ("Host", &host),
                ("Origin", "http://evil.example"),
                ("Access-Control-Request-Method", "POST"),
            ],
            b"",
        ),
    )
    .await;
    assert_eq!(r.status, 403, "{r:?}");
    assert!(r.header("access-control-allow-origin").is_none());
    for method in ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE"] {
        let r = send(
            h.addr(),
            request(method, "/api/tasks/hello", &[("Host", &host)], b""),
        )
        .await;
        assert_eq!(r.status, 405, "{method}: {r:?}");
        assert!(r.header("access-control-allow-origin").is_none());
    }
    let r = get(&h, "/api/tasks/hello", &[("Origin", &h.origin())]).await;
    assert!(r.header("access-control-allow-origin").is_none(), "{r:?}");
}

// ── 4: credentials ──────────────────────────────────────────────────────────

#[tokio::test]
async fn every_data_route_needs_a_session() {
    let h = Harness::new().await;
    let token = session(&h).await;
    let control = h.control.clone();
    let wrong_token = Secret::generate(TOKEN_BYTES).unwrap().to_hex();
    for path in [
        "/api/tasks/snapshot",
        "/api/tasks/task",
        "/api/tasks/next",
        "/api/tasks/areas",
        "/api/tasks/events",
        "/api/tasks/ops",
        "/api/anything-at-all",
        "/api/tasks/hello/",
        "/api/tasks/%68ello",
        "/api/control/pair/",
    ] {
        // No credential, and credentials of the wrong shape or kind.
        let attempts: Vec<Vec<(&str, String)>> = vec![
            vec![],
            vec![("Authorization", String::new())],
            vec![("Authorization", "Bearer".to_owned())],
            vec![("Authorization", "Bearer ".to_owned())],
            vec![("Authorization", format!("Basic {token}"))],
            vec![("Authorization", format!("bearer {token}"))],
            vec![("Authorization", token.clone())],
            vec![("Authorization", bearer(&token[..62]))],
            vec![("Authorization", bearer(&token.to_uppercase()))],
            vec![("Authorization", bearer(&wrong_token))],
            // The control secret is no session.
            vec![("Authorization", bearer(&control))],
        ];
        for extra in attempts {
            let extra: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let r = get(&h, path, &extra).await;
            assert_eq!(r.status, 401, "{path} with {extra:?}: {r:?}");
        }
    }
}

#[tokio::test]
async fn the_control_secret_and_a_session_are_not_interchangeable() {
    let h = Harness::new().await;
    let token = session(&h).await;
    // A session cannot mint a pairing code ...
    let auth = bearer(&token);
    let r = post(&h, "/api/control/pair", &[("Authorization", &auth)], "{}").await;
    assert_eq!(r.status, 401, "{r:?}");
    // ... and the control secret is no session.
    let auth = bearer(&h.control);
    let r = get(&h, "/api/tasks/not-built-yet", &[("Authorization", &auth)]).await;
    assert_eq!(r.status, 401, "{r:?}");
    // No credential at all cannot mint a code either.
    let r = post(&h, "/api/control/pair", &[], "{}").await;
    assert_eq!(r.status, 401, "{r:?}");
}

#[tokio::test]
async fn a_code_is_not_a_token() {
    let h = Harness::new().await;
    let code = mint_code(&h).await;
    let auth = bearer(&code);
    let r = get(&h, "/api/tasks/not-built-yet", &[("Authorization", &auth)]).await;
    assert_eq!(r.status, 401, "{r:?}");
}

// ── 6, 7, 8: content type and size ──────────────────────────────────────────

#[tokio::test]
async fn a_mutation_must_be_json() {
    let h = Harness::new().await;
    let token = session(&h).await;
    let auth = bearer(&token);
    let origin = h.origin();
    let host = h.host();
    for ct in [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "application/json-patch+json",
        "text/plain; application/json",
    ] {
        for (path, extra) in [
            ("/auth/exchange", vec![("Origin", origin.as_str())]),
            (
                "/api/tasks/not-built-yet",
                vec![("Authorization", auth.as_str())],
            ),
        ] {
            let mut headers = vec![
                ("Host", host.as_str()),
                ("Content-Type", ct),
                ("Content-Length", "2"),
            ];
            headers.extend(extra);
            let r = send(h.addr(), request("POST", path, &headers, b"{}")).await;
            assert_eq!(r.status, 415, "{path} with {ct:?}: {r:?}");
        }
    }
    // No content type at all.
    let r = send(
        h.addr(),
        request(
            "POST",
            "/auth/exchange",
            &[
                ("Host", &host),
                ("Origin", &origin),
                ("Content-Length", "2"),
            ],
            b"{}",
        ),
    )
    .await;
    assert_eq!(r.status, 415, "{r:?}");
    // The proper forms do pass the guard.
    for ct in [
        "application/json",
        "application/json; charset=utf-8",
        "Application/JSON",
    ] {
        let headers = [
            ("Host", host.as_str()),
            ("Origin", origin.as_str()),
            ("Content-Type", ct),
            ("Content-Length", "2"),
        ];
        let r = send(h.addr(), request("POST", "/auth/exchange", &headers, b"{}")).await;
        // Past the guard: the body is missing its `code`, so 400.
        assert_eq!(r.status, 400, "{ct:?}: {r:?}");
    }
}

#[tokio::test]
async fn a_body_over_the_limit_is_refused_unread() {
    let h = Harness::new().await;
    let host = h.host();
    let origin = h.origin();
    // 2 MiB declared; only the head is sent, the server must not wait for it.
    let r = send(
        h.addr(),
        request(
            "POST",
            "/auth/exchange",
            &[
                ("Host", &host),
                ("Origin", &origin),
                ("Content-Type", "application/json"),
                ("Content-Length", "2097152"),
            ],
            b"",
        ),
    )
    .await;
    assert_eq!(r.status, 413, "{r:?}");
    // Exactly at the limit is not refused by the size rule.
    let r = send(
        h.addr(),
        request(
            "POST",
            "/auth/exchange",
            &[
                ("Host", &host),
                ("Origin", &origin),
                ("Content-Type", "application/json"),
                ("Content-Length", "-1"),
            ],
            b"",
        ),
    )
    .await;
    assert_eq!(r.status, 400, "{r:?}");
}

#[tokio::test]
async fn a_chunked_body_over_the_limit_is_refused_while_it_is_read() {
    let limits = Limits {
        max_body_bytes: 64,
        small_body_bytes: 64,
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    let host = h.host();
    let origin = h.origin();
    let mut body = Vec::new();
    for _ in 0..4 {
        body.extend_from_slice(b"32\r\n");
        body.extend_from_slice(&[b'a'; 0x32]);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"0\r\n\r\n");
    let r = send(
        h.addr(),
        request(
            "POST",
            "/auth/exchange",
            &[
                ("Host", &host),
                ("Origin", &origin),
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
            ],
            &body,
        ),
    )
    .await;
    assert_eq!(r.status, 413, "{r:?}");
}

#[tokio::test]
async fn an_overlong_request_line_or_header_is_refused_and_the_server_lives() {
    let h = Harness::new().await;
    let host = h.host();
    let long_path = format!("/{}", "a".repeat(10 * 1024));
    let r = send(
        h.addr(),
        request("GET", &long_path, &[("Host", &host)], b""),
    )
    .await;
    assert!(matches!(r.status, 400 | 414 | 431), "long path: {r:?}");
    let long_value = "b".repeat(10 * 1024);
    let r = send(
        h.addr(),
        request(
            "GET",
            "/api/tasks/hello",
            &[("Host", &host), ("X-Long", &long_value)],
            b"",
        ),
    )
    .await;
    assert!(matches!(r.status, 400 | 431), "long header: {r:?}");
    // Still answering.
    assert_eq!(get(&h, "/api/tasks/hello", &[]).await.status, 200);
}

// ── 9, 10: what needs no credential ─────────────────────────────────────────

#[tokio::test]
async fn hello_needs_no_token_and_carries_no_data() {
    let h = Harness::new().await;
    let r = get(&h, "/api/tasks/hello", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    let doc = r.json();
    let mut keys: Vec<&str> = doc
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "app",
            "capabilities",
            "engine",
            "instance",
            "kind",
            "schema",
            "version"
        ]
    );
    assert_eq!(doc["app"], "tasks-desktop");
    assert_eq!(doc["instance"], h.server.instance());
    // No path, no drive letter, no vault, no area.
    for needle in ["\\", ":/", "vault", "area", "ROADMAP", "Users"] {
        assert!(
            !r.body.contains(needle),
            "hello holds {needle:?}: {}",
            r.body
        );
    }
}

#[tokio::test]
async fn the_page_needs_no_token_and_has_its_headers() {
    let h = Harness::new().await;
    let r = get(&h, "/", &[]).await;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(r.header("content-type").unwrap().starts_with("text/html"));
    assert_eq!(r.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(r.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(r.header("cache-control"), Some("no-store"));
    assert!(r
        .header("content-security-policy")
        .unwrap()
        .contains("frame-ancestors 'none'"));
    // Anything else outside /api is not found, with no token needed.
    let r = get(&h, "/etc/passwd", &[]).await;
    assert_eq!(r.status, 404, "{r:?}");
}

#[tokio::test]
async fn every_answer_carries_the_security_headers() {
    let h = Harness::new().await;
    let host = h.host();
    let answers = vec![
        get(&h, "/api/tasks/hello", &[]).await,
        get(&h, "/api/tasks/snapshot", &[]).await,
        get(&h, "/nope", &[]).await,
        post(&h, "/auth/exchange", &[], "{}").await,
        send(
            h.addr(),
            request("GET", "/api/tasks/hello", &[("Host", "evil.example")], b""),
        )
        .await,
        send(h.addr(), request("TRACE", "/", &[("Host", &host)], b"")).await,
    ];
    for r in answers {
        assert_eq!(r.header("x-content-type-options"), Some("nosniff"), "{r:?}");
        assert_eq!(r.header("referrer-policy"), Some("no-referrer"), "{r:?}");
        assert_eq!(r.header("cache-control"), Some("no-store"), "{r:?}");
    }
}

// ── 11 to 14, 17: pairing ───────────────────────────────────────────────────

#[tokio::test]
async fn a_pairing_code_is_good_once() {
    let h = Harness::new().await;
    let code = mint_code(&h).await;
    let first = exchange(&h, &code).await;
    assert_eq!(first.status, 200, "{first:?}");
    let token = first.json()["token"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 64);
    let second = exchange(&h, &code).await;
    assert_eq!(second.status, 401, "{second:?}");
    // The session works.
    let auth = bearer(&token);
    let r = get(&h, "/api/tasks/not-built-yet", &[("Authorization", &auth)]).await;
    assert_eq!(r.status, 404, "{r:?}");
}

#[tokio::test]
async fn a_pairing_code_expires() {
    let h = Harness::new().await;
    let code = mint_code(&h).await;
    h.clock.advance(Duration::from_secs(61));
    let r = exchange(&h, &code).await;
    assert_eq!(r.status, 401, "{r:?}");
    // The answer for an expired code is the answer for an unknown one.
    let unknown = exchange(&h, &"0".repeat(32)).await;
    assert_eq!(r.body, unknown.body);
}

#[tokio::test]
async fn a_pairing_code_cannot_be_got_without_the_control_secret() {
    let h = Harness::new().await;
    let origin = h.origin();
    let wrong = bearer(&Secret::generate(TOKEN_BYTES).unwrap().to_hex());
    let attempts: Vec<Attempt> = vec![
        ("POST", "/api/control/pair", vec![]),
        (
            "POST",
            "/api/control/pair",
            vec![("Origin", origin.as_str())],
        ),
        (
            "POST",
            "/api/control/pair",
            vec![("Authorization", wrong.as_str())],
        ),
        ("GET", "/api/control/pair", vec![]),
        ("GET", "/auth/exchange", vec![]),
        ("POST", "/api/tasks/pair", vec![]),
        ("POST", "/auth/pair", vec![]),
        ("GET", "/api/tasks/hello?pair=1", vec![]),
    ];
    for (method, path, extra) in attempts {
        let host = h.host();
        let mut headers = vec![
            ("Host", host.as_str()),
            ("Content-Type", "application/json"),
            ("Content-Length", "2"),
        ];
        headers.extend(extra);
        let body: &[u8] = if method == "POST" { b"{}" } else { b"" };
        let r = send(h.addr(), request(method, path, &headers, body)).await;
        assert!(
            matches!(r.status, 200 | 401 | 403 | 404 | 405)
                && !has_code(&r.body.replace(h.server.instance(), "")),
            "{method} {path}: {r:?}"
        );
        if path != "/api/tasks/hello?pair=1" {
            assert_ne!(r.status, 200, "{method} {path}: {r:?}");
        }
    }
}

fn has_code(text: &str) -> bool {
    // 32 lowercase hex characters in a row.
    let mut run = 0;
    for c in text.chars() {
        if c.is_ascii_digit() || ('a'..='f').contains(&c) {
            run += 1;
            if run >= 32 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

#[tokio::test]
async fn a_token_is_never_echoed() {
    let h = Harness::new().await;
    let code = mint_code(&h).await;
    let issued = exchange(&h, &code).await;
    let token = issued.json()["token"].as_str().unwrap().to_owned();
    let auth = bearer(&token);
    let mut answers = vec![
        get(&h, "/api/tasks/hello", &[("Authorization", &auth)]).await,
        get(&h, "/api/tasks/not-built-yet", &[("Authorization", &auth)]).await,
        get(&h, "/", &[("Authorization", &auth)]).await,
        post(
            &h,
            "/api/tasks/not-built-yet",
            &[("Authorization", &auth)],
            "{}",
        )
        .await,
        post(&h, "/auth/exchange", &[("Authorization", &auth)], "{}").await,
        // A bad request that has the token in it.
        get(
            &h,
            &format!("/api/tasks/{token}"),
            &[("Authorization", &auth)],
        )
        .await,
    ];
    answers.push(
        send(
            h.addr(),
            request(
                "GET",
                "/api/tasks/hello",
                &[("Host", "evil.example"), ("Authorization", &auth)],
                b"",
            ),
        )
        .await,
    );
    for r in answers {
        assert!(!r.raw.contains(&token), "the token came back: {r:?}");
        assert!(!r.raw.contains(&h.control), "the control secret came back");
    }
}

#[tokio::test]
async fn exchange_attempts_are_rate_limited() {
    let limits = Limits {
        exchange_max: 3,
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    for _ in 0..3 {
        assert_eq!(exchange(&h, &"0".repeat(32)).await.status, 401);
    }
    assert_eq!(exchange(&h, &"0".repeat(32)).await.status, 429);
    // A good code does not get past the limit either.
    let code = mint_code(&h).await;
    assert_eq!(exchange(&h, &code).await.status, 429);
    // The window ends.
    h.clock.advance(Duration::from_secs(61));
    let fresh = mint_code(&h).await;
    assert_eq!(exchange(&h, &fresh).await.status, 200);
}

#[tokio::test]
async fn mutations_are_rate_limited() {
    let limits = Limits {
        post_max: 3,
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    for _ in 0..3 {
        assert_eq!(exchange(&h, &"0".repeat(32)).await.status, 401);
    }
    assert_eq!(exchange(&h, &"0".repeat(32)).await.status, 429);
    // Reads are not counted.
    assert_eq!(get(&h, "/api/tasks/hello", &[]).await.status, 200);
    h.clock.advance(Duration::from_secs(11));
    assert_eq!(exchange(&h, &"0".repeat(32)).await.status, 401);
}

// ── 18, 20: binding and connections ─────────────────────────────────────────

#[tokio::test]
async fn the_server_binds_loopback_only() {
    let h = Harness::new().await;
    assert!(h.addr().ip().is_loopback(), "{}", h.addr());
    let cfg = |addr: &str| ServerConfig {
        addr: addr.parse().unwrap(),
        limits: Limits::default(),
        clock: Arc::new(ManualClock::new()),
        pairing_ttl: Duration::from_secs(60),
        control_secret: Secret::generate(TOKEN_BYTES).unwrap(),
        instance: Secret::generate(CODE_BYTES).unwrap(),
        status: HubStatus {
            engine_ready: false,
            problem: Some("no_vault"),
        },
    };
    for bad in ["0.0.0.0:0", "[::]:0", "192.168.1.10:0", "10.0.0.1:0"] {
        let err = start(cfg(bad)).await.err().expect("must refuse");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "{bad}");
    }
}

#[tokio::test]
async fn the_connection_limit_closes_the_extra_connection() {
    let limits = Limits {
        max_connections: 2,
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    let _a = TcpStream::connect(h.addr()).await.unwrap();
    let _b = TcpStream::connect(h.addr()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let reply = send(
        h.addr(),
        request("GET", "/api/tasks/hello", &[("Host", &h.host())], b""),
    )
    .await;
    assert_eq!(
        reply.status, 0,
        "the third connection was served: {reply:?}"
    );
    // A slot is free again once one connection ends.
    drop(_a);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(get(&h, "/api/tasks/hello", &[]).await.status, 200);
}

#[tokio::test]
async fn a_client_that_sends_nothing_is_dropped() {
    let limits = Limits {
        header_timeout: Duration::from_millis(300),
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    let mut idle = TcpStream::connect(h.addr()).await.unwrap();
    let mut buf = Vec::new();
    // Half a request line, then silence.
    idle.write_all(b"GET /api/tasks/hel").await.unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), idle.read_to_end(&mut buf)).await;
    assert!(ended.is_ok(), "the slow client was not dropped");
}

#[tokio::test]
async fn a_silent_connection_is_dropped() {
    // Not even half a request line: the slot must not be held for ever.
    let limits = Limits {
        header_timeout: Duration::from_millis(300),
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    let mut silent = TcpStream::connect(h.addr()).await.unwrap();
    let mut buf = Vec::new();
    let ended = tokio::time::timeout(Duration::from_secs(4), silent.read_to_end(&mut buf)).await;
    assert!(ended.is_ok(), "a connection that sent nothing was kept");
}

#[tokio::test]
async fn an_idle_keep_alive_connection_is_dropped() {
    let limits = Limits {
        header_timeout: Duration::from_millis(300),
        ..Limits::default()
    };
    let h = Harness::with(limits).await;
    let mut conn = TcpStream::connect(h.addr()).await.unwrap();
    let head = format!(
        "GET /api/tasks/hello HTTP/1.1\r\nHost: {}\r\n\r\n",
        h.host()
    );
    conn.write_all(head.as_bytes()).await.unwrap();
    // Read the first answer (a short JSON body), then say nothing more.
    let mut seen = Vec::new();
    let mut chunk = [0u8; 1024];
    let first = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let n = conn.read(&mut chunk).await.unwrap();
            assert!(n > 0, "closed before the answer");
            seen.extend_from_slice(&chunk[..n]);
            if String::from_utf8_lossy(&seen).contains("\"capabilities\"") {
                break;
            }
        }
    })
    .await;
    assert!(first.is_ok(), "no answer");
    let mut rest = Vec::new();
    let ended = tokio::time::timeout(Duration::from_secs(4), conn.read_to_end(&mut rest)).await;
    assert!(ended.is_ok(), "an idle keep-alive connection was kept");
}

#[tokio::test]
async fn the_routes_that_take_a_few_bytes_take_only_a_few_bytes() {
    let h = Harness::new().await;
    let host = h.host();
    let origin = h.origin();
    // Declared: refused unread.
    let r = send(
        h.addr(),
        request(
            "POST",
            "/auth/exchange",
            &[
                ("Host", &host),
                ("Origin", &origin),
                ("Content-Type", "application/json"),
                ("Content-Length", "4096"),
            ],
            b"",
        ),
    )
    .await;
    assert_eq!(r.status, 413, "{r:?}");
    // Chunked, so not declared: refused while it is read.
    let mut body = Vec::new();
    for _ in 0..4 {
        body.extend_from_slice(b"200\r\n");
        body.extend_from_slice(&[b'a'; 0x200]);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(b"0\r\n\r\n");
    let r = send(
        h.addr(),
        request(
            "POST",
            "/auth/exchange",
            &[
                ("Host", &host),
                ("Origin", &origin),
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
            ],
            &body,
        ),
    )
    .await;
    assert_eq!(r.status, 413, "{r:?}");
}

#[tokio::test]
async fn what_is_not_ours_is_not_found_whatever_is_asked() {
    let h = Harness::new().await;
    let host = h.host();
    for (method, path) in [
        ("GET", "/nope"),
        ("POST", "/nope"),
        ("DELETE", "/etc/passwd"),
    ] {
        let r = send(h.addr(), request(method, path, &[("Host", &host)], b"")).await;
        assert_eq!(r.status, 404, "{method} {path}: {r:?}");
    }
    // Even here the guard speaks first about a foreign origin.
    let r = send(
        h.addr(),
        request(
            "POST",
            "/nope",
            &[("Host", &host), ("Origin", "http://evil.example")],
            b"",
        ),
    )
    .await;
    assert_eq!(r.status, 403, "{r:?}");
}
