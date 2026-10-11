//! `CliEngine` against a fake Neovim: the properties that hold for any
//! engine process. The real engine is exercised in `real_engine.rs`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tasks_hub::config::Env;
use tasks_hub::engine::{probe, CliEngine, CliEngineConfig, Engine, EngineError, Method};

fn fake_nvim() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim"))
}

/// A vault folder that exists, so nothing depends on a real one.
fn vault() -> PathBuf {
    std::env::temp_dir()
}

fn config(env: Env) -> CliEngineConfig {
    CliEngineConfig {
        nvim: fake_nvim(),
        script: vault().join("scripts").join("tasks.lua"),
        vault: vault(),
        lib_dir: None,
        extra_areas: vec!["ALL".to_owned()],
        env,
        timeout: Duration::from_secs(10),
        max_queue: 8,
        max_reply_bytes: 64 * 1024,
    }
}

fn fake(value: Value) -> Value {
    json!({ "fake": value })
}

#[tokio::test]
async fn hello_is_probed_without_parameters() {
    let engine = CliEngine::new(config(Env::from_process()));
    let info = probe(&engine).await.expect("probe");
    assert_eq!(info.schemas, vec![1]);
    assert!(info.capabilities.iter().any(|c| c == "snapshot"));
}

#[tokio::test]
async fn the_child_gets_only_the_allow_listed_environment() {
    let env = Env::from_pairs([
        ("PATH", "C:/bin"),
        ("SystemRoot", "C:/Windows"),
        ("ANTHROPIC_API_KEY", "sk-secret"),
        ("TASKS_TRUST_VAULT_LINT", "1"),
        ("TASKS_MARKER_DOCS", "1"),
        ("TASKS_VAULT", "C:/from/the/environment"),
        ("RANDOM_THING", "x"),
    ]);
    let engine = CliEngine::new(config(env));
    let params = fake(json!({ "echo_env": true }));
    let reply = engine
        .call(Method::List, Some(&params))
        .await
        .expect("answer");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    let names: Vec<&str> = doc["env"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for forbidden in [
        "ANTHROPIC_API_KEY",
        "TASKS_TRUST_VAULT_LINT",
        "TASKS_MARKER_DOCS",
        "RANDOM_THING",
    ] {
        assert!(!names.contains(&forbidden), "{forbidden} leaked: {names:?}");
    }
    assert!(names.contains(&"PATH"), "{names:?}");
    // The vault and the extra areas come from the settings, not the environment.
    assert!(names.contains(&"TASKS_VAULT"));
    assert!(names.contains(&"TASKS_EXTRA_AREAS"));
}

#[tokio::test]
async fn exactly_one_question_is_in_flight() {
    let engine = std::sync::Arc::new(CliEngine::new(config(Env::from_process())));
    let mut handles = Vec::new();
    for _ in 0..4 {
        let engine = engine.clone();
        handles.push(tokio::spawn(async move {
            let params = fake(json!({ "sleep_ms": 150, "stamp": true }));
            let reply = engine
                .call(Method::List, Some(&params))
                .await
                .expect("answer");
            let doc: Value = serde_json::from_str(&reply.text).unwrap();
            (
                doc["started_ms"].as_u64().unwrap(),
                doc["ended_ms"].as_u64().unwrap(),
            )
        }));
    }
    let mut spans = Vec::new();
    for h in handles {
        spans.push(h.await.unwrap());
    }
    spans.sort_unstable();
    for pair in spans.windows(2) {
        assert!(
            pair[0].1 <= pair[1].0,
            "two questions overlapped: {:?} and {:?}",
            pair[0],
            pair[1]
        );
    }
}

#[tokio::test]
async fn a_question_that_takes_too_long_is_killed() {
    let mut cfg = config(Env::from_process());
    cfg.timeout = Duration::from_millis(400);
    let engine = CliEngine::new(cfg);
    let params = fake(json!({ "sleep_ms": 20_000 }));
    let started = Instant::now();
    let err = engine
        .call(Method::List, Some(&params))
        .await
        .expect_err("timeout");
    assert!(matches!(err, EngineError::Timeout), "{err}");
    assert!(started.elapsed() < Duration::from_secs(5));
    // The engine is usable afterwards: the gate was given back.
    let again = engine.call(Method::Hello, None).await;
    assert!(again.is_ok(), "{again:?}");
}

#[tokio::test]
async fn a_full_queue_says_busy() {
    let mut cfg = config(Env::from_process());
    cfg.max_queue = 1;
    let engine = std::sync::Arc::new(CliEngine::new(cfg));
    let slow = fake(json!({ "sleep_ms": 800 }));
    let mut handles = Vec::new();
    // One in flight and one waiting fill the engine; the next ones are refused.
    for _ in 0..2 {
        let engine = engine.clone();
        let slow = slow.clone();
        handles.push(tokio::spawn(async move {
            engine.call(Method::List, Some(&slow)).await.map(|_| ())
        }));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let err = engine
        .call(Method::List, Some(&fake(json!({}))))
        .await
        .expect_err("busy");
    assert!(matches!(err, EngineError::Busy), "{err}");
    for h in handles {
        h.await.unwrap().expect("the queued questions are answered");
    }
}

#[tokio::test]
async fn an_error_document_is_a_refusal_with_its_code() {
    let engine = CliEngine::new(config(Env::from_process()));
    let params = fake(json!({ "error": "invalid_argument" }));
    let err = engine
        .call(Method::List, Some(&params))
        .await
        .expect_err("refusal");
    match err {
        EngineError::Refused(r) => {
            assert_eq!(r.code, "invalid_argument");
            assert!(!r.retryable);
            assert!(r.text.contains("tasks.error"));
        }
        other => panic!("{other}"),
    }
}

#[tokio::test]
async fn a_wrong_kind_or_schema_is_a_protocol_error() {
    let engine = CliEngine::new(config(Env::from_process()));
    for params in [
        fake(json!({ "kind": "tasks.snapshot" })),
        fake(json!({ "schema": 2 })),
    ] {
        let err = engine
            .call(Method::List, Some(&params))
            .await
            .expect_err("protocol");
        assert!(matches!(err, EngineError::Protocol(_)), "{err}");
    }
}

#[tokio::test]
async fn a_process_without_a_document_fails_and_leaks_no_path() {
    let engine = CliEngine::new(config(Env::from_process()));
    let params = fake(json!({ "exit": 3 }));
    let err = engine
        .call(Method::List, Some(&params))
        .await
        .expect_err("failed");
    match err {
        EngineError::Failed { code, detail } => {
            assert_eq!(code, Some(3));
            let vault = vault().display().to_string();
            assert!(!detail.contains(&vault), "{detail}");
            assert!(detail.contains("<path>"), "{detail}");
        }
        other => panic!("{other}"),
    }
}

#[tokio::test]
async fn an_answer_over_the_limit_is_refused() {
    let engine = CliEngine::new(config(Env::from_process()));
    let params = fake(json!({ "huge": 200_000 }));
    let err = engine
        .call(Method::List, Some(&params))
        .await
        .expect_err("too large");
    assert!(matches!(err, EngineError::Protocol(_)), "{err}");
}

#[tokio::test]
async fn stdin_is_printable_ascii_whatever_the_text_holds() {
    let engine = CliEngine::new(config(Env::from_process()));
    let title = "K\u{e4}se \u{1f600}\r\nzwei\u{1a}drei\ttab";
    let params = json!({ "title": title, "fake": { "echo_stdin": true } });
    let reply = engine
        .call(Method::Ops, Some(&params))
        .await
        .expect("answer");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    let bytes: Vec<u8> = doc["stdin_bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| u8::try_from(b.as_u64().unwrap()).unwrap())
        .collect();
    assert!(
        bytes.iter().all(|b| (0x20..0x7f).contains(b)),
        "text mode would change these bytes: {bytes:?}"
    );
    let back: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(back["title"], title);
}

#[tokio::test]
async fn requests_the_hub_would_never_send_are_refused_before_a_process_starts() {
    let engine = CliEngine::new(config(Env::from_process()));
    let obj = json!({});
    let arr = json!([1, 2]);
    let cases: [(Method, Option<&Value>); 3] = [
        (Method::Hello, Some(&obj)),
        (Method::List, Some(&arr)),
        (Method::Ops, None),
    ];
    for (method, params) in cases {
        let err = engine.call(method, params).await.expect_err("bad request");
        assert!(
            matches!(err, EngineError::BadRequest(_)),
            "{method:?}: {err}"
        );
    }
}

#[test]
fn only_the_listed_methods_exist() {
    assert_eq!(Method::parse("snapshot"), Some(Method::Snapshot));
    for name in ["", "SNAPSHOT", "snapshot ", "../snapshot", "eval", "check"] {
        assert_eq!(Method::parse(name), None, "{name:?}");
    }
}
