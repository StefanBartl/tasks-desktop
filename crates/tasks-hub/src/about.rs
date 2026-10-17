//! What this build is: its version, the commit of a rolling build, the platform it runs on, and the
//! commits of the engine and its library that `engine.lock` pins. The Info dialog of the page shows
//! it and a bug report carries it (rule APP-09). Versions and commits only: nothing here names a
//! path, a vault, a folder or a person (ENG-06), because a report leaves the machine.

use serde_json::{json, Value};

/// `engine.lock` as it was when this binary was built: the CI checks out exactly these commits.
const ENGINE_LOCK: &str = include_str!("../../../engine.lock");

/// The commits of the engine and its library this build was made and tested against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pins {
    pub engine: Option<String>,
    pub lib: Option<String>,
}

/// The pins of the `engine.lock` this binary was built with.
#[must_use]
pub fn pins() -> Pins {
    parse_pins(ENGINE_LOCK)
}

/// Read `commit` and `lib_commit` out of the text of an `engine.lock` (`key = value` lines, `#`
/// comments). A key that is missing or whose value is not a hex commit is `None`: the dialog then
/// says "unknown" instead of showing a word that is not a commit.
#[must_use]
pub fn parse_pins(text: &str) -> Pins {
    let mut pins = Pins {
        engine: None,
        lib: None,
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if !is_commit(value) {
            continue;
        }
        match key.trim() {
            "commit" => pins.engine = Some(value.to_owned()),
            "lib_commit" => pins.lib = Some(value.to_owned()),
            _ => {}
        }
    }
    pins
}

fn is_commit(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The document of `GET /api/tasks/about`. `engine` is the `engine` object of the engine's `hello`
/// (`version`, `git`, `nvim`); only those three words are taken over, whatever else the engine
/// says. `None` when there is no engine, or when the one that runs did not answer: then
/// `engine_problem` carries the hub's short word for it (`engine_timeout`, ...), so that a report
/// does not claim "no engine" of an engine that hangs. The part of the app is told either way.
#[must_use]
pub fn document(engine: Option<&Value>, engine_problem: Option<&str>) -> Value {
    let pins = pins();
    json!({
        "engine_problem": engine_problem,
        "schema": 1,
        "kind": "hub.about",
        "app": crate::IDENTITY.app,
        "version": crate::VERSION,
        "build": crate::BUILD.filter(|b| !b.is_empty()),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "engine": engine.filter(|e| e.is_object()).map(|e| json!({
            "version": e["version"],
            "git": e["git"],
            "nvim": e["nvim"],
        })),
        "pinned": { "engine": pins.engine, "lib": pins.lib },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pins_of_this_build_are_two_commits() {
        let pins = pins();
        assert_eq!(pins.engine.as_deref().map(str::len), Some(40), "{pins:?}");
        assert_eq!(pins.lib.as_deref().map(str::len), Some(40), "{pins:?}");
    }

    #[test]
    fn a_lock_is_read_by_its_keys_and_a_value_that_is_no_commit_is_left_out() {
        let text = "# a comment\nrepo = https://example.invalid/x\ncommit = abc1234\nlib_repo = y\nlib_commit = not-a-commit\n";
        assert_eq!(
            parse_pins(text),
            Pins {
                engine: Some("abc1234".to_owned()),
                lib: None
            }
        );
        assert_eq!(
            parse_pins(""),
            Pins {
                engine: None,
                lib: None
            }
        );
    }

    #[test]
    fn the_document_takes_three_words_of_the_engine_and_nothing_else() {
        let engine = json!({
            "version": "1.2.3",
            "git": "abc1234",
            "nvim": "0.12.2",
            "vault": "C:/Users/someone/vault",
        });
        let doc = document(Some(&engine), None);
        assert_eq!(doc["kind"], "hub.about");
        assert!(doc["engine_problem"].is_null());
        assert_eq!(doc["app"], "tasks-desktop");
        assert_eq!(doc["version"], crate::VERSION);
        assert_eq!(doc["engine"]["version"], "1.2.3");
        assert_eq!(doc["engine"]["git"], "abc1234");
        assert_eq!(doc["engine"]["nvim"], "0.12.2");
        assert!(doc["engine"].get("vault").is_none(), "{doc}");
        assert!(!doc.to_string().contains("someone"), "{doc}");
        assert!(doc["os"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(doc["arch"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(doc["pinned"]["engine"].as_str().map(str::len), Some(40));
    }

    #[test]
    fn without_an_engine_the_app_is_still_described() {
        let doc = document(None, None);
        assert!(doc["engine"].is_null());
        assert!(doc["engine_problem"].is_null());
        assert_eq!(doc["version"], crate::VERSION);
        // A reply that is not an object (the engine answered nonsense) is treated as no engine.
        assert!(document(Some(&json!("text")), None)["engine"].is_null());
    }

    #[test]
    fn an_engine_that_did_not_answer_is_told_apart_from_no_engine() {
        let doc = document(None, Some("engine_timeout"));
        assert!(doc["engine"].is_null());
        assert_eq!(doc["engine_problem"], "engine_timeout");
    }
}
