import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { servedSummary } from "../src/core/served.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";

function mcpDeliveryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-delivery-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "context.ts"), "export const context = true;\n");

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", {
    id: "con_mcp_receipt",
    type: "architecture",
    statement: "MCP delivery metadata remains machine-readable.",
    scope: ["src/context.ts"],
    severity: "blocking",
    enforcement: "advisory_v1",
    match: null,
    forbids: null,
    rationale: "Orchestrators must not parse prose to recover receipts.",
    source_decision: null,
    violations: [],
    status: "active",
    valid_from: "2026-08-15T00:00:00.000Z",
    valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  });
  store.reindex();
  store.close();
  return root;
}

test("hunch_context exposes the delivery envelope and records exactly what MCP served", async (t) => {
  const root = mcpDeliveryFixture();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-delivery-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const contextTool = listed.tools.find((tool) => tool.name === "hunch_context");
  assert.ok(contextTool?.outputSchema, "tools/list advertises the structured delivery contract");
  assert.ok("delivered" in (contextTool.outputSchema.properties ?? {}));

  const result = await client.callTool({
    name: "hunch_context",
    arguments: { target: "src/context.ts", budget_tokens: 400 },
  });
  const structured = result.structuredContent as {
    text: string;
    delivered: Array<{
      kind: string;
      record_id: string;
      rank: number;
      delivery_reason: string;
      provenance_status: string;
      token_cost: number;
    }>;
    omitted: unknown[];
    budget_tokens: number;
    used_chars: number;
    blocking_overflow: boolean;
  };
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");

  assert.equal(text, structured.text, "legacy text and structured envelope describe the same delivery");
  assert.deepEqual(structured.delivered, [{
    kind: "constraints",
    record_id: "con_mcp_receipt",
    rank: 1,
    delivery_reason: "blocking-reserved",
    provenance_status: "current",
    token_cost: structured.delivered[0]?.token_cost,
  }]);
  assert.ok((structured.delivered[0]?.token_cost ?? 0) > 0);
  assert.deepEqual(structured.omitted, []);
  assert.equal(structured.budget_tokens, 400);
  assert.equal(structured.used_chars, [...structured.text].length);
  assert.equal(structured.blocking_overflow, false);

  const receipts = servedSummary(root);
  assert.equal(receipts.total, 1);
  assert.deepEqual(receipts.recent[0], {
    at: receipts.recent[0]?.at,
    session_id: null,
    event: "served",
    kind: "constraints",
    record_id: "con_mcp_receipt",
    target: "src/context.ts",
    rank: 1,
    delivery_reason: "blocking-reserved",
    provenance_status: "current",
    token_cost: structured.delivered[0]?.token_cost,
  });
});
