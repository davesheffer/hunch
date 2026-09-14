/** Native lifecycle coverage is independent of whether a model follows reporting
 * instructions. Only an authoritative prompt identity may join its evidence. */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { HookProvider, HunchHookInput } from "./agenthook.js";
import { findRoot } from "./paths.js";
import { isEmptyTaskReport, readTaskReport, recordReportRefusal, reportHash, reportPresentationEnabled, startReportTask } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";
import { renderTaskReport, writeTaskReportHtml } from "./taskReportRender.js";

/** The exact task identity a native host prompt maps to. */
export function promptTaskId(root: string, sessionId: string, promptId: string, agentId: string | null = null, provider: HookProvider = "claude"): string {
  return `htask_${reportHash([realpathSync(root), provider, sessionId, promptId, agentId]).slice(7, 31)}`;
}

/** Hosts whose hooks deliver a native per-prompt identity (Claude Code's
 * prompt_id, Codex's turn_id). Others get no task from a hook. */
const NATIVE_PROMPT_HOSTS: ReadonlySet<HookProvider> = new Set<HookProvider>(["claude", "codex"]);
const NATIVE_TASK_TITLE = "Assistant task";

/** Carry a hook-observed working directory into MCP only after proving it names
 * the same physical repository as the hook process. The canonical repository
 * root is stable across cwd subdirectories and safe to copy into a tool call. */
export function nativeHookCwd(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  if (!NATIVE_PROMPT_HOSTS.has(provider) || !event.cwd) return null;
  try {
    const physicalRoot = realpathSync(root);
    return realpathSync(findRoot(event.cwd)) === physicalRoot ? physicalRoot : null;
  } catch {
    return null;
  }
}

function identity(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  if (!nativeHookCwd(root, provider, event)) return null;
  for (const value of [event.session_id, event.prompt_id, event.agent_id]) {
    if (value !== undefined && (!value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))) return null;
  }
  if (!event.session_id) return null;
  if (!event.prompt_id) return "legacy";
  return promptTaskId(root, event.session_id, event.prompt_id, event.agent_id ?? null, provider);
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
  // Re-resolve after identity validation and fail closed if the filesystem
  // changed between the two reads; never emit a task instruction with cwd:null.
  const cwd = nativeHookCwd(root, provider, event);
  if (!cwd) return null;
  const cwdLiteral = JSON.stringify(cwd);
  let task: ReturnType<typeof startReportTask>;
  try { task = startReportTask(root, NATIVE_TASK_TITLE, id); }
  catch (error) {
    // A prompt may remain open while Hunch is upgraded from the release that
    // called every native task "Claude task". Preserve that exact persisted
    // identity/title; only newly opened tasks use the host-neutral name.
    const legacy = readTaskReport(root, id).task;
    if (legacy.title !== "Claude task") throw error;
    task = legacy;
  }
  return `Hunch has opened this prompt's report: ${task.task_id}. Reuse this exact ID for this prompt. Call hunch_task(action: "start", task_id: "${task.task_id}", title: "${task.title}", cwd: ${cwdLiteral}) to obtain verification_argv; do not create another report. Pass this task_id and cwd: ${cwdLiteral} to hunch_context and decision/correction/finding captures, and pass the same cwd when finishing with hunch_task before responding. A host Stop notice will show the evidence even if no task-linked memory was observed.`;
}

/** A presentation notice never denies Stop or injects another model turn. Stop
 * can precede another hook's continuation, so it does not close an open task.
 * A prompt with no observation at all prints nothing: the empty task row stays
 * in the ledger (hunch task list, the VS Code Contribution view) so "never
 * touched Hunch" remains countable without a five-line notice per prompt. */
export function stopHookReport(root: string, provider: HookProvider, event: HunchHookInput): { systemMessage: string } | null {
  if (!reportPresentationEnabled(root)) return null;
  const id = identity(root, provider, event);
  if (!id) return null;
  if (id === "legacy") return { systemMessage: "Hunch hook active. This host version does not provide an exact prompt identifier, so contribution for this response is unverified. Explicit task reports remain available with hunch report." };
  try {
    const report = readTaskReport(root, id, reportSourceSnapshot(root).hash);
    if (isEmptyTaskReport(report)) return null;
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
