# Competitive landscape

**Evidence snapshot: 2026-07-16, updated 2026-08-09 (see "Update — 2026-08-09" below). Re-verify every third-party fact before quoting or publishing an update.**

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
