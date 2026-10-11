//! `CliEngine`: one `nvim --headless -l scripts/tasks.lua call <method>`
//! process per question (concept 3.5, stage P2).
//!
//! The rules that hold here, each with a test:
//!
//! * exactly one question is in flight; the others wait in a bounded FIFO
//!   (the engine's lock is not re-entrant, and a later persistent host must
//!   be able to share this seam);
//! * every process has a watchdog: past its time it is killed;
//! * the child gets the allow-listed environment and nothing else;
//! * a question runs to its end even when the caller gives up, so a client
//!   that disconnects never kills a write half way; a read that nobody waits
//!   for any more is dropped before it starts;
//! * a write that does not end with a document is reported as
//!   [`EngineError::OutcomeUnknown`], never as a plain failure.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use app_core::proc::{self, ProcError};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{oneshot, Mutex};

use super::wire::ascii_json;
use super::{child_env, CallFuture, Engine, EngineError, EngineRefusal, Method, Reply, SCHEMA};
use crate::config::Env;
use crate::discovery::{engine_script, Setup};

/// The longest request the engine reads (`api.MAX_REQUEST_BYTES`). A larger
/// one is refused here, before a process is started for nothing.
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;

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
    /// `<tasks.nvim>/scripts/tasks.lua`, absolute.
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

struct Inner {
    cfg: CliEngineConfig,
    /// The one place of the engine; a fair queue.
    gate: Mutex<()>,
    /// Questions that were accepted and are not finished: the one in flight
    /// and those that wait.
    pending: AtomicUsize,
}

/// A place in the queue. It is given back when the work is finished, not
/// when the caller leaves.
struct Place(Arc<Inner>);

impl Place {
    fn take(inner: &Arc<Inner>) -> Option<Self> {
        // `max_queue` waiting plus the one in flight.
        if inner.pending.fetch_add(1, Ordering::AcqRel) > inner.cfg.max_queue {
            inner.pending.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self(Arc::clone(inner)))
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct CliEngine {
    inner: Arc<Inner>,
}

/// Characters that are no use in a line of text shown to a person: controls
/// and the invisible ones that can reorder or hide text.
fn is_unprintable(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}' | '\u{feff}'
        )
}

impl Inner {
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

    /// Cut paths and unprintable characters out of text that came from the
    /// engine's error output before it is shown anywhere.
    fn scrub(&self, text: &str) -> String {
        let mut roots: Vec<String> = Vec::new();
        if let Some(engine_dir) = self.cfg.script.parent().and_then(Path::parent) {
            roots.push(engine_dir.display().to_string());
        }
        roots.push(self.cfg.vault.display().to_string());
        if let Some(lib) = &self.cfg.lib_dir {
            roots.push(lib.display().to_string());
        }
        for home in ["USERPROFILE", "HOME"] {
            if let Some(h) = self.cfg.env.get(home) {
                roots.push(h.to_string_lossy().into_owned());
            }
        }
        let mut out = text.to_owned();
        for root in roots.into_iter().filter(|r| r.len() > 3) {
            out = out.replace(&root, "<path>");
            out = out.replace(&root.replace('\\', "/"), "<path>");
        }
        let cleaned: String = out
            .chars()
            .map(|c| if is_unprintable(c) { ' ' } else { c })
            .collect();
        let trimmed = cleaned.trim();
        let mut short: String = trimmed.chars().take(300).collect();
        if trimmed.chars().count() > 300 {
            short.push('…');
        }
        short
    }

    /// Run the process and judge what it left. Holds the place of the
    /// engine while it runs.
    async fn execute(
        &self,
        method: Method,
        stdin: Option<String>,
        abandoned: impl Fn() -> bool,
    ) -> Result<Reply, EngineError> {
        let permit = self.gate.lock().await;
        // A read that nobody waits for any more is not worth a process. A
        // write is always carried out: its caller may be gone, its client
        // knows it by `client_op_id`.
        if method != Method::Ops && abandoned() {
            return Err(EngineError::Process("the caller gave up".to_owned()));
        }

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

        let out = result.map_err(|e| match e {
            ProcError::Spawn(_) => EngineError::Spawn(self.scrub(&e.to_string())),
            ProcError::Timeout(_) => EngineError::Timeout,
            ProcError::TooLarge { stream, .. } => {
                EngineError::Protocol(format!("{stream} is larger than the limit"))
            }
            ProcError::Io(_) => EngineError::Process(self.scrub(&e.to_string())),
        });
        match out.and_then(|o| self.judge(method, o)) {
            Err(e) if method == Method::Ops => Err(e.for_write()),
            other => other,
        }
    }

    /// Turn what the process left into a reply or an error.
    fn judge(&self, method: Method, out: proc::Output) -> Result<Reply, EngineError> {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let mut text = String::from_utf8(out.stdout)
            .map_err(|_| EngineError::Protocol("the answer is not UTF-8".to_owned()))?;
        // The document is one line; the line ending (CRLF on Windows) goes.
        text.truncate(text.trim_end_matches(['\r', '\n']).len());
        if text.is_empty() {
            return Err(EngineError::Failed {
                code: out.code,
                detail: self.scrub(&stderr),
            });
        }
        let Ok(head) = serde_json::from_str::<Head>(&text) else {
            return Err(EngineError::Failed {
                code: out.code,
                detail: self.scrub(&format!("no document: {stderr}")),
            });
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
                text,
            }));
        }
        if kind != method.reply_kind() {
            return Err(EngineError::Protocol(format!(
                "{} answered with kind {kind:?}, expected {:?}",
                method.as_str(),
                method.reply_kind()
            )));
        }
        Ok(Reply { kind, text })
    }
}

impl CliEngine {
    #[must_use]
    pub fn new(cfg: CliEngineConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                cfg,
                gate: Mutex::new(()),
                pending: AtomicUsize::new(0),
            }),
        }
    }

    /// How many questions are accepted and not finished (in flight plus
    /// waiting). For status pages and for tests.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.inner.pending.load(Ordering::Acquire)
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
            (_, None) if method == Method::Ops => {
                return Err(EngineError::BadRequest("ops needs a request".to_owned()));
            }
            (_, Some(v)) if !v.is_object() => {
                return Err(EngineError::BadRequest(
                    "the parameters must be a JSON object".to_owned(),
                ));
            }
            (_, Some(v)) => {
                let text = ascii_json(v).map_err(|e| EngineError::BadRequest(e.to_string()))?;
                if text.len() > MAX_REQUEST_BYTES {
                    return Err(EngineError::BadRequest(format!(
                        "the request is larger than {} KiB",
                        MAX_REQUEST_BYTES / 1024
                    )));
                }
                Some(text)
            }
            (_, None) => None,
        };

        let place = Place::take(&self.inner).ok_or(EngineError::Busy)?;
        let (tx, rx) = oneshot::channel();
        let inner = Arc::clone(&self.inner);
        // The work runs on its own task: dropping the caller's future does
        // not kill a child that may be writing task files.
        tokio::spawn(async move {
            let _place = place;
            let result = inner.execute(method, stdin, || tx.is_closed()).await;
            let _ = tx.send(result);
        });
        rx.await.unwrap_or_else(|_| {
            Err(EngineError::Process(
                "the engine task ended without an answer".to_owned(),
            ))
        })
    }
}

impl Engine for CliEngine {
    fn call<'a>(&'a self, method: Method, params: Option<&'a Value>) -> CallFuture<'a> {
        Box::pin(self.call_inner(method, params))
    }
}
