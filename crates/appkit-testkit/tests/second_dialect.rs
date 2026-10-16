//! `CliEngine` against the fake engine of an app that is not the tasks hub: the seam of `appkit-hub`
//! knows no call, no kind, no variable and no script by name, so any engine works the same.
//!
//! The dialect is the one of `rules.nvim`: `rules.*` kinds, `RULES_VAULT`, its list under `rules`.
//! The binary `fake-engine` of this kit plays it.

use std::path::PathBuf;
use std::time::Duration;

use appkit_hub::engine::{
    probe, CliEngine, CliEngineConfig, Engine, EngineDialect, EngineError, Method, MethodSpec,
};
use appkit_hub::env::Env;
use serde_json::{json, Value};

static SPECS: [MethodSpec; 3] = [
    MethodSpec::bare("hello", "rules.hello"),
    MethodSpec::bare("snapshot", "rules.snapshot"),
    MethodSpec::read("list", "rules.list"),
];
const HELLO: Method = Method::new(&SPECS[0]);
const SNAPSHOT: Method = Method::new(&SPECS[1]);
const LIST: Method = Method::new(&SPECS[2]);

const DIALECT: EngineDialect = EngineDialect {
    schema: 1,
    error_kind: "rules.error",
    host_script: "rules-host.lua",
    vault_var: "RULES_VAULT",
    extra_areas_var: "RULES_EXTRA_AREAS",
    required_capabilities: &["hello", "snapshot"],
    hello: HELLO,
    engine_name: "the rules.nvim checkout",
};

fn engine(env: Env) -> CliEngine {
    let vault = std::env::temp_dir();
    CliEngine::new(CliEngineConfig {
        dialect: DIALECT,
        nvim: PathBuf::from(env!("CARGO_BIN_EXE_fake-engine")),
        script: vault.join("scripts").join("rules.lua"),
        vault,
        lib_dir: None,
        extra_areas: vec!["ALL".to_owned()],
        env,
        timeout: Duration::from_secs(10),
        max_queue: 8,
        max_reply_bytes: 64 * 1024,
    })
}

fn fake(value: Value) -> Value {
    json!({ "fake": value })
}

#[tokio::test]
async fn the_engine_of_the_second_app_is_probed_by_its_own_hello() {
    let info = probe(&engine(Env::from_process()), &DIALECT)
        .await
        .expect("probe");
    assert_eq!(info.schemas, vec![1]);
    assert!(info.capabilities.iter().any(|c| c == "snapshot"));
}

#[tokio::test]
async fn it_answers_with_its_own_plugin_kind_and_list() {
    let reply = engine(Env::from_process())
        .call(SNAPSHOT, None)
        .await
        .expect("answer");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(doc["plugin"], "rules.nvim");
    assert_eq!(doc["kind"], "rules.snapshot");
    assert!(doc["rules"].is_array(), "{doc}");
    assert!(doc.get("tasks").is_none(), "{doc}");
}

#[tokio::test]
async fn the_child_gets_the_variables_of_its_own_dialect_and_none_of_the_other() {
    let env = Env::from_pairs([
        ("PATH", "C:/bin"),
        ("SystemRoot", "C:/Windows"),
        ("TASKS_VAULT", "C:/from/the/environment"),
        ("TASKS_EXTRA_AREAS", "ELSEWHERE"),
    ]);
    let params = fake(json!({ "echo_env": true }));
    let reply = engine(env).call(LIST, Some(&params)).await.expect("answer");
    let doc: Value = serde_json::from_str(&reply.text).unwrap();
    let names: Vec<&str> = doc["env"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(names.contains(&"RULES_VAULT"), "{names:?}");
    assert!(names.contains(&"RULES_EXTRA_AREAS"), "{names:?}");
    for other in ["TASKS_VAULT", "TASKS_EXTRA_AREAS"] {
        assert!(
            !names.contains(&other),
            "{other} reached the child: {names:?}"
        );
    }
}

#[tokio::test]
async fn a_refusal_is_the_error_kind_of_the_dialect() {
    let params = fake(json!({ "error": "invalid_argument" }));
    let err = engine(Env::from_process())
        .call(LIST, Some(&params))
        .await
        .expect_err("refusal");
    match err {
        EngineError::Refused(r) => {
            assert_eq!(r.code, "invalid_argument");
            assert!(r.text.contains("rules.error"), "{}", r.text);
        }
        other => panic!("{other}"),
    }
}

#[tokio::test]
async fn an_answer_of_the_other_dialect_is_a_protocol_error() {
    // The kind of the tasks engine, the schema of nobody: neither is what this engine promised.
    for params in [
        fake(json!({ "kind": "tasks.list" })),
        fake(json!({ "kind": "rules.snapshot" })),
        fake(json!({ "schema": 2 })),
    ] {
        let err = engine(Env::from_process())
            .call(LIST, Some(&params))
            .await
            .expect_err("protocol");
        assert!(matches!(err, EngineError::Protocol(_)), "{err}");
    }
}
