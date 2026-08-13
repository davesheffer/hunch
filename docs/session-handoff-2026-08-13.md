# Session handoff — 2026-08-13

## Current state

- `main` is `9e7d57f8537204d8c4c131679c7cfa3eb6bdf0f6`.
- PR [#61](https://github.com/davesheffer/hunch/pull/61) merged the provenance-aware delivery envelope as `79e2e457911de89491d1378597c5089d46082d05`.
- PR [#62](https://github.com/davesheffer/hunch/pull/62) merged the v1.13.0 release metadata as `9e7d57f8537204d8c4c131679c7cfa3eb6bdf0f6`.
- Annotated tag `v1.13.0` resolves to that exact release commit.
- npm `latest` is `@davesheffer/hunch@1.13.0`, with an integrity digest and SLSA provenance attestation.
- The post-merge [main CI run](https://github.com/davesheffer/hunch/actions/runs/31706774363) and tagged [release run](https://github.com/davesheffer/hunch/actions/runs/31707605643) completed successfully.

## What shipped

- CLI, MCP, and edit hooks now use one deterministic delivery envelope.
- Delivered memory is checked for currentness and packed into one hard context budget.
- Active blocking constraints cannot be silently discarded by an undersized caller budget.
- Delivery receipts record the exact record ID, rank, delivery reason, provenance status, and estimated token cost.
- Existing machine-local receipt databases migrate additively.
- Documentation, decision, and retired-code supplements compete inside the same budget.
- The public roadmap and release-facing documentation now describe the v1.13.0 baseline.

## Verification receipts

- PR and post-merge CI passed on Node 22 and Node 24.
- Native/platform safety passed on Windows and macOS.
- Hunch Architectural Conformance passed 7/7.
- The tagged release validator built and attested the exact tarball before the isolated OIDC publisher received it.
- A fresh public-registry install reported package and CLI version `1.13.0` and contained `dist/core/delivery.js`.
- `npm audit signatures` verified 102 registry signatures and 11 attestations in the clean smoke install.

The local Windows full gate did not produce a pass receipt. It reached the explicit outer limit while actively running the known slow team CLI-spawn cluster:

```text
command timed out after 1804019 milliseconds
```

The eight checkout-scoped child processes left by that timeout were stopped, and the release branch was re-verified clean. The authoritative GitHub PR, post-merge, and immutable-tag gates all passed afterward.

## Workstation reconciliation

The original checkout is still at `6b9110c73b7aca0319e4feaaaf0a749d145e9ee3` with 26 dirty paths. Do not commit that tree:

- 19 paths are byte-identical to released `main`.
- `CONTRIBUTING.md` differs only by line endings.
- The remaining six differences are older release-facing metadata that predates v1.13.0.
- No unique unpushed product code was found there.

Use a fresh clone or the clean secondary checkout for subsequent work. The public-registry smoke directory `%TEMP%\hunch-v1.13.0-smoke-codex` may still exist because recursive cleanup was blocked by the execution environment; it contains only the temporary npm install and can be deleted manually.

Remote feature and release branches were deliberately retained; no branch deletion was part of this session.

## Open work

1. Implement bounded relevance traversal from lexical/semantic/task seeds, with depth decay and hard node/token caps. Keep Hunch as the structural graph; do not build a duplicate graph in ORC (`dec_bounded_graph_context_20260813`).
2. Add an A/B benchmark against the current one-hop retrieval path. Measure task success/recall, exploratory tool rounds, input tokens, latency, and cost before widening traversal.
3. Keep delivery profiles and usefulness signals after the bounded-retrieval benchmark; do not mix them into the first slice.
4. Re-run the clean-clone Windows sync/team cluster before resolving `fnd_d78bb24c20`; the working-repo green run alone is not sufficient evidence.
5. Review open PR [#60](https://github.com/davesheffer/hunch/pull/60), which excludes retired/closed constraints from generated Top invariants. It was not modified in this session.
6. Keep Go demand-triggered; it is prepared but is not the next validated-delivery milestone.

## Rollback

- User/package rollback: `npm install -g @davesheffer/hunch@1.12.2`.
- Source rollback: revert the relevant squash commit through a reviewed PR; do not rewrite `main` or delete the published npm version.
