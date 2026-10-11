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
crates/app-core/    process, auth, SSE, registry (no task or Tauri knowledge)
crates/tasks-hub/   engine trait, snapshot, queue, watch, routes (lib + bin)
engine.lock         the tasks.nvim commit this is built against
```

The UI (Svelte 5), the Tauri shell and the end-to-end tests are added by the
phases P2 to P7; the plan lives in the maintainer's notes.

## Build

```
cargo build --locked
cargo test --locked
```
