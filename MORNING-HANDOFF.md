# Morning handoff — Hunch 1.40.1

Prepared 2026-09-22. Status below is a snapshot; refresh it at session start.

## Goal

Prepare Hunch v1.40.1 as a focused bug-fix release. Investigate, implement,
test, and prepare PRs; present one consolidated merge/release brief.
Do not merge, tag, or publish without the user's approval.

## State

Planning and issue triage completed; no release implementation started.
Last checked: npm and GitHub main both at 1.40.0. GitHub's Latest release
notes lagged at v1.33.0. Refresh remote state before relying on these observations.

Use the Hunch repository on the work machine. Read its AGENTS.md and applicable
skills, consult Hunch memory, and inspect local changes first. Do not assume
the previous machine's checkout path or installed assistant setup exists here.

## Open PRs — last observed, not current guarantees

| PR | Change | Last observed CI | Proposed treatment |
|---|---|---|---|
| [#386](https://github.com/davesheffer/hunch/pull/386) | Use in-tree build for doc-regenerating hooks | 12 passed; merge clean | Review for patch |
| [#387](https://github.com/davesheffer/hunch/pull/387) | Add retire-constraint command | 12 passed; merge clean | Defer to 1.41.0 for a strict patch |
| [#388](https://github.com/davesheffer/hunch/pull/388) | Guard against misrouted auto-committing writes | 10 passed, 2 failed; blocked | Investigate failures, then review |
| [#389](https://github.com/davesheffer/hunch/pull/389) | Show complete contribution card | 13 passed; merge clean | Review for patch |

No review decisions were reported by the status helper. The two failures on
#388 were not investigated.

## Proposed additional issues

These were triaged from issue reports, **not reproduced on current main**.

Recommended:

- #362: A subscription cursor above head_seq must trigger resync. Focused
  validation fix and regression test.
- #375: Repeated pre-edit calls resend a full grounding block because their
  own delivery changes task ranking. Preserve real-change detection.
- #378: Tests can invoke the developer's real assistant subscription due to
  inherited host environment signals. Isolate test environments; do not silently
  change product provider precedence.
- #377: macOS fixture paths differ between /var and /private/var. Prefer shared
  fixture normalization; inspect product exposure too.

Investigate early:

- #380: If every file of a language fails parsing, indexing may replace a
  healthy graph with empty results. Reproduce first. If confirmed, prioritize
  preserving existing data and get an independent critic.

Optional only if bounded:

- #367: Bare ampersands in valid JSX fail parsing. Reproduce using today's
  bundled grammar; the original reproduction used 1.18.1.
- #384: Temp git fixture teardown intermittently fails with ENOTEMPTY. Identify
  the race; avoid an unreviewed 150-file cleanup.

Issue URLs use https://github.com/davesheffer/hunch/issues/NUMBER.

## Backlog hygiene

Open issues may already have shipped fixes:

- #298: merged #329 (CRLF doc anchors); also inspect #358's list-fence fix.
- #316: merged #356 (shared worktree hooks).
- #287 and #293: merged #351 (stale-lock takeover/process identity).
- #370: partially addressed by #374 (conditional task bookkeeping).

Verify acceptance criteria before closing anything.

## Decisions and constraints

- Proposed release: #386/#389, #388 once fixed, plus selected issues above.
- Final scope is not approved or frozen; prefer a small, verified patch.
- Defer new commands, broad parser redesigns, ledger merge changes, and broad
  context-budget redesigns.
- Follow existing orchestrator roles and enforced permission boundaries.
- Use fresh critic review for risky data, concurrency, and config changes.
- Never broaden agent permissions to bypass a failure.
- Preserve unrelated work and private Hunch memory.
- Keep tests from reaching real assistant CLIs.
- No blanket reruns or weakened assertions to make CI green.

## Release process observed

package.json provides `npm run gate:release` and `npm run sync-version-pins`.
The npm version lifecycle synchronizes `plugin/.mcp.json`, `server.json`, and
`.windsurf/hooks.json`. Inspect current scripts before preparing the bump.

`.github/workflows/release.yml` publishes on v* tag pushes. It builds, runs the
tagged release gate, packs an attested candidate, and uses the trusted npm
publishing workflow. Tagging is a publication action requiring approval.

## Plan

1. Refresh PR/CI status using the configured pr-status helper.
2. Inspect #388's actual failing checks.
3. Reproduce #380 and selected patch candidates on current main.
4. Implement bounded fixes in isolated branches/worktrees, test each, and
   obtain critic reviews where required.
5. Present ONE brief: PR | what it fixes | CI | critic verdict | merge order |
   decisions needed.
6. After approved integration, prepare the 1.40.1 release PR: version/lockfile/
   pins, release notes, full release gate and packaging.
7. After explicit release approval, tag the exact verified commit, monitor
   publication, verify npm/provenance and disposable installation, and publish
   matching GitHub release notes.

## Verified versus unverified

Verified: issue descriptions and recent merged PR titles were retrieved; the
version and workflow details above were inspected.

Unverified: current CI, issue reproducibility, dependencies/merge order,
release readiness, and all proposed fixes. No release changes were made,
merged, tagged, or published in this work.

## Files and unrelated local changes

This handoff is `MORNING-HANDOFF.md` at the repository root.
Before saving it, the previous checkout already had modifications to
`.cursor/rules/hunch.mdc`, `.github/copilot-instructions.md`, `.gitignore`,
`.windsurf/rules/hunch.md`, `AGENTS.md`, and `CLAUDE.md`, plus untracked
`.claude/worktrees/`. They were not part of release implementation. Inspect
ownership and current state; do not discard or include them blindly.

## Separate completed work

The orchestration bundle was renamed and published:
https://github.com/davesheffer/coding-orchestrator

Private repository, main commit acf910d. Includes Codex native roles, installer,
and documentation; 13 tests passed. Builder temporary-directory exclusions
were fixed and reviewed. The previous machine's installed builder role was
also patched. This does not establish that the work machine has the update.

## Next step

Refresh Hunch PR statuses and inspect #388's failing checks, then begin
reproduction of #380 before deciding the final patch scope.

## Next prompt

Latest user instruction: "SAVE INTO THRE HUMCH REPO"

Preceding handoff request: "MAKE A HAND OFFF FOR MORNING SESSION AT WORK"
