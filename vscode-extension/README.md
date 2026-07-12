# Hunch for VS Code

## See why. Capture what you decide.

Your repo's engineering memory ([Hunch](https://github.com/davesheffer/hunch)), in the editor.
One read surface, one write surface, nothing else:

- **Hunch: Why is this?** — for the file you're in (and the symbol under your cursor): the
  invariants that must not break, the decisions that shaped it (and what they rejected), its bug
  history with root causes, and the blast radius of touching it.
- **Hunch: Capture…** — record a decision, invariant, or bug into the repo's memory in three
  input boxes. Decisions go through the same `hunch mcp` write path Claude Code uses; every
  mutation is delegated — the extension never edits `.hunch/` JSON itself.

- **Hunch: Journey** — one read-only screen that connects you to the process: your memory curve
  rising over real decision timestamps, the return line that moves only when a real gate blocks a
  real mistake, what the repo learned this week, and one suggested next action. The 🧠 status-bar
  count is its front door.

Plus two ambient signals, both quiet until they have something to say:

- **Hover** — bug history and fragility for the symbol under the cursor.
- **Status bar** — how many invariants guard the active file (shield), and the repo's memory
  count (🧠, opens the Journey).

And **Hunch: Search memory** when you need to ask "was this decided before?".

It works with **any** assistant workflow — the same graph serves Claude Code, Cursor, Copilot,
Codex, Windsurf, and human review. Language-model tools (`hunchWhy`, `hunchContext`, `hunchQuery`)
feed VS Code chat agents automatically; you never call them yourself.

> **Get started:** install the CLI with `npm i -g @davesheffer/hunch`, open your repo, then run `hunch init`.

Everything else Hunch does — draft review, drift detection, conformance, stats, the component
graph — lives in the CLI (`hunch review`, `hunch drift`, `hunch stats`, …) and in your assistant
via the `hunch_*` MCP tools. This extension deliberately stays small: if you can't explain it in
one sentence, it isn't in here.

The data layer is a pure reader of the committed JSON source of truth — **no native deps, no
server** — and it works as soon as the repo has a `.hunch/` directory (`hunch init`). It refreshes
automatically when `.hunch/` (or the configured private overlay) changes on disk; private overlay
memory is visible only in your local editor and is never committed by this extension.

## Develop / run
```bash
npm install
npm run build      # -> dist/extension.js
# Press F5 in VS Code (Extension Development Host), or package with `vsce package`.
```

## Settings
- `hunch.statusBar.enabled` (default `true`) — invariant counter for the active file.
- `hunch.hover.enabled` (default `true`) — bug history / fragility on hover.
- `hunch.cliPath` (default `hunch`) — command used for Capture (set an absolute path if `hunch` is not on `PATH`).
