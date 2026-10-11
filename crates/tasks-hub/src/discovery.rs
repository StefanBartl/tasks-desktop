//! Find Neovim, the engine checkout and the vault, and probe them.
//!
//! The chain for each value is: the settings file, then an environment
//! variable, then a search. A value that is set decides: if it is wrong the
//! answer is an error that names it, never a quiet fall back to another
//! place. Every step that fails is kept in the problem, so the setup page
//! can list what was tried. No script of the user's own Neovim
//! configuration is ever loaded: the engine runs with `-u NONE`.

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
    /// `None` when no checkout was found by the hub's own search; the
    /// engine still looks in places the hub does not (`.deps`, the plugin
    /// manager's folder), so this is a hint and not yet an error.
    pub lib_dir: Option<Resolved<PathBuf>>,
    /// Why `lib_dir` is `None`, with what was tried.
    pub lib_problem: Option<SetupProblem>,
    pub vault: Resolved<PathBuf>,
    pub extra_areas: Vec<String>,
}

/// What stands between the user and a running hub. Each one is shown on a
/// setup page with the places that were tried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupProblem {
    /// A value of the settings file is not acceptable.
    InvalidSetting(String),
    NoVault {
        tried: Vec<String>,
    },
    VaultNotADirectory(PathBuf),
    NvimNotFound {
        tried: Vec<String>,
    },
    NvimProbeFailed(String),
    NvimTooOld {
        found: (u32, u32, u32),
    },
    EngineNotFound {
        tried: Vec<String>,
    },
    LibNotFound {
        tried: Vec<String>,
    },
}

impl fmt::Display for SetupProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSetting(why) => write!(f, "invalid setting: {why}"),
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

/// Make a path absolute without touching the file system. The engine runs
/// in another working folder, so a relative path would mean something else
/// there.
fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The file names a program may have on this platform.
fn program_names(base: &str) -> Vec<String> {
    if cfg!(windows) && Path::new(base).extension().is_none() {
        vec![format!("{base}.exe")]
    } else {
        vec![base.to_owned()]
    }
}

/// Look a program up on `PATH`, without a shell.
///
/// An empty or relative entry of `PATH` means "the current folder" to
/// some systems; a program from there is never run, so a file planted in
/// the folder the hub happens to run in is not picked up.
fn search_path(env: &Env, names: &[String]) -> Option<PathBuf> {
    let path = env.get("PATH")?;
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute() {
            continue;
        }
        for name in names {
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
    let value = absolute(&value);
    if !value.is_dir() {
        return Err(SetupProblem::VaultNotADirectory(value));
    }
    Ok(Resolved { value, source })
}

fn resolve_nvim(file: &FileConfig, env: &Env) -> Result<Resolved<PathBuf>, SetupProblem> {
    let explicit = if let Some(v) = &file.nvim {
        Some((v.clone(), Source::Setting))
    } else {
        env.path("TASKS_NVIM")
            .map(|v| (v, Source::Env("TASKS_NVIM")))
    };
    if let Some((value, source)) = explicit {
        // A bare name ("nvim") is looked up on PATH; a path is taken as it is.
        let bare = value.is_relative() && value.components().count() == 1;
        let path = if bare {
            let name = value.to_string_lossy().into_owned();
            search_path(env, &program_names(&name))
        } else {
            Some(absolute(&value))
        };
        return match path {
            Some(value) if value.is_file() => Ok(Resolved { value, source }),
            _ => Err(SetupProblem::NvimNotFound {
                tried: vec![format!("{} (from {source})", value.display())],
            }),
        };
    }
    match search_path(env, &program_names("nvim")) {
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
    let explicit = if let Some(v) = &file.engine_dir {
        Some((v.clone(), Source::Setting))
    } else {
        env.path("TASKS_ENGINE_DIR")
            .map(|v| (v, Source::Env("TASKS_ENGINE_DIR")))
    };
    if let Some((dir, source)) = explicit {
        let dir = absolute(&dir);
        return if is_engine_dir(&dir) {
            Ok(Resolved { value: dir, source })
        } else {
            Err(SetupProblem::EngineNotFound {
                tried: vec![format!("{} (from {source})", dir.display())],
            })
        };
    }
    if let Some(repos) = env.path("REPOS_DIR") {
        let dir = absolute(&repos.join("tasks.nvim"));
        if is_engine_dir(&dir) {
            return Ok(Resolved {
                value: dir,
                source: Source::Search("REPOS_DIR/tasks.nvim".to_owned()),
            });
        }
        return Err(SetupProblem::EngineNotFound {
            tried: vec![dir.display().to_string()],
        });
    }
    Err(SetupProblem::EngineNotFound {
        tried: vec![
            "the settings file (engine_dir)".to_owned(),
            "the environment variable TASKS_ENGINE_DIR".to_owned(),
            "REPOS_DIR/tasks.nvim".to_owned(),
        ],
    })
}

fn resolve_lib(
    file: &FileConfig,
    env: &Env,
    engine_dir: &Path,
) -> Result<Resolved<PathBuf>, SetupProblem> {
    // What is set decides, in the order the engine itself uses.
    let explicit = if let Some(v) = &file.lib_dir {
        Some((v.clone(), Source::Setting))
    } else if let Some(v) = env.path("LIB_NVIM_DIR") {
        Some((v, Source::Env("LIB_NVIM_DIR")))
    } else {
        env.path("LIB_NVIM_PATH")
            .map(|v| (v, Source::Env("LIB_NVIM_PATH")))
    };
    if let Some((dir, source)) = explicit {
        let dir = absolute(&dir);
        return if is_lib_dir(&dir) {
            Ok(Resolved { value: dir, source })
        } else {
            Err(SetupProblem::LibNotFound {
                tried: vec![format!("{} (from {source})", dir.display())],
            })
        };
    }
    let mut candidates: Vec<(PathBuf, Source)> = Vec::new();
    if let Some(r) = env.path("REPOS_DIR") {
        candidates.push((
            absolute(&r.join("lib.nvim")),
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
/// The first [`SetupProblem`] in the order settings, vault, Neovim, engine.
pub async fn discover(file: &FileConfig, env: &Env) -> Result<Setup, SetupProblem> {
    file.validate().map_err(SetupProblem::InvalidSetting)?;
    let vault = resolve_vault(file, env)?;
    let nvim = resolve_nvim(file, env)?;
    let nvim_version = probe_nvim(&nvim.value, env).await?;
    let engine_dir = resolve_engine(file, env)?;
    let (lib_dir, lib_problem) = match resolve_lib(file, env, &engine_dir.value) {
        Ok(lib) => (Some(lib), None),
        Err(problem) => (None, Some(problem)),
    };
    Ok(Setup {
        nvim,
        nvim_version,
        engine_dir,
        lib_dir,
        lib_problem,
        vault,
        extra_areas: file.extra_areas.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tasks-desktop-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

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
        assert_eq!(got.value, absolute(&dir));
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

    #[test]
    fn a_relative_vault_is_made_absolute() {
        let file = FileConfig {
            vault: Some(PathBuf::from(".")),
            ..FileConfig::default()
        };
        let got = resolve_vault(&file, &Env::default()).unwrap();
        assert!(got.value.is_absolute(), "{}", got.value.display());
    }

    #[test]
    fn relative_and_empty_path_entries_are_never_searched() {
        // `cargo test` runs in the package folder, where `Cargo.toml` is a
        // file. PATH names that folder by a relative entry and by an empty
        // one, so a search of relative entries would find it.
        assert!(Path::new("Cargo.toml").is_file(), "the test needs its cwd");
        let sep = if cfg!(windows) { ";" } else { ":" };
        let env = Env::from_pairs([("PATH", format!(".{sep}{sep}relative/bin"))]);
        let found = search_path(&env, &["Cargo.toml".to_owned()]);
        assert_eq!(found, None);
    }

    #[test]
    fn an_absolute_path_entry_is_searched() {
        let dir = temp_dir("path-absolute");
        let name = program_names("tasks-desktop-found")[0].clone();
        std::fs::write(dir.join(&name), b"").unwrap();
        let joined = std::env::join_paths([&dir]).unwrap();
        let env = Env::from_pairs([("PATH", joined)]);
        assert_eq!(
            search_path(&env, std::slice::from_ref(&name)),
            Some(dir.join(&name))
        );
    }

    #[test]
    fn a_wrong_engine_setting_does_not_fall_back_to_repos_dir() {
        let repos = temp_dir("repos-fallback");
        let good = repos.join("tasks.nvim").join("scripts");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(good.join("tasks.lua"), b"").unwrap();
        let file = FileConfig {
            engine_dir: Some(repos.join("typo.nvim")),
            ..FileConfig::default()
        };
        let env = Env::from_pairs([("REPOS_DIR", repos.as_os_str().to_owned())]);
        let err = resolve_engine(&file, &env).unwrap_err();
        assert!(matches!(err, SetupProblem::EngineNotFound { .. }), "{err}");
        // Without the setting the search finds it.
        let got = resolve_engine(&FileConfig::default(), &env).unwrap();
        assert_eq!(got.value, repos.join("tasks.nvim"));
    }

    #[test]
    fn a_wrong_nvim_setting_is_an_error_not_a_search() {
        let file = FileConfig {
            nvim: Some(PathBuf::from("definitely-not-a-program-xyz")),
            ..FileConfig::default()
        };
        let err = resolve_nvim(&file, &Env::from_process()).unwrap_err();
        assert!(matches!(err, SetupProblem::NvimNotFound { .. }), "{err}");
    }
}
