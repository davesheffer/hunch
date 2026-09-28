# PILOT5 Gate A, version 2: three arms and a hook diet

Status: DRAFT for approval. Nothing below runs until this file is committed. After the first timed run, any change to
a rule here starts version 3.

Gate A (version 1, `GATE-A-REPORT.md`) failed the existing-Hunch criteria and left two measurement problems open: the
maintainer's user-level instructions loaded into every child, and a legitimate way of invoking the audited CLI was
flagged as an isolation breach. Version 2 fixes both and adds a third arm that tests one hypothesis: Hunch's hooks
inject too much text, and less of it costs fewer tokens and steps without losing quality.

Everything in `GATE-A-HARNESS.md` still applies unless a section below replaces it.

## Arms

| Arm | Hunch revision | Hooks, MCP, memory |
| --- | --- | --- |
| `no-hunch` | none | as version 1 |
| `current-hunch` | tag `v1.42.0`, unchanged | as version 1 |
| `diet-hunch` | tag `v1.42.0` plus the hook-diet commits only (below), built the same way in its own clean worktree | as `current-hunch`, with its own audited root |

The diet branch starts from `v1.42.0`, not from `main`, so the diet is the only difference between the two Hunch arms.
Its commit SHA is recorded in the manifest before the first run. Every rule that version 1 applies to "the audited
CLI" applies to each Hunch arm's own audited root: exposure checks, the confinement deny roots (both audited worktrees
are denied in every arm), and the invocation allowance.

## The hook diet (fixed before any version 2 run)

Designed from the aggregate hook evidence in `GATE-A-REPORT.md` (injections by event across all `current-hunch`
runs), not from per-task outcomes. In version 1, `PostToolUse` carried 55% of injected hook text, and its largest
injections were the shell-write catch-up with full per-file grounding. `PreToolUse` carried 22.5%, much of it repeated
"unchanged this session" lines.

- D1. Shell-write catch-up becomes a pointer. When a Bash or PowerShell command wrote files Hunch has records for,
  the hook emits one line per file (at most three files, as now) naming the record ids that apply and
  `hunch_why("<file>")`. A blocking invariant scoped to the file keeps its one-line statement. No full grounding, no
  sibling-fix lesson body (a pointer line says one exists), no instruction to re-check. The pointer does not count as
  serving the file's grounding, so a later Edit of that file still receives it. A file whose grounding was already
  served this session gets no pointer, and the same pointer is not repeated.
- D2. Repeats are silent. When the session dedupe says a file's grounding is unchanged, the hook emits nothing.
  Delivery receipts are still recorded.
- D3. Session budget. Full file grounding injected by the pre-edit hook is capped at 8,000 characters per session
  (about 2,000 tokens), counted per agent identity like the dedupe. A grounding that would cross the cap is replaced
  by the D1 pointer line. The budget resets when the dedupe resets (compaction).
- Out of scope, unchanged: SessionStart orientation, UserPromptSubmit text, SubagentStart slices, Stop messages,
  strict-mode deny reasons, pipeline checkpoint and lesson reminders, and `task verify`.
- Product safety: `HUNCH_HOOK_DIET=0` restores the `v1.42.0` behaviour. The benchmark child never sets it.

## Neutral user configuration (all arms)

Replaces "User-level instructions ... are preserved" in `GATE-A-HARNESS.md`. Version 1 showed that the maintainer's
user-level `CLAUDE.md` loads under `--setting-sources project` and that `claudeMdExcludes` does not remove it. A probe
child quoted it verbatim, and every convention run in both arms routed subagents as those instructions direct. That is
maintainer-specific behaviour, not what a Hunch user gets.

- Each run gets its own empty `CLAUDE_CONFIG_DIR` under the run directory. This moves user instructions, user
  settings, credentials and auto memory out of the child's reach, so the auto-memory rename step is no longer needed.
- Login: `CLAUDE_CODE_OAUTH_TOKEN` from a subscription token made once with `claude setup-token`, read from a file
  outside every repository. Never an API key. The token is never written to output, transcripts or the manifest; the
  manifest records only that it was present.
- The harness's `CLAUDE_*` stripping keeps exactly `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` (plus
  `CLAUDE_CODE_GIT_BASH_PATH`, as now). Both are set by the harness; the parent's values are never inherited.
- The child can read its own environment, so a command such as `env` could print the token. After each run the
  harness replaces every occurrence of the token in the run directory with a placeholder and records the count.
- The user-level configuration directory (`~/.claude`) joins the confinement deny roots in every arm.
- Preflight probes, all under the neutral environment; any failure stops the schedule:
  - a user-level `CLAUDE.md` placed in a probe config directory and a project `CLAUDE.md` in the probe working
    directory each carry a random marker, and the child must report both (user instructions are read from the new
    location, and project instructions still load);
  - with an empty config directory, the child must answer NO when asked whether one distinctive line of the
    maintainer's real user-level `CLAUDE.md` appears in its context (the line is not recorded);
  - project hooks loading in a Hunch arm is checked on every run by the existing `hunch-hooks-observed` check.

## Confinement: the audited CLI through a shell variable

Replaces the "Known false positive" paragraph in `GATE-A-HARNESS.md`. An assignment
`[export ]NAME=[quote]<audited>/dist/cli/index.js[quote]` at a command boundary is ignored only when every other use
of `NAME` in the same string invokes it: `$NAME` or `${NAME}` as the command word (optionally behind `node`) after the
start, `;`, `&`, `|` or a new line that is not a backslash continuation, followed on the same line by a subcommand
or flag. Any other use (`cat "$H"`, `grep node "$H"`, `arr=("$H")`, `G="$H" …`, `${H%x}`, `process.env.H`) keeps the
mention denied. Reviewed adversarially before commit.

Known gaps, adversarial only, unchanged from version 1: code that builds a deny path from parts, `$HOME/..` climbs,
and the direct form `<reader> <audited>/dist/cli/index.js -n`, which passes the invocation rule because it has no
command-position check, and a boundary character inside a quoted string (`echo "|$H x" | … | xargs cat`), which the
check reads as a command boundary. A variable assigned in one Bash call and used in a later call is denied (a false
positive this version accepts), as are `{ "$H" task; }`, `("$H" task)` and a full quoted path to `node.exe`.

## Harness changes

- Three arms per schedule. The arm order per task and repetition comes from the seeded shuffle, as in version 1.
- `--diet-root <worktree>` for the `diet-hunch` audited root, with the same clean-build checks as `current-hunch`.
- Report: each Hunch arm against `no-hunch` under the plan's section 9 criteria, and `diet-hunch` against
  `current-hunch` (below).
- New per-run metrics: injected hook characters by event (from `hook_response` events, additional context only), and
  the number of turns started by background task notifications.

## Criteria

- `current-hunch` and `diet-hunch` are each judged against `no-hunch` under the same four existing-Hunch criteria as
  version 1.
- Diet mechanism check (must hold for the diet result to count): median injected hook characters per run on the two
  events the diet changes, `PreToolUse` and `PostToolUse`, for `diet-hunch` at most half of `current-hunch`. The
  unchanged events set a floor (version 1: median 3.2k characters per run of 16.6k), so a check on the total would
  test the floor as much as the diet. The total is still reported.
- The diet counts as an improvement only if, against `current-hunch`, it keeps quality (no more than 5 points lower)
  and lowers the median of both provider input tokens and main-agent steps on the same tasks.

Same five frozen tasks, repetitions, model, timeout and validators as version 1.
