//! The documents the fake tasks engine answers with: the data routes of the tasks hub are tested
//! with them. The machine that answers is `appkit_testkit::fake_engine`.
//!
//! A test that cannot put a `fake` into the request (the routes build their own) steers the fake
//! with files in the folder of the vault:
//!
//! * `.fake-n`: the state of "the vault"; the snapshot, the bodies and a task follow it, a real
//!   `ops` run moves it on; every snapshot is counted in `.fake-calls`;
//! * `.fake-transient`: the next snapshot has a task with a passing problem (`duplicate-id`);
//! * `.fake-bodies-page`: how many bodies one page holds;
//! * `.fake-task-ms`, `.fake-task-calls`: a `task` read takes that long, and every one is counted;
//! * `.fake-task-file`: the file every task is in;
//! * `.fake-check-ms`, `.fake-check-done`, `.fake-check-fail`: a `check` takes that long, leaves a
//!   note when it ran to its end, or fails;
//! * `.fake-ops-conflict`: every operation of `ops` is refused with `conflict` (the file changed
//!   since it was read), and nothing is written.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use appkit_testkit::fake_engine::{Call, Documents};
use serde_json::{json, Value};

/// The documents of the tasks engine.
pub const TASKS_DOCUMENTS: Documents = Documents {
    before: tasks_before,
    fill: tasks_fill,
};

fn tasks_before(call: &Call<'_>) {
    let base = Path::new(&call.vault);
    if call.method == "task"
        && let Ok(text) = std::fs::read_to_string(base.join(".fake-task-ms"))
    {
        if let Ok(mut calls) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(base.join(".fake-task-calls"))
        {
            let _ = writeln!(calls, "task");
        }
        std::thread::sleep(Duration::from_millis(text.trim().parse().unwrap_or(0)));
    }
    if call.method == "check" {
        if let Ok(text) = std::fs::read_to_string(base.join(".fake-check-ms")) {
            std::thread::sleep(Duration::from_millis(text.trim().parse().unwrap_or(0)));
            // Only a check that ran to its end leaves this: one that was stopped did not.
            let _ = std::fs::write(base.join(".fake-check-done"), b"done");
        }
        if base.join(".fake-check-fail").exists() {
            eprintln!("fake-nvim check failed in {}", call.vault);
            std::process::exit(1);
        }
    }
}

/// The state of "the vault", when a test keeps one.
fn state(vault: &Path) -> Option<u64> {
    std::fs::read_to_string(vault.join(".fake-n"))
        .ok()
        .and_then(|t| t.trim().parse().ok())
}

fn tasks_fill(call: &Call<'_>, doc: &mut Value) {
    let vault = Path::new(&call.vault);
    let params = call.params;
    match call.method {
        "snapshot" => {
            if let Some(n) = state(vault) {
                let transient = std::fs::remove_file(vault.join(".fake-transient")).is_ok();
                if let Ok(mut calls) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(vault.join(".fake-calls"))
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
                doc[call.dialect.list_key] = json!(tasks);
            } else {
                doc["digest"] = json!("sha256:00000000000000aa");
                doc["rev"] = json!("rev:000001");
                doc["counts"] = json!({ "listed": 1, "unlisted": 0 });
                doc[call.dialect.list_key] =
                    json!([{ "id": "alpha.nvim/one", "area": "alpha.nvim" }]);
            }
        }
        "bodies" => {
            // The task `t<i>` holds the word `needle<i>`.
            let n = state(vault).unwrap_or(0);
            let wanted: Option<Vec<String>> = params.get("ids").and_then(|v| {
                v.as_array().map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
            });
            let page_size: usize = std::fs::read_to_string(vault.join(".fake-bodies-page"))
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
        "groupings" => {
            doc["rev"] = json!("rev:aaaaaa");
            doc["digest"] = json!("sha256:00000000000000aa");
            doc["fields"] = json!([
                { "field": "status", "values": ["doing", "open"], "value_type": "string", "truncated": false, "writable": true, "mode": "set" },
                { "field": "prio", "values": ["1", "2", "3"], "value_type": "number", "truncated": false, "writable": true, "mode": "set" },
                { "field": "tags", "values": ["ui"], "value_type": "string", "truncated": false, "writable": true, "mode": "tags", "multi": true },
                { "field": "state", "values": ["ready", "waiting"], "value_type": "string", "truncated": false, "writable": false },
            ]);
        }
        "views" => {
            doc["rev"] = json!("rev:bbbbbb");
            doc["digest"] = json!("sha256:00000000000000bb");
            doc["views"] = json!([
                {
                    "id": "alpha.nvim/by-status", "area": "alpha.nvim", "title": "Columns by status",
                    "display": "columns", "group_by": "status", "collapsed": [],
                    "select": { "areas": [], "statuses": ["open", "doing"], "actors": [], "kinds": [], "tags": [], "plans": [] },
                    "etag": "sha256:00000000000000b1", "created": "2026-01-01", "updated": "2026-01-01",
                },
            ]);
            doc["problems"] = json!([]);
        }
        "lists" => {
            doc["lists"] = json!([
                {
                    "name": "quick-wins",
                    "source": "builtin",
                    "summary": "Quick wins",
                    "options": { "quick_win": true, "sort": "roi", "status": "open,doing" },
                },
                {
                    "name": "mine",
                    "source": "saved",
                    "desc": "small and worth it",
                    "summary": "small and worth it",
                    "options": { "effort": "<=S", "value": ">=4", "sort": "roi" },
                },
            ]);
            doc["notes"] = json!([]);
        }
        "hello" => {
            doc["enums"] = json!({
                "status": ["doing", "decision", "blocked", "open", "parked"],
                "kind": ["feature", "task", "bug", "idea", "research"],
                "prio": [1, 2, 3],
                "value": [1, 2, 3, 4, 5],
                "effort": ["XS", "S", "M", "L", "XL", "<n>d"],
                "actor": ["cdx", "me", "pair"],
                "category": ["bug", "docs"],
                "severity": ["low", "medium", "high", "critical"],
            });
        }
        "links" => {
            doc["rev"] = json!("rev:aaaaaa");
            doc["digest"] = json!("sha256:00000000000000aa");
            doc["edge_count"] = json!(1);
            doc["truncated"] = json!(false);
            doc["pairs"] = json!([{
                "a": "alpha.nvim",
                "b": "beta.nvim",
                "count": 1,
                "kinds": { "blocked_by": 1 },
                "edges": [{
                    "from": "beta.nvim/two",
                    "from_area": "beta.nvim",
                    "to": "alpha.nvim/one",
                    "to_area": "alpha.nvim",
                    "kind": "blocked_by",
                }],
            }]);
            doc["tasks"] = json!([{ "id": "beta.nvim/two", "areas": ["alpha.nvim", "beta.nvim"] }]);
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
                doc["kind"] = json!(call.dialect.error_kind);
                doc["code"] = json!("not_found");
                doc["message"] = json!("no such task");
                doc["retryable"] = json!(false);
            } else {
                doc["task"] = json!({ "id": id });
                if let Ok(file) = std::fs::read_to_string(vault.join(".fake-task-file")) {
                    doc["task"]["file"] = json!(file.trim());
                }
                doc["body"] = json!("");
                // The state the task was read in follows the snapshot, in another form than the
                // snapshot's, as the engine's is.
                if let Some(n) = state(vault) {
                    doc["rev"] = json!(format!("rev:t{n:05x}"));
                }
            }
        }
        "next" | "order" => {
            doc["echoed"] = params.clone();
        }
        "done_preview" => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("");
            doc["id"] = json!(id);
            doc["confirm"] = json!("confirm-fake");
        }
        "ops" => {
            // Every operation `changed` the task it names, and a real run moves the state on, as
            // a write moves the vault.
            let dry = params.get("dry_run").and_then(Value::as_bool) == Some(true);
            let conflict = vault.join(".fake-ops-conflict").exists();
            let ops = params
                .get("ops")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let results: Vec<Value> = ops
                .iter()
                .enumerate()
                .map(|(i, op)| {
                    let id = op
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("alpha.nvim/new");
                    if conflict {
                        return json!({
                            "n": i + 1,
                            "op": op.get("op").cloned().unwrap_or(Value::Null),
                            "id": id,
                            "ok": false,
                            "outcome": "failed",
                            "changed_ids": [],
                            "error": { "code": "conflict", "message": "the file changed since it was read", "retryable": true },
                        });
                    }
                    json!({
                        "n": i + 1,
                        "op": op.get("op").cloned().unwrap_or(Value::Null),
                        "id": id,
                        "ok": true,
                        "outcome": if dry { "would_change" } else { "changed" },
                        "changed_ids": if dry { json!([]) } else { json!([id]) },
                    })
                })
                .collect();
            // Only a vault that keeps a state moves: a test that has none must not leave a file
            // behind (a vault may be the temp dir).
            if !dry
                && !conflict
                && let Some(n) = state(vault)
            {
                let _ = std::fs::write(vault.join(".fake-n"), (n + 1).to_string());
            }
            doc["digest"] = json!("sha256:0000000000000001");
            doc["dry_run"] = json!(dry);
            doc["ok"] = json!(!conflict);
            doc["results"] = json!(results);
            if let Some(id) = params.get("client_op_id") {
                doc["client_op_id"] = id.clone();
            }
        }
        _ => {}
    }
}
