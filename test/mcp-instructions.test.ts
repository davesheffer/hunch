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

// The always-loaded block routes to hunch_context; its description carries the
// per-moment tool list, so the documented param names must match the real keys.
test("hunch_context's description lists the tools by moment with their real param names", async (t) => {
  const { root, cleanup } = tempStore();
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-description-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  const md = (await client.listTools()).tools.find((tool) => tool.name === "hunch_context")?.description ?? "";
  for (const moment of ["Start:", "Design:", "Edit:", "Merge:", "Record", "Finish:"]) assert.ok(md.includes(moment), moment);
  assert.match(md, /hunch_query\(query\)/, "hunch_query param is `query`, not `question`");
  assert.match(md, /hunch_bug_lineage\(symptom_or_symbol\)/);
  assert.match(md, /hunch_runbook\(task\)/);
  assert.match(md, /hunch_compare\(candidates\)/);
  assert.match(md, /hunch_conformance\(\)/);
  assert.match(md, /hunch_why\(target\)/);
  assert.match(md, /hunch_check_constraints\(scope\)/);
  assert.match(md, /hunch_get_dependents\(symbol\)/);
  assert.match(md, /only a human activates a policy/);
  assert.match(md, /Optional follow-up references for missing information, not a per-task checklist/);
  assert.match(md, /One adequate context brief is sufficient/);
  assert.match(md, /Record only new reusable knowledge/);
  assert.doesNotMatch(md, /hunch_query\(question\)|hunch_bug_lineage\(symptom\)/);
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
