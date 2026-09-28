# PILOT5 Gate A harness design

Design for `hunch task benchmark` (plan: `docs/HUNCH-CONTEXT-EFFICIENCY-POC.md`, sections 3.1, 7, 8, 11, 15).
Frozen before any timed run. A change to any rule below after the first timed run starts a new experiment version.
Amended 2026-09-28, before any Gate A timed run, to close the adversarial review of the harness: agent-surface files
that mention Hunch are removed in `no-hunch`, and the preflight and post-run checks below were added. Amended again the
same day after an untimed two-run smoke suite (not part of Gate A) showed two harness artifacts in `current-hunch`: the
repo `.mcp.json` and the audited CLI entrypoint allowance below.

## Revisions

| Role | What | Rule |
| --- | --- | --- |
| Controller | `hunch task benchmark` code | Runs from a clean worktree of the harness commit. Refuses a dirty tree. |
| Audited Hunch | The product the `current-hunch` arm uses | A separate clean worktree at the audited revision, built with `npm ci && npm run build`. Only its `dist/` is used. Pilot 5: tag `v1.42.0` (5ff071a), the published 1.42.0; PR #441 is not included. |
| Target | The code the agent edits | Per task: the card's `starting_commit`, rebuilt without `.hunch/` (below). |
| Memory | The `current-hunch` arm's input memory | Per task: cutoff-bounded snapshot (below), frozen and hashed before the first run. |

## Target repository (both arms)

1. Fetch `starting_commit` into a scratch bare repository as `refs/heads/start`.
2. `git fast-export --signed-tags=strip --tag-of-filtered-object=drop refs/heads/start -- . ':(exclude).hunch'`
   piped into `git fast-import` in a fresh repository. Commits that touched only `.hunch/` disappear.
3. Proof: `git ls-tree -r <starting_commit>` minus `.hunch/` entries hashes equal to `git ls-tree -r HEAD` of the rewritten
   repository, and `git log --all -- .hunch` is empty. The map from `starting_commit` to the rewritten head is recorded.
4. Per run: `git clone --no-local --no-tags` of that base into the run directory, remove `origin`, set
   `core.hooksPath` to an empty directory, set a fixed benchmark author, run `npm ci`.

Reason: a worktree of the source repository would expose every future commit through `git log --all`, and the starting
commit's own `.hunch/` holds records written after the issue arrived.

## Memory snapshot (`current-hunch` only)

Cutoff = the issue's `createdAt`.

- Public (amended 2026-09-27, before any run): candidate paths = `.hunch/` paths in the starting commit's tree plus
  the tree of the last first-parent `origin/main` commit at or before the cutoff. For each path, take the blob from
  `git log -1 --before=<cutoff> <starting_commit> -- <path>` (falling back to that main commit); exclude the path
  when no pre-cutoff commit touches it or the file is deleted there. This matches the cards' eligibility rule (first
  add before the cutoff, in history the task's checkout can reach) and gives each record's pre-cutoff content. A record
  that existed only on an unmerged branch at the cutoff is excluded as unreachable.
- Private: the `.hunch/` tree of the last private-overlay commit whose committer date is at or before the cutoff.
- Secondary guard: drop any record whose own capture timestamp is at or after the cutoff; log each drop.
- Drop `team.json` and `local.json` if present (they would point the store outside the snapshot).
- The snapshot is the whole cutoff-bounded memory, not only the card's `eligible_record_ids`. Mounting only hand-picked
  relevant records would give Hunch a distractor-free graph that no user has. `eligible_record_ids` label expected
  relevance and are checked for delivery after each run.
- Hash: sha256 over sorted `path\0sha256(content)\n` lines. Both hashes go in the manifest.
- The public part is copied to `<repo>/.hunch/`; the private part to `<run>/private/.hunch`, outside the repository, and
  exposed only through `HUNCH_PRIVATE_DIR` in the `current-hunch` child and its MCP server.

## Arm exposure

Both arms: the same rewritten repository, prompt, runner argv (except the MCP config file), model, effort, timeout and
validator. One setup commit (`bench: arm setup`) so the agent starts from a clean tree.

`no-hunch`:
- Remove every `<!-- HUNCH:START … -->` … `<!-- HUNCH:END -->` block from tracked files (CLAUDE.md, AGENTS.md and any other).
- Delete `.claude/commands/*.md` files that carry the `hunch:generated` marker.
- Delete every tracked file under `.claude/commands`, `.claude/skills`, `.claude/agents`, `.cursor/rules`, `.codex` and
  `.agents` whose path or content matches `/hunch/i` (amended 2026-09-28). Reason: the starting commits carry
  Hunch-scaffolded `capture.md`/`heal.md` without the `hunch:generated` marker, and a `hunch.mdc` rule whose frontmatter
  survives block removal.
- No `.hunch/`, no `.mcp.json`, no Hunch hooks, no `HUNCH_*` variables.
- Child MCP config: `{"mcpServers":{}}` with `--strict-mcp-config`.

`current-hunch` (audited dist, product writers, no `hunch init` because it installs Git hooks unconditionally):
- Copy the public snapshot into `.hunch/`.
- `installClaudeHooks(repo, "<node> <audited>/dist/cli/index.js hook")` and `writeSlashCommands(repo)` imported from the
  audited dist.
- `hunch grounding --refresh` and `hunch index` with the audited CLI.
- Child MCP config: one `hunch` server = `<node> <audited>/dist/cli/index.js mcp --root <repo>`, env `HUNCH_PRIVATE_DIR`.
- The same single server is written to `<repo>/.mcp.json` (amended 2026-09-28, after an untimed smoke run). A
  `hunch init` user has that file; without it the audited SessionStart hook injects an "integration needs attention"
  warning that no real user sees. The child still loads only the MCP config file under `--strict-mcp-config`. Exposure
  check `repo-mcp-json-matches`.

The snapshot-hash check runs right after the snapshot is copied, before the audited writers and `hunch index` run
(`index` legitimately rewrites `components/`); the post-setup `.hunch` hash is recorded separately.

Proof before the timer (written to `exposure.json`): marker scan, command scan, hook scan, `.hunch` presence and history,
MCP config, child environment keys (names only), snapshot hash, and for `no-hunch` `agent-surfaces-clean` (no file,
tracked or not, under the agent-surface directories above matches `/hunch/i`). Proof after the run from the transcript
(amended 2026-09-28):
- `current-hunch`: `mcp-servers-exactly-hunch` (the `init` event lists exactly one MCP server, `hunch`),
  `mcp-hunch-connected` (its status is `connected`), `hunch-hooks-observed` (at least one hook event with non-empty
  output; the audited SessionStart hook always emits).
- `no-hunch`: `mcp-servers-empty`, `hunch-tools-absent` (no `mcp__hunch__*` in the `init` tool names),
  `hunch-tool-calls-zero`, `hunch-hook-output-zero`.
- Both arms: `no-out-of-repo-access` (below).

A run that fails any setup or post check is invalid, not failed.

User-level instructions (`~/.claude/CLAUDE.md`) load in both arms under `--setting-sources project`. They are recorded by
sha256 and must contain no `hunch` string; unrelated user instructions are preserved as the plan requires.

## Runner

- Provider: Claude Code CLI on a subscription. Argv, both arms:
  `claude -p <prompt> --output-format stream-json --verbose --include-hook-events --setting-sources project
  --strict-mcp-config --mcp-config <file> --no-session-persistence --permission-mode bypassPermissions
  --model <pinned> --effort <pinned>`. Pilot 5: `--model claude-opus-5-5`; no `--effort` flag (CLI default, recorded as
  `effort: null`).
- Child environment: delete `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY`, `CURSOR_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, every `HUNCH_*`, every `GIT_*` except `GIT_EDITOR`, `CLAUDECODE`, and every
  `CLAUDE_*` / `CLAUDE_CODE_*` variable except `CLAUDE_CODE_GIT_BASH_PATH`. Then add `DISABLE_AUTOUPDATER=1` (both arms)
  and the arm's own `HUNCH_PRIVATE_DIR`.
- `claude --version` runs before every timed run; a version other than the manifest's stops the schedule.
- Preflight (fails closed, no timed run after a failure): executable found, `--version` recorded, stripped environment
  asserted, one untimed probe with the `no-hunch` flags in an empty directory must succeed with `apiKeySource: "none"`,
  report no MCP server (`probe-mcp-empty`) and no `mcp__*` tool (`probe-no-mcp-tools`) (amended 2026-09-28).
  Record CLI version, the reported model, and sha256 of the argv with the prompt and paths replaced by placeholders.
- Timeout: 30 minutes. Windows: `taskkill /pid <pid> /T /F`; POSIX: detached group, `kill(-pid)`.
- Confinement: `bypassPermissions` does not confine Bash on Windows. Detective control: `git status --porcelain` and
  `HEAD` of the source repository, the controller and the private overlay before and after each run; any change marks
  the run `isolation_breach`. Added 2026-09-28: every string in the transcript's tool inputs is scanned for a path
  under the source repository, the private overlay, the audited worktree, the controller or the output directory
  (path-boundary match, MSYS `/c/` paths normalized, mentions of the run's own directory ignored), and for any three
  consecutive `../` segments. In `current-hunch`, mentions of the exact file `<audited>/dist/cli/index.js` are also
  ignored, because the audited UserPromptSubmit hook tells the agent to run checks through
  `<node> <audited>/dist/cli/index.js task verify`; every other audited path stays denied. Any hit fails `no-out-of-repo-access` and marks the run `isolation_breach`.
- Auto memory (added 2026-09-28): Claude Code keeps auto memory per working directory under
  `~/.claude/projects/<path with non-alphanumerics as ->`. Before each run an existing directory for the run's repo path
  is renamed `.bench-stale-<n>` and logged, so a rerun after an interruption starts without memory; the `init` event's
  auto-memory path is recorded as evidence.

## Metrics (section 7 contract)

From the stream-json transcript:
- Tokens: `result.usage`; `input_tokens` = input + cache creation + cache read, with the three parts kept;
  `token_measurement: "provider"`. `modelUsage` kept per model.
- `model_calls`: distinct assistant `message.id`; `tool_calls`: `tool_use` blocks; `call_measurement: "parsed"`.
  Per-tool histogram kept. Investigation calls = `Read`, `Grep`, `Glob` (preregistered definition).
- Hunch context estimate: characters of `mcp__hunch__*` tool results, hook-event output, the grounding blocks in
  CLAUDE.md and AGENTS.md, and the `mcp.tools_list` surface from the audited `hunch footprint --json`; tokens =
  ceil(chars / 4), components kept. Zero for `no-hunch` only when the exposure proof passed.
- Delivered memory: record ids (`dec_`, `con_`, `fnd_`, `bug_`, `htask_`) found in Hunch-injected text; intersect with
  `eligible_record_ids`.
- Timing: `agent_wall_clock_ms` from just before spawn to process-tree exit; `validation_ms` for the validator only.

## Schedule

- Tasks in suite order. Repetition 1 arm order from sha256(`seed|task|1`) low bit (last hex digit of the hex digest,
  `& 1`): 0 keeps the `--arms` order, 1 reverses it; later repetitions alternate. Pilot 5 seed: `pilot5-gate-a-v1`.
- Two repetitions. When one arm's two runs disagree on success for a task, one extra paired repetition for that task.
- Sequential runs. Resume: an existing `run.json` under the same manifest hash is kept, never rerun. A run directory
  without `run.json` (interrupted) is renamed `<dir>.interrupted-<n>`, kept, and rerun. Invalid runs are recorded, not
  retried.

## Validation

After the child exits: copy the task's validator into `<repo>/test/`, run
`<node> node_modules/tsx/dist/cli.mjs --test test/<validator>` with a 10-minute timeout and the stripped environment.
Exit 0 = passed. Validator files are hashed against the suite before the first run. The validator's `HOME`,
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` point under `<run>/validator-home`.

`quality.outcome` is the validator result for every run with a valid exposure. `success` is true only when the
validator passed and the run completed: agent exit 0, `result.is_error` false, no timeout, exposure proven before and
after the run (every setup and post check above), and no isolation breach.

## Output

`<output>/manifest.json` (immutable), `snapshots/<task>/`, `runs/<task>/<rep>-<arm>/{transcript.jsonl, stderr.txt,
exposure.json, validator.txt, run.json}`, `report.json`, `report.md`. The report lists every observation, median and
range per arm and category, and prints no percentage when either side lacks provider tokens. Transcripts stay in the
git-ignored output directory, never in durable memory.
