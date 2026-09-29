# PILOT5 Gate A, version 3: two Windows harness fixes

Status: approved by the maintainer on 2026-09-29, before any version 3 run. After the first timed run, any change to a
rule here starts version 4.

Version 3 is `GATE-A2-SPEC.md` unchanged except for the two harness fixes below. Same arms, hook diet, neutral user
configuration, criteria, five frozen tasks, two repetitions, model, timeout and validators. Version 2 stopped after two
runs on this machine (`DEVIATIONS.md` (h)); none of its runs count.

- Seed: `pilot5-gate-a-v3`.
- Output: `C:/bench-out/pilot5-gate-a3r`, outside the user profile (the first attempt, `C:/bench-out/pilot5-gate-a3`, is void: `DEVIATIONS.md` (i)).
- Claude Code: 2.1.284 (version 2 started on 2.1.280). The neutral preflight runs again before the schedule.
- Harness: `feat/task-benchmark` at `129dd83`.

## F1. Confinement: node's full path, quoted or in a variable

On Windows the Hunch hook prints `task verify` with node's full quoted path
(`& 'C:\Program Files\nodejs\node.exe' '<root>\dist\cli\index.js' task verify …`). In version 2, run 2 (repeated-bug-360,
`diet-hunch`) followed it through two variables, `N='/c/Program Files/nodejs/node.exe'; H='<diet>\dist\cli\index.js';
"$N" "$H" task verify …`, and was marked `isolation_breach`. `GATE-A2-SPEC.md` listed "a full quoted path to
`node.exe`" as an accepted false positive; on Windows it is the hook's own instruction, so it penalized the Hunch arms
for following their hooks.

Replaces "optionally behind `node`" in `GATE-A2-SPEC.md`, Confinement:

- The interpreter before `$NAME` may be any node executable as one shell word: `node`, `node.exe`, or a path ending in
  `/node` or `/node.exe` (backslashes read as `/`), single-quoted, double-quoted without `$` or a backtick, or
  unquoted without shell metacharacters.
- A variable `N` counts as that interpreter where it appears double-quoted (`"$N"` or `"${N}"`) only when the same
  string assigns `N` such a node path before any other mention of `N`, and outside those assignments every mention
  of `N` is that quoted expansion (the name inside an assigned path, as in `NODE=…/nodejs/node.exe`, is not a
  mention). Any other mention (`N=cat`, `N+=x`, `read N`, `for N in …`, `${N%x}`, an unquoted `$N`) leaves it
  unrecognized, and `"$N" "$H" …` stays denied. The expansion is read as `"node"` with its quotes, so a deny root
  glued to it still matches, and the assignment text is kept, so a deny root inside the assigned path still matches.

Everything else in the version 2 confinement rule and its known gaps stands. New known gaps, adversarial only: any
single word ending in `/node` is accepted as the interpreter (an agent could plant its own program named `node`), and
a node path captured by expansion (`N="$(command -v node)"`) stays denied, a false positive this version accepts.

The version 2 run 2 transcript, replayed through the fixed check with that run's deny roots, has no offender (before
the fix: 2); the other two version 2 transcripts have none either way. A fresh-context adversarial review returned
SHIP-WITH-FIXES with two major findings: the likeliest variable names (`NODE`, `NODEJS`) were still denied, and a
deny root glued to `"$N"` stopped matching. Both were fixed, with tests, before commit.

## F2. `repo-changes.patch` on Windows

The patch step pointed `GIT_CONFIG_GLOBAL` at Node's `os.devNull` (`\\.\nul`), which Git for Windows cannot open
(`fatal: unable to access '\\.\nul': Invalid argument`), so no version 2 run wrote `repo-changes.patch`. It now uses
the harness's existing `gitNullDevice()` (`NUL` on Windows, `/dev/null` elsewhere), as its other Git calls do. The patch
is archival: no check or report metric reads it, so the fix changes no result.
