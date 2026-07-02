# Competitive landscape — where Hunch stands (July 2026)

> Deep-research sweep, 21 primary/secondary sources, 100 extracted claims, 25 adversarially
> verified (3 refutation votes each; 21 confirmed, 4 killed). Every claim below is cited.
> **Caveat:** Graphify ships weekly — the "advisory-only / no decision-capture" findings are
> a snapshot and could be invalidated by a single release. The agent-memory quadrant
> (Mem0, Zep/Graphiti, Letta, Cognee) and the classic architecture-governance quadrant
> (ArchUnit, dependency-cruiser, Nx, CodeScene) were not deeply profiled — "no competitor
> does X" is scoped to the tools actually verified.

## TL;DR

Hunch's defensible position is a **combination no verified competitor ships**: captured
decisions *with rejected alternatives* + **deterministic, gateable enforcement** of that
recorded intent + **doc≠graph drift detection** + git-native **private/shared team overlays**.
Every single element is contested *somewhere*, but nobody bundles them.

The landscape splits cleanly:

- **Graphify** (75K★ in ~3 months, YC S26) owns *derived code structure* — but captures no
  decisions and **enforces nothing**.
- The entire **assistant-native memory** layer (Cline Memory Bank, Windsurf Memories,
  AGENTS.md) plus agent-memory tools like **ByteRover** are **advisory-only**.
- The one **deterministic-enforcement peer**, **Mneme HQ**, validates the category — but is a
  ~16★, single-dev, hand-authored, keyword-level, no-team-sync project.

**What Hunch needs is distribution and positioning, not features.** Copy Graphify's
skill-format / one-command multi-assistant install; interoperate with the 60K+-repo AGENTS.md
surface (ground it, drift-check it — it's the stale-doc attack surface vendors themselves
punt to); and lead with **"memory that gates, not just recalls."**

## Landscape

| Tool | Category | License / distribution | MCP | Git-native memory | Enforces? | Team sync | Captures *why*? |
|---|---|---|---|---|---|---|---|
| **Hunch** | Engineering memory + conformance | MIT, npm | ✅ client-agnostic | ✅ JSON source of truth | ✅ **blocking** (pre-edit, CI, `conform --strict`, veto) | ✅ private + shared overlay, semantic merge | ✅ grilled ADRs + rejected alts |
| **Graphify** | Derived code knowledge graph | MIT, ~75K★, YC S26 | ✅ read-only (`query_graph`, `get_pr_impact`, …) | ✅ committed `graphify-out/` + union-merge driver | ❌ advisory (`test_never_blocks`) | ✅ git-native + HTTP team server | ⚠️ only *harvests* existing `# WHY:`/docstrings |
| **Mneme HQ** | ADR governance for AI | MIT, ~16★, PyPI | ✅ (pre-edit hook) | ✅ `.mneme/project_memory.json` | ✅ **blocking** (`check --mode strict`, exit codes) | ❌ "Layer 2… deferred" | ⚠️ hand-authored ADRs, no capture/synthesis |
| **ByteRover (brv)** | Coding-agent memory layer | Elastic License 2.0 | ✅ 22+ agents | ⚠️ git-*like* tree, cloud sync | ❌ advisory | ✅ branch/commit/merge via cloud | ⚠️ curated context, no decision schema |
| **Cline Memory Bank** | Assistant memory pattern | prompt convention | — | ✅ repo-local markdown | ❌ advisory prompt | ✅ git-shareable prose | ⚠️ freeform prose |
| **Windsurf Cascade Memories** | Assistant auto-memory | proprietary | — | ❌ per-machine `~/.codeium/` | ❌ advisory | ❌ **not committed, not shared** | auto, conversation-level |
| **AGENTS.md** | Instruction standard | open standard, 60K+ repos | — | ✅ committed markdown | ❌ schema-less prose | ✅ committed | ⚠️ freeform |
| **Sourcegraph Enterprise** | Code context/search | commercial | ✅ Enterprise MCP | ❌ server-side index | ❌ search, not gating | ✅ enterprise | ❌ code nav, not decisions |

## Where Hunch is genuinely unique

1. **Deterministic enforcement of *recorded intent*** — blocking pre-edit hook + CI Constraint
   Guard + `hunch conform --strict` + veto tripwires. Absent from *every* mainstream competitor
   verified (Graphify's hook is advisory by test assertion `test_never_blocks`; ByteRover, Cline
   Memory Bank, AGENTS.md have no gate). The *only* peer is Mneme HQ — 16 stars, keyword-level,
   no team sync.
2. **Doc≠graph drift detection** — deterministic, CI-gateable `anchor-stale` drift (a file still
   anchored to a *superseded* decision while a current one exists). Graphify shipped a *read-only*
   staleness hint ("code changed — re-verify") but never aborts a build; Mneme blocks superseded
   approaches pre-generation but does no prose↔graph reconciliation. This is effectively unique —
   and it is *exactly* the surface vendors funnel team knowledge into (see below).
3. **Captured decisions with rejected alternatives + grilling** — Graphify only *harvests*
   rationale already written in `# WHY:`/docstrings into graph nodes; it has no way to record a
   *new* decision, its alternatives, or supersession. Hunch captures at decision time.
4. **Private overlay (public repo, private reasoning)** — no profiled competitor has an
   equivalent. Open-source the code without open-sourcing the *why*.

## Where Hunch is behind / claims to drop

- **"Client-agnostic MCP" is table stakes, not a differentiator.** ByteRover claims 22+ agents;
  Sourcegraph Enterprise sells full MCP. Stop leading with it.
- **"Team sync" as a *mechanical* claim is contested.** Graphify commits its graph with a
  union-merge driver and serves a team over HTTP MCP; ByteRover has git-like branch/commit/merge.
  Hunch's *defensible* edge is **semantic** sync — `reconcile-topics`, one-live-decision-per-topic,
  merges that can violate invariants — not "we sync over git."
- **Derived-structure query depth.** Graphify's `shortest_path` / `get_pr_impact` / community
  clustering are richer graph-traversal queries than Hunch exposes. Close the cheap gap or cede
  the layer and integrate.
- **Retrieval scale.** Augment Code indexes 400K+ files with real-time updates; Hunch does not
  compete on that axis and shouldn't pretend to.

## What Hunch needs — prioritized

### Product (build)
1. **AGENTS.md / CLAUDE.md interop as a drift surface.** Ground from, compile from, and
   drift-check the git-tracked prose files that Windsurf's own docs and the 60K+-repo AGENTS.md
   standard funnel team knowledge into. This extends the existing doc≠graph spoke to the
   industry's *default* memory format — the single highest-leverage feature.
2. **Close the cheap derived-query gap** — Graphify-style `shortest_path` / PR-impact / community
   queries where they're inexpensive; otherwise explicitly integrate rather than compete.
3. **Keep enforcement receipts (`conform --strict`, `drift` exit codes) as the demo centerpiece** —
   the one capability no funded competitor ships.

### Positioning (message)
- **vs Graphify:** *"Graphify maps what the code is; Hunch enforces why it must stay that way."*
  (derived extraction vs captured + gated decisions with rejected alternatives.)
- **vs ByteRover / Mem0-class memory:** *"memory that gates, not just recalls."*
- **Drop** "client-agnostic MCP" and "team sync" as *headline* differentiators. **Lead with**
  deterministic enforcement + semantic merge safety (`reconcile-topics`) + private overlay —
  none of which any profiled competitor has.

### Distribution (copy Graphify's playbook)
Graphify went 0→75K★ in ~3 months on **frictionless install and committed artifacts**, not a
capability Hunch lacks. Replicate the mechanics:
- **Skill-format packaging** for each assistant (Claude Code / Cursor / Codex / …).
- **Single-command multi-assistant install.**
- **A committed-artifact quickstart** where the repo itself demos the graph.
- **HTTP team-mode docs.** (Hunch already has the merge-driver ingredient Graphify markets heavily.)

## Threat ranking

**Graphify is the competitor most likely to absorb Hunch's category.** 75K stars, YC backing, a
~3-month cadence that already produced git-native team sync, install-everywhere hooks, an HTTP
team MCP server, and an advisory work-memory/lessons layer with a staleness flag. Adding decision
capture or a blocking mode would be an incremental release. The one counter-signal: its
architecture is *deliberately* never-blocking (`test_never_blocks`), so enforcement would be a
philosophy change, not just a feature. Mneme validates the enforcement category without the
distribution to win it; assistant vendors (Windsurf/Cognition, Cursor) are structurally biased
toward per-user, non-git memory.

## Refuted talking points (do NOT use)

The verification pass *killed* four tempting claims — using them would be inaccurate:
- ❌ "Cline Memory Bank updates are purely manual." (Refuted 0-3.)
- ❌ "Windsurf Cascade Memories are provably advisory-only." (Refuted 0-3 — they have auto-gen.)
- ❌ "Sourcegraph has no free tier / $16K single plan." (Refuted 0-3.)
- ❌ "Only Hunch enforces recorded intent." (Mneme HQ does too — argue depth: AST vs keyword,
  auto-capture vs hand-authored, team sync — not existence.)

## Open questions

- Do heavyweight agent-memory platforms (Mem0, Zep/Graphiti, Letta, Cognee) or code-context
  incumbents (Greptile, Unblocked, Augment) offer *any* decision capture / git-native storage /
  enforcement — or are they uniformly server-side and advisory? (Unprofiled quadrant.)
- Does Graphify's roadmap signal decision capture, a blocking hook mode, or ADR-as-structured-data?
- Which mechanisms actually drove Graphify's 0→75K stars (Karpathy mention, skill packaging,
  launch content, YC network) — and which are reproducible for a solo npm tool?
- Are classic architecture-governance tools (ArchUnit, dependency-cruiser, Nx, CodeScene, Sonar)
  adding MCP/AI-gating that would collide with Hunch's conformance spoke from the rules-first side?

## Sources

Primary: [Graphify](https://github.com/safishamsi/graphify) ·
[ByteRover CLI](https://github.com/campfirein/byterover-cli) ·
[Cline Memory Bank](https://docs.cline.bot/prompting/cline-memory-bank) ·
[Windsurf Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories) ·
[AGENTS.md](https://agents.md/) · [Mneme HQ](https://mnemehq.com/) ·
[mneme repo](https://github.com/TheoV823/mneme) · [Sourcegraph pricing](https://sourcegraph.com/pricing) ·
[CodeScene AI](https://codescene.com/use-cases/ai-code-quality)
