import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, MCP_INSTRUCTIONS } from "../src/mcp/server.js";
import { tempStore } from "./helpers.js";
import { taskInstruction } from "../src/core/taskReportHook.js";
import { HOOK_REMINDER } from "../src/core/hookText.js";

test("prompt reminder requests one brief and conditional follow-ups", () => {
  assert.match(HOOK_REMINDER, /^Hunch \(engineering memory\) is available/);
  assert.match(HOOK_REMINDER, /A task-linked prompt-hook brief satisfies this task's initial context step; otherwise/);
  assert.match(HOOK_REMINDER, /one hunch_context call with the task and known files/);
  assert.match(HOOK_REMINDER, /hunch_check_constraints before editing uncovered scope/);
  assert.match(HOOK_REMINDER, /only for missing information or risk/);
  assert.match(HOOK_REMINDER, /Discovering another file does not require a second context brief/);
  assert.match(HOOK_REMINDER, /Record only what the human decides or corrects/);
  assert.doesNotMatch(HOOK_REMINDER, /Before editing, call hunch_check_constraints/);
});

test("initialize delivers the grounding contract to every client, hooks or not", async (t) => {
  const { root, cleanup } = tempStore();
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "instructions-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  const instructions = client.getInstructions();
  assert.equal(instructions, MCP_INSTRUCTIONS);
  assert.match(instructions ?? "", /task-linked prompt-hook brief as initial context; else hunch_context/);
  assert.match(instructions ?? "", /Apply constraints; hunch_check_constraints\(scope\) before uncovered edits/);
  assert.doesNotMatch(instructions ?? "", /hunch_check_constraints\(scope\) before shared edits/);
  for (const tool of ["hunch_task", "hunch_context", "hunch_check_constraints"]) assert.ok(instructions?.includes(tool), tool);
  assert.doesNotMatch(instructions ?? "", /claude code only|anthropic/i, "host-neutral (con_e04226bd05)");
  assert.ok((instructions ?? "").length <= 500, `${(instructions ?? "").length} chars; ceiling 500`);
  // An MCP-started task has no session key, so only an explicit statement by
  // the hook for this task permits automatic closure.
  assert.match(instructions ?? "", /unless the hook explicitly says it closes this task and displays its report, even when memory was used/);
  assert.match(instructions ?? "", /Manually started tasks always finish/);
  assert.doesNotMatch(instructions ?? "", /skippable/i);
  assert.doesNotMatch(instructions ?? "", /task verify check/, "a verify check alone never obliges a finish where the host closes the task");
});

test("hunch_context's description gives focused, host-neutral guidance", async (t) => {
  const { root, cleanup } = tempStore();
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-description-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  const md = (await client.listTools()).tools.find((tool) => tool.name === "hunch_context")?.description ?? "";
  assert.ok(md.length <= 900, `${md.length} chars; ceiling 900`);
  assert.match(md, /A task-linked prompt-hook brief satisfies initial context; otherwise call hunch_context first with the task, known files, and task_id/);
  assert.match(md, /Apply its constraints/);
  assert.match(md, /hunch_check_constraints\(scope\)/);
  assert.match(md, /before editing scope the brief does not cover/);
  assert.match(md, /One sufficient brief is enough/);
  assert.match(md, /hunch_why\(target\) only when more detail is needed/);
  assert.match(md, /render result\.content only; structuredContent is the alternative machine-readable representation/);
  assert.match(md, /Only a human activates a policy/);
  assert.doesNotMatch(md, /Start:|Design:|Edit:|Merge:|hunch_query\(/);
});

// The finish-skip rule reads the same wherever it is stated: the MCP instructions,
// the hunch_task description, and the prompt hook's instruction (as its mirror);
// hunch_context's moment list defers to it rather than restating it unconditionally.
test("the finish-skip rule reads the same in every channel", async (t) => {
  const { root, cleanup } = tempStore();
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "finish-rule-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  const { tools } = await client.listTools();
  const desc = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
  const rule = "unless the hook explicitly says it closes this task and displays its report, even when memory was used. Finish for real application claims (exact occurrence/hash) or interruption. Manually started tasks always finish.";
  assert.ok(MCP_INSTRUCTIONS.includes(rule), MCP_INSTRUCTIONS);
  assert.ok(desc("hunch_task").includes(rule), desc("hunch_task"));
  assert.match(desc("hunch_context"), /hunch_task finish unless its skip rule applies\.$/);
  const hook = taskInstruction({ task_id: "htask_0123456789abcdef01234567", title: "t" }, JSON.stringify("/repo"), "claude");
  assert.match(hook, /closes this task and displays its report automatically, even if memory was used/);
  assert.match(hook, /real application claims \(exact occurrence\/hash\) or an interrupted outcome/);
});
