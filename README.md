# tasks-desktop

A local web UI and desktop app for [tasks.nvim](https://github.com/WKDSteve/tasks.nvim):
see the vault at a glance, create and move tasks, plans and a dashboard,
in the browser first and later as a small native app.

**Status: pre-alpha, P2 (hub core and read-only UI) is built.** The hub
serves the vault's snapshot, tasks, next and areas, searches the text of the
tasks, tells open streams when the vault changed and ships a read-only
interface in the browser. Writing and the native shell are not there yet.
Nothing here is released.

> **Run `install`, `start` and `autostart` in a normal terminal.** A packaged
> app (the Claude desktop app is an MSIX) and its child processes get what
> they write below `AppData`, and into the registry, redirected into the app's
> private store: the program, the settings and the login entry would exist for
> that app and be missing for you. The commands say so when they notice it.

## Principles

- **The engine is the only writer.** The hub never parses or formats
  frontmatter; it talks to tasks.nvim through the versioned documents
  `tasks-export/1` (read) and `tasks-ops/1` (write).
- **Loopback only, token always.** Host and Origin are checked, there is no
  data endpoint without a session. See [docs/SECURITY.md](docs/SECURITY.md).
- **Data classes fail closed.** An area without an entry in the per-device
  `areas.json` is treated as not released.
- tasks.nvim stays a pure Lua plugin. This repository holds the hub, the UI
  and the native shell.

## Use

```
tasks-hub serve [--port 1024-65535]   run the hub until Ctrl-C
tasks-hub start [--open]               run the hub in the background (no window; log: hub.log
                                      in the config folder); --open also opens the browser
tasks-hub stop                        stop the hub that runs in the background
tasks-hub autostart on|off|status     start the hub with your login (Windows: Run key;
                                      Linux: autostart entry; macOS: launch agent)
tasks-hub install [--autostart] [--shortcut]
                                      copy the program to a fixed place (Windows:
                                      %LOCALAPPDATA%\tasks-desktop\bin; elsewhere:
                                      tasks-desktop/bin in $XDG_DATA_HOME or ~/.local/share),
                                      so a build in the repository does not fight the running hub
                                      for the file; --autostart and --shortcut register that copy
                                      (Windows: registry and desktop link; Linux: an autostart
                                      entry and a launcher; macOS: a launch agent). Build with
                                      `cargo build --release` first (about 3.9 MB: full LTO,
                                      stripped).
tasks-hub uninstall [--purge-settings] stop the hub, take away the login entry and the link;
                                      --purge-settings also removes the settings (never the
                                      vault); the program file is left for scripts/uninstall.*
                                      (it acts on the installation of this user, whichever copy
                                      of the program you run it from: a build in target/ included)
tasks-hub open [--launch]             print a one-time pairing link for the running hub
                                      (--launch also opens it in the default browser)
tasks-hub usage [--days=14]           on how many of the last days the interface was opened
```

## In the browser, without installing

For a machine where no program may be installed: the page runs alone in Chrome or Edge (in Firefox and Safari read only) from one HTML file,
`tasks.html`, with the tasks.nvim engine inside it. There is no hub, no server and no network request (the page's CSP forbids
one).

1. Get the file: `git clone` (later `git pull`) of the private repository
   [tasks-web](https://github.com/WKDSteve/tasks-web); compare `Get-FileHash tasks.html` with `SHA256SUMS`.
2. Open `file:///<path>/tasks-web/tasks.html` in Chrome, or run `start-tasks.cmd` there (it finds Chrome, `/app` for a
   window of its own, `/shortcut` for a shortcut on the desktop and in the Start menu). Without the script: Options >
   "Create a shortcut ..." in the page gives the line for Windows' "New > Shortcut" (Chrome as a window of its own, or
   the plain address); Chrome saves no downloaded `.lnk` or `.url`, so the page offers none.
3. Press "Choose folder ..." and pick the vault folder. The page reads the `*.md` files, `areas.json` and
   `vault.json` into memory (`.git` and hidden folders are skipped). After a restart of Chrome, press "Allow
   access" once for the folder used last.
4. Changes made on disk (Neovim, git, agents) show up when the tab gets focus, or within 30 seconds. Writing from the
   page (create, set a field, done, move) compares each file with what was read and writes nothing on a conflict.

Which browser does what (the page checks the browser itself and says so on the first screen):

| Browser | Folder | Reading | Writing | Remembers the folder | Sees changes on disk |
| --- | --- | --- | --- | --- | --- |
| Chrome, Edge (86+) | picker (`showDirectoryPicker`) | yes | yes | yes, "Allow access" after a restart | yes, on focus and every 30 s |
| Firefox (50+), Safari (11.1+) | folder input (`webkitdirectory`) | yes | **no**: the page is a view, a banner says so, a change is refused with the reason | no, choose the folder at every start | no, choose the folder again |
| any other | none | no, the page names Chrome and Edge | no | no | no |

The table is what CI finds: `ui/e2e-web/engines.spec.ts` asks the page in each engine for the APIs it needs and the
read only way in (`ui/e2e-web/readonly.spec.ts`) runs in Playwright's Firefox and WebKit as they are. Last record
(2026-10-30, Playwright 1.63): Chrome has the picker; Firefox 155 and WebKit 26.6 have no picker but the folder input,
`DecompressionStream`, `Uint8Array.fromBase64`, IndexedDB and a blob worker with WebAssembly; the Origin Private File
System opens in Firefox and fails in WebKit from `file://` (`UnknownError`), which the page does not need. WebKit on
Windows stands in for Safari; a real Safari on macOS is not tried.

What is missing compared to the app: tray, autostart, notifications, "show in Explorer", "open in editor",
attaching screenshots, several vaults at once, finishing or moving a folder task that holds assets. Details of
writing, data classes and limits: the web variant section under "Layout" and `docs/SECURITY.md`.

## Install from a release

There are two channels, and both carry an install script that installs exactly their build:

- **A release** (a tag `vX.Y.Z`, published by hand after a draft was tried) holds the program for
  Windows. The repository is private and has no paid plan, so CI and the builds run on the author's
  self-hosted Windows runner (see [docs/RELEASING.md](docs/RELEASING.md)); there is no Linux or macOS archive and
  no `install.sh` any more. The code still has the Linux and macOS paths (autostart entry, launch agent) and
  builds there from source, but nothing builds or tests them in CI.
- **The rolling build** (the pre-release `latest`) is the newest green commit of `main`, rebuilt
  after every CI run: for trying what is new, not for anything that matters.

The scripts need no administrator rights and install for one user, so they also work where a signed
Setup is not allowed or SmartScreen stops a downloaded program. Run them in your own terminal (not
elevated, not from inside a program that sandboxes AppData). The repository is private: an anonymous
download is answered with a login page, so fetch the script with `gh` and give it a token that may read
the repository in `GH_TOKEN`:

```
# the rolling build (Windows)
gh release download latest -R WKDSteve/tasks-desktop -p install.ps1 -D $env:TEMP --clobber
$env:GH_TOKEN = (gh auth token); & "$env:TEMP\install.ps1"

# a release: the same with the tag in place of latest, e.g. gh release download v0.1.0 ...
```

They download the program of that build, check it against its `SHA256SUMS` (a wrong or missing
checksum installs nothing), and hand over to `tasks-hub install`, which replaces the program in one
step and brings a running hub back. The installation that is there is found and replaced, never a
second one beside it: the script of `latest` run again updates to the newest rolling build, the
script of a release run again repairs that release (to update, take the script of the newer
release, or pass `-Version`/`-Rolling`). To pass arguments, add them to the call:
`& "$env:TEMP\install.ps1" -InstallArgs '--autostart','--shortcut'`
registers the hub with your login and adds a link. The other options are `-Version vX.Y.Z` / `-Rolling` for
another channel and `-File FILE` for a file you already have, with `-Sums FILE` or `-Sha256 HEX`. Through
`powershell -File` an array arrives as one string, so a saved `install.ps1` takes one `-InstallArgs`
value there; in a PowerShell session a list is fine. The install scripts are the ones of appkit's
[release-kit](https://github.com/WKDSteve/appkit/tree/main/release-kit), stamped for this app and
the channel when they are attached; `scripts/test-install.*` try the script of the pinned kit
against the hub in the CI of every commit and in the build of every release.

**Or build this checkout and install it** (Windows; Rust, Node and the toolchain of [Build](#build)):
the same steps as the rolling build, then `tasks-hub install` of the program built here. Nothing is downloaded but the packages
of the lock files, and a file built on the machine carries no mark for SmartScreen to stop.

```
.\scripts\build-install.ps1 [-BuildOnly] [-InstallArgs '--autostart','--shortcut']
```

```
.\scripts\uninstall.ps1 [-PurgeSettings]
sh scripts/uninstall.sh [--purge-settings]        # Linux/macOS, from source; not run by CI any more
```

Uninstalling stops the hub, takes away the login entry and the link, and removes the program. Your
settings stay unless you ask; your vault and your tasks are never touched. If a step fails the
program stays, so that nothing points at a missing file. How a release is made:
[docs/RELEASING.md](docs/RELEASING.md).

The hub keeps one Neovim process as its engine and asks it over a line
protocol (about a fifth of the time of one process per question, measured on
the real vault: a task detail 225 ms instead of 825 ms). If that process is
not there the hub falls back to one process per question by itself;
`TASKS_HUB_ENGINE=process` forces that way.

The hub tries port 17615 first (the port is part of the origin, so it is
fixed). If it is taken the hub starts on a free port and says so; the page
then has another origin.

`tasks-hub open` prints `http://127.0.0.1:PORT/#pair=<code>`. The code is
good once and for 60 seconds.

```
tasks-hub areas propose [--private=a,b] [--write]   a data class for every area (a proposal)
tasks-hub areas check                               fails while an area has no data class
```

Which areas may leave the hub is decided per device in `areas.json` in the
config folder; an area with no entry counts as unclassified and is released
for nothing. `propose --write` writes `areas.proposed.json` next to it; the
hub reads only `areas.json`.

To not decide area by area, `areas.json` may carry `"default": "internal"`
(or `public`, `private`): the class of every area the file does not name.
An entry still wins, so `"secret": {"class": "private"}` stays private. Without
`default` an area with no entry is unclassified. That file (schema 1) is the classes of the vault `main`. When you
read more than one vault, use schema 2, whose keys are `<vault>:<area>` (`"work:lib.nvim": {"class": "private"}`, and
`"vaults": {"work": {"default": "internal"}}`): two vaults may have an area of the same name, and each keeps its own
class; a vault the file does not name has everything unclassified. `tasks-hub areas propose` writes schema 2 as soon as
the vault is not `main` or the file is already schema 2, and keeps what the other vaults decided. See
[docs/SECURITY.md](docs/SECURITY.md).

## The rolling build (the newest `main`, one click)

After every green CI run on `main`, the workflow `rolling` builds the program of that commit for Windows
and puts it on the pre-release [`latest`](https://github.com/WKDSteve/tasks-desktop/releases/tag/latest) (a login
with read access is needed: the repository is private);
the files are replaced each time. It is not a release (see `release.yml` for that): not signed, not tried by hand.

| File | Use |
| --- | --- |
| `tasks-hub-windows-x86_64.exe` | double click (SmartScreen warns about an unsigned program: "More info", "Run anyway") |
| `install.ps1` | installs exactly this build (see above) |
| `SHA256SUMS` | the checksums of both |

Started **without an argument**, the program starts the hub in the background if it is not running and opens
the browser with a one-time pairing link (a second double click finds the running hub and opens a new link). If
something is missing, the message says what, and a console opened by the double click waits for Enter before it
closes.

The **first** double click also asks, once each, in the console: where your vault is (kept in the settings; an
empty line skips it), whether to install the program to your user folder (no administrator rights; then
whether to start it at login and to put a link on the desktop), and, when another version is installed, whether
to replace it. The hub then runs from the installed copy. What was answered or declined is noted in
`setup.json` in the settings folder, so a second click asks nothing. Without a person at the console (a pipe,
a script) nothing is asked; `TASKS_DESKTOP_NO_SETUP=1` switches the questions off. It needs Neovim 0.10+ and checkouts of `tasks.nvim` and `lib.nvim` (the engine), found through
`TASKS_ENGINE_DIR` and `LIB_NVIM_DIR`, `REPOS_DIR` or the settings file; the vault is `TASKS_VAULT`.
`tasks-hub --version` names the commit of the build; `tasks-hub stop` ends the hub.

## Look at the current state

`tools/dev-hub.ps1` builds this checkout (UI, then the hub with the interface embedded) and runs the hub from
`target/` against the local `tasks.nvim`, `lib.nvim` and vault checkouts. It installs nothing. Run it in a normal
terminal: `.\tools\dev-hub.ps1` (until Ctrl-C), `-Background` (start and open the browser), `-NoBuild`, `-Release`,
`-Vault <dir>`.

## Layout

```
crates/tasks-hub/   the routes, the engine calls and the program of the tasks hub (lib + bin)
crates/hub-testkit/ the fake tasks engine and the tests that need a process or a socket
e2e/fixture/vault   synthetic vault (no real data), made by tools/make-fixture-vault.lua
docs/SECURITY.md    what the server checks, and what it does not
engine.lock         the tasks.nvim and lib.nvim commits this is built against
ui/                 the browser interface (Svelte 5, Vite, TypeScript)
ui/probe/           the probe of the web variant: one HTML file run from file://, `pnpm probe` builds it
ui/src/web/         the engine of the web variant: tasks.nvim in a Lua VM (wasmoon), the vim shim, the worker
ui/web/             its Node side: the bundle of the Lua sources, the tests, the engine check page
```

The web variant (no install, no server: one HTML file opened from disk, the engine in the browser) is built here
and used as described under "In the browser, without installing". Its built files go to the private repository [tasks-web](https://github.com/WKDSteve/tasks-web).

- **The engine runs unchanged.** `ui/web/engine-bundle.mjs` takes the Lua sources of tasks.nvim and lib.nvim
  from the git objects of the commits in `engine.lock` (never the working tree), follows their requires with a
  small Lua lexer and drops the comments (the lines keep their numbers). `ui/src/web/vim-shim.lua` gives them the
  `vim` they use, on Lua 5.4 instead of LuaJIT; `vim.inspect` is Neovim's own (`ui/src/web/vendor/`). The vault
  lies in the in-memory file system of the VM.
- **Same documents as nvim.** `pnpm web:test` runs the engine in Node. With `TASKS_WEB_COMPARE=1` (CI does)
  every read method must answer byte for byte as `nvim --headless -l scripts/tasks.lua call ...` on the same
  commits; only `generated_at` and `engine` may differ (`engine.nvim` is `web+Lua5.4`: no Neovim runs). The
  shim itself answers `ui/web/shim-parity.lua` (JSON, paths, `tolower` for every code point to U+1FFFF, ...) as
  nvim does; `node web/tolower-table.mjs` makes its case table from nvim when Neovim's tables change.
  A second vault of edge cases (`ui/web/edge-vault.mjs`, made in the test: CRLF, a byte order mark, heads that are no
  YAML, invalid bytes, text outside ASCII, numbers and dates that are none, a folder as a task, ties in the order, 180
  tasks) is compared the same way: every read method, every page of `list` and `finished`, and every open and
  finished task by its id. The documents are compared as text, so the bytes of the task with invalid UTF-8 are
  compared after both sides made U+FFFD of them.
- **In the browser.** `pnpm web:check -- --out=<tasks-web>/engine-check.html` builds one page that starts the
  engine in a classic worker from a blob (a module worker does not start from `file://`) on a synthetic vault.
  `pnpm probe -- --out=<tasks-web>/probe.html` builds the probe that checks whether a machine allows all this.
- **The vault folder.** `ui/src/web/vault-files.ts` reads a picked folder (`showDirectoryPicker`) into memory and
  `VaultMount` puts it into the VM's file system. Names from the folder are untrusted: a separator, a NUL or a dot
  segment never becomes a path; only `*.md` and, at the root, `areas.json` and `vault.json` are read; hidden folders
  (`.git`) and `node_modules` are left out; a file over 4 MiB is skipped and reported; a folder over a budget
  (20 000 files, 256 MiB, 32 levels) is refused as a whole, because a vault read in part would show wrong data.
  `VaultMount.changes()` lists what the engine added, changed and removed since the load (for the write-back).
  `pnpm web:test` runs `web/vault-files.test.mjs` with a fake folder, so it needs no browser.
- **The hub in the page.** `ui/src/web/hub.ts` answers the routes of the Rust hub behind the `fetch` that
  `ui/src/lib/api.ts` takes: the same checks before the engine is asked (a plain query, `<area>/<slug>`, an area
  name, one of five sorts), an engine refusal with its code and the HTTP status the Rust hub gives it, the digest of
  the snapshot as its tag (304), the `hub.areas` envelope with the class of each area (from the `areas.json` of
  the folder, see *Data classes and the cache*), `hub.enums`, the check job. There is no session and no token. `ops` writes (see
  *Writing* below); `open` and the vault routes answer a refusal (`not_available`); `search` (`ui/src/web/search.ts`) reads the task
  texts once through the engine's `bodies` (kept until the vault is read again) and ranks and marks matches as the
  Rust hub does; `partial` is true only when the texts exceed 64 MiB. In the web mode the page hides what needs the
  machine ("open in Neovim", "show vault folder", attaching a screenshot), and "About" names the engine in the
  browser. `web/hub.test.mjs` runs it over a stand-in for the engine.
- **The page and the worker.** `ui/src/web/client.ts` is the page's side of the worker: `WorkerClient` matches each
  question to its answer by an id (`init`, `mount`, `call`, `changes`), `createBrowserHub` joins it to the hub. The
  worker mounts a vault with `mount` (a new mount replaces the old one; a path that is not plain, or a root that is
  not an absolute folder in the VM, is refused and leaves the vault that is there). `web/worker-client.test.mjs`
  runs the real engine in an in-process worker (it needs `wasmoon` and the engine checkouts, like
  `web/engine.test.mjs`).
- **The way in.** `ui/src/web/entry.ts` is a small state machine (starting, unsupported, choose, opening, open) behind
  `ui/src/web/WebEntry.svelte`: "Choose folder" calls `showDirectoryPicker({ id, mode: 'readwrite' })`, the folders
  used before (their handles in IndexedDB, five at most, `ui/src/web/folder.ts`) are listed with the permission each
  has now. After a restart of the browser the permission is `prompt`: the click on "Allow access" asks for it again
  and nothing else comes before that call, because the browser grants it only inside a click. A cancelled or refused
  picker (a policy of the organisation), a folder that is gone and a folder over the budget come back to the start
  page with their reason; a browser without the API, or a page that is not a secure context, is told so and offers
  no picker. `web/entry.test.mjs` and `src/web/WebEntry.test.ts` run it without a browser.
- **Writing.** A request of `ops` goes through the engine, which changes its copy of the vault in the VM; the files
  it changed, added or removed are then written to the folder (`ui/src/web/vault-session.ts`, `write-back.ts`).
  Nothing is written over something the page has not seen: every file the change touches must still have the time,
  the size and the content it had when the page read it (SHA-256), and a new file must not exist. Any difference is a
  conflict: nothing is written, the answer is HTTP 409, the page reads the folder again and shows what is on the
  disk, and a retry works on that. The same look is taken once more right before each file is written, removed or
  moved, and before a new file is made; a change found then is also a conflict, and what had been written is taken
  back. A file is written through `createWritable`, which the browser commits atomically on close, so a file is
  never half written; every file written is read back and compared. A failure in the middle takes back what was done
  (and says by name what it could not). Requests run one at a time, and a read waits for a write that is under way.
  The page asks the browser to confirm closing while a write is under way. **Limits:** the File System Access API has
  no compare-and-swap, so a program that changes a file in the milliseconds between the last look and the write
  still wins silently; a write of several files is not atomic as a whole (closing the tab in the middle, or a crash,
  can leave a task both in the roadmap and the Backlog; the next session sees that as a normal state); a folder task
  that holds files the page does not read (an image) is not moved by halves but refused; the clipboard attach is not
  available. While the reader skipped a file (over 4 MiB, unreadable, a name that is not plain) the page does not
  write, because the engine cannot see that file and would rebuild the generated index without it; a dry run still
  works. The watcher is told what the page knows of the folder (the scan taken before the read, moved on only for
  the files the write touched), so a change from outside to any other file is still found and read.
  `web/write-back.test.mjs`, `web/vault-session.test.mjs` and `web/ops.test.mjs` run it on a fake folder (the last
  with the real engine); `ui/e2e-web/writes.spec.ts` in Chrome.
- **Reading again.** There is no server to say that a file changed. When the window gets the focus back, and every 30
  seconds, the page asks for the signature of the folder (`vaultSignature`: path, size and time of each file the
  reader would take, no content); if it differs, the vault is read again and the open event streams hear a `resync`
  (`ui/src/web/watch.ts`, `ui/src/web/hub.ts`).
- **Data classes and the cache.** The page reads the `areas.json` at the root of the folder the person chose
  (`ui/src/web/classes.ts`), in the two schemas of `crates/tasks-hub/src/classes.rs` and with its refusals, fail
  closed: an area the file does not name is `unclassified`, and so is every area when the file is missing, is not valid
  JSON, names a class that does not exist, has a field twice or any other fault of the Rust parser (the page parses
  as strictly as serde_json: `1.0` is not a schema, a lone surrogate or a byte order mark refuses the file, and so
  does a file over 256 KiB). The page is the vault `main` of the file. The Rust hub keeps the file in its config
  folder, outside the vault; here it is in the vault, so a change to it that arrives with a pull counts (see
  `docs/SECURITY.md`). The classes are read with the folder and replaced together with the engine's copy of it; when the
  watcher or a conflict makes the page read the folder again and the decisions changed, the hub sends a `classes`
  event and the app asks for the areas again (a read that fails leaves no class at all). The list cache is the one of
  the hub-based page (`ui/src/lib/cache.ts`, rule WEB-17, unchanged): only public and internal areas reach IndexedDB,
  and the tab keeps its session (a word, not a secret: there is no server) in `sessionStorage`. Because the engine's `vault.id` is the same for every
  folder, `ui/src/web/scoped-cache.ts` keeps the list of one folder only, named by the id of the folders used before,
  and reads it back only while every area in it is still released; a folder the browser could not remember keeps no
  list. `web/classes.test.mjs` runs 156 cases (`web/classes-cases.mjs`: the cases of the Rust tests and the edges where
  a browser's JSON differs from serde's) that were checked against `classes.rs` itself; `ui/e2e-web/classes.spec.ts`
  watches IndexedDB for every write the page makes. **Open:** a file that cannot be used only shows as "everything is
  unclassified"; the page does not yet say why.
- **One file.** `pnpm web:build` runs `vite build --mode web` (`ui/src/main.web.ts`, one script, one style) and
  `web/pack.mjs`, which writes `ui/dist-web/tasks.html` and `SHA256SUMS`: the script and the style inline, the four
  parts of the engine (worker, WASM, Lua sources, vim shim) gzip-compressed as base64, and a policy as a meta tag
  (`default-src 'none'; connect-src 'none'; worker-src blob:` and the like: no request of any kind, no outside
  source). The build refuses a shell that loads something (a `src`, a `href`, a URL, a refresh, a stray script).
  `pnpm web:e2e` is a Playwright config of its own (`ui/playwright.web.config.ts`, tests in `ui/e2e-web/`; it needs
  `pnpm web:build` first, the system's Chrome and Playwright's Firefox and WebKit (`pnpm exec playwright install
  firefox webkit`, about 184 MiB; `--project=chrome` leaves them out), no hub, no engine checkout) that opens the built file from disk with a
  fake folder (`page.ts`: `fakePicker`, `disk`, `editOnDisk`; the fixture vault `e2e/fixture/vault` and the hostile
  tasks of `e2e/hub.ts`, the same as the hub-based `pnpm e2e`). `opens.spec.ts`: the file starts its engine in a
  worker, the tasks show, a change of a file shows after a focus event, the search, "About"; a positive test shows the
  policy does refuse a `fetch` and an image. `flows.spec.ts`: the overview and its tiles, the list and the detail, hostile
  titles and bodies as text, the search and its reset, the filters, the plan and its graph, the graph of a task, the
  check job, the board, accessibility (axe, light and dark, German). `writes.spec.ts`: create, `set`, `done`, the
  conflict. `classes.spec.ts`: what reaches IndexedDB. `floats.spec.ts`: a task of the list in its float, the float
  moved and kept, a task detached into a window of the same file and the file opened at `#task=<id>`. Every test ends by holding the page to the two rules: no request
  and no violation of the policy. CI runs the project in `ci.yml` (after the build of the page) and in `web.yml` before
  the file is published. The workflow `web.yml`
  (tag `v*`, or by hand) builds, tests and commits `tasks.html` to the private repository `WKDSteve/tasks-web` with the
  runner's own git credentials (no deploy key); it is opened there with `file:///.../tasks-web/tasks.html`.
- The Node tests need `pnpm install` for wasmoon only where they start the engine (`web/engine.test.mjs`,
  `web/worker-client.test.mjs`); the pieces around it run on Node alone: Node strips the types itself.

What does not depend on tasks (the guard, pairing and sessions, the engine seam, the store, the
watcher, the search, installing, and the security matrix every app's hub must pass) is
[appkit](https://github.com/WKDSteve/appkit), taken by the tag named in `Cargo.toml`
(`[workspace.dependencies]`); `Cargo.lock` pins its commit and `tools/check-appkit-pin.py` checks
that the tag still names it. The page takes its shared parts from the same tag (`appkit-ui`, the
folder `ui-kit` of that repository, named in `ui/package.json` and pinned by `ui/pnpm-lock.yaml`):
the design tokens and base rules, the menu bar, the multi-select, the info button, the markdown
reader, the hint popup, the event-stream reader and the pairing code; the same check holds the two
pins to one commit.

The Tauri shell and the browser tests are added by the phases P2 to P7; the
plan lives in the maintainer's notes.

### The interface

```
cd ui
pnpm install --frozen-lockfile
pnpm build        # ui/dist
pnpm check && pnpm test
```

The interface is part of the binary: `build.rs` embeds `ui/dist`, so build
the interface first and the hub after (`pnpm build`, then `cargo build`). A
hub built without `ui/dist` shows a placeholder page. For work on the
interface `TASKS_HUB_UI_DIR=<folder>` serves a build from disk instead,
read once at start.

```
pnpm e2e          # the browser tests: needs target/debug/tasks-hub, the engine
                  # (TASKS_ENGINE_DIR, LIB_NVIM_DIR) and Chrome; nothing is downloaded
```

The Plan view (`g p`) groups the open tasks by stage, marks the critical path and
shows what the plan warns about (cycles, tasks that name the same file); the
engine did all the reckoning and the page only groups it. A plan can be chosen: the
stages, the phase counts and the warnings narrow to it (the choice is kept when the view
is left), while the state counts, the estimate and the critical path stay those of the
whole vault. The interface can create a task (`c`, or the Project menu), change status,
priority, who, kind, effort, value and tags in the detail, tick a step of the plan section and add a dated line to the notes (the box of a step shows what the file says; a click asks the engine first), attach a screenshot to a task (*Attach screenshot* in the detail, or the box in the new-task form: the image on the clipboard of the machine the hub runs on, else its newest screenshot; the detail then shows the link to put into the text),
change several marked
tasks at once (also effort, reminder and tags: added or taken off for each task) (`x` or the box marks, the choice in the bar is applied with a button,
and a filter that hides a task also takes its mark; one batch, each task with the version that
was shown, so a task changed meanwhile fails alone), move the marked tasks to another area
(one dry run first says per task its new id, how many places follow, a taken slug and a change of the data class;
the button then moves those that can go in one batch, a task that names another marked one first; marks and selection
follow the new ids, and undo moves them back; at most 50 in one batch, as a move rewrites several files and one engine call has 30 s), undo that, see the tasks as a board (a column for each status, the cards in the
engine's order; a card is dragged to another column to set its status or among
the cards of its priority to reorder, or moved with `Shift` and `j` `k` `h` `l`; `g b` opens
the board; the order holds inside one priority and one stage only, which the board says), sort the tasks that lack a priority, an effort or a who in the inbox (`g i`: `j` `k` move, `1` `2` `3` set the priority, `a` `s` `d` `f` the effort XS S M L and `Shift`+`f` XL, `m` `p` `i` the who me, pair and cdx, `u` takes the last change back; one key is one change the engine judges; a key of the board or the inbox pressed while a change is still being saved is refused with "Still saving" and not kept for later: press it again), check the vault in the background (the Check dialog from the list or the palette: the engine reads every task file and applies its rules while the page goes on; the findings come with the task each is about, with a flag on its row and a section in its detail, and a check made for an older state of the vault shows none), ask what a task needs before it can start, or what waits for it (the detail's button or the palette: the Plan view then lists the tasks by their distance, with the engine's edges, the critical path and the cycles; the arrow keys move between them, and the list is the form for the keyboard and a screen reader), set effort and value of many tasks side by side in the estimate matrix (`e` in the list, on the marked tasks or the shown ones: the sum, its range and how many tasks have an effort or a value are the engine's, asked again for what you chose; nothing is written before Apply, which is one batch with only the cells that differ), make a plan with a wizard (a title and an area are enough; the engine names the
plan in a dry run while you type, tells a name that is taken and refuses what is not a plan),
find an action or a task in the command palette (`Ctrl`+`K`: a few letters in order are enough, what you chose before comes first; it changes the status or priority of the selected task, goes to a view, and more), finish a task after a preview of
what it does, and set a reminder (a date on which a task comes back on the
Today page; also when finishing); the engine makes every change. The interface lists the vault in the engine's own order (it
never sorts), shows a task with its steps and its text (as text only) in a float over the list (a click on a row, or
`o` on the selected one; the overview and the plan open it the same way), in which the text fields each take a line of
their own, the summary has several lines (it is kept as one line: a line break becomes a space) and *Done* stands large
in the lower right corner; the float and the other dialogs are moved by their title or the handle ✥, sized by the
grip in their lower right corner (or by the arrow keys on the handle, with `Shift` for the size; `Home` puts them back)
and keep place and size per kind in the browser, always inside the window; the float's button ⧉ opens the task in a
window of its own (the same page at `#task=<id>`, paired by the session of the tab; in the web variant the new window
asks for the folder again, a folder used before is one click; the hub gives one session at most four live event
streams, so from the fifth window of one tab on the bar says *not live: too many windows*: such a window is read again
when it gets the focus and goes live once another window of the tab is closed: when it gets the focus, or by itself
within half a minute),
follows the hub's event stream and asks for a scan when the window gets the
focus back. The numbers of the overview on the Today page (ready, doing, blocked, with value) are buttons: a click opens the tasks behind the number, as a list or cut up by priority, area, plan or (for blocked) the task they wait on, a page of fifty at a time; the key `v` on a number walks the views and the choice is kept for each number. The Vaults menu chooses which vault the hub reads (the list is in `config.json`); Options holds the language, the theme and the settings; one of them, "Save fields with a button", holds the changes of a task's fields in the detail until Save (or Ctrl+S) writes them in one go, against the version of the file they were made on (a change made meanwhile goes to the refused changes, not over it), where otherwise each field is written as soon as it changes. Help says what this build is (version, the commit of a rolling build, platform, the version and commit of the engine that answers, and the commits `engine.lock` pins, so that two installations can be told apart) and prepares a problem report out of those words and nothing else: no path, no vault, no name; the form opens in the browser and you send it yourself, the app sends nothing. German and English, light and dark.

#### Order, lists, views, export and moving by drag

- **Order.** The list can be shown in an order of the engine (the choice *Order* in the filter row: plan order, priority then effort, severity, most used, value for effort). The page asks the engine for the ids in that order in one call (`GET /api/tasks/order`) and lays the tasks it holds along them; it never sorts by itself. The choice is kept, and a word the engine refuses puts the plan order back with a message.
- **Search.** The search box of the list has a button that empties it (there while it holds words; `Escape` in the box does the same, once an open hint of the box is closed by the first one) and keeps the focus in the box; *Clear all filters* takes the words away together with every chip, and is offered for words alone too.
- **Lists.** The filter and the order shown can be kept under a name (*Save as list ...*, up to 50 per vault, in this browser only) and brought back from the *Lists* choice (the search words stay); the command palette has an entry for each (`List: <name>`). The lists of the engine (built in, saved with the editor, from its configuration) are offered next to them in a group of their own, read only: applying one lays its option words onto the filter, `readiness` is the page's own *State* choice (ready and decision, or waiting and stuck, as the engine means them) and `quick_win` is the engine's own figure of quick wins (also a filter of its own, *Quick wins only* under *More filters*); the words the page cannot say (`stale`, `blocked`, `unestimated`, an effort no task has) are named in a message instead of being left out in silence.
- **Views.** The tab *Views* (`g v`, the View menu, or `View: <name>` in the palette) shows the open tasks of a saved view in groups by a field: as columns side by side or as a list of sections that fold (with a count each). A view is a file of the vault (`<area>/ROADMAP/views/<slug>.md`), the same on every machine (one that a pull brings or changes is in the tab without a reload): *New view* makes one with a name, the area it is kept in, the field and the form (and, if you like, the filter of the list as what it selects); the name, the field and the form change in place, a fold is kept in the file, and every change - making and deleting included - can be taken back. A card dragged to another group - or moved with `Shift` and `h` `l` on it - writes the field the view is grouped by, on the version shown: for tags the tag it leaves goes and the one it enters comes (`Ctrl` while dragging, or `Shift`+`Alt` with `h` `l`, keeps the one it leaves); a marked card takes the other marked cards of the view with it, and what the engine refuses is said in its words. A card moved to another area (a view grouped by area) is a move of the file: as in the panel of the overview the engine is asked first and the dialog says what the move does (the new id, the places that follow, a taken name, a change of the data class); only the confirmation moves it, on the version shown. The derived fields (readiness) are not moved, and a matrix does not move the area. The board is the built-in view of the views (columns by status, with its order inside a priority, its runs and the strip for finishing): `g b`, the View menu and the palette show it in the bar of the views, where it is chosen like a saved one and cannot be deleted. As a *matrix* a view has a row for every value of a second field and a column for every value of the first; a cell shows how many tasks have both, a click on the number lists them, and a card of that list dragged onto another cell - or moved with `Shift` and `h` `l` (column), `j` `k` (row) - writes both fields in one change. A right click - or the menu key, or `Shift`+`F10` - on a task of the list (its area), an area of the overview, the plan chosen in the Plan view or a group of a view opens *Open as a view*: the same tasks as columns or a list, or grouped by a field. Such a view is one to look with, not saved (nothing is written for a look); *Save as view* makes it a file of the vault. The palette has *View: group the list by ...* for the list as it is filtered. Which fields there are and the values of each are the engine's (`GET /api/tasks/groupings`); the engine writes the file and refuses a view that changed meanwhile.
- **Connections.** The View menu's *Connections* shows where the areas hang together (the engine's `tasks.links`): a matrix of the links per pair of areas, a net beside it (a line per pair, as thick as it has links and with the number on it; a line is a button that opens the pair, reached by the keys as a cell of the matrix is), and the list of the pairs with their links. A view can be grouped by *Connects areas* (`cross`, a field of the engine): a task stands under *touches several areas* when the links name it among those that touch two or more.
- **A view in a new tab.** A middle click on a view of the View menu (or `Ctrl`+click, or `Ctrl`+`Enter` on it; `Cmd` on a Mac) opens the same page in a new tab or window at that view (`#view=<name>`), the way a link opens; the tab it came from keeps its view, and the new one does not change the view the page opens on next time. The hub's new tab has the session of the old one; the web variant's new window asks for the folder (or for access to the one used last).
- **Export.** The button *Export* of the list, the board, the plan and a saved view (and the same entries in the View menu, in the Project menu and in the palette, `Export: ...`) saves what that view shows as a CSV, JSON or Markdown file, or copies it to the clipboard: the tasks after filter and search (in the list only the marked ones when some are marked; the other views do not show the marks), in the view's order and with the group each stands in, in the words the view uses (the board's column, the plan's stage, the group of a saved view, and for a matrix the column as the group and the row beside it; a task the view shows in two groups is two rows). The entries are there only in a view that shows tasks (not on Today, in the inbox or with no saved view open), and a saved view that shows only a note exports nothing. The file is named by the view and the day (`tasks-board-2026-10-24.csv`); a JSON file says its format (`tasks-desktop-export/1`) and the view. Tasks of private or unclassified areas stay in the app, as they stay out of the browser's cache, and the message says how many; the name of a plan or a saved view kept in such an area is in neither the file's name nor its text (a task keeps its place without the id of such a plan). Until the classes are read after a start nothing leaves, and the message says that. An export of nothing is not made and says so. A CSV cell that a spreadsheet would run as a formula gets a quote mark in front; the file starts with a byte order mark and has CR LF rows, and the columns are split at `;` where the system's locale writes a decimal comma (a German spreadsheet expects that) and at `,` otherwise. The page may write the clipboard on a click and never read it (`clipboard-write=(self)`, see `docs/SECURITY.md`). *Print or save as PDF ...* (same places) opens the browser's print dialog, where *Save as PDF* makes the file: it prints a page of its own made from the same rows (not the screen, which draws long lists in parts), with the view, the day, the count and the filters on top (a filter that names a private area or a plan kept in one is left out, and the words of the search are printed only when no task of such an area has them), the groups and the cells in the words the view shows, a section for each group and a table of the tasks, black on white whatever the theme; nothing else of the page is on paper. PNG is not there yet.
- **Moving by drag.** In the tasks behind a number of the Today page, a row can be dragged onto an area: the other areas show as places to drop, the engine is asked first (a dry run: the new id, how many places follow, a taken name, a change of the data class), and only the confirmation moves the file, under the version that was shown. If the row is one of several marked tasks, they go together. Without a mouse, the key `m` on a task or the button beside it opens the choice of the area. On a touch screen a finger or a pen drags by the grip (the dotted mark) on a row of the panel, on a card of the board, on a card of a view and on a card of an opened matrix cell; the places count after the finger has gone 24 px, and what the finger lets go over takes the drop (an area, a column, the strip for finishing).

## Build

```
cargo build --locked
cargo test --workspace --locked
```

The tests that talk to the real engine need Neovim >= 0.12, a tasks.nvim and a
lib.nvim checkout (found through `REPOS_DIR`, or `TASKS_ENGINE_DIR` and
`LIB_NVIM_DIR`). Without them they skip; `TASKS_DESKTOP_REQUIRE_ENGINE=1` makes
that a failure, as CI does.

A Rust test gets its folder in the temp dir from `Scratch` (`crates/hub-testkit/src/scratch.rs`), which removes it
when it drops, also after a failure or a panic; never from `std::env::temp_dir()` and a name of its own.
`node tools/check-temp-leftovers.mjs` counts what is left of `tasks-desktop-*`, `hub-testkit-*` and `tasks-web-*` in the
temp dir (`--dir` names another, which must exist) and fails if there is anything. CI gives the Rust job a temp dir of its
own (`TEMP`, `TMP`, `TMPDIR`) and runs the check on it with `--strict` after `cargo test`: then every entry counts,
whatever a test called its folder, except the `--allow`ed `nvim` and `nvim.0` that the real Neovim makes.

The Node and Playwright tests get their folders from `ui/web/tmp.mjs` (`testDir(t, label)` for one test, `tempDir`,
`tempRoot`), never from `mkdtemp` or a name of their own in `tmpdir()` (`ui/web/tmp.test.mjs` checks the sources). A
process makes one root (`tasks-web-run-XXXXXX`, `tasks-desktop-e2e-XXXXXX` for the hub's browser tests) and removes it
when it ends, however it ends (exit, uncaught error, SIGINT, SIGTERM; under Playwright, which handles Ctrl-C itself and
runs the global teardown, the root goes in the `exit` event that follows); a folder that cannot be removed is retried (in
a loop of `removeTree`: the `maxRetries` of `fs.rmSync` does nothing on this Node) and then an error, not a silent
leftover. `ui/web/e2e-cleanup.test.mjs` holds the cleanup of the hub's browser tests (a hub that does not start, a setup
that fails, the state file) to that without a real hub. CI runs these steps, and the install tests of `scripts/`, through
`node tools/run-with-temp.mjs -- COMMAND`: the command gets a new empty temp dir (removed also after a Ctrl-C or SIGTERM,
which the wrapper waits out), and the step fails when a `tasks-desktop-*`, `tasks-web-*` or `hub-testkit-*` is left in it.
That count is not strict, because Chrome, Playwright and Node keep caches of their own in the temp dir.

## Settings

`config.json` in the config folder (`%APPDATA%\tasks-desktop` on Windows, or
whatever `TASKS_DESKTOP_CONFIG_DIR` names) may set `vault`, `vaults` (more
vaults, each a `name` and an absolute `path`: the Vaults menu of the page adds them and
chooses the one that is read), `active` (the name of that one), `nvim`,
`engine_dir`, `lib_dir`, `extra_areas`, `attach_dirs` (the folders *Attach screenshot* takes the newest screenshot from
when the clipboard holds no image, at most 8 absolute paths; none: only the clipboard; a change takes effect when the
hub starts again) and `port`. Unknown keys are refused.
Every path falls back to an environment variable (`TASKS_VAULT`,
`TASKS_NVIM`, `TASKS_ENGINE_DIR`, `LIB_NVIM_DIR`, and `TASKS_DESKTOP_PORT`
for the port) and then to a search; a value that is set decides, a wrong one
is an error and no quiet fall back. The hub says which source it used.
