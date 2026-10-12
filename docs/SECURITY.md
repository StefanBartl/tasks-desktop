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
| session token | 256 bits, in the memory of the hub only, at most 16 open | the data routes: `GET /api/tasks/snapshot`, `task?id=`, `next`, `areas`, `events`, and `POST /api/tasks/rescan` |
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
  sends `If-None-Match` gets `304`. The hub holds one snapshot and serves it
  from memory; it is replaced when the vault changed (below), and a client
  that asks while it is being replaced waits for that one answer.
* `events` is a server-sent event stream: a `hello` with where the stream
  stands, then one `tasks` event per change with the ids that were changed,
  added or removed (ids only: no title, no path), a heartbeat every 15
  seconds, and a `resync` for a client that was too slow. An event is a hint,
  not a diff: the client reads the snapshot again. There is no replay. A
  session may hold four streams (`429` beyond that). The session is looked
  at again with every message: a stream ends with its session (the oldest
  of the sixteen is closed when newer ones open), within one heartbeat.
* `rescan` (POST) asks for a full scan now, for a client that got the focus
  back; many asks are one scan.
* `task?id=<area>/<slug>`: the id is two plain names of letters, digits,
  `.`, `_` and `-`. Nothing else reaches the engine; whether the task exists
  is the engine's answer (404).
* `next?n=&actor=&area=`: a number from 0 to 10 and plain names.
* A query that is not plain, repeated or unknown is `400`. A route that
  takes no query refuses one.
* Engine refusals keep their code (`not_found` is 404, `conflict` 409, ...),
  cut to a lowercase word and one line of at most 512 characters;
  every other failure is told as `engine_failed` without detail; the detail
  goes to the terminal of whoever runs the hub. A write that ended without
  an answer is `outcome_unknown`.
* No engine (not set up): `503 engine_unavailable` with a short problem code,
  and `hello` still answers, so a page can say what is missing.

## How a change is seen

A file watcher (`notify`, the stable 8.x line) watches the vault and says
only "something that matters changed"; what matters is decided by path:
`.md` files in `ROADMAP/tasks` (folder tasks too), `ROADMAP/plans`,
`Backlog/FEATURES` and `Backlog/TASKS`, and the entries of the vault root
that are folders and not hidden (a new area). A folder task is moved and
renamed as a whole (`done`, `move_area`), and the system then reports the
folder and not the files in it: so an entry directly in those folders counts
when it is a folder, or when it is gone. Leftovers of tools
(`*.tasks-tmp.*`, `*.frontmatter.*`, lock files, backups, swap files, Vim's
`4913`, sync conflicts) and the folder events Windows adds for a changed
folder do not count. After 300 ms of quiet there is **one** scan by the
engine, however many files changed. A state that a tool is in the middle of
changing (a duplicate id while a task is being finished, an unreadable file
during an editor's save) is read once more after half a second before it is
shown. The watcher asks the file system about a path only when the place of
the path could matter at all: a vault that is a git repository makes
hundreds of events under `.git`.

Events can be lost: the watcher may drop some under a burst, and one that
says so (an overflowing queue on Linux and macOS) or fails tells the hub to
rescan. Windows drops them without saying. The net under that is a full scan
every 45 seconds **while an event stream is open**: that is who would miss a
change. With no stream open nothing is scanned for nobody (a scan of a real
vault of 600 tasks takes about a second of Neovim); the held snapshot has an
age (two minutes), and a request that finds it older reads the vault again.
A client that comes back to the foreground asks for a rescan (`POST
/api/tasks/rescan`) instead of trusting what it holds.

A read by the engine writes nothing into the vault (a test holds that): a
scan that did would wake itself again.

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

The file may name a `"default"` class: the owner's explicit choice for every
area it has no entry for (a new area then needs no decision, and an entry
still wins). It is a per-device choice like the rest of the file and absent
by default, so nothing is released that nobody said.

The user always sees every area on this machine; `GET /api/tasks/areas`
adds `data_class` to each and lists `unclassified` and `private`, so a new
area shows up as a decision to make instead of a quiet default.

A file that exists and is not valid stops the hub from starting: a typo must
not become "everything unclassified" without anyone seeing it. The file is
read at start; a change takes effect when the hub is restarted.

`tasks-hub areas propose` writes a *proposal* (`areas.proposed.json`, never
the active file). What the active file already decides is kept in the
proposal (a private area is not proposed as internal again); a new area is
proposed as `internal` unless `--private` names it, so read the proposal
before it becomes `areas.json`. `tasks-hub areas check` fails while an area
has no class.

The consumers of these rules (another panel, a cloud runner, the client
cache) do not exist yet; the rules are in place and tested for them.

## The interface

The page and its files are embedded in the binary (`build.rs`) into a table
keyed by the name that is asked for (`index.html`, `assets/<plain name>`); a
request is answered from the table or is a `404`, so no path is built or
opened per request and no folder is searched for. Only `.html`, `.js`,
`.css`, `.json`, `.svg`, `.png`, `.ico` and `.woff2` are taken, each up to
4 MiB. `TASKS_HUB_UI_DIR` replaces the embedded files by a folder (a
development setting).

The page is sent with

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none';
form-action 'none'; require-trusted-types-for 'script';
trusted-types svelte-trusted-html
```

and `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that
turns off the device and clipboard features. There is no `unsafe-inline` and
no `unsafe-eval`. A sink that takes a string as HTML or script
(`innerHTML`, `insertAdjacentHTML`, `document.write`, `script.src`) throws
unless Svelte's one policy made the value; the browser tests assert that.
The task text never reaches such a sink: the body of a task is read by
markdown-it (`html: false`) into a tree and drawn as elements, so a
sanitizer has nothing to miss. A link becomes a link only for `http:`,
`https:` and `mailto:` (an allow-list; markdown-it's own refusal is the
first wall), with `rel="noopener noreferrer nofollow"` and the host it goes
to written after it (the text of a link is the author's, the host is not);
an image is its description as text and is never requested. A block that
scrolls (a long code line, a wide table) can be reached with the keyboard.
The browser tests also fail on any message the page writes to the console.

In the browser the pairing code is taken out of the address bar before
anything else runs; the session token lives in `sessionStorage` of the tab,
so it ends with the tab and is not shared. The event stream is read with
`fetch` (an `EventSource` cannot send the header). Text of the vault (titles,
summaries, bodies, steps) is only ever put into the page as text, never as
HTML; invisible and direction-changing characters are shown as `⟦U+XXXX⟧`.

The client cache (IndexedDB) holds the list of tasks of areas that are
`public` or `internal` and nothing else: a `private` area, an area with no
class and every id of such a task in the edges of the kept ones are left
out, as is a `ref` that names a path in such an area. With no class list
at all nothing is cached. The cache is shown first, also when the hub is
not there, but only in a tab that holds a session; it is never used as an
answer to "not modified", because it holds a part of the document.

The folder of the interface is looked for in three places only (the
setting, `ui/` next to the binary, the repository the binary was built
in), because its scripts run where the session is. A file over 4 MiB or
a build without `index.html` is an error and shows the placeholder.

The page breaks soft: a task that cannot be drawn shows an error panel,
not a white page. A stream that is silent for 45 seconds (three
heartbeats) is cut and read again. Single-key shortcuts can be turned off
in the page (WCAG 2.1.4).

## Writing (`POST /api/tasks/ops`)

The page may change tasks; the engine stays the only writer and the only
holder of the rules. The route:

* needs the session, an `Origin` the hub knows, `application/json` and
  passes the rate limit of mutations like every other POST;
* checks the **form** before an engine process is asked: a JSON object with
  `ops` (1 to 100 entries, each with a known `op`), at most the fields
  `schema`, `client_op_id`, `dry_run`, `ops`, a plain `client_op_id`. What
  is plainly not a request is `400 bad_request` and never reaches the engine;
  the rules of the tasks (keys, values, relations, limits, control characters,
  links) are the engine's and its refusals come back as they are;
* does not stop at a part that failed: the answer is the engine's
  `tasks.result`, one entry per operation, never "ok" for a part;
* scans before it answers when something changed, so the next read is the new
  state and the open streams hear of it; a write that ended without an answer
  is `502 outcome_unknown` and also starts a scan;
* finishes only with the token of `GET /api/tasks/done_preview` for the version
  of the file that was shown (the engine checks it under the file lock);
* counts as a use of the interface (`usage`), like a rescan.

A change is made with the `etag` the page has (`if_match`): a task that
changed meanwhile is a `conflict`, nothing is overwritten, and the page reads
again. The undo of the page is the `inverse` operation the engine returns.

## Search in the text of the tasks

The engine alone reads task files, so the texts come from it: the verb
`bodies` of `tasks-export/1` hands over `{ id, etag, body }` of the open
tasks (a body cut at 256 KiB and flagged, a page cut at 2 MiB). The hub keeps
them in memory and searches them there; it opens no file and parses no
frontmatter. `GET /api/tasks/search?q=<escaped>&limit=<1..50>` needs a
session like every data route. The query is escaped text (`%XX` of UTF-8;
control characters, more than 200 characters or 8 words, and less than 2
characters are `400`), every word must be in a text, a text with the words
in a row ranks first. A hit carries the id, a score and a piece of the text
of at most 160 characters with the places of the words (in UTF-16 units),
control characters in the piece are blanks. The interface draws the piece as
text with `mark` elements; nothing of it is HTML.

The index is built a moment after the hub starts and follows the changes the
store reports (the ids that changed are asked for again; a big change builds
it anew). While there is none, `status` says `building`. It is memory only
and not written anywhere. It holds the text of every area, as the list does;
what leaves the machine is decided by the data classes (nothing does).

## The usage count

To answer whether the interface is used, the hub keeps `usage.json` next to
`config.json`: per day (UTC) the number of visits and the minutes an event
stream was open (a tab that stays open counts again each time its window
gets the focus back after a pause of ten minutes). No task, area, title,
token or time of day is in it, and it is never sent anywhere; `tasks-hub usage` prints it and deleting the file
resets it. `tasks-hub open --launch` passes the browser only the hub's own
link (`http://127.0.0.1:<port>/#pair=<hex>`, checked) and nothing else.

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
* **A page script in the app's own origin.** A script in the page would own
  the session (the token is in `sessionStorage`). The policy above and the
  absence of any HTML sink are the answer; a compromised npm package in the
  bundle is not stopped by them. That is what the age rule of seven days,
  the lockfile and the short list of dependencies are for.
* **Untrusted task files.** The data routes return titles and bodies as the
  engine read them. The interface shows them as text only; a client that
  renders them as HTML is on its own. Data classes (`areas.json`) decide
  what may leave the hub or reach the client cache; the local interface
  shows every area, as it is the same person's data.
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

### The persistent engine process

By default one `nvim -l scripts/tasks-host.lua` stays up and answers the
questions as lines (`<id>	<method>	<params>`, answered by
`<id>	<document>`). It gets the same environment as above, the same
ASCII-only request and the same limits. What differs:

* a host that cannot start, does not say `ready`, or fails three times in a
  row is left alone for five minutes and the questions go the one-process
  way again;
* a **read** that loses its host is asked again by a process; a **write**
  that was sent and not answered is an unknown outcome, never asked again;
* a question that does not come back in time kills the host (and is a
  time-out, or for a write an unknown outcome);
* a host keeps the Lua code it loaded: when a `.lua` file of the engine or
  of lib.nvim changes (a `git pull`), the host is replaced before the next
  question, so the hub never runs half old and half new code;
* the host ends when its stdin ends, so a hub that is killed leaves no
  engine process behind;
* the answer of a question is checked against its id, so a late line can
  never be taken for the answer of another question.

`TASKS_HUB_ENGINE=process` turns the host off.

## Dependencies

The tree is small (about 70 crates, of which the file watcher and its
platform backends are about twenty) and its policy is in the repository:

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
