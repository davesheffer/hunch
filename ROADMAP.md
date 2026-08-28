# Hunch roadmap

Updated 2026-08-28.

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

### Reciprocal adaptive-evolution boundary

ORC's adaptive-evolution work remains an ORC evaluation/control-plane concern. Its `CurriculumCandidate`, `ExecutionScaffoldCandidate`, `StrategyOutcome`, scaffold populations, replay tournaments, transfer measurements and promotion/retirement decisions do **not** become Hunch graph authority. See ORC's [`ROADMAP-ADAPTIVE-EVOLUTION.md`](https://github.com/davesheffer/orc/blob/main/docs/ROADMAP-ADAPTIVE-EVOLUTION.md) and [`EVAL-AND-LEARNING-LOOP.md`](https://github.com/davesheffer/orc/blob/main/docs/EVAL-AND-LEARNING-LOOP.md).

Hunch may receive a procedural finding from that loop only as a reviewable evidence-bearing candidate after ORC has independently verified it and shown reproducible applicability/transfer. Promotion into durable Hunch knowledge still requires Hunch's normal provenance, contradiction/currentness and review rules. Raw generated challenges, speculative scaffold variants, reward/score history and a single winning Run remain outside Hunch. Conversely, Hunch may supply revision-current decisions, constraints, failure lineage and structural features to ORC as evidence/context, but it never selects the winning scaffold or grants execution authority.

The next shared Hunch/ORC contract is the [Engineering Landscape Graph](docs/engineering-landscape.md).
Hunch publishes durable, repository-evidenced landscape fragments; ORC's reciprocal
[`ENGINEERING-LANDSCAPE.md`](https://github.com/davesheffer/orc/blob/main/docs/ENGINEERING-LANDSCAPE.md)
owns authorized cross-repository traversal, live discovery and task-scoped assembly. Hunch Memory's
reciprocal [transport contract](https://github.com/davesheffer/hunch-memory/blob/main/docs/ENGINEERING-LANDSCAPE-TRANSPORT.md)
preserves the fragment and native receipt without owning ranking, traversal or ORC caching.

## Engineering Landscape Graph — in progress

The repository is one implementation node, not the root of a developer's world. Hunch will extend
its existing graph so a bounded query can connect product → capability → system → repository →
service/interface/data/delivery resources and the decisions, constraints, incidents and lifecycle
facts that govern them.

1. **HLG-1 — versioned resource and relationship contract. DONE (2026-08-21).** Stable
   kind-qualified resource IDs and directional relationship IDs now extend the existing JSON graph;
   lifecycle, credential-free locators, provenance/currentness, forward migration and rebuildable
   SQLite projections are covered by the focused landscape fixture.
2. **HLG-2 — deterministic repository fragment discovery. DONE at the bounded repository
   discovery/adoption boundary (2026-08-26; package/Git/internal
   workspace dependencies/submodules, committed MCP,
   CI/deployment, Helm chart, OpenAPI, AsyncAPI, protobuf, JSON Schema, Prisma, Flyway, Rails,
   Django, Laravel and Alembic migration, CODEOWNERS ownership, committed runbook, JSON dashboard
   and OpenSLO v1 declaration slices landed through 2026-08-26).**
   `discoverRepositoryLandscape` now reads one exact Git revision and emits bounded,
   content-addressed candidate resources/relationships for root/workspace packages, canonical
   credential-free Git remotes, supported MCP declarations, major committed CI formats,
   Dockerfile build artifacts, Docker Compose targets, structured Kubernetes workloads, systemd
   service units and Helm chart packages. Evidence retains only safe file/field/revision/content
   identity; declaration
   bodies, commands, images, environment values and credentials never enter the fragment.
   Additional explicitly bounded declaration sources remain.
3. **HLG-3 — bounded landscape delivery. DONE (2026-08-26).** Return task-relevant resources, relationships and linked
   Hunch reasoning through the existing ranking, budget, currentness and native receipt envelope;
   add an explicit CLI/MCP view only as a projection over that machinery. Freeze the additive
   envelope before Hunch Memory implements transport; the service must preserve IDs, source/graph
   evidence, omissions and the native receipt byte-for-byte or by canonical hash.
4. **HLG-4 — cross-repository references and drift intake. INITIAL DRIFT INTAKE COMPLETE
   (2026-08-26).** Preserve stable external repository and contract references. A strict,
   content-addressed `hunch.landscape-drift-candidate/1` records credential-free identity evidence
   for one real mismatch and can become only an open advisory Finding. ORC owns live observation
   and Hunch Memory owns isolated transport; neither path rewrites the graph, currentness,
   constraints, decisions or policy.

Done means a repository can publish a revision-current, receipted landscape fragment that remains
useful to any Hunch client, while ORC can assemble multiple authorized fragments without duplicating
Hunch's graph or making Hunch a runtime/control plane.

### HLG-1 implementation status

The first executable contract slice is implemented without adding orchestration. It preserves the
frozen Hunch/ORC ownership boundary and all later documentation and ledger history from `main`:

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

`hunch.resource/1` records and `hunch.resource-relationship/1` edges preserve the JSON source of
truth, schema generation 3 forward-migrates legacy edges before validation, and derived
`resources` / `resource_relationships` tables rebuild from public plus authorized private homes.
The acceptance fixture proves deterministic identity and direction, secret/runtime-claim rejection,
legacy migration, exact write/read/reindex/restart behavior and overlay isolation.

The first **HLG-2** source slice is implemented by `src/extractors/landscapeDiscovery.ts`. It scans
only an exact commit, bounds manifests, ignores non-workspace packages, canonicalizes Git/provider
identity without retaining credentials or local paths, and returns explicit
`hunch.landscape-candidate/1` wrappers. Conflicting repository declarations leave package candidates
unbound; neither discovery nor ORC may treat them as accepted graph authority.

Package discovery also resolves unique package names across the bounded workspace set and emits
package-to-package `depends_on` candidates for internal dependencies declared in `dependencies`,
`devDependencies`, `peerDependencies` or `optionalDependencies`. Duplicate package identities stay
unresolved, malformed/self dependencies are issues, and the edge set is capped before candidate
construction. Version specifiers and registry URLs never enter the fragment.

Committed Git submodule discovery reads only a bounded ordinary `.gitmodules` blob at the exact
revision and requires a matching `160000` gitlink. Credential-free network targets become scoped
external `repository` candidates with root-repository `depends_on` relationships; repeated target
repositories merge their path and gitlink evidence. Local/relative or unsupported URLs,
self-references, duplicate/unsafe paths, missing gitlinks, malformed/oversized declarations and cap
overflow remain issues. Raw URLs, subsection labels and credentials never enter the fragment.

The committed MCP declaration slice now reads `.mcp.json`, Cursor, VS Code JSONC, Windsurf,
Antigravity, plugin and canonical Codex TOML configurations plus official registry `server.json`
manifests. Project-client declarations emit repository `depends_on` relationships; registry
manifests emit repository `provides` relationships. Discovery merges identical declarations,
leaves conflicts unresolved, ignores unrelated `server.json` files and never returns stdio
commands, arguments, environment values or credential-bearing URLs. Exact revision and content
evidence remain visible without echoing the configuration body.

The first delivery declaration slice reads GitHub Actions, GitLab CI, CircleCI, Buildkite and root
Jenkins pipelines plus Dockerfiles and canonical Docker Compose files. It emits path-derived
`pipeline`, `artifact` and `deployment_target` candidates with repository `contains`, `builds` and
`deploys` relationships. YAML must parse and expose the provider's required root field; Docker and
Jenkins declarations require only their bounded structural marker because Hunch does not interpret
commands. Symlinks, unsafe paths, malformed/oversized files and declarations beyond the fixed cap
remain explicit issues. No image, command, argument, environment or service-body value is returned.

The structured deployment slice recognizes workload documents in committed `k8s/`, `kubernetes/`,
`manifests/` and `deploy/` YAML plus committed `.service` units. Kubernetes identity is
path-scoped and derived only from a supported workload's `apiVersion`, `kind`, namespace and name;
non-workload documents are ignored, unsafe/templated identities are issues, and duplicate workload
identity remains unresolved. Systemd units require a real `[Service]` section and expose only their
safe committed unit path. The 128-declaration cap applies after multi-document expansion, so one
large manifest cannot manufacture an unbounded fragment.

The API/schema slice recognizes only committed OpenAPI/Swagger/AsyncAPI-named YAML/JSON, fixed
`*.schema.json` and `.proto` files, validates exactly one supported top-level contract
version/header and emits
family/path-stable `api` candidates with a repository `contains` relationship. It retains no title,
server, channel, message, field, service, method, option, path/operation body, extension value or
runtime claim; JSON Schema `$id`, properties, definitions and examples are also excluded. Unsafe
paths, unsupported modes, malformed/oversized declarations and cap overflow remain explicit issues.
Protobuf detection requires one first-statement proto2/proto3 syntax header and balanced lexical
structure but does not claim compiler validity. The first migration slice recognizes only committed
`prisma/migrations/<id>/migration.sql` conventions. The second recognizes Flyway's standard
`db/migration/V<version>__<description>.sql`, undo `U...` and repeatable `R__...` filenames. The
third recognizes conventional Rails `db/migrate/<14-digit-version>_<name>.rb` files; Django,
Laravel and Alembic add their strict default numbered/timestamped/revision-file conventions. These
families emit path/version-stable database-migration `artifact` candidates and never retain SQL,
Ruby, Python or PHP bodies or infer dependencies, revision edges, a target database, execution
status or schema effect.
Empty, malformed-mode, oversized and
cap-overflow declarations remain explicit issues. The immediate next HLG-2 handoff is another
source family under the same bounded envelope or an explicitly designed candidate-review/adoption
seam.

The first ownership slice follows GitHub's CODEOWNERS location precedence and reads only the last
repository-wide `*` rule. It emits credential-free `team_ref` candidates and repository `owned_by`
relationships only for `@organization/team` owners. Path-specific rules, individual handles,
emails, comments and the declaration body are discarded. Unsupported modes, invalid UTF-8,
oversized files and team overflow remain reviewable issues; a higher-precedence unsafe file never
falls through to a lower-precedence declaration.

The first operations slice recognizes a root `RUNBOOK.md` plus Markdown/MDX files below explicit
`runbook/` or `runbooks/` directories (excluding their README/index files). It emits path-stable
`runbook` candidates and repository `contains` relationships while retaining only the path, exact
revision and content hash. Runbook headings, procedures, incident details and credential-like body
text never enter the fragment. Empty/non-UTF-8, unsafe-path, unsupported-mode, oversized and excess
files remain explicit issues, and exact-revision discovery never follows a runbook symlink.

The dashboard slice recognizes JSON objects below explicit `dashboards/` directories and emits
path-stable `dashboard` candidates with repository `contains` relationships. Evidence retains only
the safe path, exact revision and content hash; titles, UIDs, panels, queries, variables, datasource
names, links and the complete JSON body are discarded. Invalid/non-object/non-UTF-8, unsafe-path,
unsupported-mode, oversized and excess declarations remain issues, and symlinks are never followed.

The SLO slice recognizes single-document OpenSLO v1 `kind: SLO` YAML/JSON under explicit `slo/`,
`slos/` or `.openslo/` directories plus conventionally named SLO files. It emits path-stable `slo`
candidates with repository `contains` relationships after checking the required OpenSLO header and
`metadata.name`. Evidence retains only the safe path, `openslo/v1` contract identity, exact revision
and content hash; names, services, objectives, indicators, targets, queries, labels and alert policy
bodies are discarded. Invalid/non-UTF-8, unsafe-path, unsupported-mode, oversized and excess
declarations remain issues, dependency-owned files are ignored before the cap, and symlinks are
never followed.

HLG-3 begins only after candidate review/adoption preserves identity and provenance through the
existing delivery receipt. Hunch still does not claim live runtime health, cross-repository
traversal or a new CLI/MCP surface. HLG-1 is closed by accepted decision `dec_a6d088f409`; the live
roadmap anchor is `roadmap.engineering-landscape-hlg-2` (`dec_9130451387`).

## Current baseline — v1.19.0

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
  Imported live ADRs remain advisory until a human answers the inline, exact-hash approve/decline
  question; unchanged re-imports preserve that answer and changed bytes require a fresh one.
- Go joins TypeScript, JavaScript, and Python in the symbol/dependency graph (v1.15); YAML anchors,
  aliases, and chart-scoped Helm helper references join it in v1.18.
- Retrieval ranks recorded intent above vocabulary-sharing code symbols — a bounded prior, never
  an exclusion (curated benchmark Recall@10 70% → 90%, MRR 0.402 → 0.575).
- Public positioning leads with the guarantee — agents never re-make a decided decision, never
  re-introduce a fixed bug — across the site (five languages) and README.

### Included in v1.18

- Retrieval-quality floors now gate the curated benchmark against a disposable fresh graph, so
  the ranking win cannot silently erode as the graph grows and clean CI clones cannot skip it.
- The MCP publication scanner's `vocabularyCache` is keyed by store instead of process-global.
- `HUNCH_PRIVATE_DIR` keeps its compatibility-sensitive precedence, but a real redirection away
  from repo-local configuration is queryable and warned on CLI/MCP stderr; bypassing an advertised
  team store is also explicit.
- HLG-1's versioned resource/relationship contract and the first exact-revision HLG-2 discovery
  slice are implemented under the ownership boundary above; candidate discovery still grants no
  graph authority.
- Root-level indexed files use exact component paths rather than a match-everything glob.

Still near-term: freshness/staleness scoring for decisions feeding context ranking only — never
authority.

## Next — close the Infection PHP and ADR audit

<!-- hunch:topic roadmap.infection-pilot-remediation dec_587ce6a081 -->

The pinned public-history audit of `infection/infection` exposed two gaps that local fixtures did
not: Hunch saw only 27 YAML files while omitting 1,823 tracked PHP files, and ADR import lost real
lifecycle meaning. This work is deliberately one acceptance gate rather than separate parser demos.

Completed in the implementation milestone:

- ADR import excludes `0000-template.md`, imports all 13 real records (including
  `0002-@covers-annotations.md`), accepts Infection's nested status sections, preserves proposed and
  superseded states, and resolves explicit ADR successors without treating issue `#1760` as one.
- A machine-readable receipt binds every ADR to its pinned path, SHA-256, introduction commit,
  date, imported ID, lifecycle, successor and representative retrieval query.
- Day-to-day review is chat-native: session orientation and `hunch_escalations` ask about one exact
  imported ADR at a time, while the MCP write tool and CLI both reject stale hashes. Approval grants
  human authority; decline stays advisory; silence does nothing.
- PHP is a native `LanguageSpec`: namespaces, classes, interfaces, traits, enums, functions,
  methods, Composer PSR-4 identities, imports/includes, conservative calls and static type
  relationships enter the existing graph. Dynamic dispatch remains unresolved rather than guessed.
- Exact-revision coverage is frozen for Infection (1,822/1,823 PHP files parsed; the only exclusion
  is a tracked outside-repository symlink) and a second repository, Composer (622/622 PHP files).
- PHP participates in changed-file history, `structure`, bounded `path`/impact queries and the
  correction-source scan. The `@final` probe remains a shortlist with exact-owner claims disabled;
  scanning the language is not presented as an accuracy result.

The final deterministic rerun is now published in `bench/infection/audit-v1.json`. It reproduced the
complete PHP graph, current-over-superseded retrieval order, structure/path/impact/shortlist probes,
and exact Git-history bindings for all 12 PHP files changed by the pinned commit. The live CLI audit
also caught and fixed a misleading template warning: `0000-template.md` was excluded correctly but
was falsely described as malformed. A human reviewer then signed the complete 13-record corpus and
approved all 10 live imported ADRs through their exact source and mapped-meaning hashes. The 3
historical records remain historical. No closure gate remains for this audit item.

The original failed audit remains the regression fixture. The signed final receipt, rather than a
green unit suite or parser alone, closes this roadmap item.

### Next validation — one real Infection issue or PR, reviewed blind

The corpus and graph audit proves deterministic coverage; it does not prove that the resulting
orientation saves a maintainer time on a real change. Before using Infection as an accuracy or
adoption claim, ask an Infection maintainer to select one current issue or pull request and freeze
the selection before seeing Hunch's result.

For that exact target, publish a bounded review packet containing:

1. the issue/PR identity, repository revision and changed-file set used for the run;
2. Hunch's current ADR matches, dependency paths, blast radius and advisory inspection shortlist;
3. the complete omissions and uncertainty statement, including unresolved dynamic dispatch;
4. a timestamped hash of the packet created before maintainer feedback; and
5. the maintainer's later assessment of useful hits, misses and false leads, kept separate from the
   frozen Hunch output.

Done means a maintainer can compare the blind packet with project knowledge without being asked to
trust a demo. One successful case remains a pilot, not an accuracy percentage; a weak result stays
published and becomes the next measured improvement target.

## Then — complete validated delivery

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

The role-specific delivery checkpoint is complete (2026-08-28). Builder, reviewer and architect
profiles share the same `hunch.delivery-profile/1` policy and canonical envelope. They reorder only
non-blocking evidence and presentation; blocking invariants remain mandatory and first, and all
profiles preserve the same provenance/currentness and abstention gates. Each profile admits at most
eight non-blocking record headlines, reports every `profile-cap` omission, seals the selected
profile/policy into the receipt, and records both fields in the additively migrated local served
ledger. CLI `hunch context --profile ...`, MCP `hunch_context(profile: ...)` and edit hooks use the
same implementation.

The squash-stable change-identity checkpoint is complete (2026-08-28). `hunch.change-identity/1`
hashes the exact raw Git tree delta, so a branch range and a squash commit with the same base/tree
transition share `hchg_*` identity despite different commit metadata. Whitespace, paths, modes and
binary blob identities remain exact; Git's looser stable patch ID is advisory interoperability only.
The sealed contract is available through `hunch change-id`, `hunch_change_identity`, and optional
receipt-bound usefulness attribution.

The first service loop is complete. Hunch Memory verifies the exact store-scoped issuance, validates
and idempotently retains `hunch.usefulness-observation/1`, and exposes privacy-safe aggregate
coverage. ORC derives feedback only from eligible terminal outcomes, preserves the exact receipt and
record identities, and delivers it without granting ranking, promotion, policy or enforcement
authority. Contradiction and staleness still create only open advisory findings.

Fused task-relevance ranking is already implemented: lexical, optional semantic and bounded graph
signals are rank-fused, then constrained by liveness, trusted provenance, recency and topic-chain
successor priors with regression floors. Patch/change IDs and role profiles are now complete.
Still open is the intentionally evidence-gated OEL-4 experiment: replay the current policy against
retained usefulness signals and publish the benchmark named above. Aggregate coverage remains its
gate—known, unknown, evidence-backed and per-signal counts must establish a meaningful baseline
before usefulness can influence ranking. Until then, retained observations have zero ranking,
promotion or authority effect.

## Later — compile into native agent surfaces

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
- Accept adaptive-loop procedural discoveries only as reviewable candidates with source outcome,
  verification, applicability/currentness and contradiction evidence; never ingest a raw ORC
  scaffold population, synthetic-task reward or single-run winner as durable Hunch truth.

The versioned authority, evidence, usefulness and promotion boundary for that loop is frozen in
[the ORC outcome/experience protocol](docs/outcome-experience-protocol.md).

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
- ORC curriculum generation, scaffold populations, reward/score storage or strategy promotion;
  Hunch stores only reviewed durable engineering knowledge that survives those external gates.
