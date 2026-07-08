# bench — does the skill / the graph actually help?

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
