# Hunch roadmap

Hunch is building the validated delivery layer for engineering intent: record why the code is the
way it is, deliver the right evidence at the moment an agent needs it, and deterministically check
the resulting change. The graph is the source of truth; assistant rules, prompts, receipts, and
other integrations are derived delivery surfaces.

This file is the public execution view. `hunch now` remains the detailed live decision ledger.

## Current baseline — v1.12.2

- Architectural Conformance and decision-grounding are deterministic release gates.
- Delivery receipts show which records reached agents and which never did.
- Grounding survives helper-agent delegation and context compaction.
- Public checks exclude private overlays, and generated artifacts are drift-checked.

## Next — complete validated delivery

1. Rank every delivered record by task relevance, recency, and trusted provenance.
2. Enforce a hard context budget with a small headline tier and progressive disclosure.
3. Validate citations and currentness at delivery time; stale evidence must be omitted or labeled.
4. Extend receipts from “served” to usefulness signals: heeded, near miss, prevented, and unused.
5. Add builder, reviewer, and architect delivery profiles. Profiles may change ranking and
   presentation, never the universal enforcement graph.

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
usefulness signals beyond served/refreshed, delivery profiles, and the benchmark named above.

## Then — compile into native agent surfaces

- Generate path-scoped rules, nested `AGENTS.md`, skills, and MCP prompts/resources as
  reproducible, drift-policed artifacts.
- Deliver bug lineage at failure time with a silence policy for low-confidence matches.
- Check plans against current decisions and rejected alternatives before editing begins.

The Hunch graph remains authoritative. Generated files never become a second source of truth.

## Adoption

- Import assistant auto-memory as reviewable candidates, never immediate authority.
- Import existing MADR/ADR corpora while preserving provenance; support deterministic export.
- Let brownfield repositories freeze known violations so strict mode blocks only new debt.
- Validate the workflow in at least three external repositories before broadening scope.

## Measurement and intelligence

- Add co-change edges for likely-omission detection.
- Build hindsight replay and graph-generated evaluation suites.
- Track constraint recall, false positives, near misses, prevention receipts, and token overhead.

## Demand-triggered, not scheduled

Go is the next prepared language registry entry, but it starts only when real Go repositories or
contributors need it. Dart remains deferred.

## Deliberately out of scope

- Generic chat or persona memory.
- An LLM proxy or pay-per-token synthesis service.
- A hosted team ACL/control plane.
- A separate wiki or codegraph authority beside the Hunch graph.
- Per-agent enforcement rules that can disagree about the same invariant.
