# bench — does the skill / the graph actually help?

> **Historical harness only.** `bench/run.ts`, `bench/tasks.json`, and every
> existing `bench/results` file predate the fresh G3 preregistrations and are
> explicitly excluded from EXP-01 and EXP-03. They must never be relabeled as a
> preregistered sample or merged into the new denominators.

Measures whether the fable-mode skill and the Hunch graph make a model converge
faster and answer better **on this repo**. Three arms, identical tasks:

| arm | skills (`.claude/skills`) | hunch MCP | CLAUDE.md hunch section |
|-----|---------------------------|-----------|-------------------------|
| A   | stripped                  | no        | stripped                |
| B   | kept                      | no        | stripped                |
| C   | kept                      | yes (published `@davesheffer/hunch` over `.mcp.json`) | kept |

Each run gets a fresh detached worktree at a pinned commit (node_modules
junctioned from the main repo). Fix tasks re-introduce a real shipped bug by
exact-string revert, so the hidden regression test fails until the model finds
the root cause. Operator-level plugins, skills, hooks, and MCP servers are kept
out of every arm (`--setting-sources project`, `--strict-mcp-config`).

Scoring is deterministic: question tasks = checklist regex hits against the
final answer; fix tasks = hidden test passes AND was not modified.

```bash
npx tsx bench/run.ts --dry-fix f1-guard-keying   # plumbing check, no model
npx tsx bench/run.ts --smoke                     # 1 cheap haiku run end-to-end
npx tsx bench/run.ts                             # the real thing: 6 tasks x 3 arms x 2 reps = 36 Opus sessions
npx tsx bench/run.ts --arms A,C --reps 1 --model claude-opus-4-8 --only q1-capture-flow
```

Results: `bench/results/<stamp>.json` (gitignored) + a printed markdown table
(mean score / mean turns per task x arm). Metrics per run: score, turns, tool
calls (hunch calls counted separately), duration, cost.

Honest-reading notes:
- Expect C to win broad cross-file questions and to carry overhead on narrow
  ones (prior A/B finding). B's marginal effect is the open question.
- The graph contains decisions ABOUT the seeded bugs (that's the product
  working, not leakage — but say so when publishing numbers).
- Checklist scoring measures fact coverage, not prose quality. Read a few
  answers by hand before trusting a delta.

## Fresh preregistered experiment runner

The durable runner is exposed through `hunch experiment`, not this legacy
script:

```text
hunch experiment validate <case-bank.json>                # read-only preflight
hunch experiment prepare <case-bank.json>                 # immutable lock
hunch experiment create <case-bank-id> --sample-per-arm <target> --actor human:<id> --reason <text> [--provider claude-cli|codex-cli --model <exact-model>]
hunch experiment run <run-id> [--limit 1]                 # EXP-01 only
hunch experiment next <run-id> --reviewer human:<id>      # EXP-03 only
hunch experiment submit <run-id> <assignment-id> <json>   # machine-timed
hunch experiment followup <run-id> <assignment-id> <json>
hunch experiment stop <run-id> <json>
hunch experiment status|report <run-id>
```

Case banks, assignment manifests, outcomes, review starts, seven-day
follow-ups, and stop receipts are private, content-addressed, and append-only.
The manifest contains the full preregistered target before the first outcome;
the minimum-per-arm value is a protocol checkpoint, never an outcome-dependent
stopping point. EXP-01 uses fresh detached worktrees, an explicitly selected
subscription CLI, ambient-instruction stripping, and a hidden external
evaluator. EXP-03 reveals only the assigned treatment and derives review time
from its recorded start. Reports retain every assignment and raw denominator,
include Wilson intervals, deterministic bootstrap intervals, Fisher exact
contrasts, and stop immediately on a recorded safety/privacy guardrail. They
carry `authority:none` and cannot activate policy or authorize a public claim.

### EXP-03 revision 2 reviewer contract

Revision 1 is an onboarding/UX pilot only and must not be resumed. Every fresh
revision-2 case must state the durable required relationship in plain language.
All three arms then show the same question: “Does the proposed rule accurately
preserve the required relationship described above?” The reviewer chooses one
of four plain outcomes: use as written, correct then use, reject, or cannot
decide from the evidence. The returned `response_template` is the manual
fill-in format; no knowledge of Hunch policy internals is expected.

Training examples and comprehension checks are excluded from timed assignments.
The timed reviewer must not have labeled the target cases. A revision-2
preregistration, fresh held-out case bank, and fresh assignment manifest are
required; revision-1 starts and outcomes remain append-only pilot evidence.
