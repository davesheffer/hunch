import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { aliasReportTask, listReportTasks, readTaskReport, startReportTask } from "../src/core/taskReport.js";
import { closeHookTask, hookReportTaskId, observeHookDenial, promptTaskId, startHookReport } from "../src/core/taskReportHook.js";
import type { HunchHookInput } from "../src/core/agenthook.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hunch-report-subagent-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  return root;
}
function evt(root: string, event: string, extra: Record<string, unknown> = {}): HunchHookInput {
  return { hook_event_name: event, cwd: root, session_id: "session-a", prompt_id: "prompt-a", ...extra } as HunchHookInput;
}
function hook(root: string, event: string, extra: Record<string, unknown> = {}) {
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ hook_event_name: event, cwd: root, session_id: "session-a", prompt_id: "prompt-a", ...extra }), encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}

test("a subagent's tool call reports to the prompt's task, which no agent-scoped prompt ever opened", t => {
  const root = fixture(t);
  const parent = startHookReport(root, "claude", evt(root, "UserPromptSubmit"));
  assert.ok(parent, "the prompt hook opens the task the subagent must find");
  const task = listReportTasks(root)[0]!.task_id;
  const sub = evt(root, "PreToolUse", { agent_id: "agent-1" });
  assert.equal(hookReportTaskId(root, "claude", sub), task, "the subagent's deliveries belong to the prompt's task");
  assert.notEqual(promptTaskId(root, "session-a", "prompt-a", "agent-1"), task, "the agent-scoped identity is genuinely different");
});

test("a subagent's strict denial lands in the prompt's report instead of vanishing", t => {
  const root = fixture(t);
  startHookReport(root, "claude", evt(root, "UserPromptSubmit"));
  const task = listReportTasks(root)[0]!.task_id;
  observeHookDenial(root, "claude", evt(root, "PreToolUse", { agent_id: "agent-1" }), "src/config.ts",
    { reason: "blocked", event: { kind: "constraint", constraint: "con_subagent" } });
  const report = readTaskReport(root, task);
  assert.equal(report.refusals.length, 1, "an emitted denial from a subagent must be visible in the prompt's report");
  assert.equal(report.refusals[0]!.record_id, "con_subagent");
});

test("an agent-scoped task that exists keeps its own evidence", t => {
  const root = fixture(t);
  startHookReport(root, "claude", evt(root, "UserPromptSubmit"));
  const task = listReportTasks(root)[0]!.task_id;
  const agentTask = promptTaskId(root, "session-a", "prompt-a", "agent-2");
  startReportTask(root, "Assistant task", agentTask);
  assert.equal(hookReportTaskId(root, "claude", evt(root, "PreToolUse", { agent_id: "agent-2" })), agentTask);
  assert.notEqual(agentTask, task);
});

test("without a prompt task nothing is guessed: the agent-scoped identity stands", t => {
  const root = fixture(t);
  startHookReport(root, "claude", evt(root, "UserPromptSubmit"));
  const sub = evt(root, "PreToolUse", { prompt_id: "p-unknown", agent_id: "agent-1" });
  assert.equal(hookReportTaskId(root, "claude", sub), promptTaskId(root, "session-a", "p-unknown", "agent-1"));
});

test("a subagent follows the prompt identity's alias to the task it continued", t => {
  const root = fixture(t);
  startHookReport(root, "claude", evt(root, "UserPromptSubmit"));
  const task = listReportTasks(root)[0]!.task_id;
  aliasReportTask(root, promptTaskId(root, "session-a", "p-note"), task);
  assert.equal(hookReportTaskId(root, "claude", evt(root, "PreToolUse", { prompt_id: "p-note", agent_id: "agent-1" })), task);
});

test("a subagent-scoped Stop never closes the prompt's task", t => {
  const root = fixture(t);
  startHookReport(root, "claude", evt(root, "UserPromptSubmit"));
  const task = listReportTasks(root)[0]!.task_id;
  const closed = closeHookTask(root, "claude", evt(root, "Stop", { agent_id: "agent-1" }));
  assert.ok(!closed.includes(task), "the subagent's Stop is not the prompt's Stop");
  assert.equal(readTaskReport(root, task).task.state, "open");
});

test("a subagent starts with fresh context, so it receives FULL grounding and its own delta", t => {
  const root = fixture(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "config.ts"), "export const settings = {};\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_subagent_hook", statement: "Preserve existing settings", scope: ["src/config.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  hook(root, "UserPromptSubmit");
  const task = listReportTasks(root)[0]!.task_id;
  const input = { tool_name: "Edit", tool_input: { file_path: join(root, "src", "config.ts"), new_string: "merge settings" } };
  assert.match(hook(root, "PreToolUse", input).hookSpecificOutput.additionalContext, /Preserve existing settings/);
  const sub = hook(root, "PreToolUse", { ...input, agent_id: "agent-1" });
  assert.match(sub.hookSpecificOutput.additionalContext, /Preserve existing settings/, "the subagent never saw the parent's grounding");
  assert.doesNotMatch(sub.hookSpecificOutput.additionalContext, /unchanged this session/);
  assert.match(sub.hookSpecificOutput.additionalContext, new RegExp(`Hunch task ${task}`), "its delivery is retained in the prompt's task");
  const repeat = hook(root, "PreToolUse", { ...input, agent_id: "agent-1" });
  assert.match(repeat.hookSpecificOutput.additionalContext, /unchanged this session/, "the same subagent still dedups against itself");
});
