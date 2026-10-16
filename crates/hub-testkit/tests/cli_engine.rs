//! `CliEngine` against a fake Neovim: the properties that hold for any
//! engine process. The real engine is exercised in `real_engine.rs`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tasks_hub::config::Env;
use tasks_hub::engine::{probe, Calls, CliEngine, CliEngineConfig, Engine, EngineError, Method};

fn fake_nvim() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim"))
}

/// A vault folder that exists, so nothing depends on a real one.
fn vault() -> PathBuf {
    std::env::temp_dir()
}

fn config(env: Env) -> CliEngineConfig {
    CliEngineConfig {
        dialect: tasks_hub::engine::DIALECT,
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

/// A marker file name no other test uses, removed if it is left over.
fn marker(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "tasks-desktop-marker-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

/// Wait until `queued()` reaches `n`, or fail after a few seconds.
async fn wait_for_queued(engine: &CliEngine, n: usize) {
    for _ in 0..200 {
        if engine.queued() == n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("queued() never became {n}, it is {}", engine.queued());
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
        .call(Calls::List, Some(&params))
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
                .call(Calls::List, Some(&params))
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
    // The fake writes its marker after the wait: if the kill worked it never does.
    let ran_on = marker("killed");
    let params = fake(json!({ "sleep_ms": 1_500, "marker": ran_on }));
    let started = Instant::now();
    let err = engine
        .call(Calls::List, Some(&params))
        .await
        .expect_err("timeout");
    assert!(matches!(err, EngineError::Timeout), "{err}");
    assert!(started.elapsed() < Duration::from_secs(1));
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert!(!ran_on.exists(), "the killed process ran on");
    // The engine is usable afterwards: the gate was given back.
    let again = engine.call(Calls::Hello, None).await;
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
    for expected in 1..=2 {
        let inner = engine.clone();
        let slow = slow.clone();
        handles.push(tokio::spawn(async move {
            inner.call(Calls::List, Some(&slow)).await.map(|_| ())
        }));
        wait_for_queued(&engine, expected).await;
    }
    let err = engine
        .call(Calls::List, Some(&fake(json!({}))))
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
        .call(Calls::List, Some(&params))
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
            .call(Calls::List, Some(&params))
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
        .call(Calls::List, Some(&params))
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
        .call(Calls::List, Some(&params))
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
        .call(Calls::Ops, Some(&params))
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
        (Calls::Hello, Some(&obj)),
        (Calls::List, Some(&arr)),
        (Calls::Ops, None),
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
    assert_eq!(Calls::parse("snapshot"), Some(Calls::Snapshot));
    for name in [
        "",
        "SNAPSHOT",
        "snapshot ",
        "../snapshot",
        "eval",
        "frobnicate",
    ] {
        assert_eq!(Calls::parse(name), None, "{name:?}");
    }
}

#[tokio::test]
async fn a_write_runs_to_its_end_when_the_caller_gives_up() {
    let engine = CliEngine::new(config(Env::from_process()));
    let done = marker("write-survives");
    let request = json!({ "schema": 1, "ops": [], "fake": { "sleep_ms": 400, "marker": done } });
    // The caller is dropped while the child is running: that must not kill it.
    let call = engine.call(Calls::Ops, Some(&request));
    let outcome = tokio::time::timeout(Duration::from_millis(100), call).await;
    assert!(outcome.is_err(), "the call should still be waiting");
    wait_for_queued(&engine, 0).await;
    assert!(done.exists(), "the write was cut off with its caller");
}

#[tokio::test]
async fn a_read_nobody_waits_for_is_never_started() {
    let engine = CliEngine::new(config(Env::from_process()));
    let blocker = fake(json!({ "sleep_ms": 600 }));
    let first = engine.call(Calls::List, Some(&blocker));
    let never = marker("abandoned-read");
    let params = fake(json!({ "marker": never }));
    let second = engine.call(Calls::List, Some(&params));
    // Start both so both hold a place, then drop the second while it waits.
    let (_, outcome) = tokio::join!(first, async {
        wait_for_queued(&engine, 1).await;
        tokio::time::timeout(Duration::from_millis(100), second).await
    });
    assert!(outcome.is_err());
    wait_for_queued(&engine, 0).await;
    assert!(!never.exists(), "an abandoned read was run");
}

#[tokio::test]
async fn a_dry_run_nobody_waits_for_is_never_started() {
    let engine = CliEngine::new(config(Env::from_process()));
    let blocker = fake(json!({ "sleep_ms": 600 }));
    let first = engine.call(Calls::List, Some(&blocker));
    let never = marker("abandoned-dry-run");
    let request = json!({ "schema": 1, "dry_run": true, "ops": [], "fake": { "marker": never } });
    let second = engine.call(Calls::Ops, Some(&request));
    let (_, outcome) = tokio::join!(first, async {
        wait_for_queued(&engine, 1).await;
        tokio::time::timeout(Duration::from_millis(100), second).await
    });
    assert!(outcome.is_err());
    wait_for_queued(&engine, 0).await;
    assert!(!never.exists(), "an abandoned dry run was run");
}

#[tokio::test]
async fn a_dry_run_that_fails_is_a_plain_failure() {
    let engine = CliEngine::new(config(Env::from_process()));
    let request = json!({ "schema": 1, "dry_run": true, "ops": [], "fake": { "exit": 3 } });
    let err = engine
        .call(Calls::Ops, Some(&request))
        .await
        .expect_err("failed");
    assert!(!matches!(err, EngineError::OutcomeUnknown(_)), "{err}");
}

#[tokio::test]
async fn a_write_that_does_not_end_with_a_document_has_an_unknown_outcome() {
    let engine = CliEngine::new(config(Env::from_process()));
    let request = json!({ "schema": 1, "ops": [], "fake": { "exit": 3 } });
    let err = engine
        .call(Calls::Ops, Some(&request))
        .await
        .expect_err("failed");
    assert!(matches!(err, EngineError::OutcomeUnknown(_)), "{err}");

    // The same failure of a read is a plain failure.
    let params = fake(json!({ "exit": 3 }));
    let err = engine
        .call(Calls::List, Some(&params))
        .await
        .expect_err("failed");
    assert!(matches!(err, EngineError::Failed { .. }), "{err}");

    // A refusal is the engine's own answer: nothing was written, say so.
    let request = json!({ "schema": 1, "ops": [], "fake": { "error": "invalid_argument" } });
    let err = engine
        .call(Calls::Ops, Some(&request))
        .await
        .expect_err("refused");
    assert!(matches!(err, EngineError::Refused(_)), "{err}");
}

#[tokio::test]
async fn a_write_that_times_out_has_an_unknown_outcome() {
    let mut cfg = config(Env::from_process());
    cfg.timeout = Duration::from_millis(300);
    let engine = CliEngine::new(cfg);
    let request = json!({ "schema": 1, "ops": [], "fake": { "sleep_ms": 5_000 } });
    let err = engine
        .call(Calls::Ops, Some(&request))
        .await
        .expect_err("timeout");
    assert!(matches!(err, EngineError::OutcomeUnknown(_)), "{err}");
}

#[tokio::test]
async fn a_program_that_does_not_start_is_not_an_unknown_outcome() {
    let mut cfg = config(Env::from_process());
    cfg.nvim = std::env::temp_dir().join("tasks-desktop-no-such-program.exe");
    let engine = CliEngine::new(cfg);
    let request = json!({ "schema": 1, "ops": [] });
    let err = engine
        .call(Calls::Ops, Some(&request))
        .await
        .expect_err("spawn");
    // Nothing ran, so nothing can have been written.
    assert!(matches!(err, EngineError::Spawn(_)), "{err}");
}

#[tokio::test]
async fn a_request_over_the_engine_limit_is_refused_before_a_process_starts() {
    let mut cfg = config(Env::from_process());
    // If a process were started the program would not exist.
    cfg.nvim = std::env::temp_dir().join("tasks-desktop-no-such-program.exe");
    let engine = CliEngine::new(cfg);
    // Non-ASCII characters grow sixfold as escapes: 50 000 of them pass 256 KiB.
    let params = json!({ "title": "\u{e4}".repeat(50_000) });
    let err = engine
        .call(Calls::Ops, Some(&params))
        .await
        .expect_err("too large");
    assert!(matches!(err, EngineError::BadRequest(_)), "{err}");
}

#[tokio::test]
async fn an_answer_is_returned_without_its_line_ending() {
    let engine = CliEngine::new(config(Env::from_process()));
    let reply = engine.call(Calls::Hello, None).await.expect("hello");
    assert!(!reply.text.ends_with('\n') && !reply.text.ends_with('\r'));
    assert!(reply.text.starts_with('{') && reply.text.ends_with('}'));
}

/// A vault folder of its own (the fake reads `.fake-check-ms` in it), and an engine on it with `timeout`.
fn check_engine(name: &str, timeout: Duration) -> (CliEngine, PathBuf) {
    let dir =
        std::env::temp_dir().join(format!("tasks-desktop-check-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = config(Env::from_process());
    cfg.vault = dir.clone();
    cfg.timeout = timeout;
    (CliEngine::new(cfg), dir)
}

#[tokio::test]
async fn a_check_may_take_ten_times_the_usual_time() {
    let (engine, dir) = check_engine("factor", Duration::from_millis(500));
    std::fs::write(dir.join(".fake-check-ms"), "1200").unwrap();
    // 1.2 s is more than the usual 0.5 s ...
    let check = engine.call(Calls::Check, Some(&json!({}))).await;
    assert!(check.is_ok(), "{check:?}");
    assert!(dir.join(".fake-check-done").exists());
    // ... and a question of the usual kind is not given that long.
    std::fs::write(dir.join(".fake-task-ms"), "1200").unwrap();
    let task = engine
        .call(Calls::Task, Some(&json!({ "id": "a/b" })))
        .await;
    assert!(matches!(task, Err(EngineError::Timeout)), "{task:?}");
}

#[tokio::test]
async fn a_check_that_is_given_up_is_stopped_with_its_process() {
    let (engine, dir) = check_engine("given-up", Duration::from_secs(10));
    std::fs::write(dir.join(".fake-check-ms"), "1500").unwrap();
    let engine = std::sync::Arc::new(engine);
    let runner = std::sync::Arc::clone(&engine);
    let job = tokio::spawn(async move { runner.call(Calls::Check, Some(&json!({}))).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    job.abort();
    let _ = job.await;
    // The process would have finished by now, and left its mark, if it had been left to run.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(
        !dir.join(".fake-check-done").exists(),
        "the check ran on after its caller was given up"
    );
    // The place is free again.
    wait_for_queued(&engine, 0).await;
}
