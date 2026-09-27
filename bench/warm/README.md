# Warm-memory cost benchmark

**Question:** on a repo that has used Hunch for months, does Hunch make a real
task cheaper, net of its own overhead? This is the claim the zod time-split
benchmark (`bench/external/`) could not test: zod's graph was backfilled from
commit history only, and it showed no accuracy or turn advantage (2026-08-23,
26 tasks).

## Protocol (fixed before the first model run, 2026-09-27)

- **Tasks.** Merged PRs in this repo, 2026-09-17..09-26, that closed exactly one
  GitHub issue and changed both `src/**.ts` and `test/**.test.ts`. A task is
  valid only if the PR's tests fail on the base tree and pass with the PR
  applied (`run.ts prepare`). All valid tasks are used, unless there are more
  than 12: then the 12 with the lowest PR numbers after sorting by
  `sha256(pr)` are used.
  *Harness fix, 2026-09-27, before any model run:* the first `prepare` pass
  ran every base's tests through `tooling/run-tests.mjs`, which only exists
  from 2026-09-23. On older bases both red and green crashed with
  MODULE_NOT_FOUND. `run.ts` now uses the runner each base had (`tsx --test`
  before that date), treats a runner that fails to load as a harness error
  rather than a red or green result, and all rejected PRs were re-prepared.
  The selection rule is unchanged.
  *Result:* 23 of 29 candidate PRs are valid. pr338 was rejected because its
  tests already pass on the base. pr322, pr336, pr343, pr348 and pr350 were
  rejected because their tests fail with the PR applied. pr343 and pr348 were
  checked at their real merge commits and fail there too (macOS
  `/private/var` path handling), so those rejections are not harness
  artifacts. Selected by the sha256 rule: 342, 344, 431, 347, 328, 365, 341,
  330, 358, 346, 392, 349.
- **Sealing.** The agent works in a clone holding history through the PR's base
  only (the fix commit is absent). No network (sandbox, `deniedDomains: *`);
  reads of the live repo, the private overlay, `~/.claude/projects`, `~/.hunch`
  and `~/.npm` are denied. Operator settings, memory and MCP servers are
  excluded (`--setting-sources project --strict-mcp-config`; verified).
- **Prompt.** The issue title and body as filed, plus the names of the PR's
  test files (placed in the tree, failing) and how to run them. Identical for
  both arms.
- **Arms.**
  - A: no Hunch. `.hunch/`, `.mcp.json`, hooks, Hunch commands and the
    `HUNCH:START..END` blocks are removed.
  - C: the repo as committed at base (memory as it was at that time, block,
    hooks, MCP), with every Hunch command repointed at a frozen copy of
    Hunch 1.42.0.
- **Model:** `claude-sonnet-5`, max 150 turns, 3 reps per task and arm,
  alternating arm order. *Changed from 60 after the smoke, before any scored
  run:* both pr431 smoke sessions hit the 60-turn cap (`error_max_turns`)
  mid-verification, which would truncate cost at the cap in both arms. A
  session that hits 150 is still scored and reported as censored.
- **Primary outcome:** cost in USD per task (`total_cost_usd`, which includes
  Hunch's own context overhead). Paired by task: the mean over tasks of
  (C mean ÷ A mean), with a 95% bootstrap CI.
- **Secondary outcomes:** turns, wall time, tokens, pass rate. A pass means the
  PR tests pass, `tsc --noEmit` passes and the test files are untouched.
- **Decision rule.**
  - "Hunch saves money" requires the cost-ratio CI upper bound to be < 1.00,
    with C's pass rate not lower than A's by more than one task.
  - A CI spanning 1.00 is reported as "no measurable saving".
  - A lower bound > 1.00 is reported as "Hunch costs more".
- **Known threats.**
  - Arm A can still reach `.hunch/` via git history. Tool inputs touching
    `.hunch` are counted per run (`touchedHunchDir`) and reported.
  - This is one repo, the product's own, with the richest memory Hunch has.
    That is deliberately favourable, so a null here is strong evidence.
    A win here still needs replication on another team's repo.
  - Issues were often filed by an audit agent and describe the root cause.
    That lowers the ceiling for any memory benefit.

## Commands

```bash
npx tsx bench/warm/run.ts prepare <pr,pr,...>       # validate tasks, no model
npx tsx bench/warm/run.ts run --only <pr> --reps 1  # smoke
npx tsx bench/warm/run.ts run --reps 3 --concurrency 4 --out bench/warm/results/full.json  # full, resumable
# --concurrency N runs N sessions at once: cost and turns are unaffected; wall time
# is then measured under shared load (each row records its concurrency)
npx tsx bench/warm/run.ts report bench/warm/results/<file>.json
```

## Running the full benchmark on another machine (Windows PC → WSL2)

The sealed run relies on Claude Code's sandbox, which works on macOS and
Linux, **not native Windows**. On a PC, run everything inside WSL2 (Ubuntu).
Keep the clone in the Linux filesystem (`~/hunch`), not under `/mnt/c`. The
harness refuses to start on native Windows.

**One-time setup (Ubuntu shell in WSL2):**

```bash
sudo apt update && sudo apt install -y git bubblewrap socat build-essential   # bubblewrap + socat = Claude Code sandbox
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && source ~/.bashrc
nvm install 22                                          # Node ≥ 22.13
npm i -g @anthropic-ai/claude-code && claude            # log in with the subscription, then /exit
git clone https://github.com/davesheffer/hunch.git ~/hunch && cd ~/hunch
git checkout bench/warm-cost
npm ci && npm run build && node dist/cli/index.js --version   # → 1.42.0
```

**1. Re-validate the tasks on this machine (no model, ~10 min).** Tests were
validated on macOS. Any task printed as `INVALID HERE` must be dropped from
`--only` below for this machine; record which ones.

```bash
npx tsx bench/warm/run.ts check --only 342,344,431,347,328,365,341,330,358,346,392,349
```

**2. Smoke (2 sessions, ~15 min).** Confirms the sandbox, hooks and MCP work
under Linux.

```bash
npx tsx bench/warm/run.ts run --only 344 --reps 1 --out bench/warm/results/smoke-wsl.json
```

Go on only if both `■` lines show no `INFRA`, have a `$` cost, and the C line
has `hunch=` > 0. If the sandbox refuses to start, check that `bwrap` and
`socat` are installed and that you are inside WSL2, not WSL1
(`wsl -l -v` in PowerShell).

**3. Full run (72 sessions, ~3–4 h at concurrency 4).**

```bash
nohup npx tsx bench/warm/run.ts run \
  --only 342,344,431,347,328,365,341,330,358,346,392,349 \
  --reps 3 --concurrency 4 --out bench/warm/results/full.json \
  > bench/warm/results/full.log 2>&1 &
tail -f bench/warm/results/full.log     # ▶ started / ■ finished
```

- **Usage limit:** the run drains and exits 3. Rerun the identical command
  later and it resumes; finished rows in `full.json` are skipped.
- **Sleep:** keep the PC awake. Closing the WSL terminal is fine with `nohup`,
  but Windows sleep suspends WSL.
- **Result:** `npx tsx bench/warm/run.ts report bench/warm/results/full.json`,
  judged only against the decision rule above. Commit `full.json`, `full.log`,
  the report output and the `check` output together. The machine is part of
  the record: the smoke ran on macOS, the full run on WSL2 Linux.
