# PILOT5 Gate A, version 4: drive letters in confinement

Status: decided on 2026-09-29 by the agent under the maintainer's standing delegation, before any version 4 run. The
maintainer may veto it before any result is read. After the first timed run, any change to a rule here starts
version 5.

Version 4 is `GATE-A3-SPEC.md` unchanged except for fix F3 below. Same arms, hook diet, neutral user configuration,
criteria, five frozen tasks, two repetitions, model, timeout and validators; F1 and F2 stand. The version 3 rerun
stopped after one run (`DEVIATIONS.md` (j)); none of its runs count.

- Seed: `pilot5-gate-a-v4`.
- Output: `C:/bench-out/pilot5-gate-a4`, outside the user profile.
- Claude Code: 2.1.284. The neutral preflight runs again before the schedule.
- Harness: `feat/task-benchmark` at `7e08c13`.
- Private overlay: the maintainer checkout's store stays registered to the shadow clone for the whole run
  (`DEVIATIONS.md` (i)).

## F3. Confinement: a drive letter is not a mention of a variable

In the version 3 rerun, run 1 (repeated-bug-360, `current-hunch`) ran `H='C:\Program Files\nodejs\node.exe';
C='<audited>\dist\cli\index.js'; "$H" "$C" task verify …`. The text is lowercased before matching, so the drive
letter `c:` in H's path read as a second mention of the variable `C`. Under F1's rule, `C` then was not "only
invoked", the audited entrypoint stayed denied, and the run was marked `isolation_breach` with its validator skipped.

Added to F1's rule and to the version 2 variable-invocation rule, for counting a variable's mentions only:

- A drive letter is not a mention: a letter followed by `:/` (backslashes read as `/`), and an MSYS drive `/x/` at the
  start of a path. A letter behind `$`, `{`, `%` or `!` (`$C:/x`, `${C:-x}`, cmd's `%C:/=\%`, `!C:…`) is still a
  reference. The deny-root scan itself is unchanged: a deny root anywhere in the text still matches.

Known gaps, both minor: a quote-split `'$'C:/x` is no longer counted as a mention (the path it builds, `<entrypoint>:/x`,
is not a real file); and a drive letter at the very end of the text (`ls e:/`) still counts as a mention of `E` (a
false positive this version accepts).

The rerun's run 1 transcript, replayed through the fixed check, has no offender (before: 2 strings). All 28 existing
Gate A transcripts (versions 1 to 3) were swept: one flags, a version 1 run that read the real `~/.claude` before
per-run configuration existed. A fresh-context adversarial review returned SHIP-WITH-FIXES: cmd `%E:/=\%`
substitution was masked (a loosening), and no test covered the node-variable path. Both were fixed with tests before
commit; a mutation of the first fix fails its test.
