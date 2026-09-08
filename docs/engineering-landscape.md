# Engineering Landscape Graph

Updated 2026-09-07.

The Engineering Landscape is Hunch's durable, evidence-backed model of the resources surrounding a repository: product, capability, system, repository, service, interface, data, delivery and operations relationships.

The original repository-local implementation is shipped. The forward architecture no longer assigns live traversal to ORC or transport to a separate Hunch Memory product. Those integrations remain historical evidence; the current boundary is between **durable state** and the **live agent/runtime layer**.

Read [Deterministic organizational state](deterministic-state.md) for the active product direction.

## Product outcome

A developer or agent should be able to start from a task, file, service, product capability or organizational entity and learn, within authorized scope:

- what product/capability the code serves;
- which repositories, services, interfaces and data systems participate;
- how those resources connect and which contracts bind them;
- how the system is built, tested, deployed and operated;
- which decisions, incidents, constraints and lifecycle facts govern a change;
- which other resources may need coordinated work; and
- which durable external-work facts are relevant without copying raw source-system content into Hunch.

The repository is one implementation node, not necessarily the root of the model.

## Ownership boundary

Hunch owns the **durable, evidenced landscape/state**: facts that should remain useful when every agent and connector process is stopped.

The live agent/runtime layer owns **ephemeral operational observations**: what is currently reachable, installed, authenticated, healthy, connected or temporarily available.

A practical test is:

> **If the fact should remain useful when every process is stopped, Hunch may own it. If it changes merely because a process connects, authenticates or becomes unavailable, the live layer owns it.**

Examples:

- Hunch may record that a repository declares an MCP server, deploys a service or depends on an external API.
- A live agent may observe that the executable is installed, the MCP handshake currently succeeds or the API is healthy.
- Hunch may record a verified receipt that a deployment occurred.
- Hunch should not pretend a service is currently healthy because it was healthy when a prior agent checked it.

This boundary is agent-neutral. Sofia, Codex, Claude Code or another orchestrator may perform live discovery; none becomes the permanent owner of the durable graph.

## One graph, multiple scopes

The Engineering Landscape is an additive view over Hunch's existing graph, not another graph authority.

Repository scope remains git-native in `.hunch/`. The deterministic-state roadmap may add organization/team/user partitions to the same served graph.

Useful views include:

| View | Durable questions |
| --- | --- |
| Product | Which product, domain and capability does this resource implement or serve? |
| Architecture | Which systems, repositories, components, services, interfaces and data resources connect? |
| Delivery | Which pipelines, artifacts, migrations and deployment targets carry a change? |
| Operations | Which owners, runbooks, dashboards, SLO declarations and lifecycle states govern it? |
| Work state | Which customer/incident/commitment/change entities are durably related to this engineering resource? |

## Resource model

Use one versioned `resource` contract with an extensible `kind`; do not create a bespoke storage engine for every surrounding type.

Representative engineering kinds:

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

The organizational-state roadmap extends the same identity/relationship pattern to non-code entities such as customers, incidents, commitments and source references. Those should be separate typed entities/records rather than pretending every business object is an engineering resource.

Each resource carries at least:

```text
resource_id       stable kind-qualified identity
kind              versioned resource kind
name              bounded human-readable name
scope             repository/product/environment/organization scope
locator           credential-free canonical locator when available
lifecycle         planned | active | deprecated | retired
criticality       optional engineering criticality
contract_version  optional compatibility/version declaration
provenance        source evidence and capture authority
currentness       evidence timestamp/revision and validity state
metadata          bounded kind-specific fields
```

Secrets, bearer tokens, private keys, passwords and unrestricted credential material never enter resources, locators, graph edges, receipts or generated context.

## Relationship model

Representative relationship types:

```text
provides             belongs_to          implemented_by
contains             depends_on          invokes
exposes              publishes           consumes
reads_from           writes_to           builds
tests                deploys             deployed_on
owned_by             monitored_by        governed_by
source_of_truth_for  compatible_with     replaces
```

Every relationship has stable identity, source/target IDs, provenance, currentness and optional bounded metadata. Direction is explicit.

A relationship inferred from a manifest is not silently promoted to human-confirmed architecture.

Existing Hunch decisions, constraints, bugs, findings, symbols, components, proofs and future organizational state may link to landscape resources through the normal graph.

## State about external work

The earlier boundary said Hunch did not ingest CRM/messages and was not an organizational knowledge gateway. The refined boundary is more precise:

**Hunch may hold durable state about external work, but should not mirror source-system content or become the source-system proxy.**

For example, Hunch may hold:

```text
entity: customer/example-customer
entity: crm-event/10017
relationship: customer/example-customer -> crm-event/10017
commitment: obtain-site-budget-tables
changed: repository/change-proof/<id>
relationship: crm-event/10017 -> change-proof/<id>
source pointer: gmail-thread/<opaque-id>
```

The CRM/Gmail/WhatsApp systems remain authorities for their own records. A live agent such as Sofia resolves those pointers when fresh source content is needed.

Credential-free provenance pointers, source versions/hashes and bounded evidence are preferred over raw mail bodies, private chat transcripts or copied CRM payloads.

## Repository-local landscape fragments

Each repository should publish only the fragment it can evidence.

Example:

```text
repository:github.com/acme/payments-api
  belongs_to       product:commerce
  implemented_by   capability:payments
  builds           artifact:payments-service
  consumes         event:customer-events/v2
  writes_to        database:payments
  depends_on       repository:github.com/acme/identity-sdk
```

A referenced repository does not need to be checked out locally for Hunch to preserve the durable reference.

Under the current direction, following that reference is a live-agent concern. The agent authenticates to whatever source is required, obtains authorized state/evidence and can ask the Hunch state service for other partitions it is allowed to see.

Hunch itself should not recursively log into repositories/services to manufacture a global graph.

## Deterministic discovery

Hunch may derive candidate resources and relationships from repository-local, reviewable sources such as:

- package/workspace manifests and dependency declarations;
- MCP configuration and expected capability declarations;
- Docker, Compose, Helm, Kubernetes and systemd declarations;
- CI workflows, artifact definitions and environment templates;
- OpenAPI, AsyncAPI, protobuf and schema/migration contracts;
- Git remotes and submodules;
- ownership, runbook, dashboard and SLO references;
- explicit Hunch decisions and human-vouched corrections.

Discovery is deterministic and records exact source revision/file/field evidence. An unreviewed inference remains candidate/derived evidence.

Missing runtime discovery never deletes a durable declaration automatically.

## Safety rules for discovery

Repository discovery is deliberately bounded:

- exact committed revision only for deterministic baseline discovery;
- no arbitrary command execution;
- no retention of secret-bearing URLs or environment values;
- no assumption that a declaration means a resource is currently healthy;
- malformed/oversized/ambiguous declarations remain explicit issues;
- discovery does not grant authority to mutate the graph unless a separate adoption/review path allows it.

These rules survive the deterministic-state expansion.

## Delivery contract

Landscape state is delivered through Hunch's validated-delivery machinery.

A useful fragment should preserve:

```text
fragment version and scope
resource and relationship IDs
selection/rank reason when applicable
provenance and currentness
required/optional/blocking state
source revision/content evidence
budget/omission evidence
native delivery receipt identity
```

The existing `hunch.delivery-envelope/1` and `hunch.landscape-fragment/1` contracts remain repository primitives.

The future state contract may wrap or reference them as sub-schemas; it should not force clients to reconstruct structured landscape facts from prose.

## Cross-scope authorization

Organization-scale landscape/state introduces a new requirement that repository-local Hunch did not need to solve fully: a principal may be allowed to see some partitions/records and not others.

The state service must therefore support:

- token -> principal -> authorized scope resolution;
- no caller-selected arbitrary filesystem path;
- per-record visibility where a shared scope mixes sensitivities;
- public/private repository semantics preserved;
- no leakage of credential-bearing source pointers;
- delivery receipts that make omissions/scope visible without exposing hidden records.

## Relationship to Sofia

Sofia is a useful first non-code consumer/writer.

Sofia may:

1. resolve a customer in CRM;
2. write a durable customer entity and credential-free source pointers;
3. relate the customer incident to a repository/service from the Engineering Landscape;
4. create a commitment/receipt after a verified external action;
5. allow an engineering agent to read the incident relationship before changing code;
6. link a shipped Change Proof back to the incident;
7. later read the complete chain to close the customer commitment.

Hunch should not fetch the CRM record on Sofia's behalf. It serves and validates the durable relationship/state.

## Shipped repository foundation

The initial Engineering Landscape implementation already established the important engine pieces:

- versioned resource and relationship records;
- deterministic identities;
- credential-safe locators;
- exact-revision repository declaration discovery;
- bounded delivery through the native receipt envelope;
- migration/reindex behavior with JSON authority and rebuildable SQLite projections;
- candidate discovery across package/workspace dependencies, Git submodules, MCP declarations, CI/deployment declarations, APIs/schemas/migrations, ownership, runbooks, dashboards and SLO declarations.

The old ORC/Hunch Memory production integration proved external transport and multi-process consumption. The new roadmap keeps the primitives and changes the product ownership/topology.

## Non-goals

- a live infrastructure health monitor inside Hunch;
- a connector gateway that logs into CRM/Gmail/WhatsApp/GitHub for agents;
- raw organizational message warehousing;
- a second global graph database that overrides git-native authority;
- ORC-specific resource semantics;
- automatic promotion of discovered declarations into human authority;
- hiding missing/unauthorized evidence behind synthesized prose.
