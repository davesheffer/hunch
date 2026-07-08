---
name: fable-mode
description: Maximum-rigor execution protocol — five gates (scope, evidence, attack, verify, report) plus per-task playbooks and tripwires. Use when the user says "fable mode", "be rigorous", "do this properly", "think hard", when debugging anything non-obvious, reviewing code, making high-blast-radius changes, or whenever a wrong answer costs more than a slow one.
---

# Fable Mode

Each gate exists to kill one specific failure mode. The gates shape the work; they are
invisible in the output — only Gate 5 is what the user sees. Never narrate "now entering
Gate 2." A failed gate sends you backward, never forward.

**Sizing rule — pay ceremony proportional to blast radius.** Mechanical, reversible,
single-file task: Gates 1 and 5 only, one sentence each, go. Anything touching shared
code, data, config, or a diagnosis the user will act on: full protocol. When unsure,
full protocol.

## Gate 1 — SCOPE — kills: solving the wrong problem
- Restate the task in one sentence. Can't? You don't understand it yet — read until you can.
- Define "done" as an observable outcome: a passing test, a rendered page, a measured
  number, a reproduced-then-gone failure. Never "code written."
- Name your riskiest assumption. Gate 2 checks that one first.
- Say what you are deliberately NOT doing. Scope creep dies here, not in review.

## Gate 2 — EVIDENCE — kills: acting on memory and guesswork
- Never state from memory what you can check. Read the file, run the command, fetch the doc.
- Every claim gets a source observed *this session*: file:line, command output, test
  result. "I believe" and "typically" are not sources.
- Read before you write. Enough surrounding code to match its idiom and find the existing
  helper you'd otherwise duplicate.
- Batch independent lookups in one parallel round, not a serial drip. Delegate broad
  sweeps to a cheap scout subagent and keep only conclusions — spend your own context on
  reasoning, not raw file dumps.
- Distinguish three grades and keep them straight: **know** (observed it), **infer**
  (follows from observations), **guess** (plausible). Only "know" supports action;
  a guess is a to-verify item, not a fact.

## Gate 3 — ATTACK — kills: anchoring on the first plausible answer
- **Two-candidate rule.** Never act on a diagnosis or design until you have written a
  second candidate and can say what evidence discriminates between them. No second
  candidate = you haven't compared, you've anchored.
- Run the **cheapest discriminating test first** — the one observation that splits your
  candidates, not the most convenient one that confirms your favorite.
- Try to kill your own answer: what input breaks it? what file did you not read? what
  simpler explanation fits the same evidence?
- Bug diagnosis must explain ALL symptoms — timing, scope, "why now," why it ever worked.
  A cause that explains only the loudest symptom is a co-incident, not a root cause.
- If the attack lands, return to Gate 2. One survived honest attack outweighs three
  optimistic re-reads.

## Gate 4 — VERIFY — kills: "should work"
- Exercise the change end-to-end. Run the real code path. Typecheck passing is spelling,
  not verification.
- Prove the fix fixes: reproduce the failure FIRST, then show it gone. A fix without a
  repro is a hypothesis wearing a fix's clothes.
- Test the edge you attacked in Gate 3, not just the happy path.
- Verify in proportion to blast radius: a typo fix needs a glance; a shared-helper change
  needs its dependents exercised.
- **Simplify pass.** Once it works, re-read the diff and ask what can be deleted —
  dead branches, needless flags, a helper that duplicates an existing one, a comment
  explaining what the code now says. Working is the midpoint, not the finish.
- Verification impossible (no runtime, no repro)? Fine — but that fact goes in the
  report as a fact, not an apology.

## Gate 5 — REPORT — kills: burying the lede
- First sentence = the outcome. What happened, what you found, what changed.
- Label the grades: verified ("tests pass — I ran them") vs assumed ("should hold —
  couldn't run X"). Never let a guess wear a fact's voice.
- Failures verbatim, with the exact error. Never softened, never buried mid-paragraph.
- Shorter by selection, not compression: cut what doesn't change the reader's next
  action; write what remains in full sentences.
- Before sending, check: outcome first? grades labeled? every "I'll…" promise already
  done? nothing important stranded mid-conversation?

## Domain playbooks — read BEFORE Gate 1

Identify the domain, then Read the matching playbook from this skill's
`references/` directory — it sharpens every gate for that terrain. Cross-domain
task: read each one that applies. The gates never change; their teeth do.

- `references/frontend.md` — UI, components, styling, browser behavior.
- `references/backend.md` — APIs, services, data, contracts, migrations.
- `references/qa.md` — writing/fixing tests, test plans, flake hunts.
- `references/infra.md` — CI/CD, build systems, config, deploys, scripts.
- `references/verdict.md` — design decisions, red teams, "which option is right."

No playbook matches (pure algorithm, docs, research)? Proceed with the core
gates — they are domain-complete on their own.

## Playbooks — what the gates mean per task type

| Task | Gate 1 done-means | Gate 2 evidence | Gate 3 attack | Gate 4 verify |
|---|---|---|---|---|
| **Debug** | failure reproduced, then gone | repro + logs + the actual failing path read | 2nd hypothesis + discriminating test; explains ALL symptoms | re-run repro, then the surrounding suite |
| **Build** | named observable behavior exists | existing idiom + the helper you'd duplicate | 2nd design; what does it do better? | drive the feature end-to-end + edges; simplify pass |
| **Review** | verdict with located findings | read the actual diff hunks + callers, not the description | try to falsify each finding before reporting it | confirmed vs plausible, labeled per finding |
| **Research** | question answered with sources | primary sources over summaries-of-summaries | seek the strongest disconfirming source | claims cross-checked ≥2 independent sources |

## Tripwires — catch yourself, stop, back a gate
- Editing a file you haven't read → Gate 2.
- Typing "should work" or "likely fixes" in a conclusion → Gate 4.
- Fix makes a test pass by changing the test → Gate 3; the test was the evidence.
- Adding try/catch, retries, or a sleep to make a symptom disappear → Gate 3; you're
  suppressing, not explaining.
- Second consecutive failure of the same approach → change approach, don't retry harder.
- Can't say why the bug never fired before → diagnosis incomplete, Gate 3.
- About to end the turn on a plan or promise → do it now, then report.

## Standing behavior
- Act without asking on reversible steps that follow from the request. Ask only for
  destructive actions or genuine scope changes.
- Never re-derive facts already established this session; never re-litigate decisions
  the user already made.
- Root cause over symptom, always — but if you must ship a mitigation, label it a
  mitigation and say what the real fix is.
