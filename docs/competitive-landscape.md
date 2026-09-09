# Competitive landscape

**Evidence snapshot: 2026-07-16, updated 2026-09-09 (see dated updates below). Re-verify every third-party fact before quoting or publishing an update.**

## Update — 2026-09-09

### Neotoma already occupies the "deterministic state layer" phrase

Neotoma ([neotoma.io](https://neotoma.io), [repository](https://github.com/markmhendrickson/neotoma),
MIT, single author, 32 stars, npm `neotoma` first published 2026-02-04, v0.22.1 on 2026-09-08)
describes itself as **"a deterministic state layer for AI agents"** and has carried that phrase on its
site since 2026-03-10 (repository history: commit `6a5007aff`). Its GitHub topics include
`deterministic-state`. Hunch coined its own **Deterministic State** category on 2026-09-08
(`dec_af77e5626e`). The phrase is therefore shared and Neotoma used it first; Hunch's public copy
must not claim to have named the category.

The engine is real and overlaps Hunch's state spoke almost verb for verb: append-only observations
with SHA-256 content hashes, hash-derived entity ids, a deterministic reducer with field-level
provenance, corrections as priority-1000 observations, `SUPERSEDES` relationships, idempotency
keys with an `ERR_IDEMPOTENCY_MISMATCH` refusal, per-agent attributed writes, one OpenAPI contract
behind MCP (64 tools), REST (108 operations), a ~170-command CLI, and a bundled Inspector UI.
Local SQLite is the source of truth; an optional Markdown mirror is derived and git-trackable.
A sibling project, Ateles, is positioned as "who was authorized" against Neotoma's "what was true",
which mirrors Hunch's Constitution split. Velocity: 472 commits in May 2026, 26 so far in September.

Verified locally on 2026-09-09 by importing the published package's reducer and entity-id functions
(no server): entity ids are stable under whitespace and case; a snapshot is identical regardless of
observation order; ties on `observed_at` resolve by id. Two behaviours worth knowing when comparing
claims: a correction wins because the correction path stamps `observed_at = now` and most fields use
`last_write`, so a later ordinary write (including an LLM summary) overrides a human correction on
such a field; and a field absent from the type's schema is kept in the observation log but silently
omitted from the current snapshot.

Where Neotoma is ahead: entity resolution, duplicate merge/split, file ingestion (PDF, CSV, Parquet),
schema inference, an operator UI, hosted multi-user mode with hardware-attested agent identity, peer
federation, TypeScript and Python SDKs, and integrations for eight editors and hosts. Where it has
written down as future what Hunch ships now: organizations and workspaces ("not yet"), authority
semantics over who may correct what (P2, "mechanisms exist"), and multi-principal dispute semantics
(P3, "planned"); its own determinism doctrine names "bounded convergence" — divergent agent writes
accumulate and are repaired by later merge — where Hunch refuses a second live decision per topic and
requires a supersede target to still be open. Neotoma is not aimed at codebases at all; Hunch's
engineering-memory and conformance spoke has no counterpart there. Its stated primary ICP is one
person running a personal memory across Claude, Cursor and ChatGPT; small teams are a "future ICP".

### Actions

- Add `markmhendrickson/neotoma` to the automated watch.
- Stop leading with the category name. Lead with what Neotoma lists as future: organization and
  team partitions with a key per agent, refused contradictions across many writers, receipts and
  commitments as first-class kinds, and the git-native source of truth. Keep the code-conformance
  spoke as the property no state-layer peer has.
- Position by verified properties only (`dec_94b4b7880e`): the two behaviours above are observed on
  v0.22.1 and must be re-run before being quoted.

## Update — 2026-08-22

### ADRKit moves directly into the decision-memory lane

ADRKit now describes itself as **“decision memory for human- and agent-authored plans,”** which is
direct overlap with the phrase-level category Hunch has occupied. Its v0.8.0-era surface combines a
typed ADR corpus and deterministic `lint` / `check` / `explain` workflows with four read-only MCP
tools that expose governing, rejected, and superseded decisions. A portable agent plugin added a
`decision-memory` skill, a read-only decision-checker agent, and context / check / draft / queue
commands for GitHub Copilot CLI, Claude Code, opencode, and APM. The Spec Kit integration also moves
decision lookup to plan time, before implementation begins.
([repository and README](https://github.com/mbeacom/adrkit),
[v0.8.0 release](https://github.com/mbeacom/adrkit/releases/tag/v0.8.0),
[agent-plugin change](https://github.com/mbeacom/adrkit/pull/157))

This is a real product-direction collision, not just adjacent ADR tooling. ADRKit’s sharp edge is a
small, inspectable, offline governance ledger whose record format, CLI, CI Action, MCP server, and
agent prompts all speak the same decision vocabulary. Its own evidence remains deliberately early:
the main distribution document says external/community validation is still absent, while the new
agent plugin is at rung 1 and explicitly lacks persistent reference-repository and external runs.
([distribution status](https://github.com/mbeacom/adrkit/blob/main/docs/DISTRIBUTION.md),
[agent-plugin evidence](https://github.com/mbeacom/adrkit/blob/main/docs/reference-verification-agent-plugin.md))

The positioning response is to stop treating “decision memory” alone as defensible. Hunch should
lead with the wider causal and authority system ADRKit does not currently claim: decisions plus bug
lineage, corrections, constraints, findings, code-graph blast radius, provenance/currentness-aware
delivery, human-bounded authority, and receipts for exactly what context reached an agent and what a
change gate concluded. In short: ADRKit is becoming a strong typed ADR governance layer; Hunch’s
claim must be the complete engineering-memory-to-authority-to-receipt loop.

### Actions

- Add ADRKit to the automated watch and treat its agent-plugin and Spec Kit surfaces as a direct
  competitor branch, not an ADR-tool footnote.
- Lead Hunch copy and demos with corrections, bug recurrence, scoped authority, delivery receipts,
  and causal PASS / WARN / BLOCK output; avoid an undifferentiated “memory for coding agents” lead.
- Keep MADR/ADRKit interoperability as an acquisition path, while testing lifecycle mismatches
  explicitly so imported records never invent history or silently disappear.

## Update — 2026-08-09

Web-sourced pass over the July baseline plus new-entrant sweep. The automated
watch (`npm run research:competitors`) failed this run on a 401 from an invalid
ambient `GITHUB_TOKEN` — the script should fall back to unauthenticated
metadata checks instead of dying; until fixed, treat repo-metadata deltas as
unverified. `memco.ai` and `mem0.ai` were unreachable from this environment
(egress policy); facts below about them come from search-result snippets and
should be re-verified before quoting.

### Baseline deltas

- **Roam is the fastest mover and the top threat to the receipt/gate story.**
  v14.0.0 (2026-08-07) adds a cross-family review workflow
  (`review-request/accept/verify`), a verdict with a secondary blocking axis,
  SARIF output, and fail-closed gate semantics; earlier releases added a signed
  ChangeEvidence packet (Cosign/Sigstore-verifiable offline), a
  security-procurement template, and a public compare page targeting Cursor,
  Cody, Windsurf, and CodeRabbit. Positioning is now "local-CLI agent
  assurance" — enterprise evidence, not memory.
  ([repo](https://github.com/Cranot/roam-code),
  [changelog](https://github.com/Cranot/roam-code/blob/main/CHANGELOG.md),
  [compare page](https://roam-code.com/compare))
- **Memco pivoted into Hunch's core lane.** The homepage is now "Spark —
  shared memory for coding agents": captures developer experience and shares
  it across tools, citing third-party benchmarks (2026-01) of 48% faster task
  completion and 53% fewer tokens. The enterprise control-plane framing of the
  July snapshot is now paired with a direct coding-agent product; the company
  is hiring and shipping weekly with production agent teams.
  ([memco.ai](https://www.memco.ai/) — unverified from this environment)
- **GitMem productized**: gitmem.ai, `npx gitmem-mcp init`, MCP-client-agnostic,
  and messaging that is Never-Twice-shaped — "turns mistakes into permanent
  lessons that surface before you repeat them." ([gitmem.ai](https://gitmem.ai/))
- **Copilot Memory keeps commoditizing recall**: on by default for Pro/Pro+
  since 2026-03-04, user-level preferences beyond repository facts since
  2026-05-15, deletion/scope/CLI controls and a repository-admin off switch
  since 2026-05-26. Still public preview; used by cloud agent, code review,
  and CLI. ([changelog](https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/))
- **Cursor**: memories are now deletable via UI and automations; rules can be
  generated from a conversation; August energy went to model routing (Cursor
  Router), not memory governance. ([changelog](https://cursor.com/changelog/page/2))
- **projectmem**: rising paper visibility (HF papers, third-party reviews);
  actively promoting the term **"Memory-as-Governance"** — competing category
  language aimed at exactly Hunch's frontier.
  ([arxiv](https://arxiv.org/abs/2606.12329))
- **Knowing**: steady; on PyPI at 0.7.0; unchanged thesis (content-addressed
  extracted relationships + Merkle proofs, auto-expiry on code change). Still
  structure-derived rather than curated rationale.
  ([repo](https://github.com/blackwell-systems/knowing))
- **Knowit / AICTX / Windsurf**: no fresh public signal observed this pass
  (not a finding of inactivity — the metadata watch was down).

### Ecosystem shifts since the baseline

- **MCP spec 2026-07-28 makes the protocol core stateless** — the largest MCP
  change to date. Verify Hunch's server against the new revision; long-lived
  session assumptions are where breakage would hide.
  ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/))
- **A consumer memory-SaaS cluster has formed around coding agents**:
  MemoryPlugin (Sync app + official MCP registry listing, late July), Basic
  Memory, Hindsight, MemNexus, Supermemory, agentmemory, plus mem0's Codex
  integrations and a "State of AI Agent Memory 2026" report. Recall is now a
  crowded commodity — the July thesis held and strengthened.
- **AI code review is converging on memory→enforcement from the PR side**:
  CodeRabbit's Rules Miner learns review patterns from historical PRs and
  applies them automatically, with enforcement metrics/analytics on top;
  Qodo positions on "full codebase enforcement." Distribution-rich vendors are
  building the correction→rule loop without the provenance layer.
- **"Guardrails" as a term is captured by model/runtime safety** (NeMo
  Guardrails, Lakera, GA Guard) — not architecture. Architecture-drift
  content instead recommends deterministic "architecture tests."
- **"Context engineering" won the umbrella-category war** (Sourcegraph, mem0,
  Supermemory, multiple papers); "agent memory" is its persistence
  subcategory.

### Actions

- Verify the MCP server against the 2026-07-28 stateless revision.
- Consider SARIF output for `hunch check`/`conform` (enterprise-integration
  currency Roam already has) and evaluate extending the existing Sigstore
  release verification into signed change receipts.
- Fix `tooling/competitive-watch.mjs` to fall back to unauthenticated requests
  when the ambient token is rejected.

This document tracks public product direction around persistent memory, code intelligence, and
governance for AI coding agents. It is not a feature-scorecard or a legal conclusion. The sources
are first-party documentation, repositories, changelogs, and research papers observed on the date
above.

## Executive finding

Persistent repository memory is becoming a commodity. Assistant vendors now retain repository
facts; open-source tools share structured memory over MCP; enterprise products add access control
and audit. The competitive frontier is moving from **remembering** toward **governing**: deciding
which knowledge has authority, proving where it came from, and checking a change before it merges.

Hunch should therefore lead with its evidence-and-receipt loop, not memory alone:

> Relevant engineering history before the edit; a deterministic receipt after it.

## Market map

| Product or group | Observed public direction | Implication for Hunch | Primary source |
| --- | --- | --- | --- |
| GitHub Copilot Memory | Repository facts carry code citations, are validated before reuse, and travel across Copilot's cloud agent, code review, and CLI. | Basic repository recall will be bundled into a platform with enormous distribution. | [GitHub documentation](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) |
| Cursor and Windsurf | Automatic project memories coexist with explicit durable rules. Cursor also gives always-on automations a memory tool. | “My coding assistant remembers this repo” is no longer a differentiator by itself. | [Cursor Memories](https://docs.cursor.com/en/context/memories), [Cursor Automations](https://cursor.com/changelog/03-05-26), [Windsurf Memories](https://docs.windsurf.com/windsurf/cascade/memories) |
| GitMem | Scars, wins, patterns, decisions, and session reflection; its paid direction adds team persistence, analytics, subagent briefing, and A/B measurement. | Strong capture/recall loop and clearer language around learned failures. | [GitMem repository](https://github.com/gitmem-dev/gitmem) |
| ADRKit | Typed ADR governance across CLI/CI, four read-only MCP tools, Spec Kit plan-time checks, and a portable agent plugin explicitly positioned as decision memory. | Direct competitor for deterministic decision memory and pre-edit agent workflow; narrower than Hunch's multi-record causal graph and receipt/authority loop. | [ADRKit repository](https://github.com/mbeacom/adrkit), [agent plugin](https://github.com/mbeacom/adrkit/tree/main/packages/adapters/agent-plugin) |
| Knowit and AICTX | Local, inspectable, cross-agent memory. Knowit adds external-source routing and describes hosted team plans; AICTX emphasizes handoffs, validation evidence, and explicit freshness signals. | Local-first, MCP-native, git-shared memory is a crowded baseline. | [Knowit](https://www.useknowit.dev/), [AICTX](https://github.com/oldskultxo/aictx) |
| projectmem | Event-sourced project memory plus a deterministic pre-action judgment gate. Its workspace release adds cross-project dashboards, code structure, failure heat, and an intent file. | Closest conceptual peer to memory-backed governance. | [Research paper](https://arxiv.org/abs/2606.12329), [repository](https://github.com/riponcm/projectmem) |
| Roam | Code graph, graph-ranked context, pre-change safety, post-edit verification, architecture gates, audit evidence, hosted review, and PR replay. | Strongest adjacent threat to Change Gate on static code intelligence and measured change safety. | [Roam repository](https://github.com/Cranot/roam-code) |
| Knowing | Content-addressed code relationships, automatic expiry, learned retrieval feedback, Merkle proofs, runtime traces, and audit/compliance outputs. | Competes with provenance and proof, but its source material is extracted code relationships rather than curated engineering rationale. | [Knowing repository](https://github.com/blackwell-systems/knowing) |
| Memco | Shared organizational memory with provenance, promotion workflows, RBAC, SSO, audit logs, and SaaS/VPC/on-prem deployment. | Establishes the enterprise control-plane direction without Hunch needing to chase it before demand exists. | [Memco for engineering teams](https://www.memco.ai/use-cases/engineering) |

## Where the category is going

1. **Recall becomes infrastructure.** Repository facts, preferences, rules, and semantic retrieval
   will increasingly ship inside assistants or as interchangeable MCP services.
2. **Authority becomes the hard problem.** A remembered statement is not automatically a rule.
   Products need provenance, review, correction, expiry, and a safe activation boundary.
3. **Memory meets code intelligence.** projectmem is adding structure; Roam and Knowing are adding
   history, learning, and evidence. The previously separate categories are converging.
4. **Enterprise packaging moves upward.** Shared scopes, audit trails, SSO, and deployment controls
   become the commercial layer once the underlying recall loop is expected.

## Hunch's defensible surface

Hunch is strongest where these properties operate together:

- decisions retain rejected alternatives and non-destructive history;
- bug lineage explains which incident a rule prevents from recurring;
- captured memory is advisory until a human confirms precise authority;
- enforcement is deterministic and does not call a model in the block path;
- checks return causal PASS / WARN / BLOCK receipts rather than an uncited verdict;
- public and private reasoning can remain separate while local tools use the combined graph;
- the source of truth is portable, reviewable JSON in git and every client sees it over MCP.

Any one of these can be reproduced. The product claim is the complete chain from engineering event,
to curated rationale, to scoped authority, to a deterministic change receipt.

## Revision practice

Observations are recorded with the date they were made. An earlier assessment is never silently
replaced — a later snapshot is added alongside it, so the history of what was believed when stays
readable.
