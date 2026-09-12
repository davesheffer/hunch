# Task contribution reports

Shipped in 1.32.0. Live-host results and the acceptance items still open are
recorded in the [qualification record](task-report-qualification.md); this
document is not a claim that every host has passed its live acceptance tests.

Hunch can retain the lessons returned during a task, the agent's stated application
of those lessons, and command results observed by its local verification wrapper.
The result is available as a short completion card and a self-contained HTML view.

## Normal agent workflow

The generated Hunch instructions ask the agent to:

1. Start one task with `hunch_task(action: "start", title: "Short task title")`.
2. Carry the returned `task_id` into each `hunch_context` call and each decision,
   correction, or finding capture.
3. Run a relevant verification using the exact `verification_argv` launcher from
   task start, followed by the command and arguments. This avoids stale global CLIs.
4. Before attributing an application, read `hunch_report(task_id)` and copy its
   exact `application_references`, adding the action actually taken.
5. Finish with `hunch_task(action: "finish", task_id, applications?)` and include
   the structured `contribution_card`, including its evidence link, in the final
   response unless presentation is disabled.

This lifecycle is instruction-driven. Configuration does not prove the host
followed it. A host must load the current MCP server and allow the tool calls;
missing task identity or denied tools cannot produce a verified contribution.
Hunch does not guess a task ID from a transport session or recent activity.

`hunch init` writes the instructions. `hunch update` invokes the freshly installed
CLI's `integrations repair-pins`, which now also refreshes existing Hunch
grounding documents. Other user prose and unrelated integration settings remain
preserved. Restart/reconnect the host after updating.

## Terminal access

```sh
hunch task start "Update configuration handling"
# Use the returned htask_… identity in subsequent commands.
hunch context src/config.ts --task htask_…
hunch task verify htask_… -- node --test test/config.test.js
hunch task finish htask_…
hunch report
hunch report htask_… --json
hunch report htask_… --html
```

The HTML command writes a file under `.hunch-cache/reports/` and prints its path.
Open that file in a browser. It has no scripts, remote assets or hosted-account
dependency. The local report may contain private project memory.
It is a saved snapshot with a generation timestamp, not a live source check.
Regenerate it after editing files; CLI/MCP reads recompute source currentness.

The verification wrapper executes the explicitly supplied argument vector with
no shell expansion, records its exit result and separate output-stream digests,
and retains no raw stdout/stderr. Output streams remain visible while the command
runs; `task verify --json <task_id> -- <command>` suppresses live output and emits
only the result JSON. Commands with shell syntax must use an explicit
shell, just as they would outside Hunch. A nonzero/unknown exit or timeout makes
the wrapper exit unsuccessfully. The default timeout is two minutes. SIGINT and
SIGTERM cancel the command tree and retain a cancelled result before exit. An OS
hard kill cannot run cleanup; a missing result remains pending/unverified, never
a successful check. Independently detached descendants cannot be guaranteed to
remain in the command's process group.

Checks bind bounded source snapshots before and after execution. Git-ignored
files, Hunch memory/cache and external dependencies are excluded. Changed files,
unavailable snapshots and source-mutating checks cannot be presented as a
current stable-source verification. This is not a native committed-change proof;
use `hunch prove` for that artifact.

## Reading the evidence

| Display | Meaning |
| --- | --- |
| Recalled | Hunch retained a task-linked delivery and a snapshot of the referenced lesson. The HTML view also shows the exact context text returned. |
| Applied · agent-reported | The agent linked an action to an exact delivered occurrence, record ID and record hash. This is attribution from the agent, not an independent causal proof. |
| Applied · rule-supported | The same agent attribution, plus Hunch's own evaluation of that lesson's declared rule (a constraint's forbids matcher, or a decision's conformance predicate) held on the files this task changed, and the evaluated source is still the current source. The attribution stays the agent's; the support is Hunch's. |
| Conformed · rule held | No agent attribution, but a delivered lesson's declared rule held on the changed files in its scope. This shows the change conforms to the lesson; it does not show the agent read it. |
| Violated · rule broken | The changed files trip a delivered lesson's declared rule. This is negative evidence and is always shown. |
| Saved · local/committed/pushed | A successful capture wrote this exact revision to its actual memory home. Commit/push labels require its matching JSON content at an immutable Git revision. A later overwrite or unavailable proof leaves the observation local. |
| Guarded · Denial emitted | The native edit gate emitted a denial in this exact task. Host compliance and bugs prevented remain unverified. |
| Checked · passed/failed | The local wrapper observed the named command's result. A passing command does not prove Hunch caused the outcome. |
| Current source snapshot | The current bounded source hash equals both hashes recorded around the check. |
| Contribution unverified | Delivery is known; supported attribution is missing. |
| No task-linked delivery observed | Instrumentation is incomplete. This does not prove the agent was disconnected or never consulted memory. |

### Rule evaluation

```sh
hunch task conform htask_…
```

Finishing a task (CLI, MCP `hunch_task`, or the engine API) runs this
evaluation automatically before closing; the command re-runs it after further
edits. For every constraint or decision revision delivered in the task, Hunch
evaluates the record's own declared rule against the working tree's changes
versus `HEAD`:

- a constraint with a `forbids` matcher (dependencies, symbols, patterns) is
  judged over the added lines of its scoped changed files;
- a decision with `conformance` predicates is judged over the current working
  source graph, and only when a predicate's subject is defined in a changed file.

Outcomes are `satisfied`, `violated`, `not-exercised` (no changed file in the
rule's scope) or `unavailable` (no machine-checkable rule, a stored revision that
differs from the delivered one, an incomplete scan, or a diff over the analysis
budget). File overlap alone never produces `satisfied`. The agent neither
selects the rule nor submits the verdict; no MCP tool accepts one. Each result is
bound to a bounded source snapshot, and a later edit invalidates its support until
re-evaluated. A held rule supports an application; it is not proof the agent read
the lesson, and a passing rule on a scope-only constraint is impossible by design.

Native `hdr_…` receipts identify context content. `hocc_…` identities distinguish
separate occurrences, including identical content returned in different tasks.
The task report schema is `hunch.task-report/1`. Historical served rows remain
readable through `hunch served`; missing task/record hashes are not invented.
Historical `hunch.usefulness-observation/1` data keeps its original contract.
Task reports do not change retrieval ranking or grant memory/policy authority.

## Follow a lesson across tasks

```sh
hunch report --lesson con_example --kind constraints
hunch report --lesson con_example --kind constraints --revision sha256:…
```

The MCP equivalent is `hunch_report(lesson: {kind, record_id, content_hash?})`;
the local SDK provides `reporter.lesson(reference, {limit?, before?})`.
The lookup joins exact retained save and delivery events, including different
revisions of a record. It never joins by title or timestamp. `index_complete:
false` means an older ledger is still being indexed in bounded batches; refresh
before using `next_before`. Expired/forgotten observations are absent.

The local HTML view shows up to three lesson revisions and eight appearances
per revision, with explicit truncation notices. Repeated delivery is not repeated
impact. Cross-task titles, private saves, and denial details stay out of public
exports.

Decision/correction/finding MCP captures observe the successful write before
flushing. A skipped flush is not a failed local save. Public memory is committed
without automatically pushing the code repository. Private/shared pushes retain
proof only when the exact captured revision appears at an observed immutable
published commit. The proof distinguishes Git push status from a subsequent
exact remote-ref confirmation. Neither claims the current remote still holds it.
Reporting failure never reverses a save, changes capture authority, or suppresses
an emitted edit denial. Other write paths without explicit task identity remain
unassociated; background sync is never assigned to the most recent task.

## Sharing a report

```sh
hunch report htask_… --public-only --json
hunch report htask_… --public-only --html
```

These produce `hunch.public-task-report/1`, a separate projection. Only record
revisions that still match records in the public JSON store are included. Text
is reconstructed from those public records; task prose, private context payloads,
command details/results, rule evaluations and application descriptions are omitted. Receipt hashes
remain references to local evidence, not published copies of the original
payloads. A changed or missing public record cannot authorize an older snapshot.

## Local controls and limits

```sh
hunch task presentation off
hunch task presentation on
hunch task finish htask_… --interrupted
hunch task forget htask_…
hunch task prune --days 90
```

Presentation controls only automatic cards; memory and manual report access remain
available. The setting is merged atomically into `.hunch/local.json`; malformed
configuration is refused rather than overwritten.

Presentation off is not a filesystem read-only mode: task observations and other
Hunch caches can still be written. A natural-language request to modify no files
cannot disable already-configured native hooks. Strict no-write environments must
prevent those writes at their host boundary; automatic persistent reporting is
not supported in that mode. Ordinary source-read-only tasks can retain reports
without changing source files or tests.

Task observations use the separate machine-local `.hunch-cache/served.db`, so
reindexing does not erase history. Each task is bounded to 10,000 events and 8 MB
of event JSON; each event is bounded to 256 KB. Space is reserved for in-flight
verification results. A task cannot finish successfully while a check is pending;
after an interrupted runner, explicitly close it as interrupted.

Starting a task prunes up to 1,000 reports closed more than 90 days ago, or still open 90 days after creation. The manual
prune command permits a different retention window. Deletion removes local
observations and generated report files, never durable project lessons. Recent open
tasks remain available until explicitly closed or their retention period expires. Symlinked/hard-linked report paths
are refused so reports do not cross repository/worktree boundaries.

## Integration boundary

CLI and MCP use the same local report service. CCC or another orchestrator can
consume the JSON report through a local CLI bridge or MCP, supplying explicit
task IDs and exact application references. This implementation does not add a
new HTTP route or grant an external principal access to local reports. A served
deployment must retain its existing scope/authentication boundary when adapting
the report contract.

Clients that prefer MCP `structuredContent` receive copyable application
references from `hunch_report` and the completion card from `hunch_task`.
Both return `hunch.task-report-summary/1`: exact identities, verdicts, counts
and the card, bounded to the host's round-trip (envelope text and lesson prose
are omitted; `omitted` counts what fell off). The full `hunch.task-report/1`
document is `hunch report <id> --json` or the HTML view. Native
context envelopes remain unchanged; task occurrence IDs and record hashes must
not be derived from the envelope receipt ID or task scope hash. The card and
references are presentation metadata alongside the report, outside its content hash.

## Native Claude lifecycle coverage

Claude Code 2.1.196+ supplies an authoritative prompt identifier. Existing Hunch prompt hooks create an exact report from physical worktree, provider, session, prompt and optional agent identity; raw prompt text and host identifiers are not retained. Every prompt receives its ID even when ambient reminders are deduplicated. The model reuses it through MCP. The Stop hook emits a nonblocking `systemMessage`, including missing coverage when no linked retrieval occurred. It never adds a Stop block or another model turn. An existing verification gate still takes precedence.

Stop does not close an unfinished report: another hook may continue the turn, and Stop is not an independent assertion that all user work finished. Explicit finish/interruption records remain authoritative. Older Claude versions receive an unassociated coverage notice, never a report selected by time or recent task. Presentation opt-out silences both notices and cards; firmness off retains its existing disabled-hook semantics.

Live Claude 2.1.268 headless qualification observed exact prompt continuity through a Stop continuation, informational-message delivery, and the previously failing README task now returning an empty-memory card with a clickable Markdown evidence link. Interactive display and CCC/Watchtower adapters require their own qualification.

## Provider-neutral engine API

Import `createTaskReporter` from `@davesheffer/hunch/reports` in a Node harness
running beside the authorized worktree. Kimi, Codex, Claude, or another agent can
execute the task; the report API has no provider-specific branches.

```js
import { createTaskReporter } from '@davesheffer/hunch/reports';

const reports = createTaskReporter(authorizedWorktree);
const task = reports.start('Preserve configuration settings', {
  task: controllerTaskId,
  attempt: controllerAttemptId,
});

// Pass task.task_id to hunch_context over MCP. If your harness already issues
// native context itself, retain that exact envelope and its record snapshots:
// const occurrence = reports.delivered(task.task_id, envelope, snapshots);
// Only return/insert the context you actually issued; a delivery is not use.

let outcome = 'completed';
try {
  await runAgent({ taskId: task.task_id }); // supplied by your harness
  // Wrap the relevant check once; this observes its actual local result.
  await reports.verify(task.task_id, ['npm', 'test'], 'Configuration tests');
} catch (error) {
  outcome = 'interrupted';
  throw error;
} finally {
  try {
    const finished = reports.finish(task.task_id, outcome);
    if (finished.contribution_card !== null) {
      const evidencePath = reports.html(task.task_id);
      showContribution(finished.contribution_card, evidencePath); // host UI
    }
  } catch (reportError) {
    showReportUnavailable(task.task_id, reportError); // does not retry the work
  }
}
```

`runAgent`, `showContribution`, and `showReportUnavailable` are integration callbacks, not Hunch APIs. Keep
presentation failures separate from work failures in your production controller;
an unavailable report must not retry completed work. `verify` returns the actual
exit result, including nonzero results; it does not throw just because a check
failed. Use the result to implement your controller's existing completion policy.

The stable caller identity contains both task and execution attempt. Repeating
it retries the same report; a fresh attempt gets a separate report. Hunch hashes
these identifiers with the physical worktree and does not retain the original
strings. Do not derive identities from timestamps or the most recent task.
`applied` accepts exact delivered references and always labels them agent-reported.
`conform(taskId)` runs Hunch's rule evaluation of the delivered lessons against
the changed files; `finish` runs it automatically for a completed outcome and
discloses an evaluation failure through the report's unknowns instead of failing
the finish. `report` rechecks current source, `history` lists up to 30 recent
tasks, and `html(id, true)` derives a public-only export.

This is a local engine API, not an HTTP endpoint or an access-control system.
An external service must authorize its principal and partition before selecting
an engine/worktree; a task ID is not a bearer token. Remote execution results are
not accepted as locally verified checks. Existing CLI/MCP integrations expose the
same report engine without requiring an embedded Node client. The report cannot
force an arbitrary host to display it: the controller renders the returned card,
including missing-coverage states, regardless of whether the agent called Hunch.

Retention also expires abandoned open reports 90 days after creation (or the explicit `prune --days` interval). Expiry is serialized with writes and removes only local observations and generated HTML, never project memory. It does not fabricate completion or interruption evidence. Native full pre-edit injections are linked to the exact prompt; repeated delta notices do not create another full-delivery claim. A new native prompt receives its own first full injection.
