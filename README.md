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

## Install from a release

A release on GitHub (a tag `vX.Y.Z`, published by hand after a draft was tried) holds the program for
Windows, Linux and macOS (macOS is built but not tried: the hub's tests with the real engine, the watcher of a
folder task that moves to another area among them, run on Windows and Linux only), `SHA256SUMS`, and the four scripts below. The
scripts need no administrator rights and install for one user, so they also work where a signed
Setup is not allowed. Run them in your own terminal (not elevated, not from inside a program that
sandboxes AppData).

```
sh scripts/install.sh [--version vX.Y.Z] [--autostart] [--shortcut]      # Linux, macOS
.\scripts\install.ps1 [-Version vX.Y.Z] [-Autostart] [-Shortcut]         # Windows PowerShell
```

They download the archive of the release, check it against `SHA256SUMS` (a wrong or missing
checksum installs nothing), and hand over to `tasks-hub install`, which replaces the program in one
step and brings a running hub back. Run the same script again to repair or to update: the
installation that is there is found and replaced, never a second one beside it. `--archive FILE`
(`-Archive`) installs from a file you already have, with `--sums FILE` or `--sha256 HEX`.

```
sh scripts/uninstall.sh [--purge-settings]
.\scripts\uninstall.ps1 [-PurgeSettings]
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

After every green CI run on `main`, the workflow `rolling` builds the program of that commit for Windows and
Linux and puts it on the pre-release [`latest`](https://github.com/StefanBartl/tasks-desktop/releases/tag/latest);
the files are replaced each time. It is not a release (see `release.yml` for that): not signed, not tried by hand.

| File | Use |
| --- | --- |
| `tasks-hub-windows-x86_64.exe` | double click (SmartScreen warns about an unsigned program: "More info", "Run anyway") |
| `tasks-hub-linux-x86_64.tar.gz` | unpack, run `./tasks-hub` |
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
```

What does not depend on tasks (the guard, pairing and sessions, the engine seam, the store, the
watcher, the search, installing, and the security matrix every app's hub must pass) is
[appkit](https://github.com/StefanBartl/appkit), taken by the tag named in `Cargo.toml`
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
priority, who, kind, effort, value and tags in the detail, tick a step of the plan section and add a dated line to the notes (the box of a step shows what the file says; a click asks the engine first),
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
never sorts), shows a task with its steps and its text (as text only),
follows the hub's event stream and asks for a scan when the window gets the
focus back. The numbers of the overview on the Today page (ready, doing, blocked, with value) are buttons: a click opens the tasks behind the number, as a list or cut up by priority, area, plan or (for blocked) the task they wait on, a page of fifty at a time; the key `v` on a number walks the views and the choice is kept for each number. The Vaults menu chooses which vault the hub reads (the list is in `config.json`); Options holds the language, the theme and the settings. Help says what this build is (version, the commit of a rolling build, platform, the version and commit of the engine that answers, and the commits `engine.lock` pins, so that two installations can be told apart) and prepares a problem report out of those words and nothing else: no path, no vault, no name; the form opens in the browser and you send it yourself, the app sends nothing. German and English, light and dark.

#### Order, lists, views, export and moving by drag

- **Order.** The list can be shown in an order of the engine (the choice *Order* in the filter row: plan order, priority then effort, severity, most used, value for effort). The page asks the engine for the ids in that order in one call (`GET /api/tasks/order`) and lays the tasks it holds along them; it never sorts by itself. The choice is kept, and a word the engine refuses puts the plan order back with a message.
- **Lists.** The filter and the order shown can be kept under a name (*Save as list ...*, up to 50 per vault, in this browser only) and brought back from the *Lists* choice (the search words stay); the command palette has an entry for each (`List: <name>`). The lists of the engine (built in, saved with the editor, from its configuration) are offered next to them in a group of their own, read only: applying one lays its option words onto the filter, `readiness` is the page's own *State* choice (ready and decision, or waiting and stuck, as the engine means them) and `quick_win` is the engine's own figure of quick wins (also a filter of its own, *Quick wins only* under *More filters*); the words the page cannot say (`stale`, `blocked`, `unestimated`, an effort no task has) are named in a message instead of being left out in silence.
- **Views.** The tab *Views* (`g v`, the View menu, or `View: <name>` in the palette) shows the open tasks of a saved view in groups by a field: as columns side by side or as a list of sections that fold (with a count each). A view is a file of the vault (`<area>/ROADMAP/views/<slug>.md`), the same on every machine: *New view* makes one with a name, the area it is kept in, the field and the form (and, if you like, the filter of the list as what it selects); the name, the field and the form change in place, a fold is kept in the file, and every change - making and deleting included - can be taken back. A card dragged to another group - or moved with `Shift` and `h` `l` on it - writes the field the view is grouped by, on the version shown: for tags the tag it leaves goes and the one it enters comes (`Ctrl` while dragging keeps the one it leaves); a marked card takes the other marked cards of the view with it, and what the engine refuses is said in its words. The area and the derived fields (readiness) are not moved here. A right click - or the menu key, or `Shift`+`F10` - on a task of the list (its area), an area of the overview, the plan chosen in the Plan view or a group of a view opens *Open as a view*: the same tasks as columns or a list, or grouped by a field. Such a view is one to look with, not saved (nothing is written for a look); *Save as view* makes it a file of the vault. The palette has *View: group the list by ...* for the list as it is filtered. Which fields there are and the values of each are the engine's (`GET /api/tasks/groupings`); the engine writes the file and refuses a view that changed meanwhile.
- **Export.** The Project menu saves the tasks shown, or the marked ones, as a Markdown or CSV file, or copies them to the clipboard. A CSV cell that a spreadsheet would run as a formula gets a quote mark in front; the file starts with a byte order mark and has CR LF rows, and the columns are split at `;` on a German page (a German spreadsheet expects that) and at `,` otherwise. The page may write the clipboard on a click and never read it (`clipboard-write=(self)`, see `docs/SECURITY.md`).
- **Moving by drag.** In the tasks behind a number of the Today page, a row can be dragged onto an area: the other areas show as places to drop, the engine is asked first (a dry run: the new id, how many places follow, a taken name, a change of the data class), and only the confirmation moves the file, under the version that was shown. If the row is one of several marked tasks, they go together. Without a mouse, the key `m` on a task or the button beside it opens the choice of the area. On a touch screen a finger or a pen drags by the grip (the dotted mark) on a row of the panel and on a card of the board; the places count after the finger has gone 24 px, and what the finger lets go over takes the drop (an area, a column, the strip for finishing).

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
whatever `TASKS_DESKTOP_CONFIG_DIR` names) may set `vault`, `vaults` (more
vaults, each a `name` and an absolute `path`: the Vaults menu of the page adds them and
chooses the one that is read), `active` (the name of that one), `nvim`,
`engine_dir`, `lib_dir`, `extra_areas` and `port`. Unknown keys are refused.
Every path falls back to an environment variable (`TASKS_VAULT`,
`TASKS_NVIM`, `TASKS_ENGINE_DIR`, `LIB_NVIM_DIR`, and `TASKS_DESKTOP_PORT`
for the port) and then to a search; a value that is set decides, a wrong one
is an error and no quiet fall back. The hub says which source it used.
