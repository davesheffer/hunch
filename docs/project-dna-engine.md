# Project DNA Engine

Status: **P1 strategic initiative — production implementation in progress across Hunch, Hunch Memory and ORC**

## Vision

Hunch should learn and adopt the engineering DNA of a repository so an agent entering an unfamiliar project behaves and communicates like a contributor who already understands that project, rather than sounding like a generic Claude-, Codex-, or model-generated contributor.

Project DNA is not a prompt persona and is not limited to code style. It is an evidence-backed, revision-aware model of how a repository's maintainers communicate, reason, review, and build software.

The initial cross-product production roadmap is complete as of 2026-08-31. Hunch provides sealed
baseline discovery, explicit host-authorized PR/review intake, explainable matching and deltas;
Hunch Memory provides isolated immutable transport; and ORC provides authorized, role-shaped
consumption with exact receipts. The frozen Infection acceptance profile and the three-repository
harness cover repository scale, delta propagation, isolation, malformed input and service fallback.
The milestone list below remains the long-horizon product model, not a claim that speculative
persona cloning, automatic policy learning or a public profile marketplace is required for the
production contract.

The capability should extend Hunch's existing graph, provenance, currentness, delivery, and memory contracts rather than create a parallel source of truth.

## What Project DNA captures

A repository DNA profile may contain bounded, evidence-backed traits across these layers:

1. **Communication DNA** — terminology, tone, preferred level of detail, issue/PR language, commit conventions, recurring phrases and project-specific vocabulary.
2. **Engineering DNA** — architectural preferences, abstraction boundaries, naming and organization patterns, testing philosophy, dependency preferences, error-handling conventions, and recurring implementation patterns.
3. **Review DNA** — what maintainers repeatedly request, reject, question, or approve; expected evidence; review strictness; common objections; and preferred change scope.
4. **Culture DNA** — contribution norms, backwards-compatibility posture, documentation expectations, appetite for refactors, stability versus experimentation bias, and other durable repository-specific conventions.

Traits must distinguish observed evidence from inference. No inferred trait becomes durable authority merely because a model generated it.

## Evidence sources

Discovery should use only authorized, bounded repository evidence, for example:

- accepted and rejected pull requests;
- review comments and review outcomes;
- issues and maintainer discussions;
- commit messages and change history;
- CONTRIBUTING, AGENTS, ADR/MADR and project documentation;
- code, tests, configuration and repository structure;
- existing Hunch decisions, constraints, findings and Engineering Landscape records.

Every durable DNA trait must retain provenance, revision/currentness information, confidence, and the evidence that supports it. Sensitive/private sources must preserve the existing Hunch public/private-store boundary.

## Runtime flow

```text
repository evidence
      ↓
DNA discovery / candidate extraction
      ↓
evidence + provenance + confidence
      ↓
reviewed Project DNA profile
      ↓
Hunch ranking / bounded delivery
      ↓
agent context
      ↓
code + PR + issue + review output
      ↓
Project Match evaluation
      ↓
new evidence / candidate updates
```

Project DNA should be loaded automatically when Hunch serves context for that repository. It should shape presentation and task-relevant guidance without weakening universal constraints, provenance checks, currentness checks, or deterministic conformance gates.

## Project Match Score

Introduce an explainable **Project Match Score** for generated contributions. It estimates how well an output matches the repository's known DNA across relevant dimensions such as communication, engineering conventions, review expectations, and contribution culture.

The score is advisory unless a future reviewed policy explicitly promotes a specific dimension to enforcement. It must expose the traits/evidence responsible for the result rather than returning an opaque model score.

The goal is not imitation for its own sake. The goal is to catch contributions that are technically plausible but obviously foreign to the repository's established way of working.

## Continuous learning and drift resistance

Repository DNA changes over time. Hunch must therefore treat DNA as revision-aware and self-correcting:

- traits have evidence, confidence and freshness;
- contradictory evidence creates reviewable findings/candidates rather than silently rewriting history;
- old evidence can decay in relevance without being deleted;
- maintainer-reviewed evidence outranks weak behavioural inference;
- multiple competing hypotheses may coexist until evidence resolves them;
- no single PR, reviewer, agent run or generated output should redefine project culture.

This prevents Project DNA from becoming a self-reinforcing style drift loop.

## Relationship to Hunch Memory

Project DNA is a Hunch semantic capability, not a second memory product. Hunch's graph remains authoritative. Hunch Memory may transport/store the profile and its evidence under existing isolation contracts, but it must not invent, rank, promote, or rewrite DNA independently.

## Relationship to Repository Intelligence

Project DNA answers:

> **How does this repository think, communicate, review, and build?**

Repository Intelligence is the higher reasoning layer that can use DNA plus Hunch's existing evidence to ask:

> **Why is the repository this way, what is changing, what is risky, and what is likely to matter next?**

The intended stack is:

```text
Hunch evidence + memory
        ↓
Project DNA
        ↓
Repository Intelligence / evidence-backed hypotheses
        ↓
validated, repository-native agent behaviour
```

Repository Intelligence must not contaminate Project DNA with unsupported hypotheses. DNA remains evidence-grounded; higher-order inference remains explicitly probabilistic and traceable.

## Milestones

### DNA-1 — Contract and evidence model

Define a versioned Project DNA trait/profile contract with stable identity, repository/revision scope, provenance, confidence, freshness, contradiction state, and public/private-store semantics. Reuse existing Hunch graph primitives wherever possible.

### DNA-2 — Deterministic discovery baseline

Build bounded candidate extraction from high-signal committed sources first: contribution docs, ADRs, repository structure, tests, commit conventions, and existing Hunch records. Add GitHub discussion/review evidence only through an explicit authorized intake boundary.

### DNA-3 — Communication and review DNA

Extract repository vocabulary, contribution tone, PR conventions, review expectations, recurring maintainer objections, and evidence expectations. Keep observations traceable to exact source evidence.

### DNA-4 — Engineering DNA

Add architectural and implementation conventions derived from code/history plus accepted Hunch knowledge. Avoid turning statistical frequency into architectural authority without evidence.

### DNA-5 — Bounded agent delivery

Deliver task-relevant DNA through Hunch's existing role-shaped, currentness-checked, hard-budgeted context envelope. Agents should receive only DNA relevant to the current task and role.

### DNA-6 — Project Match evaluation

Create an explainable evaluator for code/PR/issue/review output. Benchmark whether it predicts maintainer objections and reduces obviously foreign contributions without forcing superficial stylistic mimicry.

### DNA-7 — Continuous learning

Use later maintainer outcomes as evidence-bearing candidates. Add contradiction handling, confidence/freshness updates, and protection against self-generated feedback loops.

### DNA-8 — Reusable DNA cache/library

Only after the repository-local model is validated, explore reusable/cached DNA profiles for public repositories. Cached DNA must remain revision-bound and refreshable; it never overrides local/current evidence.

## Acceptance criteria

Project DNA is successful when, on a repository unfamiliar to the agent:

- Hunch can produce a compact, evidence-backed DNA profile;
- another agent can consume it without needing a giant transcript or prompt wall;
- generated PR descriptions, implementation choices and review responses measurably match repository norms better than the same agent without DNA;
- maintainers can inspect why Hunch believes each important trait;
- stale or contradictory traits are visible rather than silently reinforced; and
- the feature works across Claude, Codex and future agents without becoming model-specific.

## Non-goals

- Generic persona cloning.
- Pretending an agent is a specific human maintainer.
- Blindly copying slang or superficial writing quirks.
- Treating frequency as truth.
- Letting generated agent output train the repository profile without an evidence/authority boundary.
- Creating another source of truth beside the Hunch graph.
- Moving agent routing or orchestration ownership from ORC into Hunch.
