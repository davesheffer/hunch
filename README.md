# Hunch

## Your repo remembers why — and teaches every coding agent how the project works.

[![npm version](https://img.shields.io/npm/v/@davesheffer/hunch?color=2742ff&label=npm)](https://www.npmjs.com/package/@davesheffer/hunch)
[![GitHub stars](https://img.shields.io/github/stars/davesheffer/hunch?color=2742ff&label=%E2%98%85%20star)](https://github.com/davesheffer/hunch)
[![license](https://img.shields.io/npm/l/@davesheffer/hunch?color=2742ff)](LICENSE)

Every new AI coding session can read your code. It cannot automatically see why your team chose
this design, which alternative already failed, what an odd-looking line protects, or how this
repository expects work to be explained and reviewed.

That is how settled decisions get reopened, fixed bugs return, and technically plausible changes
arrive feeling foreign to the project.

**Hunch is evidence-backed project intelligence for the AI coding tools you already use.** It gives
Claude, Codex, Cursor, Copilot, Windsurf, Antigravity, and other MCP clients the same durable
understanding of your codebase:

- why the code is shaped this way;
- how the repository communicates, reviews, and builds;
- what depends on the code about to change; and
- which trusted decisions, fixes, and architectural boundaries the result must preserve.

For precise rules your team has explicitly trusted, the promise is **Never Twice**: an agent may
propose a different direction, but it cannot quietly re-make a decided decision or re-introduce a
fixed failure without Hunch surfacing the conflict and its evidence.

Memory starts advisory. Nothing blocks until a human deliberately trusts a precise rule and opts
into strict enforcement.

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

`hunch init` indexes the repository, installs local lifecycle hooks, and connects supported
assistants without replacing their existing configuration. The next session receives the relevant
story with its sources, not a giant transcript or a generic prompt wall.

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

Hunch is not an agent, orchestrator, or hosted knowledge service. It is the durable reasoning and
validation layer behind the tools that write the code.

## What Hunch understands

| Layer | What it adds |
| --- | --- |
| **Engineering Memory** | Decisions, rejected alternatives, corrections, bug lineage, findings, and the rationale a future session would otherwise miss. |
| **Code Graph** | Symbols, calls, imports, dependencies, components, blast radius, and architectural reachability across TypeScript, JavaScript, Python, Go, PHP, YAML, and Helm. Memory itself works with any language. |
| **Project DNA** | Revision-specific, evidence-backed observations about how a repository communicates and works: vocabulary, contribution habits, review expectations, engineering conventions, and culture. |
| **Engineering Landscape** | Human-reviewed links from product and capability to system, repository, service, interface, data, delivery resources, runbooks, ownership, dashboards, and SLOs. |
| **Validated Delivery** | The smallest relevant evidence for the current builder, reviewer, or architect, with provenance, currentness, omissions, authority, and a content-addressed receipt. |
| **Native Change Proof** | A sealed exact-change artifact binding revisions, DNA, base/result graphs, memory, blast radius, conformance, guard verdict, and explicit gaps without granting workflow authority. |
| **Change Gate + Constitution** | Deterministic checks for trusted constraints and architectural intent. Policies are compiled, proved, inspected, and explicitly activated by a human—never promoted by an agent in the background. |

Readable JSON in `.hunch/` is the source of truth. SQLite is a fast, rebuildable projection. Git
keeps the memory portable, reviewable, and reversible.

## Project DNA: help the agent work like it belongs here

Project DNA is Hunch's evidence-bound model of **how a repository communicates and works**. It is
not a persona, does not impersonate a maintainer, and does not turn frequent behavior into policy.

The deterministic baseline reads an exact Git revision, bounded commit history, and committed
convention files. The current release can also accept bounded, caller-authorized pull-request and
review evidence. Every evidence batch is validated and sealed; raw collaboration text does not
enter the profile.

Each trait keeps its category, confidence, freshness, repository revision, and evidence hash. Hunch
can then include only the relevant DNA in normal context, explain how well a commit, PR, issue, or
message matches repository conventions, and show how the profile changed between two revisions.

```bash
hunch dna inspect
hunch dna context
hunch dna diff <older-ref> <newer-ref>
```

DNA may shape orientation, terminology, and advisory Project Match checks. It cannot create or
override a decision, constraint, finding, conformance rule, policy, or permission.

Read the [Project DNA contract](docs/project-dna.md) and the broader
[Project DNA vision](docs/project-dna-engine.md).

## Day-to-day

Most capture happens around normal commits and test failures. These commands cover the common
manual paths:

| Command | Use it for |
| --- | --- |
| `hunch context "<task>" --profile builder` | Get a bounded builder, reviewer, or architect brief before work starts |
| `hunch why <file-or-symbol>` | See the decisions, bugs, constraints, and blast radius behind code |
| `hunch structure [target]` | Inspect the indexed repository shape without repeated search rounds |
| `hunch findings [scope]` | Inherit known-but-unfixed gaps instead of rediscovering them |
| `hunch check --working` | Review the current tree against trusted project rules |
| `hunch conform` | Prove the code still satisfies recorded architectural intent |
| `hunch impact origin/main` | See the dependency and memory surface of a branch |
| `hunch compare branch-a branch-b` | Rank candidate changes by the fewest invariant and decision conflicts |
| `hunch prove origin/main --public-only` | Produce a publication-safe `hunch.change-proof/1` artifact for an exact committed change |
| `hunch landscape review` | Inspect a hash-bound repository landscape without writing authority |
| `hunch now` | See recent memory and the live decision-backed roadmap |
| `hunch escalations` | See the rare questions that genuinely require a human answer |
| `hunch doctor` | Diagnose setup, provider, index, or overlay problems |

When you are ready for deterministic enforcement:

```bash
hunch firmness strict
hunch check --staged --strict
```

That is the one moment of teeth. Captured memory cannot silently hard-block on its own.

## What changed after v1.19

The v1.19 correction-search benchmark is still useful evidence, but it no longer describes the
whole product.

- **v1.20 — one validated path from reason to result.** Role-shaped context, reviewed Engineering
  Landscape fragments, exact change identity, PHP graph support, and hash-bound ADR review moved
  source, provenance, currentness, omissions, and human authority through one delivery contract.
- **v1.21 — Project DNA.** Hunch gained deterministic, revision-specific repository profiles,
  bounded DNA context delivery, explainable Project Match checks, and auditable profile deltas.
- **v1.22 — authorized collaboration evidence.** Hosts can contribute bounded PR and review
  evidence to Project DNA through a typed, sealed contract without storing raw collaboration text
  or changing policy authority.

See the [changelog](CHANGELOG.md) for the release-by-release detail and the
[roadmap](ROADMAP.md) for what is next and deliberately out of scope.

<details>
<summary><strong>The scoped v1.19 benchmark</strong></summary>

On a preregistered 12-problem transfer, the supplemental inspection view found the changed
declaration in 6 cases instead of 3 and the correct file in 10 cases instead of 8. On a separate
12-case transfer, its progressive queue retained the same five successful finds while reducing the
average declarations to inspect from 18.9 to 11 (41.9% less).

These are bounded diagnostic results, not a claim that Hunch is universally twice as accurate.
Failed evidence and causal rerankers remain disabled; evidence can annotate the shortlist but does
not reorder it or claim an exact correction owner. The detailed receipts live in
[`bench/external/results`](bench/external/results).

</details>

## Share one living memory with your team

Hunch can keep a team's memory in a dedicated private Git repository, separate from the code. Hunch
does not host that repository. Give teammates and CI normal Git access, keep credentials in SSH or
the Git credential helper, and have one maintainer connect it:

```bash
npm i -g @davesheffer/hunch@1.23.1
hunch shared --repo git@github.com:acme/project-hunch-memory.git
git add .gitignore .hunch/team.json
git commit -m "chore: connect shared Hunch memory"
git push
```

Teammates then install the same version and run:

```bash
npm i -g @davesheffer/hunch@1.23.1
git pull
hunch init
hunch doctor
```

The committed pointer contains a credential-free repository locator and branch. The local clone,
paths, preferences, and private overlays stay ignored. MCP sessions refresh shared memory at tool
boundaries, and failed pushes are retried by a later capture or `hunch shared --sync`.

Use `hunch firmness off` to pause hook enforcement without deleting history. Use
`hunch shared --repo <url> --no-auto-commit` when captures should remain local until an explicit
`hunch shared --sync`.

## Trust boundaries that stay visible

- **Local-first.** Hunch has no hosted memory service or telemetry. The graph travels with Git and
  speaks MCP instead of belonging to one editor or model provider.
- **Private when needed.** `hunch private --repo <url>` keeps sensitive reasoning in a separate
  overlay. Local tools see the union; public CI and documentation remain public-only.
- **Human authority.** Observations, generated drafts, imported ADRs, discovered landscape records,
  and proved policy candidates do not silently become trusted truth.
- **Deterministic core.** Indexing, retrieval receipts, currentness, conformance, checks, Project
  DNA discovery, and policy evaluation do not require a model.
- **No surprise synthesis bill.** Optional drafting can use a selected Claude Code, Codex, or
  Cursor subscription CLI, a local OpenAI-compatible endpoint, or the deterministic fallback.
  Public remote endpoints require explicit `HUNCH_SYNTH_ALLOW_METERED=1` opt-in.
- **Traceable releases.** npm packages and the VS Code extension are content-addressed, verified
  against their public registries, and tied back to exact source tags.

## Learn more

- [Full documentation](https://hunch-pi.vercel.app/docs)
- [Copy-paste cookbook](https://hunch-pi.vercel.app/cookbook)
- [Project DNA](docs/project-dna.md)
- [Native change proof](docs/change-proof.md)
- [Engineering Landscape Graph](docs/engineering-landscape.md)
- [Hunch roadmap](ROADMAP.md)
- [VS Code extension](vscode-extension/README.md)
- [Architecture benchmark](bench/architectural-conformance.md)
- [Contributing](CONTRIBUTING.md)

Apache-2.0
