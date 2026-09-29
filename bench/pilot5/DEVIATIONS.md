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
