//! A stand-in for `nvim --headless -u NONE -l scripts/tasks.lua call <method>`.
//!
//! It answers like the engine would, and does what the request under
//! `"fake"` asks it to, so a test can make it slow, noisy, wrong or loud:
//!
//! * `sleep_ms`: wait before answering;
//! * `stamp`: put `started_ms` and `ended_ms` (since the epoch) in the answer;
//! * `echo_env`: put the names of its environment in the answer;
//! * `echo_stdin`: put the bytes it received on stdin in the answer;
//! * `error`: answer with a `tasks.error` of that code;
//! * `kind`, `schema`: answer with another kind or schema than asked for;
//! * `marker`: write this file after the wait, so a test can tell that the
//!   process ran to the end (or that it never started);
//! * `exit`: print nothing but a line on stderr and end with this status;
//! * `huge`: answer with a string of this many bytes.

use std::io::{Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tasks_hub::engine::Method;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("NVIM v0.12.2");
        return;
    }
    if args.iter().any(|a| a.ends_with("tasks-host.lua")) {
        host_loop();
        return;
    }
    let started = now_ms();
    let Some(call) = args.iter().position(|a| a == "call") else {
        eprintln!("fake-nvim: no call");
        std::process::exit(2);
    };
    let method = args.get(call + 1).cloned().unwrap_or_default();
    let with_params = args.iter().any(|a| a == "--params=-");

    let mut raw = Vec::new();
    if with_params {
        let _ = std::io::stdin().read_to_end(&mut raw);
    }
    let doc = respond(&method, &raw, started);
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{doc}");
}

/// The persistent host: `nvim -l scripts/tasks-host.lua`. It says `ready`,
/// then answers one line per request (`<id>\t<method>\t<params>`) with
/// `<id>\t<document>`, until its stdin ends. A `fake.exit` in a request ends
/// the process on the spot (a crash); `fake.hang` never answers.
fn host_loop() {
    use std::io::BufRead;
    let vault = std::env::var("TASKS_VAULT").unwrap_or_default();
    // `<vault>/.fake-host-starts` counts how often a host was started.
    if let Ok(mut starts) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::path::Path::new(&vault).join(".fake-host-starts"))
    {
        let _ = writeln!(starts, "start");
    }
    // `<vault>/.fake-host-broken` makes the host fail before it is ready.
    if std::path::Path::new(&vault)
        .join(".fake-host-broken")
        .exists()
    {
        eprintln!("fake host: broken");
        std::process::exit(3);
    }
    // `<vault>/.fake-host-pid` names the host that was started last.
    let _ = std::fs::write(
        std::path::Path::new(&vault).join(".fake-host-pid"),
        std::process::id().to_string(),
    );
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "ready\t1");
    let _ = out.flush();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let mut parts = line.splitn(3, '\t');
        let (Some(id), Some(method), params) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let raw = params.unwrap_or("").as_bytes();
        let fake = serde_json::from_slice::<Value>(raw)
            .ok()
            .and_then(|v| v.get("fake").cloned())
            .unwrap_or(Value::Null);
        // Only a host crashes or hangs on these (the process way, which the
        // caller falls back to, answers the same request).
        if fake.get("host_exit").is_some() {
            eprintln!("fake host: crashed");
            std::process::exit(5);
        }
        if fake.get("host_hang").is_some() {
            std::thread::sleep(Duration::from_secs(3600));
        }
        let doc = respond(method, raw, now_ms());
        let _ = writeln!(out, "{id}\t{doc}");
        let _ = out.flush();
    }
}

/// The answer of the fake engine to one request.
fn respond(method: &str, raw: &[u8], started: u64) -> Value {
    let params: Value = if raw.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(raw).unwrap_or(Value::Null)
    };
    let fake = params.get("fake").cloned().unwrap_or(Value::Null);

    // `<vault>/.fake-task-ms` makes a `task` read take that long, and every
    // such read is counted in `<vault>/.fake-task-calls` when it starts: a
    // test that cannot put a `fake` into the request (the routes build their
    // own) can still see which reads ran.
    if method == "task" {
        let vault = std::env::var("TASKS_VAULT").unwrap_or_default();
        let base = std::path::Path::new(&vault);
        if let Ok(text) = std::fs::read_to_string(base.join(".fake-task-ms")) {
            use std::io::Write as _;
            if let Ok(mut calls) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(base.join(".fake-task-calls"))
            {
                let _ = writeln!(calls, "task");
            }
            std::thread::sleep(Duration::from_millis(text.trim().parse().unwrap_or(0)));
        }
    }
    if let Some(ms) = fake.get("sleep_ms").and_then(Value::as_u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
    if let Some(path) = fake.get("marker").and_then(Value::as_str) {
        let _ = std::fs::write(path, b"ran");
    }
    if let Some(code) = fake.get("exit").and_then(Value::as_i64) {
        eprintln!(
            "fake-nvim failed in {}",
            std::env::var("TASKS_VAULT").unwrap_or_default()
        );
        std::process::exit(i32::try_from(code).unwrap_or(1));
    }

    let kind = fake.get("kind").and_then(Value::as_str).map_or_else(
        || {
            Method::parse(method)
                .map_or("tasks.unknown", Method::reply_kind)
                .to_owned()
        },
        str::to_owned,
    );
    let schema = fake.get("schema").and_then(Value::as_u64).unwrap_or(1);
    let mut doc = json!({
        "schema": schema,
        "plugin": "tasks.nvim",
        "kind": kind,
        "generated_at": "2026-01-01T00:00:00Z",
        "vault": {"id": "vault"},
        "engine": {"version": "0.0.0-fake", "git": "0000000", "nvim": "0.12.2"},
    });
    if let Some(code) = fake.get("error").and_then(Value::as_str) {
        doc["kind"] = json!("tasks.error");
        doc["code"] = json!(code);
        doc["message"] = json!("the fake engine refused");
        doc["retryable"] = json!(false);
    } else if method == "hello" {
        doc["schemas"] = json!([1]);
        doc["capabilities"] = json!([
            "areas",
            "done_preview",
            "hello",
            "list",
            "next",
            "ops",
            "snapshot",
            "task"
        ]);
    }
    // The documents the data routes are tested with.
    if fake.get("error").is_none() {
        match method {
            "snapshot" => {
                // With `<vault>/.fake-n` the document follows that number, so a
                // test can change "the vault" by writing a file; every call is
                // counted in `<vault>/.fake-calls`.
                let vault = std::env::var("TASKS_VAULT").unwrap_or_default();
                let state = std::path::Path::new(&vault).join(".fake-n");
                if let Ok(text) = std::fs::read_to_string(&state) {
                    use std::io::Write as _;
                    let n: u64 = text.trim().parse().unwrap_or(0);
                    let transient =
                        std::fs::remove_file(std::path::Path::new(&vault).join(".fake-transient"))
                            .is_ok();
                    if let Ok(mut calls) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(std::path::Path::new(&vault).join(".fake-calls"))
                    {
                        let _ = writeln!(calls, "call");
                    }
                    let mut tasks: Vec<Value> = (0..=n)
                        .map(|i| {
                            json!({
                                "id": format!("alpha.nvim/t{i}"),
                                "area": "alpha.nvim",
                                "etag": format!("sha256:{i:016x}"),
                                "problems": [],
                            })
                        })
                        .collect();
                    if transient {
                        tasks[0]["problems"] = json!([{ "code": "duplicate-id", "msg": "x" }]);
                    }
                    doc["digest"] = json!(format!("sha256:{n:016x}"));
                    doc["rev"] = json!(format!("rev:{n:06x}"));
                    doc["tasks"] = json!(tasks);
                } else {
                    doc["digest"] = json!("sha256:00000000000000aa");
                    doc["rev"] = json!("rev:000001");
                    doc["counts"] = json!({ "listed": 1, "unlisted": 0 });
                    doc["tasks"] = json!([{ "id": "alpha.nvim/one", "area": "alpha.nvim" }]);
                }
            }
            "bodies" => {
                // The bodies follow `<vault>/.fake-n` like the snapshot: the
                // task `t<i>` holds the word `needle<i>`.
                let vault = std::env::var("TASKS_VAULT").unwrap_or_default();
                let n: u64 = std::fs::read_to_string(std::path::Path::new(&vault).join(".fake-n"))
                    .ok()
                    .and_then(|t| t.trim().parse().ok())
                    .unwrap_or(0);
                let wanted: Option<Vec<String>> = params.get("ids").and_then(|v| {
                    v.as_array().map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                });
                let page_size: usize =
                    std::fs::read_to_string(std::path::Path::new(&vault).join(".fake-bodies-page"))
                        .ok()
                        .and_then(|t| t.trim().parse().ok())
                        .unwrap_or(1000);
                let offset = params
                    .get("offset")
                    .and_then(Value::as_u64)
                    .and_then(|o| usize::try_from(o).ok())
                    .unwrap_or(0);
                let chosen: Vec<String> = (0..=n)
                    .map(|i| format!("alpha.nvim/t{i}"))
                    .filter(|id| wanted.as_ref().is_none_or(|w| w.contains(id)))
                    .collect();
                let total = chosen.len();
                let items: Vec<Value> = chosen
                    .into_iter()
                    .skip(offset)
                    .take(page_size)
                    .map(|id| {
                        let i = id.trim_start_matches("alpha.nvim/t").to_owned();
                        json!({
                            "id": id,
                            "etag": format!("sha256:{:016x}", i.parse::<u64>().unwrap_or(0)),
                            "body": format!("Text of task {i}.\nIt mentions needle{i} and a shared word zebra.\n"),
                            "body_truncated": false,
                        })
                    })
                    .collect();
                doc["rev"] = json!(format!("rev:{n:06x}"));
                doc["total"] = json!(total);
                if offset + items.len() < total {
                    doc["next_offset"] = json!(offset + items.len());
                }
                doc["offset"] = json!(offset);
                doc["limit"] = json!(1000);
                doc["items"] = json!(items);
                doc["incomplete"] = json!([]);
            }
            "areas" => {
                doc["areas"] = json!([
                    { "name": "alpha.nvim", "open": 1 },
                    { "name": "beta.nvim", "open": 0 },
                    { "name": "secret-area", "open": 2 },
                ]);
            }
            "task" => {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                if id == "alpha.nvim/missing" {
                    doc["kind"] = json!("tasks.error");
                    doc["code"] = json!("not_found");
                    doc["message"] = json!("no such task");
                    doc["retryable"] = json!(false);
                } else {
                    doc["task"] = json!({ "id": id });
                    doc["body"] = json!("");
                    // The state the task was read in follows `<vault>/.fake-n`
                    // like the snapshot, when a test keeps one.
                    let vault = std::env::var("TASKS_VAULT").unwrap_or_default();
                    if let Some(n) =
                        std::fs::read_to_string(std::path::Path::new(&vault).join(".fake-n"))
                            .ok()
                            .and_then(|t| t.trim().parse::<u64>().ok())
                    {
                        // Another form than the snapshot's, as the engine's is.
                        doc["rev"] = json!(format!("rev:t{n:05x}"));
                    }
                }
            }
            "next" => {
                doc["echoed"] = params.clone();
            }
            _ => {}
        }
    }
    if fake.get("stamp").and_then(Value::as_bool) == Some(true) {
        doc["started_ms"] = json!(started);
        doc["ended_ms"] = json!(now_ms());
    }
    if fake.get("echo_env").and_then(Value::as_bool) == Some(true) {
        let mut names: Vec<String> = std::env::vars().map(|(k, _)| k.to_uppercase()).collect();
        names.sort();
        doc["env"] = json!(names);
    }
    if fake.get("echo_stdin").and_then(Value::as_bool) == Some(true) {
        doc["stdin_bytes"] = json!(raw);
    }
    if let Some(n) = fake.get("huge").and_then(Value::as_u64) {
        doc["pad"] = json!("x".repeat(usize::try_from(n).unwrap_or(0)));
    }

    doc
}
