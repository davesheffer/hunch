import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findingId } from "../src/core/ids.js";
import { buildServer } from "../src/mcp/server.js";

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function findingRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-finding-provenance-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "MCP finding provenance test");
  git(root, "config", "user.email", "mcp-finding-provenance@example.invalid");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), '{"autoCommit":false}\n');
  return root;
}

async function connect(root: string): Promise<{ client: Client; server: McpServer }> {
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-finding-provenance-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function record(client: Client, finding: Record<string, unknown>): Promise<ToolText> {
  return await client.callTool({ name: "hunch_record_finding", arguments: { finding } }) as ToolText;
}

function persisted(root: string, title: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, ".hunch", "findings", `${findingId(title)}.json`), "utf8"));
}

test("hunch_record_finding MCP capture is advisory agent testimony", async (t) => {
  const root = findingRepo();
  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(root);
  });

  const result = await record(client, {
    title: "unscoped query audit",
    observation: "the query omitted tenant scoping",
    evidence: ["test:mcp-finding-provenance"],
  });
  assert.equal(result.isError, undefined, result.content.map((item) => item.text ?? "").join("\n"));

  const saved = persisted(root, "unscoped query audit");
  assert.deepEqual(saved.provenance, {
    source: "agent_recorded",
    confidence: 0.75,
    evidence: ["test:mcp-finding-provenance"],
    last_verified: saved.provenance.last_verified,
  });
  assert.match(saved.provenance.last_verified, /^20\d\d-\d\d-\d\dT/);
});

test("updating a human-confirmed finding through MCP cannot mint new human testimony", async (t) => {
  const root = findingRepo();
  const title = "human finding to reverify";
  const id = findingId(title);
  mkdirSync(join(root, ".hunch", "findings"), { recursive: true });
  writeFileSync(join(root, ".hunch", "findings", `${id}.json`), `${JSON.stringify({
    id,
    title,
    observation: "the original human observation",
    evidence: ["human:review"],
    method: null,
    severity: "high",
    triage: "open",
    affected_files: ["app.ts"],
    affected_symbols: [],
    violates_constraint: null,
    spawned_decision: null,
    observed_at: "2026-01-01T00:00:00.000Z",
    resolved_commit: null,
    provenance: {
      source: "human_confirmed",
      confidence: 1,
      evidence: ["human:review"],
      last_verified: "2026-01-01T00:00:00.000Z",
    },
  }, null, 2)}\n`);

  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(root);
  });

  const result = await record(client, {
    title,
    observation: "the agent re-ran the audit and still found it",
    evidence: ["agent:rerun"],
  });
  assert.equal(result.isError, undefined, result.content.map((item) => item.text ?? "").join("\n"));

  const saved = persisted(root, title);
  assert.equal(saved.provenance.source, "agent_recorded");
  assert.equal(saved.provenance.confidence, 0.75);
  assert.deepEqual(saved.provenance.evidence, ["agent:rerun"]);
  assert.equal(saved.observed_at, "2026-01-01T00:00:00.000Z", "reverification keeps the first observation date");
});
