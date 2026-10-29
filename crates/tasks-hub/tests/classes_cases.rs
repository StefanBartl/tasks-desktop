//! The web page reads `areas.json` with its own reader (`ui/src/web/classes.ts`). Where it would release an area that
//! this hub keeps closed, the page would keep a task title in the browser that the owner marked private. So the cases of
//! the page's tests (`ui/web/classes-cases.mjs`: the files, and what the vault `main` shows for each) are held to the
//! answers of `AreaPolicy::load` here, the same file for the same answer.
//!
//! The cases are asked of Node (`ui/web/classes-cases-dump.mjs`), so that there is one list and it cannot drift. Without
//! Node the test is skipped, unless `TASKS_DESKTOP_REQUIRE_ENGINE` is set (as CI does): then it fails.

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tasks_hub::classes::{path, AreaPolicy, Shown};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn from_hex(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2), "odd hex");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

fn word(shown: Shown) -> &'static str {
    match shown {
        Shown::Public => "public",
        Shown::Internal => "internal",
        Shown::Private => "private",
        Shown::Unclassified => "unclassified",
    }
}

/// The cases, or `None` when Node is not there and the test may be skipped.
fn cases() -> Option<Vec<Value>> {
    let ui = repo().join("ui");
    let out = Command::new("node")
        .args(["--experimental-strip-types", "web/classes-cases-dump.mjs"])
        .current_dir(&ui)
        .output();
    match out {
        Ok(out) if out.status.success() => {
            let parsed: Value = serde_json::from_slice(&out.stdout).expect("the dump is JSON");
            Some(parsed.as_array().expect("a list of cases").clone())
        }
        other => {
            let why = match other {
                Ok(out) => String::from_utf8_lossy(&out.stderr).into_owned(),
                Err(e) => e.to_string(),
            };
            assert!(
                std::env::var_os("TASKS_DESKTOP_REQUIRE_ENGINE").is_none(),
                "Node is required here and the cases could not be read: {why}"
            );
            eprintln!("skipped: no Node to read the cases of the web page ({why})");
            None
        }
    }
}

#[test]
fn the_hub_answers_every_case_of_the_web_page_alike() {
    let Some(cases) = cases() else { return };
    assert!(cases.len() >= 150, "{} cases", cases.len());
    let dir = std::env::temp_dir().join(format!(
        "tasks-desktop-classes-cases-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut wrong = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        std::fs::write(path(&dir), from_hex(case["hex"].as_str().unwrap())).unwrap();
        let got = AreaPolicy::load(&dir);
        if case["refused"].as_bool().unwrap() {
            if got.is_ok() {
                wrong.push(format!(
                    "{name}: the page refuses the file, the hub reads it"
                ));
            }
            continue;
        }
        match got {
            Err(e) => wrong.push(format!(
                "{name}: the page reads the file, the hub refuses it ({e})"
            )),
            Ok(policy) => {
                for (area, class) in case["shows"].as_object().unwrap() {
                    let shown = word(policy.shown(area));
                    if Some(shown) != class.as_str() {
                        wrong.push(format!(
                            "{name}: area {area:?} is {class} on the page and {shown} in the hub"
                        ));
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        wrong.is_empty(),
        "the page and the hub differ:\n{}",
        wrong.join("\n")
    );
}
