//! `CliEngine`: one `nvim --headless -l scripts/tasks.lua call <method>`
//! process per question (concept 3.5, stage P2).
//!
//! Three rules hold here, each with a test:
//!
//! * exactly one question is in flight; the others wait in a bounded FIFO
//!   (the engine's lock is not re-entrant, and a later persistent host must
//!   be able to share this seam);
//! * every process has a watchdog: past its time it is killed;
//! * the child gets the allow-listed environment and nothing else.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use app_core::proc::{self, ProcError};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use super::wire::ascii_json;
use super::{child_env, CallFuture, Engine, EngineError, EngineRefusal, Method, Reply, SCHEMA};
use crate::config::Env;
use crate::discovery::{engine_script, Setup};

/// The engine switches the hub sets from its own settings.
pub struct EngineVars<'a> {
    pub vault: &'a Path,
    pub lib_dir: Option<&'a Path>,
    pub extra_areas: &'a [String],
}

/// What a `CliEngine` needs.
#[derive(Debug, Clone)]
pub struct CliEngineConfig {
    pub nvim: PathBuf,
    /// `<tasks.nvim>/scripts/tasks.lua`.
    pub script: PathBuf,
    pub vault: PathBuf,
    pub lib_dir: Option<PathBuf>,
    pub extra_areas: Vec<String>,
    /// The hub's environment; only the allow-list of [`child_env`] is used.
    pub env: Env,
    /// Watchdog per question.
    pub timeout: Duration,
    /// How many questions may wait behind the one in flight.
    pub max_queue: usize,
    /// The longest answer that is accepted.
    pub max_reply_bytes: usize,
}

impl CliEngineConfig {
    #[must_use]
    pub fn from_setup(setup: &Setup, env: Env) -> Self {
        Self {
            nvim: setup.nvim.value.clone(),
            script: engine_script(&setup.engine_dir.value),
            vault: setup.vault.value.clone(),
            lib_dir: setup.lib_dir.as_ref().map(|l| l.value.clone()),
            extra_areas: setup.extra_areas.clone(),
            env,
            timeout: Duration::from_secs(30),
            max_queue: 64,
            // The snapshot of the real vault is below 8 MiB (concept 11.1, P1).
            max_reply_bytes: 16 * 1024 * 1024,
        }
    }
}

/// The head every document starts with.
#[derive(Deserialize)]
struct Head {
    schema: Option<u64>,
    kind: Option<String>,
    code: Option<String>,
    message: Option<String>,
    retryable: Option<bool>,
}

/// Counts the questions that wait, and gives the place back on every exit.
struct Place<'a>(&'a AtomicUsize);

impl<'a> Place<'a> {
    fn take(counter: &'a AtomicUsize, limit: usize) -> Option<Self> {
        // `limit` waiting plus the one in flight.
        if counter.fetch_add(1, Ordering::AcqRel) > limit {
            counter.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self(counter))
    }
}

impl Drop for Place<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct CliEngine {
    cfg: CliEngineConfig,
    gate: Mutex<()>,
    pending: AtomicUsize,
}

impl CliEngine {
    #[must_use]
    pub fn new(cfg: CliEngineConfig) -> Self {
        Self {
            cfg,
            gate: Mutex::new(()),
            pending: AtomicUsize::new(0),
        }
    }

    fn args(&self, method: Method, with_params: bool) -> Vec<OsString> {
        // `-u NONE`: no configuration, no plugins. `-i NONE`: no shada file.
        // `-n`: no swap file. The vault comes through the environment, not
        // argv, so no global option can be moved behind the verb.
        let mut args: Vec<OsString> = ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-l"]
            .iter()
            .map(OsString::from)
            .collect();
        args.push(self.cfg.script.clone().into_os_string());
        args.push(OsString::from("call"));
        args.push(OsString::from(method.as_str()));
        if with_params {
            args.push(OsString::from("--params=-"));
        }
        args
    }

    /// Cut paths and control characters out of text that came from the
    /// engine's error output before it is shown anywhere.
    fn scrub(&self, text: &str) -> String {
        let mut out = text.to_owned();
        let mut roots: Vec<String> = Vec::new();
        if let Some(engine_dir) = self.cfg.script.parent().and_then(Path::parent) {
            roots.push(engine_dir.display().to_string());
        }
        roots.push(self.cfg.vault.display().to_string());
        if let Some(lib) = &self.cfg.lib_dir {
            roots.push(lib.display().to_string());
        }
        for root in roots.into_iter().filter(|r| r.len() > 3) {
            out = out.replace(&root, "<path>");
            out = out.replace(&root.replace('\\', "/"), "<path>");
        }
        let cleaned: String = out
            .chars()
            .map(|c| if c.is_control() && c != ' ' { ' ' } else { c })
            .collect();
        let mut short: String = cleaned.trim().chars().take(300).collect();
        if cleaned.trim().chars().count() > 300 {
            short.push('…');
        }
        short
    }

    async fn call_inner(
        &self,
        method: Method,
        params: Option<&Value>,
    ) -> Result<Reply, EngineError> {
        let stdin = match (method.takes_params(), params) {
            (false, Some(_)) => {
                return Err(EngineError::BadRequest(format!(
                    "{} takes no parameters",
                    method.as_str()
                )));
            }
            (true, None) if method == Method::Ops => {
                return Err(EngineError::BadRequest("ops needs a request".to_owned()));
            }
            (_, Some(v)) if !v.is_object() => {
                return Err(EngineError::BadRequest(
                    "the parameters must be a JSON object".to_owned(),
                ));
            }
            (_, Some(v)) => {
                Some(ascii_json(v).map_err(|e| EngineError::BadRequest(e.to_string()))?)
            }
            (_, None) => None,
        };

        let place = Place::take(&self.pending, self.cfg.max_queue).ok_or(EngineError::Busy)?;
        let permit = self.gate.lock().await;

        let vars = EngineVars {
            vault: &self.cfg.vault,
            lib_dir: self.cfg.lib_dir.as_deref(),
            extra_areas: &self.cfg.extra_areas,
        };
        let spec = proc::Spec {
            program: self.cfg.nvim.clone(),
            args: self.args(method, stdin.is_some()),
            env: child_env(&self.cfg.env, Some(&vars)),
            cwd: self
                .cfg
                .script
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf),
            stdin: stdin.map(String::into_bytes).unwrap_or_default(),
            timeout: self.cfg.timeout,
            max_stdout: self.cfg.max_reply_bytes,
            max_stderr: 64 * 1024,
        };
        let result = proc::run(spec).await;
        drop(permit);
        drop(place);

        let out = result.map_err(|e| match e {
            ProcError::Timeout(_) => EngineError::Timeout,
            ProcError::TooLarge { .. } => {
                EngineError::Protocol("the answer is larger than the limit".to_owned())
            }
            other => EngineError::Process(self.scrub(&other.to_string())),
        })?;

        let stderr = String::from_utf8_lossy(&out.stderr);
        let Ok(text) = std::str::from_utf8(&out.stdout) else {
            return Err(EngineError::Protocol("the answer is not UTF-8".to_owned()));
        };
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            return Err(EngineError::Failed {
                code: out.code,
                detail: self.scrub(&stderr),
            });
        }
        let head: Head = match serde_json::from_str(text) {
            Ok(h) => h,
            Err(_) => {
                return Err(EngineError::Failed {
                    code: out.code,
                    detail: self.scrub(&format!("no document: {stderr}")),
                });
            }
        };
        if head.schema != Some(SCHEMA) {
            return Err(EngineError::Protocol(format!(
                "unsupported schema {:?}",
                head.schema
            )));
        }
        let kind = head.kind.unwrap_or_default();
        if kind == "tasks.error" {
            return Err(EngineError::Refused(EngineRefusal {
                code: head.code.unwrap_or_else(|| "internal".to_owned()),
                message: head.message.unwrap_or_default(),
                retryable: head.retryable.unwrap_or(false),
                text: text.to_owned(),
            }));
        }
        if kind != method.reply_kind() {
            return Err(EngineError::Protocol(format!(
                "{} answered with kind {kind:?}, expected {:?}",
                method.as_str(),
                method.reply_kind()
            )));
        }
        Ok(Reply {
            kind,
            text: text.to_owned(),
        })
    }
}

impl Engine for CliEngine {
    fn call<'a>(&'a self, method: Method, params: Option<&'a Value>) -> CallFuture<'a> {
        Box::pin(self.call_inner(method, params))
    }
}
