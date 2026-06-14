# 🧠 brain — Engineering Memory OS

> Git stores *what* the code is. **brain** stores *why* it is that way — a persistent,
> git-native reasoning graph (the **Project Brain**) over your codebase, injected into
> Claude Code at reasoning time so the AI stops re-deriving understanding and stops
> undoing intentional design.

This is a working MVP of the system specified in [DESIGN.md](DESIGN.md). Local-first,
git-native, zero documentation toil — the Brain is captured as a *byproduct* of commits
and test failures.

## What it does

- **Indexes** your repo into a symbol/dependency graph with tree-sitter (functions,
  call graph, import edges, components) plus churn / fan-in metrics — no LLM.
- **Learns** from git: a `post-commit` hook turns each commit into a structured
  **Decision** (ADR); test failures become **Bugs** with suspect ranking; recurring or
  severe bugs are promoted into **Constraints** (invariants) and raise a component's
  fragility.
- **Answers "why"** with evidence: every record carries `provenance` (source +
  confidence + evidence), so nothing is a blind assertion.
- **Grounds Claude Code** through three surfaces: an **MCP server** (structured
  read/write tools), an auto-maintained **`CLAUDE.md`** (ambient context), and
  **slash commands** (`/brain-why`, `/brain-fix`, `/brain-fragile`).

## Quickstart

```bash
npm install
npm run build

# from the repo you want a Brain for:
brain init                  # scaffold .brain/, index, install hook, wire up Claude Code
brain backfill --since 90d  # cold-start: seed decisions from git history
brain why src/auth/session.ts
brain query "why redis sessions"
brain fragile
```

Then in Claude Code, the `brain_*` MCP tools and `CLAUDE.md` context are available
automatically. Make a commit → the Brain captures a decision → ask *"why is this
module built this way?"* and get an evidence-cited answer.

## CLI

| Command | What |
|---|---|
| `brain init` | scaffold `.brain/`, index, install `post-commit` hook, write `.mcp.json` + `CLAUDE.md` + slash commands |
| `brain index` | parse repo → symbols / edges / components (deterministic) |
| `brain backfill --since 90d` | replay git history → seed decisions |
| `brain sync [sha]` | commit → Decision (run by the hook) |
| `brain query "<q>"` | FTS + graph search |
| `brain why <path\|symbol>` | decisions / bugs / constraints explaining a target |
| `brain fragile` | ranked fragility report with evidence |
| `brain record-bug --test <id> --message <m>` | capture a Bug from a failing test |
| `brain mcp` | start the MCP server over stdio |
| `brain doctor` | environment diagnostics |

## MCP tool surface

`brain_query`, `brain_why`, `brain_bug_lineage`, `brain_check_constraints`,
`brain_get_dependents` (recursive-CTE blast radius), `brain_record_decision` (write-back).

## Architecture

```
src/
├─ core/         types (Zod schema), ids, paths, glob
├─ store/        JSON source of truth  ←→  SQLite/FTS5 derived index, graph CTEs
├─ extractors/   tree-sitter parse, git introspection, the indexer
├─ synthesis/    pluggable LLM provider (anthropic-sdk | claude-cli | deterministic), write-path
├─ mcp/          MCP stdio server (6 brain_* tools)
├─ integrations/ post-commit hook, CLAUDE.md writer, .mcp.json + slash commands
└─ cli/          commander entrypoint
.brain/          source of truth (committed): components/ edges/ symbols/ decisions/ bugs/ constraints/
                 brain.sqlite is a derived index (gitignored)
```

The JSON under `.brain/` is the **source of truth** (diffable, reviewable, free team
sync via git push/pull). SQLite is a **derived index** rebuilt by `brain index`.

## Notable engineering decisions

These deviate from / pin the stack named in DESIGN.md §7 for verified reproducibility:

- **Native `tree-sitter` (0.21.1) + `tree-sitter-typescript`, not web-tree-sitter.**
  The prebuilt WASM grammars (`tree-sitter-wasms`) have an ABI incompatible with current
  `web-tree-sitter`; the native bindings ship Node-20 prebuilds (no compiler needed) and
  give a simpler synchronous API.
- **`better-sqlite3` pinned to `12.9.0`.** 12.10.x ships **no Node-20 prebuild** and
  would force a source compile (Xcode CLT); 12.9.0 has the Node-20 (ABI 115) prebuild.
- **Pluggable synthesis with a deterministic fallback.** The write path works with an
  Anthropic API key, the `claude` CLI, or neither — the no-LLM fallback emits
  low-confidence advisory drafts so the loop never hard-requires credentials.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test suite (store, graph, parse, indexer, synthesis)
npm run dev -- why src/store/brainStore.ts   # run the CLI via tsx without building
```

## Status

MVP per DESIGN.md §6 / Appendix B. Deferred (per design): embeddings/vector search,
PR webhooks, web dashboard, remote team sync, multi-repo.
