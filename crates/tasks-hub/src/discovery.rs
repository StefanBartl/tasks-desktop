//! Find Neovim, the engine checkout and the vault, and probe them.
//!
//! The chain for each value is: the settings file, then an environment
//! variable, then a search. Every step that fails is kept in the problem, so
//! the setup page can list what was tried. No script of the user's own
//! Neovim configuration is ever loaded: the engine runs with `-u NONE`.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use app_core::proc;

use crate::config::{Env, FileConfig, Resolved, Source};

/// The oldest Neovim the engine is tested against (concept 13.3).
pub const MIN_NVIM: (u32, u32, u32) = (0, 12, 0);

/// What the hub needs to start the engine.
#[derive(Debug, Clone)]
pub struct Setup {
    pub nvim: Resolved<PathBuf>,
    pub nvim_version: (u32, u32, u32),
    pub engine_dir: Resolved<PathBuf>,
    pub lib_dir: Option<Resolved<PathBuf>>,
    pub vault: Resolved<PathBuf>,
    pub extra_areas: Vec<String>,
}

/// What stands between the user and a running hub. Each one is shown on a
/// setup page with the places that were tried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupProblem {
    NoVault { tried: Vec<String> },
    VaultNotADirectory(PathBuf),
    NvimNotFound { tried: Vec<String> },
    NvimProbeFailed(String),
    NvimTooOld { found: (u32, u32, u32) },
    EngineNotFound { tried: Vec<String> },
    LibNotFound { tried: Vec<String> },
}

impl fmt::Display for SetupProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoVault { tried } => {
                write!(f, "no vault is set (tried: {})", tried.join(", "))
            }
            Self::VaultNotADirectory(p) => write!(f, "the vault is not a folder: {}", p.display()),
            Self::NvimNotFound { tried } => {
                write!(f, "Neovim was not found (tried: {})", tried.join(", "))
            }
            Self::NvimProbeFailed(why) => write!(f, "Neovim does not run: {why}"),
            Self::NvimTooOld { found } => write!(
                f,
                "Neovim {}.{}.{} is older than {}.{}.{}",
                found.0, found.1, found.2, MIN_NVIM.0, MIN_NVIM.1, MIN_NVIM.2
            ),
            Self::EngineNotFound { tried } => write!(
                f,
                "the tasks.nvim checkout was not found (tried: {})",
                tried.join(", ")
            ),
            Self::LibNotFound { tried } => write!(
                f,
                "the lib.nvim checkout was not found (tried: {})",
                tried.join(", ")
            ),
        }
    }
}

impl std::error::Error for SetupProblem {}

/// The engine entry point inside a tasks.nvim checkout.
#[must_use]
pub fn engine_script(engine_dir: &Path) -> PathBuf {
    engine_dir.join("scripts").join("tasks.lua")
}

fn is_engine_dir(dir: &Path) -> bool {
    engine_script(dir).is_file()
}

fn is_lib_dir(dir: &Path) -> bool {
    dir.join("lua").join("lib").join("nvim").is_dir()
}

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["nvim.exe", "nvim.cmd", "nvim.bat"]
    } else {
        &["nvim"]
    }
}

/// Look `nvim` up on `PATH`, without a shell.
fn find_on_path(env: &Env) -> Option<PathBuf> {
    let path = env.get("PATH")?;
    for dir in std::env::split_paths(path) {
        for name in exe_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Parse `NVIM v0.12.2` out of the first line of `nvim --version`.
#[must_use]
pub fn parse_nvim_version(text: &str) -> Option<(u32, u32, u32)> {
    let line = text.lines().next()?;
    let rest = line.trim().strip_prefix("NVIM v")?;
    let core: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = core.split('.').map(str::parse::<u32>);
    let major = parts.next()?.ok()?;
    let minor = parts.next()?.ok()?;
    let patch = parts.next().and_then(Result::ok).unwrap_or(0);
    Some((major, minor, patch))
}

fn resolve_vault(file: &FileConfig, env: &Env) -> Result<Resolved<PathBuf>, SetupProblem> {
    let (value, source) = if let Some(v) = &file.vault {
        (v.clone(), Source::Setting)
    } else if let Some(v) = env.path("TASKS_VAULT") {
        (v, Source::Env("TASKS_VAULT"))
    } else {
        return Err(SetupProblem::NoVault {
            tried: vec![
                "the settings file (vault)".to_owned(),
                "the environment variable TASKS_VAULT".to_owned(),
            ],
        });
    };
    if !value.is_dir() {
        return Err(SetupProblem::VaultNotADirectory(value));
    }
    Ok(Resolved { value, source })
}

fn resolve_nvim(file: &FileConfig, env: &Env) -> Result<Resolved<PathBuf>, SetupProblem> {
    if let Some(v) = &file.nvim {
        return Ok(Resolved {
            value: v.clone(),
            source: Source::Setting,
        });
    }
    if let Some(v) = env.path("TASKS_NVIM") {
        return Ok(Resolved {
            value: v,
            source: Source::Env("TASKS_NVIM"),
        });
    }
    match find_on_path(env) {
        Some(value) => Ok(Resolved {
            value,
            source: Source::Search("PATH".to_owned()),
        }),
        None => Err(SetupProblem::NvimNotFound {
            tried: vec![
                "the settings file (nvim)".to_owned(),
                "the environment variable TASKS_NVIM".to_owned(),
                "PATH".to_owned(),
            ],
        }),
    }
}

fn resolve_engine(file: &FileConfig, env: &Env) -> Result<Resolved<PathBuf>, SetupProblem> {
    let mut tried = Vec::new();
    let mut candidates: Vec<(PathBuf, Source)> = Vec::new();
    if let Some(v) = &file.engine_dir {
        candidates.push((v.clone(), Source::Setting));
    }
    if let Some(v) = env.path("TASKS_ENGINE_DIR") {
        candidates.push((v, Source::Env("TASKS_ENGINE_DIR")));
    }
    if let Some(r) = env.path("REPOS_DIR") {
        candidates.push((
            r.join("tasks.nvim"),
            Source::Search("REPOS_DIR/tasks.nvim".to_owned()),
        ));
    }
    for (dir, source) in candidates {
        if is_engine_dir(&dir) {
            return Ok(Resolved { value: dir, source });
        }
        tried.push(dir.display().to_string());
    }
    if tried.is_empty() {
        tried.push("the settings file (engine_dir), TASKS_ENGINE_DIR, REPOS_DIR".to_owned());
    }
    Err(SetupProblem::EngineNotFound { tried })
}

fn resolve_lib(
    file: &FileConfig,
    env: &Env,
    engine_dir: &Path,
) -> Result<Resolved<PathBuf>, SetupProblem> {
    let mut candidates: Vec<(PathBuf, Source)> = Vec::new();
    if let Some(v) = &file.lib_dir {
        candidates.push((v.clone(), Source::Setting));
    }
    if let Some(v) = env.path("LIB_NVIM_DIR") {
        candidates.push((v, Source::Env("LIB_NVIM_DIR")));
    }
    if let Some(v) = env.path("LIB_NVIM_PATH") {
        candidates.push((v, Source::Env("LIB_NVIM_PATH")));
    }
    if let Some(r) = env.path("REPOS_DIR") {
        candidates.push((
            r.join("lib.nvim"),
            Source::Search("REPOS_DIR/lib.nvim".to_owned()),
        ));
    }
    if let Some(parent) = engine_dir.parent() {
        candidates.push((
            parent.join("lib.nvim"),
            Source::Search("next to the tasks.nvim checkout".to_owned()),
        ));
    }
    let mut tried = Vec::new();
    for (dir, source) in candidates {
        if is_lib_dir(&dir) {
            return Ok(Resolved { value: dir, source });
        }
        tried.push(dir.display().to_string());
    }
    Err(SetupProblem::LibNotFound { tried })
}

/// Ask Neovim for its version, with the same empty environment as the engine.
async fn probe_nvim(nvim: &Path, env: &Env) -> Result<(u32, u32, u32), SetupProblem> {
    let spec = proc::Spec {
        program: nvim.to_path_buf(),
        args: vec![OsString::from("--version")],
        env: crate::engine::child_env(env, None),
        cwd: None,
        stdin: Vec::new(),
        timeout: Duration::from_secs(10),
        max_stdout: 64 * 1024,
        max_stderr: 64 * 1024,
    };
    let out = proc::run(spec)
        .await
        .map_err(|e| SetupProblem::NvimProbeFailed(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let version = parse_nvim_version(&text).ok_or_else(|| {
        SetupProblem::NvimProbeFailed("the answer of --version is not recognised".to_owned())
    })?;
    if version < MIN_NVIM {
        return Err(SetupProblem::NvimTooOld { found: version });
    }
    Ok(version)
}

/// Resolve everything the engine needs and probe Neovim.
///
/// # Errors
///
/// The first [`SetupProblem`] in the order vault, Neovim, engine, lib.nvim.
pub async fn discover(file: &FileConfig, env: &Env) -> Result<Setup, SetupProblem> {
    let vault = resolve_vault(file, env)?;
    let nvim = resolve_nvim(file, env)?;
    let nvim_version = probe_nvim(&nvim.value, env).await?;
    let engine_dir = resolve_engine(file, env)?;
    // lib.nvim is only a hard requirement when the engine cannot find it
    // itself; the engine knows the same places, so a miss here is a problem
    // only if none of them works. We report it, the caller may go on.
    let lib_dir = resolve_lib(file, env, &engine_dir.value).ok();
    Ok(Setup {
        nvim,
        nvim_version,
        engine_dir,
        lib_dir,
        vault,
        extra_areas: file.extra_areas.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_and_dev_versions() {
        assert_eq!(
            parse_nvim_version("NVIM v0.12.2\nBuild type"),
            Some((0, 12, 2))
        );
        assert_eq!(
            parse_nvim_version("NVIM v0.13.0-dev-123+gabc\n"),
            Some((0, 13, 0))
        );
        assert_eq!(parse_nvim_version("vim 9.0"), None);
    }

    #[test]
    fn a_missing_vault_lists_what_was_tried() {
        let err = resolve_vault(&FileConfig::default(), &Env::default()).unwrap_err();
        assert!(matches!(err, SetupProblem::NoVault { tried } if tried.len() == 2));
    }

    #[test]
    fn the_setting_beats_the_environment() {
        let dir = std::env::temp_dir();
        let file = FileConfig {
            vault: Some(dir.clone()),
            ..FileConfig::default()
        };
        let env = Env::from_pairs([("TASKS_VAULT", "Z:/other")]);
        let got = resolve_vault(&file, &env).unwrap();
        assert_eq!(got.source, Source::Setting);
        assert_eq!(got.value, dir);
    }

    #[test]
    fn a_vault_that_is_a_file_is_refused() {
        let real = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let file = FileConfig {
            vault: Some(real.clone()),
            ..FileConfig::default()
        };
        let err = resolve_vault(&file, &Env::default()).unwrap_err();
        assert_eq!(err, SetupProblem::VaultNotADirectory(real));
    }
}
