# Changelog

## Unreleased

## 1.20.2 — 2026-08-29

### Snapshot deletion is durable without risking source

Private and shared memory sync now carries stale JSON record deletions after first proving that the
memory overlay is a standalone Git repository distinct from the protected code repository. This
closes the durability gap where a graph snapshot was correct on disk but an obsolete per-record
component remained in remote history and left the local memory repository dirty.

The boundary stays fail-closed: public-repository deletion, `local.json`, derived artifacts,
non-JSON paths, copies, type changes, and anything outside the exact Hunch subtree are still
refused. Snapshot ID churn is inspected as an exact add plus delete instead of trusting Git's
heuristic rename presentation.

## 1.20.1 — 2026-08-29

### Reviewed landscapes stay current safely

A reviewed Engineering Landscape can now be re-reviewed at a newer exact Git revision without
weakening the no-overwrite guard. `hunch landscape adopt --all --refresh-reviewed` replays the prior
full review from immutable history, proves the exact stored bytes and repository identity, and then
replaces only those proven adoption records.

Partial selections, hand edits, forged review IDs, missing history, same-revision conflicts, and
foreign repositories remain fail-closed.

## 1.20.0 — 2026-08-28

### One verified memory path from reason to result

Stable 1.20 promotes the complete release-candidate line to npm's `latest` channel. Reviewed
repository landscapes and role-shaped context travel in Hunch's native, content-addressed delivery
envelope; an exact code change can then be bound to later usefulness evidence without allowing that
evidence to grant ranking, promotion, policy, or enforcement authority.

PHP repositories and existing ADR corpora now enter the same graph and lifecycle model as the rest
of the codebase. Bulk graph snapshots make that practical on production-sized repositories, while
source, provenance, currentness, omissions, and review state remain explicit throughout delivery.

### Assistant instructions now use the real context argument

Generated grounding now documents `hunch_context(target)`, matching the MCP schema, so an agent can
copy the signature without sending an invalid `target_or_task` argument. Existing managed grounding
files self-heal on refresh. Fixed #95.

### Config safety checks now cover config writers, not local Git hooks

The raw-write guard remains blocking for the modules that merge user MCP, provider, and grounding
configuration, but no longer flags the marker-based local Git hook installer. Fixed #94.

### Shared decisions no longer disappear behind a transient pull backoff

An already-running MCP process now rechecks shared team memory before claiming that an exact topic
has no current decision. A transient Git failure may still leave known local decisions readable,
but an unconfirmed miss is an explicit error rather than a false “never captured” answer; once the
store recovers, the same client bypasses backoff and receives the teammate's decision without a
restart.

## 1.20.0-rc.6 — 2026-08-28

### Delivery adapts to the work without changing authority

Hunch now seals `builder`, `reviewer`, and `architect` delivery profiles into every native receipt.
Profiles only reorder and cap nonblocking material; blocking constraints remain first and mandatory,
and provenance, currentness, abstention, and authority rules are identical across roles. The CLI,
MCP surface, hooks, and Hunch Memory bridge share the same versioned policy.

### Outcomes bind to the exact tree change

The new `hunch.change-identity/1` receipt hashes Git's raw tree delta, including paths, modes,
whitespace, and binary changes, while ignoring commit messages, authors, and squash metadata.
Usefulness observations may carry that independently validated receipt, giving downstream outcome
analysis an exact change boundary without granting ranking, promotion, or execution authority.

## 1.20.0-rc.5 — 2026-08-28

### Outcome evidence can return without silently becoming authority

Hunch now owns the strict, content-addressed `hunch.usefulness-observation/1` contract. One terminal
episode, exact Hunch Memory receipt, and delivered record identity produce one deterministic key;
changed content under that key conflicts instead of becoming a second observation. The seal binds
the episode, provider-native receipt hash, graph/source revision, record revision/content hash,
bounded evidence references, and retention window while excluding transcripts and provider output.

Every usefulness signal declares zero ranking, promotion, policy, or enforcement effect. Only
contradiction and staleness can be converted into a new open advisory Finding, so outcome evidence
creates review work without rewriting trusted knowledge. The contract is independently exercised
through Hunch Memory's store-scoped issuance proof before that service enables its intake capability.

### Infection evidence is signed and the next validation is blind

The pinned Infection audit now has one content-bound final receipt covering the real ADR corpus,
PHP graph, retrieval order, behavioral probes, Git-history participation, and explicit remaining
limitations. The 13-record corpus is human-signed, all 10 live imported ADRs carry hash-bound human
approval, and the 3 historical records remain historical. Corpus templates are also excluded
without the former false "malformed filename" warning.

The roadmap now requires the next Infection checkpoint to run on a fresh real Issue/PR whose target
and expected answer were not used to build the feature. This separates implementation fixtures from
transfer evidence and prevents a polished replay from being presented as independent validation.

## 1.20.0-rc.4 — 2026-08-27

### PHP repositories enter the production graph

PHP now uses the existing native Tree-sitter graph pipeline instead of a parallel index. Hunch
extracts namespaces, classes, interfaces, traits, enums, functions and methods; resolves safe
Composer PSR-4 identities, namespace imports, includes, conservative calls and type relationships;
and reports per-language eligible, parsed and skipped coverage. Type relationships now participate
in path and impact queries, whose bounded BFS avoids the exponential simple-path enumeration exposed
by Infection's 45,792-edge graph. The correction-source scan also includes production PHP while
keeping exact-owner claims disabled.

Pinned acceptance receipts cover Infection (1,822/1,823 PHP files parsed, with one tracked external
symlink rejected) and Composer (622/622), including graph behavior and explicit uncertainty.

### ADR import preserves corpus lifecycle and provenance

ADR import now handles nested Markdown sections, safe `@` filenames, reference links, prose
alternatives and explicit successor references without confusing issue numbers for ADRs. Corpus
templates are excluded, source bytes and first-introduction commits are recorded, and successor
dates close historical validity windows deterministically. The complete 13-record Infection receipt
is checked in and intentionally remains pending human sign-off.

Imported live ADRs now enter the graph as advisory memory and surface as plain approve/decline
questions during normal assistant sessions, one at a time. The answer is bound to both the exact
source bytes and the complete mapped decision meaning: approve adds human-confirmed authority,
decline records review while keeping the memory advisory, silence changes nothing, and changed
source or importer semantics reopen the question. CLI and MCP use the same review state.

## 1.20.0-rc.3 — 2026-08-27

### Exact graph snapshots no longer rewrite dense indexes once per record

Snapshot producers can now replace one routed capture kind in a validated bulk operation while
preserving Hunch's single-home collision rules. This removes quadratic JSON work for array-backed
symbols and edges without weakening immutable-source scanning, atomic writes, shared-store routing,
or fail-closed currentness. On the 667-file ORC production tree, the Hunch Memory pilot derived and
persisted 5,247 symbols plus 16,051 edges in 28.1 seconds locally; the previous production path
spent about 55 minutes repeatedly rewriting those arrays.

## 1.20.0-rc.2 — 2026-08-27

### The release candidate reports what actually happened

When the selected synthesis provider exits successfully without returning a draft, Hunch can fall
back to its deterministic local synthesis. The result now names that fallback as the provider that
actually produced the draft instead of incorrectly crediting the silent provider. The release also
removes a dependency-audit exception automatically once its formerly vulnerable package is no
longer present, so an obsolete allowlist cannot linger unnoticed.

The reviewed engineering-landscape transport introduced in rc.1 is otherwise unchanged.

## 1.20.0-rc.1 — 2026-08-26

### Reviewed engineering landscapes become a transportable contract

Hunch can now discover bounded, credential-free landscape candidates from an exact Git revision,
show them for review, and adopt only an explicit human-confirmed fragment. Replaying the same
fragment is idempotent; changed content requires a new review; candidate, stale and retired records
never become delivery authority. Reuse compares the complete reviewed record with the
candidate-derived value, so copied review metadata cannot hide changed resource bytes.
Bounded selection now reserves a reviewed repository-root slot when one exists and records the
displaced task match as an omission, allowing consumers to bind source identity without increasing
the selection cap. The later hard token budget remains authoritative and may still omit items.

`hunch.delivery-envelope/1` now carries a deterministic, token-budgeted
`hunch.landscape-fragment/1` with exact resources, relationships, review/discovery provenance,
currentness and a content-addressed `hdr_*` receipt. The exported validator recomputes the native
receipt and fragment hashes and rejects altered scope, ranks, selections, omissions, evidence or
budget accounting. It also proves a unique one-to-one mapping from every landscape record to its
exact delivery rank, reason, provenance status and token charge. CLI and MCP review/adopt surfaces
use the same contract.

This release candidate is the first package version that Hunch Memory can feature-detect for the
reviewed landscape transport. Hunch still owns durable reviewed structure; Memory only transports
one authenticated store's native envelope; ORC/Nuryel validates and freezes it before use. No layer
may turn discovery candidates or provider prose into authority.

## 1.19.0 — 2026-08-26

### The release evidence is visible where people install

The GitHub and npm README now put the preregistered correction-search results near the install path:
changed-declaration coverage moved from 3/12 to 6/12, correct-file coverage from 8/12 to 10/12,
and the progressive plan retained the same five hits while inspecting 41.9% fewer declarations.
The copy keeps the evidence boundary explicit: these are narrow transfer results, evidence remains
annotation-only, and Hunch does not claim universal 2× accuracy or an exact correction owner.

The public site now carries the same measured release card, the stable installation path, and
localized v1.19 release/changelog surfaces. Version 1.19.0 promotes the tested rc.1 implementation
to npm's `latest` channel without changing its frozen algorithms or experiment receipts.

## 1.19.0-rc.1 — 2026-08-25

### Evidence-bounded correction search

`hunch shortlist` now preserves its flat top five while adding repository-adaptive correction-stage
ranking, file-anchored semantic declaration families, and a bounded progressive inspection queue.
On a preregistered 12-case transfer, the supplemental cluster view found 6/12 changed declarations
versus 3/12 for the flat shortlist (+25 percentage points) and raised correct-file coverage from
8/12 to 10/12. On a separate 12-case transfer, the progressive queue retained all 5 full-cluster
hits with zero losses while reducing mean inspection from 18.9 declarations to 11 (41.9% less).

`hunch evidence-map` compiles authenticated red/green probe, execution, and intervention receipts
into a read-only map. Fresh transfers did not establish execution or intervention influence as a
reliable exact-owner signal, so evidence remains annotation-only: it cannot reorder the shortlist,
and exact-owner and per-case confidence output remain disabled. The preregistrations, frozen
predictions, positive receipts, and rejected follow-ups are retained under `bench/external/results`.

### Reasoning that must meet evidence

Delivery now abstains from low-confidence or task-irrelevant memory and emits at most two testable
hypotheses. The agent pipeline can compile bounded executable obligations across runtime, static,
serialization, and compatibility contracts, normalize tool outcomes, require a real pre-edit
baseline, and track proof closure after edits. These controls fail open when no valid proof plan is
provided and do not turn advisory memory into blocking authority.

## 1.18.1 — 2026-08-22

### Deprecated ADRs no longer invent successors

`hunch import-adr` now distinguishes a bare `deprecated` lifecycle from an explicit replacement.
A named successor still closes the decision window; without one, Hunch keeps the imported record
visible as advisory accepted memory, preserves the raw lifecycle in provenance, and emits a warning
asking for an explicit successor or rejection instead of silently fabricating history.

## 1.18.0 — 2026-08-22

### YAML and Helm enter the graph

YAML anchors are now symbols and aliases are reference edges, so configuration dependencies
participate in blast radius without pretending to be function calls. Helm helper definitions and
`include` / `template` uses are extracted only inside the nearest `Chart.yaml` scope; duplicate
names in separate charts and unrelated languages do not fabricate edges. `.tpl` files and
Helm/Jinja-templated YAML remain indexable before rendering, while invalid ordinary YAML still
fails closed and GitHub Actions `${{ }}` expressions are not mistaken for Helm syntax.

The merge also fixes two graph-integrity seams surfaced by YAML: root-level files now belong to an
exact-file component instead of a repository-wide `./**` glob, and call attribution keys on a
symbol's stable array position so overlapping synthetic YAML/Helm symbols cannot collapse at byte
zero. YAML and Helm support was contributed by Oliver Sampson and reconciled with the current Go,
HLG, and schema-generation contracts before release.

### A repository becomes a versioned landscape fragment

The Engineering Landscape Graph begins as an additive view over the existing source of truth.
Stable kind-qualified resource IDs, directional relationship IDs, lifecycle, credential-free
locators, provenance/currentness, forward migration, and rebuildable SQLite projections now have
an executable contract. The first bounded discovery slice reads an exact Git revision and emits
reviewable package/workspace and canonical Git-remote candidates with field-level evidence; it
does not write authority, retain credentials or local paths, or make Hunch an orchestrator.

Retrieval benchmark floors now run against a disposable fresh graph, publication vocabulary caches
are store-scoped, and effective private/team memory routing is explicit in diagnostics. These close
silent-regression and cross-repository contamination paths without changing enforcement authority.

## 1.17.0 — 2026-08-18

### The projection notices when it rots

Exported ADR corpora can now adopt a content-hash manifest and participate in normal drift and
healing. Hunch distinguishes a decision that moved (`madr-stale`), a generated file changed by a
human (`madr-edited`), and an artifact whose public decision disappeared (`madr-orphan`), with a
separate repair path for each. Adopted corpora refresh during post-commit sync, and edit protection
is keyed by content so renumbering cannot erase a hand edit.

Retrieval also gives recorded intent a bounded ranking prior over code symbols that only share the
query vocabulary. The prior improved the curated Recall@10 result from 70% to 90% and remains
reversible with `HUNCH_MEMORY_PRIOR_SHIFT=0`.

## 1.16.0 — 2026-08-18

### The MADR bridge

`hunch import-adr` deterministically imports MADR and Nygard corpora into the graph, preserving
accepted, superseded, and rejected semantics without duplicating records on rerun. `hunch
export-adr` emits a standard, regenerable MADR projection with Backstage metadata, refuses to
overwrite a hand-written corpus, and excludes private-overlay records. The graph remains the source
of truth.

## 1.15.0 — 2026-08-18

### Go support

Go repositories now enter the same symbol and dependency graph as TypeScript and Python through the
language registry. Structs, interfaces, type specifications, aliases, imports, and package-qualified
calls are indexed conservatively: module paths resolve exact package directories, standard-library
calls are filtered, and ambiguous edges are not invented. Prebuilt grammar support ships across the
supported platform matrix.

## 1.14.0 — 2026-08-18

### Context arrives with its graph neighborhood

Context delivery can walk a bounded, deterministic graph neighborhood with depth decay, node and
token caps, and external-hub exclusion. This raised the curated Recall@10 result from 81.8% to
90.9% without changing the response contract. The release also excludes retired constraints from
grounding, resolves MCP auto-commit roots per call, and fixes unstaged-only release-gate drift.

## 1.13.1 — 2026-08-15

### MCP delivery receipts arrive as structured data

`hunch_context` now advertises an MCP output schema and returns the canonical delivery envelope in
`structuredContent` while preserving the existing text response for older clients. Orchestrators
can consume exact delivered and omitted record IDs, rank, delivery reason, provenance/currentness,
token cost, budget use and blocking overflow without parsing prose.

Every record actually returned by MCP is also appended to the same machine-local served ledger used
by agent hooks. Budget-omitted or stale records are never receipted, and receipt persistence remains
best-effort so telemetry failure cannot block context delivery.

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
