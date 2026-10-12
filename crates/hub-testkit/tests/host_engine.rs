//! The persistent engine (stage P8): the same questions, the same answers,
//! one process; and what happens when that process is not there.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tasks_hub::config::Env;
use tasks_hub::engine::{CliEngine, CliEngineConfig, Engine, EngineError, Method};

fn vault(name: &str) -> PathBuf {
    let vault =
        std::env::temp_dir().join(format!("tasks-desktop-host-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&vault);
    std::fs::create_dir_all(vault.join("scripts")).unwrap();
    // The host script has to be there; the fake does not read it.
    std::fs::write(vault.join("scripts").join("tasks-host.lua"), "").unwrap();
    std::fs::write(vault.join(".fake-n"), "2").unwrap();
    vault
}

fn config(vault: &Path, timeout: Duration) -> CliEngineConfig {
    CliEngineConfig {
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-nvim")),
        script: vault.join("scripts").join("tasks.lua"),
        vault: vault.to_path_buf(),
        lib_dir: None,
        extra_areas: vec![],
        env: Env::from_process(),
        timeout,
        max_queue: 16,
        max_reply_bytes: 4 * 1024 * 1024,
    }
}

fn starts(vault: &Path) -> usize {
    std::fs::read_to_string(vault.join(".fake-host-starts"))
        .map(|t| t.lines().count())
        .unwrap_or(0)
}

fn pid(vault: &Path) -> u32 {
    std::fs::read_to_string(vault.join(".fake-host-pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn alive(pid: u32) -> bool {
    let out = if cfg!(windows) {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap()
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
    };
    if cfg!(windows) {
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    } else {
        out.status.success()
    }
}

async fn wait_gone(pid: u32) -> bool {
    for _ in 0..50 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn many_questions_one_process_and_the_same_documents() {
    let dir = vault("same");
    let host = CliEngine::with_host(config(&dir, Duration::from_secs(10)));
    let process = CliEngine::new(config(&dir, Duration::from_secs(10)));

    for method in [Method::Hello, Method::Snapshot, Method::Areas] {
        let a = host.call(method, None).await.unwrap();
        let b = process.call(method, None).await.unwrap();
        assert_eq!(a, b, "{}", method.as_str());
    }
    let params = json!({ "id": "alpha.nvim/t1" });
    let a = host.call(Method::Task, Some(&params)).await.unwrap();
    let b = process.call(Method::Task, Some(&params)).await.unwrap();
    assert_eq!(a, b);
    // The engine's own refusal comes through as a refusal.
    let refused = host
        .call(Method::Task, Some(&json!({ "id": "alpha.nvim/missing" })))
        .await;
    assert!(matches!(refused, Err(EngineError::Refused(r)) if r.code == "not_found"));

    assert_eq!(starts(&dir), 1, "five questions, one host");
    assert!(host.host_running().await);
    let host_pid = pid(&dir);
    drop(host);
    assert!(
        wait_gone(host_pid).await,
        "the host ends with the engine that started it"
    );
}

#[tokio::test]
async fn a_host_that_crashes_on_a_read_is_replaced_and_the_read_is_asked_again() {
    let dir = vault("crash-read");
    let host = CliEngine::with_host(config(&dir, Duration::from_secs(10)));
    host.call(Method::Hello, None).await.unwrap();
    assert_eq!(starts(&dir), 1);

    // The host dies with this question; the answer comes from a process.
    let crash = json!({ "fake": { "host_exit": 1 } });
    let reply = host.call(Method::Next, Some(&crash)).await.unwrap();
    assert_eq!(reply.kind, "tasks.next");
    // The next question starts a new host.
    host.call(Method::Snapshot, None).await.unwrap();
    assert_eq!(starts(&dir), 2);
    assert!(host.host_running().await);
}

#[tokio::test]
async fn a_host_that_crashes_on_a_write_leaves_the_outcome_open() {
    let dir = vault("crash-write");
    let host = CliEngine::with_host(config(&dir, Duration::from_secs(10)));
    host.call(Method::Hello, None).await.unwrap();

    let crash = json!({ "fake": { "host_exit": 1 }, "ops": [] });
    let err = host.call(Method::Ops, Some(&crash)).await.unwrap_err();
    assert!(
        matches!(err, EngineError::OutcomeUnknown(_)),
        "a write that was sent and not answered is not asked again: {err}"
    );
    // And the engine is usable afterwards.
    assert!(host.call(Method::Hello, None).await.is_ok());
    assert_eq!(starts(&dir), 2);
}

#[tokio::test]
async fn a_question_that_hangs_kills_the_host_and_is_a_timeout() {
    let dir = vault("hang");
    let host = CliEngine::with_host(config(&dir, Duration::from_millis(700)));
    host.call(Method::Hello, None).await.unwrap();
    let first = pid(&dir);

    let hang = json!({ "fake": { "host_hang": 1 } });
    let err = host.call(Method::Next, Some(&hang)).await.unwrap_err();
    assert!(matches!(err, EngineError::Timeout), "{err}");
    assert!(wait_gone(first).await, "the hung host was killed");
    // A write that times out is open, not failed.
    let err = host
        .call(
            Method::Ops,
            Some(&json!({ "fake": { "host_hang": 1 }, "ops": [] })),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, EngineError::OutcomeUnknown(_)), "{err}");

    assert!(host.call(Method::Hello, None).await.is_ok());
}

#[tokio::test]
async fn a_host_that_cannot_start_is_left_alone_and_the_process_way_answers() {
    let dir = vault("broken");
    std::fs::write(dir.join(".fake-host-broken"), "").unwrap();
    let host = CliEngine::with_host(config(&dir, Duration::from_secs(10)));

    for _ in 0..6 {
        let reply = host.call(Method::Snapshot, None).await.unwrap();
        assert_eq!(reply.kind, "tasks.snapshot");
    }
    // Three failures in a row and the host is not tried again for a while.
    assert_eq!(starts(&dir), 3);
    assert!(!host.host_running().await);
}

#[tokio::test]
async fn an_engine_without_a_host_script_asks_one_process_per_question() {
    let dir = vault("no-script");
    std::fs::remove_file(dir.join("scripts").join("tasks-host.lua")).unwrap();
    let host = CliEngine::with_host(config(&dir, Duration::from_secs(10)));
    host.call(Method::Hello, None).await.unwrap();
    assert_eq!(starts(&dir), 0);
    assert!(!host.host_running().await);
}

#[tokio::test]
async fn a_host_that_was_killed_from_outside_is_replaced_without_an_error() {
    let dir = vault("killed");
    let host = CliEngine::with_host(config(&dir, Duration::from_secs(10)));
    host.call(Method::Hello, None).await.unwrap();
    let first = pid(&dir);

    let status = if cfg!(windows) {
        std::process::Command::new("taskkill")
            .args(["/PID", &first.to_string(), "/F"])
            .output()
            .unwrap()
            .status
    } else {
        std::process::Command::new("kill")
            .args(["-9", &first.to_string()])
            .status()
            .unwrap()
    };
    assert!(status.success());
    assert!(wait_gone(first).await);

    // Not an error for the caller, not even for a write: nothing was sent.
    let reply = host.call(Method::Snapshot, None).await.unwrap();
    assert_eq!(reply.kind, "tasks.snapshot");
    assert_eq!(starts(&dir), 2);
    assert_ne!(pid(&dir), first);
}
