# Competitive landscape

**Evidence snapshot: 2026-07-16. Re-verify every third-party fact before quoting or publishing an update.**

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

## Copying assessment

**Finding on 2026-07-16: no credible public evidence that a screened competitor copied Hunch.**

The strongest disconfirming evidence is chronology:

- Cursor Memories reached general availability in July 2025.
- GitMem's first public release is dated February 18, 2026.
- projectmem reports real usage beginning March 30 and published its paper on June 10, 2026.
- Roam documented graph-ranked retrieval and its post-edit verification loop on June 11, 2026.
- [Hunch's first commit](https://github.com/davesheffer/hunch/commit/a2d3f811ad9058fe1d69dd67a45a1c43648cafef) is dated June 14, 2026.

Additional checks performed for this snapshot:

- GitHub exact-phrase searches for distinctive Hunch language, including “Causal Merge Verdict,”
  “corrections become enforced,” and “content-matched constraints,” found no reuse by the screened
  competitors.
- An exact-clone scan across 52,306 current TypeScript source lines in Hunch, Knowit, GitMem, and
  mnemo found no cross-repository clone at an 8-line / 70-token threshold.

This cannot inspect private repositories, establish what an author read, or rule out conceptual
inspiration. Escalate only when several signals converge: a feature first appears after Hunch's
dated release, the overlap is distinctive rather than categorical, and wording, schema, code, or
access evidence independently supports the same conclusion.

## Operating watchlist

Run the public metadata and exact-phrase check monthly:

```bash
npm run research:competitors

# Authenticated code search adds the phrase-copy check.
GITHUB_TOKEN="$(gh auth token)" npm run research:competitors
```

Review projectmem and Roam weekly while their governance surfaces are moving quickly. Review
Knowing, GitMem, Knowit, Copilot Memory, Cursor, Windsurf, and Memco monthly. Record observations
with dates; never silently replace the history of an earlier assessment.
