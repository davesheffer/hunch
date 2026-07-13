# Hunch for VS Code

## Your repo's memory, running itself — visible, reversible, one click when it matters.

Your repo's engineering memory ([Hunch](https://github.com/davesheffer/hunch)), in the editor.
Memory is captured, committed, and repaired automatically in the background; this extension is
where you *see* it and where the few decisions that genuinely need a human get asked.

### 🧠 Hunch Memory — the panel (activity bar)

A source-control-style view of everything Hunch does:

- **⚖ Needs your decision** — the inline escalations: a topic conflict, a candidate rule awaiting
  review, a proposed rule carrying its proof ("activate or reject?"), a rule auto-repaired after a
  rename ("re-prove it?"). Questions, never queues — the group only exists while something real
  needs you.
- **🏛 Constitution** — every policy with its state, severity, and authority. Click a rule for its
  deterministic proof card. Proposed rules carry the one-click **vouch** ("Activate rule…" —
  advisory or blocking, your username recorded as the authority); active rules carry audited
  **Demote / Withdraw / Retire**. The full authority lifecycle, one explicit human click per
  transition.
- **Memory timeline** — every move Hunch made: ✚ capture, ✓ adopt, ↻ supersede, ✗ prune,
  🔧 repair. Click a move for its diff; right-click to revert it locally (never pushed).
- **Title actions** — 🛡 Strictness (advisory ↔ strict gate), Sync now, Adopt drafts, and
  **Approve-to-push**: memory auto-commits locally; publishing it to your remote is deliberately
  your click.

### Read & write, one command each

- **Hunch: Why is this?** — for the file (and symbol under your cursor): the invariants that must
  not break, the decisions that shaped it (and what they rejected), bug history with root causes,
  and blast radius.
- **Hunch: Capture…** — record a decision, invariant, or bug in three input boxes. Every mutation
  is delegated to the `hunch` CLI/MCP write path — the extension never edits `.hunch/` JSON itself.
- **Hunch: Journey** — one read-only screen: your memory curve rising over real timestamps, the
  return line that moves only when a real gate blocks a real mistake, and one suggested next action.
- **Hunch: Search memory** — "was this decided before?"

Plus two ambient signals, both quiet until they have something to say: **hover** (bug history and
fragility for the symbol under the cursor) and the **status bar** (invariants guarding the active
file, and the 🧠 memory count that opens the Journey).

### How it stays trustworthy

- Memory **auto-trusts** on capture (advisory immediately, in every assistant's context) — but
  nothing gains *blocking* power without your explicit click, and blocking demands a P3 proof.
- Renames **self-repair** the graph in the background as revertable timeline moves; anything
  ambiguous is simply left for drift detection rather than guessed.
- The panel's spawn seam is **conformance-certified**: it returns byte-identical policy receipts
  to the CLI, MCP, and CI in an executable fixture — same verdict everywhere.
- Works with **any** assistant: the same graph serves Claude Code, Cursor, Copilot, Codex,
  Windsurf, and human review. Language-model tools (`hunchWhy`, `hunchContext`, `hunchQuery`) feed
  VS Code chat agents automatically.

> **Get started:** `npm i -g @davesheffer/hunch`, open your repo, run `hunch init`.

The data layer is a pure reader of the committed JSON source of truth — **no native deps, no
server**. It refreshes automatically when `.hunch/` (or the configured private overlay) changes on
disk; private overlay memory is visible only in your local editor and is never committed or pushed
by this extension.

## Develop / run
```bash
npm install
npm run build      # -> dist/extension.js
# Press F5 in VS Code (Extension Development Host), or package with `vsce package`.
```

## Settings
- `hunch.statusBar.enabled` (default `true`) — invariant counter for the active file.
- `hunch.hover.enabled` (default `true`) — bug history / fragility on hover.
- `hunch.cliPath` (default `hunch`) — command used for every delegated action (set an absolute path if `hunch` is not on `PATH`).
