# Task reports — release qualification

Recorded 2026-09-11 and updated after the 1.32.0 release. The implementation ships
in 1.32.0. Items not completed before publication remain listed under “Remaining
release acceptance”; the 2026-09-14 update closes the live-host and Codex terminal
checks while leaving the two repository-user sessions open.

## Update — 2026-09-14

A real Codex CLI 0.154.0 host session
(`01a09de5-c07f-7080-a72f-81d257fe9f2f`) completed the live-host
rule-supported-application acceptance. Hunch task
`htask_58bd481703d475f797408927` received constraint `con_91e6074b66` at
occurrence `hocc_847085485a40f7b943eaf63b`, applied the exact delivered
revision
`sha256:19e99f441e16b94eca99b2060a942ba91a9fb637e5a2f98d463555b2accf5cde`,
and finished with a rule-supported application. Verification passed against
that task's then-current source snapshot after checking 15 linked documents,
28 local links and anchors, four JSON examples, and the documentation-only diff
scope. The local evidence view is
`.hunch-cache/reports/htask_58bd481703d475f797408927.html`.

This run used a real Codex host and the explicit Hunch MCP task flow. Its
worktree did not contain native `.codex` hooks, so that run did not qualify
native prompt/Stop lifecycle behavior or visual terminal-card display.

A separate Codex CLI 0.154.0 run on main
`c069988258a13bbe118f61ad19db3c7e56642af6` completed the Codex-specific native
interactive acceptance in a VS Code integrated terminal. `/hooks` visibly
reported one installed and one active hook for each of `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStart`
and `Stop`. The ordinary prompt “Inspect README.md's npm installation command
and package.json's package name. Report whether they match. Do not edit files.”
did not mention Hunch. It created native task `htask_b471eca7ae1d96a30c589786`
with delivery occurrence `hocc_f0aa61f8c2bc820846b95ee3`; verification
`hev_8e5464e5f9ea57acaba57a14` passed against the current source. The saved
report hash was
`sha256:2456f2838ead4be2bfa8200a6b76c47ea0d50100be592417227823e97fe797d4`.
`integrations check --harness codex --probe --json` independently reported a
fresh Hunch 1.33.0 MCP and observed `UserPromptSubmit` at
`2026-09-14T03:24:03.119Z`.

The terminal visibly showed the normal completion card and a separate
`Hook · Hunch · Claude task` card carrying the local `file://` evidence URI.
VS Code's `Terminal: Open Detected Link...` action selected that URI, and its
integrated browser rendered the report's memory, delivery, command-check,
conformance and unknowns sections. This qualifies interactive card display,
link opening and native prompt/Stop presentation for Codex CLI 0.154.0 in the
VS Code integrated terminal only. Other terminal hosts are not qualified by
this run. The two repository-user acceptance sessions remain open.

## Update — 2026-09-12

1.32.0 was published on 2026-09-11 and 1.32.1 and 1.32.2 on 2026-09-12 through the release
workflow with required platform CI and the release gate on each tag, so items 1 and 4 under
"Remaining release acceptance" are done. The dogfooding hardening those releases carry
(`task verify --timeout`, a bounded MCP summary, hook runtime evidence, the `Hunch recalled:`
line, `drift --fail-on`) is described in [Task contribution reports](task-reports.md). Still
open: interactive-terminal display, the two repository-user acceptance sessions, a live task
showing a rule-supported application, and the MCP registry publish. The text below is the record
as written before publication and is kept unchanged.

## Current work after the qualified foundation

The clean candidate and archive below qualify the foundation only. Subsequent
lesson-history and rule-evaluation changes in the working tree are not covered
by that full gate.

Independently supported application (2026-09-11, after the archive below): the
report now carries Hunch's own deterministic evaluation of each delivered
lesson's declared rule against the task's changed files (`hunch task conform`,
run automatically on a completed finish through CLI, MCP and the engine API).
A constraint's forbids matcher is judged over the added lines of its scoped
changed files; a decision's conformance predicates over the current working
graph, only when a predicate subject is defined in a changed file. An
agent-reported application becomes `rule-supported` only while a satisfied
evaluation of the same record revision is bound to the current source; a later
edit drops the support, a tripped rule is shown as `Violated`, a scope-only
constraint stays `unavailable`, and a stored revision that differs from the
delivered one is never evaluated in its place. No MCP tool accepts a verdict.
Two focused regressions cover both rule kinds (satisfied → stale → violated →
revision changed; not-exercised → satisfied → violated), plus the CLI command.
The full suite on the preceding working tree ran 1,833 tests with 28 failures,
all in provider-launch and team-workflow files that pass in isolation: the
provider files refuse other launchers under a `CLAUDECODE=1` environment, and
the team files hit `spawnSync … ETIMEDOUT` under load in a 32-minute run. This
is a development observation, not a clean gate.
Exact record revisions can now be inspected across tasks through CLI, MCP, the
local SDK, and the private HTML report. Public export omits task history.

The legacy-ledger backfill originally held a write transaction while validating
64 large events: a separate task writer failed with `database is locked` after
124 ms. The backfill now caps each read at 64 events / 512 KB, validates outside
the writer transaction, and conditionally advances a derived cursor. The same
reproduction returned in 18 ms while the other process started a task in 4 ms;
a separate review observed 17 ms / 6 ms. Nineteen focused report/SDK tests passed.
Partial indexing withholds pagination cursors until the retained ledger is indexed.

## Candidate and verified scope

The shared `@davesheffer/hunch/reports` API, CLI, MCP tools, and built-in adapters
use one task ledger and report derivation. A harness controls lifecycle and
presentation without requiring the model to call reporting tools. No CCC,
Watchtower, Kimi, or other product-specific fork is required. External adapters
must enforce their own authorization and render the returned data.

The report distinguishes exact memory delivery, agent-reported application, and
observed local command results. A successful test is not causal proof that memory
helped. Missing delivery, failed checks, stale source, and unfinished tasks retain
their limited meaning. Local HTML and public-only export use the same evidence.

Clean code candidate: `c454739f06a53e9e75f1729e5c03c84160fa1905`, assembled in an
isolated local clone. Main-workspace implementation changes remain uncommitted;
subsequent qualification documentation is not part of that candidate commit.

Exact runtime archive (398 files; 3,931,478 unpacked bytes):
`sha512-LnbYrmRr0RUrY18TR1KxheIkwB4Qzw6hpUAQ/KLKVDap4xQ/HQtB5E0rbH6fQzrUHFarOjCdLU1Z242IJ2S5vA==`.
A separate strict TypeScript consumer installed this tarball and ran the actual
start → local check → finish → reopen → HTML path. Declaration closure and runtime
imports passed. This same-version unreleased archive is not a published upgrade.

## Live host qualification

Prompts requested ordinary repository work, without mentioning Hunch or asking for
a report. Runs used subscription-authenticated CLIs with API keys removed and
normal automatic approval review. Fixtures used generated grounding and explicit
launchers selecting the installed unreleased archive: normal published setup pins
a registry version. No raw model transcripts are committed.

| Path | Attempts and observed result | Capability boundary |
| --- | --- | --- |
| Claude Code 2.1.268 | Ten attempts: eight ordinary completed tasks returned cards/links plus native Stop informational messages; one deliberate interruption remained open without a completion card; one strict no-files-anywhere request still produced local writes. | Native prompt identity plus MCP. Strict filesystem read-only operation is unsupported. Headless display verified; interactive clicking is not certified. |
| Codex CLI 0.153.4 | Ten attempts: eight ordinary completed tasks returned cards/links; one strict no-file-modification request explicitly skipped reporting; one deliberate interruption remained open without a completion card. | Managed MCP instructions. No native lifecycle hook is claimed. Skipping forbidden bookkeeping is recorded separately from ordinary-use success. |
| Generic local harness | Deterministic lifecycle fixture and separate packed TypeScript consumer passed without any model/provider SDK. Retries reuse one identity; new attempts are separate; failed checks and interruption retain their states. | Local engine contract. Does not certify arbitrary remote transport or host UI. |

Claude's cases cover relevant memory, empty memory, source inspection, failed
checks, restart, and restart after interruption. Interrupted task
`htask_9c32da8dcc8a6dee9f1276b9` stayed open after a fresh task
`htask_753e56282cfc325fcea9fd32` completed in the same repository.
Codex reconnect tasks `htask_ed5771065a520ee90cbc3a97` and
`htask_7378f920963b747fbd633247` stayed distinct. Its interrupted task
`htask_3fdcb7d9c8cbc62c7249e57b` had no finish time, completed card, or report HTML.

These twenty attempts used the preceding archive. The only subsequent runtime
change recalibrated the existing retrieval prior as described below. An additional
ordinary relevant Codex task on the exact archive above passed: task
`htask_2badeff5ee8b0deecdd5cd13`, retained delivery, one agent-reported application,
exit-0 check matching current source, and final card/link. Final-archive Claude task
`htask_056501c1af61cfd737a98eb9` also passed: the preservation lesson was delivered,
two meaningful regression tests were added, an exit-0 check matched current
source, and both the final card/link and native Stop informational message appeared.
The host runs validate behavior on the exact archive; they do not certify every
possible task or interactive renderer.

Presentation opt-out hides cards; it does not disable observations or other Hunch
cache writes. Source-read-only tasks can retain reports without changing source
or tests. A natural-language prohibition on all filesystem writes cannot disable
already-configured native hooks. No heuristic parsing of prompts is used as a
permission mechanism.

## Reproduced defects and dispositions

- Claude 2.1.186 could finish a README task without calling Hunch at all. The
  regression failed before native task creation (`host must start reporting
  before the model can skip its instructions`). Supported Claude prompt hooks now
  create an exact task before reminder deduplication; Stop emits only a nonblocking
  `systemMessage`. A live 2.1.268 probe observed stable prompt identity across a
  Stop continuation. Older hosts receive an unassociated coverage notice.
- Claude preferred MCP structured results and originally missed text-only
  references. Exact application references and the card are now included in
  structured results. Invented occurrence/hash references were correctly refused.
- Terminating the verification CLI originally left its child command alive.
  The subprocess regression now observes cancellation of the owned process group
  and a retained cancelled result. Hard kills remain unobservable; missing results
  cannot become successful checks.
- Saved HTML originally implied live source freshness after an edit. It now gives
  its generation time, describes the source match at that time, and supplies a
  regeneration command. Fresh CLI/MCP reads recompute currentness.
- Native pre-edit delivery originally lacked task evidence. Exact full injections
  now bind to the prompt task; repeated delta notices do not fabricate another full
  delivery. A new prompt receives its own first full injection.
- Abandoned open reports originally escaped retention. Open reports now expire
  after 90 days from creation, closed reports after 90 days from finish, with a
  bounded serialized prune. Expiry never invents completion.
- The first clean gate rejected new declaration files through release allowlists.
  Both allowlists now accept the packaged declaration closure; negative tests
  still reject maps, private paths, credentials, and traversal.
- Indexing the new helpers diluted a previously reachable orientation decision.
  With the same memory corpus, baseline Recall@10 was 9/11 (MRR .528); candidate
  was 8/11 (.470). The existing memory prior changed from 12 to 16 positions.
  A 16→20 sibling-function regression failed at 12 and passed at 16, including
  maximal recency decay. The golden floor remains 9/11 and .45, with unchanged
  expected records. Thirty-eight ranking/delivery tests passed; six real exact
  symbol searches retained identical top tens. This repairs measured dilution,
  not arbitrary future corpus growth. Report outcomes never promote authority.

## Automated release checks

The exact archive passed an actual npm replacement from published 1.31.1 to the
candidate and back. Two repairs were byte-idempotent across MCP settings,
permissions, and grounding; user prose and public/private record bytes were
unchanged. Task `htask_6fe7eb644ded70e2ffaa613b` retained its delivery, check, and
report across reindex/restart. The rolled-back runtime read both memory homes,
read and appended historical served rows, and reindexed; the candidate then
reopened identical report JSON. The same-version registry-pin limitation above
still applies. Archive SHA256:
`d2cadb1cceb37d7bdb3035bcaa468a4a4696a509d93d4bbe6df03c672dcbad22`.

A live Claude presentation-off task retained delivery/application/check evidence
but emitted neither a final card nor a native Stop card/informational message.
This qualifies the presentation control, not a no-write mode.

Focused verification includes exact/repeated occurrences, cross-task/worktree
refusal, forged references, empty versus missing delivery, failing and stale
checks, source-mutating checks, cancellation, pending completion refusal, hash
corruption, safe HTML paths, escaping, public-export sentinels, expiry, opt-out,
and preservation of custom settings and instructions during repair.

The preceding clean candidate ran 1,822 tests: **1,814 passed, 6 skipped, 2 failed**.
Those were the retrieval-floor and declaration-allowlist defects above; both have
passing targeted regressions. Receipt `release_b73adc597039` remains a failed
superseded candidate, not release evidence for the final code.

The earlier dirty development gate ran 1,810 passing tests and six skips, then
correctly refused index publication with `refusing to persist a derived graph
from dirty indexed code`. The clean-source guard was preserved.

The next clean run caught stale generated grounding: the older running MCP
capture had regenerated the public instructions without the new report section.
The candidate CLI regenerated all five files from public memory, and six grounding
checks passed. Packing the repaired clean checkout produces the identical archive
hash above; no runtime behavior changed. The prior run finished with 1,817 passing tests, six skips, and only that grounding
failure (receipt `release_f433649e656c`); it remains historical.

The full gate on repaired candidate `c454739f06a53e9e75f1729e5c03c84160fa1905`
**passed**: receipt `release_e3fa22ced29e`, 1,818 passing tests, six skips, zero
failures. All eleven stages passed: typecheck, tests, core build, packaged matrix,
VS Code installation/build, repository index, architectural conformance, memory
drift, clean installation, and production dependency audit (zero unreviewed
vulnerabilities). Source stayed clean and at the same commit throughout.

The eight-client/four-round matrix preserved all 32 distinct writes and converged
its eight simultaneous collision writers to one record. Compatibility took
41,287 ms, crash recovery 27,534 ms, and the 40-write soak 257,635 ms; all remained
inside the unchanged gate limits. The matrix and clean-install rehearsal both
identify the same exact archive qualified in live hosts. Memory drift reported
three historical unresolvable commit references as nonblocking findings; no
provenance was rewritten to obtain a pass.

The gate says **candidate ready: yes; publish ready: no**. It is an untagged local
candidate, still versioned 1.31.1. This macOS result does not substitute for
platform CI, the remaining product scope, user acceptance, or publication
authorization.

## Presentation observations

A real Codex report was opened in Chrome through native UI controls. Desktop dark
mode and a 390-by-844 CSS-pixel viewport in light/dark modes were inspected.
Tab/Return opened delivery and verification disclosures with visible focus.
A fresh reload produced no console errors, and the saved-snapshot wording was
verified. This is a visual spot check, not a complete accessibility audit.

An earlier attempted rendered-terminal check was blocked by the UI tool:
`Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.`
No alternate automation route bypassed that restriction, and no onboarding,
theme, or global preferences changed. Raw PTY output is not counted as visual
verification. That attempt did not verify interactive terminal cards, links or
Stop notices.

The 2026-09-14 Codex CLI 0.154.0 rehearsal above used the VS Code integrated
terminal and visibly exercised the native prompt/Stop path. The normal completion
card and native Stop card rendered, VS Code detected the report's `file://` URI,
and its integrated browser opened and rendered the local evidence report. This
qualifies that Codex/version/terminal combination only; it does not qualify other
terminal hosts or establish the two-user usability result.

## Performance

Apple M1, Darwin 24.3.0, arm64, Node 22.23.1. Thirty measured warm samples per
operation, nearest-rank p95. Valid historical event rows were bulk-seeded in a
disposable Git repository; measured operations used the production service.

| Fixture | Event JSON bytes | Delivery p95 | Report-read p95 |
| --- | ---: | ---: | ---: |
| 60 one-lesson deliveries | 70,560 | 1.018 ms | 6.381 ms |
| 10,000 empty deliveries | 6,370,000 | 4.950 ms | 561.515 ms |
| 6,802 one-lesson deliveries | 7,999,152 | 5.000 ms | 671.413 ms |
| 636 large-lesson deliveries | 7,991,340 | 2.858 ms | 166.313 ms |
| 10,000 mixed claims/deliveries | 1,989,271 | 3.839 ms | 272.304 ms |

All boundary fixtures rejected the next append. The 8 MB byte limit can be
reached before the 10,000-event limit. Warm reads exclude source snapshot
computation and HTML rendering. Three fresh-process source-CLI samples measured
task-start maximum 1,240.484 ms and 10,000-event JSON report maximum 1,530.923 ms.
These cold samples include the normal source snapshot and serialization, but
exclude package download and host latency. They are not a p95 cold-start claim.

## Remaining release acceptance

1. **Completed for 1.33.0:** the tagged release ran the required clean, contract,
   package, platform and publication checks. The release record remains the source
   for those results; the prior foundation gate was not reused as evidence.
2. **Codex interactive display/link opening completed 2026-09-14; two user
   sessions remain:** Codex CLI 0.154.0 in the VS Code integrated terminal
   visibly rendered the normal and native Stop cards, opened the detected local
   report URI, and rendered its evidence sections. This result is specific to
   that host/version/terminal combination. The two repository-user acceptance
   sessions defined in the plan have not been observed; no human usability
   success is inferred from this rehearsal, synthetic fixtures or headless model
   output. The [external acceptance operator runbook](external-acceptance-runbook.md)
   fixes the questions, timer, evidence packet and no-substitution rule for those
   sessions.
3. **Completed 2026-09-14:** a real Codex CLI 0.154.0 task exercised a
   rule-supported application of the exact delivered `con_91e6074b66` revision,
   with a passing verification bound to that task's source snapshot. This closes
   only the live-host rule-supported-application item; the run used explicit Hunch
   MCP task calls and did not qualify native `.codex` hooks or visual terminal
   presentation. Saved/committed/pushed observations, native gate-refusal linkage,
   lesson history, and rule-based application support remain implemented within
   their documented evidence boundaries.
4. **Completed for 1.33.0:** the release candidate was reconciled, versioned,
   published to npm and registered in the official MCP Registry. The two observed
   repository-user sessions remain an acceptance gate after publication; release
   publication does not stand in for their usability evidence.

Local sanitized host results, the archive manifest, and an actual report example
are retained under `.hunch-cache/release/task-report/` (ignored by Git). The source
plan is [Next release: see what Hunch contributed](next-release-memory-impact.md);
usage and integration boundaries are in [Task contribution reports](task-reports.md).
