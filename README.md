# Hunch

## Agents are probabilistic. Organizations need deterministic state. Hunch is the state layer between them.

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

Every employee is getting an agent. Each one reads the code, the CRM, the mail thread, the chat, and forms its own opinion about what was decided, what was done and what is still owed. Two agents, two slightly different realities. Neither is wrong. Both are guesses, made fresh, from raw material.

An organization cannot run on guesses. It runs on state: this was decided, this rule is in force, this action happened and was verified, this promise is due Thursday, this summary is current and rests on these sources. Hunch holds that state in git, refuses it when it contradicts, and delivers it to Claude, Codex, Cursor, Copilot, Windsurf, Antigravity and any other MCP client before the agent answers or edits.

**Hunch started as engineering memory for coding agents** and still is: why the code is shaped this way, which alternative already failed, what an odd-looking line protects, what depends on the code about to change, and which trusted decisions, fixes and architectural boundaries a change must preserve. The same graph now holds organizational state for operations agents too (see [Deterministic organizational state](#deterministic-organizational-state)).

## Why Hunch, not another memory layer

Memory optimizes recall. State optimizes refusal. Hunch competes for the deterministic state layer from the organizational side, and every point below is a property you can verify in this repository rather than a claim:

- **Git is the source of truth.** Every fact is a JSON file under `.hunch/`, every change a commit: diffable, PR-reviewable, revertable, mergeable, never locked in a vendor database. SQLite is only a derived index.
- **Refusal, not convergence.** One live decision per topic. A second contradicting record is refused at write time with the incumbent named, and a supersede target must still be open. Diverging writes are not merged later.
- **Organization drawers with a key per agent.** Repository, user, team and organization partitions; the bearer key resolves the principal and decides visibility before anything is looked up.
- **Receipts and commitments are facts.** What was actually done in an external system, verified or not, and who owes what by when, readable by any agent with the key.
- **Never Twice.** A human correction becomes an enforced rule, not a one-session memory. Nothing blocks until a human deliberately trusts a precise rule and opts into strict enforcement.
- **The code spoke.** Decisions, constraints and bug lineage are checked against the code deterministically, with no model in the block path. No state-layer peer has it.

## Start in five minutes

Requires Node 22.13+ and a Git repository.

```bash
npm i -g @davesheffer/hunch
cd your-repo
hunch init
hunch backfill --since 90d   # optional: seed memory from recent history
```

Reload your coding assistant, then ask a normal question:

> Why is this built this way?

`hunch init` indexes the repository, installs local lifecycle hooks and connects supported assistants without replacing their existing configuration. The next session receives the relevant story with its sources, not a giant transcript or generic prompt wall.

Lifecycle coverage depends on the harness; MCP connectivity alone does not establish automatic grounding or enforcement.

To update Hunch and configured harness pins for the current repository:

```sh
hunch update
```

Agents receive an instruction to run this when you ask **“update Hunch”** in generated Hunch guidance. Restart active harnesses afterward.

Check integrations after upgrading Hunch or switching assistants:

```sh
hunch integrations check
hunch integrations repair-pins
hunch integrations check --harness claude --probe --require mcp
hunch integrations check --harness codex --require context,edit-blocking
```

Capabilities are reported as **verified**, **advisory-only**, **unsupported** or **untested**. `--require` fails unless every named capability is verified. `mcp` is verified by a fresh-server probe; hook capabilities become verified only from lifecycle events actually delivered to Hunch's hook on the expected version within the last 30 days (machine-local evidence, the same trust level as the served ledger), so a repository whose agent has actually run shows it, and one that only has configuration does not.

Codex CLI 0.153+ gets a native lifecycle adapter (`.codex/hooks.json`: session orientation, prompt task IDs from `turn_id`, `apply_patch` pre-edit grounding and strict denial, Stop cards); project-layer hooks load only for a trusted project and must be trusted once in Codex with `/hooks`. The opt-in `--probe` verifies a fresh MCP process, not whether an existing host session or model actually followed the memory.

Use `hunch integrations check` in CI to prevent pin drift; add `--require` for capabilities your workflow cannot operate without.

## One evidence loop, not another model

```text
Git history + ADRs + corrections + tests + repository conventions
                              │
                              ▼
                  Hunch's evidence graph
                 /            │             \
      engineering memory   Project DNA   reviewed landscape
                 \            │             /
                              ▼
             role-shaped, budgeted context delivery
                              │
                              ▼
             Claude / Codex / Cursor / any MCP agent
                              │
                              ▼
                  deterministic change receipt
```

Hunch is not the agent and is not the workflow engine. The model thinks; Hunch holds deterministic, evidence-backed state about the project and validates what must remain true.

## What Hunch understands

| Layer | What it adds |
| --- | --- |
| **Engineering Memory** | Decisions, rejected alternatives, corrections, bug lineage, findings and rationale a future session would otherwise miss. |
| **Code Graph** | Symbols, calls, imports, dependencies, components, blast radius and architectural reachability across supported languages/configuration. Memory itself works with any language. |
| **Project DNA** | Revision-specific, evidence-backed observations about how a repository communicates and works: vocabulary, contribution habits, review expectations, engineering conventions and culture. |
| **Engineering Landscape** | Durable links from product/capability to system, repository, service, interface, data, delivery resources, runbooks, ownership, dashboards and SLOs. |
| **Validated Delivery** | The smallest relevant evidence for the current builder/reviewer/architect, with provenance, currentness, omissions, authority and a content-addressed receipt. |
| **Native Change Proof** | A sealed exact-change artifact binding revisions, DNA, base/result graphs, memory, blast radius, conformance, guard verdict and explicit gaps without granting workflow authority. |
| **Change Gate + Constitution** | Deterministic checks for trusted constraints and architectural intent. Policies are compiled, proved, inspected and explicitly activated by a human. |

Readable JSON in `.hunch/` is the repository-scoped source of truth. SQLite is a fast, rebuildable projection. Git keeps the state portable, reviewable and reversible.

## Project DNA: help the agent work like it belongs here

Project DNA is Hunch's evidence-bound model of **how a repository communicates and works**. It is not a persona, does not impersonate a maintainer and does not turn frequent behavior into policy.

The deterministic baseline reads an exact Git revision, bounded commit history and committed convention files. The current release can also accept bounded, caller-authorized pull-request/review evidence. Every evidence batch is validated and sealed; raw collaboration text does not enter the profile.

Each trait keeps its category, confidence, freshness, repository revision and evidence hash. Hunch can include only the relevant DNA in normal context, explain how an artifact matches repository conventions and show profile change between revisions.

```bash
hunch dna inspect
hunch dna context
hunch dna diff <older-ref> <newer-ref>
```

DNA may shape orientation, terminology and advisory Project Match checks. It cannot create or override a decision, constraint, finding, conformance rule, policy or permission.

Read the [Project DNA contract](docs/project-dna.md) and broader [Project DNA vision](docs/project-dna-engine.md).

## Day-to-day

| Command | Use it for |
| --- | --- |
| `hunch context "<task>" --profile builder` | Get a bounded builder/reviewer/architect brief before work starts |
| `hunch why <file-or-symbol>` | See decisions, bugs, constraints and blast radius behind code |
| `hunch structure [target]` | Inspect indexed repository shape without repeated search rounds |
| `hunch findings [scope]` | Inherit known-but-unfixed gaps instead of rediscovering them |
| `hunch check --working` | Review the current tree against trusted project rules |
| `hunch conform` | Prove the code still satisfies recorded architectural intent |
| `hunch impact origin/main` | See the dependency and memory surface of a branch |
| `hunch compare branch-a branch-b` | Rank candidate changes by invariant/decision conflicts |
| `hunch prove origin/main --public-only` | Produce a publication-safe `hunch.change-proof/1` artifact for an exact committed change |
| `hunch landscape review` | Inspect a hash-bound repository landscape without writing authority |
| `hunch task start "<title>"` · `hunch report <id> --html` | See what Hunch contributed to a task: the lesson recalled, the agent's stated application, whether the lesson's own rule held on the changed files, and the command Hunch observed — separate evidence grades, in a local evidence view |
| `hunch now` | See recent memory and live decision-backed roadmap |
| `hunch escalations` | See questions that genuinely require a human answer |
| `hunch doctor` | Diagnose setup, provider, index or overlay problems |

When you are ready for deterministic enforcement:

```bash
hunch firmness strict
hunch check --staged --strict
```

Captured memory cannot silently hard-block on its own.

## Deterministic organizational state

Repository memory solves one version of a larger problem, and since 1.25.0 Hunch ships the larger one.

As organizations give every employee an agent that can work across CRM, email, messaging, repositories and other tools, the agents become probabilistic writers/readers of the same organization. If each one independently reconstructs what was decided, what was already done or what is still owed, the organization gets multiple conflicting realities.

Hunch is the deterministic state layer between those agents and the organization:

> **Agents are probabilistic. Organizations need deterministic state. Hunch is the state layer between them.**

The target is **one product, one authorized state graph and one versioned state contract** across repository, user, team and organization scopes.

The state it holds:

- decisions currently in force;
- verified action receipts / what was done;
- commitments and due-state;
- entities and relationships;
- code/system changes with proof;
- repository/user/team/org DNA;
- derived current state with exact dependencies/invalidation.

Agents continue to own live connector mechanics. Hunch must **not** become a managed proxy that fetches Gmail, CRM, WhatsApp or GitHub on an agent's behalf.

Instead:

```text
                  Hunch deterministic state
                        ↑       ↓
agent -> deterministic action gate -> connector -> source system
```

Hunch may hold durable state **about** external work with credential-free provenance pointers, but should not mirror raw source-system contents into a universal cache.

The first real-world pilot is **Sofia**, a working operations agent over CRM, Gmail and WhatsApp. Sofia's approved actions, follow-ups, customer/source relationships and cited summaries map naturally to action receipts, commitments, entities/relationships and dependency-bound state.

The pilot measures whether Sofia and a second, different agent stop re-deriving contradictory state when the deterministic state is delivered before they answer or act. First live number (2026-09-12, one user): after one CRM read, the next status questions were answered from held state under a receipt, 0 of 3 without a source; the [roadmap](ROADMAP.md) carries the gate table.

### The state contract, shipped

As of 1.25.0 the contract exists as code: `nuryel.state/1` — three verbs (`read` under the
delivery envelope's receipt, `write` with provenance and an idempotency key, `subscribe` to a
strictly ordered change stream) over five new record facets: action receipts, commitments,
derived state that names what it rests on, external entities and their relationships. Ids are
derived from a record's facts, a replay returns the original, a second live decision on a topic is
refused with the incumbent named, and derived state without dependencies is not state. Each scope
keeps a git-native change ledger under `.hunch/changes/`; organization, team and user partitions
are homed in an overlay, never in a repository. The MCP server binds it as `nuryel_capabilities`,
`nuryel_read`, `nuryel_write` and `nuryel_subscribe`; every other transport will call the same
store binding. Contract and evidence: [docs/nuryel-state-contract.md](docs/nuryel-state-contract.md).

As of 1.26.0 the state layer is also **served**: `hunch serve --config <file>` hosts organization,
team, user and repository partitions over HTTP on loopback with the same three verbs. A served
partition is a directory whose `.hunch/partition.json` names the scope it is; the bearer token
resolves the principal and grants come from the config only. `hunch serve init --partition
user:david --root <dir> --principal sofia@david` declares a partition and mints a token. The typed
client is `import { createStateClient } from "@davesheffer/hunch/state"`. This folds the separate
Hunch Memory service into Hunch.

As of 1.27.0 a fourth verb, `records`, lists a subject's records for the first writers, and the per-scope ledger compacts and merges across clones. As of 1.28.0 reads are a union across writers, a supersede target must still be open (two racing writers can no longer leave two current records), state records are searchable and delivered by subject, and subjects are keyed by the external record rather than by the agent. Proven on an emulated organization: three agents over ten clinics and a generated year of mail, chat and CRM, one organization drawer, 96 cited summaries, 24 verified receipts, 24 commitments, zero contradictions.

As of 1.30.0 subject identity is by external reference: one active entity per external record per partition, a subject written as an entity's external key refused with the entity id named, reads resolving one explicit hop — so two agents over one CRM record land on one subject. Replay determinism is a check, not a claim: `hunch serve replay --partition <kind:id>` (or `--root <dir>`) folds a partition's ledger into the state it implies and compares it hash for hash to the records on file, exits 1 on any divergence, runs inside `hunch drift` when the partition has a ledger, and runs on every agent-farm run; and a human correction outranks later agent writes — a record a human confirmed is never overwritten or superseded by an agent or service principal (replay, stale-with-cause and closure by receipt are the only agent moves, each keeping the human's provenance).

Read [Deterministic organizational state](docs/deterministic-state.md), the [roadmap](ROADMAP.md) and the dated [competitive landscape](docs/competitive-landscape.md).

### Naming

The product is still **Hunch**. A possible hosted-platform name, **Nuryel**, is intentionally deferred until the state contract and Sofia pilot have evidence. Rename work is not the deliverable.

## Share one living repository memory with your team

The current release can keep a team's **repository-scoped** memory in a dedicated private Git repository, separate from the code.

Today Hunch does not host that shared Git repository; teammates/CI use normal Git access and one maintainer connects it:

```bash
npm i -g @davesheffer/hunch@1.32.2
hunch shared --repo git@github.com:acme/project-hunch-memory.git
git add .gitignore .hunch/team.json
git commit -m "chore: connect shared Hunch memory"
git push
```

Teammates then install the same version and run:

```bash
npm i -g @davesheffer/hunch@1.32.2
git pull
hunch init
hunch doctor
```

The committed pointer contains a credential-free repository locator and branch. Local clone paths, preferences and private overlays stay ignored. MCP sessions refresh shared memory at tool boundaries; failed pushes can be retried by later capture or `hunch shared --sync`.

Use `hunch firmness off` to pause hook enforcement without deleting history. Use `hunch shared --repo <url> --no-auto-commit` when captures should remain local until explicit `hunch shared --sync`.

This existing Git-sharing feature is not the same thing as the planned organization/team/user state service. The roadmap extends the git-native model rather than declaring today's shared-memory repository to be an organization control plane.

## Trust boundaries that stay visible

- **Local-first today.** Repository Hunch works without a hosted service or telemetry. Git remains the repository-scoped authority.
- **Hosted state is a roadmap extension, not a shipped claim.** Organization/team/user state will require authenticated scope/visibility, idempotency and durability while preserving git-native truth.
- **Private when needed.** `hunch private --repo <url>` keeps sensitive repository reasoning in a separate overlay; public CI/documentation remain public-only.
- **Human authority.** Observations, generated drafts, imported ADRs, discovered landscape records and proved policy candidates do not silently become trusted truth.
- **Deterministic core.** Indexing, retrieval receipts, currentness, conformance, Project DNA discovery and policy evaluation do not require a model.
- **Agents own execution.** Hunch state does not silently grant connector permissions, send messages or become a source-system proxy.
- **No surprise synthesis bill.** Optional drafting can use a selected Claude Code, Codex or Cursor subscription CLI, a local OpenAI-compatible endpoint or deterministic fallback. Public remote endpoints require explicit opt-in.
- **Traceable releases.** npm packages and the VS Code extension are content-addressed, verified against public registries and tied back to exact source tags.

## What changed after v1.19

The v1.19 correction-search benchmark remains scoped evidence, but it no longer describes the whole product.

- **v1.20 — one validated path from reason to result.** Role-shaped context, reviewed Engineering Landscape fragments, exact change identity, PHP graph support and hash-bound ADR review moved source, provenance, currentness, omissions and human authority through one delivery contract.
- **v1.21 — Project DNA.** Hunch gained deterministic, revision-specific repository profiles, bounded DNA context delivery, explainable Project Match checks and auditable profile deltas.
- **v1.22 — authorized collaboration evidence.** Hosts can contribute bounded PR/review evidence to Project DNA through a typed, sealed contract without raw collaboration persistence or policy-authority change.
- **v1.23 — native change proof and proof-carrying evidence work.** Exact Git change identity, graph before/after, decisions/constraints, blast radius and Change Gate result can be bound into a sealed evidence artifact without granting authority.
- **v1.25 – v1.30 — the state layer.** `nuryel.state/1` as code, `hunch serve` partitions, union reads, subject identity by external reference, replay determinism, human corrections outranking agent writes.
- **v1.32 — see what Hunch contributed.** Task contribution reports: what was delivered, what the agent reports it applied, what a rule verified, what a command observed; concise card, local evidence view.

See the [changelog](CHANGELOG.md) for release detail and the [roadmap](ROADMAP.md) for active work.

## Learn more

- [Full documentation](https://www.hunchmemory.com/docs)
- [Copy-paste cookbook](https://www.hunchmemory.com/cookbook)
- [Turn PR review threads into scoped review rules](docs/review-memory.md)
- [Keep agent launches with the initiating provider](docs/agent-origin.md)
- [Deterministic organizational state](docs/deterministic-state.md)
- [Project DNA](docs/project-dna.md)
- [Native change proof](docs/change-proof.md)
- [The autonomy ladder](docs/autonomy-ladder.md)
- [Task contribution reports](docs/task-reports.md)
- [Autonomous development](docs/autonomous-development.md)
- [Local cookbook](docs/cookbook.md)
- [Engineering Landscape Graph](docs/engineering-landscape.md)
- [Hunch roadmap](ROADMAP.md)
- [VS Code extension](vscode-extension/README.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [Contributing](CONTRIBUTING.md)

Apache-2.0