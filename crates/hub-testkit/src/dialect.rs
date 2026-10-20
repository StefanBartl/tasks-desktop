//! What the fake tasks engine calls things: the names of `tasks.nvim`.

use appkit_testkit::dialect::FakeDialect;

fn tasks_kind(method: &str) -> Option<&'static str> {
    tasks_hub::engine::Calls::parse(method).map(|m| m.reply_kind())
}

/// The tasks engine (`tasks.nvim`): the kinds come from the table of calls of the hub.
pub const TASKS: FakeDialect = FakeDialect {
    name: "tasks",
    plugin: "tasks.nvim",
    error_kind: "tasks.error",
    unknown_kind: "tasks.unknown",
    vault_var: "TASKS_VAULT",
    host_script: "tasks-host.lua",
    list_key: "tasks",
    // What the fake says it can do: everything the hub needs (`REQUIRED_CAPABILITIES`) and the calls
    // the routes use, as the engine says it.
    capabilities: &[
        "areas",
        "done_preview",
        "groupings",
        "hello",
        "list",
        "lists",
        "next",
        "ops",
        "order",
        "snapshot",
        "task",
    ],
    kind_of: tasks_kind,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kinds_are_those_of_the_table_of_calls() {
        assert_eq!(TASKS.kind("snapshot"), "tasks.snapshot");
        assert_eq!(TASKS.kind("done_preview"), "tasks.donepreview");
        assert_eq!(TASKS.kind("no-such-call"), "tasks.unknown");
    }

    #[test]
    fn the_tasks_scripts_choose_the_tasks_engine() {
        let args = |s: &str| vec!["-l".to_owned(), s.to_owned()];
        let rules = &appkit_testkit::dialect::RULES;
        for script in ["/x/scripts/tasks.lua", "/x/scripts/tasks-host.lua"] {
            assert_eq!(
                FakeDialect::of_args(&[rules, &TASKS], &args(script)).name,
                "tasks"
            );
        }
    }
}
