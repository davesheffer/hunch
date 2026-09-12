# Next release: see what Hunch contributed

Status: shipped in 1.32.0 on 2026-09-11 and hardened in 1.32.1 and 1.32.2 on 2026-09-12; all five implementation slices were executed; the acceptance gates below that were not run before publication remain open in the [qualification record](task-report-qualification.md) (its 2026-09-12 update lists them). This document is kept as the plan that was executed.  
Requested: 2026-09-11.  
Release: 1.32.0.  
Priority: complete this experience before starting the next new roadmap feature. Existing live-pilot measurement continues.

The current command and integration behavior is documented in [Task contribution reports](task-reports.md).
The [development qualification record](task-report-qualification.md) contains
observed host results, measured performance, and the remaining release blockers.
The shared engine API lets a harness own lifecycle and presentation without model
cooperation. Built-in Claude hooks now cover the original no-call regression;
Codex uses managed MCP instructions. Live qualification records distinguish those
paths, interruptions, and unsupported strict filesystem read-only operation.
Passing service tests does not waive the remaining product acceptance gates.

## Product promise

**Your agents carry your project's experience into each task, and you can see where that experience mattered.**

The release answers three questions without asking the developer to read tool logs: Is Hunch connected? What did the agent receive? What contribution can we demonstrate?

The memorable moment is a lesson crossing a session boundary. A developer records why a configuration update must preserve existing settings. In a fresh task, the next agent receives that lesson, implements the relevant behavior, and produces an inspectable report showing the original lesson, its delivery, and the verification result. The developer did not need to repeat the lesson.

Release acceptance: a repository user can complete this loop through a supported agent integration, see the report in their normal workflow, and open its evidence. A terminal user needs no CCC installation or hosted account.

### Binding requirement: answer the original user's wish

Production readiness and the user's experience are release gates, not follow-up polish. The user clarified that Kimi, Codex, Claude, CCC, and Watchtower are providers/harnesses: Hunch must remain agnostic. Ship one task/evidence contract and deterministic rendering that any authorized harness can consume. Do not require their repositories or add product-specific forks. Qualify built-in adapters with real hosts and publish accurate capability limits; protocol compatibility alone does not prove automatic display in an external harness.

| What the user needs | Required production behavior | Release-blocking failure |
| --- | --- | --- |
| “I installed it and ran init.” | Existing users update through the normal supported path; configuration is preserved and any reconnect needed is stated clearly. No manual instrumentation setup is required for the advertised primary integrations. | Works only in a fresh demo repo or needs hidden flags/manual hook edits. |
| “I see the tool calls.” | Hunch identifies an actual task's memory delivery, with the original lesson available. | Configuration/probe success is presented as real agent use. |
| “But did it help?” | At least one relevant real task produces a specific contribution with inspectable execution/verification evidence; the report clearly separates attribution from conformance. | A call counter, agent praise, or a passing unrelated test is the only evidence. |
| “Do I have to ask it?” | A concise completion card appears through the verified integration without asking about Hunch or invoking a report command. Uninstrumented tasks are visibly incomplete when the integration can observe them. | The user must remember a command, explicitly ask for Hunch, or inspect raw logs to get the answer. |
| “Will the next agent remember?” | A fresh task receives a previously recorded relevant lesson without the user repeating it, and both tasks remain linked in the evidence view. | The demonstration relies on the first task's conversation history. |
| “Is the feedback believable?” | No-match, no-use-evidence, failed-check, stale-check, save-failure and disconnected states say exactly what is known, with a concrete recovery action where possible. | An unconditional green badge or invented impact claim. |

The report command is a recovery and inspection surface. It does not satisfy the automatic completion requirement. A fixture proves the contract; a real host task proves the experience. Both are required.

## The experience to ship

### 1. Setup that establishes what works

At the end of init/update, show the selected integration, configuration health, observed runtime activity, and the next action when evidence is missing. Reuse the existing opt-in MCP probe rather than silently executing custom launchers.

Keep four independent facts: configured, fresh-server read verified, actual host activity observed, and task contribution evidenced. A probe must never count as a real task or prove an already-open host session is connected. Reconnect instructions appear when pins change.

### 2. One useful indication while working

On the first relevant delivery in a task, surface a short line where the host supports it:

> Hunch recalled why configuration updates must preserve existing settings.

Deduplicate by task and record revision. Further deliveries remain inspectable without repeated banners. Report generation never adds a new edit/stop block or changes the user's firmness setting. Hosts that only expose tool responses receive the same information there; actual display support must be documented and tested.

### 3. A contribution card at the end of the task

Illustrative content; the demo must produce the evidence before this wording is allowed:

```text
Hunch · Update configuration handling

Recalled   Preserve existing settings · open original lesson
Applied    Used a merge · agent-reported · open linked change
Checked    Preservation test passed · open exact-change evidence
Saved      Empty-file finding · saved locally · open record

View task evidence
```

Show up to three relevant contributions; omit empty sections. If only delivery is known, say “Memory delivered; contribution unverified.” Distinguish no relevant memory, incomplete instrumentation, interrupted work, failed verification, and a failed memory save. Do not fabricate a positive story for every task.

The default card fits in a terminal or agent summary. Its local HTML detail view provides a readable timeline: original lesson → this task's delivery → linked action → verification. Use Hunch's existing visual language, legible type, short copy, evidence links, and explicit uncertainty. No account, background web server, external asset requests, or new dashboard application is required.

### 4. See a lesson reused

The detail view connects a record's creation to subsequent task deliveries and supported applications. The landing summary prioritizes the strongest evidenced contribution from the selected task. It must not join tasks using timestamps alone or count repeated delivery of the same record as repeated impact.

A bounded recent-task list is in scope. Weekly emails, organization analytics, estimated hours saved, and public efficiency claims are outside this release.

## Verified starting point and gaps

These were the gaps identified by the initial source inspection on 2026-09-11.
Subsequent implementation and runtime/release results are recorded in the linked
qualification document; this table preserves the starting point.

| Existing foundation | Gap this release must close |
| --- | --- |
| [Integration health](../src/integrations/health.ts) and [probe](../src/integrations/probe.ts) distinguish configuration from runtime evidence. | Present the distinction after setup and connect real activity to the task report. The probe uses a fresh process; it does not test the user's current host session. |
| [Delivery envelopes](../src/core/delivery.ts) have validated native `hdr_…` receipt IDs. | Persist enough exact delivery evidence to validate later task reports, including empty/abstaining responses. |
| [Local served ledger](../src/core/served.ts) records per-record delivery, optional session identity, rank and cost. | Rows currently omit envelope receipt identity and record revision hashes; no rows are written for empty deliveries. Add exact task/attempt linkage without inventing it for old rows. |
| [MCP delivery](../src/mcp/server.ts) passes an optional transport session ID into the ledger. | A transport session is not a reliable user-task identity; explicit task correlation and worktree/partition scope are needed. |
| [Usefulness contract](../src/core/outcomeExperience.ts) seals observations and distinguishes supported signals. | Its delivery reference currently requires historical `hunch-memory:hmctx_…` syntax. Add a versioned native-receipt path and retain historical validation. A nonempty evidence array alone does not establish causal contribution. |
| [Verification pipeline](../src/core/pipeline.ts) observes hook events; [Claude scaffolding](../src/integrations/scaffold.ts) registers lifecycle hooks. | Bind usable observations to report evidence and the exact tested change. A command name or an agent-written “pass” is insufficient verification. |
| [Native change proof](change-proof.md) binds exact committed transitions. | A task may end with uncommitted work. Represent a bounded worktree snapshot and its limitations; never label it a native committed-change proof. |
| [Outcome protocol](outcome-experience-protocol.md) assigns execution evidence to the host and validation to Hunch. | Expose one report contract through CLI/MCP and document how an orchestrator supplies and reads the same evidence. |

## Evidence rules

The report records separate facts rather than collapsing everything into a success score:

| Statement | Minimum support |
| --- | --- |
| Delivered | Valid native delivery envelope, exact record identity/revision, and an identified delivery occurrence. Delivery records show what Hunch returned; host acknowledgement is separate where available. |
| Agent reports applying | Explicit task-bound claim with a delivered record reference and a linked action; visibly labeled as self-report. |
| Supported application | Resolvable execution or verification evidence linking the delivered record to the action, checked against a declared validation rule. File overlap alone is insufficient. |
| Check passed | Observed successful result, named assertion, evidence source, and exact tested revision/snapshot. Later edits invalidate the current-pass display. |
| Invalid action stopped | Existing authorized gate refusal tied to the attempted action and applicable rule. Do not infer a prevented bug from a successful task. |
| Saved | Successful write identity and actual durability outcome. Preserve the difference between saved, committed, and pushed. |

Unsupported evidence remains unverified. A report can show a passing check while attribution remains agent-reported. The HTML renderer must not upgrade that wording.

## Technical design

Introduce a versioned task report derived by one core service. The surfaces, shipped as proposed, are `hunch report [task-id]`, `--json`, `--html <path>`, and the client-neutral MCP read tool `hunch_report`; `hunch impact` retains its existing branch/dependency meaning.

Use an explicit repository/worktree or served-partition scope, task ID, attempt ID, delivery occurrence ID, native content-addressed envelope ID, record hashes, evidence references, observation source, and report revision. A repeated envelope can have the same content ID in different tasks; an occurrence ID distinguishes delivery events. Task start/finish markers come from a supported host adapter or an explicit CLI/MCP lifecycle call. If identity cannot be established, retain unassociated activity and say why; never attach it to the most recent task by guesswork.

CLI/MCP/host adapters use the same validators and report derivation. Evidence ingestion accepts bounded references and hashes, checks scope and exact delivery membership, preserves provenance, and rejects conflicting identities. A submitted hash is a claim until the corresponding artifact or trusted host event is verified. Do not run arbitrary evidence commands or fetch arbitrary URLs to make a report look complete.

Extend the machine-local observation ledger with additive migrations for task activity and exact delivery evidence. Keep it outside the rebuildable search index; reindexing must not erase observed history. Old delivery rows remain readable and explicitly lack attribution. Report projections can be rebuilt from retained observations, not from current memory alone. Durable lessons stay in the existing Git-native store. Any authorized organizational export uses the existing state boundary; no second Hunch Memory service or competing source of truth is introduced.

Store no raw transcripts, hidden reasoning, credentials or arbitrary tool output. Bound retention and artifact size, expose a clear-history operation with explicit scope, and make missing/expired evidence visible. Local HTML is escaped and contains only authorized report content. Shared exports use public-only derivation before rendering, not cosmetic redaction afterward. Report failures remain best-effort and must never block edits; the next report surfaces missing observation coverage when detectable.

## Integration contract for this release

| Surface | Required behavior |
| --- | --- |
| Claude Code | Exercise existing start/pre-edit/post-tool/stop wiring in a real supported host. Observe task identity, create a final report, and demonstrate its user-visible presentation without a new blocking gate. |
| Codex | Use the repository's current MCP + managed instruction path. Start/finish reporting through explicit tools called by the agent, with no reminder from the user, and test real sessions. Do not invent hook support: the existing health matrix declares no Codex hook events. Missing lifecycle calls must remain visible. If instruction-driven reporting is unreliable, resolve the integration gap before advertising automatic support. |
| Other configured harnesses | Preserve current integration behavior; CLI/MCP reports remain available. Advertise automatic reporting only for host/version combinations exercised end to end. |
| Any harness / orchestrator | Consume the shared task/evidence contract through CLI/MCP or the engine API. Create the task, pass its ID to retrieval/execution, and render deterministic report data on completion or interruption. Agent prose is optional attribution. Ship a runnable contract fixture and integration guide. Preserve scope/authentication at the transport boundary; no provider-specific fork or external repository is required. |

If a required primary host cannot reliably show an automatic completion card, that is a release blocker to resolve during the first implementation slice. A manual fallback alone does not close it. Other hosts may ship with explicitly limited compatibility, but the confirmed original user's setup cannot be silently moved to that category.

## Ordered implementation slices

Each slice is separately reviewable; the entire release requires the complete user journey.

| Order | Work and principal files | Completion evidence |
| --- | --- | --- |
| 1 — complete one thin path | Add task identity, one persisted native delivery, one linked verification observation, and a plain report. Touch `served.ts`, `delivery.ts`, `outcomeExperience.ts`, `mcp/server.ts`; isolate new report logic in a core module. Exercise Claude and Codex lifecycle feasibility early. | Two fresh tasks in a disposable repository connect the same lesson correctly. Empty deliveries and missing task IDs do not produce success claims. Native and historical receipt fixtures validate under their own versions. |
| 2 — make collection dependable | Add correlation across hooks/MCP, snapshots, persistence, idempotency, interrupted-task handling, and evidence validation. Reuse pipeline and gate events where applicable. | Concurrent worktrees/tasks stay isolated; forged/stale/wrong-task observations fail validation; historical data remains readable after upgrade and reindex. |
| 3 — ship the visible experience | Add CLI/MCP report readers, concise agent completion instructions, setup/health summary, terminal rendering, and self-contained HTML evidence view. Work through `src/cli/`, `src/integrations/`, and managed grounding generation. | A user sees the card without asking “did Hunch work?”; each claim opens evidence. Narrow terminal, plain output, light/dark HTML, keyboard access, empty/failure states, and public-only export are checked. |
| 4 — prove the release story | Create a repeatable two-task demo fixture, run real host rehearsals, document compatibility and CCC contract, and add release notes through the existing localization workflow. | A real selected subscription CLI performs the demonstration; synthetic setup is labeled. Preserve report and verification artifacts. A fresh observer can explain the contribution and its limits without inspecting raw tool logs. |
| 5 — release candidate | Run focused tests, full compiled-CLI release gate and platform matrices; rehearse clean installation and upgrade; synchronize version pins and publish only the exact verified candidate through the existing release workflow. | All required CI/release checks pass on the candidate; clean-install and upgrade users reproduce the supported experience. |

Planning estimate: 8–12 focused engineering days for one engineer, including polish and release rehearsal, assuming the existing host lifecycle paths provide the needed evidence. This is a scope estimate, not a promised date. Re-estimate after slice 1. If time compresses, reduce secondary-host automation and history browsing first; preserve the required primary-host journeys, correct attribution, and the evidence detail view. Extend the schedule rather than release a manual-only answer for the original user.

## Release demonstration and acceptance gates

1. Start from a disposable repository installed using the release candidate. Show health before and after an actual agent call; the setup probe never appears as user activity.
2. Record a configuration-preservation lesson through Hunch. Create a fresh agent task with a relevant implementation request, without repeating the lesson in that request.
3. Observe its exact delivery. Complete the change and independently verify the specific preservation assertion against the resulting snapshot or commit. Show the final contribution card and open the original lesson, delivery and check evidence.
4. Repeat with no relevant memory, no outcome instrumentation, failed verification, a later edit, and an interrupted task. Each must present the correct limited result. A matched filename must not turn into “used.”
5. Demonstrate one deliberately invalid attempted action in a clearly labeled fixture under an already-authorized gate. A stopped-action claim must bind to that refusal; it must not appear in normal sessions without such evidence.
6. Run two concurrent tasks and two worktrees; replay duplicate events; alter a receipt/hash; supply a different task's evidence. Require isolation, idempotency and rejection of mismatched evidence.
7. Upgrade an old served ledger, reindex, restart, and reopen the report. Preserve available observations; never backfill historical impact claims. Simulate ledger failure and require that editing continues.
8. Exercise private-overlay and served-scope isolation with sentinels. Public-only artifacts and package contents must not contain private evidence. Verify HTML escaping and safe evidence links.
9. Before release, run `npm run typecheck`, targeted tests for the changed paths, and the required full `npm run gate:release`/CI platform workflow on the compiled candidate. Test publication packaging if new report assets/contracts are included; the release workflow has an explicit allowlist.

Product gate: in observed usability sessions with at least two repository users, each can identify connection state, name one supported contribution, and open its evidence within 30 seconds of seeing the report. Record the outcome; this is a target to test, not an existing measurement. Recruiting the users is release coordination work, not permission to contact anyone automatically.

## Production go/no-go checklist

All items below must have a recorded result on the release candidate. An unrun item stays pending; synthetic results do not become live-host results.

- **Normal-use reliability:** for each required host, complete ten fresh task attempts across relevant-memory, irrelevant-memory, failed-check, interrupted-task and reconnect cases. No prompts may ask the agent to remember Hunch or generate its report. All normally completed tasks show their correctly scoped card; interrupted/disconnected attempts remain correctly incomplete. Repeat at least one relevant task after restarting the host.
- **Upgrade and rollback compatibility:** rehearse current-version upgrade with existing custom MCP configuration, public/private memory and historical served rows. Prove idempotent setup and additive ledger migration. Document rollback behavior; do not require a durable-store schema migration solely for report presentation.
- **Evidence durability:** kill a process during observation/report writes and retry duplicate writes. No partial artifact may be accepted as valid, and a restarted report must not borrow another task's evidence. Concurrent writers must preserve independent events or report missing coverage without blocking work.
- **Exactness:** changing the tested file after verification invalidates its current-check claim. Reused content-addressed envelopes in separate tasks retain separate occurrence identities. Superseded/deleted lessons preserve historical reference meaning or show evidence unavailable, rather than borrowing today's text.
- **Performance:** report creation uses deterministic code and no additional model call. Initial acceptance budgets are at most 100 ms p95 incremental warm hook-observation overhead and 2 seconds p95 local report derivation for a declared 10,000-event fixture. Measure on documented release hardware with at least 30 samples and report cold-start behavior separately. If budgets need adjustment, explain it before sign-off; no silent removal of expensive checks.
- **Presentation:** inspect the actual terminal output and rendered HTML, including 80-column output, long record titles, Unicode, zero contributions, failed checks and missing evidence. Verify keyboard access, readable contrast and meaningful link labels. Keep the normal card within ten lines excluding a necessary recovery instruction; detailed evidence belongs in the view.
- **Operational controls:** bound event payloads and retention; test expiry and unavailable evidence. A documented presentation opt-out silences cards without deleting memory or disabling existing protections. Report generation must never introduce an edit/stop block, auto-activate policy or execute arbitrary evidence commands.
- **Scope and privacy:** repeat private-sentinel, task/worktree isolation and safe-rendering checks on the packaged candidate. The report is local by default; no automatic external upload, public export or background network dependency is introduced.
- **Release integrity:** required CI and platform checks pass, new packaged resources are covered by the release allowlist, all generated version pins agree, and install/upgrade rehearsals use the exact packed candidate. Public copy describes only behavior observed on named supported host versions.

Keep a release acceptance record containing candidate revision/package hash, host versions, case IDs, task/report IDs, evidence artifact locations, measured latencies, failures and final dispositions. Release sign-off is blocked while any original-user requirement is unmet or any required case is unknown. That record is [the qualification record](task-report-qualification.md); the items it still lists as open were not waived by publication.

## Scope decisions and revisit conditions

- **Ship one evidence-backed task experience.** A delivery-count dashboard alone cannot answer the user's question about contribution. Keep `hunch served` as a diagnostic view.
- **Ship a compact card plus local evidence detail.** A prose-only “Hunch helped” footer depends on agent self-report; the structured report lets every renderer preserve the evidence grades. The extra view earns its scope only if it remains a small projection of the same data.
- **Keep the core provider-neutral.** A CCC-only implementation would leave the repository user in the original conversation without an answer. Keep one shared engine contract. External harnesses own their lifecycle and rendering adapters; Hunch ships the validated data and deterministic renderer, with built-in adapters qualified separately.
- **Do not use report outcomes to change retrieval ranking or promote authority. A bounded recalibration of the existing memory prior repairs the lexical dilution introduced by new indexed helpers; the golden floor and expected records remain unchanged.** Gather valid evidence first; a later versioned policy can use it after review. Do not turn an agent's successful task into an accepted decision.
- **Defer causal efficiency claims.** If a time/token improvement claim is later required, use the existing preregistered experiment path and its applicable roadmap gates. This release promises inspectable contributions.

## Coordination and ownership

Hunch owns the report schema, validation, local ledger, CLI/MCP surfaces, built-in adapters, documentation, and release gate. Host adapters own collection of actual execution events; external orchestrator owners integrate their UI and authenticated evidence source. Assign named implementation/review owners when work starts; no external integration is assumed complete.

The principal schedule risk is task identity and reliable lifecycle delivery across hosts. Slice 1 resolves that before presentation polish. The principal trust risk is presenting correlation or agent prose as verified impact; the evidence rules and negative-path release gates address it. The existing organizational-state roadmap remains intact; this item makes Hunch's contribution visible and provides a reusable report contract for that direction.

## Provider and harness neutrality — clarified 2026-09-11

Kimi, Codex, Claude, CCC, and Watchtower are examples of consumers, not a list of product-specific integrations to build. Hunch owns task identity, exact delivery evidence, validation, report derivation, and deterministic presentation data. A harness owns its authoritative lifecycle, execution, and display. No agent's compliance is required when a harness drives the contract. Never guess identity from transport sessions or timestamps, and never accept agent-supplied successful checks as independently observed execution. External transport adapters retain authorization and partition isolation; local reports are not automatically remote resources.
