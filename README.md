# tasks-desktop

A local web UI and desktop app for [tasks.nvim](https://github.com/StefanBartl/tasks.nvim):
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
tasks-hub autostart on|off|status     start the hub with your login (Windows)
tasks-hub install [--autostart] [--shortcut]
                                      copy the program to a fixed place (%LOCALAPPDATA%	asks-desktopin),
                                      so a build in the repository does not fight the running hub
                                      for the file; --autostart and --shortcut register that copy
                                      (Windows: registry and desktop link; Linux: an autostart
                                      entry and a launcher; macOS: a launch agent). Build with
                                      `cargo build --release` first: 3.4 MB instead of 5.9 MB.
tasks-hub open [--launch]             print a one-time pairing link for the running hub
                                      (--launch also opens it in the default browser)
tasks-hub usage [--days=14]           on how many of the last days the interface was opened
```

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
`default` an area with no entry is unclassified. See [docs/SECURITY.md](docs/SECURITY.md).

## Layout

```
crates/app-core/    process runner, auth rules, pairing and sessions, hub.json (no task or Tauri knowledge)
crates/tasks-hub/   config, discovery, engine trait and CliEngine, the server, the program (lib + bin)
crates/hub-testkit/ a fake Neovim and the tests that need a process or a socket
e2e/fixture/vault   synthetic vault (no real data), made by tools/make-fixture-vault.lua
docs/SECURITY.md    what the server checks, and what it does not
engine.lock         the tasks.nvim and lib.nvim commits this is built against
ui/                 the browser interface (Svelte 5, Vite, TypeScript)
```

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
engine did all the reckoning and the page only groups it. The interface can create a task (`c`, or the Project menu), change status,
priority and who in the detail, undo that, finish a task after a preview of
what it does, and set a reminder (a date on which a task comes back on the
Today page; also when finishing); the engine makes every change. The interface lists the vault in the engine's own order (it
never sorts), shows a task with its steps and its text (as text only),
follows the hub's event stream and asks for a scan when the window gets the
focus back. German and English, light and dark.

## Build

```
cargo build --locked
cargo test --workspace --locked
```

The tests that talk to the real engine need Neovim >= 0.12, a tasks.nvim and a
lib.nvim checkout (found through `REPOS_DIR`, or `TASKS_ENGINE_DIR` and
`LIB_NVIM_DIR`). Without them they skip; `TASKS_DESKTOP_REQUIRE_ENGINE=1` makes
that a failure, as CI does.

## Settings

`config.json` in the config folder (`%APPDATA%\tasks-desktop` on Windows, or
whatever `TASKS_DESKTOP_CONFIG_DIR` names) may set `vault`, `nvim`,
`engine_dir`, `lib_dir`, `extra_areas` and `port`. Unknown keys are refused.
Every path falls back to an environment variable (`TASKS_VAULT`,
`TASKS_NVIM`, `TASKS_ENGINE_DIR`, `LIB_NVIM_DIR`, and `TASKS_DESKTOP_PORT`
for the port) and then to a search; a value that is set decides, a wrong one
is an error and no quiet fall back. The hub says which source it used.
