# Hunch — VS Code extension

A read-only visualizer over [Hunch](../README.md) (`.hunch/`) for the
open repo. Pairs with the Claude Code chat (which uses the `hunch_*` MCP tools); this gives
you the **human** surface.

## Features
- **Activity-bar tree** — Invariants, Decisions, Bugs, Fragile symbols, Components, each with
  provenance + a `⚠stale` flag when a file in scope changed after the record was verified.
- **"Why is this file the way it is?"** (editor title bar / palette / status bar) — opens a brief
  of the decisions, invariants, bug history, and blast radius for the active file.
- **Context brief** — the minimal relevant slice for a task on the current file.
- **Status bar** — `🛡 N invariants` for the active file (⚠ if any are blocking); click → Why.
- **Live** — refreshes automatically when `.hunch/` changes on disk (e.g. after a commit).

It is a pure reader of the committed JSON source of truth — **no native deps, no server**, and
it works as soon as the repo has a `.hunch/` directory (`hunch init`).

## Develop / run
```bash
npm install
npm run build      # -> dist/extension.js
# Press F5 in VS Code (Extension Development Host), or package with `vsce package`.
```

## Settings
- `hunch.statusBar.enabled` (default `true`) — show the invariant counter for the active file.
