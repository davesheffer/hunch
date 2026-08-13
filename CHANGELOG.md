# Changelog

## 1.13.0 — 2026-08-13

### Truthful, provenance-checked delivery envelopes

CLI, MCP, and edit-hook context now share a deterministic ranked headline envelope. It checks
record anchors and decision-commit reachability, withholds definitively stale records, packs to the
requested context budget, and returns the exact delivered IDs used by the machine-local receipt
ledger. Active blocking constraints are never silently discarded when a requested budget is too
small; the envelope reports that exceptional overflow explicitly.

Edit-hook decision, documentation, and retired-code grounding now competes inside that same hard
budget instead of overflowing after packing. Delivery receipts add rank, delivery reason,
provenance/currentness status, and estimated token cost, with an additive migration for existing
machine-local ledgers and the fields available from `hunch served --json`.

## 1.12.2 — 2026-08-12

### Grounding that reliably reaches Windows agents

Generated hook commands now execute correctly under PowerShell, cmd, and sh, and rerunning
`hunch init` replaces the broken form instead of installing a duplicate. Architectural Conformance
also tolerates the exact tagged-template escape shape that TypeScript accepts but the underlying
grammar rejects, without weakening fail-closed handling for real syntax errors.

The release gate now includes public-only memory drift, so it verifies the same graph and grounding
a fresh contributor clone receives. See the [complete release history](https://hunch-pi.vercel.app/changelog)
for v1.12.1 delivery receipts and v1.12.0 delegation/compaction coverage.

## 1.9.0 — 2026-07-22

### One living engineering memory for the whole team

Hunch can now connect a codebase to a dedicated private Git repository that holds the team's
decisions, corrections, constraints, policies, and proofs. Commit the generated
`.hunch/team.json` pointer once; a fresh clone running `hunch init` validates and connects its own
ignored local memory clone, and connected MCP sessions refresh at tool-request boundaries.

Shared captures commit and synchronize automatically by default. Concurrent structured records
merge deterministically, public-only checks exclude the shared graph, and strict checks refuse to
pass on a stale or unverified team route. Corrections can be upgraded into proof-backed proposals,
but those correction proposals remain mechanically non-activatable until source-currentness safety
lands. Other policy types still gain no authority unless a human explicitly accepts them.

Release artifacts now hold the same line. The package and VS Code extension are tested before any
publisher receives credentials, the exact tested bytes are carried forward unchanged, and the
registries are checked after publication. npm releases prove the tagged source across supported
runtimes and Windows/macOS Matrix safety; VS Code v0.17.2 publishes the same VSIX to the Visual
Studio Marketplace and Open VSX.

To move an existing code repository's public Hunch records into the shared store, use
`hunch shared --repo <separate-private-memory-repo> --migrate`. Omit `--migrate` for a new setup.
Upgrade with `npm i -g @davesheffer/hunch@1.9.0`; the documented rollback keeps the memory
repository intact while disabling enforcement and automatic publication before pinning a previous
package version.

The complete release history remains available on the
[Hunch changelog](https://hunch-pi.vercel.app/changelog).
