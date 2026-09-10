import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { currentInitiator, initiatorChildEnv } from "../src/synthesis/initiator.js";

test("real MCP client handshakes bind isolated origins to registered callbacks", async () => {
  const results = await Promise.all(["Claude Code", "codex-mcp-client", "Kimi", "unknown-editor"].map(async name => {
    const root = mkdtempSync(join(tmpdir(), "hunch-mcp-origin-"));
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.close();
    const server = buildServer(root);
    server.registerTool("test_origin", { inputSchema: {} }, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { content: [{ type: "text" as const, text: JSON.stringify({
        origin: currentInitiator(), child: initiatorChildEnv({ CODEX_THREAD_ID: "server-host" }).HUNCH_INITIATOR,
      }) }] };
    });
    const client = new Client({ name, version: "1.0.0" });
    try {
      const [c, s] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(s), client.connect(c)]);
      const result = await client.callTool({ name: "test_origin", arguments: {} });
      assert.ok(!result.isError);
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    } finally {
      await client.close();
      await server.close();
      assert.ok(resolve(root).startsWith(resolve(tmpdir())));
      rmSync(root, { recursive: true, force: true });
    }
  }));
  assert.deepEqual(results.map(r => r.origin.provider), ["claude-cli", "codex-cli", "kimi-cli", null]);
  assert.deepEqual(results.map(r => r.child), ["claude-cli", "codex-cli", "kimi-cli", "unknown"]);
});
