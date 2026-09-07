# Project DNA Engine

Status: **repository capability shipped; organizational DNA extension planned under the deterministic-state roadmap**

## Vision

Project DNA lets an agent entering an unfamiliar repository work and communicate with evidence-backed awareness of that project's established conventions instead of behaving like a generic model-generated contributor.

It is not a prompt persona and is not limited to code style. It is a revision-aware model of how a repository's maintainers communicate, reason, review and build software.

The initial repository production path is complete. Hunch provides sealed baseline discovery, explicit host-authorized PR/review intake, explainable matching and deltas, bounded delivery and receipt-bound usefulness observations.

Previous Hunch Memory transport and ORC consumption proved the contract could survive process boundaries and another orchestrator. They are historical production evidence, not the future product topology.

The current roadmap keeps Project DNA as an engine primitive and extends the same deterministic-state ideas upward to **user, team and organization DNA** through one Hunch state graph and one shared state contract.

Read [Deterministic organizational state](deterministic-state.md) for the active architecture.

## What Project DNA captures

A repository DNA profile may contain bounded, evidence-backed traits across these layers:

1. **Communication DNA** — terminology, preferred level of detail, issue/PR language, commit conventions, recurring phrases and project-specific vocabulary.
2. **Engineering DNA** — architectural preferences, abstraction boundaries, naming/organization patterns, testing philosophy, dependency preferences and recurring implementation patterns.
3. **Review DNA** — what maintainers repeatedly request, reject, question or approve; expected evidence; common objections; preferred change scope.
4. **Culture DNA** — contribution norms, backwards-compatibility posture, documentation expectations, stability versus experimentation bias and other durable repository conventions.

Traits must distinguish observed evidence from inference. No inferred trait becomes durable authority merely because a model generated it.

## Evidence sources

Discovery uses only authorized, bounded evidence, for example:

- accepted/rejected pull requests supplied through an explicit host boundary;
- review comments/outcomes supplied through that boundary;
- commit messages and change history;
- CONTRIBUTING, AGENTS, ADR/MADR and project documentation;
- code, tests, configuration and repository structure;
- existing Hunch decisions, constraints, findings and Engineering Landscape records.

Every durable trait retains provenance, revision/currentness information, confidence and evidence identity. Sensitive/private sources preserve Hunch's existing public/private boundaries.

## Runtime flow

```text
repository evidence
      ↓
DNA discovery / candidate extraction
      ↓
evidence + provenance + confidence
      ↓
revision-bound Project DNA profile
      ↓
Hunch ranking / bounded delivery
      ↓
agent context
      ↓
code + PR + issue + review output
      ↓
Project Match evaluation
      ↓
explicit outcome evidence / candidate updates
```

Project DNA may be loaded automatically when Hunch serves repository context. It should shape presentation and task-relevant guidance without weakening universal constraints, provenance/currentness checks or deterministic gates.

## Project Match

Project Match is an explainable advisory evaluation of how well an artifact matches evidence-backed repository conventions.

It may evaluate dimensions such as:

- commit-title conventions;
- recurring repository vocabulary;
- explicit rationale expectations;
- issue-reference expectations;
- other bounded deterministic checks tied to observed traits.

The score is advisory unless a separate reviewed policy explicitly promotes a precise rule into deterministic enforcement.

Project Match must expose the traits/evidence responsible for the result. It is not proof of maintainer acceptance and is not itself causal evidence of a good change.

## Continuous learning and drift resistance

Repository DNA changes over time. Hunch therefore treats profiles as revision-specific and evidence-bound:

- traits have evidence, confidence and freshness/currentness;
- contradictory evidence creates visible reviewable state rather than silently rewriting history;
- old evidence may become stale without being deleted;
- maintainer-reviewed evidence outranks weak behavioral inference;
- no single PR, reviewer, agent run or generated output redefines project culture;
- a new exact revision produces a new sealed profile rather than mutating the old one.

This prevents a self-reinforcing style-drift loop.

## Relationship to deterministic organizational state

Project DNA is the repository-scoped DNA primitive.

The broader roadmap adds:

```text
repository DNA  -> how this repository demonstrably works
user DNA        -> explicit durable preferences/rules for one principal
team DNA        -> reviewed team working conventions
organization DNA-> reviewed organization-wide conventions/boundaries
```

All four should share core properties:

- stable identity;
- explicit scope;
- provenance;
- confidence/currentness;
- contradiction/supersession history;
- bounded delivery;
- explicit authority.

A higher scope must not silently overwrite evidence-bound repository observations. If an organization rule is authoritative, it should be represented as its own reviewed state/policy and delivered alongside repository DNA with the conflict visible.

## One-product boundary

The earlier architecture described three product roles:

```text
Hunch -> Hunch Memory -> ORC -> agent
```

That is no longer the forward architecture.

The target is:

```text
Hunch state graph
  repository/team/user/org partitions
        │
        ▼
one versioned state/delivery contract
        │
        ▼
Sofia / Codex / Claude Code / future agent
```

No separate Hunch Memory product is required to transport Project DNA, and no ORC-specific ContextAssembler owns the future consumption model.

Each agent/host remains responsible for source authorization, final prompt/context assembly and execution. Hunch supplies deterministic state and evidence through a provider-neutral contract.

## Relationship to Repository Intelligence

Project DNA answers:

> **How does this repository demonstrably communicate and work?**

A higher reasoning layer may ask:

> **Why is the repository this way, what is changing, what is risky, and what is likely to matter next?**

Those hypotheses are probabilistic. They must remain traceable and must not contaminate the evidence-bound DNA profile.

## Original milestone status

The repository capability delivered the useful first production sequence:

### DNA-1 — Contract and evidence model — complete

Versioned profile/trait identity, repository/revision scope, provenance, confidence/currentness and contradiction-safe state are implemented.

### DNA-2 — Deterministic discovery baseline — complete

Bounded discovery from committed repository evidence exists without ambient network/model dependence.

### DNA-3 — Communication and review DNA — initial production slice complete

Repository vocabulary, contribution/title conventions, rationale practice and authorized recurring maintainer expectations can be represented when bounded evidence supports them.

### DNA-4 — Engineering DNA — bounded observations only

Engineering conventions may be represented when deterministic evidence supports them. Statistical frequency is not architectural authority.

### DNA-5 — Bounded agent delivery — complete

Task-relevant DNA can be delivered through Hunch's existing budgeted context machinery.

### DNA-6 — Project Match evaluation — complete as advisory primitive

Explainable deterministic artifact checks exist without granting authority.

### DNA-7 — Continuous learning — evidence-gated only

Later outcomes may become candidates/usefulness observations; they do not automatically rewrite trusted DNA.

### DNA-8 — reusable public-profile catalog — deferred

A public/reusable cache is not required by the deterministic organizational-state pilot. Exact-revision local/current evidence remains primary.

## Post-DNA handoff

Project DNA now feeds two important directions:

1. **Native Change Proof / deterministic enforcement** — exact DNA identity may be part of the proof/context around a change without granting merge/deploy authority.
2. **Deterministic organizational state** — the same DNA principles are generalized to user/team/org scope so heterogeneous agents can act from stable reviewed conventions.

The active cross-domain pilot is Sofia, not a new ORC roadmap. Sofia should read shared state before re-deriving known organizational facts and write verified action receipts/commitments after external operations complete.

## Acceptance criteria

Repository Project DNA remains successful when:

- Hunch produces a compact, evidence-backed exact-revision profile;
- another agent consumes it without a giant transcript/prompt wall;
- relevant output better matches repository norms without superficial impersonation;
- maintainers can inspect why Hunch believes each important trait;
- stale/contradictory traits remain visible;
- the feature remains model/provider neutral; and
- no profile observation silently becomes permission or blocking policy.

The organizational DNA extension will add a separate acceptance question: can multiple agents consume the same user/team/org conventions without independently reconstructing contradictory working rules?

## Non-goals

- Generic persona cloning.
- Pretending an agent is a specific human maintainer.
- Blindly copying slang or superficial quirks.
- Treating frequency as truth.
- Letting generated agent output train the profile without an evidence/authority boundary.
- Creating another source of truth beside the Hunch state graph.
- Moving connector access or general orchestration into Hunch.
- Requiring ORC or a separate Hunch Memory product.
