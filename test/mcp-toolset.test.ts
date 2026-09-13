import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { MCP_TOOL_GROUPS, parseToolsetSpec, resolveMcpToolset, rootStoresState } from "../src/mcp/toolset.js";
import { tempStore } from "./helpers.js";

const SPECIALIST = [...MCP_TOOL_GROUPS.nuryel, ...MCP_TOOL_GROUPS["constitution-experiments"]];

async function toolNames(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const saved = process.env.HUNCH_MCP_TOOLS;
  if (env.HUNCH_MCP_TOOLS === undefined) delete process.env.HUNCH_MCP_TOOLS; else process.env.HUNCH_MCP_TOOLS = env.HUNCH_MCP_TOOLS;
  try {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "toolset-test", version: "1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try { return (await client.listTools()).tools.map(t => t.name).sort(); } finally { await client.close(); await server.close(); }
  } finally {
    if (saved === undefined) delete process.env.HUNCH_MCP_TOOLS; else process.env.HUNCH_MCP_TOOLS = saved;
  }
}

test("spec grammar: all, core, and extra groups on top of core; unknown words are ignored", () => {
  assert.deepEqual(parseToolsetSpec("all")?.sort(), ["constitution-experiments", "nuryel"]);
  assert.deepEqual(parseToolsetSpec("core"), []);
  assert.deepEqual(parseToolsetSpec("core, nuryel"), ["nuryel"]);
  assert.deepEqual(parseToolsetSpec("Nuryel,bogus"), ["nuryel"]);
  assert.equal(parseToolsetSpec("  "), null);
});

test("an ordinary repository gets the everyday tools only; the specialist groups are not registered", async () => {
  const { root, cleanup } = tempStore();
  try {
    const set = resolveMcpToolset(root, { env: {} });
    assert.deepEqual(set.groups, []);
    assert.equal(set.source, "default");
    assert.deepEqual(set.hidden.sort(), [...SPECIALIST].sort());
    const names = await toolNames(root, {});
    for (const tool of SPECIALIST) assert.ok(!names.includes(tool), `${tool} must not be listed by default`);
    for (const tool of ["hunch_context", "hunch_task", "hunch_why", "hunch_check_constraints", "hunch_record_decision", "hunch_policy_evaluate", "hunch_conformance"]) assert.ok(names.includes(tool), tool);
    assert.ok(names.length >= 40, `everyday set still carries the grounding tools (${names.length})`);
  } finally { cleanup(); }
});

test("a root that stores nuryel state records is a state partition and exposes the nuryel tools by default", async () => {
  const { root, cleanup } = tempStore();
  try {
    assert.equal(rootStoresState(root), false);
    mkdirSync(join(root, ".hunch", "receipts"), { recursive: true });
    writeFileSync(join(root, ".hunch", "receipts", "rcp_x.json"), "{}");
    assert.equal(rootStoresState(root), true);
    const set = resolveMcpToolset(root, { env: {} });
    assert.deepEqual(set.groups, ["nuryel"]);
    const names = await toolNames(root, {});
    for (const tool of MCP_TOOL_GROUPS.nuryel) assert.ok(names.includes(tool), tool);
    for (const tool of MCP_TOOL_GROUPS["constitution-experiments"]) assert.ok(!names.includes(tool), `${tool} stays hidden`);
  } finally { cleanup(); }
});

test("HUNCH_MCP_TOOLS=all and .hunch/config.json mcp_tools expose specialist groups; env wins over config", async () => {
  const { root, cleanup } = tempStore();
  try {
    assert.deepEqual(resolveMcpToolset(root, { env: {}, configSpec: "core,constitution-experiments" }).groups, ["constitution-experiments"]);
    assert.equal(resolveMcpToolset(root, { env: {}, configSpec: "all" }).source, "config");
    const env = resolveMcpToolset(root, { env: { HUNCH_MCP_TOOLS: "core" }, configSpec: "all" });
    assert.deepEqual(env.groups, []);
    assert.equal(env.source, "env");
    const names = await toolNames(root, { HUNCH_MCP_TOOLS: "all" });
    for (const tool of SPECIALIST) assert.ok(names.includes(tool), tool);
    writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory", mcp_tools: "core,nuryel" }));
    const fromConfig = await toolNames(root, {});
    for (const tool of MCP_TOOL_GROUPS.nuryel) assert.ok(fromConfig.includes(tool), tool);
    for (const tool of MCP_TOOL_GROUPS["constitution-experiments"]) assert.ok(!fromConfig.includes(tool), tool);
  } finally { cleanup(); }
});
