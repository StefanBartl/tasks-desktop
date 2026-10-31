# Security of the local server

`tasks-hub` is a web server on your own machine. Anything on the machine, and
any web page you open in a browser, can try to talk to it. This page says
what the server does about that, and what it does not.

The numbers (T1 to T10, "rule N") refer to the maintainer's design notes. The
guard, the pairing, the sessions and the engine seam are those of
[appkit](https://github.com/WKDSteve/appkit) (its `SECURITY.md` says what holds for every app);
this page adds what is the tasks hub's own. The security matrix is written in
`appkit-testkit` and run for this hub by `crates/hub-testkit/tests/security.rs`; other tests
named here are in `crates/hub-testkit/tests/` unless another file is given.

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
| session token | 256 bits, in the memory of the hub only, at most 16 open | the data routes: `GET /api/tasks/snapshot`, `task?id=`, `next`, `areas`, `about`, `finished`, `order`, `lists`, `groupings`, `views`, `links`, `sheet_snap?name=` (below), `events` (and the other reads of the engine), and `POST /api/tasks/rescan` |
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
`Backlog/FEATURES` and `Backlog/TASKS`, the saved views (`.md` files directly
in `ROADMAP/views`, which the engine counts in the `views_rev` of the snapshot,
so a view changed by a pull reaches an open page by the next event), and the
entries of the vault root that are folders and not hidden (a new area). A folder task is moved and
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

| Class | Another panel | A cloud runner | A cache of the client | An export of the page |
|---|---|---|---|---|
| `public`, `internal` | yes | yes (after a consent, later) | yes | yes |
| `private` | no | no | no | no |
| unclassified | no | no | no | no |

An export (a file the browser saves, the clipboard, the page for the printer or a PDF) leaves the app: the page leaves
the tasks of private and unclassified areas out and says how many, and until the classes are read after a start (or
when the hub cannot tell them) nothing is exported. The id of a plan or a saved view kept in such an area names that
area: it is in neither the name of the file, nor the `view` of a JSON export, nor the `plan` field of a task of a
public area in that plan, nor the name of a group of a view grouped by plan (it is called a plan of a private area).
The page for the printer names the filters of the list on top, but no chip of such an area or plan, and the words of
the search only when no task of such an area has them (else it says only that a search narrows the list); a saved
view kept in such an area is called by the word for views, not by its title.

The file may name a `"default"` class: the owner's explicit choice for every
area it has no entry for (a new area then needs no decision, and an entry
still wins). It is a per-device choice like the rest of the file and absent
by default, so nothing is released that nobody said.

The user always sees every area on this machine; `GET /api/tasks/areas`
adds `data_class` to each and lists `unclassified` and `private`, so a new
area shows up as a decision to make instead of a quiet default.

Schema 1 (`"schema": 1`, keys are area names) is the classes of the vault `main`. Schema 2 keys an entry by
`<vault>:<area>` and may give a vault its own `default` (`"vaults": {"work": {"default": "internal"}}`): two vaults
may have an area of the same name, and one class table by name would release the private one because the other is
public. A vault the file does not name has every area unclassified; it never takes over `main`.

A file that exists and is not valid stops the hub from starting: a typo must
not become "everything unclassified" without anyone seeing it. The file is
read at start and again each time a vault is chosen (or the folder of the vault that is read is changed), and
the classes of that vault replace the old ones with the engine and the snapshot. A file that has become invalid
stops that choice (nothing changes; the page is told `areas_unreadable`, the terminal gets the reason).

`tasks-hub areas propose` writes a *proposal* (`areas.proposed.json`, never
the active file). What the active file already decides is kept in the
proposal (a private area is not proposed as internal again); a new area is
proposed as `internal` unless `--private` names it, so read the proposal
before it becomes `areas.json`. `tasks-hub areas check` fails while an area
has no class. Both work for the vault the settings name as active; a proposal for a vault other than `main`
(or on a file of schema 2) is written as schema 2 and keeps the entries of the other vaults.

The consumers of these rules (another panel, a cloud runner, the client
cache) do not exist yet; the rules are in place and tested for them.

### In the web variant

The page that runs without a hub has no config folder, so it reads the `areas.json` at the root of the folder the
person chose (`ui/src/web/classes.ts`). It reads it the way `classes.rs` does, with the same two schemas and the same
refusals, and a page has one vault, which is `main` of the file: schema 1 is its classes, of schema 2 the entries
`main:<area>` and the `default` of `main` (the other vaults of a schema 2 file are checked and not used). The text is
parsed as strictly as serde_json parses it, because a browser's parser is not that strict and the difference would
release an area: a field twice in an entry (`{"class":"private","class":"public"}`), a schema written `1.0` or `1e0`, a
lone surrogate in an escape, a byte order mark, text that is not UTF-8 and a file over 256 KiB are all refusals.
`ui/web/classes-cases.mjs` holds the cases (files, and what `main` shows for each); `pnpm web:test` runs them against the
page's reader, and `crates/tasks-hub/tests/classes_cases.rs` runs the same list against `classes.rs` itself (it asks Node for
the cases, so there is one list), in the CI job that runs both. A case the hub answers differently, or a change of
`classes.rs` the page does not follow, fails there. The reader was also compared once with 64 000 mutated files, which the
two answered alike.

A file that cannot be used does not keep the page from starting (it is a tool for reading), but it releases nothing: every
area is unclassified, and so is every area while the folder cannot be read. What the classes decide there is the cache
(IndexedDB, `lib/cache.ts` unchanged: public and internal only, a reference to a task left out is cut) and the exports.
The cache holds the list of one folder only, named by the id the folders used before give it, and is read back only while
every area in it is still released. The same rule holds on the way in: a list that holds a task of an area that is not
released at that moment is not written (and the record of the older classes is cleared), whatever the page was told when
it built the list. When the file in the folder changes (the page reads the folder again on focus and every 30 seconds) the
classes are read again, the page asks for the areas again, and the record in IndexedDB follows; if the new classes cannot be
read, the record is cleared. A folder that is forgotten ("Forget" in the list of folders used before) takes its record with it.

**The web page is weaker than the hub in one respect.** The hub keeps the file outside the vault because the vault is
synced and changed by pull requests; the page can only read the folder it was given, so a change to `areas.json` that
arrives with a pull releases an area for this browser's cache and exports. What that can reach is the browser's own storage
for this page and the files the person asks to save; nothing leaves the machine by itself (`connect-src 'none'`). Review a
change to `areas.json` as you review code.

**Chrome gives every page opened from disk the same origin (`file://`).** Measured with two different local HTML files in
one Chrome: the second reads the `localStorage` and the IndexedDB databases of the first. So another HTML file opened
from disk in that browser (one downloaded, say) can read what this page keeps there: its choices, the list cache (public
and internal areas only, which is why the classes matter), and the handles of the folders used before (`tasks-web`
database), whose permission is the origin's. This is a property of `file://`, not something the page can change; open no
HTML file of unknown origin in the browser profile that runs the page, or serve the page from a place of its own.

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
turns off the device features and the reading of the clipboard; the page itself may write it
(`clipboard-write=(self)`, used by the "copy" entries of the export, in a view, a menu or the palette, on a click). There is no `unsafe-inline` and
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

Saved views are files of the vault (`<area>/ROADMAP/views/<slug>.md`, read with
`GET /api/tasks/views`, written only through `POST /api/tasks/ops` with
`view_save` and `view_delete`, both on the version read: the engine replaces or
deletes a view only with `if_match`, so a change made on another machine is not
taken away unseen); the browser keeps none of them. What it keeps of
them is one id, the view that was open last (`tasks-desktop.view-open` in
`localStorage`), and the choice of a view in the palette (its frecency) - both
only for an area that is `public` or `internal`, as the cache: the id names its
area. A view to try (opened from a context menu) lives in the page only and is
written nowhere until it is saved.

A screenshot is attached with `attach` through `POST /api/tasks/ops` (a button
in the detail, a box in the new-task form): the engine takes the image on the
clipboard of the machine the hub runs on, else the newest image younger than
`attach.max_age_s` (300 s) in the screenshot folders, and writes it below the
folder of the task. The screenshot folders are only those `attach_dirs` of the
hub's `config.json` names (at most 8 absolute paths); the hub hands them to the
engine with the request (`attach_dirs` of `tasks-ops/1`), because it runs the
engine without the person's Neovim configuration and the engine would else look
into the folders of the system (`~/Pictures`, on macOS the Desktop). Without
`attach_dirs` the hub refuses `from: latest` itself (`attach_no_folders`, the
engine is not asked): only the clipboard is read. The hub reads `attach_dirs`
when it starts: a folder taken out of the file is read until the hub starts
again. A failed `latest` names no folder and no file to the page (the paths hold
the user name). The page asks for the newest
image only when the engine said the clipboard holds none, and the message says
which of the two was taken. One request holds at most one `attach` (the door
refuses more): each reads the clipboard, which takes seconds on Windows.
The request names no path and no file, only `from` (`clipboard` or `latest`); the door refuses `attach_dirs` from a
page;
the answer holds the path below the task and the Markdown link, never the
image, and the page reads neither the clipboard of the browser nor the file.
A paired page can make the hub's clipboard a file of the vault this way: it
needs a session and counts against the limit of the writes, like any write. The
hub does not check the data class of the area for it (no write does; the
classes say what may leave the hub, and an asset is not sent anywhere by the
hub), so an image can land in an area that is `public` or `internal` and from
there in a pushed vault. There is no way back (the engine gives no inverse):
the file is removed by hand.

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
  passes a rate limit of mutations like every other POST, in the guard before
  the credential: every POST to this route counts against a coarse limit of
  its own (300 in 10 s, the plan wizard asks once per key); only the body
  tells a write from a dry run, so the writes are counted a second time,
  strictly (the limit of all mutations), once the handler has read it. A dry
  run costs the writes nothing; a request that is none counts as a write;
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
  is `502 outcome_unknown` and also starts a scan. The page sends at most 50
  moves to another area in one request (`MOVE_MAX` in `ui/src/lib/bulk.ts`):
  a move rewrites several files. Measured 2026-10-18 with
  `tools/measure-bulk-move.lua` (650 open tasks, each moved task named by
  three others, a cold vault): 10 moves 7.9 s, 50 moves 9.5 s, 100 moves
  12.0 s of the 30 s the hub gives one engine call, that is about 7.5 s for
  reading the vault and 45 ms for a move. The limit is the page's own; the
  hub lets 100 operations through;
* finishes only with the token of `GET /api/tasks/done_preview` for the version
  of the file that was shown (the engine checks it under the file lock);
* counts as a use of the interface (`usage`), like a rescan.

A change is made with the `etag` the page has (`if_match`): a task that
changed meanwhile is a `conflict`, nothing is overwritten, and the page reads
again. The undo of the page is the `inverse` operation the engine returns.

## Vaults (`/api/vaults`)

The hub reads one vault at a time. `config.json` may hold more (`vaults`: a name and an absolute folder each, at most 16)
and the one that is read (`active`, `main` for the folder of `vault`). The routes need a session like the other data
routes and count against the same limit of mutations:

* `GET /api/vaults` lists the names and the last part of each folder, never a whole path.
* `POST /api/vaults/add` `{ name, path, confirm: true }` remembers a folder. The page asks the person first and says so in
  the request (`confirm`); without it the hub refuses. The name is 1 to 40 letters, digits, dot, dash or underscore; the
  folder must be absolute and exist, and must not be a network share (`//host/share`, or two backslashes and a host:
  looking at one makes Windows sign in to that host; a drive letter or a mount is fine). Windows reads `/` and the
  backslash alike, so the separators are made one before the start is looked at (`/\host\share` and `\/host/share` are
  shares too), and device, verbatim and NT forms (`\\.\`, `\\?\`, `\??\`) are refused with them. Nothing is read from it yet.
  The settings file is read again before every change, so what a person edited by hand meanwhile is not written over,
  and a file that cannot be read stops the change.
* `POST /api/vaults/remove` `{ name }` forgets one (never its files); the vault that is read cannot go, also when the settings
  file was edited by hand to name another: the hub holds the vault it reads in memory, and an add or a remove does not move it.
* `POST /api/vaults/select` `{ name }` starts an engine for that vault. Only a vault that answers is taken: the old one
  stays when the new one does not work, and the settings are written (in one step, a temporary file and a rename) only after
  that. The snapshot, the search, the watcher and the open event streams of the old vault end with it; the page loads again.
  One change at a time, from the choice to the swap: two that overlap do not leave the hub reading one vault while the
  settings name the other.

The data classes (`areas.json`) are per vault and area name (schema 2, `<vault>:<area>`; schema 1 is the vault `main`): the
new vault brings its own, an area with no entry there is closed (or has the `default` of that vault), whatever the
old vault said of an area of the same name. What a page may do here is what a person at the keyboard of this machine
may do: a page that is paired could point the hub at any folder, so adding is a deliberate step with a confirmation, and an
error never holds a path (the terminal of whoever runs the hub gets the reason).

## The check as a job (`POST` and `GET /api/tasks/check`)

The check reads every task file and, with `stale: refs`, asks git, which takes longer than a question; so it runs in the
hub as a job, and as a process of its own (ten times the usual time allowed), outside the place and the persistent host
of the other calls: a write, a task or a question does not wait behind it. It only reads; a file changed while it reads
is at worst a finding that is gone at the next look. The page judges each finding by the task it is about, against the
version of that task as it was when the check was made (the snapshot of the same `rev`): a finding of a task that changed
since is shown as possibly resolved and counts for nothing, one of a task that is gone is dropped, one about no listed
task (the index, the Backlog) stands with the time of the check. A check whose `rev` the page never held (the vault
changed while it ran) shows no finding. A finding that names another task as well (a stale reference) is judged by the task it is
about only: it stays when just the task it points to changes.
Once a person has started a check without `refs`, the hub runs it again by itself after the vault changed: 10 seconds
without a change first, at least 30 seconds after the last start (a person's too), at most one at a time, only while a
client holds an event stream, with the area the person asked for, never with `refs` (a check that was started with `refs` switches this off, since running it
again would take those findings out), never in a vault that is no longer read. Changes within the quiet time or the gap
are folded into the one check that follows, so a folder that changes all the time (a sync tool) costs one check per
30 seconds at most, and none for a hub nobody is looking at. The page finds such a check by asking now and then (every 15
seconds, twelve times after each change of the list).
A check whose job is given up (another vault is read, the hub stops) is stopped with its process: it runs in the future of the job,
not on a task of its own. `POST` takes `{ "stale": "refs", "area": "<area>" }` (both optional, anything else is refused at the door),
starts the job and answers at once; a start while a job runs answers that job and starts no second one. `GET` (no query)
answers the state: `idle`, `running`, `done` with the engine's `tasks.check` document, or `failed` with a code and one
short sentence. The sentence of a failure is the engine's own refusal or a fixed text: what a failed process wrote on its
error output (it holds paths) never reaches the page. The state belongs to the vault that is read: choosing another vault
drops it (a start that comes after is refused with `vault_changed`), and a job of the old vault is aborted before it sets
anything. What the engine writes to its error output is logged by the hub for whoever runs it and never sent to the page;
hidden characters (bidirectional, zero width) are taken out of the sentence that is. There is no cancel: closing the dialog only stops the
page from looking, and the job ends by itself (the engine is not killed in the middle of a read). A `POST` counts against
the limit of mutations like every `POST`. The findings are the engine's words and are shown as text only.

## The graph of a task (`GET /api/tasks/plan_for?id=&direction=`)

A read like `done_preview`: the id must be `<area>/<slug>` and the direction `needs` (the default) or `unlocks`; any other
query is refused at the door. The tasks it names, the edges between them and the walk of the graph are the engine's; the
page lists what it is given and reckons nothing. The answer holds at most 500 tasks, which the page draws in steps.

## The estimate question (`POST /api/tasks/estimate`)

A read that is a POST, because its question (a list of ids and some assumed efforts and values) is too long for a query.
The body is one JSON object with `ids` (up to 1000 ids, each `<area>/<slug>`) and `assume` (up to 1000 entries, each with
an `id` and, if wanted, a short `effort` word and a whole `value`); anything else is refused at the door before an engine
process is asked. What the values may be is the engine's judgement, and its words come back as they are. Nothing is
written and nothing is scanned. The route needs a session and JSON like every route with a body, and has the coarse limit
of `ops` in the guard (300 in 10 s), not the strict one of the writes: choosing a cell in the matrix is a question, and
asking again must not use up what the writes may do. The sums are the engine's; the page never reckons one. A question that is
out when the next choice is made is abandoned (the page aborts it), and the draft holds the version of each file as it was when
the cell was chosen: Apply writes with that version, so a change made in Neovim meanwhile is a conflict and not overwritten.

## Opening a task in Neovim (`POST /api/tasks/open`)

The page sends `{ "id": "<area>/<slug>" }` and nothing else (a second field is refused). The hub asks the engine which file
the task is in, accepts only a plain relative name (no `..`, no drive, not absolute), and only a regular file that, with
links resolved, lies inside the vault (a link planted in the vault does not lead out of it). Neovim is started with that one
file as an argument and no shell: a new console window on Windows, the first terminal program found on Linux (`x-terminal-emulator`,
`gnome-terminal`, `konsole`, `xfce4-terminal`, `alacritty`, `kitty`, `xterm`). Where no way is known (macOS) the answer says so.
On Windows the path given to Neovim has the `\\?\` prefix of `canonicalize` taken off, except where the plain form would not
do: a path of 260 UTF-16 units or more, and a name Windows reads differently without the prefix (a device name such as
`con.md` or `com1`, also with a superscript digit, a trailing dot or space). The answer holds no path. The route needs a session and counts against the limit of mutations like any POST. An area that is
private is opened too: it is the person at this machine who asks, and showing it here is not a use that leaves the hub.
`TASKS_DESKTOP_EDITOR_LOG` (a file) makes the hub write the file instead of starting anything; the browser tests use it.

## Showing the vault folder, choosing a folder and making a new vault (`POST /api/tasks/vault_reveal`, `POST /api/tasks/vault_pick`, `POST /api/tasks/vault_create`)

`vault_reveal` takes `{}` (any field is refused): the page names no folder. The hub shows the folder of the vault it reads in
the file manager of the system (`explorer.exe`, `open`, `xdg-open`; no shell, the folder as the one argument) and answers
with no path. `TASKS_DESKTOP_EDITOR_LOG` makes it write `reveal <folder>` instead of starting anything.

`vault_pick` takes `{}` (any field is refused): the page cannot show a folder dialog with a path, so the hub shows the one of
the system on its own machine (PowerShell with `FolderBrowserDialog`, `osascript` with `choose folder`, `zenity` or `kdialog`; no
shell, fixed arguments) and answers `{ "path": "<folder>" }`, or `{ "path": null }` when the dialog was closed. The answer is the
person's own choice, put in the field of the form to look at and change; nothing is added by it (`vaults/add` asks again and
checks the folder). Only one dialog is open at a time (`pick_failed`, 502, for the second), and a hub without an opener answers
`404 open_unavailable`. `TASKS_DESKTOP_EDITOR_LOG` makes it write `pick` and return `TASKS_DESKTOP_PICK_RESULT` (empty: closed).

`vault_create` takes `{ path, area, confirm: true }` and writes on the machine of the hub, so without `confirm: true` it does
nothing. The path must be absolute without `.` or `..`, its parent must exist, and the target must not exist or be an empty
folder (never a file, never a folder with something in it: nothing is merged or overwritten). The one exception is a folder that holds exactly the structure of the same area and nothing else, what an earlier try left when the second step was refused: it is taken as it is, so that the person can try again. The area must be a plain folder
name. It makes `<path>/<area>/ROADMAP/tasks`, the folders the engine looks for, and does not register the vault: the page
then calls `vaults/add` as for any folder. All three routes need a session and count as mutations.

## The ranges of the fields (`GET /api/tasks/enums`)

A read without parameters (a query is `400`), a session needed. The hub asks the engine `hello` and passes on only its
`enums` (status, kind, prio, value, effort, actor, category, severity) as `{ "kind": "hub.enums", "enums": ... }`: no
version, vault or limit of the rest of the hello. An engine whose hello has no `enums` is a `502 engine_failed`, no engine
a `503`. The page reads the answer as data: a field that is not a short list of short words (or small whole numbers) keeps
the default of `ui/src/lib/fields.ts`, and the placeholder `<n>d` of the effort is not offered as a size.

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
questions as lines (`<id>\t<method>\t<params>`, answered by
`<id>\t<document>`). It gets the same environment as above, the same
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
* `deny.toml` allows a short list of licenses, crates.io and one git source
  (appkit), no wildcard versions; `cargo audit` and `cargo deny check` run
  in CI. Unmaintained crates are errors in the whole tree, the dependencies
  that come with appkit included.
* appkit is taken by a tag; `Cargo.lock` pins the commit, and a tag that was
  moved later is caught by `tools/check-appkit-pin.py` (also run in CI): the
  pinned commit must be the one the tag names now. The page's `appkit-ui`
  (the folder `ui-kit` of the same repository, pinned by `ui/pnpm-lock.yaml`)
  must name the same tag and commit; a `link:` to a checkout fails the check.
* A version that is younger than seven days is not taken
  (`tools/check-lock-age.py`, also run in CI). Cargo has no setting for
  this. A newer version is taken with `cargo update -p <crate> --precise
  <version>` once it is old enough, in a commit of its own with a look at
  the lockfile diff.

## Reporting

This is a personal project. Open an issue without details, or mail the
maintainer.

## Text snapshots of the test sheets (`GET /api/tasks/sheet_snap`)

The acceptance view shows the snapshots a test-sheet block of a live-check task names. They lie in the plugin
checkouts (`REPOS_DIR` of the hub's environment, never a setting of the page), not in the vault. The page sends the name
the block holds, `<repo>/TESTS/__snapshots__/<path>.snap`; the hub resolves it under `REPOS_DIR` and answers its text
(`snapshots::read_snapshot`). The route reads nothing else: the name is plain components only (no `..`, no drive, no
backslash, no hidden part), the first part is a plain repository name, the next two are exactly `TESTS/__snapshots__`,
the file ends in `.snap`, is a plain file (no link) that stays inside the checkouts after the path is resolved, and is at
most 256 KiB. A hub without `REPOS_DIR` answers 404. The specs name each refusal (`snapshots.rs`, `open_file.rs`).
