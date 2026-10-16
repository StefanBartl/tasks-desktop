//! What the fake engine calls things, for the engine of one app.
//!
//! The fake stands in for `nvim -l scripts/<app>.lua`. Which app's engine it plays is read from the
//! script it is given (`rules.lua`, `rules-host.lua`: the file name starts with the name of the
//! dialect), because the engine is started with a clean environment and a variable would not
//! arrive. An app states its own dialect; this kit has one of its own, [`RULES`], to test with.

use std::path::Path;

/// The names the fake engine of one app uses.
#[derive(Debug)]
pub struct FakeDialect {
    /// The prefix of the script file names and of the kinds (`tasks`, `rules`).
    pub name: &'static str,
    /// The `plugin` of every document.
    pub plugin: &'static str,
    /// The kind of a refusal.
    pub error_kind: &'static str,
    /// The kind of an answer to a call the table does not know.
    pub unknown_kind: &'static str,
    /// The variable that names the vault.
    pub vault_var: &'static str,
    /// The file name of the persistent host.
    pub host_script: &'static str,
    /// The key of the list of documents in a snapshot.
    pub list_key: &'static str,
    /// The kind of the answer to a call, by its name.
    pub kind_of: fn(&str) -> Option<&'static str>,
}

fn rules_kind(method: &str) -> Option<&'static str> {
    match method {
        "hello" => Some("rules.hello"),
        "snapshot" => Some("rules.snapshot"),
        "list" => Some("rules.list"),
        _ => None,
    }
}

/// An engine that is not any app's that uses this kit: `rules.nvim`, with three calls.
pub const RULES: FakeDialect = FakeDialect {
    name: "rules",
    plugin: "rules.nvim",
    error_kind: "rules.error",
    unknown_kind: "rules.unknown",
    vault_var: "RULES_VAULT",
    host_script: "rules-host.lua",
    list_key: "rules",
    kind_of: rules_kind,
};

impl FakeDialect {
    /// The dialect of `dialects` the arguments of the process ask for: the one whose name the file
    /// name of the script (`*.lua`) starts with; the first one when none does.
    ///
    /// # Panics
    ///
    /// When `dialects` is empty.
    #[must_use]
    pub fn of_args(dialects: &[&'static FakeDialect], args: &[String]) -> &'static FakeDialect {
        let scripts: Vec<&str> = args
            .iter()
            .filter_map(|a| Path::new(a).file_name().and_then(|n| n.to_str()))
            .filter(|n| n.ends_with(".lua"))
            .collect();
        dialects
            .iter()
            .find(|d| scripts.iter().any(|s| s.starts_with(d.name)))
            .or_else(|| dialects.first())
            .copied()
            .expect("a fake engine plays at least one dialect")
    }

    /// The kind of the answer to `method`.
    #[must_use]
    pub fn kind(&self, method: &str) -> &'static str {
        (self.kind_of)(method).unwrap_or(self.unknown_kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_none(_: &str) -> Option<&'static str> {
        None
    }

    const OTHER: FakeDialect = FakeDialect {
        name: "other",
        plugin: "other.nvim",
        error_kind: "other.error",
        unknown_kind: "other.unknown",
        vault_var: "OTHER_VAULT",
        host_script: "other-host.lua",
        list_key: "others",
        kind_of: kind_none,
    };

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn the_script_names_the_dialect_and_the_first_is_the_default() {
        let both = [&OTHER, &RULES];
        let rules = args(&["--headless", "-l", "/x/scripts/rules.lua", "call", "hello"]);
        assert_eq!(FakeDialect::of_args(&both, &rules).name, "rules");
        let host = args(&["-l", "C:/x/rules-host.lua"]);
        assert_eq!(FakeDialect::of_args(&both, &host).name, "rules");
        let neither = args(&["-l", "/x/tasks.lua", "call", "hello"]);
        assert_eq!(FakeDialect::of_args(&both, &neither).name, "other");
        // A word that is not a script does not choose: a vault called `rules` is no script.
        let vault = args(&["--vault=/x/rules", "rules"]);
        assert_eq!(FakeDialect::of_args(&both, &vault).name, "other");
    }

    #[test]
    fn an_unknown_call_has_the_unknown_kind_of_the_dialect() {
        assert_eq!(RULES.kind("snapshot"), "rules.snapshot");
        assert_eq!(RULES.kind("nothing"), "rules.unknown");
    }
}
