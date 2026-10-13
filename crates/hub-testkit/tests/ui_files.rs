//! The interface files: served from a table by name, with the headers of the
//! page, and nothing else is reachable through them.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use app_core::authn::{ManualClock, Secret, CODE_BYTES, TOKEN_BYTES};
use tasks_hub::classes::AreaPolicy;
use tasks_hub::client;
use tasks_hub::server::{start, HubStatus, Limits, RunningServer, ServerConfig};
use tasks_hub::ui::UiFiles;

fn build_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tasks-desktop-uifiles-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>ui</title>").unwrap();
    std::fs::write(dir.join("assets").join("app-1.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("assets").join("app-1.css"), "body{}").unwrap();
    // Next to the build, but not part of it.
    std::fs::write(dir.join("secret.txt"), "no").unwrap();
    dir
}

async fn hub(ui: UiFiles) -> RunningServer {
    start(ServerConfig {
        addr: "127.0.0.1:0".parse().unwrap(),
        limits: Limits::default(),
        clock: Arc::new(ManualClock::new()),
        pairing_ttl: Duration::from_secs(60),
        control_secret: Secret::generate(TOKEN_BYTES).unwrap(),
        instance: Secret::generate(CODE_BYTES).unwrap(),
        status: HubStatus {
            engine_ready: false,
            problem: None,
            capabilities: Vec::new(),
        },
        engine: None,
        policy: Arc::new(AreaPolicy::default()),
        ui,
        usage: None,
        watch: None,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn the_page_and_its_assets_are_served_with_the_page_headers() {
    let dir = build_dir("serve");
    let server = hub(UiFiles::load(&dir).unwrap()).await;
    let port = server.addr().port();

    let page = client::request(port, "GET", "/", &[], "").await.unwrap();
    assert_eq!(page.status, 200);
    assert!(page.body.contains("<title>ui</title>"));
    let csp = page.header("content-security-policy").expect("a CSP");
    assert!(csp.contains("script-src 'self'"), "{csp}");
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(csp.contains("default-src 'none'"), "{csp}");
    assert!(csp.contains("require-trusted-types-for 'script'"), "{csp}");
    assert!(csp.contains("trusted-types svelte-trusted-html"), "{csp}");
    assert!(
        !csp.contains("unsafe-inline") && !csp.contains("unsafe-eval"),
        "{csp}"
    );
    assert_eq!(
        page.header("cross-origin-opener-policy"),
        Some("same-origin")
    );
    assert_eq!(page.header("cache-control"), Some("no-store"));

    let js = client::request(port, "GET", "/assets/app-1.js", &[], "")
        .await
        .unwrap();
    assert_eq!(js.status, 200);
    assert!(js
        .header("content-type")
        .is_some_and(|t| t.starts_with("text/javascript")));
    assert_eq!(js.header("x-content-type-options"), Some("nosniff"));
    assert!(js.header("content-security-policy").is_some());

    let css = client::request(port, "GET", "/assets/app-1.css", &[], "")
        .await
        .unwrap();
    assert_eq!(css.status, 200);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn nothing_outside_the_table_is_reachable() {
    let dir = build_dir("table");
    let server = hub(UiFiles::load(&dir).unwrap()).await;
    let port = server.addr().port();
    for path in [
        "/assets/missing.js",
        "/assets/secret.txt",
        "/secret.txt",
        "/assets/..%2Fsecret.txt",
        "/assets/%2e%2e/secret.txt",
        "/assets/../secret.txt",
        "/assets/",
        "/index.htm",
    ] {
        let r = client::request(port, "GET", path, &[], "").await.unwrap();
        assert_eq!(r.status, 404, "{path}: {r:?}");
    }
    // A write to a file is not a thing.
    let r = client::request(
        port,
        "POST",
        "/assets/app-1.js",
        &[("Content-Type", "application/json")],
        "{}",
    )
    .await
    .unwrap();
    assert!(r.status == 405 || r.status == 403, "{r:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn without_an_interface_there_is_a_placeholder_and_no_assets() {
    let server = hub(UiFiles::none()).await;
    let port = server.addr().port();
    let page = client::request(port, "GET", "/", &[], "").await.unwrap();
    assert_eq!(page.status, 200);
    assert!(page.body.contains("not built yet"));
    let asset = client::request(port, "GET", "/assets/app.js", &[], "")
        .await
        .unwrap();
    assert_eq!(asset.status, 404);
}

#[test]
fn the_interface_in_the_binary_is_the_build_there_is() {
    let index = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("ui")
        .join("dist")
        .join("index.html");
    let embedded = UiFiles::embedded();
    assert_eq!(embedded.has_index(), index.is_file());
    if embedded.has_index() {
        let page = embedded.get("/").expect("the page");
        assert!(page.content_type.starts_with("text/html"));
        // The page names its scripts under /assets/, and they are there.
        let html = String::from_utf8_lossy(&page.bytes).into_owned();
        let src = html
            .split("src=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("a script");
        let name = src.trim_start_matches("./");
        assert!(embedded.get(&format!("/{name}")).is_some(), "{src}");
    }
}
