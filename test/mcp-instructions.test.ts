import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, MCP_INSTRUCTIONS } from "../src/mcp/server.js";
import { tempStore } from "./helpers.js";

test("initialize delivers the grounding contract to every client, hooks or not", async (t) => {
  const { root, cleanup } = tempStore();
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "instructions-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  const instructions = client.getInstructions();
  assert.equal(instructions, MCP_INSTRUCTIONS);
  for (const tool of ["hunch_task", "hunch_context", "hunch_check_constraints", "hunch_why"]) assert.ok(instructions?.includes(tool), tool);
  assert.doesNotMatch(instructions ?? "", /claude code only|anthropic/i, "host-neutral (con_e04226bd05)");
  assert.ok((instructions ?? "").length < 1500, "short enough to survive every client's context budget");
  // An MCP-started task has no session key, so no hook ever closes it: the finish
  // skip must read as ONE conjunction gated on the prompt hook's own statement,
  // never as an independent "skippable where the host closes the task" clause.
  assert.match(instructions ?? "", /its instruction said that host closes the task AND the task used no Hunch/);
  assert.match(instructions ?? "", /A task you started with hunch_task is always finished by you/);
  assert.doesNotMatch(instructions ?? "", /skippable/i);
});
