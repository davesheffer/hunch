import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finishReportTask, listReportTasks, listTaskSummaries, readTaskReport, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { promptTaskId } from "../src/core/taskReportHook.js";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hunch-report-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  return root;
}
function hook(root: string, event: string, extra: Record<string, unknown> = {}, provider = "claude") {
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", provider], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ hook_event_name: event, cwd: root, session_id: "session-a", prompt_id: "prompt-a", ...extra }), encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}

test("native Stop stays silent for a prompt with no observation, closes the task as a host close, and the empty row stays ledger-only", t => {
  const root = fixture(t);
  const prompt = hook(root, "UserPromptSubmit", { prompt: "PRIVATE_PROMPT_SENTINEL" });
  const [task] = listReportTasks(root);
  assert.ok(task, "host must start reporting before the model can skip its instructions");
  assert.equal(task.title, "Assistant task");
  assert.match(prompt.hookSpecificOutput.additionalContext, /title: "Assistant task"/);
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /Claude task/);
  assert.match(prompt.hookSpecificOutput.additionalContext, new RegExp(task.task_id));
  assert.equal(hook(root, "Stop"), null, "no delivery, check, save or denial: nothing to print (dec_77d99014e0's sibling: silence only where there is no evidence to show)");
  assert.equal(readFileSync(join(root, ".hunch-cache", "served.db")).includes(Buffer.from("PRIVATE_PROMPT_SENTINEL")), false);
  const closed = listReportTasks(root)[0]!;
  assert.equal(closed.state, "completed", "the turn ended: the ledger says so without the agent's cooperation");
  assert.equal(closed.closed_by, "host");
  assert.equal(existsSync(join(root, ".hunch", "tasks")), false, "an empty task never becomes a graph record");
  const [summary] = listTaskSummaries(root);
  assert.equal(summary?.task.task_id, task.task_id);
  assert.equal(summary?.empty, true, "the ledger still shows the prompt never touched Hunch");
});

test("a prompt that follows another in the same session continues its task; the episode's record is written under the first task's id", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ taskRecordsFlush: "batch" }));
  hook(root, "UserPromptSubmit", { prompt_id: "p1" });
  const [first] = listReportTasks(root);
  assert.ok(first);
  assert.equal(first.continues, undefined, "the first prompt of a session starts an episode");
  assert.ok(first.session_key?.startsWith("sha256:"), "the session is kept as a hash, never as the identifier");
  assert.equal(readFileSync(join(root, ".hunch-cache", "served.db")).includes(Buffer.from("session-a")), false, "the host session identifier is not retained");
  hook(root, "Stop", { prompt_id: "p1" });
  // "next": a follow-up prompt within the window in the same session.
  hook(root, "UserPromptSubmit", { prompt_id: "p2" });
  const second = listReportTasks(root).find(x => x.task_id !== first.task_id)!;
  assert.equal(second.continues, first.task_id);
  assert.equal(second.episode, first.task_id);
  execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", second.task_id, "--json", "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, encoding: "utf8" });
  hook(root, "Stop", { prompt_id: "p2" });
  assert.equal(existsSync(join(root, ".hunch", "tasks", `${second.task_id}.json`)), false, "no record per prompt");
  const episode = JSON.parse(readFileSync(join(root, ".hunch", "tasks", `${first.task_id}.json`), "utf8")) as { id: string; checks: unknown[]; provenance: { evidence: string[] } };
  assert.equal(episode.id, first.task_id, "the episode's record carries the head's id");
  assert.equal(episode.checks.length, 1, "the follow-up prompt's check lives in the episode record");
  assert.deepEqual(episode.provenance.evidence, [`hunch report ${first.task_id}`, `hunch report ${second.task_id}`]);
  // A third prompt continues the same episode; another session never does.
  hook(root, "UserPromptSubmit", { prompt_id: "p3" });
  const third = listReportTasks(root).find(x => ![first.task_id, second.task_id].includes(x.task_id))!;
  assert.equal(third.continues, second.task_id);
  assert.equal(third.episode, first.task_id);
  hook(root, "UserPromptSubmit", { session_id: "session-b", prompt_id: "p1" });
  const other = listReportTasks(root).find(x => x.session_key !== first.session_key)!;
  assert.equal(other.continues, undefined);
  assert.equal(other.episode, undefined);
  const [row] = listTaskSummaries(root).filter(s => s.task.task_id === second.task_id);
  assert.equal(row?.task.episode, first.task_id, "summaries expose the episode for host views");
});

test("Stop keeps the record of a task with observations, a continuation reopens it, and an explicit finish overrides the host close", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ taskRecordsFlush: "batch" }));
  hook(root, "UserPromptSubmit");
  const [task] = listReportTasks(root);
  const verify = () => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", task!.task_id, "--json", "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, encoding: "utf8" });
  verify();
  const stop = hook(root, "Stop");
  assert.match(stop.systemMessage, /Checked .*passed/);
  let row = listReportTasks(root)[0]!;
  assert.equal(row.state, "completed");
  assert.equal(row.closed_by, "host");
  const recordPath = join(root, ".hunch", "tasks", `${task!.task_id}.json`);
  assert.ok(existsSync(recordPath), "the host close persists the graph record; the agent never called finish");
  const first = JSON.parse(readFileSync(recordPath, "utf8")) as { checks: unknown[]; state: string };
  assert.equal(first.checks.length, 1);
  assert.equal(first.state, "completed");
  // The turn continued (another hook blocked, or the prompt resumed): a new
  // observation reopens the host-closed task instead of failing.
  verify();
  row = listReportTasks(root)[0]!;
  assert.equal(row.state, "open", "a host close is provisional");
  assert.equal(row.closed_by, undefined);
  hook(root, "Stop");
  row = listReportTasks(root)[0]!;
  assert.equal(row.state, "completed");
  assert.equal((JSON.parse(readFileSync(recordPath, "utf8")) as { checks: unknown[] }).checks.length, 2, "the record is refreshed from the report at the next Stop");
  // The agent's explicit outcome wins over the host's provisional one.
  const explicit = finishReportTask(root, task!.task_id, "interrupted");
  assert.equal(explicit.state, "interrupted");
  assert.equal(explicit.closed_by, "agent");
  assert.throws(() => finishReportTask(root, task!.task_id, "completed"), /different outcome/, "an agent close is final");
});

const verifyTask = (root: string, taskId: string) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", taskId, "--json", "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, encoding: "utf8" });
function deliverTo(root: string, taskId: string): string {
  const ctx = { target: "src/config.js", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  ctx.constraints.push({ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.js"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
  const record = { record_id: "con_preserve", kind: "constraints", title: "Preserve existing settings", lesson: "Merge settings.", content_hash: reportHash("fixture record revision"), recorded_at: "2026-09-11T00:00:00.000Z" };
  return recordTaskDelivery(root, taskId, buildDeliveryEnvelope(ctx), [record], undefined, "src/config.js");
}

test("a prompt interrupted before its Stop is closed when the session's next prompt arrives, and its evidence reaches the episode record (#263)", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ taskRecordsFlush: "batch" }));
  hook(root, "UserPromptSubmit", { prompt_id: "p1" });
  const [first] = listReportTasks(root);
  verifyTask(root, first!.task_id);
  // No Stop: the user interrupted the turn. The session's next prompt arrives.
  hook(root, "UserPromptSubmit", { prompt_id: "p2" });
  const rows = listReportTasks(root);
  const interrupted = rows.find(r => r.task_id === first!.task_id)!;
  assert.equal(interrupted.state, "completed", "the interrupted prompt's task is over once the session moved on");
  assert.equal(interrupted.closed_by, "host");
  const second = rows.find(r => r.task_id !== first!.task_id)!;
  assert.equal(second.state, "open", "the new prompt's own task stays open");
  assert.equal(second.continues, first!.task_id, "an open task is the session's current work whatever its age");
  const recordPath = join(root, ".hunch", "tasks", `${first!.task_id}.json`);
  assert.ok(existsSync(recordPath), "the interrupted prompt's evidence became a record without any Stop");
  assert.equal((JSON.parse(readFileSync(recordPath, "utf8")) as { checks: unknown[] }).checks.length, 1);
  hook(root, "Stop", { prompt_id: "p2" });
  const episode = JSON.parse(readFileSync(recordPath, "utf8")) as { provenance: { evidence: string[] } };
  assert.deepEqual(episode.provenance.evidence, [`hunch report ${first!.task_id}`, `hunch report ${second.task_id}`]);
});

test("an observation naming an older host-closed task lands on the session's newest task; verification keeps its own task; an agent close stays closed (#266)", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ taskRecordsFlush: "batch" }));
  hook(root, "UserPromptSubmit", { prompt_id: "p1" });
  const [first] = listReportTasks(root);
  hook(root, "Stop", { prompt_id: "p1" });
  hook(root, "UserPromptSubmit", { prompt_id: "p2" });
  const second = listReportTasks(root).find(r => r.task_id !== first!.task_id)!;
  // The agent reuses p1's id for p2's context call, as the grounding tells it to.
  deliverTo(root, first!.task_id);
  assert.equal(readTaskReport(root, first!.task_id).task.state, "completed", "the old task is not reopened: no Stop would close it again");
  assert.equal(readTaskReport(root, first!.task_id).deliveries.length, 0);
  assert.equal(readTaskReport(root, second.task_id).deliveries.length, 1, "the observation is the current prompt's work");
  // A verification result must match its start, so a check on the old id stays there and reopens it.
  verifyTask(root, first!.task_id);
  assert.equal(readTaskReport(root, first!.task_id).task.state, "open");
  hook(root, "Stop", { prompt_id: "p2" });
  assert.equal(listReportTasks(root).find(r => r.task_id === first!.task_id)!.state, "completed", "Stop closes what an earlier prompt left open");
  assert.equal(readTaskReport(root, first!.task_id).checks.length, 1);
  // The agent closed the newest task for good: a late observation naming the old one falls back to reopening it.
  finishReportTask(root, second.task_id, "completed");
  deliverTo(root, first!.task_id);
  assert.equal(readTaskReport(root, second.task_id).task.closed_by, "agent");
  assert.equal(readTaskReport(root, first!.task_id).task.state, "open");
  assert.equal(readTaskReport(root, first!.task_id).deliveries.length, 1);
});

test("a host notification turn continues the session's latest task instead of opening a row of its own (#269)", t => {
  const root = fixture(t);
  hook(root, "UserPromptSubmit", { prompt_id: "p1", prompt: "do it" });
  const [first] = listReportTasks(root);
  hook(root, "Stop", { prompt_id: "p1" });
  const notice = hook(root, "UserPromptSubmit", { prompt_id: "n1", prompt: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>" });
  assert.equal(listReportTasks(root).length, 1, "no ledger row for a notification");
  assert.match(notice.hookSpecificOutput.additionalContext, new RegExp(first!.task_id), "the instruction names the task the notification belongs to");
  assert.equal(hook(root, "Stop", { prompt_id: "n1" }), null);
  assert.equal(listReportTasks(root)[0]!.state, "completed");
  // Without a session task, a notification is just a prompt.
  hook(root, "UserPromptSubmit", { session_id: "session-b", prompt_id: "n2", prompt: "<task-notification>\n</task-notification>" });
  assert.equal(listReportTasks(root).length, 2);
});

test("native Stop shows the card as soon as a check is observed, even when the agent never called a tool", t => {
  const root = fixture(t);
  hook(root, "UserPromptSubmit");
  const [task] = listReportTasks(root);
  execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", task!.task_id, "--json", "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, encoding: "utf8" });
  const stop = hook(root, "Stop");
  assert.match(stop.systemMessage, /No task-linked delivery observed/);
  assert.match(stop.systemMessage, /Checked .*passed/);
  assert.match(stop.systemMessage, /Evidence  hunch report htask_[a-f0-9]{24} --html/, "the evidence view is rendered on demand, not written per prompt");
  assert.equal(stop.decision, undefined, "report presentation never blocks Stop");
  assert.equal(stop.hookSpecificOutput, undefined, "report does not ask the model to continue");
});

test("host identities separate prompts and sessions; old hosts never borrow a recent task", t => {
  const root = fixture(t);
  hook(root, "UserPromptSubmit");
  const first = listReportTasks(root)[0]!;
  hook(root, "UserPromptSubmit");
  assert.equal(listReportTasks(root).length, 1);
  hook(root, "UserPromptSubmit", { prompt_id: "prompt-b" });
  hook(root, "UserPromptSubmit", { session_id: "session-b" });
  assert.equal(listReportTasks(root).length, 3);
  execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", first.task_id, "--json", "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, encoding: "utf8" });
  assert.match(hook(root, "Stop").systemMessage, new RegExp(first.task_id));
  const legacy = hook(root, "Stop", { prompt_id: undefined });
  assert.match(legacy.systemMessage, /exact prompt identifier/);
  assert.doesNotMatch(legacy.systemMessage, /htask_/);
  assert.match(hook(root, "Stop", { prompt_id: "never-started" }).systemMessage, /unavailable/);
});

test("presentation opt-out, disabled hooks, wrong worktree and malformed identifiers stay safe", t => {
  const root = fixture(t), other = fixture(t);
  hook(root, "UserPromptSubmit");
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ reportPresentation: false }));
  assert.equal(hook(root, "Stop"), null);
  assert.equal(hook(root, "Stop", { prompt_id: undefined }), null);
  writeFileSync(join(root, ".hunch", "local.json"), "{}");
  assert.equal(hook(root, "Stop", { cwd: other }), null);
  assert.equal(hook(root, "Stop", { prompt_id: "x".repeat(1025) }), null);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "off" }));
  assert.equal(hook(root, "Stop"), null);
});

test("native pre-edit injections appear in the exact prompt report; deltas do not invent deliveries", t => {
  const root = fixture(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "config.ts"), "export const settings = {};\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_hook_report", statement: "Preserve existing settings", scope: ["src/config.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  hook(root, "UserPromptSubmit");
  const first = listReportTasks(root)[0]!;
  const input = { tool_name: "Edit", tool_input: { file_path: join(root, "src", "config.ts"), new_string: "merge settings" } };
  const edit = hook(root, "PreToolUse", input);
  assert.match(edit.hookSpecificOutput.additionalContext, /Preserve existing settings/);
  assert.match(edit.systemMessage, /^Hunch recalled: Preserve existing settings$/, "the first delivery in a prompt shows the user one line");
  assert.equal(readTaskReport(root, first.task_id).deliveries.length, 1);
  const repeat = hook(root, "PreToolUse", input);
  assert.equal(repeat.systemMessage, undefined, "a repeat delivery never re-announces the lesson");
  assert.equal(readTaskReport(root, first.task_id).deliveries.length, 1);
  assert.match(hook(root, "Stop").systemMessage, /Recalled.*Preserve existing settings/);
  hook(root, "UserPromptSubmit", { prompt_id: "prompt-b" });
  const second = listReportTasks(root)[0]!;
  const fresh = hook(root, "PreToolUse", { ...input, prompt_id: "prompt-b" });
  assert.match(fresh.systemMessage, /Hunch recalled: Preserve existing settings/, "deduplication is per task, so a new prompt hears the lesson once more");
  assert.equal(readTaskReport(root, second.task_id).deliveries.length, 1, "a previous prompt's delta cannot substitute for a full receipt");
  assert.notEqual(readTaskReport(root, first.task_id).deliveries[0]!.occurrence_id, readTaskReport(root, second.task_id).deliveries[0]!.occurrence_id);
});

test("strict denial is retained in its prompt report without claiming host compliance", t => {
  const root = fixture(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "config.ts"), "export const settings = {};\n");
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "strict" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_denial_report", statement: "PRIVATE_REFUSAL_SENTINEL", scope: ["src/config.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  hook(root, "UserPromptSubmit");
  const task = listReportTasks(root)[0]!;
  const input = { tool_name: "Edit", tool_input: { file_path: join(root, "src", "config.ts"), new_string: "replace settings" } };
  const denied = hook(root, "PreToolUse", input);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  const report = readTaskReport(root, task.task_id) as unknown as { refusals?: Array<{ kind: string; record_id: string; outcome: string }> };
  assert.equal(report.refusals?.length, 1, "an emitted denial must be visible in the exact task report");
  assert.equal(report.refusals[0]!.record_id, "con_denial_report");
  assert.equal(report.refusals[0]!.outcome, "denial-emitted");
  assert.match(hook(root, "Stop").systemMessage, /Denial emitted/);
  // An unidentified prompt must not attach to the most recent task.
  hook(root, "PreToolUse", { ...input, prompt_id: undefined });
  assert.equal((readTaskReport(root, task.task_id) as unknown as typeof report).refusals?.length, 1);
});

test("Codex hooks open the same per-prompt report from turn_id and never share a task with Claude Code", t => {
  const root = fixture(t);
  const prompt = hook(root, "UserPromptSubmit", { prompt_id: undefined, turn_id: "turn-1", prompt: "codex prompt" }, "codex");
  const [task] = listReportTasks(root);
  assert.ok(task, "Codex's UserPromptSubmit opens the report natively");
  assert.equal(task.title, "Assistant task");
  assert.match(prompt.hookSpecificOutput.additionalContext, new RegExp(task.task_id));
  assert.equal(hook(root, "Stop", { prompt_id: undefined, turn_id: "turn-1" }, "codex"), null, "nothing observed yet: silent");
  execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "task", "verify", task.task_id, "--json", "--", process.execPath, "-e", "process.exit(0)"], { cwd: root, encoding: "utf8" });
  const stop = hook(root, "Stop", { prompt_id: undefined, turn_id: "turn-1" }, "codex").systemMessage;
  assert.match(stop, new RegExp(task.task_id));
  assert.match(stop, /Hunch · Assistant task/);
  assert.doesNotMatch(stop, /Claude task/);
  hook(root, "UserPromptSubmit", { prompt_id: "turn-1" }, "claude");
  assert.equal(listReportTasks(root).length, 2, "same session/prompt strings on another host are a different task");
});

test("native SubagentStart grounding carries exact cwd and fails closed on supplied invalid cwd", t => {
  const root = fixture(t), other = fixture(t);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_subagent_cwd", statement: "PRIVATE_NONEMPTY_STORE_SENTINEL", scope: ["src/**"], severity: "blocking" }));
  store.reindex(); store.close();
  for (const provider of ["claude", "codex"]) {
    const routed = hook(root, "SubagentStart", { agent_type: "general" }, provider);
    assert.ok(routed, `${provider} delegated agents need a routing instruction`);
    assert.match(routed.hookSpecificOutput.additionalContext, /PRIVATE_NONEMPTY_STORE_SENTINEL/);
    assert.match(routed.hookSpecificOutput.additionalContext, new RegExp(`cwd: ${JSON.stringify(realpathSync(root)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(hook(root, "SubagentStart", { agent_type: "general", cwd: other }, provider), null, "a foreign payload cwd must suppress current-root memory too");
    assert.equal(hook(root, "SubagentStart", { agent_type: "general", cwd: 42 }, provider), null, "a malformed supplied cwd must suppress current-root memory too");
  }
});

test("an in-flight pre-upgrade native task keeps its legacy title and still receives its task ID", t => {
  const root = fixture(t);
  const id = promptTaskId(root, "session-a", "turn-legacy", null, "codex");
  startReportTask(root, "Claude task", id);
  const prompt = hook(root, "UserPromptSubmit", { prompt_id: undefined, turn_id: "turn-legacy" }, "codex");
  assert.match(prompt.hookSpecificOutput.additionalContext, new RegExp(id));
  assert.match(prompt.hookSpecificOutput.additionalContext, /title: "Claude task"/);
  assert.equal(listReportTasks(root).length, 1);
});

test("prompt-derived titles are opt-in: the default retains no prompt text, the opt-in keeps a bounded first line", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ taskTitles: "prompt" }));
  const prompt = hook(root, "UserPromptSubmit", { prompt: "Fix the settings merge so nested overrides survive\nsecond line is never used" });
  const [task] = listReportTasks(root);
  assert.equal(task!.title, "Fix the settings merge so nested overrides survive");
  assert.match(prompt.hookSpecificOutput.additionalContext, /title: "Fix the settings merge so nested overrides survive"/);
  // A credential-looking prompt keeps the generic title even when opted in.
  const secret = hook(root, "UserPromptSubmit", { prompt: "-----BEGIN PRIVATE KEY-----\nabc", prompt_id: "prompt-b" });
  assert.match(secret.hookSpecificOutput.additionalContext, /title: "Assistant task"/);
  assert.equal(readFileSync(join(root, ".hunch-cache", "served.db")).includes(Buffer.from("BEGIN PRIVATE KEY")), false);
  // The model paraphrasing the title on hunch_task start must not fork a task: the same
  // identity re-opened with the persisted title is the only valid answer.
  const again = hook(root, "UserPromptSubmit", { prompt: "Fix the settings merge so nested overrides survive\nsecond line is never used" });
  assert.equal(listReportTasks(root).filter(x => x.task_id === task!.task_id).length, 1);
  assert.match(again.hookSpecificOutput.additionalContext, new RegExp(task!.task_id));
});
