import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";

/** Tools that an agent can plausibly confuse for one another. Each member's description
 *  must name at least one sibling behind a "Not for" boundary, so tool selection is routed
 *  by the description itself rather than by luck. Families outside this list (policy,
 *  constitution, project DNA) already disclaim authority and share a distinctive prefix. */
const SIBLING_FAMILIES: Record<string, string[]> = {
  orient: ["hunch_context", "hunch_why", "hunch_query", "hunch_structure", "hunch_runbook"],
  scope: ["hunch_check_constraints", "hunch_get_dependents", "hunch_blast_radius", "hunch_findings"],
  write: ["hunch_record_decision", "hunch_record_correction", "hunch_record_finding", "hunch_capture_decision"],
  verdict: ["hunch_merge_verdict", "hunch_pr_impact", "hunch_conformance", "hunch_change_proof"],
};

/** Every description is sent to the model on every session. A boundary sentence is worth
 *  its tokens; a paragraph is not. Longest existing description sits near 150 words. */
const MAX_WORDS = 200;

test("sibling tool families carry a 'Not for' boundary naming a sibling, and descriptions stay bounded", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-descriptions-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.close();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-descriptions-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((tool) => [tool.name, tool.description ?? ""]));

  for (const [family, members] of Object.entries(SIBLING_FAMILIES)) {
    for (const name of members) {
      const description = byName.get(name);
      assert.ok(description, `${name} is registered`);
      assert.match(description, /Not for /, `${family}: ${name} states what it is NOT for`);
      const siblings = members.filter((m) => m !== name);
      assert.ok(
        siblings.some((sibling) => description.includes(sibling)),
        `${family}: ${name} names at least one sibling (${siblings.join(", ")})`,
      );
    }
  }

  for (const [name, description] of byName) {
    if (!name.startsWith("hunch_")) continue;
    const words = description.trim().split(/\s+/).length;
    assert.ok(words <= MAX_WORDS, `${name} description is ${words} words; cap is ${MAX_WORDS}`);
  }
});

test("hunch_record_decision refuses a second live decision per topic with the Refused: prefix", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-refused-"));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.close();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-refused-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

  const first = await client.callTool({
    name: "hunch_record_decision",
    arguments: { decision: { title: "Sessions live in Redis", topic: "auth.session-storage", status: "accepted", decision: "Redis." } },
  });
  assert.ok(!first.isError, text(first));

  const second = await client.callTool({
    name: "hunch_record_decision",
    arguments: { decision: { title: "Sessions live in Postgres", topic: "auth.session-storage", status: "accepted", decision: "Postgres." } },
  });
  assert.ok(second.isError, "a second live decision for one topic is an error result");
  assert.match(text(second), /^Refused: /, "gate refusals start with the Refused: prefix");
  assert.match(text(second), /already has a live decision/);

  const bad = await client.callTool({ name: "hunch_merge_verdict", arguments: { base: "x", commit: "y" } });
  assert.ok(bad.isError);
  assert.match(text(bad), /^Invalid: /, "argument validation starts with the Invalid: prefix");
});
