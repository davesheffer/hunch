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
  assert.match(HOOK_REMINDER, /Use a task-linked prompt-hook brief for its covered file; otherwise/);
  assert.match(HOOK_REMINDER, /one hunch_context call with the task and known files/);
  assert.match(HOOK_REMINDER, /hunch_check_constraints for edit scope not covered by the brief/);
  assert.match(HOOK_REMINDER, /only for missing information or risk/);
  assert.match(HOOK_REMINDER, /Record new reusable decisions and corrections/);
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
  assert.match(instructions ?? "", /task-linked prompt-hook brief covers its file; else hunch_context/);
  assert.match(instructions ?? "", /Apply constraints; hunch_check_constraints\(scope\) before editing uncovered scope/);
  assert.doesNotMatch(instructions ?? "", /hunch_check_constraints\(scope\) before shared edits/);
  for (const tool of ["hunch_task", "hunch_context", "hunch_check_constraints"]) assert.ok(instructions?.includes(tool), tool);
  assert.doesNotMatch(instructions ?? "", /claude code only|anthropic/i, "host-neutral (con_e04226bd05)");
  assert.ok((instructions ?? "").length <= 500, `${(instructions ?? "").length} chars; ceiling 500`);
  // An MCP-started task has no session key, so no hook ever closes it: the finish
  // skip must read as ONE conjunction gated on the prompt hook's own statement,
  // never as an independent "skippable where the host closes the task" clause.
  assert.match(instructions ?? "", /skip it only if the hook said the host closes the task and it used no Hunch \(no hunch_\* call on its ID, hook context acted on, or claim\)/);
  assert.match(instructions ?? "", /Tasks you start, you finish/);
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
  assert.match(md, /Use a task-linked prompt-hook brief for its covered file; otherwise call hunch_context first with the task, known files, and task_id/);
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
  const rule = "skip it only if the hook said the host closes the task and it used no Hunch (no hunch_* call on its ID, hook context acted on, or claim). Tasks you start, you finish.";
  assert.ok(MCP_INSTRUCTIONS.includes(rule), MCP_INSTRUCTIONS);
  assert.ok(desc("hunch_task").includes(rule), desc("hunch_task"));
  assert.match(desc("hunch_context"), /hunch_task finish unless its skip rule applies\.$/);
  const hook = taskInstruction({ task_id: "htask_0123456789abcdef01234567", title: "t" }, JSON.stringify("/repo"), "claude");
  assert.match(hook, /ONLY if this task used Hunch \(a hunch_\* call on its ID, hook context acted on, or a claim\)/);
});
