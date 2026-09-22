/** Native lifecycle coverage is independent of whether a model follows reporting
 * instructions. Only an authoritative prompt identity may join its evidence. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookProvider, HunchHookInput } from "./agenthook.js";
import { findRoot } from "./paths.js";
import { canonicalReportRoot } from "./taskReportPaths.js";
import { isCredentialFreeText } from "./types.js";
import { aliasReportTask, continuationLinks, finishReportTask, isEmptyTaskReport, latestSessionTask, readTaskReport, recordReportRefusal, reportHash, reportPresentationEnabled, reportTaskExists, resolveReportTask, settleSessionTasks, startReportTask, type TaskLinks } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";
import { renderTaskReport } from "./taskReportRender.js";
import { verificationLauncher } from "./verifyLauncher.js";

/** The exact task identity a native host prompt maps to. */
export function promptTaskId(root: string, sessionId: string, promptId: string, agentId: string | null = null, provider: HookProvider = "claude"): string {
  return `htask_${reportHash([canonicalReportRoot(root), provider, sessionId, promptId, agentId]).slice(7, 31)}`;
}

/** Hosts whose hooks deliver a native per-prompt identity (Claude Code's
 * prompt_id, Codex's turn_id). Others get no task from a hook. */
const NATIVE_PROMPT_HOSTS: ReadonlySet<HookProvider> = new Set<HookProvider>(["claude", "codex"]);

/** Hosts PROVEN to close a task they opened, so its evidence is shown without
 * the agent's cooperation and the finish call may be made conditional. A host
 * belongs here only when BOTH hold: (1) `hunch init` wires its stop event, and
 * (2) its stop payload carries the same native prompt identity the task was
 * opened under, so `closeHookTask` actually resolves that task and closes it.
 * (2) is what excludes a host with a stop hook but no native identity: outside
 * NATIVE_PROMPT_HOSTS `nativeHookCwd` returns null on Stop, so nothing is
 * closed and a skipped finish would leak an open task. Everywhere else finish
 * stays mandatory. Adding a host requires proving both, never its name. */
const HOST_CLOSES_TASK: ReadonlySet<HookProvider> = new Set<HookProvider>(["claude", "codex"]);
const NATIVE_TASK_TITLE = "Assistant task";
const GENERIC_TASK_TITLES: ReadonlySet<string> = new Set(["Assistant task", "Claude task"]);
const TASK_TITLE_MAX = 72;

/** Prompt-derived titles are OPT-IN (`"taskTitles": "prompt"` in .hunch/local.json).
 * The default keeps the documented guarantee that no prompt text is retained
 * anywhere: not in the ledger, the Stop card, the Contribution view, nor a graph
 * record that may be committed to a public repository. */
export function promptTitlesEnabled(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, ".hunch", "local.json"), "utf8")).taskTitles === "prompt"; }
  catch { return false; }
}

/** A short, safe task title from the prompt's first line: control characters
 * and runs of whitespace collapse, credential-looking text is refused, and the
 * result is cut at a word boundary. Null means "use the generic title". The
 * title is the only prompt-derived prose that reaches the ledger and, on
 * finish, the graph record. */
export function promptTaskTitle(prompt: string | undefined): string | null {
  if (typeof prompt !== "string") return null;
  const firstLine = prompt.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? "";
  const clean = firstLine.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 3 || !isCredentialFreeText(clean) || !isCredentialFreeText(prompt.slice(0, 4096))) return null;
  if (clean.length <= TASK_TITLE_MAX) return clean;
  const cut = clean.slice(0, TASK_TITLE_MAX);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > TASK_TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** Carry a hook-observed working directory into MCP only after proving it names
 * the same physical repository as the hook process. The canonical repository
 * root is stable across cwd subdirectories and safe to copy into a tool call. */
export function nativeHookCwd(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  if (!NATIVE_PROMPT_HOSTS.has(provider) || !event.cwd) return null;
  try {
    const physicalRoot = canonicalReportRoot(root);
    return canonicalReportRoot(findRoot(event.cwd)) === physicalRoot ? physicalRoot : null;
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
  const id = promptTaskId(root, event.session_id, event.prompt_id, event.agent_id ?? null, provider);
  // A notification turn reports to the task it continued (an explicit alias).
  try { return resolveReportTask(root, id); } catch { return id; }
}

export function hookReportTaskId(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  try {
    const id = identity(root, provider, event);
    if (!id || id === "legacy") return null;
    // A subagent's tool call carries the prompt's session and prompt identity
    // plus its own agent_id, and no prompt ever opens a task under that
    // identity (subagents never fire UserPromptSubmit): its deliveries and
    // denials belong to the prompt's task. An agent-scoped task that DOES
    // exist keeps its own evidence, and without a prompt task nothing is guessed.
    if (event.agent_id && event.session_id && event.prompt_id && !reportTaskExists(root, id)) {
      const parent = resolveReportTask(root, promptTaskId(root, event.session_id, event.prompt_id, null, provider));
      if (reportTaskExists(root, parent)) return parent;
    }
    return id;
  } catch { return null; }
}

/** Every prompt receives its exact ID, even when ambient reminders were deduped.
 * No raw prompt, host session identifier, or transcript is retained; a repository
 * that opts in (`taskTitles: "prompt"`) keeps only a bounded first-line title. */
export function startHookReport(root: string, provider: HookProvider, event: HunchHookInput): string | null {
  const id = identity(root, provider, event);
  if (!id || id === "legacy") return null;
  // Re-resolve after identity validation and fail closed if the filesystem
  // changed between the two reads; never emit a task instruction with cwd:null.
  const cwd = nativeHookCwd(root, provider, event);
  if (!cwd) return null;
  const cwdLiteral = JSON.stringify(cwd);
  const title = (promptTitlesEnabled(root) ? promptTaskTitle(event.prompt) : null) ?? NATIVE_TASK_TITLE;
  // Continuity: a prompt that follows another of the same session within the
  // window continues its task ("status", "next", "go" are the same work), and
  // the episode's graph record is written under the first task's id. The key
  // is a hash; the host session identifier itself is still never retained.
  let links: TaskLinks = {};
  const sessionKey = hookSessionKey(cwd, provider, event);
  if (sessionKey) {
    links = { session_key: sessionKey };
    try {
      const previous = latestSessionTask(root, sessionKey);
      // A host notification (a background command finished) is not new work:
      // it continues the session's latest task instead of opening an empty row,
      // unless the agent already closed that task for good. The alias makes
      // this prompt's Stop and hook observations report to that task.
      if (previous && previous.task_id !== id && isNotificationPrompt(event.prompt) && previous.closed_by !== "agent") {
        aliasReportTask(root, id, previous.task_id);
        return taskInstruction(previous, cwdLiteral, provider);
      }
      const continued = previous && previous.task_id !== id ? continuationLinks(previous) : null;
      if (continued) links = { ...links, ...continued };
    } catch { /* no continuity; still a task */ }
  }
  let task: ReturnType<typeof startReportTask>;
  try { task = startReportTask(root, title, id, links); }
  catch (error) {
    // The same prompt identity may already be open: a release that called every
    // native task "Claude task"/"Assistant task", or a second hook registration
    // for the same host. The persisted identity and title win; never a second task.
    const existing = readTaskReport(root, id).task;
    if (existing.title !== title && !GENERIC_TASK_TITLES.has(existing.title) && !GENERIC_TASK_TITLES.has(title)) throw error;
    task = existing;
  }
  return taskInstruction(task, cwdLiteral, provider);
}
/** The hook already opened the task, so the model needs no start call: the only
 * thing start used to supply was verification_argv, and the launcher is printed
 * inline here. Identical in substance for EVERY hook provider that reaches this
 * function; the one variation is capability-driven, never host-named — where the
 * host is not PROVEN to close the task it opened (HOST_CLOSES_TASK) nobody but the
 * next prompt's settle would close it, so finish stays mandatory there. Elsewhere
 * finish is CONDITIONAL: ~87 start/finish round trips a day mostly returned "No
 * task-linked delivery observed", and the host's Stop hook closes the task and
 * shows the evidence either way. FAILS OPEN (con_03a0b94b2e): if the launcher
 * cannot be computed, fall back to asking for the start call — that path is then
 * the only source of both the launcher and the finish instruction, so it carries
 * its own finish sentence. */
export function taskInstruction(task: { task_id: string; title: string }, cwdLiteral: string, provider: HookProvider, launcher: () => { shell: string; note?: string } = verificationLauncher): string {
  const head = `Hunch has already opened this prompt's report: ${task.task_id}. Reuse this exact ID; never open another report. Pass this task_id and cwd: ${cwdLiteral} to hunch_context and decision/correction/finding captures.`;
  let verify: string;
  try {
    const l = launcher();
    verify = ` Never call hunch_task start for it. For checks, run: ${l.shell} task verify ${task.task_id} -- <command> [arguments]${l.note ?? ""}. Default budget 15 min; add --timeout <seconds> before -- for longer suites.`;
  }
  catch { return `${head} Call hunch_task(action: "start", task_id: "${task.task_id}", title: ${JSON.stringify(task.title)}, cwd: ${cwdLiteral}) to obtain verification_argv, and finish with hunch_task(action: "finish", task_id, cwd) before responding and show its card.`; }
  const used = `this task used Hunch (a hunch_* call on this ID, a task verify check, Hunch hook context you acted on, or an application to claim)`;
  const finish = HOST_CLOSES_TASK.has(provider)
    ? ` ONLY if ${used}, call hunch_task(action: "finish", task_id, cwd) before responding and show its card; otherwise skip it — this host's stop hook closes the task and shows the evidence.`
    : ` No stop hook closes this task, so finish it yourself whether or not ${used}: call hunch_task(action: "finish", task_id, cwd) before responding and show its card.`;
  return `${head}${verify}${finish}`;
}
/** The session key a hook event maps to: a hash of (root, provider, session,
 * agent), never the identifier itself. Null without a host session. */
function hookSessionKey(cwd: string, provider: HookProvider, event: HunchHookInput): string | null {
  return event.session_id ? reportHash([cwd, provider, event.session_id, event.agent_id ?? null]) : null;
}
/** A prompt the host generated to report a background command's completion,
 * not something the user typed. */
export function isNotificationPrompt(prompt: string | undefined): boolean {
  if (typeof prompt !== "string") return false;
  const firstLine = prompt.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? "";
  return /^<task-notification>/i.test(firstLine);
}

/** Close, as host closes, the tasks of this session that an earlier prompt left
 * open: the prompt was interrupted before its Stop, or a late observation
 * reopened its task. Called when a new prompt starts (`keepNewest`: the new
 * task, or the task a notification turn continues, stays open) and when the
 * current prompt stops. Returns the ids closed here for the caller to persist. */
export function settleHookSession(root: string, provider: HookProvider, event: HunchHookInput, options: { keepId?: string | null; keepNewest?: boolean } = {}): string[] {
  const cwd = nativeHookCwd(root, provider, event);
  const key = cwd ? hookSessionKey(cwd, provider, event) : null;
  if (!key) return [];
  try { return settleSessionTasks(root, key, options); } catch { return []; }
}

/** Stop ends the turn, so the prompt's task closes here as a HOST close: the
 * ledger says the task completed even when the agent never called finish, and
 * a task with observations becomes a graph record without anyone's cooperation.
 * The close is provisional because Stop can precede another hook's
 * continuation: the next observation reopens the task and the following Stop
 * closes it again (the record is refreshed from the report). An explicit agent
 * finish with any outcome overrides a host close. Pending verification keeps
 * the task open. Tasks an earlier prompt of the session left open close here
 * too. Returns the ids of the tasks closed after this call, so the caller can
 * persist their records; empty when nothing is closed. */
export function closeHookTask(root: string, provider: HookProvider, event: HunchHookInput): string[] {
  let id: string | null;
  try { id = identity(root, provider, event); } catch { return []; }
  if (!id || id === "legacy") return [];
  const closed: string[] = [];
  try {
    const task = readTaskReport(root, id).task;
    if (task.state === "open") finishReportTask(root, id, "completed", { by: "host" });
    if (task.state !== "interrupted") closed.push(id);
  } catch {
    // No task for this prompt (a notification turn), or verification still running: leave it as it is.
  }
  for (const other of settleHookSession(root, provider, event, { keepId: id })) if (!closed.includes(other)) closed.push(other);
  return closed;
}

/** A presentation notice never denies Stop or injects another model turn.
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
    // The HTML evidence view is a rendering of the local ledger, generated on
    // demand (`hunch report <id> --html`, or a click in the VS Code view). The
    // graph record is the durable memory; no file is written per prompt.
    return { systemMessage: renderTaskReport(report) };
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
