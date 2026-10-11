# Security of the local server

`tasks-hub` is a web server on your own machine. Anything on the machine, and
any web page you open in a browser, can try to talk to it. This page says
what the server does about that, and what it does not.

The numbers (T1 to T10, "rule N") refer to the maintainer's design notes. The
tests named here are in `crates/hub-testkit/tests/security.rs` unless another
file is given.

## What a request has to pass

Every request goes through one guard, in this order. A refusal stops there.

| # | Check | Refusal | Why |
|---|---|---|---|
| 1 | `Host` is exactly `127.0.0.1:PORT`, `localhost:PORT` or `[::1]:PORT` (one header, ASCII) | 403 / 400 | DNS rebinding |
| 2 | `Content-Length` is a number and not over 1 MiB | 413 / 400 | memory |
| 3 | `Origin`, if sent, is exactly one of the three origins; `Sec-Fetch-Site`, if sent, is `same-origin` or `none` | 403 | cross-site requests |
| 4 | the method is one the route knows (no `OPTIONS`, no CORS) | 405 | no cross-origin access at all |
| 5 | a mutation without `Origin` is a program client: it must carry a credential and must not send `Sec-Fetch-Site` | 403 | a browser always sends `Origin` with a POST |
| 6 | at most 60 mutations in 10 s; at most 10 pairing attempts in 60 s | 429 | guessing |
| 7 | the credential the route needs | 401 | see below |
| 8 | a mutation is `application/json` | 415 | no form posts |

Around that: the server binds loopback only and refuses any other address;
at most 64 connections; a client has 10 s to send its request head; the
request line and headers together are at most 8 KiB; a request has 30 s.

Every answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `Cache-Control: no-store` and `Cross-Origin-Resource-Policy:
same-origin`. The page also carries a restrictive `Content-Security-Policy`;
the strict policy with Trusted Types arrives with the user interface.

Routes are classified by their raw path. Everything under `/api/` needs a
session unless it is on the short list below, so a route that is added later
is closed until someone opens it on purpose; a path with percent escapes or
a trailing slash is not the list's path and needs a session too.

## Credentials

| Credential | What it is | What it allows |
|---|---|---|
| none | | the placeholder page, `GET /api/tasks/hello` (version, instance id, whether the engine is ready, a short problem code; no task, no area, no path) |
| pairing code | 128 bits, one use, 60 s | `POST /auth/exchange` for a session token |
| session token | 256 bits, in the memory of the hub only, at most 16 open | the data routes (none yet) |
| control secret | 256 bits, in `control.secret` | `POST /api/control/pair`: mint a pairing code. Nothing else. |

Comparisons are constant time and look at every stored entry. Secrets come
from the operating system's random source and never print themselves. The
answer for an unknown, a spent and an expired code is the same.

### How a browser gets a session

1. `tasks-hub open` reads `hub.json` and `control.secret` from the config
   folder, checks that the program on the port is this hub (same instance
   id) before it sends the secret anywhere, and asks for a pairing code.
2. It prints `http://127.0.0.1:PORT/#pair=<code>`. The code is in the URL
   *fragment*: a browser does not send it to the server or in a `Referer`.
3. The page takes the code out of the fragment, calls `/auth/exchange` and
   keeps the token in memory.

A pairing code is never handed out by an open endpoint. The only way to get
one is to be a program that can read `control.secret`.

### The control secret file

`<config>/tasks-desktop/control.secret` is the one thing that lets a local
program ask for access. It is protected by the rights of your account:

* Unix: mode `0600`, set when the file is created and again afterwards.
* Windows: every inherited right is removed and the file is given to the
  current user alone (`icacls /inheritance:r`). The inherited list of a
  folder is not trusted: on the development machine it named a sandbox group
  with the right to change the file. If the rights cannot be set, the hub
  does not start.

`hub.json` (port, process id, version, instance id) holds no secret.

## What this does not protect against

* **Another process of the same user.** It can read `control.secret`, or
  bind the port while the hub is not running (rule T2). The server cannot
  tell that process from `tasks-hub open`. Mitigations that exist: the
  secret is only sent to a process that reports the instance id of
  `hub.json`, tokens are per run, and the port is fixed so the origin is
  stable.
* **A local program that wants to be a nuisance.** The limits protect the
  hub, not its availability: a program on the machine can use up the budget
  of pairing attempts or of mutations for a while and so keep you from
  pairing. It gains no access by that.
* **An administrator**, who can take ownership of the file.
* **The terminal and the browser history.** The pairing link lives in the
  URL fragment; it ends up in the terminal that ran `tasks-hub open` and in
  the browser's history. That is why the code is single use and lives 60 s.
* **A page script in the app's own origin.** Once the interface exists, a
  cross-site script in the page would own the session. The strict
  Content-Security-Policy and Trusted Types of the interface are the answer;
  they are not in place yet.
* **Untrusted task files.** There is no route that returns task data yet.
  When there is, the interface must render titles and bodies as text, and
  data classes (`areas.json`) must keep private areas out of every response
  that leaves the hub.
* **Writes cut short.** A write that ends without an answer is reported as
  an unknown outcome. The hub kills only the engine process on a time-out,
  not the processes it started.

## What an engine process gets

The engine runs with an empty environment plus a short list: `PATH`,
`PATHEXT`, `REPOS_DIR`, `SystemRoot`, `windir`, `TEMP`, `TMP`, `TMPDIR`,
`HOME`, `USERPROFILE`, and the three engine switches the hub sets from its
own settings (`TASKS_VAULT`, `LIB_NVIM_DIR`, `TASKS_EXTRA_AREAS`). Every
other `TASKS_*` switch is left out. The request goes in on stdin as printable
ASCII; nothing the user typed is put on a command line.

## Reporting

This is a personal project. Open an issue without details, or mail the
maintainer.
