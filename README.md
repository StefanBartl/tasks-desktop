# tasks-desktop

A local web UI and desktop app for [tasks.nvim](https://github.com/StefanBartl/tasks.nvim):
see the vault at a glance, create and move tasks, plans and a dashboard,
in the browser first and later as a small native app.

**Status: pre-alpha, P2 (hub core and read-only UI) in progress.** Nothing here is
released yet.

## Principles

- **The engine is the only writer.** The hub never parses or formats
  frontmatter; it talks to tasks.nvim through the versioned documents
  `tasks-export/1` (read) and `tasks-ops/1` (write).
- **Loopback only, token always.** Host and Origin are checked, there is no
  data endpoint without a session.
- **Data classes fail closed.** An area without an entry in the per-device
  `areas.json` is treated as not released.
- tasks.nvim stays a pure Lua plugin. This repository holds the hub, the UI
  and the native shell.

## Layout

```
crates/app-core/    process runner, later auth, SSE, registry (no task or Tauri knowledge)
crates/tasks-hub/   config, discovery, engine trait and CliEngine (lib + bin)
crates/hub-testkit/ a fake Neovim and the tests that need a process
e2e/fixture/vault   synthetic vault (no real data), made by tools/make-fixture-vault.lua
engine.lock         the tasks.nvim commit this is built against
```

The UI (Svelte 5), the Tauri shell and the end-to-end tests are added by the
phases P2 to P7; the plan lives in the maintainer's notes.

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

`config.json` in the config folder (`%APPDATA%	asks-desktop`, or
`TASKS_DESKTOP_CONFIG_DIR`) may set `vault`, `nvim`, `engine_dir`, `lib_dir`
and `extra_areas`. Unknown keys are refused. Every value falls back to an
environment variable (`TASKS_VAULT`, `TASKS_NVIM`, `TASKS_ENGINE_DIR`,
`LIB_NVIM_DIR`) and then to a search; the hub says which one it used.
