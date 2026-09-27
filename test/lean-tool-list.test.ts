import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { leanTool } from "../src/mcp/leanToolList.js";
import { tempStore } from "./helpers.js";

const DRAFT7 = "http://json-schema.org/draft-07/schema#";
const SAFE = Number.MAX_SAFE_INTEGER;

test("leanTool drops the draft-07 marker, the default execution, and zod's safe-integer bounds", () => {
  const tool = {
    name: "t",
    title: "T",
    description: "d",
    inputSchema: {
      $schema: DRAFT7,
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 },
        before: { type: "integer", exclusiveMinimum: 0, maximum: SAFE },
        offset: { type: "integer", minimum: -SAFE, maximum: SAFE },
        score: { type: "number", maximum: SAFE },
      },
      required: ["limit"],
      additionalProperties: false,
    },
    outputSchema: { $schema: DRAFT7, type: "object", properties: { n: { type: "integer", minimum: 0, maximum: SAFE } } },
    execution: { taskSupport: "forbidden" },
  };
  assert.deepEqual(leanTool(tool), {
    name: "t",
    title: "T",
    description: "d",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 },
        before: { type: "integer", exclusiveMinimum: 0 },
        offset: { type: "integer" },
        // Only integer nodes carry zod's artificial bounds; a number keeps whatever it declares.
        score: { type: "number", maximum: SAFE },
      },
      required: ["limit"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { n: { type: "integer", minimum: 0 } } },
  });
  // The input is never mutated: the SDK reuses the registered execution object.
  assert.deepEqual(tool.execution, { taskSupport: "forbidden" });
  assert.equal(tool.inputSchema.$schema, DRAFT7);
});

test("leanTool keeps what carries meaning: a non-default execution and the marker on dialect-sensitive schemas", () => {
  assert.deepEqual(leanTool({ name: "t", execution: { taskSupport: "optional" } }).execution, { taskSupport: "optional" });
  // Without $schema MCP reads 2020-12, where tuple `items`, `definitions` and `$ref` mean something else.
  for (const sensitive of [
    { type: "object", properties: { pair: { type: "array", items: [{ type: "string" }, { type: "integer" }] } } },
    { type: "object", definitions: { a: { type: "string" } }, properties: { x: { $ref: "#/definitions/a" } } },
    { type: "object", dependencies: { a: ["b"] } },
  ]) {
    assert.equal((leanTool({ name: "t", inputSchema: { $schema: DRAFT7, ...sensitive } }).inputSchema as Record<string, unknown>).$schema, DRAFT7);
  }
});

test("tools/list across every tool group carries no $schema, default execution, or safe-integer bound — and calls still validate", async () => {
  const saved = process.env.HUNCH_MCP_TOOLS;
  process.env.HUNCH_MCP_TOOLS = "all";
  const { root, cleanup } = tempStore();
  try {
    const server = buildServer(root);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lean-tool-list-test", version: "1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 40, `expected every group, got ${tools.length} tools`);
      const wire = JSON.stringify(tools);
      assert.ok(!wire.includes('"$schema"'), "a tool schema still carries $schema");
      assert.ok(!wire.includes(String(SAFE)), "a tool schema still carries a safe-integer bound");
      for (const t of tools) {
        assert.equal(t.execution, undefined, `${t.name} advertises the default execution`);
        assert.equal(t.inputSchema.type, "object", `${t.name} input schema is not an object`);
      }
      // The client caches the advertised outputSchema and validates structuredContent against it.
      const context = await client.callTool({ name: "hunch_context", arguments: { target: "src" } });
      assert.ok(!context.isError, JSON.stringify(context.content));
      assert.ok(context.structuredContent);
      // The registered zod schema still guards the call: an integer past the safe range is refused.
      const report = await client.callTool({ name: "hunch_report", arguments: { before: SAFE + 2 } });
      assert.equal(report.isError, true);
      assert.match(JSON.stringify(report.content), /Input validation error.*before/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup();
    if (saved === undefined) delete process.env.HUNCH_MCP_TOOLS; else process.env.HUNCH_MCP_TOOLS = saved;
  }
});
