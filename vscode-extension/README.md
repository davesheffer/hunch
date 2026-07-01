# Hunch — VS Code extension

A visualizer and query surface over [Hunch](https://github.com/davesheffer/hunch) (`.hunch/`) for
the open repo. Pairs with the Claude Code chat (which uses the `hunch_*` MCP tools); this gives
you the **human** surface.

> Requires a repo with a `.hunch/` directory — install the CLI with `npm i -g @davesheffer/hunch` and run `hunch init`.

## Features

### Browse
- **Activity-bar tree** — Invariants, Decisions, Bugs, **Bug lineage** (recurrence chains),
  Fragile symbols, Components, and **Stale records**, each with provenance and a `⚠stale` flag
  when a file in scope changed after the record was verified.
- **Component graph** (`Hunch: Component Graph`) — the symbol call-graph rolled up to components;
  node size = symbols owned, color = fragility, link width = cross-component calls, badges = ⛔/🐞.
- **Search** (`Hunch: Search`) — fuzzy-find any decision, invariant, bug, or component.

### In the editor
- **CodeLens** — a per-file summary (⛔ invariants · ⚠ near · 🧭 decisions · 🐞 bugs) plus a mark on
  each function carrying bug/fragility signal.
- **Hover** — bug history and fragility for the symbol under the cursor.
- **Diagnostics** — invariants in scope (and *near*-invariants reached through the blast radius)
  appear in the Problems panel while you edit.
- **Overview-ruler marks** — bug-bearing (red) and fragile (orange) symbols, scannable from the scrollbar.
- **"Why is this file/symbol the way it is?"** — a full brief: decisions, invariants, bug history,
  and blast radius. Plus a **status bar** invariant counter for the active file.

### Grounding
- **Topic-anchored decisions** — a decision can carry an optional `topic` (the drift-detection
  anchor); the pre-edit brief surfaces a file's *current* decision for its topic with
  doc-precedence framing (follow the graph, not a stale doc) plus what that decision **rejected**.
- **doc≠graph drift** — a deterministic `anchor-stale` drift fires when a file is still anchored to a
  **superseded** decision while a current one exists for its topic. Surface it from the CLI with
  `hunch drift` (CI-gateable) or `hunch doctor`; `hunch reconcile-topics` catches the >1-live-per-topic
  case a git merge can introduce, and the scaffolded `/heal` command / `hunch heal` do a read-only
  doc↔graph reconciliation (never rewriting prose silently). This is the doc≠graph spoke — it
  **complements** Architectural Conformance (graph≠code), it doesn't replace it.

### Write back
- **Record Invariant…** / **Record Bug…** delegate to the `hunch` CLI (atomic, validated writes —
  the extension never edits `.hunch/` JSON itself). Set `hunch.cliPath` if the CLI isn't on `PATH`.
  Decisions are recorded from Claude Code chat — either `hunch_record_decision` (now **gated**: a
  store-scoped uniqueness guard refuses a second live decision for the same `topic`, so a topic is
  never silently two) or `hunch_capture_decision`, which returns a one-question-at-a-time grilling
  protocol (also wired as the scaffolded `/capture` slash command).

### Live
- Refreshes automatically when `.hunch/` changes on disk (e.g. after a commit).

The data layer is a pure reader of the committed JSON source of truth — **no native deps, no
server** — and it works as soon as the repo has a `.hunch/` directory (`hunch init`).

## Develop / run
```bash
npm install
npm run build      # -> dist/extension.js
# Press F5 in VS Code (Extension Development Host), or package with `vsce package`.
```

## Settings
- `hunch.statusBar.enabled` (default `true`) — invariant counter for the active file.
- `hunch.codeLens.enabled` (default `true`) — per-file summary + per-symbol bug/fragility CodeLens.
- `hunch.hover.enabled` (default `true`) — bug history / fragility on hover.
- `hunch.diagnostics.enabled` (default `true`) — invariants in the Problems panel.
- `hunch.decorations.enabled` (default `true`) — overview-ruler marks for buggy/fragile symbols.
- `hunch.cliPath` (default `hunch`) — command used for the Record Invariant / Record Bug actions.
