# 🧠 Hunch — Engineering Memory OS

> Git stores *what* the code is. **Hunch** stores ***why*** it is that way — a persistent,
> git-native reasoning graph over your codebase, surfaced to Claude Code at reasoning time
> so the AI stops re-deriving understanding and stops undoing intentional design.

## The problem

Every AI coding session starts from zero. The model re-reads your code, re-guesses the
intent, and happily "fixes" the thing you deliberately did last month — because the
*reasoning* behind the code lives in PRs, Slack, and people's heads, not in the repo.

**Hunch** captures that reasoning as a **byproduct of normal work** — commits and test
failures — stores it as a git-tracked graph next to your code, and feeds it back to
Claude Code so every session is grounded in the decisions, bugs, and invariants that
came before. Local-first, no documentation toil, no SaaS.

## How it works

```
   commit / test failure              .hunch/  (git-tracked JSON)            Claude Code
 ┌───────────────────────┐         ┌──────────────────────────┐         ┌──────────────┐
 │ post-commit hook   ───┼────────▶│ Decisions  (why a change) │────────▶│ MCP tools     │
 │ record-bug         ───┼────────▶│ Bugs       (root causes)  │  read   │ /hunch-* cmds │
 │ structured diff +     │  write  │ Constraints(invariants)   │◀────────│ CLAUDE.md     │
 │ Claude (or heuristic) │         │ Components / Symbols/Edges │         │ CLI           │
 └───────────────────────┘         └──────────────────────────┘         └──────────────┘
```

- **Index** (no LLM): tree-sitter parses your repo into a symbol/dependency graph —
  functions, call edges, imports, components — plus churn and fan-in metrics.
- **Learn**: each commit becomes a structured **Decision** (an ADR); a failing test
  becomes a **Bug** with a ranked suspect list; recurring or severe bugs are promoted
  into **Constraints** (do-not-break invariants) and raise a component's *fragility*.
- **Ground**: Claude Code reads it through an **MCP server**, an auto-maintained
  **`CLAUDE.md`**, and **slash commands** — every answer cites `provenance`
  (source + confidence + evidence), so nothing is a blind assertion.

## Getting started

### 1. Install it

```bash
npm install -g @davesheffer/hunch   # puts `hunch` on your PATH
```

Or run from source (for hacking on Hunch itself):

```bash
npm install
npm run build                  # compiles to dist/
npm link                       # optional: puts a global `hunch` on your PATH
```

Either way you then type `hunch …`. From a source checkout without `npm link`, use
`node dist/cli/index.js …` (or `npm run hunch -- …` to run via tsx). The rest of this
README uses `hunch` for brevity.

### 2. (Recommended) make a coding-assistant CLI available

Hunch's LLM synthesis is billed to **your subscription** through a coding-assistant
CLI — **never** a pay-per-token API key (the API key is stripped from the child env).
Hunch auto-detects the first one present, in this order:

| CLI | Subscription | Detected by |
|---|---|---|
| `claude` (Claude Code) | Claude Pro/Max | `claude --version` |
| `codex` (OpenAI Codex) | ChatGPT Plus/Pro | `codex --version` |
| `cursor-agent` (Cursor) | Cursor | `cursor-agent --version` |

If none is installed, Hunch still works using a deterministic structural heuristic
(lower-confidence drafts). `hunch doctor` tells you which mode you're in; force one
with `HUNCH_SYNTH_PROVIDER=claude-cli|codex-cli|cursor-agent|deterministic`.

### 3. Initialize the repo you want a memory for

```bash
hunch init                  # scaffold .hunch/, index, install the post-commit hook,
                            # write .mcp.json + slash commands + CLAUDE.md, register the merge driver
hunch backfill --since 90d  # cold start: seed decisions from recent git history
```

`init` writes a `.mcp.json` pointing at *this machine's* node + Hunch — so **reload
Claude Code in the repo** afterward to pick up the `hunch_*` tools. (Each teammate runs
`hunch init` once to wire up their own clone; the captured `.hunch/` content is shared
via git.)

> **Prefer `hunch init` (project-local `.mcp.json`) over a global `claude mcp add`.**
> `.mcp.json` is registered by file path, so it's robust. A global `claude mcp add`
> writes to `~/.claude.json` keyed by the raw working-directory string — and **on
> Windows** that's a trap: drive letters are case-insensitive (`c:\` and `C:\` are the
> same folder) but Claude Code compares the key case-sensitively, so it can create two
> project blocks for one directory and a session that resolves to the *other* casing
> sees no `hunch_*` tools (registration looked fine, the tools just aren't there). If
> you hit this, run **`hunch doctor`** — on Windows it detects the split and heals it
> (merging the MCP servers across both casings, after backing up `~/.claude.json`).
> `hunch init` runs the same heal automatically at the end.

### 4. Use it

```bash
hunch why src/auth/session.ts     # the decisions / bugs / invariants behind a file
hunch doctor                      # check git, schema version, and synthesis mode
```

…and in Claude Code, just ask: *"why is the session module built this way?"*

## Two ways to use it

**Through Claude Code (the point).** Once the MCP server is registered, ask questions
normally and Claude consults Hunch, or invoke the slash commands:

| Slash command | What it does |
|---|---|
| `/hunch-why <file\|symbol>` | the decisions, invariants, and bug history behind it — with citations |
| `/hunch-fix <bug>` | fix a bug grounded in past root causes, blast radius, and constraints |
| `/hunch-fragile` | a fragility report (the riskiest code, with evidence) |

The MCP tools Claude calls under the hood: `hunch_why`, `hunch_query`,
`hunch_check_constraints`, `hunch_get_dependents` (blast radius), `hunch_blast_radius`
(dependent files + near-violations a change could break indirectly), `hunch_bug_lineage`,
`hunch_context` (surgical minimal slice for a task), `hunch_timeline` (a target's decision
history over time), `hunch_merge_verdict` (a cited BLOCK/WARN/PASS over a diff — see below),
and the write-backs `hunch_record_decision`, `hunch_record_correction` (turn a correction into
an enforced invariant — see below). `hunch_why` and `hunch_context` take an optional `as_of`
(commit/tag/branch) to **time-travel** the graph to a past state.

### Works with any MCP assistant

The Hunch MCP server is **client-agnostic** — one `.hunch/` graph powers every
assistant. `hunch init` scaffolds each tool's MCP config + ambient grounding so
they all consult the same memory:

| Assistant | MCP config | Grounding file |
|---|---|---|
| Claude Code | `.mcp.json` | `CLAUDE.md` + `/hunch-*` slash commands |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/hunch.mdc` (always-applied) |
| VS Code (Copilot) | `.vscode/mcp.json` | `.github/copilot-instructions.md` |
| Codex CLI | `.codex/config.toml` | `AGENTS.md` |
| Windsurf | `.windsurf/mcp_config.json` | `.windsurf/rules/hunch.md` (always-on) |
| Anything else | — | `AGENTS.md` (cross-tool standard) |

Each writer **merges** into existing files (other MCP servers and your own prose are
preserved) and is idempotent. Opt out with `hunch init --no-providers`.

**Through the CLI** — the same graph, from your terminal:

| Command | What |
|---|---|
| `hunch init` | scaffold `.hunch/`, index, install hook + merge driver, auto-install the advisory pre-commit guard, install the **Claude Code agent hooks**, and wire up **every assistant** (Claude Code, Cursor, VS Code/Copilot, Codex, Windsurf, AGENTS.md). Flags: `--no-enforce`, `--enforce-strict`, `--no-providers`, `--no-agent-hooks`, `--firmness <level>` |
| `hunch index` | parse repo → symbols / edges / components (deterministic, no LLM) |
| `hunch backfill --since 90d` | replay git history → seed decisions |
| `hunch sync [sha]` | turn a commit into a Decision (run automatically by the hook) |
| `hunch record-bug --test <id> --message <m>` | capture a Bug from a failing test |
| `hunch record-constraint "<statement>" [--scope <globs>] [--severity advisory\|warning\|blocking] [--type …] [--rationale <t>] [--source-decision <id>]` | record an invariant the code must not break (what `hunch check` + the strict agent hook enforce) |
| `hunch firmness [off\|advisory\|firm\|strict]` | get/set how firmly the agent hook enforces Hunch before edits (no arg prints the current level) |
| `hunch test [cmd…]` | run the suite (default `npm test`); auto-capture failures as Bugs (suspects + recurrence→Constraints), mark passing tests' bugs fixed |
| `hunch why <path\|symbol> [--as-of <ref>]` | decisions / bugs / constraints explaining a target (flags `⚠STALE`); `--as-of` time-travels to what was believed at a commit/tag/branch |
| `hunch timeline <path\|symbol>` | the decision history for a target — what was believed, its valid-time window, and what superseded it |
| `hunch supersede <old> --by <new>` | mark one decision as replaced by another: closes the old one's valid-time window (invalidate, don't delete) |
| `hunch query "<q>" [--semantic]` | full-text + graph search (`--semantic` blends in local embeddings) |
| `hunch embed` | generate local embeddings for semantic recall (opt-in; needs `@huggingface/transformers`) |
| `hunch context <path\|symbol> [--as-of <ref>]` | minimal relevant slice for a task: invariants → decisions → bugs → blast radius (`--as-of` time-travels) |
| `hunch fragile` | ranked fragility report with evidence |
| `hunch check [--staged\|--commit <sha>\|--base <ref>] [--strict] [--format text\|markdown] [--blast]` | guardrail: flag changes touching a do-not-break invariant **directly or via blast radius** (a guarded file that depends on what you changed), **and changes that re-introduce something a decision deliberately retired** (the Regression Guard). `--base <ref>` checks a PR's diff (for CI); `--format markdown` emits a PR comment; `--strict` fails only on a direct, high-confidence, non-stale **blocking** invariant; `--blast` prints the dependency fan-out |
| `hunch ci` | scaffold the **CI Constraint Guard** — a GitHub Action that runs `hunch check` on every PR, comments the affected invariants/decisions, and fails on a blocking one |
| `hunch stale [--resync]` | drift: records whose files changed after last verification (`--resync` regenerates stale decisions from their commits) |
| `hunch review [--accept <id>\|--reject <id>]` | curate: triage / promote / drop low-confidence drafts |
| `hunch migrate` | upgrade `.hunch/` records to the current schema version |
| `hunch compact [--apply]` | prune low-value drafts to bound growth (dry-run by default) |
| `hunch doctor` | environment diagnostics (git, auth mode, schema version, counts) |
| `hunch mcp` | start the MCP server over stdio (Claude Code connects here) |

## Grounding the agent automatically (firmness)

Telling an assistant "consult Hunch first" in a prompt is advisory — it drifts. `hunch
init` instead installs two **Claude Code agent hooks** (in `.claude/settings.json`) so the
grounding is enforced by the harness, not by the model's memory:

- **Before every edit** (`PreToolUse` on `Edit`/`Write`/`MultiEdit`) Hunch injects the
  relevant slice for the file being touched — its decisions, invariants, bug history, and
  blast radius — straight into the model's context.
- **On every prompt** (`UserPromptSubmit`) it reminds the agent to query Hunch.

How hard it pushes is one committed knob — set it once, it applies to the whole team:

```bash
hunch firmness            # print the current level
hunch firmness strict     # change it (takes effect on the next edit; no restart)
```

| Level | Before an edit |
|---|---|
| `off` | nothing (hook is a no-op) |
| `advisory` *(default)* | inject the relevant Hunch slice as context |
| `firm` | advisory **+** explicitly flag invariants in the file's scope |
| `strict` | firm **+** **deny** an edit that hits a *blocking* invariant (directly or via blast radius), feeding the invariant back as the refusal reason |

Before an edit, the hook also grounds the agent in anything an in-force decision
**deliberately retired** from that file ("don't re-introduce `login` here — dec_017 removed
it"). The actual gate is at commit time: `hunch check` runs the **Regression Guard** over
the staged diff and, under `--strict`, fails the commit when a change re-adds a retired
symbol/dependency tied to a blocking invariant (otherwise it warns).

The hook never breaks your flow: any error or unrecognized input emits nothing and exits
0, and it stays silent on files Hunch hasn't learned yet. `strict` only bites once you have
**blocking** constraints recorded (`hunch record-constraint … --severity blocking`) — with
none, every level degrades to context-only. Opt out of the hooks entirely with `hunch init
--no-agent-hooks`.

## Never Twice: corrections become enforced invariants

The most expensive failure in AI coding is being corrected and then *re-corrected* — you
tell the agent "no, never call the pay-per-token API here," it complies once, and next
session it does it again because the feedback was stored as advisory text, not enforced.

Hunch closes that loop. When you correct the agent, it captures the rule as a **first-class
Constraint** (provenance `human_confirmed`) via the `hunch_record_correction` MCP tool — and
from then on the **same pre-edit hook + CI Constraint Guard** hold *every* assistant to it:

```text
You:   "no — never import lodash, we ship our own utils"
Agent: calls hunch_record_correction({ rule: "never import lodash; use src/utils",
                                       scope_hint_file: "src/cart.ts", severity: "blocking" })
→ con_… recorded. A later edit that adds `import _ from "lodash"` to that scope is DENIED
  (strict firmness) and the PR fails CI — in Cursor, Copilot, Windsurf, or Claude Code alike.
```

The `UserPromptSubmit` hook nudges the agent to persist a rule whenever your prompt reads
like a correction ("no…", "that's wrong", "never do X"), so capture is one frictionless step
rather than a discipline. Scoping is conservative by default (the file you were in); a
repo-wide (`**`) rule is only blocking when you pass `applies_to_all`, so one correction
can't silently gate the whole tree. Because it's the *same* constraint machinery, a
correction is enforced exactly like a hand-authored invariant — see firmness above.

## Causal Merge Verdict: does this change re-open a closed bug?

A diff-only reviewer (CodeRabbit, Greptile) sees *what* changed. It can't see that the line
you're deleting is the fix for an incident, or that the symbol you're re-adding was
deliberately retired. Hunch can — because it holds the **why**.

`hunch_merge_verdict` (MCP tool) and `hunch check` replay a diff against the graph and return
one verdict — **BLOCK / WARN / PASS** — that *cites the reasoning*, not just the rule:

```text
VERDICT: ⛔ BLOCK — this change breaks a recorded invariant or re-opens a known bug.

⛔ pay() must verify the session before charging — con_pay
   🧠 why: "Charge must verify the session first" (dec_pay)
   🐞 guards against: Double-charge on unverified session — pay() charged without verifying (bug_trunc)
```

It's **deterministic** (no LLM): for every invariant *directly* in scope it walks
constraint → `source_decision` → the bug whose root cause spawned it; it flags invariants
reached transitively (blast radius, advisory) and any deliberately-retired code the diff
re-introduces. BLOCK fires only on a direct, high-confidence, non-stale **blocking** invariant
or a blocking-linked regression — near-hits stay advisory, so it's safe as a merge gate. Call
it before opening a PR (`{}` checks staged changes; pass `base: "origin/main"` for the range);
the CI Constraint Guard renders the same cited verdict as a PR comment.

## Semantic search (optional)

By default `hunch query` and the `hunch_query` MCP tool use fast keyword (FTS) search —
zero setup, instant, offline. For recall on *paraphrases* (a question that shares no words
with the record it should find), opt into **local embeddings**:

```bash
npm i -g @huggingface/transformers              # one-time; a local model runtime
hunch embed                                     # embed your records (first run downloads ~90MB)
hunch query --semantic "auth token expiry"      # hybrid keyword + semantic recall
```

> **Install it where `hunch` runs.** The runtime is resolved from `hunch`'s own
> `node_modules`, so match the install scope: a globally-installed `hunch` needs the
> global (`-g`) install above; running from a source checkout needs it in the repo
> (`npm i @huggingface/transformers` there). If `hunch embed` reports the model "present
> but failed to load," the scopes don't match. `hunch doctor` shows the active mode.

Embeddings are **local and free** (no API — consistent with the subscription-only synthesis
rule) and **opt-in** (the base install stays lean). The long-lived MCP server picks them up
automatically once present. Vectors live in the derived SQLite index and are reconciled by
content hash on every `hunch index`, so they never drift from the JSON source of truth. `hunch
doctor` reports coverage; tune the blend with `HUNCH_RRF_W_FTS` / `HUNCH_RRF_W_SEM` / `HUNCH_RRF_K`.

## What makes the capture good (not just "changed N files")

Even with **no LLM**, the write path runs a structured **diff analysis** — added /
removed / changed symbols, new and dropped dependencies, and which invariants a change
touches — so an auto-captured decision reads like *"introduced `verifySession`,
`revokeSession`; removed `login`; new dep: redis; touches con_004"*, with breaking-change
consequences. With the `claude` CLI present it upgrades to full LLM synthesis; otherwise
it stays useful offline. Either way every record is **advisory and cheap to discard** —
`hunch review` lets you promote the good ones to human-confirmed.

## Working as a team

The `.hunch/` JSON is the **source of truth**: diffable, reviewable in PRs, and synced
for free over `git push` / `pull`. `hunch init` also registers a **git merge driver** so
concurrent edits to the graph merge **by record id** instead of throwing conflict markers
(human-confirmed beats auto, then higher confidence, then recency). The routing lives in a
committed `.gitattributes`; the per-clone driver definition is set up by each teammate's
`hunch init`. The graph is **OS-agnostic**: paths are stored and matched in POSIX form, and
an installed Hunch registers its MCP server by package name (`npx -y @davesheffer/hunch`)
rather than an absolute path — so a teammate on Windows, macOS, or Linux shares the same
`.hunch/` and the same committed config without per-machine fixups.

## Continuous learning (CI)

The decision half of the loop is automatic (the post-commit hook). Light up the **bug /
constraint half** by wrapping your test run with `hunch test`:

```bash
hunch test                       # runs `npm test`; capture failures → Bugs, resolve fixed ones
hunch test -- pytest -q          # any runner: pass the command after `--`
```

It parses TAP and the `node:test` spec reporter, captures each failing test as a **Bug**
(ranked suspects; a recurrence or substantiated high-severity failure auto-promotes a
do-not-break **Constraint**), and marks a previously-open bug **fixed** once its test passes
again. It preserves the runner's exit code, so it's a drop-in CI step:

```yaml
# .github/workflows/ci.yml
- run: npm ci
- run: npx hunch test            # exits non-zero on failure, just like the suite
- run: |                         # persist what was learned (optional)
    git add .hunch && git commit -m "chore(hunch): capture test run" || true
    git push || true
```

Repair drift after refactors with **`hunch stale --resync`** (re-synthesizes stale decisions
from their commits via the LLM).

### Block a PR that breaks memory (CI Constraint Guard)

Memory that only *advises* gets ignored. `hunch ci` scaffolds a GitHub Action that turns
Hunch into a **merge gate**: on every pull request it runs `hunch check` over the diff,
posts a sticky comment citing the affected `con_`/`dec_` ids, and **fails the check** when
the PR breaks a *direct, high-confidence, non-stale* blocking invariant, re-adds
deliberately-retired code, or contradicts an in-force decision.

```bash
hunch ci          # writes .github/workflows/hunch-guard.yml — commit it
```

It reasons over **the diff plus the constraints committed in the same git history**, so the
comment says exactly which decision a change violates ("breaks `con_004` — server-side
revocation, from `dec_017`"). Make *Hunch Guard* a required status check in branch protection
to enforce on merge. The hardened strict gate only blocks on high-confidence, non-stale
invariants — stale / low-confidence / blast-radius hits stay advisory in the comment — so
it's safe to require on a shared repo. Under the hood it's just
`hunch check --base origin/<target> --strict --format markdown`.

## Maintenance

- **`hunch doctor`** — is git healthy? are you on the subscription path or the offline
  heuristic? what schema version is on disk? how many records?
- **`hunch migrate`** — after upgrading Hunch, bring old `.hunch/` records up to the
  current schema (old records are migrated in memory on every read, so reads never break;
  `migrate` persists the upgrade and never drops a record it can't migrate).
- **`hunch compact --apply`** — auto-captured drafts accumulate; compaction prunes the
  low-value ones (rejected / superseded / stale drafts, resolved low-confidence bugs).
  It **never** removes an accepted/human-confirmed decision, an open bug, a constraint, or
  any record another record still references. Run without `--apply` first to preview.

## Where it's stored

```
.hunch/
├─ components/   one JSON file per architecture node      (curated, PR-reviewable)
├─ decisions/   one JSON file per Decision (ADR)
├─ bugs/        one JSON file per Bug
├─ constraints/ one JSON file per Constraint (invariant)
├─ symbols/index.json   the symbol graph   (high-cardinality, single file)
├─ edges/index.json     the dependency graph
├─ manifest.json        on-disk schema version
└─ hunch.sqlite         DERIVED FTS5 + graph index, rebuilt by `hunch index` (gitignored)
```

Low-volume entities are one file per record so they read cleanly in a PR; the
high-cardinality symbol/edge graphs are single id-sorted arrays to keep git noise down.
SQLite is a throwaway index rebuilt from the JSON — only the JSON is committed.

> Note: the on-disk directory is still `.hunch/` (and the MCP tools are still `hunch_*`)
> for backward compatibility with existing graphs. A future release may migrate these to
> `.hunch/` / `hunch_*`.

## Architecture

```
src/
├─ core/         types (Zod schema), ids, paths, glob, schema migration, atomic file I/O
├─ store/        JSON source of truth ←→ SQLite/FTS5 derived index; merge driver; compaction
├─ extractors/   tree-sitter parse, git introspection, the indexer
├─ synthesis/    write path: Claude-CLI (subscription) or deterministic fallback
├─ mcp/          MCP stdio server (the hunch_* tools)
├─ integrations/ post-commit hook, CLAUDE.md writer, .mcp.json + slash commands, merge driver
└─ cli/          commander entrypoint
```

## VS Code

A companion **[VS Code extension](vscode-extension/)** (on
[Open VSX](https://open-vsx.org/extension/davesheffer/hunch-vscode) — works in
VS Code / Cursor / Windsurf / VSCodium) brings the graph into the editor: a tree of
decisions / invariants / bugs / **bug-lineage** / fragility / **stale records**, a
**CodeLens** summary + per-symbol bug/fragility marks, **hover** with bug history,
invariants surfaced in the **Problems panel**, overview-ruler hotspot marks, an
interactive **component graph**, fuzzy **search**, and a status-bar invariant counter.
It reads the committed `.hunch/` JSON directly (no server, no native deps); writes
delegate to the `hunch` CLI.

## Notable engineering decisions

- **Subscription-billed synthesis, never the API.** The write path drives your Claude
  subscription via the `claude` CLI; `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are
  stripped from the child env to force subscription auth (they outrank it in headless
  mode). A deterministic, no-LLM fallback means the loop never hard-requires credentials.
- **Native `tree-sitter` (0.21.1) + `tree-sitter-typescript`, not web-tree-sitter.** The
  prebuilt WASM grammars have an ABI incompatible with current `web-tree-sitter`; the
  native bindings ship Node-20 prebuilds (no compiler) and a simpler synchronous API.
- **`better-sqlite3` pinned to `12.9.0`** — 12.10.x ships no Node-20 prebuild and would
  force a source compile; 12.9.0 has the Node-20 (ABI 115) prebuild.
- **Atomic, durable writes.** All `.hunch/` writes go through a temp-file + rename, with a
  Windows-safe fallback, so an interrupted write can't truncate the index; `put`/`delete`
  refuse to rewrite a corrupt index rather than flatten it.
- **OS-agnostic by construction.** Git emits `/`-separated paths on every platform, so the
  graph is the source of truth in POSIX form; any free-form target is canonicalized before
  comparison, so `src\auth\x.ts` and `src/auth/x.ts` resolve to the same records. Generated
  configs that get committed reference Hunch by package name, never a machine-local path.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test suite (store, graph, parse, indexer, synthesis, migrate, merge, compact)
npm run hunch -- why src/store/hunchStore.ts   # run the CLI from source via tsx, no build
```

See [DESIGN.md](DESIGN.md) for the full spec. PR/CI enforcement now ships as the
**CI Constraint Guard** (`hunch ci`). Still deferred by design: a hosted web dashboard
and multi-repo support.
