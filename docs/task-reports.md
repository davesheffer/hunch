# Task contribution reports

Shipped in 1.32.0. Live-host results and the acceptance items still open are
recorded in the [qualification record](task-report-qualification.md); this
document is not a claim that every host has passed its live acceptance tests.

**See what Hunch contributed to the work.** A short completion card and a local HTML report show what memory reached the agent, what the agent says it used, and which checks actually ran. These are separate kinds of evidence: a delivered lesson or a passing test alone does not prove that Hunch improved the result.

The durable memory is the decision, rule, bug history or finding that future tasks can reuse. A task report records how that memory appeared in one task. Project DNA is different again: it describes observed repository conventions, such as terminology and review habits; it does not make those habits mandatory.

## Normal agent workflow

The generated Hunch instructions ask the agent to:

1. Reuse the task ID and exact `cwd` supplied by a trusted native prompt hook. If none was supplied, start one task with `hunch_task(action: "start", title: "Short task title")`.
2. Carry the returned `task_id` and hook-supplied `cwd` into each `hunch_context`
   call and each decision, correction, or finding capture. Pass that `cwd` again
   when reading or finishing the task report.
3. Run a relevant verification using the exact `verification_argv` launcher from
   task start, followed by the command and arguments. This avoids stale global CLIs.
4. Before attributing an application, read `hunch_report(task_id)` and copy its
   exact `application_references`, adding the action actually taken.
5. Finish with `hunch_task(action: "finish", task_id, applications?)` and include
   the structured `contribution_card`, including its Evidence line, in the final
   response unless presentation is disabled.

The first time a lesson revision reaches a task, the delivery carries one
line — `Hunch recalled: <lesson title>` — in the `hunch_context` result, the
`hunch context --task` output, and, for Claude Code's pre-edit hook, as a
`systemMessage` the host shows the user. Repeats of the same revision in the
same task stay silent; deduplication is per task and record revision, so a new
prompt hears a lesson once more. Presentation opt-out silences the hook line.

Native hooks can supply task identity; the agent's reporting workflow remains instruction-driven. Configuration does not prove the host
followed it. A host must load the current MCP server and allow the tool calls;
missing task identity or denied tools cannot produce a verified contribution.
Hunch does not guess a task ID from a transport session or recent activity.

`hunch init` writes the instructions. `hunch update` invokes the freshly installed
CLI's `integrations repair-pins`, which now also refreshes existing Hunch
grounding documents. Other user prose and unrelated integration settings remain
preserved. Restart/reconnect the host after updating. In Codex, open `/hooks` to review and trust changed hook commands, then start a new session. An updated version pin changes the command and needs renewed trust. Hunch does not grant that trust automatically.

`hunch integrations check --harness codex --probe --require mcp` checks a fresh MCP process. After a trusted hook has run in the host, `hunch integrations check --harness codex --require context` checks its recorded context delivery. The first check does not prove the second, or prove that the model used the delivered memory.

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
the wrapper exit unsuccessfully. The default timeout is two minutes;
`--timeout <seconds>` (before `--`) raises it up to six hours for a long suite,
and the engine API's `verify(…, { timeoutMs })` accepts the same range. SIGINT and
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

## Tasks in the graph

A finished task with at least one observation becomes graph memory:
`.hunch/tasks/<task_id>.json`, a bounded summary in the same JSON format as
decisions and findings (title, delivered lesson revisions, agent-reported
applications and whether Hunch's own rule check supported them, saves with their
home and proven durability, observed checks, the files it touched, and the
content hash of the full local report). It is written through the same capture
path as every other record, so public/private homing, the one-home-per-record
rule, auto-commit and team routing apply unchanged. A task that saved to the
private overlay, or that received a lesson living only there, is homed private.
Empty tasks stay ledger-only. Titles are the only prose kept; prompt text,
transcripts, context payloads and denial reasons never leave the local ledger.

Up to five graph tasks are delivered as a "RECENT TASKS" supplement by
`hunch_context`, the pre-edit hook and `hunch context` (advisory history
sharing the brief's budget; withheld on time-travel), chosen deterministically:
candidates are tasks that touched the file, a dependent of it, a file that
co-changed with it in at least two commits, or that share a rule or decision
with the current task; each is scored by file relation, IDF-weighted shared
records, outcome (a violated rule or failed check ranks highest), phrase
match, recency (30-day half-life, never a cutoff) and overlap with the files
this task already touched. Slots: the latest task on the exact file, the most
recent task with a problem, then up to three relevant tasks with near-duplicates
removed. Every line names its reasons ("same file", "shares con_x (3 tasks)",
"RULE VIOLATED", "12 days ago"). The current task's own ledger is the query; no
prompt text is read or stored. A task whose last check passed, with no rule
violated, supersedes older tasks on the same file that share a record with it;
superseded records stay in the graph but are not delivered. Recency counts
from the later of a task's finish and its last delivery, so lines that keep
being useful stay warm.

Whether that selection helps is measured, not assumed: `hunch task rank-eval`
replays history leave-one-out (rank the older tasks with each task's own
record as the query; did the records it evidently used land in the five
slots?) and reports Hit@5 and MRR against "latest 3 on the file" with a paired
bootstrap confidence interval; `hunch task stats` adds two proxies from task
records alone, the re-verification rate (a later task re-ran an earlier task's
check on the same file within 24 hours) and the repeat-violation rate. The
pre-registered rule applies itself: the evaluation is recomputed whenever a
task record is written (cached under `.hunch-cache/task-rank-eval.json`),
delivery reads it, and once 200 task records exist a ranked selection that has
lost to "latest 3" with a confidence interval excluding zero switches delivery
to latest-only; the header says so, `hunch now` and `hunch task stats` print the
current line, and a verdict change is recorded as a finding. Nobody has to run
anything. `"taskRanking": "ranked" | "latest"` in `.hunch/local.json` pins the
mode for a repository that wants to.
`hunch task list` and the VS Code Contribution view show graph records next to
local observations (`in graph (public|private)`), including tasks another
machine or teammate finished. `hunch report <id>` prints the graph record when
the local ledger no longer has the task. Graph tasks are indexed for
`hunch_query`, and `hunch_why <file>` lists recent tasks that touched the file.
One record per episode, not per prompt. A prompt that follows another of the same host session within 30 minutes continues its task: the ledger row carries `continues` (the previous task) and `episode` (the first task of the chain), and the chain's graph record is written under the episode's id and refreshed as prompts finish. "status", "next" and "go" therefore add their observations and their git-side work to the work they belong to instead of leaving empty rows behind. The session is kept only as a hash; the host session identifier is still never retained. An episode whose record already lives in the public store splits when a later prompt brings private-only memory, so private memory is never named in a public record. A task still open when the next prompt arrives (the user interrupted the previous one before its Stop) is the session's current work whatever its age: the new prompt continues it and closes it as a host close, so its evidence reaches the record. A host notification turn (a background command finished) continues the session's latest task instead of opening a row of its own.

Git-side anchoring excludes Hunch's own work: commits with a `hunch:` subject (captures, task records, repairs) and fresh working-tree changes to the grounding files a capture rewrites (`CLAUDE.md`, `AGENTS.md`, the host rule files); a user commit that edits those files, or a delivery that named one, still counts. When another session had a task open on the same checkout during the window, only commits anchor the record: a working-tree mtime cannot say whose edit it was.

A record's `files` also include what git saw change while the task was open: commits authored by the configured git user in the task window (merges excluded) and working-tree changes whose modification time falls in it. Work done from a shell (patch scripts, rebases, release commits) therefore anchors the record even though no pre-edit hook ever fired for it. Hunch's own memory and cache paths and deletions are excluded; report-derived files come first under the 64-file cap.

Set `"taskRecords": false` in `.hunch/local.json` to keep tasks ledger-only.
Set `"taskRecordsFlush": "batch"` to write records without their own commit;
they ride the next capture commit (decision, finding, correction) instead.

By default native tasks (Claude Code, Codex) carry the generic title
"Assistant task" and no prompt text is retained anywhere. Set
`"taskTitles": "prompt"` in `.hunch/local.json` to title them from the prompt's
first line (72 characters, cut at a word). Credential-looking prompts keep the
generic title. That title is then the only prompt-derived prose retained, and it
travels into the task's graph record, so opt in only where the graph's home is
acceptable for it.
The files a task touched include the targets of its context deliveries when
they name a path or symbol; task phrases are never recorded as files.

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

Claude Code 2.1.196+ supplies an authoritative prompt identifier. Existing Hunch prompt hooks create an exact report from physical worktree, provider, session, prompt and optional agent identity; raw prompt text and host identifiers are not retained (a repository that opts in with `taskTitles: "prompt"` keeps only a bounded first-line title). Every prompt receives its ID and canonical worktree `cwd` even when ambient reminders are deduplicated. The model reuses both through MCP. The Stop hook emits a nonblocking `systemMessage`, including missing coverage when no linked retrieval occurred. It never adds a Stop block or another model turn. An existing verification gate still takes precedence.

Stop closes the prompt's task as a *host close*: the ledger records the task as completed when the turn ends, and a task with observations becomes a graph record without the agent calling finish. The close is provisional. Another hook may continue the turn, so the next observation reopens the task and the following Stop closes it again, refreshing the record from the report. Once the session has moved on to a later prompt, an observation that still names the older, host-closed task (the grounding tells agents to reuse ids) lands on the session's newest task instead, so nothing is reopened that no Stop would close again; verification keeps its own task, since a result must match its start. An explicit finish or interruption from the agent overrides a host close and is final. Stop also closes any task an earlier prompt of the session left open, and a new prompt closes them on arrival, so an interrupted prompt's evidence is never stranded. A task whose verification is still running stays open; a verification whose runner never came back (a killed process, a closed laptop) stops holding the task open once its own timeout plus a minute has passed, and the report keeps saying that its result was not retained. Older Claude versions receive an unassociated coverage notice, never a report selected by time or recent task. Presentation opt-out silences both notices and cards; firmness off retains its existing disabled-hook semantics.

Live Claude 2.1.268 headless qualification observed exact prompt continuity through a Stop continuation, informational-message delivery, and the previously failing README task now returning an empty-memory card with a clickable Markdown evidence link. Interactive display and CCC/Watchtower adapters require their own qualification.

## Native Codex lifecycle coverage

Codex 0.153+ has a Hunch lifecycle adapter for `.codex/hooks.json`. After the project and hook commands are trusted, the prompt hook can supply the task identity from `turn_id` and its canonical worktree `cwd`; the agent reuses both through MCP. Pre-edit and post-tool events support grounding and observation, and Stop can present the contribution card. Hook command changes require renewed review through `/hooks` and a new session.

Check observed delivery with `hunch integrations check`. Enabled configuration does not prove that each event ran, that a failed-tool event was delivered, or that the model used a lesson.

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
