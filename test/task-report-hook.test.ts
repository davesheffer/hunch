import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listReportTasks, readTaskReport } from "../src/core/taskReport.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hunch-report-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  return root;
}
function hook(root: string, event: string, extra: Record<string, unknown> = {}) {
  const output = execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "hook"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ hook_event_name: event, cwd: root, session_id: "session-a", prompt_id: "prompt-a", ...extra }), encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}

test("native Stop shows missing coverage even when the agent never calls Hunch", t => {
  const root = fixture(t);
  const prompt = hook(root, "UserPromptSubmit", { prompt: "PRIVATE_PROMPT_SENTINEL" });
  const [task] = listReportTasks(root);
  assert.ok(task, "host must start reporting before the model can skip its instructions");
  assert.match(prompt.hookSpecificOutput.additionalContext, new RegExp(task.task_id));
  const stop = hook(root, "Stop");
  assert.match(stop.systemMessage, /No task-linked delivery observed/);
  assert.match(stop.systemMessage, /file:\/\//);
  assert.equal(stop.decision, undefined, "report presentation never blocks Stop");
  assert.equal(stop.hookSpecificOutput, undefined, "report does not ask the model to continue");
  assert.equal(readFileSync(join(root, ".hunch-cache", "served.db")).includes(Buffer.from("PRIVATE_PROMPT_SENTINEL")), false);
  assert.equal(listReportTasks(root)[0]!.state, "open", "Stop alone cannot establish task completion or absence of another hook continuation");
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
  assert.equal(readTaskReport(root, first.task_id).deliveries.length, 1);
  hook(root, "PreToolUse", input);
  assert.equal(readTaskReport(root, first.task_id).deliveries.length, 1);
  assert.match(hook(root, "Stop").systemMessage, /Recalled.*Preserve existing settings/);
  hook(root, "UserPromptSubmit", { prompt_id: "prompt-b" });
  const second = listReportTasks(root)[0]!;
  hook(root, "PreToolUse", { ...input, prompt_id: "prompt-b" });
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
