# Hunch roadmap

Updated 2026-08-21.

Hunch is building the validated delivery layer for engineering intent: record why the code is the
way it is, deliver the right evidence at the moment an agent needs it, and deterministically check
the resulting change. The graph is the source of truth; assistant rules, prompts, receipts, and
other integrations are derived delivery surfaces.

This file is the public execution view. `hunch now` remains the detailed live decision ledger.

## Ecosystem boundary

Hunch remains independent of any one orchestrator or agent. In the ORC ecosystem the ownership is:

```text
Hunch
  durable engineering semantics + graph + validated delivery + conformance
        │
        ▼
Hunch Memory
  optional operational service: store isolation, HTTP/MCP transport,
  concurrency and recoverable Git-backed deployment
        │
        ▼
ORC HunchContextProvider / MemoryAdapter
        │
        ▼
ORC ContextAssembler
  combines Hunch with Git, SimplyLog and future context providers
        │
        ▼
AgentPolicy-selected Claude / Codex / future agent
```

Hunch does **not** become ORC's agent router, workflow engine, global context compiler, tenant control plane or organizational knowledge gateway. ORC does **not** become a second durable Hunch graph or ranking engine.

The integration contract must preserve Hunch's validated-delivery evidence — record IDs, rank/reason, provenance/currentness, blocking state and budget cost where available — so an orchestrator can build a generic context manifest without reconstructing facts from prose. Hunch Memory should transport that evidence additively; ORC owns final cross-provider budget/dedupe and execution evidence.

This boundary is intentionally vendor-neutral: the same Hunch knowledge must remain usable whether the worker is Claude, Codex, another MCP-capable agent or a future orchestrator.

The next shared Hunch/ORC contract is the [Engineering Landscape Graph](docs/engineering-landscape.md).
Hunch publishes durable, repository-evidenced landscape fragments; ORC's reciprocal
[`ENGINEERING-LANDSCAPE.md`](https://github.com/davesheffer/orc/blob/main/docs/ENGINEERING-LANDSCAPE.md)
owns authorized cross-repository traversal, live discovery and task-scoped assembly. Hunch Memory's
reciprocal [transport contract](https://github.com/davesheffer/hunch-memory/blob/main/docs/ENGINEERING-LANDSCAPE-TRANSPORT.md)
preserves the fragment and native receipt without owning ranking, traversal or ORC caching.

## Engineering Landscape Graph — planned

The repository is one implementation node, not the root of a developer's world. Hunch will extend
its existing graph so a bounded query can connect product → capability → system → repository →
service/interface/data/delivery resources and the decisions, constraints, incidents and lifecycle
facts that govern them.

1. **HLG-1 — versioned resource and relationship contract.** Add stable resource IDs, extensible
   kinds, typed directional relationships, lifecycle, credential-free locators, provenance and
   currentness without creating another graph authority.
2. **HLG-2 — deterministic repository fragment discovery.** Derive reviewable candidate topology
   from package/MCP/deployment/CI/API/event/schema/Git/ownership sources; distinguish declarations,
   derived evidence and human-vouched facts.
3. **HLG-3 — bounded landscape delivery.** Return task-relevant resources, relationships and linked
   Hunch reasoning through the existing ranking, budget, currentness and native receipt envelope;
   add an explicit CLI/MCP view only as a projection over that machinery. Freeze the additive
   envelope before Hunch Memory implements transport; the service must preserve IDs, source/graph
   evidence, omissions and the native receipt byte-for-byte or by canonical hash.
4. **HLG-4 — cross-repository references and drift intake.** Preserve stable external repository and
   contract references. Accept ORC-observed mismatches only as evidenced findings/proposals; live
   observation never silently rewrites declared architecture.

Done means a repository can publish a revision-current, receipted landscape fragment that remains
useful to any Hunch client, while ORC can assemble multiple authorized fragments without duplicating
Hunch's graph or making Hunch a runtime/control plane.

### Immediate implementation handoff — HLG-1

Branch from current `main`. Commit `8481edc` is the last code baseline reviewed for this handoff,
not a branch target; later documentation/ledger commits are part of current `main` and must not be
dropped. The architecture and Hunch/ORC ownership boundary are frozen; the next change is the
smallest executable contract slice, not discovery or orchestration:

1. Add one extensible, versioned resource record in `src/core/types.ts` with stable kind-qualified
   identity, lifecycle, credential-free locator, provenance and currentness.
2. Extend the existing edge graph for typed resource relationships. Do not create a second graph,
   a second source of truth or an ORC-specific store.
3. Bump the JSON schema generation and forward-migrate before Zod validation. JSON remains
   authoritative; SQLite remains a rebuildable derived index.
4. Make resource and relationship identity deterministic and reject secret-bearing locators or
   metadata at the write boundary.
5. Prove legacy graph migration, deterministic round trips, malformed-record rejection, derived
   index rebuild and public/private-store behavior with focused tests.

HLG-1 is complete when existing repositories migrate without loss and Hunch can store, index and
query one repository-local resource fragment with stable identities and provenance. It does not yet
claim manifest discovery, live runtime health, cross-repository traversal or a new CLI/MCP surface;
those remain HLG-2 and HLG-3. The live roadmap anchor is
`roadmap.engineering-landscape-hlg-1`.

## Current baseline — v1.17.0

- Architectural Conformance and decision-grounding are deterministic release gates.
- CLI, MCP, and edit hooks share one currentness-checked, hard-budgeted delivery envelope.
- MCP advertises and returns that envelope as structured output while preserving legacy text.
- Delivery receipts record exact IDs, rank, reason, provenance status, and estimated token cost.
- Grounding survives helper-agent delegation and context compaction.
- Public checks exclude private overlays, and generated artifacts are drift-checked — including
  the exported MADR corpus, which reports its own rot (`madr-stale` / `madr-edited` /
  `madr-orphan`), refreshes automatically on the post-commit sync, and protects human edits by
  content rather than file name.
- The MADR bridge is bidirectional and shipped: `import-adr` populates the graph from an existing
  corpus deterministically; `export-adr` projects it back as standard MADR (Backstage-readable).
- Go joins TypeScript, JavaScript, and Python in the symbol/dependency graph (v1.15).
- Retrieval ranks recorded intent above vocabulary-sharing code symbols — a bounded prior, never
  an exclusion (curated benchmark Recall@10 70% → 90%, MRR 0.402 → 0.575).
- Public positioning leads with the guarantee — agents never re-make a decided decision, never
  re-introduce a fixed bug — across the site (five languages) and README.

### Post-v1.17 work landed

- Retrieval-quality floors now gate the curated benchmark against a disposable fresh graph, so
  the ranking win cannot silently erode as the graph grows and clean CI clones cannot skip it.
- The MCP publication scanner's `vocabularyCache` is keyed by store instead of process-global.
- `HUNCH_PRIVATE_DIR` keeps its compatibility-sensitive precedence, but a real redirection away
  from repo-local configuration is queryable and warned on CLI/MCP stderr; bypassing an advertised
  team store is also explicit.

Still near-term: freshness/staleness scoring for decisions feeding context ranking only — never
authority.

## Next — complete validated delivery

1. Rank every delivered record by task relevance, recency, and trusted provenance.
2. Enforce a hard context budget with a default 3–8 non-blocking headline target per role-specific delivery; pin mandatory blocking constraints outside that target, count duplicate IDs once, and require a recorded mandatory/ambiguity reason plus token accounting when more are delivered. Use progressive disclosure for deeper context.
3. Validate citations and currentness at delivery time; stale evidence must be omitted or labeled.
4. Extend receipts from “served” to usefulness signals: heeded, near miss, prevented, and unused.
5. Add builder, reviewer, and architect delivery profiles. Profiles may change ranking and
   presentation, never the universal enforcement graph.
6. Keep the delivery envelope transportable through Hunch Memory/other service shells without
   losing receipt/currentness metadata or creating an orchestrator-specific source of truth.

Done means every injected item has a record ID, delivery reason, rank, provenance/currentness
result, and token cost—and the benchmark shows the effect on missed constraints and context size.

### First vertical slice

The shared delivery envelope is now implemented across the CLI, MCP context tool, and edit hook.
It deterministically ranks compact record headlines, checks workspace/index anchors plus decision
commit reachability, withholds definitively stale records, and exposes the exact delivered IDs so
the machine-local receipt ledger cannot claim budget-omitted records. Active blocking constraints
are never silently dropped; an impossible caller budget is reported as an explicit overflow.
Hook-specific decision, document, and retired-code grounding now shares that same hard budget
instead of being appended afterward. Each delivered record's receipt records its rank, delivery
reason, provenance/currentness result, and estimated token cost; older local ledgers migrate
additively without becoming a new source of truth.

Still open: fused task-relevance ranking (FTS/vector/graph), patch/change IDs for squash merges,
usefulness signals beyond served/refreshed, delivery profiles, transport preservation of the full
delivery envelope through service integrations such as Hunch Memory, and the benchmark named above.

## Then — compile into native agent surfaces

- Generate path-scoped rules, nested `AGENTS.md`, skills, and MCP prompts/resources as
  reproducible, drift-policed artifacts.
- Deliver bug lineage at failure time with a silence policy for low-confidence matches.
- Check plans against current decisions and rejected alternatives before editing begins.

The Hunch graph remains authoritative. Generated files never become a second source of truth.

## Adoption

- Import assistant auto-memory as reviewable candidates, never immediate authority.
- ~~Import existing MADR/ADR corpora while preserving provenance; support deterministic export.~~
  Shipped in v1.16–1.17, including drift-tracked, self-refreshing exports.
- Let brownfield repositories freeze known violations so strict mode blocks only new debt.
- Validate the workflow in at least three external repositories before broadening scope.

## Measurement and intelligence

- Add co-change edges for likely-omission detection.
- Build hindsight replay and graph-generated evaluation suites.
- Track constraint recall, false positives, near misses, prevention receipts, and token overhead.
- Expose enough receipt identity for orchestrators such as ORC to associate downstream verified
  outcomes with the exact Hunch delivery without requiring transcript access.

## Demand-triggered, not scheduled

Go shipped in v1.15 through exactly this policy — one registry entry, no engine changes, when a
real repository needed it. Dart remains deferred until the same signal arrives.

## Deliberately out of scope

- Generic chat or persona memory.
- An LLM proxy or pay-per-token synthesis service.
- A hosted team ACL/control plane.
- A separate wiki or codegraph authority beside the Hunch graph.
- Per-agent enforcement rules that can disagree about the same invariant.
- Cross-provider organizational context assembly; systems such as SimplyLog remain outside Hunch.
- Agent selection/routing or workflow orchestration; those belong to orchestrators such as ORC.
