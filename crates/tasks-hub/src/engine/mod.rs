//! The engine seam of the tasks hub: the seam itself is `appkit_hub::engine`; what is the tasks
//! engine's own is here: its calls, its dialect and how a setup becomes a `CliEngine`.
//!
//! A [`Method`] is a closed list, never a string from outside (concept 5.5 Nr. 8): the only way
//! from a name to a call is [`Calls::parse`].

// Named, not a glob: the kit's own `probe` takes the dialect, this module's `probe` is the one of the tasks engine.
pub use appkit_hub::engine::{
    ascii_json, child_env, is_unprintable, CallFuture, CliEngine, CliEngineConfig, Engine,
    EngineBuild, EngineDialect, EngineError, EngineInfo, EngineRefusal, EngineVars, HostFailure,
    Method, MethodSpec, ProbeProblem, Reply,
};

use crate::config::Env;
use crate::discovery::{engine_script, Setup};

/// The contract version this hub speaks.
pub const SCHEMA: u64 = 1;

/// What the read side of the app needs from the engine.
pub const REQUIRED_CAPABILITIES: &[&str] = &["hello", "snapshot", "list", "task", "next", "areas"];

/// What the seam must know about the tasks engine.
pub const DIALECT: EngineDialect = EngineDialect {
    schema: SCHEMA,
    error_kind: "tasks.error",
    host_script: "tasks-host.lua",
    vault_var: "TASKS_VAULT",
    extra_areas_var: "TASKS_EXTRA_AREAS",
    required_capabilities: REQUIRED_CAPABILITIES,
    hello: Calls::Hello,
    engine_name: "the tasks.nvim checkout",
};

/// Ask `hello` and check the answer against what this app needs.
///
/// # Errors
///
/// A [`ProbeProblem`] when the engine does not answer, speaks another
/// contract version or lacks a capability.
pub async fn probe(engine: &dyn Engine) -> Result<EngineInfo, ProbeProblem> {
    appkit_hub::engine::probe(engine, &DIALECT).await
}

/// The configuration of a `CliEngine` for what the setup found.
#[must_use]
pub fn cli_config_from_setup(setup: &Setup, env: Env) -> CliEngineConfig {
    CliEngineConfig {
        dialect: DIALECT,
        nvim: setup.nvim.value.clone(),
        script: engine_script(&setup.engine_dir.value),
        vault: setup.vault.value.clone(),
        lib_dir: setup.lib_dir.as_ref().map(|l| l.value.clone()),
        extra_areas: setup.extra_areas.clone(),
        env,
        timeout: std::time::Duration::from_secs(30),
        max_queue: 64,
        // The snapshot of the real vault is below 8 MiB (concept 11.1, P1).
        max_reply_bytes: 16 * 1024 * 1024,
    }
}

/// The calls of the contract `tasks-export/1` and `tasks-ops/1`: the table of this app. The seam
/// reads the flags of each entry; it knows no call by name.
static SPECS: [MethodSpec; 15] = [
    MethodSpec::bare("hello", "tasks.hello"),
    MethodSpec::bare("snapshot", "tasks.snapshot"),
    MethodSpec::read("list", "tasks.list"),
    MethodSpec::read("task", "tasks.task"),
    MethodSpec::read("bodies", "tasks.bodies"),
    MethodSpec::aside("check", "tasks.check"),
    MethodSpec::read("estimate", "tasks.estimate"),
    MethodSpec::read("next", "tasks.next"),
    MethodSpec::bare("areas", "tasks.areas"),
    MethodSpec::bare("links", "tasks.links"),
    MethodSpec::read("finished", "tasks.finished"),
    MethodSpec::read("done_preview", "tasks.donepreview"),
    MethodSpec::read("plan_for", "tasks.planfor"),
    MethodSpec::write("ops", "tasks.result"),
    MethodSpec::read("order", "tasks.order"),
];

/// The calls of the tasks engine, by name.
pub struct Calls;

#[allow(non_upper_case_globals)]
impl Calls {
    pub const Hello: Method = Method::new(&SPECS[0]);
    pub const Snapshot: Method = Method::new(&SPECS[1]);
    pub const List: Method = Method::new(&SPECS[2]);
    pub const Task: Method = Method::new(&SPECS[3]);
    pub const Bodies: Method = Method::new(&SPECS[4]);
    pub const Check: Method = Method::new(&SPECS[5]);
    pub const Estimate: Method = Method::new(&SPECS[6]);
    pub const Next: Method = Method::new(&SPECS[7]);
    pub const Areas: Method = Method::new(&SPECS[8]);
    pub const Links: Method = Method::new(&SPECS[9]);
    pub const Finished: Method = Method::new(&SPECS[10]);
    pub const DonePreview: Method = Method::new(&SPECS[11]);
    pub const PlanFor: Method = Method::new(&SPECS[12]);
    pub const Ops: Method = Method::new(&SPECS[13]);
    pub const Order: Method = Method::new(&SPECS[14]);

    /// Every call of the table.
    pub const ALL: [Method; 15] = [
        Self::Hello,
        Self::Snapshot,
        Self::List,
        Self::Task,
        Self::Bodies,
        Self::Check,
        Self::Estimate,
        Self::Next,
        Self::Areas,
        Self::Links,
        Self::Finished,
        Self::DonePreview,
        Self::PlanFor,
        Self::Ops,
        Self::Order,
    ];

    /// Parse the name of a route or a request. Nothing else is accepted.
    #[must_use]
    pub fn parse(name: &str) -> Option<Method> {
        Method::find(&Self::ALL, name)
    }
}

#[cfg(test)]
mod table_tests {
    use super::Calls;

    /// The seam treats a call by its flags, not by its name: these are the calls that were special
    /// when the names were still matched in the seam.
    #[test]
    fn only_ops_writes_and_only_check_runs_aside() {
        for m in Calls::ALL {
            assert_eq!(m.writes(), m == Calls::Ops, "{}", m.as_str());
            assert_eq!(m.needs_params(), m == Calls::Ops, "{}", m.as_str());
            assert_eq!(m.is_aside(), m == Calls::Check, "{}", m.as_str());
        }
    }

    #[test]
    fn the_calls_without_parameters_are_the_four_bare_reads() {
        let bare: Vec<_> = Calls::ALL
            .iter()
            .filter(|m| !m.takes_params())
            .map(|m| m.as_str())
            .collect();
        assert_eq!(bare, ["hello", "snapshot", "areas", "links"]);
    }

    #[test]
    fn every_name_round_trips_and_every_answer_kind_is_the_apps() {
        for m in Calls::ALL {
            assert_eq!(Calls::parse(m.as_str()), Some(m));
            assert!(m.reply_kind().starts_with("tasks."), "{}", m.as_str());
        }
        assert_eq!(Calls::ALL.len(), 15);
    }
}
