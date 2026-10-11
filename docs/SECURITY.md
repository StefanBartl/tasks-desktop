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
| 2 | `Content-Length` is a number and not over 1 MiB (1 KiB for the two pairing routes, which take a few bytes) | 413 / 400 | memory |
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
a trailing slash is not the list's path and needs a session too. A path
outside `/api/` that is not the page is answered "not found" by the guard
itself and never reaches the router.

## Credentials

| Credential | What it is | What it allows |
|---|---|---|
| none | | the placeholder page, `GET /api/tasks/hello` (version, instance id, whether the engine is ready, a short problem code; no task, no area, no path) |
| pairing code | 128 bits, one use, 60 s | `POST /auth/exchange` for a session token |
| session token | 256 bits, in the memory of the hub only, at most 16 open | the data routes: `GET /api/tasks/snapshot`, `task?id=`, `next`, `areas` |
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

## The data routes

They sit under `/api/`, so the guard has asked for a session before a
handler runs. They hand on the documents of the engine as it wrote them
(the contract promises no path of this machine in any of them) and add one
thing, the data class of an area.

* `snapshot` has the `digest` of the document as its `ETag`; a client that
  sends `If-None-Match` gets `304`. Concurrent requests share one engine
  question.
* `task?id=<area>/<slug>`: the id is two plain names of letters, digits,
  `.`, `_` and `-`. Nothing else reaches the engine; whether the task exists
  is the engine's answer (404).
* `next?n=&actor=&area=`: a number from 0 to 10 and plain names.
* A query that is not plain, repeated or unknown is `400`. A route that
  takes no query refuses one.
* Engine refusals keep their code (`not_found` is 404, `conflict` 409, ...);
  every other failure is told as `engine_failed` without detail; the detail
  goes to the terminal of whoever runs the hub. A write that ended without
  an answer is `outcome_unknown`.
* No engine (not set up): `503 engine_unavailable` with a short problem code,
  and `hello` still answers, so a page can say what is missing.

## Data classes (`areas.json`)

`<config>/areas.json`, per device, never in the vault (the vault is synced
and changed by pull requests). Each area is `public`, `internal` or
`private`; an area with no entry is **unclassified**, and an unclassified
area is released for nothing that leaves the hub.

| Class | Another panel | A cloud runner | A cache of the client |
|---|---|---|---|
| `public`, `internal` | yes | yes (after a consent, later) | yes |
| `private` | no | no | no |
| unclassified | no | no | no |

The user always sees every area on this machine; `GET /api/tasks/areas`
adds `data_class` to each and lists `unclassified` and `private`, so a new
area shows up as a decision to make instead of a quiet default.

A file that exists and is not valid stops the hub from starting: a typo must
not become "everything unclassified" without anyone seeing it.
`tasks-hub areas propose` writes a *proposal* (`areas.proposed.json`, never
the active file); `tasks-hub areas check` fails while an area has no class.

The consumers of these rules (another panel, a cloud runner, the client
cache) do not exist yet; the rules are in place and tested for them.

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

## Dependencies

The tree is small (about 50 crates) and its policy is in the repository:

* `Cargo.lock` is committed and every build uses `--locked`.
* `deny.toml` allows a short list of licenses, crates.io only, no git
  sources, no wildcard versions; `cargo audit` and `cargo deny check` run
  in CI.
* A version that is younger than seven days is not taken
  (`tools/check-lock-age.py`, also run in CI). Cargo has no setting for
  this. A newer version is taken with `cargo update -p <crate> --precise
  <version>` once it is old enough, in a commit of its own with a look at
  the lockfile diff.

## Reporting

This is a personal project. Open an issue without details, or mail the
maintainer.
