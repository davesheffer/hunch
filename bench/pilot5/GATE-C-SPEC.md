# PILOT5 Gate C: Codex as the agent

Status: DRAFT, deferred until Gate A v5 is done (2026-09-30). The open questions below are still open. Nothing below runs until the harness changes at the end are
merged with their tests. After the first timed run, any change to a rule here starts version 2.

Gate A ran Claude Code. Gate C asks the same question with OpenAI's Codex CLI as the agent: on the same five frozen
tasks, does `current-hunch` lower main-agent steps and input tokens against `no-hunch` without losing quality?

Everything in `GATE-A4-SPEC.md` (and the files it builds on) still applies unless a section below replaces it. File
and line references to the harness are to `feat/task-benchmark` at `7e08c13`.

## Arms

| Arm | Hunch | Codex surfaces |
| --- | --- | --- |
| `no-hunch` | none | as Gate A: Hunch blocks removed from `AGENTS.md`, Hunch files under `.codex` and `.agents` deleted (`armIsolation.ts:26`), no `.codex/config.toml`, no `.codex/hooks.json` |
| `current-hunch` | tag `v1.42.0`, the audited build of Gate A version 4, unchanged | memory snapshot, `.codex/config.toml` MCP entry, `.codex/hooks.json`, `AGENTS.md` Hunch block |

- `diet-hunch` is dropped (`GATE-A4-REPORT.md`, Recommendation 3). The build is named with its SHA in the manifest
  before the first run. If a release carrying Recommendations 1 and 2 ships first, it is a separate gate, not a swap.
- How Hunch reaches Codex in `current-hunch`, with the audited dist's own writers (the Codex analog of
  `installClaudeHooks`, `armIsolation.ts:400-427`):
  - MCP: `writeCodexConfig` (`src/integrations/providers.ts:218`) writes a marker-delimited `[mcp_servers.hunch]`
    block with `startup_timeout_sec = 60`. Its command is `<node> <audited>/dist/cli/index.js`; the harness adds
    `--root <repo>` and `env.HUNCH_PRIVATE_DIR`, as the Claude arm's `mcp.json` has (`armIsolation.ts:444`).
  - Hooks: `writeCodexHooks` (`providers.ts:366-383`) writes `SessionStart`, `UserPromptSubmit`, `PreToolUse`
    (matcher `apply_patch`), `PostToolUse` (`apply_patch|Bash|PowerShell|shell|local_shell`), `Stop`, `PreCompact`,
    `SubagentStart`, each running `hook --provider codex`.
  - Grounding: `hunch grounding --refresh` refreshes the `AGENTS.md` block. Every starting commit's `AGENTS.md` is
    only a heading and a Hunch block, so `no-hunch` Codex gets no repository instructions at all. Codex does not read
    `CLAUDE.md`, where Gate A's `no-hunch` agents found `npm test`. This is what a Codex user of this repo had.
- Trust, granted deterministically: Codex loads project `.codex/` files only for a trusted project and runs hooks
  only once trusted (`providers.ts:360-365`; users trust through `/hooks`, `src/cli/integrations.ts:33`). The harness
  writes `[projects."<repo>"] trust_level = "trusted"` into the run's own `CODEX_HOME/config.toml` and passes
  `--dangerously-bypass-hook-trust`, both in both arms, so the argv is the same.
- Codex gets less delivery than Claude Code did. Current Codex runs tools through a code-mode `exec` tool; an
  `apply_patch` inside it does not reach the `apply_patch` matcher (`src/core/agenthook.ts:140-144`, an open TODO).
  Expect `SessionStart`, `UserPromptSubmit`, `Stop` and `AGENTS.md`, and little or no per-file pre-edit grounding,
  which carried most delivered records in Gate A. The report counts hook firings by event; it does not assume them.

## Runner

- Argv, both arms: `codex exec --json -m <model> -c model_reasoning_effort="<effort>" --cd <repo>
  --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -o <run>/last-message.txt -`, prompt on
  stdin (built on `codexExecArgs`, `src/synthesis/provider.ts:479`, without its `--skip-git-repo-check`: the run
  repository is a git checkout, and synthesis's neutral-cwd reason does not apply). No `--ephemeral`: the session rollout under
  `CODEX_HOME/sessions` is the measurement source. Web search disabled in the run's config.
- Pinned before the first run, in the manifest: model `<CODEX_MODEL_ID>`, reasoning effort `<EFFORT>`, `codex
  --version` (0.154.0 on the maintainer's Mac on 2026-09-30; the benchmark machine's value is what counts). A version
  other than the manifest's before any run stops the schedule, as in Gate A.
- Sandbox and approvals: bypassed, matching Gate A's `bypassPermissions`. Confinement stays a detective control.
  Network: open, as in Gate A.

## Isolation

- Config home: each run gets its own `CODEX_HOME` under the run directory, holding only the harness's `config.toml`
  and the login. This keeps the maintainer's `~/.codex/config.toml`, `AGENTS.md`, skills, MCP servers, hook trust and
  history out of the child. `~/.codex` joins the deny roots.
- Login: a ChatGPT-subscription `auth.json`, made once with `codex login`, read from a file outside every repository
  (the rule for `--oauth-token-file`, `orchestrate.ts:223-245`). Never an API key: `OPENAI_API_KEY`, `CODEX_API_KEY`,
  `OPENAI_BASE_URL` and every `CODEX_*` except the harness's `CODEX_HOME` are stripped. After each run every token
  string from the file is redacted in the run directory (`redactTokenInDir`, `taskRunner.ts:73`). If Codex rotates the
  refresh token during a run, the harness carries the new file forward; the preflight proves this over two probes.
- Instructions: Codex reads `CODEX_HOME/AGENTS.md` and project `AGENTS.md` files. The Codex analog of finding
  `fnd_3ecd8c0b57` is an `AGENTS.md` in a directory above the run repository. Output goes to
  `C:/bench-out/pilot5-gate-c`, outside the user profile, with no `AGENTS.md` in any ancestor. Preflight probes (the
  design of `taskRunner.ts:378-472`): a canary in the probe repo's `AGENTS.md` must be reported, a canary in an
  `AGENTS.md` one directory above it must not, and the completion probe on the real `~/.codex/AGENTS.md` answers NONE.
- Skills: the starting commits track `.agents/skills/fable-mode`, the Codex copy of the rigor skill (commit 34aa594e,
  "Add repository agent and Codex configuration"). So `fable-mode` applies to Codex too, and Gate A's confound carries
  over. In addition, `no-hunch` deletes that skill's `references/verdict.md` (it names Hunch) and `current-hunch` keeps
  it. Gate C removes both copies, `.agents/skills/fable-mode` and `.claude/skills/fable-mode`, in both arms (Gate S's
  `skill: removed`) before the snapshot hash. Any read of a `fable-mode` path is then an isolation breach.
- Confinement: the same deny roots and rules (`orchestrate.ts:186-190`, `478-491`), applied to every string in the
  rollout's tool inputs: `custom_tool_call` code, `function_call` arguments and `apply_patch` text (file headers
  scanned, patch bodies treated as file content). The `task verify` allowance must hold for the Codex shapes (code-mode
  `exec`, PowerShell); an untimed smoke run per arm is replayed through it before the first timed run.

## Tasks and schedule

The five tasks in `suite.json`, 4 repetitions per arm, plus the harness's tie-break rule: 40 runs, about 7.5 hours at
Gate A version 4's pace (33 runs in 6 hours); Codex's pace is unknown. New seed `pilot5-gate-c-v1`, recorded in the
manifest. About 20 runs per arm cannot detect a 20% time difference (Gate A: about 120 per arm). Steps and tokens
should be less noisy, but their spread under Codex is unknown, so the result is directional. The report gives the
observed within-cell spread and the n it implies.

## Measures

- Primary: main-agent steps (model responses: `token_count` events in the rollout, main thread) and input tokens
  (session total, cached part reported apart; subagents reported apart). If the preflight finds no per-response
  `token_count`, steps become tool calls, fixed before the first run. Quality: the same validators and success rule.
- Secondary: agent time and time minus the longest tool call; full-suite waits (a shell call of 590 s or more, or one
  running `npm test` or `tsx --test test/*.test.ts`) and how many went through `task verify`, as in Gate A version 4;
  hook firings and injected characters by event; delivered and eligible record ids; `hunch_*` MCP calls.

## Criteria

Judged `current-hunch` against `no-hunch`, per task, then pooled; medians.

- Hunch helps on Codex: quality not more than 5 points lower, and median main-agent steps and median input tokens both
  lower on continuation + repeated-bug and not more than 10% higher pooled.
- Hunch hurts on Codex: quality more than 5 points lower, or pooled median steps or input tokens more than 15% higher.
- Otherwise inconclusive; the report names the measure that blocked a decision and the n that would settle it.
- Mechanism check (must hold for the result to count): in `current-hunch`, median hook firings per run at least 1 on
  `SessionStart` and `UserPromptSubmit`, and the Hunch MCP server started. `PreToolUse` firings are reported, not
  required.
- Exclusions and timeouts as `GATE-A4-ANALYSIS-PLAN.md`. No comparison with Gate A's Claude numbers is a criterion.

## Harness change (after the confinement fix of `DEVIATIONS.md` (k))

- A `codex` provider: `RunnerConfig.provider` accepts only `claude | fixture` (`types.ts:75-82`, `orchestrate.ts:354`);
  argv built only for Claude (`taskRunner.ts:171-179`, `219-221`); version stop only for `claude`
  (`orchestrate.ts:604-610`); `evidence_kind` `product` only for `claude` (`orchestrate.ts:740`).
- Per-run `CODEX_HOME` with trust and login, env stripping for `CODEX_*`/`OPENAI_*`, auth redaction and carry-forward.
- A Codex parser: `--json` stdout and rollout into the metrics contract (the parser is Claude stream-json only,
  `transcript.ts:1-3`, `121-137`). Post checks replacing the Claude `init` checks (`orchestrate.ts:614-633`):
  `codex-mcp-exactly-hunch` (`codex mcp list --json`), `hunch-hooks-observed`, and `no-hunch` equivalents.
- Hook firings: the rollout has no hook events, so the hook command runs through a harness wrapper that records each
  event name and output to the run directory and passes the output through unchanged.
- `current-hunch` setup through the audited `writeCodexConfig`/`writeCodexHooks`; `.codex/` exposure checks in both
  arms; the Codex preflight probes (above); `skill: removed` from Gate S.
- Tests: a Codex argv snapshot; a stripped env with a planted `OPENAI_API_KEY` and `CODEX_API_KEY`; a fixture rollout
  whose steps, tokens and tool inputs parse to known values; a fixture code-mode call reading a deny root is flagged
  and one running `task verify` through the audited entrypoint is not; a version change stops the schedule; the
  ancestor-`AGENTS.md` probe fails when the canary is reported; auth redaction leaves no token string in the run.

## Open questions for David

1. Keep `v1.42.0`, or wait for the build with `GATE-A4-REPORT.md` Recommendations 1 and 2?
2. Remove `fable-mode` in both arms (proposed), or keep it present in both and count reads?
3. Model id and reasoning effort for Codex.
4. Codex's defaults as shipped (code mode on, the edit-hook gap included), or code mode off to test full hook delivery?
5. Bypass the sandbox as Gate A did (proposed), or run `workspace-write`?
6. Is 4 repetitions (about 7.5 hours) acceptable, or 3?
