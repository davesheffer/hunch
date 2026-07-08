<!-- hunch:topic capture.verdict-loop dec_58f016807f -->
# Fable Mode — Verdict playbook

Design decisions, red teams, "which option is right." Not for execution work —
this playbook manufactures a CALL, and its byproducts are the record: real
rejected alternatives, evidenced attacks, flip conditions.

## The loop

**1. Split the proposal before judging it.** A verdict on "the whole idea" is
lazy — decompose into separately-shippable parts. Parts get separate fates.

**2. Lay candidates, not yes/no.** At least two real options, including
do-nothing when sane. A verdict without a second candidate is anchoring.

**3. Attack from independent lenses.** Product, technical, strategy, economics —
and the highest-yield one: **self-consistency** (does the proposal contradict
the proposer's own recorded principles, decisions, constraints?). Lenses must be
independent; five rephrasings of one worry count as one attack.

**4. Every attack cites evidence or gets demoted.** A landing attack points at
something observed or recorded — a measurement, a decision id, a constraint, a
repro. Attack without a citation = opinion; mark it plausible, weigh it less.

**5. Report failed attacks too.** They are the tested-safe surface, and they
prove the red team was honest — not theater staged to justify a preexisting
preference.

**6. Convergence rule — the verdict engine.** One landing attack = a
consideration to mitigate. Two-three INDEPENDENT lenses converging on the same
component = kill that component. Count convergence per part (step 1), not per
proposal.

**7. Downside-shape check.** For each side, ask what being wrong looks like.
When one mistake is reversible (add it later) and the other is not (trust
erosion, migration, publicity), take the reversible one. Ties break toward
demand-driven, not default.

**8. Grade confidence per component and name what flips it.** High where attacks
converge; medium where the unknown is empirical (only data settles it, not
argument). Stating the flip condition keeps the verdict falsifiable instead of
oracular.

**9. The verdict must be executable.** Ship X, don't ship Y, escape hatch Z,
next action. "It depends" is analysis wearing verdict's clothes.

Compressed: **split → candidates → independent evidenced attacks → keep the
failures → converge → prefer reversible → grade → execute.**

## Feeding the record

The loop's byproducts map onto a decision record — don't discard them:
- candidates killed → rejected alternatives (with the attack that killed each)
- flip conditions → "revisit if …" tripwires embedded in each rejection
- failed attacks → context (the tested-safe surface)
- convergence strength → confidence

In a repo with Hunch: run `hunch_capture_decision(deciding: true)` to drive this
loop as the interview, then record — the graph gets alternatives that were
actually attacked, not post-hoc fiction.

## Tripwires
- Verdict formed before candidates were written down → anchoring; back to step 2.
- All attacks landing on one side → the red team is theater; attack the favorite
  harder or find the lens you're avoiding.
- "It depends" as the conclusion → step 9; name the condition and pick.
- Confidence stated without a flip condition → oracle, not analysis.
