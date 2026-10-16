//! Find Neovim, the engine checkout and the vault, and probe them: the search is the kit's, the
//! names it looks for (`TASKS_VAULT`, `TASKS_NVIM`, `TASKS_ENGINE_DIR`, the `tasks.nvim` checkout
//! and its `scripts/tasks.lua`) are stated here.

use std::path::{Path, PathBuf};

use hub_kit::discovery::AppInputs;
pub use hub_kit::discovery::{parse_nvim_version, DiscoverySpec, Setup, SetupProblem, MIN_NVIM};

use crate::config::{Env, FileConfig};

/// What the hub looks for.
pub const SPEC: DiscoverySpec = DiscoverySpec {
    vault_var: "TASKS_VAULT",
    nvim_var: "TASKS_NVIM",
    engine_dir_var: "TASKS_ENGINE_DIR",
    engine_name: "tasks.nvim",
    engine_script: &["scripts", "tasks.lua"],
};

/// The engine entry point inside a tasks.nvim checkout.
#[must_use]
pub fn engine_script(engine_dir: &Path) -> PathBuf {
    hub_kit::discovery::engine_script(&SPEC, engine_dir)
}

/// Resolve everything the engine needs and probe Neovim.
///
/// # Errors
///
/// The first [`SetupProblem`] in the order settings, vault, Neovim, engine.
pub async fn discover(file: &FileConfig, env: &Env) -> Result<Setup, SetupProblem> {
    let inputs = AppInputs {
        lib_dir: file.app.lib_dir.as_deref(),
        extra_areas: &file.app.extra_areas,
    };
    hub_kit::discovery::discover(&SPEC, file, inputs, env).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These names are in the environments of people: a rename is a migration.
    #[test]
    fn the_names_that_are_searched_do_not_move() {
        assert_eq!(SPEC.vault_var, "TASKS_VAULT");
        assert_eq!(SPEC.nvim_var, "TASKS_NVIM");
        assert_eq!(SPEC.engine_dir_var, "TASKS_ENGINE_DIR");
        let script = engine_script(Path::new("E"));
        assert_eq!(
            script,
            Path::new("E").join("scripts").join("tasks.lua"),
            "{script:?}"
        );
    }

    #[test]
    fn the_engine_is_looked_for_under_its_own_name() {
        let problem = SetupProblem::EngineNotFound {
            name: SPEC.engine_name,
            tried: vec!["x".to_owned()],
        };
        assert_eq!(
            problem.to_string(),
            "the tasks.nvim checkout was not found (tried: x)"
        );
    }
}
