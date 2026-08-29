# Engineering Landscape Graph

Updated 2026-08-26. This document defines Hunch's durable side of the product-to-code landscape.
The graph remains the authority for engineering semantics inside a repository; it does not make
Hunch a runtime discovery service or cross-provider orchestrator.

The reciprocal ORC contract is
[`docs/ENGINEERING-LANDSCAPE.md`](https://github.com/davesheffer/orc/blob/main/docs/ENGINEERING-LANDSCAPE.md);
the reciprocal service contract is
[Hunch Memory landscape transport](https://github.com/davesheffer/hunch-memory/blob/main/docs/ENGINEERING-LANDSCAPE-TRANSPORT.md).
ORC owns live discovery, authorized cross-repository traversal, task-scoped assembly and execution
evidence. Hunch Memory preserves one authorized store's fragment and native receipt without
reranking, following external references or owning ORC's cache. The three documents describe one
boundary from their canonical owners.

## Product outcome

A developer should be able to start from a task, file, service or product capability and learn:

- what product and capability the code serves;
- which repositories, services, interfaces and data systems participate;
- how those resources connect and which contracts bind them;
- how the system is built, tested, deployed and operated;
- which decisions, incidents, constraints and lifecycle facts govern a change; and
- which other repositories may need a coordinated change.

The repository is not the root of this model. It is one implementation node beneath product,
capability and system identity.

## Ownership boundary

Hunch owns the **declared, durable and evidenced landscape**: what should exist, why it exists and
how it is expected to relate. ORC owns the **observed and actionable landscape**: what is currently
reachable, installed, authenticated, healthy and eligible for a Run.

A practical test is:

> If the fact remains useful when every process is stopped, Hunch may own it. If it changes when a
> process starts, connects, authenticates or becomes unavailable, ORC owns it.

Hunch may record that a repository requires a CLI, configures an MCP server or deploys a service.
It must not claim that the executable is installed, the MCP handshake currently succeeds or the
service is healthy. Those are time-bound ORC observations.

## One graph, four views

The Engineering Landscape is an additive view over the existing Hunch graph, not another graph
authority.

| View | Durable questions answered by Hunch |
| --- | --- |
| Product | Which product, domain and capability does this repository implement? |
| Architecture | Which systems, repositories, components, services, interfaces and data resources connect? |
| Delivery | Which pipelines, artifacts, migrations and deployment targets carry a change? |
| Operations | Which owners, runbooks, dashboards, SLO declarations and lifecycle states govern it? |

## Resource model

Use one versioned `resource` contract with an extensible `kind`; do not create a separate storage
engine or bespoke schema for every surrounding type.

Initial kinds:

```text
product           capability        domain
system            repository        package
component         service           worker
job               api               mcp_server
cli               event             database
queue             storage           external_system
pipeline          artifact          deployment_target
environment       team_ref          runbook
dashboard
```

`team_ref`, `runbook` and `dashboard` are credential-free engineering references. Hunch does not
ingest an organization's people directory, messages or CRM and does not become an organizational
knowledge gateway.

Each resource carries at least:

```text
resource_id       stable kind-qualified identity
kind              versioned resource kind
name              human-readable name
scope             repository/product/environment scope
locator           credential-free canonical locator when available
lifecycle         planned | active | deprecated | retired
criticality       optional engineering criticality
contract_version  optional compatibility/version declaration
provenance        source evidence and capture authority
currentness       evidence timestamp/revision and validity state
metadata          bounded kind-specific fields
```

Secrets, bearer tokens, private keys, passwords and unrestricted credential material never enter
the resource, its locator, graph edges, receipts or generated agent context.

## Relationship model

Initial relationship types:

```text
provides             belongs_to          implemented_by
contains             depends_on          invokes
exposes              publishes           consumes
reads_from           writes_to           builds
tests                deploys             deployed_on
owned_by             monitored_by        governed_by
source_of_truth_for  compatible_with     replaces
```

Every relationship has its own stable identity, source/target resource IDs, provenance,
currentness and optional environment/criticality/contract metadata. Direction is explicit. A
relationship inferred from a manifest is not silently promoted to human-confirmed architecture.

Existing Hunch decisions, constraints, bugs, findings, symbols and components link to landscape
resources through the normal graph. This allows one bounded query to connect `why` evidence with
product and system topology without duplicating either record.

## Repository-local landscape fragments

Each repository publishes only the fragment it can evidence. Stable external references connect
that fragment to other repositories and systems:

```text
repository:github.com/acme/payments-api
  belongs_to       product:commerce
  implements       capability:payments
  builds           artifact:payments-service
  consumes         event:customer-events/v2
  writes_to        database:payments
  depends_on       repository:github.com/acme/identity-sdk
```

Hunch does not need every referenced repository checked out and does not recursively assemble a
global organizational graph. It preserves the durable link and evidence. ORC authorizes and
follows the link, asks the relevant repository's Hunch provider for its own fragment, and assembles
only the bounded view required by the task.

## Deterministic discovery

Hunch may derive candidate resources and relationships from repository-local, reviewable sources:

- package manifests, scripts, binaries and dependency declarations;
- MCP configuration and expected capability declarations;
- Docker, Compose, Helm, Kubernetes, systemd and deployment manifests;
- CI workflows, artifact definitions and environment templates;
- OpenAPI, AsyncAPI, protobuf and schema/migration contracts;
- Git remotes, workspace manifests and submodules;
- ownership, runbook and dashboard references; and
- explicit Hunch decisions and human-vouched corrections.

Discovery is deterministic and records source revision, file/field evidence and confidence. An
unreviewed inference remains derived/candidate evidence. Missing runtime discovery never deletes a
durable declaration automatically.

## Delivery contract

Hunch exposes a bounded landscape fragment through the existing validated-delivery envelope. The
transport must preserve:

```text
fragment version and scope
resource and relationship IDs
selection rank and reason
provenance and currentness
required/optional and blocking state
source revision/content evidence
estimated token cost
omitted-item evidence
native delivery receipt identity
```

This is now the versioned `hunch.delivery-envelope/1` contract, with a content-addressed
`hdr_*` receipt for the exact response. Its optional `hunch.landscape-fragment/1` section carries
the reviewed records themselves rather than asking a client to reconstruct them from prose. The
human-readable text and structured records share one hard caller budget; `accounted_chars`
conservatively includes each delivered landscape record as well as its headline. A relationship is
withheld unless both endpoint resources were delivered, and every budget/cap omission remains
explicit. The envelope receipt list maps one-to-one onto the selected structured records and repeats
their exact rank, delivery reason, provenance status and token charge; duplicate or substituted
entries invalidate even a newly content-addressed envelope.

The default bounded orientation target is 3–8 non-blocking landscape/decision headlines per
role-specific delivery. Mandatory blocking constraints are pinned outside that target, duplicate
IDs count once, and more items require a recorded mandatory/ambiguity reason plus explicit token
accounting. The hard caller budget and honest overflow remain authoritative.

A future `hunch landscape <target-or-task>` CLI/MCP surface may make the view explicit, but it must
reuse the graph, ranking/currentness rules and receipt machinery. It must not become a second
context envelope or ORC-specific API.

## ORC integration

```text
repository task
  -> Hunch returns the relevant durable landscape fragment
  -> Hunch Memory transports one authorized store's versioned fragment and native receipt
  -> ORC follows authorized repository/resource references
  -> ORC combines other Hunch fragments + Git + live runtime + optional providers
  -> ORC freezes a task-scoped landscape snapshot
  -> build, independent verification and execution evidence
  -> verified drift becomes a Hunch finding/proposal, never an automatic rewrite
```

ORC may report that a declared service, CLI, MCP server or contract differs from reality. Hunch
stores that mismatch only as evidenced finding/proposed knowledge until the normal authority model
accepts it. Runtime observation cannot silently rewrite architecture.

## Implementation status and handoff

HLG-1 landed as the deliberately bounded contract slice before discovery and ORC consumption:

- introduce the versioned resource contract in `src/core/types.ts` and extend the existing edge
  contract for resource relationships;
- preserve the JSON source of truth through `src/core/migrate.ts` and `src/store/jsonStore.ts`;
- rebuild resource projections through `src/store/schema.ts` and `src/store/hunchStore.ts`;
- keep resource IDs and relationship IDs stable across reindex, ordering and clean clones;
- reject credentials and unrestricted secret material before persistence or delivery; and
- cover migration, validation, deterministic identity, public/private overlays and derived-index
  reconstruction in the focused store/migration tests.

The implementation uses `hunch.resource/1` records and `hunch.resource-relationship/1` edges in
the existing JSON graph. Schema generation 3 migrates legacy edges before validation; resource IDs
remain readable and deterministic in `resources/index.json`; SQLite `resources` and
`resource_relationships` are rebuilt projections. The acceptance fixture covers a
product/capability/repository/service/API/database chain plus an external repository and verifies
exact identity, provenance and currentness across write, read, reindex and restart. It also rejects
runtime-health fields and credential material anywhere in the durable resource/relationship record.

The same fixture proves that the fragment remains useful without ORC and that no runtime
reachability or health claim is inferred from a durable declaration.

The package/Git, committed MCP and CI/deployment HLG-2 discovery slices and the explicit
review/adoption seam have landed.
`discoverRepositoryLandscape` reads a caller-selected exact commit, bounds and parses root/workspace
package manifests, canonicalizes configured and manifest-declared repository identity without
retaining credentials or host paths, and returns content-addressed `hunch.landscape-candidate/1`
resources/relationships. Evidence names the exact file/field/revision/content hash. Working-tree
bytes cannot alter an exact-revision result; repository-identity conflicts remain explicit and leave
packages unbound. One exact tree snapshot is shared across every source classifier; source families
do not repeat repository tree walks or observe different path sets. That same snapshot carries exact
blob sizes, so source families launch no separate size-check processes; only bodies within each
per-file byte limit are hydrated through bounded batches, and oversized objects are never read. It
also binds exact revision and commit time in one replacement-isolated commit snapshot instead of
launching separate repository, revision and timestamp probes. It
reads a fixed, bounded set of
project-local MCP JSON/JSONC configurations, canonical Codex TOML tables and official MCP registry
`server.json` manifests. Client declarations
produce repository dependencies; registry manifests identify repository-provided servers. Identical
descriptors merge and conflicting identities remain issues. Unrelated `server.json` files are
ignored. Commands, arguments, environment values, package arguments and credential-bearing URLs
never appear in the candidate fragment. The extractor is pure and never writes `.hunch` graph
authority.

Repository-wide API, migration, delivery and operations classifiers ignore declarations below
committed `node_modules/`, `vendor/`, `third_party/` and `third-party/` segments before applying
their caps. Dependency-owned files describe the dependency rather than the first-party repository;
they cannot manufacture candidates or crowd first-party evidence out of a bounded fragment.

Within the bounded workspace set, unique package identities now contribute exact internal
package-to-package `depends_on` candidates from `dependencies`, `devDependencies`,
`peerDependencies` and `optionalDependencies`. Multiple fields for the same pair merge as evidence;
duplicate package names remain unresolved, malformed/self dependencies are issues, and the
relationship cap is applied before candidate construction. Dependency version specifiers and
registry URLs are never retained.

Committed Git submodules contribute scoped external `repository` candidates and root-repository
`depends_on` relationships only when a bounded ordinary `.gitmodules` entry has a distinct
credential-free network identity and a matching exact-revision `160000` gitlink. Repeated target
repositories merge declaration-path and gitlink evidence. Local/relative or unsupported URLs,
self-references, duplicate/unsafe paths, missing gitlinks, malformed/oversized declarations and cap
overflow stay reviewable issues. Raw URLs, subsection labels and credentials are discarded.

Committed GitHub Actions, GitLab CI, CircleCI, Buildkite and root Jenkins declarations now produce
path-derived `pipeline` candidates. Dockerfiles produce path-derived container `artifact`
candidates, and canonical Compose files produce `deployment_target` candidates. Repository edges
remain explicit (`contains`, `builds`, `deploys`); candidates never claim that a pipeline ran, an
image exists or a deployment is healthy. Discovery validates bounded structure and UTF-8, rejects
symlinks and unsafe paths, and retains only declaration path/field/revision/content hashes—not
workflow commands, images, build arguments, environment values or service bodies.

Committed `Chart.yaml` files now contribute path-derived Helm `artifact` candidates with a
repository `contains` relationship. Discovery requires structurally valid YAML, Helm chart
`apiVersion` v1 or v2, a bounded safe name and a SemVer package version. The candidate retains only
the safe declaration path, chart contract version, exact revision and content hash; chart names,
package versions, descriptions, dependencies, repositories, values and templates never enter the
fragment. Dependency-owned paths are ignored before the shared delivery cap, and unsafe paths,
symlinks, malformed declarations and oversized files remain explicit issues.

Committed YAML under explicit Kubernetes/deployment directories now contributes path-scoped
`deployment_target` candidates for `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, `CronJob` and
`Pod` documents. Identity retains only safe `apiVersion`, kind, namespace and name; non-workload
documents are ignored, duplicate identities remain conflicts, and the declaration cap is enforced
after multi-document expansion. Committed `.service` units contribute systemd deployment targets
only when a `[Service]` section exists. Images, commands, environment values, Secret/ConfigMap data
and runtime state never enter either candidate family.

Committed OpenAPI/Swagger/AsyncAPI-named YAML/JSON, fixed `*.schema.json` and `.proto` files now
contribute family/path-stable `api` candidates after bounded UTF-8, syntax/header and version validation. The repository
relationship is only `contains`: a committed contract does not prove that this repository
implements it, serves it or has a healthy runtime. Evidence retains the declaration path, exact
revision, content hash and `openapi`/`swagger`/`asyncapi`/JSON Schema dialect version or protobuf `syntax` field; titles,
servers, channels, paths, operations, schemas, messages, fields, services, methods, options,
extensions and security bodies never enter the fragment. JSON Schema retains only recognized
2020-12, 2019-09 or draft-07 dialect identity; `$id`, properties, definitions and examples are
discarded. Protobuf requires exactly one first
statement `proto2`/`proto3` syntax header plus lexically balanced strings/comments/braces; this is
bounded declaration identity evidence, not a compiler-validity claim. Unsupported Git modes,
unsafe paths, malformed or oversized declarations and declaration-cap overflow remain explicit
reviewable issues.

Committed `prisma/migrations/<id>/migration.sql` files, standard Flyway
`db/migration/V<version>__<description>.sql`, `U...` and `R__...` files, and conventional Rails
`db/migrate/<14-digit-version>_<name>.rb` and Django
`<app>/migrations/<number>_<name>.py` and Laravel
`database/migrations/<timestamp>_<name>.php` plus default Alembic
`alembic/versions/<revision>_<name>.py` files now contribute
path/version-stable database-migration `artifact` candidates with repository `contains`
relationships. Evidence keeps only the safe path, framework, migration type/version, exact
revision and content hash; SQL/Ruby/Python/PHP bodies, inferred tables, dependencies or revision edges, target database identity, execution state
and schema effects never enter the fragment. Empty, oversized, unsupported-mode and excess
declarations remain explicit reviewable issues.

For GitHub repositories, the precedence-selected `.github/CODEOWNERS`, root `CODEOWNERS` or
`docs/CODEOWNERS` file can now contribute repository-wide team ownership candidates. Discovery
uses only the last global `*` rule, normalizes and bounds `@organization/team` references, and
emits `team_ref` resources with repository `owned_by` relationships. It ignores path-specific
rules, individual handles and email owners, and retains no comments or declaration body. Invalid
UTF-8, oversized files, unsupported Git modes and excess teams are explicit issues; an unsafe
higher-precedence file cannot silently fall through to a lower-precedence one.

Committed root `RUNBOOK.md` and Markdown/MDX files below explicit `runbook/` or `runbooks/`
directories now contribute path-stable `runbook` candidates with repository `contains`
relationships. README/index files are ignored. Evidence retains only the safe path, exact revision
and content hash; headings, procedures, incident data and body text never enter the fragment.
Empty/non-UTF-8, unsafe-path, unsupported-mode, oversized and excess declarations are explicit
issues, and symlinks are never followed.

Committed JSON objects below explicit `dashboards/` directories contribute path-stable `dashboard`
candidates with repository `contains` relationships. Evidence retains only the safe path, exact
revision and content hash. Dashboard titles, UIDs, panels, queries, variables, datasource names,
links and complete JSON bodies never enter the fragment. Invalid/non-object/non-UTF-8, unsafe-path,
unsupported-mode, oversized and excess declarations are explicit issues; symlinks are never
followed and dependency-owned dashboard directories are ignored before the cap.

Single-document OpenSLO v1 YAML/JSON under explicit `slo/`, `slos/` or `.openslo/` directories, or
with conventional SLO filenames, contributes path-stable `slo` candidates after the required
`apiVersion: openslo/v1`, `kind: SLO` and `metadata.name` structure is confirmed. Repository
relationships remain `contains`; a declaration does not prove that a target is measured, met or
enforced. Evidence retains only the path, contract version, exact revision and content hash. Names,
services, indicators, objectives, targets, queries, labels and alert policies are discarded.
Malformed/non-UTF-8, unsafe-path, unsupported-mode, oversized and excess declarations remain
explicit issues; symlinks are never followed and dependency-owned declarations are ignored before
the cap.

`hunch landscape review` now exposes the exact revision, complete content-addressed candidate set,
discovery hash and bounded issues without creating `.hunch` graph state. `hunch landscape adopt`
requires that reviewed discovery hash, an explicit reviewer label, either the full set or exact
candidate hashes, and acknowledgement when issues exist. Adoption re-runs discovery at the named
revision, verifies every candidate and envelope hash, refuses unknown/duplicate selections,
requires both endpoint resources for a selected relationship, and fails rather than overwriting a
different curated graph record. Accepted records shed candidate authority, become current and
human-confirmed, retain the candidate/discovery/review identities in bounded metadata, flow through
the ordinary public/private/shared capture boundary, and return a native
`hunch.landscape-adoption-receipt/1`. Retrying the same exact fragment reuses its accepted records
instead of duplicating them.

When the repository advances but the reviewed resource identities remain stable, the operator can
explicitly pass `--all --refresh-reviewed`. This is not a general overwrite switch: Hunch re-runs
discovery for every older exact revision named by the conflicting records, requires the same
repository identity, recomputes the prior full-fragment review identity, reconstructs the prior
human-confirmed form, and compares the complete stored bytes. Only an unchanged record that is
proven to be the output of that prior adoption may be
replaced by the newly hash-bound review. Missing Git history, a hand edit (even one retaining copied
landscape metadata), a partial candidate selection, same-revision conflicts, foreign-repository evidence, and more than the bounded
prior-revision proof limit remain fail-closed. The ordinary command without
`--refresh-reviewed` keeps the original no-overwrite behavior.

HLG-2 is therefore complete at the bounded repository-discovery and explicit-adoption boundary.

HLG-3 is complete at the reviewed-delivery boundary. `assembleContext` now selects a deterministic,
target-oriented fragment from current records whose discovery candidate and adoption review
identities are intact. Exact/task matches, the repository root and one-hop reviewed neighbors are
ranked under the bounded orientation cap. When a reviewed root exists, one resource slot is reserved
for it so consumers can bind the fragment to a repository even under a crowded task match; the
displaced resource remains explicit omission evidence. Candidate, unreviewed, stale and retired landscape
records never acquire delivery authority through lexical relevance. The canonical envelope carries
the selected resource and relationship records, selection and delivery receipts, review/discovery
hashes, exact source revisions, omission evidence and one content-addressed fragment hash. CLI,
MCP and edit-time injection all use that same envelope; MCP advertises the structured contract and
the served ledger records the exact resource/relationship headlines that reached the caller.
The exported validator independently proves the receipt list is a unique exact mapping to those
records, rather than accepting matching list counts alone.
Historical `as_of` requests deliberately withhold the current landscape until resource records have
valid-time semantics, preventing current topology from leaking into a historical response.

The focused HLG-3 acceptance covers deterministic replay, candidate/stale exclusion, tamper
detection, endpoint withholding, tiny hard budgets, structured MCP schema publication, a
plain-English task path and served-ledger evidence.

HLG-4's initial drift-intake boundary is complete. A strict,
content-addressed `hunch.landscape-drift-candidate/1` accepts only credential-free evidence of one
observed repository identity mismatch. Its deterministic conversion produces only an open,
medium-severity advisory Finding with exact candidate provenance. It cannot create or rewrite a
resource, relationship, currentness claim, constraint, decision or policy rule. ORC remains the
authority for the actual provider observation and Hunch Memory remains only the separately
authorized store transport.
ORC's aligned execution snapshot
explicitly rejects `hunch.landscape-candidate/1` and requires an accepted, current fragment plus its
native receipt before execution authority can be frozen.

## Non-goals

- live service health, MCP handshakes, installed CLI versions or authenticated sessions;
- secret or connection management;
- cloning, opening, mutating or coordinating foreign repositories;
- global cross-provider context assembly;
- workflow, agent/model or deployment routing;
- an organizational people/content warehouse; or
- a second graph beside the existing Hunch graph.

## Acceptance milestone

Given a task or repository target, Hunch can return a revision-current, budgeted and receipted
fragment connecting product → capability → system → repository → service/interface/data/delivery
resources, including declared cross-repository references and the relevant decisions/constraints.
The same fragment remains client-agnostic and useful without ORC; ORC can consume it without
reconstructing identity or provenance from prose.
