//! The hub against the real engine (tasks.nvim) and the synthetic fixture
//! vault in `e2e/fixture/vault`.
//!
//! These tests need Neovim >= 0.12, a tasks.nvim checkout and a lib.nvim
//! checkout (found as the hub finds them: settings, environment, then
//! `REPOS_DIR`). Without them they skip and say so; set
//! `TASKS_DESKTOP_REQUIRE_ENGINE=1` (as CI does) to make a missing engine a
//! failure instead.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};
use tasks_hub::config::{Env, FileConfig};
use tasks_hub::discovery::{discover, Setup, SetupProblem};
use tasks_hub::engine::{probe, CliEngine, CliEngineConfig, Engine, EngineError, Method};

fn fixture_vault() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("e2e")
        .join("fixture")
        .join("vault")
}

/// The areas of the fixture that have no `ROADMAP/` or `Backlog/` folder.
fn fixture_extra_areas() -> Vec<String> {
    ["ALL", "nvim-config", "docmap-desktop", "migrate.nvim"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect()
}

async fn engine() -> Option<(CliEngine, Setup)> {
    let env = Env::from_process();
    let file = FileConfig {
        vault: Some(fixture_vault()),
        extra_areas: fixture_extra_areas(),
        ..FileConfig::default()
    };
    match discover(&file, &env).await {
        Ok(setup) => {
            let cfg = CliEngineConfig::from_setup(&setup, env);
            Some((CliEngine::new(cfg), setup))
        }
        Err(
            problem @ (SetupProblem::NvimNotFound { .. }
            | SetupProblem::NvimTooOld { .. }
            | SetupProblem::NvimProbeFailed(_)
            | SetupProblem::EngineNotFound { .. }
            | SetupProblem::LibNotFound { .. }),
        ) => {
            assert!(
                std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_none(),
                "the engine is required but not usable: {problem}"
            );
            eprintln!("skipped: {problem}");
            None
        }
        Err(other) => panic!("the fixture vault is not usable: {other}"),
    }
}

/// Every file below `root`: its relative path, length and modification time.
fn listing(root: &Path) -> BTreeMap<String, (u64, Option<SystemTime>)> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, (u64, Option<SystemTime>)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let meta = entry.metadata().unwrap();
            if meta.is_dir() {
                walk(&path, root, out);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .display()
                    .to_string()
                    .replace('\\', "/");
                out.insert(relative, (meta.len(), meta.modified().ok()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[tokio::test]
async fn a_read_leaves_the_vault_as_it_was() {
    // The watcher wakes a scan when the vault changes. A scan that wrote
    // into the vault would wake itself again and never rest.
    let Some((engine, _)) = engine().await else {
        return;
    };
    let vault = fixture_vault();
    let before = listing(&vault);
    assert!(!before.is_empty());
    let task = json!({ "id": "lib.nvim/alpha" });
    for (method, params) in [
        (Method::Snapshot, None),
        (Method::Areas, None),
        (Method::Next, None),
        (Method::Task, Some(&task)),
    ] {
        engine.call(method, params).await.expect("a read");
    }
    assert_eq!(listing(&vault), before, "a read changed the vault");
}

#[tokio::test]
async fn the_engine_is_found_and_probed() {
    let Some((engine, setup)) = engine().await else {
        return;
    };
    assert!(setup.nvim_version >= tasks_hub::discovery::MIN_NVIM);
    let info = probe(&engine).await.expect("probe");
    assert!(info.schemas.contains(&1));
}

#[tokio::test]
async fn the_snapshot_of_the_fixture_vault_is_complete() {
    let Some((engine, _)) = engine().await else {
        return;
    };
    let reply = engine.call(Method::Snapshot, None).await.expect("snapshot");
    assert_eq!(reply.kind, "tasks.snapshot");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    let tasks = doc["tasks"].as_array().expect("tasks");
    assert!(!tasks.is_empty());
    assert_eq!(doc["vault"]["id"], "vault");
    // No absolute path in any document (concept 4.1).
    let vault = fixture_vault().canonicalize().unwrap();
    let vault = vault.display().to_string().replace('\\', "/");
    assert!(!reply.text.replace("\\\\", "/").contains(&vault));
}

#[tokio::test]
async fn the_bodies_are_one_state_with_the_snapshot_and_the_search_finds_them() {
    let Some((engine, _)) = engine().await else {
        return;
    };
    let snapshot = engine.call(Method::Snapshot, None).await.expect("snapshot");
    let snapshot: Value = serde_json::from_str(&snapshot.text).unwrap();
    let reply = engine
        .call(Method::Bodies, Some(&json!({ "limit": 1000 })))
        .await
        .expect("bodies");
    assert_eq!(reply.kind, "tasks.bodies");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    // The same state as the snapshot: the text and the list belong together.
    assert_eq!(doc["rev"], snapshot["rev"]);
    assert_eq!(
        doc["items"].as_array().unwrap().len(),
        snapshot["counts"]["listed"].as_u64().unwrap() as usize
    );
    let alpha = doc["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == "lib.nvim/alpha")
        .expect("alpha");
    assert!(alpha["body"]
        .as_str()
        .unwrap()
        .contains("The body of alpha."));
    // The words are found where the hub's index looks for them.
    let query = tasks_hub::search::Query::parse("body ALPHA").unwrap();
    assert_eq!(query.tokens, ["body", "alpha"]);

    // A named id, and one that is not there.
    let named = engine
        .call(
            Method::Bodies,
            Some(&json!({ "ids": ["lib.nvim/alpha", "nope.nvim/missing"] })),
        )
        .await
        .expect("named");
    let named: Value = serde_json::from_str(&named.text).unwrap();
    assert_eq!(named["items"].as_array().unwrap().len(), 1);
    assert_eq!(named["rev"], snapshot["rev"]);
}

#[tokio::test]
async fn one_task_comes_back_with_its_body() {
    let Some((engine, _)) = engine().await else {
        return;
    };
    let params = json!({ "id": "lib.nvim/alpha" });
    let reply = engine
        .call(Method::Task, Some(&params))
        .await
        .expect("task");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(doc["task"]["id"], "lib.nvim/alpha");
    assert!(doc["body"].is_string());
}

#[tokio::test]
async fn an_unknown_parameter_is_refused_by_the_engine() {
    let Some((engine, _)) = engine().await else {
        return;
    };
    let params = json!({ "colour": "red" });
    let err = engine
        .call(Method::List, Some(&params))
        .await
        .expect_err("refused");
    match err {
        EngineError::Refused(r) => assert_eq!(r.code, "invalid_argument"),
        other => panic!("{other}"),
    }
}

#[tokio::test]
async fn text_mode_hazards_reach_the_engine_intact() {
    // CRLF and a byte 0x1A in stdin are what `nvim -l` changes or stops at
    // in text mode. The hub sends them as escapes; the engine must see the
    // request whole, which it proves by judging the operation, not the bytes.
    let Some((engine, _)) = engine().await else {
        return;
    };
    let count = |text: &str| -> usize {
        let doc: Value = serde_json::from_str(text).unwrap();
        doc["tasks"].as_array().map_or(0, Vec::len)
    };
    let before = engine.call(Method::Snapshot, None).await.expect("snapshot");
    let new_task = |id: &str, title: &str| {
        json!({
            "schema": 1,
            "client_op_id": id,
            "dry_run": true,
            "ops": [{ "op": "new", "area": "lib.nvim", "title": title }],
        })
    };

    // A title with a control character (CRLF, 0x1A): the engine reads the
    // whole request and refuses the title itself. A raw 0x1A on stdin would
    // have cut the request off and been answered "not valid JSON".
    let hazard = new_task("c-hazard", "Zeile\r\nund\u{1a}danach");
    let reply = engine
        .call(Method::Ops, Some(&hazard))
        .await
        .expect("a result document");
    assert_eq!(reply.kind, "tasks.result");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(doc["client_op_id"], "c-hazard");
    let error = &doc["results"][0]["error"];
    assert_eq!(error["code"], "invalid_argument");
    assert!(
        error["message"]
            .as_str()
            .is_some_and(|m| m.contains("control character")),
        "{error}"
    );

    // Non-ASCII text arrives as it was written and is accepted.
    let clean = new_task("c-unicode", "K\u{e4}se \u{1f600} und \u{4e2d}\u{6587}");
    let reply = engine
        .call(Method::Ops, Some(&clean))
        .await
        .expect("a result document");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(doc["ok"], true, "{}", reply.text);

    // A dry run judged the operations and wrote nothing.
    let after = engine.call(Method::Snapshot, None).await.expect("snapshot");
    assert_eq!(count(&before.text), count(&after.text), "a dry run wrote");
}

// ── the persistent host against the real engine ──────────────────────────

/// A copy of the fixture vault that a test may change.
fn copy_vault(name: &str) -> PathBuf {
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), &target).unwrap();
            }
        }
    }
    let to = std::env::temp_dir().join(format!(
        "tasks-desktop-host-real-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&to);
    copy(&fixture_vault(), &to);
    to
}

async fn engines_on(vault: &Path) -> Option<(CliEngine, CliEngine)> {
    let env = Env::from_process();
    let file = FileConfig {
        vault: Some(vault.to_path_buf()),
        extra_areas: fixture_extra_areas(),
        ..FileConfig::default()
    };
    match discover(&file, &env).await {
        Ok(setup) => {
            let cfg = CliEngineConfig::from_setup(&setup, env);
            Some((CliEngine::with_host(cfg.clone()), CliEngine::new(cfg)))
        }
        Err(problem) => {
            assert!(
                std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_none(),
                "the engine is required but not usable: {problem}"
            );
            eprintln!("skipped: {problem}");
            None
        }
    }
}

/// The document without the moment it was made.
fn steady(text: &str) -> Value {
    let mut doc: Value = serde_json::from_str(text).unwrap();
    if let Some(map) = doc.as_object_mut() {
        map.remove("generated_at");
    }
    doc
}

#[tokio::test]
async fn the_host_answers_with_the_documents_of_the_process_way() {
    let vault = copy_vault("same");
    let Some((host, process)) = engines_on(&vault).await else {
        return;
    };
    let cases: Vec<(Method, Option<Value>)> = vec![
        (Method::Hello, None),
        (Method::Snapshot, None),
        (Method::Areas, None),
        (Method::List, Some(json!({ "limit": 20 }))),
        (Method::Bodies, Some(json!({ "limit": 50 }))),
        (Method::Next, Some(json!({ "n": 3 }))),
        (Method::Task, Some(json!({ "id": "lib.nvim/alpha" }))),
        (Method::Task, Some(json!({ "id": "lib.nvim/no-such-task" }))),
    ];
    for (method, params) in cases {
        let a = host.call(method, params.as_ref()).await;
        let b = process.call(method, params.as_ref()).await;
        match (a, b) {
            (Ok(a), Ok(b)) => assert_eq!(steady(&a.text), steady(&b.text), "{}", method.as_str()),
            (Err(EngineError::Refused(a)), Err(EngineError::Refused(b))) => {
                assert_eq!(steady(&a.text), steady(&b.text), "{}", method.as_str());
            }
            (a, b) => panic!("{}: {a:?} / {b:?}", method.as_str()),
        }
    }
    assert!(host.host_running().await);
}

#[tokio::test]
async fn the_host_never_answers_from_before_a_change_of_the_vault() {
    let vault = copy_vault("fresh");
    let Some((host, _)) = engines_on(&vault).await else {
        return;
    };
    let before = host.call(Method::Snapshot, None).await.unwrap();
    let before = steady(&before.text);
    let task = vault
        .join("lib.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join("beta.md");

    // The same length at once after the first read (the case a cache keyed
    // on size and time alone gets wrong): `prio: 2` becomes `prio: 3`.
    let text = std::fs::read_to_string(&task).unwrap();
    let changed = text.replacen("prio: 2", "prio: 3", 1);
    assert_ne!(text, changed, "the fixture task has `prio: 2`");
    assert_eq!(text.len(), changed.len());
    std::fs::write(&task, &changed).unwrap();

    let after = steady(&host.call(Method::Snapshot, None).await.unwrap().text);
    assert_ne!(before["digest"], after["digest"], "the change was not seen");
    assert_ne!(before["rev"], after["rev"]);
    let id = "lib.nvim/beta";
    let prio = |doc: &Value| {
        doc["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .map(|t| t["prio"].clone())
    };
    assert_eq!(prio(&after), Some(json!(3)));
    assert_ne!(prio(&before), prio(&after));

    // A task that appears and one that goes.
    let fresh = vault
        .join("lib.nvim")
        .join("ROADMAP")
        .join("tasks")
        .join("fresh-one.md");
    std::fs::write(&fresh, "---\ntitle: Fresh one\nstatus: open\n---\nBody.\n").unwrap();
    let with = steady(&host.call(Method::Snapshot, None).await.unwrap().text);
    assert!(with["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["id"] == "lib.nvim/fresh-one"));
    std::fs::remove_file(&fresh).unwrap();
    let without = steady(&host.call(Method::Snapshot, None).await.unwrap().text);
    assert!(!without["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["id"] == "lib.nvim/fresh-one"));
}

#[tokio::test]
async fn a_write_through_the_host_is_seen_by_the_next_read() {
    let vault = copy_vault("write");
    let Some((host, process)) = engines_on(&vault).await else {
        return;
    };
    let before = steady(&host.call(Method::Snapshot, None).await.unwrap().text);
    let task = before["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "lib.nvim/beta")
        .unwrap()
        .clone();
    let request = json!({
        "client_op_id": "host-test-1",
        "ops": [{
            "op": "set",
            "id": "lib.nvim/beta",
            "if_match": task["etag"],
            "patch": { "prio": 3 }
        }]
    });
    let done = host.call(Method::Ops, Some(&request)).await.unwrap();
    let done = steady(&done.text);
    assert_eq!(done["ok"], true, "{done}");

    // Through the host and through a fresh process: the same new state.
    let a = steady(&host.call(Method::Snapshot, None).await.unwrap().text);
    let b = steady(&process.call(Method::Snapshot, None).await.unwrap().text);
    assert_eq!(a, b);
    assert_ne!(a["digest"], before["digest"]);
}
