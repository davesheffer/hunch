# PILOT5 deviations from the selection rule

Dated 2026-09-27. Recorded before any benchmark arm ran.
`SELECTION.md` stays as preregistered; this file lists every amendment to how it was applied, with reason and effect.

## (a) Rule 4 read per issue slice

- Rule: for a bundled fix commit, count the non-test source files in the issue's own separable slice. Rule 5 decides
  whether a slice is separable. Applied uniformly to every candidate.
- Reason: several fixes landed in multi-issue commits (5558d6d closes 8 issues; a6eb1c60 closes 10). Counting the whole
  commit would exclude issues whose own change is small and isolable, while rule 5 already guards isolation.
- Effect:
  - continuation: #375 qualifies first in the walk and replaces #372 (pending the other builder's proof).
  - convention: #357 is excluded only as `excluded: category mismatch` (#356 merged after #357 arrived; no recorded convention at the cutoff).
  - operation: #378 is excluded under rule 3 (its fix is test-only, like #270). #268 qualifies by its slice: 2 of the commit's 7 non-test source files.
  - self-contained: #394 qualifies by its slice: 1 non-test source file, which also carries #395's one-word CSS change.

## (b) Node 24.13.0 for validation runs

- Rule 2 names Node 22. Every validation run used Node v24.13.0, the version installed on this machine.
- Reason: the package declares `engines.node >=22.13.0`, which 24.13.0 satisfies.
- Effect: none observed. The #268, #314 and #394 validators failed at their starting commits and passed at their fix
  commits on 24.13.0.

## (c) Validators run with `tsx --test`

- Command: `node node_modules/tsx/dist/cli.mjs --test test/pilot5-issue-<N>.test.ts`, run from the target worktree after `npm ci`.
- Reason: `tooling/run-tests.mjs` is absent at most starting commits; their own `npm test` script is `tsx --test`.
- Effect: the same command runs at every starting and fix commit and in the harness (`GATE-A-HARNESS.md`, Validation).

## (d) Memory cutoff rule applied literally

- Rule: a record is eligible if and only if its first-add commit time and its own capture timestamp both precede the
  issue's `createdAt`. Records captured in the same session that filed the issue are included; there is no
  filing-session exclusion.
- Effect:
  - #268: `fnd_a894c4e4ed` becomes eligible (first add 13:47:43Z, observed 13:47:41Z, issue 13:47:49Z).
  - #394: `fnd_e1e9d91cea`, `fnd_d98451bc6b` and `htask_8e3a87e6ade96968613dfbdf` stay eligible.

## (e) Hunch-arm memory is the whole cutoff-bounded snapshot

- The `current-hunch` arm mounts the snapshot the harness builds (`GATE-A-HARNESS.md`, Memory snapshot), not only a
  card's `eligible_record_ids`. Those ids label expected relevance and are checked for delivery after each run.
- Reason: a mount of hand-picked relevant records is a distractor-free graph that no user has.
- Effect: a card's own per-record snapshot hash is replaced by the hash the harness computes at freeze (`snapshot.json`).
- The public part of the snapshot follows the per-path rule (`GATE-A-HARNESS.md`, amended 2026-09-27, before any
  run): each `.hunch/` path in the starting commit's tree or the cutoff main commit's tree, at its last pre-cutoff
  commit reachable from the starting commit. A record that is eligible under (d) but sat only on a branch the
  starting commit cannot reach is absent. Checked against the frozen `snapshot.json` of the 2026-09-28 prepare:
  - #268: `fnd_a894c4e4ed` is absent. Its first add (9021f3b7) is on a branch that 0cdb20f4 does not reach, and the
    file is in neither candidate tree. The delivery check will report it as not delivered.
  - #394: `fnd_e1e9d91cea` and `fnd_d98451bc6b` are present. They are in the starting tree 43b9339b with a
    pre-cutoff commit reachable from it, although the cutoff main commit 1625abd8 lacks them.
  - Every other card's eligible ids are all present (public or private part). No `excluded_future_record_ids` entry
    is present in any snapshot.

## (f) #314 third validator test is stricter than the issue text

- The third test (comment-looking text inside JSON strings must still merge) is not in the issue text. A fix that
  refuses every file whose raw text contains `//` or `/*` would satisfy the issue's refusal alternative but fail it.
- Reason: `con_8460b6770f` governs this category's fix. It requires config writers to merge idempotently into
  existing user files and to refuse to clobber an unparseable file. A file with comment-looking text inside strings
  is parseable, so it must be merged.
- Effect: #314's validator requires comment-safe merging of parseable files, as the constraint does.

## (g) Workspace `.hunch/` is handled by the harness

- Both arms get the target repository rewritten without `.hunch/` in any commit. `current-hunch` mounts the cutoff
  snapshot; `no-hunch` has no memory. Every card's memory block says so.
- Reason: every starting tree except 0cdb20f4 (#268) contains records added after the issue's cutoff. Records added
  after the cutoff in the starting commit's history: 43b9339b 1, 7742a3b1 26, 3550f376 22, 0cdb20f4 0. The
  continuation card's starting commit was not checked here.
- Effect: neither arm sees post-cutoff memory through the workspace or its Git history.

## (h) Gate A version 2 stopped after two runs on Windows

- Version 2 (`GATE-A2-SPEC.md`) started on 2026-09-29 at 08:35 on the Windows machine, output
  `C:/bench-out/pilot5-gate-a2`, after its neutral preflight passed 10 of 10 on Claude Code 2.1.280. It was stopped
  during run 3.
  - Run 1, repeated-bug-360 `no-hunch`: success, 108.7 s.
  - Run 2, repeated-bug-360 `diet-hunch`: `isolation_breach`, a false positive. The agent ran `task verify` through
    node's full path held in a variable, as the Windows hook prints it (`GATE-A3-SPEC.md` F1).
  - Run 3, repeated-bug-360 `current-hunch`: killed mid-run with the controller process tree.
- Runs 1 and 2 also failed to write `repo-changes.patch` (`GATE-A3-SPEC.md` F2); run 3 never reached that step.
- Effect: no version 2 run counts. The output directory is kept as evidence, and no file in it contains the login
  token. Version 3 fixes both harness problems and reruns the whole schedule under a new seed.

## (i) Gate A version 3 first attempt void: maintainer sessions wrote to the private overlay

- The first version 3 attempt (output `C:/bench-out/pilot5-gate-a3`, preflight 10 of 10, manifest `d1e13aed…`)
  started at 09:29:46. Run 1, repeated-bug-360 `current-hunch`, ended `isolation_breach` with "HEAD or git status
  changed in `hunch-private`". The agent did not cause it. The maintainer's own Claude Code sessions in the `hunch`
  checkout committed Hunch task reports to the private overlay at every turn end (09:33:23, 09:40:01). Run 1
  otherwise passed (validator exit 0), and wrote `repo-changes.patch` (F2 confirmed). The controller was stopped
  during run 2.
- Fix, operational only (no harness or spec rule changes): for the rerun, `hunch private
  C:/bench-out/hunch-private-shadow/.hunch --no-hook` registers a clone of the overlay, with no remote, as the private
  store of the `hunch` checkout and its worktrees (git common dir plus the gitignored `.hunch/local.json`; editing
  `local.json` alone is ignored). Maintainer sessions write to the clone, and `hunch-private` stays still. After the
  run, the store is registered back to `../hunch-private/.hunch` and the clone's commits are pulled back.
- Effect: the rerun uses the same seed and a fresh output directory, `C:/bench-out/pilot5-gate-a3r`. The void
  attempt is kept as evidence and counts for nothing.

## (j) Gate A version 3 rerun stopped after one run: a drive letter read as a variable

- The version 3 rerun (output `C:/bench-out/pilot5-gate-a3r`, preflight 10 of 10, manifest `d1e13aed…`, the same as
  the void attempt) started at 10:10:33. The overlay redirect held: `hunch-private` did not change during the run.
- Run 1, repeated-bug-360 `current-hunch` (726.7 s), ended `isolation_breach`, a harness false positive. The agent
  held node's path in `H` and the audited entrypoint in `C`, and the drive letter `c:` in H's path counted as a
  mention of `C` (`GATE-A4-SPEC.md` F3). The validator was skipped, so the run has no outcome. The same shape would
  recur in both Hunch arms, so the controller was stopped at about 10:40, during run 2.
- A prepare-only call launched through the agent's POSIX shell first collided with a half-built base from its own
  torn-down earlier attempt (two preflight directories, a leftover `bases/*.src`). That output was deleted and the
  prepare-only rerun, and the timed launch, went through PowerShell.
- Correction to (i): the shadow clone is not pulled back wholesale. Its staged changes are CRLF churn from
  `hunch private` except for genuinely new record files, which are copied back one by one after the run.
- Effect: F3 changes a confinement rule after a timed run, so it starts version 4 (`GATE-A4-SPEC.md`) with a new
  seed and output directory. The rerun's output is kept as evidence and counts for nothing.

## (k) Gate A version 4: one run flagged by an unused variable assignment

- Run 8, continuation-375 rep 1 `current-hunch` (334.8 s), ended `isolation_breach`, a harness false positive. The agent's
  Bash call began `V="'C:/Program Files/nodejs/node.exe' '<audited entrypoint>'"`, an assignment it never used, then ran
  `task verify` through the POSIX node path and the audited entrypoint, the launcher the Windows hook prints. The
  confinement check read the entrypoint inside the nested quotes of the assignment as out-of-repo access.
- Replay through the harness's own `isOutOfRepoAccess`: the call with the assignment is flagged; the next call, the same
  invocation without it, is not. No read or write outside the run directory occurred.
- The shape depends on how an agent writes a command, not on the arm: rep 2 of the same task and arm, and the diet arm's
  rep 1, ran the same launcher without it and passed. So version 4 continued; changing the rule now would start version 5.
- Effect: the run has no outcome (validator skipped), as in (j). The `current-hunch` arm reports 10 outcomes of 11 (the harness added a tie-break repetition for convention-314).

## (l) Gate A version 5: one selection ranking rule changed after the offline replay

The version 5 task-scored selection was meant to be fixed before the offline replay. After critic fixes, the replay
scored 19% micro precision (12/63), just under the 20% bar set in advance. The only task that moved was
`convention-314`: once `src/integrations/providers.ts:35-46` was correctly read as a path, the hub file
`providers.ts` tied a dozen records, and rare words from the prompt's boilerplate broke the tie wrongly.

Change, approved by the maintainer on 2026-09-30: rank records by how many of the prompt's named files they are
anchored to (then term overlap, priority, id), instead of a yes/no path match. The final build scores 22% (14/65),
recall 34% (14/41). Because the rule was added after seeing the replay, the replay no longer validates it
independently; the live Gate A version 5 run is the test. All selection rules are frozen from this point. Details:
`hunch-private/docs/product/gate-a5/replay-2026-09-30.md`.

## (m) Gate A version 5 precondition 1 failed on the real (k) transcript: the fix missed its `cd` prefix

- Precondition 1 ran on the Windows machine on 2026-09-30 with harness `171aa037`
  (`confinement-replay-v5.json`, 11:35Z): 32 of 33 version 4 runs clear, but the (k) run was still flagged, so the
  verdict was FAIL.
- Cause: the (k) fix drops an unused assignment only when the rest of the command parses under a strict grammar in
  which every shell builtin fails. The real call opened with `cd "<run repo>"`; the synthetic shape the fix was tested
  on had no `cd`. The earlier "171aa037 clears (k)" check was on that synthetic shape only.
- Change, before any version 5 run: the grammar accepts one builtin statement, unquoted `cd` with exactly one literal
  absolute-path argument and no redirection. `cd -`, bare `cd`, relative arguments (zsh `cdablevars`, `CDPATH`), a
  second argument, a redirection and a quoted `cd` stay denied. Regression tests include the real call verbatim.
- Precondition 1 is rerun on the Windows machine with the new harness SHA; the spec's harness pin moves to it.
- Rerun on 2026-09-30 with harness `1b22cedb` (`confinement-replay-v5 (1).json`, 11:51Z): 33 of 33 runs clear, zero
  unexplained flags, the (k) run clear. Verdict PASS; precondition 1 is met.

## (n) Gate A version 5: `fable-mode` removed from the run repositories, not the user configuration

- The spec said `fable-mode` would be removed from both arms' configuration. It is not in the user configuration: the
  repository commits it at `.claude/skills/fable-mode` and `.agents/skills/fable-mode` at all five starting commits,
  and Claude Code 2.1.284 loads both (version 4 session start events list it). The harness had no way to remove it.
- Change, before any version 5 run: harness `d6ae3167` adds a repeatable `--exclude-path <path>` to
  `hunch task benchmark`. Excluded paths are removed from each run repository's tree and history when it is built;
  the base proof records them and proves the excluded history is empty. The manifest pins the list (a mismatch stops
  before any base is built). Before the agent starts, any `SKILL.md` whose directory or frontmatter name matches an
  excluded skill makes the run `invalid_exposure` and the agent is not spawned. After the run, the session's loaded
  skill list must be present and must not name an excluded skill. Reviewed by the critic: SHIP.
- Known limits, accepted: output directories made before this harness cannot be resumed (the command stops; version 5
  uses a fresh output); excluding a whole skills root (for example `.claude/skills`) is only checked as "a skill list
  was reported"; an unreadable `SKILL.md` passes the pre-start scan (the loaded-skills check still applies).

## (o) Gate A version 5 smoke run 1: two harness-side false stops; the smoke is void

- Smoke run 1 (2026-09-30, harness `d6ae3167`, seed `pilot5-gate-a-v5-smoke`, task `continuation-375`, one run per
  arm) ended `isolation_breach` in both arms. Neither was an escape by the agent. It does not count toward any result.
- (i) `current-hunch`: the agent stored the whole `task verify` launcher in a variable
  (`H='<node> <audited build>/dist/cli/index.js task verify <task> --'`) and ran checks as `eval "$H npx tsx --test ..."`.
  The confinement rule did not recognise the launcher behind `eval` and flagged it. Change, before any timed run:
  harness `2c189270` accepts an assignment whose whole value is the launcher and contains no `$` or backtick, treats
  `eval` as a command word, and blanks only the first mention of the variable. Critic: FIX FIRST (expansions inside
  the value would run through `eval`), fixed, then SHIP. Known limit, pre-existing and unchanged: `$_` is not tracked.
- (ii) `no-hunch`: the check "HEAD or `git status` changed in the source repository" fired because the maintainer's
  own session wrote Hunch task-report commits into the main checkout, which was the source repository, during the
  run. Change: the source repository is now a dedicated clean clone that no session works in (spec, Platform).
- Also observed and fine: `fable-mode` absent from both run repositories and not among the 18 loaded skills; the
  repository patch was written; the agent ran the task's covering tests through the launcher.
- A second smoke run, with harness `2c189270` and the clean clone, must pass before any timed run.
