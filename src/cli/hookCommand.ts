/**
 * `hunch hook`: the agent-hook handler. Lives apart from the Commander program so
 * the hook-only bundle (hookMain.ts) can run it without loading the whole CLI.
 * MUST NOT import ./index.js (directly or transitively).
 */
import { existsSync, readFileSync } from "node:fs";
import { beginHookInvocation } from "../core/hookMemo.js";
import { join, relative, dirname, resolve, isAbsolute } from "node:path";
import { hunchPaths, findRoot, toPosixTarget, isDir, repoRelativeTarget } from "../core/paths.js";
import { looksLikeCorrection, CORRECTION_NUDGE, stripHostBlocks } from "../core/correction.js";
import { roleHasHunchTools } from "../core/subagentrole.js";
import { integrationSessionWarning } from "../integrations/health.js";
import { HunchStore } from "../store/hunchStore.js";
import { teamPullIsFresh, sameFilesystemEntry, checkoutCommonDir } from "../extractors/git.js";
import { readActivePendingRepairs, withheldRewrites } from "../core/repairqueue.js";
import { HOOK_REMINDER } from "../core/hookText.js";
import { taskSelectionSupplements } from "../core/taskDelivery.js";
import { buildTaskRankingQuery } from "../core/taskQuery.js";
import { buildDeliveryEnvelope, deliveryDedupeInput } from "../core/delivery.js";
import { readConfig } from "../core/config.js";
import { blockingInScope, vetoInScope, proposedEditLines, type BlockingHit } from "../core/hookpolicy.js";
import { appendEvent } from "../core/events.js";
import { clearTaskSelection, injectionMode, loadTaskSelection, resetSessionInjections, saveTaskSelection, taskSelectionEnabled } from "../core/hookcache.js";
import { isBareFollowUp, isFilterableSelectionId, liveSelectionRecords, promptPaths, selectForTask } from "../core/taskSelection.js";
import { recordServed } from "../core/served.js";
import { readTaskReport, recordTaskDelivery, reportHash, reportPresentationEnabled, unseenLessons } from "../core/taskReport.js";
import { snapshotDeliveredRecords } from "../core/taskReportEvidence.js";
import { renderRecalledLine } from "../core/taskReportRender.js";
import { closeHookTask, hookReportTaskId, isNotificationPrompt, nativeHookCwd, settleHookSession, startHookReport, stopHookReport, observeHookDenial } from "../core/taskReportHook.js";
import { persistTaskRecord } from "../core/taskRecord.js";
import { recordHookObservation } from "../core/hookObservations.js";
import { contextHookOutput, deliversCommandOutcome, deliversPromptEvent, denyHookOutput, hookProvider, normalizeHookEvent, stopHookOutput, type HookProvider, type HunchHookEvent, type HunchHookInput, type HunchToolInput } from "../core/agenthook.js";
import { PIPELINE_LOOP, armExecutionObligations, beforeEditProbeVerdict, compileExecutableProbes, environmentExecutableProbes, environmentExecutionObligations, executionObligationBrief, isProductPath, loadPipelineState, onCommand, onEdit, onPrompt, onSkill, pipelineEnabled, proofCheckpoint, savePipelineState, stopVerdict, onLessonsDelivered, lessonReminder, unverifiedNag } from "../core/pipeline.js";
import { recallFailures, type FailureRecall } from "../core/failureRecall.js";
import { nowData } from "../wiki/wiki.js";
import { pendingEscalations, policyEscalations, commitRepairEscalations, actionableEscalations, relevantEscalations, type Escalation } from "../core/escalations.js";
import { premiseEscalations } from "../core/premises.js";
import { parseDocAnchors, renderDocGrounding } from "../core/docanchors.js";
import { pathMatchesGlob } from "../core/glob.js";
import { SIBLING_HEADING, functionBodyHash, siblingGrounding } from "../core/siblingfix.js";
import { noteEditedFiles, refreshShellBaseline, shellWrittenFiles } from "../core/shellwrites.js";
import type { Decision } from "../core/types.js";
import { openTeamStore } from "./teamStore.js";

export async function runHookCommand(opts: { provider?: string }): Promise<void> {
    // Every entry (full CLI, the hook-only bundle) comes through here: one hook
    // invocation, one memo scope.
    beginHookInvocation();
    // A hook MUST NEVER break the agent: on ANY error or unrecognized input we
    // exit 0 and never deny (the action defers to the host's normal flow).
    // Unrecognized input stays silent; an error after the event was recognized
    // says "grounding unavailable" in one context line — see the catch below.
    let store: HunchStore | null = null;
    // Hoisted so the fail-open catch below can still say which grounding was lost.
    let provider: HookProvider | null = null;
    let eventName: HunchHookEvent | null = null;
    try {
      provider = hookProvider(opts.provider);
      if (!provider) return;
      const evt = normalizeHookEvent(JSON.parse(await readStdin()), provider);
      if (!evt) return;
      eventName = evt.hook_event_name;
      // Grounding reads the store of the checkout the event's file is in; the prompt's
      // task and the hook evidence stay with the process root that opened them.
      const processRoot = findRoot();
      const routed = hookEventRoot(processRoot, evt);
      const root = routed.root;
      // The host delivered this event: runtime evidence for `hunch integrations check`,
      // recorded before any policy decision so firmness never hides delivery itself.
      recordHookObservation(processRoot, provider, evt.hook_event_name, evt.tool_outcome?.status);
      const paths = hunchPaths(root);
      const firmness = readConfig(paths).firmness;
      if (firmness === "off") return;

      // Verification pipeline (delivery enforced, not hoped for — see core/pipeline.ts).
      // PostToolUse records facts; Stop gates on them. Both are pipeline-only events,
      // handled before the grounding dispatch below.
      const postTool = evt.hook_event_name === "PostToolUse" || evt.hook_event_name === "PostToolUseFailure" ? evt.hook_event_name : null;
      // A shell command can edit files without the edit tools ever firing: ground
      // what it wrote now. Every other tool call just moves the baseline.
      let shellGround = "";
      let recall: FailureRecall = { text: "", bugs: [] };
      const recallScope = `${evt.agent_id ?? "main"}:`;
      if (postTool) {
        const shell = evt.tool_name === "Bash" || evt.tool_name === "PowerShell";
        let stale = false;
        let openFailed = false;
        const openStore = (): HunchStore => {
          if (store) return store;
          // One team pull per event: a failed open is not retried by the recall below.
          if (openFailed) throw new Error("store unavailable");
          openFailed = true;
          const opened = openTeamStore(root, { requireFreshTeamMemory: firmness === "strict" });
          openFailed = false;
          // Same rule as the pre-edit path: strict never grounds from stale team rules.
          stale = !!(firmness === "strict" && opened.teamPullStatus && !teamPullIsFresh(opened.teamPullStatus));
          return (store = opened.store);
        };
        // Fail-open on its own: a grounding error must not cost the pipeline
        // bookkeeping below (a missed check would wrongly hold the Stop gate).
        try {
          if (shell) {
            const written = shellWrittenFiles(root, evt.session_id, evt.agent_id);
            if (written.length) {
              const opened = openStore();
              if (!stale) shellGround = shellWriteGrounding(root, opened, provider, evt, written, processRoot);
            }
          } else {
            // An edit tool wrote known files: move just those baseline entries.
            // Any other tool (and a first observation) re-reads the tree.
            const edited = EDIT_TOOLS.has(evt.tool_name ?? "") || evt.tool_input?.patch_files?.length ? editTargets(root, evt.tool_input).map((t) => t.target) : [];
            if (edited.length) noteEditedFiles(root, evt.session_id, evt.agent_id, edited);
            else refreshShellBaseline(root, evt.session_id, evt.agent_id);
          }
        } catch { shellGround = ""; }
        // A failed check that matches a recorded bug says so; anything else stays silent.
        if (shell && evt.tool_outcome?.status === "failure" && evt.tool_outcome.output) {
          try {
            // Per agent, like shellWrittenFiles: a recall a subagent saw is not one the main agent saw.
            const seen = evt.session_id && pipelineEnabled()
              ? loadPipelineState(evt.session_id).recalled.filter((k) => k.startsWith(recallScope)).map((k) => k.slice(recallScope.length)) : [];
            // The store opens only once the output parses as a failing test report.
            recall = recallFailures(evt.tool_outcome.output, () => {
              const opened = openStore();
              return stale ? [] : opened.recs("bugs");
            }, seen);
          } catch { recall = { text: "", bugs: [] }; }
        }
      }
      if (postTool && evt.session_id && pipelineEnabled()) {
        let st = loadPipelineState(evt.session_id);
        if (recall.bugs.length) st = { ...st, recalled: [...st.recalled, ...recall.bugs.map((id) => `${recallScope}${id}`)] };
        const before = st;
        let activity: Parameters<typeof proofCheckpoint>[2] | null = null;
        let lessonNote = "";
        if (/^(Edit|Write|MultiEdit)$/.test(evt.tool_name ?? "")) {
          // A Codex apply_patch touches every file it lists (and each Move-to
          // destination); the Stop gate must see all of them, not only the first.
          // Same in-repo filter as the pre-edit path: a scratch file outside the
          // repository is not a product edit, and recording it would block Stop on
          // a path no check can ever verify.
          const edited = editTargets(root, evt.tool_input);
          for (const e of edited) st = onEdit(st, e.target);
          if (edited.length) activity = { kind: "edit" };
        } else if (evt.tool_name === "Bash" || evt.tool_name === "PowerShell") {
          const command = String(evt.tool_input?.command ?? "");
          st = onCommand(st, command, evt.tool_outcome);
          activity = { kind: "command", command };
          // A command that both wrote the file and ran a check just received the
          // lesson itself; the follow-up waits for the next check.
          if (!shellGround) {
            const followUp = lessonReminder(st, command, (l) => functionBodyHash(root, l.file, l.symbol));
            st = followUp.state;
            lessonNote = followUp.reminder;
          }
        } else if (evt.tool_name === "Skill") {
          st = onSkill(st, String(evt.tool_input?.skill ?? ""));
          activity = { kind: "skill" };
        }
        if (activity) {
          const checkpoint = proofCheckpoint(before, st, activity);
          st = checkpoint.state;
          savePipelineState(evt.session_id, st);
          const post = [shellGround, recall.text, lessonNote, checkpoint.reminder].filter(Boolean).join("\n\n");
          if (post) emitContext(provider, postTool, post);
          return;
        }
        savePipelineState(evt.session_id, st);
        const post = [shellGround, recall.text].filter(Boolean).join("\n\n");
        if (post) emitContext(provider, postTool, post);
        return;
      }
      if (postTool) {
        const post = [shellGround, recall.text].filter(Boolean).join("\n\n");
        if (post) emitContext(provider, postTool, post);
        return;
      }
      if (evt.hook_event_name === "Stop") {
        if (evt.session_id && pipelineEnabled()) {
          const st = loadPipelineState(evt.session_id);
          const verdict = stopVerdict(st, firmness);
          if (verdict.block) {
            savePipelineState(evt.session_id, verdict.state);
            emitStop(provider, verdict.reason);
            return;
          }
        }
        // The turn is over: close the prompt's task and keep its record, whether
        // or not the agent called finish. Fail-open: the card below still renders.
        try {
          const closed = closeHookTask(root, provider, evt);
          if (closed.length) { store ??= new HunchStore(paths); for (const id of closed) persistTaskRecord(root, store, id); }
        } catch { /* the ledger and the card remain authoritative; the next finish retries */ }
        const report = stopHookReport(root, provider, evt);
        if (report) console.log(JSON.stringify(report));
        return;
      }

      if (evt.hook_event_name === "UserPromptSubmit") {
        // When the prompt reads like a correction ("no / that's wrong / never X"),
        // nudge the agent to PERSIST it as an enforced constraint (Never Twice) —
        // not just obey it this once and forget it next session.
        // Shell writes are measured from the start of each prompt.
        refreshShellBaseline(root, evt.session_id);
        const isCorrection = looksLikeCorrection(evt.prompt);
        // Once per session is enough for the bare availability reminder — repeating it
        // every prompt burns context for zero information (dec_244397d920). It is deduped
        // on its OWN key: hashed together with the per-prompt task report (a new ID each
        // prompt) it was re-sent on every prompt. A correction is never deduped: two
        // back-to-back corrections are byte-identical, and the second (usually the
        // escalating one) must still become an enforced rule. Neither is the unverified
        // nag below, the one nag that must repeat.
        const parts: string[] = [];
        // Always stamp the key, so a correction that delivers the reminder counts as
        // this session's one delivery.
        const reminderDue = injectionMode(evt.session_id, "prompt-reminder", HOOK_REMINDER) === "full";
        if (isCorrection) parts.push(`${HOOK_REMINDER}\n\n${CORRECTION_NUDGE}`);
        else if (reminderDue) parts.push(HOOK_REMINDER);
        // Reporting failure must not suppress the existing correction/policy reminder.
        try {
          const report = startHookReport(root, provider, evt);
          if (report) {
            parts.push(report);
            store ??= new HunchStore(paths);
            const selected = promptTaskSelection(root, store, provider, evt);
            if (selected) parts.push(selected);
          }
        } catch { /* passive reporting remains fail-open */ }
        // A task an earlier prompt of this session left open (interrupted before
        // its Stop) is over now: close it and keep its record.
        try {
          const settled = settleHookSession(root, provider, evt, { keepId: hookReportTaskId(root, provider, evt), keepNewest: true });
          if (settled.length) { store ??= new HunchStore(paths); for (const id of settled) persistTaskRecord(root, store, id); }
        } catch { /* the next Stop or prompt retries */ }
        // Escalations this prompt's task touches (dec_12ba37db1c): asked once per
        // session, never answered for the human; the rest stay pending in
        // `hunch escalations`. A broken store must not take the prompt hook down.
        try {
          store ??= new HunchStore(paths);
          const ask = await promptEscalations(root, store, provider, evt);
          if (ask) parts.push(ask);
        } catch { /* escalations stay listed by `hunch escalations` */ }
        // Pipeline turn bookkeeping (fresh block budget) + the one nag that must
        // repeat: edits from an earlier turn still unverified.
        if (evt.session_id && pipelineEnabled()) {
          const st = onPrompt(loadPipelineState(evt.session_id));
          savePipelineState(evt.session_id, st);
          if (!st.verifyAfterEdit || st.obligations.some((item) => item.status !== "satisfied")) {
            parts.push(unverifiedNag(st));
          }
        }
        if (!parts.length) return;
        emitContext(provider, "UserPromptSubmit", parts.join("\n\n"));
        return;
      }
      if (evt.hook_event_name === "PreCompact") {
        // Compaction is about to summarize injected grounding out of the agent's
        // context while the dedup map still says "delivered". Reset it so every
        // post-compact injection is full again. Emit nothing — this event has no
        // context channel worth spending.
        resetSessionInjections(evt.session_id);
        return;
      }
      if (evt.hook_event_name === "SubagentStart") {
        // A delegated agent starts with NONE of the parent session's grounding:
        // session orientation never fired inside it and only per-edit PreToolUse
        // follows it in — so read-only agents (Explore/Plan) could work fully
        // blind. Slice by what the agent TYPE is about to do (dec_a788cc039b):
        // explorers get the indexed shape, planners get live decisions + what
        // was already rejected, everyone else gets the invariant digest. Public
        // store only; cheap reads.
        const routedCwd = nativeHookCwd(root, provider, evt);
        // A native host that supplied cwd made an explicit scope claim. If it is
        // malformed or names another checkout, serving this process root's memory
        // would cross worktrees; stay silent instead of guessing which side is right.
        if ((provider === "claude" || provider === "codex") && evt.cwd !== undefined && !routedCwd) return;
        // The prompt's baseline is the session's, not this agent's: without its
        // own, a first tool call that is a shell write would go ungrounded.
        // Without an agent id the key would be the SESSION's baseline, and
        // refreshing it here could swallow a parent write not yet grounded.
        if (evt.agent_id) refreshShellBaseline(root, evt.session_id, evt.agent_id);
        const s = new HunchStore(paths);
        try {
          const clip1 = (text: string, max: number): string => {
            const flat = text.replace(/\s+/g, " ").trim();
            return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
          };
          const type = (evt.agent_type ?? "").toLowerCase();
          // A role whose tool list leaves out Hunch's MCP tools is not told to call them.
          const tools = roleHasHunchTools(root, evt.agent_type ?? "");
          const L: string[] = [];
          const served: Array<{ kind: string; record_id: string; token_cost: number }> = [];
          const route = routedCwd && tools
            ? `Worktree routing: call hunch_context first with cwd: ${JSON.stringify(routedCwd)}, and pass the same cwd to hunch_task, hunch_report, and every Hunch capture/write call in this delegated task.`
            : null;
          const activeProvider = provider;
          const emitRouteOnly = (): void => { if (route) emitContext(activeProvider, "SubagentStart", route); };
          if (/explore|search|investigat/.test(type)) {
            // Orient from the graph, not grep rounds: the component map IS the shape.
            const components = s.advisoryRecs("components").filter((c) => c.status === "active");
            if (!components.length) { emitRouteOnly(); return; }
            L.push(`🧠 Hunch — repo shape for a delegated explorer: ${components.length} component(s).`);
            for (const c of components.slice(0, 12)) {
              const line = `- ${c.name}${c.paths.length ? ` (${c.paths.slice(0, 2).join(", ")})` : ""}${c.responsibility ? ` — ${clip1(c.responsibility, 90)}` : ""}`;
              L.push(line);
              served.push({ kind: "components", record_id: c.id, token_cost: Math.ceil([...line].length / 4) });
            }
            if (components.length > 12) L.push(`…and ${components.length - 12} more${tools ? " — hunch_structure() for the full map" : ""}.`);
            if (tools) L.push("Orient: hunch_structure(target) · hunch_why(target) · hunch_context(task).");
          } else if (/plan|architect|design/.test(type)) {
            // A plan drafted blind re-proposes what the graph already rejected.
            const decisions = s.advisoryRecs("decisions")
              .filter((d) => d.status === "accepted")
              .sort((a, b) => (a.date < b.date ? 1 : -1));
            if (!decisions.length) { emitRouteOnly(); return; }
            L.push(`🧠 Hunch — live decisions for a delegated planner (${decisions.length} in force; plans must not re-propose the rejected).`);
            for (const d of decisions.slice(0, 6)) {
              const line = `- ${d.title} (${d.id})${d.alternatives_rejected.length ? ` — rejected: ${clip1(d.alternatives_rejected[0]!, 80)}` : ""}`;
              L.push(line);
              served.push({ kind: "decisions", record_id: d.id, token_cost: Math.ceil([...line].length / 4) });
            }
            if (tools) L.push("Before finalizing a plan: hunch_why(target) · hunch_current_decision(topic) · hunch_check_constraints(scope).");
          } else {
            const sevRank = { blocking: 0, warning: 1, advisory: 2 } as const;
            const constraints = s.advisoryRecs("constraints")
              .filter((c) => c.status === "active")
              .sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
            if (!constraints.length) { emitRouteOnly(); return; }
            L.push(`🧠 Hunch — delegated agent grounding: ${constraints.length} invariant(s) in force in this repo.`);
            for (const c of constraints.slice(0, 8)) {
              const line = `- [${c.severity}] ${clip1(c.statement, 140)}${c.scope.length ? ` (scope: ${c.scope.slice(0, 3).join(", ")})` : ""}`;
              L.push(line);
              served.push({ kind: "constraints", record_id: c.id, token_cost: Math.ceil([...line].length / 4) });
            }
            if (constraints.length > 8) L.push(`…and ${constraints.length - 8} more${tools ? " — hunch_check_constraints(scope) for your files" : "; the edit hook shows the ones your files touch"}.`);
            if (tools) L.push("Before editing: hunch_check_constraints(scope) · hunch_why(target). Orient: hunch_context(task).");
          }
          if (route) L.push(route);
          // No dedup here: the hook event carries the PARENT session id, but each
          // spawned agent is a fresh empty context — deduping would ground the
          // first Explore and silently starve every later one.
          recordServed(root, served.map((r, index) => ({
            ...r,
            event: "served",
            target: `(subagent:${evt.agent_type ?? "any"})`,
            session_id: evt.session_id,
            rank: index + 1,
            delivery_reason: "ranked",
            provenance_status: "unverified",
          })));
          emitContext(provider, "SubagentStart", L.join("\n"));
        } finally {
          s.close();
        }
        return;
      }
      if (evt.hook_event_name === "SessionStart") {
        // A compact-resume (or a cleared context that keeps its session id) means
        // everything injected so far is gone — the dedup map must forget it
        // delivered anything, or the rest of the session gets delta one-liners
        // against grounding and task rules the agent no longer has.
        if (evt.source === "compact" || evt.source === "clear") resetSessionInjections(evt.session_id);
        // Orientation at the moment it matters: what just happened + what's next,
        // straight from the graph — the agent sits down already knowing where it
        // is instead of pulling (or worse, grepping) for it. Cheap reads only
        // (no reindex, no drift walk); public store only — session transcripts
        // travel further than a terminal. Union view: `hunch now --private`.
        let controllerBrief = "";
        if (evt.session_id && pipelineEnabled()) {
          const state = armExecutionObligations(
            loadPipelineState(evt.session_id),
            [
              ...compileExecutableProbes(environmentExecutableProbes()),
              ...environmentExecutionObligations(),
            ],
            { replaceOrigin: "episode" },
          );
          savePipelineState(evt.session_id, state);
          controllerBrief = executionObligationBrief(state);
        }
        const s = new HunchStore(paths);
        try {
          // Mode-aware: in unified ("shared") mode the public `.hunch/` is only a routing
          // shell, so loading it alone makes session-start orientation — recent work,
          // roadmap, escalations — report an empty graph for a repo whose memory is all
          // in the overlay. Private mode stays public-only: session transcripts travel
          // further than a terminal.
          const decisions = s.advisoryRecs("decisions");
          const { pendingReview } = nowData(decisions, 3);
          // Escalations are task-scoped (dec_12ba37db1c): session start has no task
          // yet, so it asks nothing when the provider delivers prompts — the prompt
          // hook asks about the ones a prompt touches; every entry stays pending in
          // `hunch escalations`. A provider with no prompt event would never ask,
          // so its orientation event keeps asking every actionable entry.
          const actionableEsc = deliversPromptEvent(provider) ? [] : (await actionableEscalationsWithAnchors(paths.root, s)).actionable;
          if (!decisions.length && !actionableEsc.length) {
            // A fresh graph with nothing to raise has nothing to orient on, but the
            // operating loop is still delivered. A queued commit-repair escalation
            // (checked against the full store) is enough reason NOT to bail here
            // even when the visible decisions list is empty.
            if (pipelineEnabled()) emitContext(provider, "SessionStart", [PIPELINE_LOOP, controllerBrief].filter(Boolean).join("\n\n"));
            return;
          }
          const L: string[] = [];
          L.push(`🧠 Hunch orientation — ${decisions.length} decision(s) in the graph.`);
          if (pendingReview > 0) L.push(`${pendingReview} legacy un-vouched draft(s) — adopt as advisory memory with \`hunch adopt-drafts\` (new captures auto-trust).`);
          if (actionableEsc.length) {
            L.push(`⚖ ${actionableEsc.length} decision(s) need YOUR call — ASK the user inline (don't queue): ${actionableEsc.map((e) => e.question).join(" · ")}`);
          }
          L.push("Orient further: hunch_context(task) · hunch_structure() · `hunch now`.");
          // The operating loop rides session start — guaranteed delivery, once
          // (the zod bench showed ambient skills are read in ~0% of sessions).
          if (pipelineEnabled()) L.push("", PIPELINE_LOOP);
          if (controllerBrief) L.push("", controllerBrief);
          const orientation = L.join("\n");
          // Antigravity's nearest equivalent is PreInvocation, which can fire
          // repeatedly in one conversation. Deduplicate it just like edit
          // grounding so it remains an orientation, not a context flood.
          if (provider === "antigravity" && injectionMode(evt.session_id, "orientation", orientation) === "delta") return;
          emitContext(provider, "SessionStart", orientation);
        } finally {
          s.close();
        }
        return;
      }
      if (evt.hook_event_name !== "PreToolUse") return;

      // A shell command's writes are measured from its own start: a file written
      // before it (a parallel tool call, another process, a host that skipped the
      // last PostToolUse) is not this command's to be blamed for.
      if (evt.tool_name === "Bash" || evt.tool_name === "PowerShell") {
        refreshShellBaseline(root, evt.session_id, evt.agent_id);
        return;
      }

      const targets = editTargets(root, evt.tool_input);
      // Nothing inside the repo → nothing for Hunch to say, except for a file in a
      // linked worktree of this repository Hunch could not ground (never silently).
      if (!targets.length) {
        if (routed.ungrounded) emitContext(provider, "PreToolUse", routed.ungrounded);
        return;
      }
      // Grounding below stays about the first in-repo file; the strict gate checks every target.
      const { abs, target } = targets[0]!;

      // A compiled red→green probe is only meaningful if its red receipt exists
      // before implementation. Firm/strict may deny two edits per prompt, then
      // fail open so a malformed or unavailable probe can never deadlock work.
      if ((firmness === "firm" || firmness === "strict") && evt.session_id && pipelineEnabled() && targets.some((t) => isProductPath(t.target))) {
        const baseline = beforeEditProbeVerdict(loadPipelineState(evt.session_id), { commandOutcomes: deliversCommandOutcome(provider) });
        // Unverifiable on this host: the edit proceeds and the hook says why on
        // stderr (stdout stays free for the grounding/deny response below).
        if (baseline.unverifiable && baseline.reason) process.stderr.write(`${baseline.reason}\n`);
        if (baseline.block) {
          savePipelineState(evt.session_id, baseline.state);
          emitDeny(provider, baseline.reason ?? "Hunch evidence gate — establish the pre-edit probe baseline first.");
          return;
        }
      }

      // Pre-edit grounding must resolve the same advertised graph as every CLI
      // and MCP consumer. Any unavailable/mismatched team route falls through to
      // the outer fail-open catch: one "grounding unavailable" line, never a deny,
      // never grounding from public/stale memory (dec_77d99014e0).
      const opened = openTeamStore(root, { requireFreshTeamMemory: firmness === "strict" });
      store = opened.store;
      if (firmness === "strict" && opened.teamPullStatus && !teamPullIsFresh(opened.teamPullStatus)) {
        // A strict deny is only trustworthy when it includes the latest team
        // rules. Offline/busy/unconfigured team memory is unavailable, so the
        // non-blocking hook says so instead of denying from stale state.
        emitContext(provider, "PreToolUse", `Hunch grounding unavailable for this edit; it proceeds ungrounded (team memory is ${opened.teamPullStatus}; strict mode never denies from stale rules). Run \`hunch doctor\`.`);
        return;
      }

      // strict: refuse an edit that hits a BLOCKING invariant (direct OR via blast
      // radius), feeding the invariant statement back as the refusal reason. Reindex
      // first so the blast radius reflects uncommitted edges — strict opts into the
      // cost for correctness. Advisory/firm skip it: the hook fires on every edit,
      // and decisions/constraints don't change between commits, so the committed
      // index is good enough for grounding.
      if (firmness === "strict") {
        store.reindex();
        // The lines this edit would ADD — so a content-matched invariant denies only
        // when the edit actually trips it (not on every edit in scope), and the Veto
        // Guard can test the proposed text. Covers Edit/Write/MultiEdit, and each
        // file of a Codex apply_patch with that file's own added lines.
        const denials: Array<{ target: string; hit: BlockingHit }> = [];
        for (const t of targets) {
          // Veto Guard (live): the proposed edit text re-introduces an approach an
          // in-force decision REJECTED. The agent self-corrects before staging;
          // only human-confirmed tripwires deny.
          const hit = blockingInScope(store, t.target, t.lines) ?? (t.lines.length ? vetoInScope(store, t.target, t.lines) : null);
          if (hit) denials.push({ target: t.target, hit });
        }
        if (denials.length) {
          for (const d of denials) appendEvent(paths, { at: new Date().toISOString(), file: d.target, ...d.hit.event });
          // One denied file keeps the single-file reason verbatim; several are
          // listed so the agent knows every file it must reconsider.
          const reason = denials.length === 1
            ? denials[0]!.hit.reason
            : `Hunch: this patch is denied for ${denials.length} files (${denials.map((d) => d.target).join(", ")}).\n${denials.map((d) => d.hit.reason).join("\n")}`;
          emitDeny(provider, reason);
          for (const d of denials) observeHookDenial(processRoot, provider, evt, d.target, d.hit);
          return;
        }
      }

      // advisory / firm / strict(non-blocking): inject the relevant Hunch slice.
      const grounded = fileGrounding(root, store, provider, evt, target, abs, processRoot);
      if (!grounded) return; // no noise on files Hunch hasn't learned yet
      emitContext(provider, "PreToolUse", grounded.text, grounded.mode === "full" ? grounded.recalled ?? undefined : undefined);
    } catch (e) {
      // Never block an edit on a hook failure — and never go silent either: an
      // ungrounded edit that looks grounded gets diagnosed as model flakiness.
      // One context line, exit 0 (the launcher itself failing stays out of reach).
      const reason = e instanceof Error ? e.message.split("\n")[0] : "unknown error";
      if (provider && (eventName === "PreToolUse" || eventName === "SessionStart" || eventName === "UserPromptSubmit")) {
        const what = eventName === "PreToolUse" ? "for this edit; it proceeds ungrounded" : "for this session";
        try { emitContext(provider, eventName, `Hunch grounding unavailable ${what} (${reason}). Run \`hunch doctor\`.`); } catch { /* stdout gone */ }
      }
    } finally {
      store?.close();
    }
}

// --- agent-hook helpers (used by `hunch hook`) -----------------------------

/** Read all of stdin (the hook event JSON). A TTY (no piped input) resolves to ""
 *  so an accidental interactive `hunch hook` exits cleanly instead of hanging. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** Absolute edit path → repo-relative, forward-slash (constraint scopes are
 *  forward-slash globs even on Windows). Returns "" when the path isn't resolvably
 *  inside `root`. A thin adapter over the shared `repoRelativeTarget` in core/paths.ts,
 *  which realpath-normalizes both ends but passes an unresolvable absolute path through
 *  unchanged; this converts that "still absolute" result into "", the sentinel that
 *  `onEdit` and `editTargets` treat as "skip, not in this repo". */
function toRepoRel(root: string, abs: string): string {
  const rel = repoRelativeTarget(abs, root);
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return "";
  return rel;
}

/** The repository root a hook event belongs to. Normally the process root, but an
 *  edit to a file in another LINKED worktree of the same repository (or a subagent
 *  started in one) belongs to that worktree's memory: grounded against the process
 *  root it was dropped as "outside the repo", with no output at all. Re-roots only
 *  to a worktree sharing this repository's git common dir that carries its own
 *  .hunch/; one without it is reported as ungrounded rather than skipped silently.
 *  Checkouts are told apart by their `.git` entry, never by a .hunch/ hit, so a
 *  nested package .hunch/ inside this checkout (a monorepo) never displaces the
 *  process root and its blocking constraints. Git is spawned only for a file in a
 *  different checkout than the process root's. */
function hookEventRoot(processRoot: string, evt: HunchHookInput): { root: string; ungrounded?: string } {
  const toolEvent = evt.hook_event_name === "PreToolUse" || evt.hook_event_name === "PostToolUse" || evt.hook_event_name === "PostToolUseFailure";
  const subject = evt.hook_event_name === "SubagentStart" ? evt.cwd
    : toolEvent ? (evt.tool_input?.patch_files?.[0]?.path ?? evt.tool_input?.file_path) : undefined;
  if (!subject || !isAbsolute(subject)) return { root: processRoot };
  try {
    const ownerTop = checkoutTop(evt.hook_event_name === "SubagentStart" ? subject : dirname(subject));
    const processTop = checkoutTop(processRoot);
    if (!ownerTop || !processTop || sameFilesystemEntry(ownerTop, processTop)) return { root: processRoot };
    const common = checkoutCommonDir(processRoot);
    const ownerCommon = common ? checkoutCommonDir(ownerTop) : "";
    if (!common || !ownerCommon || !sameFilesystemEntry(common, ownerCommon)) return { root: processRoot };
    // The same Hunch root inside the other worktree: its top, or the package dir a
    // subdirectory-rooted process uses.
    const owner = join(ownerTop, relative(processTop, processRoot));
    if (isDir(join(owner, ".hunch"))) return { root: owner };
    return { root: processRoot, ungrounded: `Hunch: ${toPosixTarget(subject)} is in linked worktree ${toPosixTarget(ownerTop)}, which has no .hunch/ — this edit proceeds ungrounded.` };
  } catch {
    return { root: processRoot };
  }
}

/** The nearest directory at or above `start` holding a `.git` entry (a checkout's top;
 *  a linked worktree's `.git` is a file), or "" outside every checkout. Pure fs. */
function checkoutTop(start: string): string {
  let cur = resolve(start);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return "";
    cur = parent;
  }
}

/** Files a shell command wrote get the grounding the edit tools would have
 *  delivered before the edit — late, but while the agent can still revise.
 *  Already-served grounding (a delta) is not repeated. */
const MAX_SHELL_GROUNDED = 3;
function shellWriteGrounding(root: string, store: HunchStore, provider: HookProvider, evt: HunchHookInput, written: readonly string[], ledgerRoot = root): string {
  const parts: string[] = [];
  const grounded: string[] = [];
  for (const target of written.slice(0, MAX_SHELL_GROUNDED)) {
    const g = fileGrounding(root, store, provider, evt, target, join(root, target), ledgerRoot);
    if (g?.mode === "full") { parts.push(g.text); grounded.push(target); }
  }
  if (!parts.length) return "";
  const more = written.length > MAX_SHELL_GROUNDED ? ` (${written.length - MAX_SHELL_GROUNDED} more written file(s) not checked)` : "";
  const sibling = parts.some((p) => p.startsWith(SIBLING_HEADING)) ? " It starts with a fix a same-shaped function elsewhere received and this file's copy never did: resolve it before you finish." : "";
  return `Hunch: this shell command wrote ${grounded.join(", ")}${more}. Edits made outside the Edit/Write tools skip the pre-edit grounding, so it arrives now: re-check the change against it before relying on it.${sibling}\n\n${parts.join("\n\n")}`;
}

/** Score the store against this prompt once per task (taskSelection.ts) and keep
 *  the selected ids — never the prompt — for the task's file grounding. Returns
 *  the short prompt-time list, or "" when nothing clears the threshold (silence).
 *  A follow-up prompt widens the qualifying set rather than replacing it, so a
 *  "go" cannot unselect the task's memory. */
const TASK_SELECTION_TITLE_CHARS = 80;
/** Every actionable escalation plus each entry id's anchor paths (a decision's
 *  related_files, a policy's scope paths/globs). Titles come from the advisory
 *  scope (public-only in private mode: session transcripts travel further than
 *  a terminal); commit-repair liveness and the anchors read the full store, so a
 *  private decision's repair stays answerable by id. */
async function actionableEscalationsWithAnchors(root: string, store: HunchStore): Promise<{ actionable: Escalation[]; anchors: Map<string, readonly string[]> }> {
  const decisions = store.advisoryRecs("decisions");
  const all = store.recs("decisions");
  const anchors = new Map<string, readonly string[]>(all.map((d) => [d.id, d.related_files] as const));
  const escalations = pendingEscalations(decisions);
  escalations.push(...premiseEscalations(decisions, { now: new Date().toISOString(), exists: (p) => existsSync(join(root, p)) }));
  const queue = readActivePendingRepairs(root);
  escalations.push(...commitRepairEscalations(queue, decisions, all, withheldRewrites(root, queue)));
  try {
    // Constitution human moments ride the same line; a broken policy store must
    // never take the hook down (fail open). Public store only.
    const { ConstitutionService: CS } = await import("../constitution/service.js");
    const policies = new CS(store, root).list({ publicOnly: true });
    for (const p of policies) anchors.set(p.id, p.scope.paths);
    escalations.push(...policyEscalations(policies.map((p) => ({ ...p, last_action: p.audit.at(-1)?.action ?? null }))));
  } catch { /* constitution unavailable */ }
  // Only ACTIONABLE entries are worth asking inline — a duplicate-id commit-repair
  // follower whose resolution says "act on a different entry first" isn't a
  // question the assistant can put to the human directly (#61).
  return { actionable: actionableEscalations(escalations), anchors };
}

/** The ASK line for the escalations one prompt touches, or "" (dec_12ba37db1c). */
async function promptEscalations(root: string, store: HunchStore, provider: HookProvider, evt: HunchHookInput): Promise<string> {
  if (!evt.prompt || isNotificationPrompt(evt.prompt)) return "";
  const { actionable, anchors } = await actionableEscalationsWithAnchors(root, store);
  if (!actionable.length) return "";
  // A qualifying record outside the top-K is still part of this task.
  const selection = loadTaskSelection(hookReportTaskId(root, provider, evt));
  const selectedIds = new Set([...(selection?.top ?? []), ...(selection?.qualifying ?? [])]);
  const relevant = relevantEscalations(actionable, { prompt: evt.prompt, paths: promptPaths(evt.prompt, root), selectedIds }, (id) => anchors.get(id) ?? []);
  // Each question is asked once per session, however the touched set changes.
  const unasked = relevant.filter((e) => injectionMode(evt.session_id, `prompt-escalation:${e.kind}:${e.topic}:${e.decisionIds.join(",")}`, e.question) === "full");
  if (!unasked.length) return "";
  return `⚖ ${unasked.length} decision(s) this task touches need the human's call — ASK the user inline, never decide for them: ${unasked.map((e) => e.question).join(" · ")}`;
}

function promptTaskSelection(root: string, store: HunchStore, provider: HookProvider, evt: HunchHookInput): string {
  // A host notification is not a task prompt: the earlier selection stands untouched.
  if (!taskSelectionEnabled() || isNotificationPrompt(evt.prompt)) return "";
  const taskId = hookReportTaskId(root, provider, evt);
  if (!taskId) return "";
  // Host-injected blocks (reminders, browser instructions) are not the task the human named.
  const humanText = stripHostBlocks(evt.prompt ?? "");
  const selection = selectForTask(liveSelectionRecords({
    decisions: store.recs("decisions"),
    bugs: store.recs("bugs"),
    constraints: store.recs("constraints"),
    findings: store.recs("findings"),
  }), humanText, { root, pathExists: (p) => existsSync(join(root, p)) });
  // Same task id again (a notification alias) keeps its own earlier selection; a
  // new task that CONTINUES the session's previous one inherits that task's
  // selection only on a bare follow-up ("continue", "go on"), so it is not left
  // ungrounded. A substantive prompt names its own task: a same-session prompt
  // inside the continuation window must not hide memory behind an old selection.
  let previous = loadTaskSelection(taskId);
  if (!previous && isBareFollowUp(humanText)) {
    try {
      const continues = readTaskReport(root, taskId).task.continues;
      previous = continues ? loadTaskSelection(continues) : null;
    } catch { /* no continuity; the prompt's own selection stands */ }
  }
  const qualifying = [...new Set([...(previous?.qualifying ?? []), ...selection.qualifying])];
  // An empty selection is no selection: the task keeps the unfiltered grounding.
  // Emptiness counts only the kinds grounding filters (decisions, bugs,
  // findings): constraints always pass, so a constraint-only set would hide every
  // other record anchored to the file. The prompt-time list may still print.
  if (!qualifying.some(isFilterableSelectionId)) {
    clearTaskSelection(taskId);
  } else {
    saveTaskSelection({
      task_id: taskId,
      qualifying,
      top: selection.qualifying.length ? selection.top.map((item) => item.id) : previous?.top ?? [],
    });
  }
  // An inherited selection was listed when its own prompt ran: not again.
  if (!selection.top.length) return "";
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > TASK_SELECTION_TITLE_CHARS ? `${flat.slice(0, TASK_SELECTION_TITLE_CHARS - 1).trimEnd()}…` : flat;
  };
  return `Hunch memory for this task: ${selection.top.map((item) => `${item.id} — ${clip(item.title)}`).join(" · ")} (hunch_why(id) for detail)`;
}

type FileGrounding = { mode: "delta"; text: string } | { mode: "full"; text: string; recalled: string | null };
/** Memory budget beside a sibling lesson (the default is 1500 tokens). */
const SIBLING_MEMORY_BUDGET_TOKENS = 800;

/** The advisory grounding for one repo-relative file: the ranked memory slice,
 *  retired code, doc anchors, recent tasks and sibling-fix lessons. `delta` when
 *  identical grounding was already served this session, null when Hunch knows
 *  nothing about the file. Serves the pre-edit hook and files a shell command
 *  wrote (which never pass through the edit tools). `ledgerRoot` is where the prompt's
 *  task lives — the process root when the event was re-rooted to a linked worktree. */
function fileGrounding(root: string, store: HunchStore, provider: HookProvider, evt: HunchHookInput, target: string, abs: string, ledgerRoot = root): FileGrounding | null {
  // Decision-grounding for PROSE (doc≠graph): a markdown target that declares
  // <!-- hunch:topic … --> anchors gets each topic's CURRENT decision — the
  // graph outranks the prose being edited, and a stale pin is called out inline.
  let docGround = "";
  if (/\.(md|mdx)$/i.test(target)) {
    try {
      docGround = renderDocGrounding(parseDocAnchors(readFileSync(abs, "utf8")), store.recs("decisions"));
    } catch { /* unreadable / not yet created — no doc grounding */ }
  }
  // A task whose prompt was scored (promptTaskSelection) gets the file's
  // decisions, bugs and findings conditioned on it. Constraints always pass (any
  // severity): they are scoped rules, including agent-recorded corrections capped
  // at warning, not relevance guesses. No selection (a host without a prompt
  // hook, a legacy session, a prompt that selected nothing) keeps the unfiltered
  // grounding.
  const selection = loadTaskSelection(hookReportTaskId(ledgerRoot, provider, evt));
  const assembled = store.assembleContext(target);
  const selected = selection ? new Set(selection.qualifying) : null;
  const ctx = selected ? {
    ...assembled,
    decisions: assembled.decisions.filter((d) => selected.has(d.id)),
    bugs: assembled.bugs.filter((b) => selected.has(b.id)),
    findings: assembled.findings.filter((f) => selected.has(f.id)),
  } : assembled;
  // Sibling fixes: a same-shaped function elsewhere was fixed and this copy
  // never was — the concrete lesson a scoped constraint cannot carry.
  const siblings = siblingGrounding(root, target, store.recs("symbols"),
    ctx.constraints.filter((c) => c.severity === "blocking" && c.scope.some((g) => pathMatchesGlob(target, g))).map((c) => ({ id: c.id, statement: c.statement })),
    { cacheOnly: true });
  // Remember what was delivered, so the first check the agent runs can follow
  // up if the function is still untouched (pipeline.ts lessonReminder).
  if (siblings.lessons.length && evt.session_id && pipelineEnabled()) {
    try {
      savePipelineState(evt.session_id, onLessonsDelivered(loadPipelineState(evt.session_id), siblings.lessons.map((l) => ({
        id: `${l.file}:${l.symbol}~${l.siblingFile}:${l.sibling}`,
        file: l.file,
        symbol: l.symbol,
        sibling: l.sibling,
        siblingFile: l.siblingFile,
        change: l.commits.map((c) => `${c.sha.slice(0, 8)} ${c.subject}`).join("; "),
        callers: [...(siblings.callers.get(l.symbol) ?? [])],
        hash: functionBodyHash(root, l.file, l.symbol),
      }))));
    } catch { /* the reminder is a convenience; the lesson itself was delivered */ }
  }
  // Regression Guard (edit-time grounding): what an in-force decision retired
  // from this file. No diff exists yet, so this is context — "don't re-add X" —
  // not a block; the commit-time `hunch check` does the actual gating.
  const retired = store.retiredForFile(target).filter((r) => r.symbols.length || r.deps.length);
  // Recent-task history is advisory; under a task selection it is dropped
  // (`hunch task list` still has it).
  const recentTasks = selected ? [] : taskSelectionSupplements(store.selectTasksAuto(target, buildTaskRankingQuery(ledgerRoot, hookReportTaskId(ledgerRoot, provider, evt), target, { excludeTargetDeliveries: true })), target);
  const hasContent =
    ctx.constraints.length ||
    ctx.decisions.length ||
    ctx.bugs.length ||
    ctx.blast_radius.length ||
    ctx.findings.length ||
    ctx.landscape?.resources.length ||
    ctx.landscape?.relationships.length ||
    retired.length ||
    recentTasks.length ||
    docGround ||
    siblings.text;
  if (!hasContent) return null;
  const supplements = [
    ...(retired.length ? [{
      id: "retired-code",
      kind: "retired-code",
      priority: 200,
      text: `⚠ Deliberately RETIRED from this file — do not re-introduce without cause: ${retired.map((r) => `${[...r.symbols, ...r.deps].join(", ")} (${r.decision})`).join("; ")}.`,
    }] : []),
    ...(docGround ? [{ id: "doc-grounding", kind: "doc-grounding", priority: 100, text: docGround }] : []),
    ...recentTasks,
  ];
  // A sibling lesson is the most specific thing Hunch knows about this edit:
  // it leads, and the ranked memory gets a smaller budget so it cannot bury it.
  const envelope = buildDeliveryEnvelope(siblings.text ? { ...ctx, budget_tokens: Math.min(ctx.budget_tokens, SIBLING_MEMORY_BUDGET_TOKENS) } : ctx, {
    profile: "builder",
    root,
    symbols: store.recs("symbols"),
    components: store.recs("components"),
    decisionCorpus: store.recs("decisions"),
    supplements,
    ...(selected ? { taskSelected: selected } : {}),
  });
  // Outside the envelope's budget on purpose: the lesson is a code change, not a
  // one-line supplement, and memory records must not crowd it out.
  const text = [siblings.text, envelope.text.trim()].filter(Boolean).join("\n\n");
  // Identical grounding already shown this session → one-line delta instead of
  // the full 10-16KB block. Any record change re-sends the full text; the
  // strict-gate deny path above never routes through this (dec_244397d920).
  // Delivery receipts (dec_925f4bcaad): the ledger of what actually reached
  // an agent. A full injection is a serve; a delta one-liner attests the
  // earlier serve is still standing. Never throws, never blocks.
  const receipts = (event: "served" | "refreshed") => recordServed(root, [
    ...envelope.delivered.map((item) => ({
      event,
      kind: item.kind,
      record_id: item.record_id,
      target,
      session_id: evt.session_id,
      rank: item.rank,
      delivery_reason: item.delivery_reason,
      provenance_status: item.provenance_status,
      token_cost: item.token_cost,
      delivery_profile: envelope.profile,
      ranking_policy: envelope.ranking_policy,
    })),
    // Delivered task lines are receipts too: they feed access-based recency.
    ...envelope.supplements.filter((s) => s.kind === "recent-task" && s.delivered).map((s) => ({
      event, kind: "tasks", record_id: s.id, target, session_id: evt.session_id,
      rank: s.rank, delivery_reason: "supplemental", token_cost: s.token_cost,
      delivery_profile: envelope.profile, ranking_policy: envelope.ranking_policy,
    })),
  ]);
  const reportTaskId = hookReportTaskId(ledgerRoot, provider, evt);
  // A new authoritative prompt gets its own full delivery. An earlier
  // prompt's session-level delta cannot establish this task's receipt.
  // A subagent reports to the prompt's task but starts with FRESH context:
  // it never saw that grounding, so its dedup is scoped by its own agent
  // identity (hashed — the raw agent_id is never retained in the key).
  const agentKey = evt.agent_id ? `:${reportHash(evt.agent_id).slice(7, 19)}` : "";
  // Dedup on the envelope's stable IDENTITY projection, never on the
  // rendered block: serving the full text writes delivery receipts, and the
  // next call's task ranking reads them back and moves the wording ("today"
  // → "delivered today"), so hashing the presentation made this grounding
  // self-invalidating and re-sent the full block for unchanged records.
  if (injectionMode(evt.session_id, `pre:${target}${reportTaskId ? `:${reportTaskId}` : ""}${agentKey}`, text, deliveryDedupeInput(envelope, supplements) + (siblings.identity ? `\u0000sibling-fix\u0000${siblings.identity}` : "")) === "delta") {
    receipts("refreshed");
    return {
      mode: "delta",
      text: `Hunch grounding for ${target}: unchanged this session (${envelope.delivered.filter((item) => item.kind === "decisions").length} decision(s), ${envelope.delivered.filter((item) => item.kind === "constraints").length} invariant(s)${siblings.identity ? ", sibling-fix lesson" : ""} shown earlier — still current; hunch_why("${target}") to re-expand).`,
    };
  }
  receipts("served");
  let reportNotice = "";
  let recalled: string | null = null;
  if (reportTaskId) {
    try {
      const snapshots = snapshotDeliveredRecords(store, envelope);
      // The first time a lesson reaches this prompt's task, tell the USER in one
      // line (systemMessage); repeats of the same revision stay silent.
      recalled = reportPresentationEnabled(ledgerRoot) ? renderRecalledLine(unseenLessons(ledgerRoot, reportTaskId, snapshots)) : null;
      const occurrence = recordTaskDelivery(ledgerRoot, reportTaskId, envelope, snapshots, undefined, target);
      reportNotice = `\n\nHunch task ${reportTaskId} · delivery ${occurrence}. Inspect exact application references with hunch_report(task_id).`;
    } catch { reportNotice = "\n\nTask report observation unavailable; this delivery's task contribution remains unverified."; recalled = null; }
  }
  return { mode: "full", text: text + reportNotice, recalled };
}

/** The in-repo files a pre-edit event would change, each with the lines the edit
 *  ADDS to that file. A Codex apply_patch yields one entry per touched path (a
 *  Move-to destination is its own entry, carrying the section's added lines);
 *  every other edit tool yields its single `file_path`. Paths outside the repo
 *  ("..") or on another drive ("D:/…") are skipped. */
/** Host tools that write exactly the files named in their input. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function editTargets(root: string, input: HunchToolInput | undefined): Array<{ abs: string; target: string; lines: string[] }> {
  const raw = input?.patch_files?.length
    ? input.patch_files.flatMap((f) => (f.moved_to ? [f.path, f.moved_to] : [f.path]).map((abs) => ({ abs, lines: f.added_lines })))
    : input?.file_path ? [{ abs: input.file_path, lines: proposedEditLines(input) }] : [];
  const byTarget = new Map<string, { abs: string; target: string; lines: string[] }>();
  for (const { abs, lines } of raw) {
    const target = toRepoRel(root, abs);
    if (!target || target.startsWith("..") || /^[a-zA-Z]:/.test(target)) continue;
    const seen = byTarget.get(target);
    if (seen) seen.lines = [...seen.lines, ...lines];
    else byTarget.set(target, { abs, target, lines });
  }
  return [...byTarget.values()];
}

function emitContext(
  provider: HookProvider,
  event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "UserPromptSubmit" | "SessionStart" | "SubagentStart",
  text: string,
  /** One user-facing line where the host shows hook messages (Claude Code's
   * `systemMessage`); never a block, never a second model turn. */
  systemMessage?: string,
): void {
  if (event === "SessionStart") {
    const warning = integrationSessionWarning(findRoot(), provider);
    if (warning) text = `${warning}\n\n${text}`;
  }
  const output = contextHookOutput(provider, event, text);
  if (output) process.stdout.write(JSON.stringify(provider === "claude" && systemMessage ? { ...output, systemMessage } : output));
}
function emitDeny(provider: HookProvider, reason: string): void {
  const result = denyHookOutput(provider, reason);
  if (result.output) process.stdout.write(JSON.stringify(result.output));
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
}
function emitStop(provider: HookProvider, reason: string): void {
  process.stdout.write(JSON.stringify(stopHookOutput(provider, reason)));
}
