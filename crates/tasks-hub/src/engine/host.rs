//! The persistent engine process (concept 3.5, stage P8): one
//! `nvim -l scripts/tasks-host.lua` that answers many questions over a line
//! protocol, instead of one process per question.
//!
//! The protocol (see `docs/CONTRACT.md` of tasks.nvim): the host says
//! `ready\t1`; a question is `<id>\t<method>\t<params>\n`, its answer
//! `<id>\t<document>\n`. One question is in flight (the caller holds the
//! gate of the engine). The host ends when its stdin ends, so a hub that
//! dies leaves no process behind; `kill_on_drop` covers the normal end.
//!
//! What this module decides, and what it leaves to the caller:
//!
//! * a host that cannot start, or does not say `ready`, is [`Failure::Unavailable`]:
//!   nothing was sent, the caller asks the one-process-per-call way;
//! * a host that ends or breaks after the question was written is
//!   [`Failure::Died`]: the caller may ask again for a read, never for a
//!   write (it may have been carried out);
//! * a question that does not come back in time kills the host
//!   ([`Failure::Timeout`]): it is not worth another 30 seconds;
//! * a host that fails again and again is not tried for a while.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

/// The protocol version this hub speaks (the number after `ready`).
const PROTOCOL: &str = "1";
/// How long a host may take to say `ready`.
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a killed host may take to be reaped.
const REAP_GRACE: Duration = Duration::from_secs(2);
/// Failures in a row after which the host is left alone for a while.
const MAX_FAILURES: u32 = 3;
/// How long it is left alone.
const COOLDOWN: Duration = Duration::from_secs(300);
/// How much of the host's error output is kept for a message.
const STDERR_KEEP: usize = 2048;

/// What to start.
#[derive(Debug, Clone)]
pub struct HostSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: Option<PathBuf>,
    /// The longest answer line that is accepted.
    pub max_reply_bytes: usize,
}

/// Why a question did not get its answer from the host.
#[derive(Debug)]
pub enum Failure {
    /// The host is not there (not started, no `ready`, or left alone after
    /// failures). Nothing was sent.
    Unavailable(String),
    /// The question may have reached the host, and the host ended or sent
    /// something that is no answer.
    Died(String),
    /// No answer within the time; the host was killed.
    Timeout,
    /// The answer line is larger than the limit; the host was killed.
    TooLarge,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// The end of what the host wrote to stderr.
    stderr: Arc<StdMutex<String>>,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    failures: u32,
    left_alone_until: Option<Instant>,
}

/// The host of one engine. Calls are serialised by the caller; the lock here
/// only keeps the state honest.
pub struct Host {
    spec: HostSpec,
    state: tokio::sync::Mutex<State>,
}

impl Host {
    #[must_use]
    pub fn new(spec: HostSpec) -> Self {
        Self {
            spec,
            state: tokio::sync::Mutex::new(State::default()),
        }
    }

    /// Ask one question. `params` is the JSON text of the request, or empty.
    ///
    /// # Errors
    ///
    /// [`Failure`] when the host did not answer; the caller decides what that
    /// means for the question.
    pub async fn ask(
        &self,
        method: &str,
        params: &str,
        timeout: Duration,
    ) -> Result<String, Failure> {
        // The line protocol has one question per line.
        if params.contains(['\n', '\r']) || method.contains(['\t', '\n']) {
            return Err(Failure::Unavailable(
                "the request does not fit the line protocol".to_owned(),
            ));
        }
        let mut state = self.state.lock().await;
        if state
            .left_alone_until
            .is_some_and(|until| Instant::now() < until)
        {
            return Err(Failure::Unavailable(
                "the host failed repeatedly and is left alone for a while".to_owned(),
            ));
        }
        // A host that ended between two questions (killed, or crashed on
        // its own) is replaced before the question is written.
        let gone = state
            .running
            .as_mut()
            .is_some_and(|r| !matches!(r.child.try_wait(), Ok(None)));
        if gone {
            state.running = None;
        }
        if state.running.is_none() {
            match self.start().await {
                Ok(running) => state.running = Some(running),
                Err(why) => {
                    state.failures += 1;
                    if state.failures >= MAX_FAILURES {
                        state.left_alone_until = Some(Instant::now() + COOLDOWN);
                        state.failures = 0;
                    }
                    return Err(Failure::Unavailable(why));
                }
            }
        }
        let max = self.spec.max_reply_bytes;
        let outcome = {
            let running = state.running.as_mut().expect("started above");
            exchange(running, method, params, timeout, max).await
        };
        match outcome {
            Ok(text) => {
                state.failures = 0;
                Ok(text)
            }
            Err(mut failure) => {
                // Whatever went wrong, the next question gets a fresh host:
                // after a timeout or a broken line this one cannot be
                // trusted to be in step.
                if let Some(mut dead) = state.running.take() {
                    let tail = dead.stderr.lock().map(|s| s.clone()).unwrap_or_default();
                    let _ = dead.child.start_kill();
                    let _ = tokio::time::timeout(REAP_GRACE, dead.child.wait()).await;
                    drop(dead);
                    failure = match failure {
                        Failure::Died(why) if !tail.is_empty() => {
                            Failure::Died(format!("{why}: {}", tail.trim()))
                        }
                        other => other,
                    };
                }
                if matches!(failure, Failure::Died(_)) {
                    state.failures += 1;
                    if state.failures >= MAX_FAILURES {
                        state.left_alone_until = Some(Instant::now() + COOLDOWN);
                        state.failures = 0;
                    }
                }
                Err(failure)
            }
        }
    }

    /// Whether a host process is running right now (for tests and status).
    pub async fn running(&self) -> bool {
        self.state.lock().await.running.is_some()
    }

    /// End the host (the next question starts another).
    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        if let Some(mut running) = state.running.take() {
            let _ = running.child.start_kill();
            let _ = tokio::time::timeout(REAP_GRACE, running.child.wait()).await;
        }
    }

    async fn start(&self) -> Result<Running, String> {
        let mut command = Command::new(&self.spec.program);
        command
            .args(&self.spec.args)
            .env_clear()
            .envs(self.spec.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &self.spec.cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: no console window for a console program.
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start the host: {e}"))?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.start_kill();
            return Err("a pipe of the host is missing".to_owned());
        };
        let kept = Arc::new(StdMutex::new(String::new()));
        tokio::spawn(keep_tail(stderr, Arc::clone(&kept)));
        let mut running = Running {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            stderr: kept,
        };

        let mut line = Vec::new();
        let ready = tokio::time::timeout(
            READY_TIMEOUT,
            read_line(&mut running.stdout, &mut line, 256),
        )
        .await;
        let text = String::from_utf8_lossy(&line).trim_end().to_owned();
        let said = matches!(ready, Ok(Ok(true))) && text.strip_prefix("ready\t") == Some(PROTOCOL);
        if said {
            return Ok(running);
        }
        let tail = running.stderr.lock().map(|s| s.clone()).unwrap_or_default();
        let _ = running.child.start_kill();
        let _ = tokio::time::timeout(REAP_GRACE, running.child.wait()).await;
        Err(match ready {
            Err(_) => "the host did not say ready in time".to_owned(),
            Ok(_) if text.is_empty() => format!("the host ended before it was ready: {tail}"),
            Ok(_) => format!("the host spoke another protocol: {text:.40}"),
        })
    }
}

/// Write the question and read its answer.
async fn exchange(
    running: &mut Running,
    method: &str,
    params: &str,
    timeout: Duration,
    max_reply: usize,
) -> Result<String, Failure> {
    let id = running.next_id;
    running.next_id += 1;
    let line = format!("{id}\t{method}\t{params}\n");
    // A write that fails left no complete line in the pipe: the host never
    // saw the question, and the caller may ask another way.
    if let Err(e) = running.stdin.write_all(line.as_bytes()).await {
        return Err(Failure::Unavailable(format!(
            "the host's pipe is closed: {e}"
        )));
    }
    if let Err(e) = running.stdin.flush().await {
        return Err(Failure::Unavailable(format!(
            "the host's pipe is closed: {e}"
        )));
    }

    let mut buf = Vec::new();
    let read = tokio::time::timeout(
        timeout,
        read_line(&mut running.stdout, &mut buf, max_reply + 32),
    )
    .await;
    match read {
        Err(_) => Err(Failure::Timeout),
        Ok(Err(e)) => Err(Failure::Died(format!("the host's pipe failed: {e}"))),
        Ok(Ok(false)) if buf.len() > max_reply => Err(Failure::TooLarge),
        Ok(Ok(false)) => Err(Failure::Died("the host ended without an answer".to_owned())),
        Ok(Ok(true)) => {
            let text = String::from_utf8(buf)
                .map_err(|_| Failure::Died("the answer is not UTF-8".to_owned()))?;
            let text = text.trim_end_matches(['\r', '\n']);
            let Some((got, doc)) = text.split_once('\t') else {
                return Err(Failure::Died("the answer has no id".to_owned()));
            };
            if got.parse::<u64>().ok() != Some(id) {
                return Err(Failure::Died(format!(
                    "the answer is for question {got:.15}, not {id}"
                )));
            }
            if doc.len() > max_reply {
                return Err(Failure::TooLarge);
            }
            Ok(doc.to_owned())
        }
    }
}

/// Read up to a newline. `Ok(true)`: a line is in `out`. `Ok(false)`: the
/// stream ended, or the line grew past `limit` (then `out.len() > limit`).
async fn read_line(
    reader: &mut BufReader<ChildStdout>,
    out: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<bool> {
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(false);
        }
        if let Some(at) = chunk.iter().position(|b| *b == b'\n') {
            out.extend_from_slice(&chunk[..at]);
            reader.consume(at + 1);
            return Ok(out.len() <= limit);
        }
        out.extend_from_slice(chunk);
        let n = chunk.len();
        reader.consume(n);
        if out.len() > limit {
            return Ok(false);
        }
    }
}

/// Keep the last bytes of the host's error output, so a death can say why.
async fn keep_tail(mut stderr: ChildStderr, kept: Arc<StdMutex<String>>) {
    let mut chunk = [0u8; 1024];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let text = String::from_utf8_lossy(&chunk[..n]).into_owned();
                if let Ok(mut tail) = kept.lock() {
                    tail.push_str(&text);
                    if tail.len() > STDERR_KEEP {
                        let cut = tail.len() - STDERR_KEEP;
                        let at = (cut..=tail.len())
                            .find(|i| tail.is_char_boundary(*i))
                            .unwrap_or(tail.len());
                        tail.drain(..at);
                    }
                }
            }
        }
    }
}
