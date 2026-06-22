# Expansion Research — where Hunch should grow

> **Research artifact**, dated **2026-06-22**. Produced by a deep-research harness:
> 5 search angles → 23 sources fetched → 112 claims extracted → 25 adversarially
> verified (3 independent skeptics each) → **19 confirmed, 6 killed** → 9 synthesized.
> Confidence tags and the killed claims are kept deliberately — treat exact numbers as
> *directional*, since several rest on single non-peer-reviewed preprints. **The
> competitive landscape moves fast; re-verify competitor facts before committing.**

## Thesis

Hunch's defensible moat is the **one combination no competitor has**: local-first /
git-native storage **+** provenance-first records **+** deterministic
(model-out-of-the-block-path) enforcement over a code-**decision** reasoning graph. The
market is converging fast on "memory for coding agents," but each major player races on a
*different* axis — so the moat **holds on the decision/ADR + deterministic-guard + git-native
axis**, and is **exposed on retrieval quality and adoption/traction**, not on the moat itself.

---

## Axis 1 — Market / competitors

Where the moat holds vs. where it leaks.

| Competitor | What it is | Where Hunch wins | Confidence |
|---|---|---|---|
| **GitHub Copilot Memory** | Citation-validated repo facts; server-side; **28-day auto-expiry**; **single-vendor** (Copilot agent/review/CLI only) | Client-agnostic MCP (one `.hunch/` → Cursor + Claude + Windsurf), durable git-tracked JSON, structured ADRs w/ rejected-alternatives + rationale lineage, **fail-closed** guards (Copilot is advisory/just-in-time) | **high** (3-0) |
| **agentmemory** (~23.7k★) | Local-first SQLite + in-memory vector, triple-stream retrieval, MCP/REST, very client-broad | Curated code-**decision** graph + deterministic enforcement (theirs is a *general* agent store; heavy native daemon + web viewer on :3113) | **high** (3-0) |
| **Graphiti / Zep** | Bi-temporal KG, hybrid retrieval (~300ms P95, no LLM in retrieval path) | *Validates* Hunch's bi-temporal valid-time + non-destructive veto/supersede — external precedent, not a code competitor | **high** (3-0) |
| **cognee** | KG memory engine (incl. repo→KG); Apache-2.0, self-hostable | Less of a threat than feared, but **does** have repo-to-KG and defaults to server DBs (Postgres / PGVector / Neo4j / OpenAI) — *not* a single-dev git-native store | mixed (2 sub-claims **refuted 0-3**) |

**Verdict:** the git-native code-**decision** graph with deterministic guards is **largely
uncontested**. Exposure = retrieval sophistication + traction (Copilot's distribution,
agentmemory's stars).

---

## Axis 2 — Technical / architecture (the validated wins)

1. **Graph-augmented retrieval — 58% → 82% cross-file citation completeness** *(high, but a
   single preprint — arXiv 2512.12117)*. 1-hop BFS over the import-dependency graph from seed
   files (neighbor boost γ≈0.25, exponential decay) added **+24 points**; 62% of "why"
   questions needed multi-file evidence. **Hunch already builds this graph**
   ([src/extractors/indexer.ts](../src/extractors/indexer.ts): `depends_on` / `calls` edges,
   components). The win = **expand query results by one graph hop** — reuses existing infra.

2. **Triple-stream hybrid retrieval (BM25 + dense-vector + graph, fused via RRF, k=60)** *(high,
   3-0)* — the recipe both Graphiti and agentmemory independently converge on (agentmemory
   reports 95.2% R@5 on LongMemEval-S). **Hunch is 2/3 there already**: FTS5 + vector already
   fuse via RRF (`HUNCH_RRF_W_FTS` / `HUNCH_RRF_W_SEM` / `HUNCH_RRF_K`). The win = **add the
   graph as the third RRF stream** — lower effort than the literature implies.

3. **Bi-temporal modeling is externally validated** *(high, 3-0)*. Graphiti/Zep invalidate edges
   rather than deleting (four timestamps: `t_valid`/`t_invalid`/`t_created`/`t_expired`) —
   *exactly* Hunch's valid-time windows + non-destructive veto/supersede. **Lean into it as a
   documented provenance/audit differentiator**, not just an implementation detail.

4. **Memory quality = retrieval/selection, not reader capability** *(medium; web-agent
   benchmark)*. Coding-agent **trajectory memory** (store trajectories as files, invoke a coding
   agent to gather evidence) beat the strongest dense-RAG baseline **72.5% vs 48.5%**
   (LongMemEval-V2, arXiv 2605.12493). Implications: (a) invest disproportionately in retrieval
   (wins 1–2); (b) **big bet** — file-based, git-native "**runbook / trajectory**" records
   inspected by the user's *subscription* coding agent, which aligns with Hunch's local-first +
   subscription-billed architecture. ⚠️ Caveat: benchmarked on **web** agents, authors' own
   method — code-domain transfer unproven.

5. **Curated graph nodes at reasoning time beat full-context dumps** *(medium; vendor
   self-benchmark)*. Zep reports up to **+18.5% accuracy and −90% latency** vs full-context.
   Supports Hunch's core thesis — but Zep disclosed 9–18% *regressions* on single-session
   questions, so **validate the curated-node advantage on Hunch's own code-decision eval**.

---

## Axis 3 — Product / features (mapped to the above)

- **Deep / ensemble synthesis** ([docs/deep-synthesis.md](deep-synthesis.md)) — the decision-
  **quality** play (brain reviews multiple subscription-CLI worker drafts). Medium impact/effort.
- **Memory-quality eval harness** — evaluation is shifting from static recall to multi-session
  agentic tests, where current systems crater (MemoryArena: task completion **>80% → ~45%** on
  interdependent tasks). A **code-decision** eval harness is a defensible, regression-testable
  quality signal. High impact / medium effort.
- **Cross-repo / org memory** — federated per-repo `.hunch/` + a shared index, *without*
  becoming a server-side store like Copilot. Preserves the moat. High impact / high effort.

The adjacent SWE-agent landscape confirms the trajectory: RepoAudit (graph traversal over file
dependencies), MemGovern (governs raw GitHub data into retrievable "experience cards", +4.65% on
SWE-bench Verified) — software agents are converging on **structured, graph-shaped memory built
from code dependencies + commit/issue/test loops**, which is precisely Hunch's ingestion model.

---

## Prioritized roadmap (impact × effort)

| # | Move | Impact | Effort | Why now |
|---|---|---|---|---|
| **1** | **Add graph as the 3rd RRF stream** + 1-hop query-time graph expansion | High | **Low** | Graph + 2/3 of fusion already exist; closes the #1 exposure |
| **2** | **Code-decision memory-quality eval harness** (multi-session) | High | Med | Turns "trust us" into measurable, regression-tested quality |
| **3** | **Position client-agnostic + git-native + fail-closed** vs Copilot single-vendor/28-day/advisory | High | Low | Differentiation Copilot *structurally* cannot copy |
| **4** | **Deep / ensemble synthesis** | Med | Med | Decision quality on the write path |
| **5** | **Git-native trajectory / runbook memory** (big bet) | High | High | Fits subscription model; validate on *code* first |
| **6** | **Cross-repo / org federated memory** (big bet) | High | High | Team/enterprise growth without server-side compromise |

**Recommended first move: #1.** Low-effort, reuses code that already exists
([indexer.ts](../src/extractors/indexer.ts) + the FTS5/vector RRF path), and directly closes
the only real technical exposure.

---

## Killed claims — do NOT build on these (refuted 0-3)

- ❌ "Mechanical citation-grounding eliminates code-location hallucination (0%)" — overstated.
- ❌ Exact weighted-fusion numbers (BM25 α=0.45 + dense β=0.55 → 92%) — refuted; use **RRF k=60**, not learned weights.
- ❌ "Graph memory is THE frontier, superseding vector memory" — overstated; **hybrid** wins, graph is *a* stream.
- ❌ "Zep beats MemGPT 94.8 vs 93.4 on DMR" — that specific benchmark claim did not hold.
- ❌ "cognee has no code-graph" and "cognee is purely local-first across many platforms" — both refuted; cognee **does** repo→KG and defaults to **server** DBs.

## Open questions (de-risk before committing)

1. Does the **58→82** graph-expansion gain transfer to Hunch's code-**decision** graph (vs the
   code-comprehension setting it was measured in)? Measure on real "why" questions first.
2. Can Hunch build/adopt a **multi-session agentic eval** (MemoryArena / MemoryAgentBench /
   LongMemEval spirit) specialized to code decisions, runnable deterministically in CI?
3. Is file-based git-native **trajectory/runbook** memory viable within local-first +
   model-out-of-block constraints — and does its advantage hold for **code** (not web)?
4. What cross-repo / org architecture preserves git-native source-of-truth + provenance without
   becoming server-side, and how does the existing **merge driver** scale to org-level sync?

## Sources (primary, verified)

- GitHub Copilot Memory — docs.github.com/en/copilot/concepts/agents/copilot-memory ; github.blog "building an agentic memory system for GitHub Copilot"
- Graphiti — github.com/getzep/graphiti ; Zep paper — arXiv 2501.13956
- agentmemory — github.com/rohitg00/agentmemory
- cognee — github.com/topoteretes/cognee
- "Memory for Autonomous LLM Agents" — arXiv 2603.07670
- "Graph-based Agent Memory" — arXiv 2602.05665
- LongMemEval-V2 (trajectory memory) — arXiv 2605.12493
- Citation-Grounded Code Comprehension (graph expansion) — arXiv 2512.12117 *(single preprint; directional)*
- RepoAudit — arXiv 2501.18160 ; MemGovern — arXiv 2601.06789

_Run metadata: 105 agents · ~2.6M subagent tokens · ~16 min · deep-research harness, 2026-06-22._
