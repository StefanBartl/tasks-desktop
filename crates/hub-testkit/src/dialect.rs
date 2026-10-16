//! What the fake engine calls things, for the engine of each app.
//!
//! `fake-nvim` stands in for `nvim -l scripts/<app>.lua`. Which app's engine it plays is read from
//! the script it is given (`rules.lua`, `rules-host.lua`: the file name starts with the name of the
//! app), because the engine is started with a clean environment and a variable would not arrive.

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

fn tasks_kind(method: &str) -> Option<&'static str> {
    tasks_hub::engine::Calls::parse(method).map(|m| m.reply_kind())
}

fn rules_kind(method: &str) -> Option<&'static str> {
    match method {
        "hello" => Some("rules.hello"),
        "snapshot" => Some("rules.snapshot"),
        "list" => Some("rules.list"),
        _ => None,
    }
}

/// The tasks engine (`tasks.nvim`), and the default.
pub const TASKS: FakeDialect = FakeDialect {
    name: "tasks",
    plugin: "tasks.nvim",
    error_kind: "tasks.error",
    unknown_kind: "tasks.unknown",
    vault_var: "TASKS_VAULT",
    host_script: "tasks-host.lua",
    list_key: "tasks",
    kind_of: tasks_kind,
};

/// A second engine, `rules.nvim`: nothing in it is the tasks engine's.
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
    /// The dialect the arguments of the process ask for: a script whose file name starts with
    /// `rules`; anything else is the tasks engine.
    #[must_use]
    pub fn of_args(args: &[String]) -> &'static FakeDialect {
        let plays_rules = args.iter().any(|a| {
            Path::new(a)
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(RULES.name) && n.ends_with(".lua"))
        });
        if plays_rules {
            &RULES
        } else {
            &TASKS
        }
    }

    /// The kind of the answer to `method`.
    #[must_use]
    pub fn kind(&self, method: &str) -> &'static str {
        (self.kind_of)(method).unwrap_or(self.unknown_kind)
    }

    /// Is this argument the persistent host script of either dialect?
    #[must_use]
    pub fn is_host_script(arg: &str) -> bool {
        arg.ends_with(TASKS.host_script) || arg.ends_with(RULES.host_script)
    }
}
