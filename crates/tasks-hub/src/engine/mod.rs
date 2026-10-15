//! The engine seam: what the hub may ask of tasks.nvim and what comes back.
//!
//! A [`Method`] is a closed list, never a string from outside (concept 5.5
//! Nr. 8). A [`Reply`] is the document as the engine wrote it; the hub
//! checks its head (schema, kind) and passes the text on untouched.

mod cli;
mod host;
mod wire;

use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use crate::config::Env;

pub(crate) use cli::is_unprintable;
pub use cli::{CliEngine, CliEngineConfig, EngineVars};
pub use host::Failure as HostFailure;
pub use wire::ascii_json;

/// The contract version this hub speaks.
pub const SCHEMA: u64 = 1;

/// The calls of the contract `tasks-export/1` and `tasks-ops/1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    Hello,
    Snapshot,
    List,
    Task,
    Bodies,
    Check,
    Estimate,
    Next,
    Areas,
    Links,
    Finished,
    DonePreview,
    PlanFor,
    Ops,
}

impl Method {
    /// The name the engine knows it by.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hello => "hello",
            Self::Snapshot => "snapshot",
            Self::List => "list",
            Self::Task => "task",
            Self::Bodies => "bodies",
            Self::Check => "check",
            Self::Estimate => "estimate",
            Self::Next => "next",
            Self::Areas => "areas",
            Self::Links => "links",
            Self::Finished => "finished",
            Self::DonePreview => "done_preview",
            Self::PlanFor => "plan_for",
            Self::Ops => "ops",
        }
    }

    /// The `kind` the answer must carry.
    #[must_use]
    pub fn reply_kind(self) -> &'static str {
        match self {
            Self::Hello => "tasks.hello",
            Self::Snapshot => "tasks.snapshot",
            Self::List => "tasks.list",
            Self::Task => "tasks.task",
            Self::Bodies => "tasks.bodies",
            Self::Check => "tasks.check",
            Self::Estimate => "tasks.estimate",
            Self::Next => "tasks.next",
            Self::Areas => "tasks.areas",
            Self::Links => "tasks.links",
            Self::Finished => "tasks.finished",
            Self::DonePreview => "tasks.donepreview",
            Self::PlanFor => "tasks.planfor",
            Self::Ops => "tasks.result",
        }
    }

    /// Whether the method carries a request or parameters at all.
    #[must_use]
    pub fn takes_params(self) -> bool {
        !matches!(
            self,
            Self::Hello | Self::Snapshot | Self::Areas | Self::Links
        )
    }

    /// Parse the name of a route or a request. Nothing else is accepted.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "hello" => Self::Hello,
            "snapshot" => Self::Snapshot,
            "list" => Self::List,
            "task" => Self::Task,
            "bodies" => Self::Bodies,
            "check" => Self::Check,
            "estimate" => Self::Estimate,
            "next" => Self::Next,
            "areas" => Self::Areas,
            "links" => Self::Links,
            "finished" => Self::Finished,
            "done_preview" => Self::DonePreview,
            "plan_for" => Self::PlanFor,
            "ops" => Self::Ops,
            _ => return None,
        })
    }
}

/// An answer of the engine: one JSON document on one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub kind: String,
    /// The document text, with the line ending removed.
    pub text: String,
}

/// A `tasks.error` document: the engine refused or failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRefusal {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    /// The document text, ready to be relayed.
    pub text: String,
}

/// Why a call produced no answer.
#[derive(Debug)]
pub enum EngineError {
    /// The engine answered with a `tasks.error` document.
    Refused(EngineRefusal),
    /// The request itself is not one the hub will send (checked before any
    /// process starts).
    BadRequest(String),
    /// More calls are waiting than the hub keeps; try again.
    Busy,
    /// The engine did not answer within its time and was killed.
    Timeout,
    /// The process could not be started: nothing ran, nothing changed.
    Spawn(String),
    /// The process started but its pipes failed.
    Process(String),
    /// The process ended without a document (exit status and a scrubbed
    /// excerpt of its error output).
    Failed { code: Option<i32>, detail: String },
    /// A document came back that does not fit the contract.
    Protocol(String),
    /// A write (`ops`) started and did not end with a document: some of it
    /// may have been written. The caller must read again before it believes
    /// anything about the vault; the text says what happened.
    OutcomeUnknown(String),
}

impl EngineError {
    /// What a failure means for a write: once the process has started, an
    /// error that is not the engine's own refusal leaves the outcome open.
    #[must_use]
    pub fn for_write(self) -> Self {
        match self {
            Self::Timeout | Self::Process(_) | Self::Failed { .. } | Self::Protocol(_) => {
                Self::OutcomeUnknown(self.to_string())
            }
            other => other,
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(r) => write!(f, "engine refused ({}): {}", r.code, r.message),
            Self::BadRequest(m) => write!(f, "bad request: {m}"),
            Self::Busy => f.write_str("the engine queue is full"),
            Self::Timeout => f.write_str("the engine did not answer in time"),
            Self::Spawn(m) => write!(f, "engine could not be started: {m}"),
            Self::Process(m) => write!(f, "engine process: {m}"),
            Self::Failed { code, detail } => match code {
                Some(c) => write!(f, "engine failed (exit {c}): {detail}"),
                None => write!(f, "engine failed: {detail}"),
            },
            Self::Protocol(m) => write!(f, "engine protocol: {m}"),
            Self::OutcomeUnknown(m) => write!(f, "the outcome of the write is unknown ({m})"),
        }
    }
}

impl std::error::Error for EngineError {}

/// The boxed future of a call, so the trait stays object safe.
pub type CallFuture<'a> = Pin<Box<dyn Future<Output = Result<Reply, EngineError>> + Send + 'a>>;

/// The engine, as the hub sees it. `CliEngine` is the one of P2; a
/// persistent host (P8) implements the same trait.
pub trait Engine: Send + Sync {
    /// Ask one question. `params` is the object of the request: the
    /// parameters of a read method, the whole request of `ops`.
    fn call<'a>(&'a self, method: Method, params: Option<&'a Value>) -> CallFuture<'a>;
}

/// The variables a child process gets, and nothing else (concept 5.5 Nr. 11).
///
/// `PATH`, the system root and the temp and home variables are what any
/// program needs. The three engine switches are set from the hub's own
/// settings, never copied from whatever the environment holds; every other
/// `TASKS_*` switch (trust, marker docs, files) is left out on purpose.
#[must_use]
pub fn child_env(env: &Env, engine: Option<&EngineVars<'_>>) -> Vec<(OsString, OsString)> {
    const PASS: &[&str] = &[
        "PATH",
        "PATHEXT",
        "REPOS_DIR",
        "SystemRoot",
        "windir",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "USERPROFILE",
    ];
    let mut out: Vec<(OsString, OsString)> = PASS
        .iter()
        .filter_map(|name| env.get(name).map(|v| (OsString::from(name), v.clone())))
        .collect();
    if let Some(vars) = engine {
        out.push((OsString::from("TASKS_VAULT"), vars.vault.into()));
        if let Some(lib) = vars.lib_dir {
            out.push((OsString::from("LIB_NVIM_DIR"), lib.into()));
        }
        if !vars.extra_areas.is_empty() {
            out.push((
                OsString::from("TASKS_EXTRA_AREAS"),
                vars.extra_areas.join(",").into(),
            ));
        }
    }
    out
}

/// What the engine says about itself, from `hello`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EngineInfo {
    pub engine: EngineBuild,
    pub schemas: Vec<u64>,
    pub capabilities: Vec<String>,
}

/// The build of the engine and the Neovim it runs in.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EngineBuild {
    pub version: String,
    pub git: String,
    pub nvim: String,
}

/// What the read side of the app needs from the engine.
pub const REQUIRED_CAPABILITIES: &[&str] = &["hello", "snapshot", "list", "task", "next", "areas"];

/// Why an engine cannot be used. Each one is a setup page, not a crash.
#[derive(Debug)]
pub enum ProbeProblem {
    /// The call itself failed.
    Call(EngineError),
    /// The engine does not speak this contract version.
    ContractUnsupported { schemas: Vec<u64> },
    /// The engine is older than this app: it lacks these capabilities.
    TooOld { missing: Vec<String> },
}

impl ProbeProblem {
    /// A short, fixed word for the problem, free of paths (see
    /// `SetupProblem::code`).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Call(_) => "engine_unreachable",
            Self::ContractUnsupported { .. } => "contract_unsupported",
            Self::TooOld { .. } => "engine_too_old",
        }
    }
}

impl fmt::Display for ProbeProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Call(e) => write!(f, "the engine did not answer hello: {e}"),
            Self::ContractUnsupported { schemas } => write!(
                f,
                "the engine speaks contract versions {schemas:?}, this app needs {SCHEMA}"
            ),
            Self::TooOld { missing } => write!(
                f,
                "the tasks.nvim checkout is too old, it lacks: {}",
                missing.join(", ")
            ),
        }
    }
}

impl std::error::Error for ProbeProblem {}

/// Ask `hello` and check the answer against what this app needs.
///
/// # Errors
///
/// A [`ProbeProblem`] when the engine does not answer, speaks another
/// contract version or lacks a capability.
pub async fn probe(engine: &dyn Engine) -> Result<EngineInfo, ProbeProblem> {
    let reply = engine
        .call(Method::Hello, None)
        .await
        .map_err(ProbeProblem::Call)?;
    let info: EngineInfo = serde_json::from_str(&reply.text).map_err(|e| {
        ProbeProblem::Call(EngineError::Protocol(format!("hello is not readable: {e}")))
    })?;
    if !info.schemas.contains(&SCHEMA) {
        return Err(ProbeProblem::ContractUnsupported {
            schemas: info.schemas,
        });
    }
    let missing: Vec<String> = REQUIRED_CAPABILITIES
        .iter()
        .filter(|c| !info.capabilities.iter().any(|have| have == *c))
        .map(|c| (*c).to_owned())
        .collect();
    if !missing.is_empty() {
        return Err(ProbeProblem::TooOld { missing });
    }
    Ok(info)
}
