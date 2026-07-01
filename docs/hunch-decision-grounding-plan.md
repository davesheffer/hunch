# Hunch — Decision-Grounded Drift Governance

**Build plan (consolidated).** Turn Hunch's decision graph into the authoritative source that keeps AI coding agents grounded to current decisions — and catches the moment a doc or diff contradicts one.

**One sentence:** *Authoritative, supersession-aware decision memory that keeps your AI agent grounded to current decisions — and never rots or needs manual pruning.*

> This is the single merged spec. It absorbs the former `README`, `01-architecture`, `02-decision-schema`, `03-capture-tool`, `04-heal-flow`, and `05-build-order-and-risks`. The two drop-in agent files (`/capture`, `/heal`) are preserved verbatim as [Appendix A](#appendix-a--capture-command-drop-in) and [Appendix B](#appendix-b--heal-command-drop-in).

> **Revision status — hardened v3** (two source-checking red-team passes applied in-place). **v2** closed four v1 holes: the unenforced topic-uniqueness invariant ([§4 Enforcement](#enforcement-where-the-invariant-actually-lives)), grounding on a rotted-but-high-confidence decision ([§3 freshness guards](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team)), the "falls out for free" overclaim ([§3 caveat](#the-three-drifts)), and the presence-not-quality validator ([§5](#two-build-stages)). **v3** closed the one defect the re-red-team confirmed in *shipping code* — the un-gated `hunch_record_decision` side door — by scoping it into [§7 step 1](#sequence-only-after-the-atom-demos) and the [§8-10](#8-red-team) open list (it was previously mis-booked as "Addressed"), plus a merge-hook correction, a Heal-A rubber-stamp guard, and a grounding-autonomy reconciliation. See the [§8 revision note](#8-red-team) for what is confirmed-and-fixed vs. what stays genuinely open. **Honest posture:** the plan is sound *as a costed build order*, not as a present-tense product claim — the anti-rot promise is backed only once [§4 Enforcement](#enforcement-where-the-invariant-actually-lives) is built in the store.

---

## Contents

1. [The wedge (why this, why now)](#1-the-wedge)
2. [The identity principle & automation contract](#2-the-identity-principle--automation-contract)
3. [Architecture — hub with two spokes](#3-architecture)
4. [Decision schema (canonical)](#4-decision-schema-canonical)
5. [Capture tool — `hunch_capture_decision`](#5-capture-tool--hunch_capture_decision)
6. [Heal flow — Heal A / Heal B](#6-heal-flow)
7. [Build order — the atom, then the sequence](#7-build-order)
8. [Red team — the kill shots & the gate](#8-red-team)
9. [Backwards compatibility & migration](#9-backwards-compatibility--migration)
10. [Component map to Hunch's codebase](#10-component-map)
- [Appendix A — `/capture` command (drop-in)](#appendix-a--capture-command-drop-in)
- [Appendix B — `/heal` command (drop-in)](#appendix-b--heal-command-drop-in)

**If you read one section, read [§7 Build order](#7-build-order).** It contains the atom everything is downstream of, and the risks that determine what you must *not* build yet. The single blocking task today: **make one capture write one structured decision into the graph** ([§5](#5-capture-tool--hunch_capture_decision)). Until that write exists, detection has nothing to check and grounding has nothing to inject.

---

## 1. The wedge

The decision-memory-for-code space is already contested; the gap is specific.

- **vs. CodeRabbit "Learnings"** — stores past corrections and applies them to review, but has **no supersession model**. Learnings accumulate, conflict, and rot; the documented remedy is that the user must manually hunt down and delete stale ones. **That decay is the problem Hunch removes.**
- **vs. Greptile** — builds a repo graph and *infers* conventions from past review comments. Inferred convention, not an authoritative decision log, and it competes on catch-depth at the cost of noise.

**Do not compete on catching-more.** Depth bought with false positives is the category graveyard. Compete on **memory that stays true over time** — the axis no competitor occupies.

### What this package is NOT (scope guardrails)

- **Not auto-heal-first.** Detection + grounding is the spine; autonomous prose rewriting rebuilds the poisoned well.
- **Not a semantic alarm.** Semantic inference *suggests* anchors; it never *fires* drift.
- **Not a catch-more race.** Win on memory that stays true, not on depth-via-noise.
- **Not generic doc-linting.** Drift with no governing decision is out of scope — the graph is what gives drift a right answer.
- **Not agentry-in-Hunch.** This is self-grounding for Hunch's own decision record, not a manager for arbitrary third-party components across nine tools.
- **Not a landing-page headline for the plumbing.** Reversible install/merge is table stakes — correct, not marketed.

---

## 2. The identity principle & automation contract

> **The machine holds the boundary against an authoritative record. The human authors the truth. Violations are loud, never silent.**

Veto, the config-merge guard, capture, and drift-grounding are all faces of this one principle. Any design choice that breaks it (machine deciding truth, silent rewrites, firing on a guess) is off-identity and rejected throughout this plan.

### The automation contract, in one table

| Tier | What | Human involvement |
|---|---|---|
| **Fully automated** | Detection, read-time grounding | None — fires on hooks/MCP |
| **One-tap gate** | Capture (what's a decision), heal (rewrite prose), supersession | Confirm in a moment they're already in |
| **Never automated** | Firing on a semantic guess; auto-superseding a decision | — (forbidden) |

**The resolution:** "Fully automated" as a **felt experience** ≠ "zero human" in the **mechanism**. The detection-and-grounding spine runs autonomously; the only human touch is a one-tap confirm on the things that must never be machine-decided. Per the entire competitive field, this is the *only* version of full automation that doesn't get itself muted. (One nuance grounding adds: it always *fires* autonomously, but an aged or fact-contradicted decision is served as *advisory / surface-both*, not hard authority — see [§3 freshness guards](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team). Autonomous in the firing path; not unconditional in the verdict.)

And the deeper move: you can't win the fight of keeping prose docs perpetually fresh — that's entropy. So don't. Make staleness *harmless* via grounding: the doc can stay stale-but-flagged, and the agent still gets truth because the graph is injected over it. Keep the human-written doc whole; the agent eats current truth.

---

## 3. Architecture

### The model — a hub with two spokes

Not a triangle of three equal artifacts.

- **Hub — the decision graph (authoritative).** Append-only, supersession-linked, status-bearing. This is battle-tested ADR doctrine: you never edit an accepted decision, you write a superseding one and link them. The graph *is* ground truth. Its shape is defined in [§4](#4-decision-schema-canonical).
- **Spoke — docs (derived view).** Prose the agent reads. Goes stale. Not truth.
- **Spoke — code (derived view).** The implementation. Also just a view of what the graph decided.

Because status is explicit, **drift needs no fuzzy definition**: drift is any derived view still asserting a decision the graph has marked superseded or contradicted.

### The three drifts

| Drift | What it is | How it's covered |
|---|---|---|
| **doc ≠ graph** | Doc still preaches an approach the graph superseded | **Spoke 1. Build first.** Highest harm: the agent reads the stale doc and re-does the rejected thing — and Veto never sees it enter. |
| **graph ≠ code** | Implementation contradicts a decision | **This is Veto.** Already speced (`strictgate.ts`, `regressionHits`). Reuses the same machinery. |
| **doc ≠ code** | Doc describes what the code no longer does | **Not a third detector.** If a decision governs the topic, it decomposes into the two spokes above. If none does, it's plain doc-rot with no ground truth to adjudicate — **out of scope.** |

You build **one anchor layer + two spoke-checks**, and doc≠code falls out *logically* wherever a decision governs.

> **Caveat — "logically," not "for free."** The decomposition is only as complete as its sparsest spoke. `graph≠code` (Veto) fires *only* where a human hand-authored a machine-checkable tripwire / conformance predicate (`rejected_tripwires` defaults empty; a blocker requires a `human_confirmed` tripwire). So where a decision is governed but no tripwire was written, doc *and* code can silently agree with each other and both contradict the graph — and neither spoke fires. **doc≠code coverage = "doc anchored" ∩ "code tripwired," not the union.** Real, but partial; this is a known blind spot, not free coverage (see [§8-8](#8-red-team)).

### The automation contract, placed

**Fully automate — zero human, end-to-end:**
- **Detection.** Scan docs + code, compare against the graph, flag any view asserting a superseded/contradicted decision. Nobody needs to *notice* drift. Runs on hook / commit / CI, silently.
- **Grounding (read-time injection).** *The crown jewel — autonomous in mechanism (it fires with no human turn) and safe by construction (it serves, never decides or rewrites).* Before the agent acts, inject the authoritative decision into its context over whatever the doc says. A stale doc stops mattering because the agent reads the graph over it. **Autonomy caveat (post-v2):** the [§3 freshness guards](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team) mean an *aged* decision is injected as **advisory, not hard authority**, and a doc asserting a *new external fact* triggers a surface-both — both are still autonomous outputs (no human in the firing path), but grounding is not *unconditional* graph-over-doc. **No competitor does this from an authoritative decision graph.**

**One-tap gate — machine proposes, human confirms in a moment they're already in:**
- **Deciding what is an authoritative decision.** Auto-promoting every observed correction into a binding decision poisons the graph. Gate it inside capture ([§5](#5-capture-tool--hunch_capture_decision)).
- **Heal / rewrite.** Never silent. Split by *what is actually stale* ([§6](#6-heal-flow)). Machine-generated prose is always a separate, explicit confirm.
- **Supersession.** Human-authored and linked, never machine-guessed ([§4](#4-decision-schema-canonical) §conflict).

**Never automate:**
- **Hard-blocking on a *semantic* guess.** That is firing into the graveyard. Semantic matching may *suggest*; it may never *fire*.
- **Auto-superseding a decision.** The machine never decides which decision is current.

### The anchor system

Every drift check needs one join: *how does Hunch know doc-section-X, decision-#47, and code-region-Z are about the same topic?* That linkage **is** the feature; everything else is plumbing.

**Decision: explicit topic anchors, graph-seeded, human-confirmed. Semantic inference suggests only.**

Every mature traceability system (ADR ↔ code linking, doc-block ↔ code anchors, "covers" paths) uses *declared* links, not inference. Rationale by cost:

- **Explicit anchors** bill you in **discipline** — honest and bounded: the system protects what's tagged and is upfront it can't protect what isn't.
- **Semantic inference** bills you in **false positives** — paid in the currency Hunch can least afford. The first false "your doc is stale" alarm teaches the user to ignore every future alarm.

**The flip that collapses the discipline cost toward zero:**

1. **Seed the graph side for free.** Every decision written by the capture tool ([§5](#5-capture-tool--hunch_capture_decision)) gets its topic anchor *at capture* — model-proposed, human-confirmed in the flow they're already in. This anchors the authoritative side at ~zero marginal cost.
2. **Anchor doc/code by suggestion, not tax.** Semantic inference *proposes* — "this section looks like `auth-transport` — anchor it? [y/n]." Being wrong on a suggestion costs one keystroke; being wrong on an alarm costs the moat.
3. **Confirmed anchors persist and compound.** Pay the confirm once per artifact, not per check. The repo accretes a topic map; the system gets cheaper *and* more reliable with use.

**Guard:** the anchor prompt must live at the **decision-capture choke point** — inside the capture tool, wherever decisions enter the graph. Any capture path that adds a decision without prompting for its topic is a hole where un-anchored decisions leak in and become invisible to detection.

> **Known risk (see [§8](#8-red-team)):** on an existing repo, anchoring hundreds of doc sections is a cold-start wall, and fatigue turns confirmation into rubber-stamping. The atom-first path deliberately avoids the bootstrap by hand-anchoring a single section.

### The grounding mechanism (the autonomous win)

The precise guard:

> When a recorded decision supersedes something a doc still asserts, the doc section is stale-flagged, **and the agent is told the graph overrides the doc — before it reads the doc.**

Two laws, stated not decided case-by-case:

1. **Graph > doc, always.** The graph is human-confirmed decisions; the doc is prose that goes stale. If the doc could ever override the graph, Veto means nothing.
2. **The doc need not be *correct* for the system to be safe — only *known-stale*.** Once staleness is flagged and the graph is injected over it, correctness of the prose becomes a nice-to-have. A vastly cheaper bar than "keep all docs perfectly current," and the one that actually prevents the harm.

**Delivery:** inject via the existing MCP server / pre-edit hook path. The agent asks for (or is handed) context; Hunch returns the current decision for the anchored topic, with any stale doc section flagged and overridden. This is `hookpolicy.ts` territory extended from "block bad writes" to "supply correct reads."

> **Known risk (see [§8](#8-red-team)):** grounding assumes the graph is fresher than the doc. When the graph itself is stale, injecting it as authority *amplifies* the staleness — the agent obeys it without question. Graph freshness (Heal B) is therefore a safety dependency, not a nicety.

### Freshness is a computed precondition, not an assumption (post-red-team)

The two laws above are safe **only when the graph is actually fresher than the doc.** `confidence` does not establish that: it is set once, at capture, to record the author's uncertainty *at the time* — it never decays. The dangerous decision is one captured `confidence: high`, `accepted`, never superseded, that *became* wrong when reality moved (a CVE in a blessed library, a deprecated provider). Injecting it as authority makes every agent obey a rotted decision — **and grounding silences the very doc ("don't use library-Z, it's vulnerable") that would have prompted a human to reopen the topic.** A stale doc is self-correcting in aggregate; a stale high-confidence decision is anti-corrective by construction. Veto is no backstop: it trusts the same stale graph and would flag the *correct* new code as the violation.

Three guards make grounding safe against this class, not just against `superseded`:

1. **Last-affirmed age.** Each decision carries `last_affirmed_at` (bumped on capture, on an explicit "still current" confirm, and whenever code/doc is re-verified against it). Grounding injects an aged decision **with its age surfaced**, not as timeless authority; past a staleness threshold it downgrades to "advisory — confirm before relying," never hard authority.
2. **Never silence a doc asserting a *newer fact*.** Grounding overrides a doc that merely restates a *superseded choice*. It must **not** suppress a doc that asserts a *new external fact the decision's rationale never considered* (a CVE, a breaking upstream change). Choice-axis conflict → graph wins. Fact-axis conflict → surface **both** and flag the topic for revisit; never pick the graph silently.
3. **Grounding is measured, not assumed.** Grounding hit-rate and false-override rate are tracked (see [§8 gate](#the-gate)); the crown jewel does not ship on a single anecdote.

---

## 4. Decision schema (canonical)

This is the **single canonical definition** of a decision in Hunch's graph. Capture writes it, detection reads it, grounding injects it, heal supersedes it. Do not redefine the shape elsewhere.

### The decision entry

```json
{
  "id": "dec_<ulid>",
  "topic": "auth-transport",            // the anchor. exactly one topic per decision.
  "status": "accepted",                  // proposed | accepted | superseded
  "decision": "Use GraphQL for the public API.",   // the resolved choice, one line
  "rationale": "…",                      // why. REQUIRED — a decision without why rots.
  "rejected": [                          // explicit. what Veto/drift check against.
    { "option": "REST", "why_not": "…" }
  ],
  "supersedes": null,                    // decision id this replaces, or null. NEVER auto-set.
  "superseded_by": null,                 // back-link, set when this is superseded.
  "confidence": "high",                  // high | medium | low  (low = flag for revisit)
  "anchored_paths": [],                  // optional doc/code regions linked at capture
  "created_at": "…",
  "last_affirmed_at": "…",               // bumped on capture / "still current" confirm / re-verify. drives grounding age (§3).
  "source": "hunch_capture_decision"
}
```

### Field rules

- **`topic`** — the join key for all drift detection. One topic per decision; if a capture spans two topics, split it into two decisions. Model-proposed at capture, human-confirmed.
- **`status`** — the drift trigger. A derived view asserting a `superseded` decision *is* drift, by definition. Only three values; there is no "deprecated" limbo.
- **`decision`, `rationale`, `rejected`** — **non-negotiable.** The validator rejects any entry missing `rationale` or `rejected`. These are exactly what make a decision *enforceable* (Veto/drift can check against `rejected`) and *non-rotting* (a future reader can judge whether it still applies). A capture that skips them is producing mush, and detection/grounding will enforce the mush.
- **`supersedes` / `superseded_by`** — the anti-rot mechanism. **Only ever set by an explicit human action** (see below). Never inferred, never auto-set.
- **`confidence`** — `low` marks a decision made under uncertainty; surfaces it for later revisit instead of treating it as settled truth. **It does not decay** — a `high`-confidence decision that *rotted* still reads `high`. Age, not confidence, is what grounding uses to decide whether to inject as authority; that is `last_affirmed_at` (see [§3 freshness guards](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team)).
- **`last_affirmed_at`** — the freshness clock. Bumped at capture, on an explicit "still current" confirm, and on any re-verification against live code/doc. Grounding surfaces a decision's age at injection and downgrades a sufficiently-aged decision from hard authority to advisory. This is the mechanism that keeps grounding from weaponizing a stale decision against a correcting doc.

### Supersession & conflict (the anti-rot guard)

This is the mechanism that beats CodeRabbit's rotting-learnings problem, and it is the answer to the red-team question *"is supersession manual, or just a rename of manual pruning?"* ([§8](#8-red-team), Kill shot 1).

**When a new decision is committed for a `topic` that already has an `accepted` decision, the machine does NOT choose.** It presents both to the human, who resolves:

| Human choice | Effect |
|---|---|
| **This supersedes the old one** | New decision `supersedes` = old id; old decision `status: superseded`, `superseded_by` = new id; linked. |
| **These are different sub-topics** | Split the topic; both stay `accepted` under distinct anchors. |
| **Keep the old, discard this** | Drop the new capture. |

Why this is **not** "manual pruning renamed": pruning is *deletion of contradictions after the fact*, a chore the user must remember to do, on a pile that silently produces wrong behavior until they do. Supersession here is a **first-class, linked, at-write-time** operation — the contradiction is resolved the moment it arises, the history is preserved (append-only, never deleted), and the current decision is unambiguous **provided the "one `accepted` per topic" invariant is machine-enforced.** That uniqueness is *not* self-evident from the schema and *not* enforceable by prose: it must be enforced in the store and at merge time (see **Enforcement** below), or the graph silently accumulates exactly the contradictions this mechanism exists to prevent.

**The one thing the machine may never do:** decide, on its own, that decision B supersedes decision A. That would reintroduce machine-decides-truth. Supersession is always human-authored; the machine only makes it a clean, linked, one-click operation instead of a manual archaeology dig.

### Enforcement (where the invariant actually lives)

The "one `accepted` decision per topic" guarantee is a **claim about the store, not a property of the prose.** It holds only if three things are built — and today none exist in Hunch's code (`topic` is absent from `DecisionSchema` in `src/core/types.ts`; `src/store/merge.ts` merges records by `id` and lets per-record ADD/ADD through at the git tree level with no topic gate):

1. **Schema + index.** `topic` is a first-class, indexed field on the decision record. `current(topic)` is a real query, not a scan.
2. **Write-time guard (in the store, not the prompt).** A second `accepted` write on a live topic is *refused by the store* and forces the resolution table above. Delegating this to "the calling agent should prompt" is a hole: any agent that skips the prompt leaks a second live decision.
3. **Merge-time collision pass.** Git is distributed; two branches can each add an `accepted` decision for the same topic and neither local guard fires. This dominant collision case is a **cross-file ADD/ADD**, for which the content merge driver is *not invoked* (`src/store/merge.ts:12-13`) — so the pass must be a **new post-merge hook, not the existing driver.** The hook runs a `(topic, status=accepted)` uniqueness scan after every merge and routes each collision to the *same* human resolution flow as a write-time conflict. This reduces "distributed uniqueness across a git-native store" to "re-run the §4 resolution on topic collisions at merge time."

**Topic canonicalization.** The guard keys on the `topic` string, so `auth-transport` vs `auth_transport` vs `public-api-format` route around it. Capture must offer a **near-duplicate-topic suggestion** at write time ("looks like existing topic `api-format` — same? [y/n]") — suggest-only, never auto-merged, so it stays inside the never-fire-on-a-guess rule while closing the free-text synonym hole.

Until (1)–(3) are real, the wedge's core promise is unbacked: the graph's default behavior under two people using git is to accumulate silent contradictions — exactly the CodeRabbit rot this section claims to beat.

### Query contract (what detection/grounding rely on)

The graph must answer, cheaply:

- `current(topic)` → the single `accepted` (non-superseded) decision for a topic, or none.
- `history(topic)` → the full supersession chain, newest first.
- `rejected(topic)` → the union of `rejected` options across the current decision (what Veto blocks).

If the current graph store can't answer these — and today it can't; `topic` is not in the schema — that's a **schema migration plus the [Enforcement](#enforcement-where-the-invariant-actually-lives) guards above**, and it is the true first sub-task before the capture writer is built against it. It is *not* small (see [§5 pre-req](#definition-of-done-the-red-team-atom) and [§7 step 1](#sequence-only-after-the-atom-demos)).

---

## 5. Capture tool — `hunch_capture_decision`

**Replaces** the grill-me `SKILL.md` (killed). Capture no longer lives in a file that must be *placed* into each agent's `skills/` dir. It lives in Hunch's MCP server, invokable by any connected agent, and its output is **a graph write by construction** — it cannot emit a summary instead.

**Why this is the foundation:** every other Hunch feature (detection, grounding, heal, Veto) is downstream of decisions existing in the graph. Until one tool reliably writes a well-resolved decision into the graph, the rest has nothing to check against or inject. **Build this first.**

> **Distinction that matters:** we kill the *skill* (the packaging), not the *grilling* (the interrogation loop). The relentless one-question-at-a-time questioning is the part of grill-me worth keeping — it's what produces a well-resolved decision instead of an unexamined guess. It moves *inside* this tool.

### Must / must not

**Must:**
- Run the **grilling loop** — relentless, one-question-at-a-time interrogation until the decision tree for the topic is resolved.
- End by writing **one structured decision** to the graph, conforming to [§4](#4-decision-schema-canonical). The write is the tool's only success condition.
- Attach a **topic anchor** at write time (model-proposed, human-confirmed).
- Capture **rejected alternatives** explicitly — this is what makes Veto and drift detection possible.

**Must not:**
- Emit prose/doc text as its *output*. It writes a graph entry, full stop. (A human-readable summary to *read* is fine; the *artifact* is the graph write.)
- Write an unexamined decision — grilling is not optional.
- Auto-supersede. On conflict with an existing decision, it *flags* for human resolution per [§4 supersession](#supersession--conflict-the-anti-rot-guard). It never silently overwrites.

### Two build stages

**Stage 1 — prompt-driven (build now, week-sized).** Two-call dance:
- `hunch_capture_decision(topic?, seed?)` → returns grilling instructions to the calling agent: the interrogation protocol + what a resolved decision must contain, and **issues a capture-session token.**
- `hunch_commit_decision(payload, token)` → validates the payload against the schema and writes it to the graph. Returns the new decision id.

**Bind the two calls.** `hunch_commit_decision` must require a capture-session token issued only by `hunch_capture_decision`, so a decision cannot be committed without an interview having been opened. Otherwise the commit call is a side door that writes authoritative decisions with no human turn — breaking the identity principle ([§2](#2-the-identity-principle--automation-contract)). (Note: `hunch_record_decision` (`src/mcp/server.ts:291-386`) already ships as exactly such an un-gated write path — `status: accepted`, `confidence: 0.95`, no interview, no token. It is a live capture bypass *today*, not a hypothetical; gating or removing it is an explicit build step — [§7 step 1](#sequence-only-after-the-atom-demos) — and it stays on the open list ([§8-10](#8-red-team)) until that lands.)

Grilling quality depends on the calling agent following the returned protocol. The **validator is a backstop for *completeness*, not *quality*** — it rejects any payload missing `rationale` or `rejected`, so a short-circuited interview can't commit *structurally incomplete* mush. It does **not** and cannot verify the fields are *substantive*: `rationale: "it's better"` plus one strawman rejected option passes. Decision *quality* is not machine-enforced in Stage 1 — it rides on the grilling protocol the connected agent may ignore. Treat this as a known, bounded gap: at the atom, N=1 and a human eyeballs the entry; at scale, **Stage 2 server-orchestration is what actually closes it** (sequence step 8). Do not read "the validator is the backstop" as "quality is guaranteed."

**Stage 2 — server-orchestrated (harden later).** Hunch's server drives the questioning turns itself and only writes when the decision tree is resolved. Interrogation quality and the graph-write are both guaranteed by Hunch, not by whichever agent is connected. Do this once the atom is proven.

### What it writes

A single entry per [§4](#4-decision-schema-canonical). Non-negotiable fields: `topic`, `decision`, `rationale`, `rejected`. Conflict on an existing topic → human resolution per [§4 supersession](#supersession--conflict-the-anti-rot-guard); the tool never sets `supersedes` itself.

### Invocation surfaces

- **Model-invokable:** any agent on Hunch's MCP can reach `hunch_capture_decision` when the task fits (rich description so it's discoverable).
- **Human front door:** the thin `/capture` slash command ([Appendix A](#appendix-a--capture-command-drop-in)) that just calls the tool.

No `SKILL.md`, no per-agent skills-dir placement, no `~/.claude/skills/` drift. The tool rides the MCP connection Hunch already has.

### Definition of done (the red-team atom)

Done when you can:

1. Run `/capture` (or let the agent invoke it) on one real decision in the Hunch repo.
2. See exactly one structured entry appear in the graph, with `topic`, `rationale`, and `rejected` populated.
3. Query it back out via the MCP server (`current(topic)` returns it).

That single round-trip is the foundation the entire package waits on, and it is step 1 of the demo in [§7](#7-build-order). Nothing else gets built until this write works.

> **Pre-req check (not small):** Hunch's graph store does not yet hold `topic` (absent from `DecisionSchema`) and cannot answer `current(topic)`. Before the writer, you must land the `topic` field + index, the **write-time uniqueness guard**, the **merge-time collision pass**, and `last_affirmed_at` — i.e. all of [§4 Enforcement](#enforcement-where-the-invariant-actually-lives). This is the true first sub-task and it is a real migration, not a rename. The atom (below) hand-waves past it with N=1; the *product* cannot.

---

## 6. Heal flow

Grounding makes drift *harmless* (the agent reads the graph over a stale doc). Healing makes drift *gone* (the doc is reconciled). But "heal" is not one action, and routing every heal the same way reintroduces the poisoned well. Split by **what is actually stale.**

### The two heals

- **Heal A — doc-stale (the common case).** The graph is right; the doc is just out-of-date prose. Nothing to interview — the decision is already resolved. Treatment: a **lightweight confirm** on a graph-derived rewrite of the doc section. No grilling; interrogating a settled decision is theater and friction.
- **Heal B — decision-stale / gap (the rare, important case).** Healing the doc reveals the doc *isn't* wrong — reality moved and the *decision* is stale, or the doc surfaced a case the graph never resolved. Now there's a genuine unresolved decision. Treatment: **the grilling loop via the capture tool** ([§5](#5-capture-tool--hunch_capture_decision)), because the real artifact being produced is a *decision*, not prose.

### The escalation on-ramp

Heal A is where the need for Heal B is *detected*.

1. Drift detected (doc ≠ graph).
2. Hunch proposes the graph-derived rewrite → **lightweight confirm** — surfacing the governing decision id with a neutral, one-tap **"is this decision still current? [yes / no, it's stale]"** prompt. This is the counter to the incentive gradient (see [§8-9](#8-red-team)): without it, the cheap Heal-A path silently launders a stale *decision* into a freshly-rewritten doc, because confirming prose is easier than opening an interview. The prompt makes "the decision rotted" a one-tap signal, not a scary escalation the user avoids. A "yes" *may* bump `last_affirmed_at` ([§4](#4-decision-schema-canonical)) — **but guard against rubber-stamp corruption:** this confirm is high-frequency and fatigue-prone ([§8-5](#8-red-team)), and a reflexive "yes" that never truly re-examined the decision must not silently refresh the freshness clock — otherwise it defeats the one guard ([§3 guard 1](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team)) that reaches a *choice-axis* rot the fact-axis rule doesn't cover. Bump only on genuine engagement (a distinct affirm, not a bare doc-wording confirm), or decouple the affirm from the doc-heal entirely. Tracked as open in [§8-10](#8-red-team).
3. Human confirms (or edits the wording, then confirms) → doc healed. *Done. (Heal A — the common path. Editing wording is a prose fix, still Heal A.)*
4. Human **explicitly** signals "the decision is stale, not the doc" → **escalate to capture** ([§5](#5-capture-tool--hunch_capture_decision)) → the grilling loop resolves the superseding decision → the doc then re-derives from the new decision, presented as a **separate confirm**. *(Heal B.)*

> **Critical UI rule:** the escalation trigger is a *judgment*, not an inference. Only an explicit "this decision is wrong now" opens Heal B. If the human merely tweaks the proposed wording, that stays Heal A. Make the two rejection paths visibly distinct so the common case never drags someone into an interview they didn't need.

### The two laws (that keep capture from becoming a silent rewriter)

1. **Capture settles the decision, never the prose.** The grilling loop's only output is a graph entry (a new or superseding decision), per [§5](#5-capture-tool--hunch_capture_decision). It must never end by silently emitting doc prose — that would be an ungated rewrite wearing an interview's clothes.
2. **Prose is always a separate confirm — even post-interview.** After Heal B resolves the decision, the doc rewrite derived from it is still machine-generated and can still be subtly wrong. It gets its own lightweight confirm. The human authors the decision; the machine drafts the prose; the human nods at the prose. No silent rewrite anywhere in the chain.

### Automation placement

| Step | Tier | Notes |
|---|---|---|
| Detect drift | Fully automated | Fires on hooks/CI; no confirmation |
| Propose doc-stale rewrite | Machine drafts | Presented as a diff |
| Apply rewrite | One-tap gate | Human confirms; never silent |
| Escalate to Heal B | Human-initiated | Explicit "decision is stale" only |
| Capture superseding decision | One-tap gate | Grilling loop → graph; supersession human-authored ([§4](#4-decision-schema-canonical)) |

The manual front door to this flow is the [`/heal`](#appendix-b--heal-command-drop-in) command. The autonomous detection + grounding around it lives in Hunch's hooks + MCP, not in the command.

---

## 7. Build order

Read this section first if you read only one. It contains the atom everything is downstream of, and the risks that determine what you must *not* build yet.

### The happy path (the atom)

Stop building the system. Build the single atom that produces one visible moment — a human watching the agent get corrected by the graph in real time. One line, no forks:

1. **Capture one decision.** Run the capture tool ([§5](#5-capture-tool--hunch_capture_decision)) on one real decision in the Hunch repo. Confirm it writes a single structured entry ([§4](#4-decision-schema-canonical)), tagged with one topic. *(This also proves the capture-writes-to-graph foundation.)*
2. **Point the agent at a contradicting doc.** Take one doc section on that same topic that still says the old thing. Anchor **this one section** by hand — do not anchor the repo.
3. **Let the agent act on that topic.** Grounding injects the decision over the stale doc at read time. The agent does the *new* thing, not the stale-doc thing.
4. **Watch the moment.** The agent visibly corrected by the graph. Record it. That ~30-second clip is your demo *and* your validation in one artifact.

**Why the atom, not the spec:** it needs no full graph, no anchor bootstrap, no supersession logic, no semantic detection at scale — and it's a week, not a quarter. It directly tests whether the value is even *visible*, at the cheapest possible place to learn it.

> **What the atom does NOT prove.** Because you place *both* the decision and the contradicting doc by hand, the atom validates **desirability** — does grounding produce a felt "wait, what." It does **not** validate detection, false-positive rate, the uniqueness invariant, or grounding's reliability on a repo you didn't stage. Those are the gate's separate, *measured* bars ([§8 gate](#the-gate)); a compelling clip must not stand in for them.

### Sequence (only after the atom demos)

1. **Schema migration + Enforcement (required, not "if needed")** — add `topic` (absent today) + index; the write-time uniqueness guard; the merge-time collision pass; `last_affirmed_at`. Answer the [§4 query contract](#query-contract-what-detectiongrounding-rely-on). This is [§4 Enforcement](#enforcement-where-the-invariant-actually-lives), and it is load-bearing for every step after it — do it first, real, in the store. (Migration mechanics, schema reconciliation, and the `hunch_record_decision` deprecation path: [§9](#9-backwards-compatibility--migration).) **In the same step, close the live side door:** gate or remove `hunch_record_decision` (`src/mcp/server.ts:291-386`) — today it writes an `accepted` decision at `confidence: 0.95` with no interview, no token, no topic, no rejected alternatives. Route it through the store uniqueness guard + capture-session token, or delete it. Until it's gated, every §2/§5 guarantee is bypassable by the one decision-write tool that actually ships.
2. **Capture tool** ([§5](#5-capture-tool--hunch_capture_decision)), Stage 1 — the write. *This is the atom's step 1.*
3. **Grounding injection** — read-time, over one anchored doc. *The atom's step 3.*
4. **doc ≠ graph detection** — automated, over anchored sections.
5. **Heal A** ([§6](#6-heal-flow)) — lightweight confirm.
6. **Heal B + supersession** ([§6](#6-heal-flow), [§4](#4-decision-schema-canonical)) — escalation, human-authored supersession.
7. **graph ≠ code (Veto)** — reuses the anchor machinery; largely already speced.
8. Harden capture to Stage 2; add semantic anchor *suggestion*.

**doc ≠ code** is never built as its own detector — it falls out of steps 4 + 7 *only where both a doc anchor and a code tripwire exist for the governing decision* ([§3 caveat](#the-three-drifts) / [§8-8](#8-red-team)). Where a decision governs but no tripwire was authored, this is a known blind spot, not free coverage.

---

## 8. Red team

The kill shots. Face them. But note which ones are only worth solving *after* the atom earns a "wait, what."

> **Revision note (v2).** This section and §3–§7 were hardened after an adversarial red-team that checked every claim against Hunch's source. Items **1, 2, 8, 9** below were *confirmed holes in v1* — the store contradicted the prose — and are now addressed in-place. Items 3–7 remain as originally scoped. Item **10** collects what stays genuinely open. The honest posture: the plan is sound *as a build order* iff [§4 Enforcement](#enforcement-where-the-invariant-actually-lives) is built in the store, not asserted in prose.

**1. Supersession: fix or rename?** If a human must declare "#47 supersedes #12," is that just CodeRabbit's manual pruning renamed? The *design* answer holds — supersession is at-write-time, linked, append-only ([§4](#supersession--conflict-the-anti-rot-guard)). But the design answer is **worthless until mechanized**, and v1 asserted the invariant as if prose could enforce it. It can't: `topic` was absent from the schema and `merge.ts` lets two `accepted` decisions for one topic through a git merge with no gate. **Now addressed** by [§4 Enforcement](#enforcement-where-the-invariant-actually-lives) (store-level write guard + merge-time collision pass + topic canonicalization), made [§7 step 1](#sequence-only-after-the-atom-demos) *required, not optional*. This is the load-bearing answer; it holds **iff those three guards are built in the store.** If they slip back to "the agent should prompt," the wedge collapses.

**2. Grounding a stale graph amplifies harm.** A stale *doc* the agent might question; a stale *decision injected as authority* it obeys blindly. Two failure classes, not one: (a) `superseded`-but-doc-still-asserts — handled by status; (b) **`accepted`, `confidence: high`, never superseded, but *rotted* since capture** — the sharp one, which v1 "mitigated" with `confidence: low` (a capture-time flag that never decays and so cannot reach a decision that *became* wrong). **Now addressed** by [§3 freshness guards](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team): `last_affirmed_at` age surfaced at injection, downgrade-to-advisory past a threshold, and the hard rule that grounding must **never silence a doc asserting a new external fact** (CVE, upstream breakage) the decision's rationale never considered. Grounding stays the sharpest area; treat graph-freshness as core, and note Veto cannot backstop it (it trusts the same stale graph).

**3. Empty-room problem.** Value scales with graph density; day one it does nothing, and capture is gated friction. A new user sees nothing happen. **Mitigation:** the atom sidesteps this for *your* demo (you pre-capture one decision). For *users*, onboarding must seed a few decisions immediately or the tool is invisible when they're deciding whether to keep it. Open problem — do not pretend it's solved.

**4. "Deterministic drift" smuggles a semantic judgment.** The status check is deterministic, but matching a doc paragraph's *meaning* to a decision is an LLM call — fuzzy, false-positive-prone. Explicit anchors contain this (you match by declared topic, not by meaning), which is *why* anchors are explicit and semantic only suggests. If anchoring ever drifts toward semantic firing, this risk returns.

**5. Anchor bootstrap wall.** On an existing repo, confirming hundreds of anchor suggestions → rubber-stamping → low-quality anchors → false alarms → muted tool. **Mitigation:** atom-first avoids the bootstrap (hand-anchor one section). At scale, addressable set skews toward repos built with Hunch from the start. Do not promise clean retrofit onto large legacy repos.

**6. Scope vs. solo.** The full spec is multiple quarters for one person, and the failure mode is *never shipping* while a competitor bolts "supersession" onto existing learnings. **Mitigation:** the atom + strict sequence above. Ship the moment, not the system.

**7. Invisible value / can't-demo.** "Memory that doesn't rot" is *more* abstract than "prevents regressions," which was already too abstract to land. **Mitigation:** the atom exists specifically to convert the abstract claim into a watchable moment. If step 4 of the happy path doesn't make someone go "wait, what," the problem is upstream of features and no amount of building fixes it — which you'll have learned in a week instead of a quarter.

**8. "doc≠code falls out for free" overstates a partial detector.** The decomposition is logical, not complete: `graph≠code` (Veto) fires only on hand-authored tripwires (`rejected_tripwires` defaults empty; a blocker needs a `human_confirmed` tripwire). Where a decision is governed but untripwired, doc and code can silently agree and both violate the graph — the drift you actually ship. **Addressed** by de-claiming "for free" ([§3 caveat](#the-three-drifts)): doc≠code coverage = anchored ∩ tripwired, an acknowledged blind spot, not the union.

**9. Capture writes authoritative mush.** The validator checks field *presence*, not *substance* ("it's better" passes), and the two-call split lets a decision be committed with no real interview. **Partially addressed:** the validator claim is reframed to *completeness, not quality* ([§5](#two-build-stages)), a capture-session token binds the two calls, and decision-quality is named an explicitly unenforced gap until Stage 2. **Not yet addressed — the token gates a front door that isn't built while the back door ships open:** `hunch_record_decision` (`src/mcp/server.ts:291-386`) writes `accepted` / `confidence: 0.95` decisions with no token, topic, or interview, and it is the decision-write tool that actually exists today. It is scoped into [§7 step 1](#sequence-only-after-the-atom-demos) (gate or remove) and listed under [§8-10](#8-red-team) until then — **do not read this item as closed.** Bounded at the atom (human eyeballs N=1); real at scale — so do not ship grounding as hard authority off Stage-1 captures alone.

**10. Still genuinely open (not closed by v2):**
- **The live un-gated `hunch_record_decision` side door** (`src/mcp/server.ts:291-386`) — writes `accepted` / `confidence: 0.95` decisions with no interview, token, or topic. **Highest-priority open item** because it is a defect *in shipping code*, not an unbuilt spec. Closed only when [§7 step 1](#sequence-only-after-the-atom-demos)'s gate-or-remove lands.
- **`last_affirmed_at` rubber-stamp coupling** ([§6](#6-heal-flow)) — the freshness clock can be falsely refreshed by a reflexive Heal-A "yes," and it is the one guard that reaches a *choice-axis* rot. Decouple the affirm from the doc-heal, or require genuine engagement before bumping.
- **Empty-room / onboarding density** (item 3) — unchanged; seeding a new repo's first few decisions is unsolved.
- **Grilling-loop economics** — per-capture LLM cost, latency, and nondeterminism of a 6–10-turn interview, feeding the very density item 3 needs. Priced nowhere.
- **Topic-namespace governance at scale** — canonicalization ([§4](#enforcement-where-the-invariant-actually-lives)) stops byte-level synonyms, but there is still no owner, rename story, or merge story for the topic taxonomy after a year of accretion.
- **Anchor bootstrap on legacy repos** (item 5) — atom-first dodges it; retrofit onto a large existing repo is still a wall. Do not promise clean retrofit.

### The gate

Split by what each bar actually tests. The atom clears the first; it **cannot** stand in for the rest.

**Desirability bar — the atom (qualitative):**
- Watching the agent get grounded over a stale doc earns a genuine "wait, what." If this fails, stop — the problem is upstream of features.

**Mechanism bars — measured, before scaling past N=1 (the hand-staged atom does not count here):**
- Finds/uses real drift in your own repo you did **not** stage.
- **False-positive rate ~zero** on unstaged anchors — *plus a negative control:* on a section with no drift, the detector stays silent. "Never fires on a guess" must be *demonstrated*, not assumed.
- **Grounding hit-rate and false-override rate are measured**, not anecdotal: how often injection actually changes agent behavior, and how often it wrongly overrides a doc that was right. The crown jewel does not ship on one clip.
- **Uniqueness invariant survives a real git merge:** two branches, same topic, both `accepted` → the merge-time collision pass catches it ([§4 Enforcement](#enforcement-where-the-invariant-actually-lives)).

**Budgetability bar — positioning (not mechanism):**
- Someone with a line item can name the pain in a sentence. "Earns a wait-what" tests *visibility*, not *willingness to pay*; item 7 admits the claim is more abstract than "prevents regressions." If no champion can budget it, fix positioning before building more.

If it clears desirability, you've found the demo the product was missing. If it then clears the mechanism bars, the sequence writes itself. If it clears neither, stop and fix value/positioning first.

---

## 9. Backwards compatibility & migration

The feature lands on an existing, shipped store with real user data. Compatibility splits three ways: **on-disk data (compatible, by the existing migration system), the MCP tool surface (a breaking change that needs a deprecation path), and the §4 schema (must reconcile with the real schema, not fork it).** This section is grounded in Hunch's current code, not the idealized §4 restatement.

### 9.1 On-disk data — compatible by construction

Hunch already versions its JSON source of truth and forward-migrates it. Reuse that; do not invent a new mechanism.

- `.hunch/manifest.json` stores `schema_version` (currently `2`). On load, `migrateRaw` upgrades raw JSON **up to `SCHEMA_VERSION` *before* Zod validation** (`src/core/migrate.ts:5-6`), so old records never fail validation on missing new fields.
- **Precedent:** the v2 migration added the bi-temporal `valid_from`/`valid_to`/`superseded_by` fields by backfilling from each record's `date` (`src/core/migrate.ts:46-66`) — losslessly, no record dropped. The topic/freshness fields follow the identical pattern.
- **The v3 migration:** bump `SCHEMA_VERSION` to `3`; append one `Migration{ version: 3 }` that, for `kind === "decisions"`, sets `last_affirmed_at` from the existing `valid_from ?? date` and leaves `topic` unset (see 9.4 for why topic is *not* auto-guessed). New fields must be `.optional()` / `.default()` so partial legacy records validate — consistent with every existing field.
- **SQLite is derived, never authoritative** — `hunch index` rebuilds the FTS/graph/vector index from JSON. Schema changes there are a reindex, never a data-compat concern.

### 9.2 Schema reconciliation — extend the real schema, do not fork it

The plan's [§4](#4-decision-schema-canonical) is a simplified restatement. Implemented literally it forks concepts Hunch already has (`src/core/types.ts:129-155`). Bind each §4 field to what exists:

| §4 concept | Reuse this existing field | Note |
|---|---|---|
| `confidence: high\|medium\|low` | **`provenance.confidence: number` (0–1)** (`types.ts:14`) | Do **not** add a second confidence field. If tiers are wanted for display, derive them from the number at read time. Grounding's freshness decision keys on `last_affirmed_at`, **not** on confidence (see [§3](#freshness-is-a-computed-precondition-not-an-assumption-post-red-team)). |
| `rejected: [{option, why_not}]` | **`alternatives_rejected: string[]`** + **`rejected_tripwires`** (structured, machine-checkable, for Veto) | `{option, why_not}` is a *presentation* shape over these. Don't introduce a third rejected-list. |
| `anchored_paths: []` | **`related_files` / `related_components`** + the sidecar anchor map ([§9-map](#10-component-map)) | Doc/code *regions* go in the sidecar; whole-file links reuse `related_files`. |
| `status: 3 values` | **`status: proposed\|accepted\|rejected\|superseded`** (4 values already) | Detection keys on `superseded`. Note the 4th value `rejected` means *the decision itself was rejected* — distinct from `alternatives_rejected`. |
| supersession model | **`supersedes` / `superseded_by` + `valid_from`/`valid_to`** already exist | The anti-rot supersession machinery is **largely built.** The feature adds `topic` as the join key and the uniqueness *guard* — not a new supersession model. |

**Genuinely new fields: only `topic` and `last_affirmed_at`.** Everything else in §4 maps to existing structure.

### 9.3 MCP tool-contract compatibility — `hunch_record_decision` needs a deprecation path, not a hard gate

`hunch_record_decision` (`src/mcp/server.ts:293-386`) is a **published MCP write tool**; external agents and integrations call it directly. The [§7 step 1](#sequence-only-after-the-atom-demos) "gate or remove it" instruction is a **breaking change** if done abruptly. Staged path:

1. **Non-breaking first (v3).** Keep the tool and its input/output contract intact. Internally route its write through the new store uniqueness guard (9.4) and accept an optional `topic`. A call with no `topic` still writes — it just lands **un-anchored** (invisible to detection), exactly the honest bound the anchor system already documents. **No existing caller breaks.**
2. **Warn (v3.x).** When called without a capture-session token or topic, return a soft deprecation notice in the tool result; log it. Behavior unchanged.
3. **Enforce (next major only).** Require the token / fold into capture, announced in `CHANGELOG`. Never change the output contract silently.

Until step 3, the identity-principle bypass the red-team flagged is *contained* (the write is still guarded by the store uniqueness check even via the old tool), while no integration is broken. Move the item from [§8-9](#8-red-team) accordingly once step 1 lands.

### 9.4 Enabling the uniqueness guard on a legacy graph

The migration **must not** auto-assign `topic` (an LLM guess at scale = the banned semantic firing, and it would manufacture false collisions). Consequence: a repo can hold two `accepted` decisions that *should* share a topic but don't yet. So:

- **The write-time guard applies to new writes from day one; it is not retroactive.**
- Backfilling topics is a **human, incremental** act (capture, or a suggest-only anchor pass) — never the migration.
- Once topics exist, a one-time **`hunch reconcile-topics`** pass scans `(topic, status=accepted)` collisions and routes each to the [§4 human resolution](#supersession--conflict-the-anti-rot-guard) — never auto-picks. Until a topic is reconciled, a topic with >1 live `accepted` decision is treated by grounding as **ambiguous → do not inject as authority** (fail-safe), the same rule as the merge-collision case ([§4 Enforcement](#enforcement-where-the-invariant-actually-lives)).

### 9.5 Forward-compat hazard (mixed-version teams)

`DecisionSchema` is a non-strict `z.object`, so it **strips unknown keys.** An **older** Hunch binary opening a v3 repo (manifest `schema_version: 3` > its own `SCHEMA_VERSION: 2`) runs no applicable migration, passes the raw record to Zod, and **silently drops `topic`/`last_affirmed_at` on any rewrite** — data attrition in a mixed-version team. Mitigation: on load, if `manifest.schema_version > SCHEMA_VERSION`, **refuse-with-upgrade-prompt** (or read-only) rather than silently round-tripping newer data through an older schema. This guard does not exist today and should ship *with* the v3 bump.

### 9.6 Reversibility

Migrations are forward-only, but the JSON is git-tracked: a downgrade is `git revert` + `hunch index`. New fields are additive and defaulted, so a revert loses only the new signal, not existing decisions. Keep it that way — no v3 migration may mutate or drop a pre-existing field.

---

## 10. Component map

To Hunch's codebase.

| Piece | Strategy | Where it lives |
|---|---|---|
| Decision write + topic anchor | Model-proposed, human-confirmed | `hunch_capture_decision` MCP tool ([§5](#5-capture-tool--hunch_capture_decision)) → graph |
| Anchor suggestion for doc/code | Semantic, suggest-only, persisted on confirm | New pass; writes to a sidecar anchor map |
| doc ≠ graph detector | Fully automated; fires on status=superseded conflict | New detector, reuses graph read path |
| graph ≠ code detector | = Veto | `strictgate.ts`, `regressionHits` (existing) |
| Read-time grounding injection | Fully automated; graph over doc | MCP server + pre-edit hook (`hookpolicy.ts`) |
| Heal A — doc-stale | Lightweight confirm on graph-derived rewrite | Detector output → confirm UI ([§6](#6-heal-flow)) |
| Heal B — decision-stale | Escalated; captures superseding decision | `hunch_capture_decision` → graph; prose is a separate confirm |
| Ownership/anchor manifest | Records what Hunch anchored/owns; reversible | `.hunch/` sidecar |

---

## Appendix A — `/capture` command (drop-in)

*Place at `.claude/commands/capture.md`.*

```markdown
---
description: Capture an engineering decision into Hunch's graph via a grilling interview. Interrogates one question at a time until the decision is resolved, then writes it (topic, rationale, rejected alternatives) to the graph via Hunch's MCP tools. Use for "capture this decision", "grill me on this", "record this decision", or "/capture".
---

# /capture — record a decision into Hunch's graph

Invoke Hunch's `hunch_capture_decision` MCP tool for the current topic, then run the grilling loop it returns.

## Rules

1. **Grill before you commit.** Ask one focused question at a time. Push back on weak or hand-wavy answers. Resolve every branch of the decision tree before committing — an unexamined decision poisons the graph.
2. **Confirm the topic anchor with me** before committing. One topic per decision; if the decision spans two topics, split it into two captures.
3. **Capture rejected alternatives explicitly** — for each, what it was and why not. This is what makes the decision enforceable later.
4. **Commit via `hunch_commit_decision`.** The output is the graph entry only — do NOT write any doc prose. If a human-readable summary helps, show it, but the artifact is the graph write.
5. **On conflict** with an existing decision for this topic, do NOT auto-supersede. Present both to me and let me choose: supersede (link them), split the topic, or discard this one.

Required fields before commit: `topic`, `decision`, `rationale`, `rejected`. If any are missing, keep grilling — the validator will reject an incomplete decision.
```

---

## Appendix B — `/heal` command (drop-in)

*Place at `.claude/commands/heal.md`.*

```markdown
---
description: Reconcile documentation against Hunch's decision graph. Detects where a doc still asserts an approach the graph has superseded (doc-stale), proposes a graph-derived rewrite for confirmation, and escalates to a decision-capture interview only when the human indicates the decision itself is stale. Never rewrites prose silently. Use for "heal drift", "reconcile docs with decisions", or "/heal".
---

# /heal — decision-grounded drift reconciliation

You are running Hunch's heal flow. Bring derived views (docs) back into agreement with the authoritative decision graph — **without ever silently rewriting prose**. The graph is ground truth; docs are stale-able views of it.

## Hard rules (do not violate)

1. **Graph > doc, always.** When a doc and the graph disagree, the graph wins. The doc gets flagged/fixed, never the graph — unless the human explicitly says the decision is stale (Heal B).
2. **Never emit doc prose silently.** Every rewrite is a separate, explicit confirmation — even after a capture interview.
3. **Never fire on a semantic guess.** Only act on drift where an explicit topic anchor links the doc section to a decision. Un-anchored sections are reported as "unanchored, not checked" — never flagged as drift.
4. **Capture produces a decision, never prose.** If you escalate to a decision-capture interview, its only output is a new/superseding graph entry via `hunch_capture_decision`. It must not end by writing doc text.

## Step 1 — Detect (automated, no confirmation needed)

Read the decision graph via Hunch's MCP tools. For each doc section carrying a topic anchor, compare it against the current (non-superseded) decision for that topic.

Classify each anchored section:
- **In sync** — doc agrees with the current decision. Do nothing.
- **Drifted** — doc asserts an approach the graph marked superseded or contradicted. Collect for Step 2.
- **Unanchored** — no topic anchor. Report count only; do not check or flag.

Output: `N drifted, M in sync, K unanchored`. List only drifted sections, each with: doc path + section, the topic anchor, the current decision id it conflicts with, and a one-line statement of the conflict. If `N = 0`, say so and stop. Do not invent drift.

## Step 2 — Heal A (doc-stale): propose, confirm, apply

For each drifted section, assume first that **the doc is stale and the graph is right** (the common case).

1. Draft a rewrite **derived from the current decision**. Keep the doc's voice and surrounding structure; change only what the decision requires.
2. Present it as a diff: current (stale) text vs. proposed rewrite, with the governing decision id shown.
3. **Wait for the human.** Three responses:
   - **Confirm** (or edits wording, then confirms) → apply. *Still Heal A — editing prose is a prose fix, not a decision change.*
   - **Skip** → leave flagged-but-unhealed; grounding still overrides it at read time.
   - **"The decision is stale, not the doc"** (explicit judgment) → escalate to Step 3. Do NOT infer this from a wording edit — only an explicit signal that the graph is wrong opens Step 3.

## Step 3 — Heal B (decision-stale): escalate to capture

Reached **only** when the human explicitly says the graph is out of date or the doc surfaced a case the decision never resolved.

1. Invoke `hunch_capture_decision` scoped to this topic. Run the grilling loop — one question at a time — until the superseding decision is resolved.
2. Commit it as a **new decision that supersedes the old one**, linked, with the topic anchor attached (human-authored supersession — never auto-set). This is the interview's *only* output — no doc prose here.
3. Return to **Step 2 / Heal A** for this section: the doc re-derives from the *new* decision, presented as a diff for a **separate confirmation**. The interview settled the decision; the prose still gets its own nod.

## Step 4 — Summary

Report: sections healed (Heal A), decisions superseded (Heal B), sections skipped, sections left unanchored. Note that unanchored sections are unprotected until anchored, and offer to anchor them (model proposes, human confirms) — never auto-anchor by semantic guess.

## What this command does NOT do

- Does not touch the graph except via an explicit Heal B capture.
- Does not run continuously — the autonomous detection + read-time grounding spine lives in Hunch's hooks + MCP, not here. This is the manual front door for a deliberate reconciliation pass.
- Does not auto-apply any prose. Ever.
```
