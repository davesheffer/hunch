/** Native lifecycle coverage is independent of whether a model follows reporting
 * instructions. Only an authoritative prompt identity may join its evidence. */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { HookProvider, HunchHookInput } from "./agenthook.js";
import { findRoot } from "./paths.js";
import { readTaskReport, recordReportRefusal, reportHash, reportPresentationEnabled, startReportTask } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";
import { renderTaskReport, writeTaskReportHtml } from "./taskReportRender.js";

function identity(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  if (provider !== "claude" || !event.cwd || realpathSync(findRoot(event.cwd)) !== realpathSync(root)) return null;
  for (const value of [event.session_id, event.prompt_id, event.agent_id]) {
    if (value !== undefined && (!value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))) return null;
  }
  if (!event.session_id) return null;
  if (!event.prompt_id) return "legacy";
  return `htask_${reportHash([realpathSync(root), provider, event.session_id, event.prompt_id, event.agent_id ?? null]).slice(7, 31)}`;
}

export function hookReportTaskId(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  try {
    const id = identity(root, provider, event);
    return id === "legacy" ? null : id;
  } catch { return null; }
}

/** Every prompt receives its exact ID, even when ambient reminders were deduped.
 * No raw prompt, host session identifier, or transcript is retained. */
export function startHookReport(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  const id = identity(root, provider, event);
  if (!id || id === "legacy") return null;
  const task = startReportTask(root, "Claude task", id);
  return `Hunch has opened this prompt's report: ${task.task_id}. Reuse this exact ID for this prompt. Call hunch_task(action: "start", task_id: "${task.task_id}", title: "Claude task") to obtain verification_argv; do not create another report. Pass this task_id to hunch_context and decision/correction/finding captures, and finish with hunch_task before responding. A host Stop notice will show the evidence even if no task-linked memory was observed.`;
}

/** A presentation notice never denies Stop or injects another model turn. Stop
 * can precede another hook's continuation, so it does not close an open task. */
export function stopHookReport(root: string, provider: HookProvider, event: HunchHookInput): { systemMessage: string } | null {
  if (!reportPresentationEnabled(root)) return null;
  const id = identity(root, provider, event);
  if (!id) return null;
  if (id === "legacy") return { systemMessage: "Hunch hook active. This Claude version does not provide an exact prompt identifier, so contribution for this response is unverified. Explicit task reports remain available with hunch report." };
  try {
    const report = readTaskReport(root, id, reportSourceSnapshot(root).hash);
    let card = renderTaskReport(report);
    try {
      const file = writeTaskReportHtml(root, id);
      card = card.replace(/^Evidence .*$/m, `Evidence  ${pathToFileURL(file).href}`);
    } catch { /* exact CLI evidence link remains available */ }
    return { systemMessage: card };
  } catch {
    return { systemMessage: `Hunch report unavailable for ${id}. Contribution is unverified; inspect with hunch report ${id}.` };
  }
}

/** Call only after emitting the native denial. Evidence failures must never
 * suppress the gate response or attach it to a guessed task. */
export function observeHookDenial(root: string, provider: HookProvider, event: HunchHookInput, target: string, denial: { reason: string; event: { kind: "constraint" | "veto"; constraint?: string; decision?: string } }): void {
  try {
    const taskId = hookReportTaskId(root, provider, event);
    const recordId = denial.event.kind === "constraint" ? denial.event.constraint : denial.event.decision;
    if (!taskId || !recordId) return;
    recordReportRefusal(root, taskId, { source: "native-edit-gate", outcome: "denial-emitted", kind: denial.event.kind, record_id: recordId, target, reason_hash: reportHash(denial.reason) });
  } catch { /* the already emitted gate response remains authoritative */ }
}
