import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/mcp/server.js";
import { decisionId } from "../src/core/ids.js";

type ToolText = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function decisionRepo(): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-decision-collision-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Decision Collision Test");
  git(root, "config", "user.email", "decision-collision@example.invalid");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), `${JSON.stringify({ autoCommit: false })}\n`);
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

async function connect(root: string): Promise<{ client: Client; server: McpServer }> {
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "decision-collision-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function record(client: Client, decision: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({
    name: "hunch_record_decision",
    arguments: { decision },
  })) as ToolText;
  return {
    isError: !!result.isError,
    text: result.content.map((item) => item.text ?? "").join("\n"),
  };
}

test("same commit cannot silently replace a different human-confirmed decision", async (t) => {
  const { root, sha } = decisionRepo();
  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const first = await record(client, {
    title: "Decision A",
    topic: "decision-a",
    context: "first",
    decision: "Choose A",
    commit: sha,
  });
  assert.equal(first.isError, false, first.text);

  const id = decisionId(sha);
  const file = join(root, ".hunch", "decisions", `${id}.json`);
  const before = readFileSync(file, "utf8");
  const second = await record(client, {
    title: "Decision B",
    topic: "decision-b",
    context: "second",
    decision: "Choose B",
    commit: sha,
  });

  assert.equal(second.isError, true, `the second capture must be refused, got: ${second.text}`);
  assert.match(second.text, /already identifies a different human-confirmed decision/i);
  assert.equal(readFileSync(file, "utf8"), before, "the first decision remains byte-for-byte unchanged");

  const topicless = await record(client, {
    title: "Decision C",
    context: "third",
    decision: "Choose C",
    commit: sha,
  });
  assert.equal(topicless.isError, true, `omitting a topic must not bypass the collision guard: ${topicless.text}`);
  assert.equal(readFileSync(file, "utf8"), before, "the first decision remains unchanged after a topicless collision");
});

test("a human capture still upgrades the machine draft for its commit", async (t) => {
  const { root, sha } = decisionRepo();
  const id = decisionId(sha);
  const file = join(root, ".hunch", "decisions", `${id}.json`);
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    id,
    title: "Machine draft",
    topic: null,
    status: "accepted",
    context: "draft",
    decision: "Draft choice",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["app.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: sha,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "llm_draft", confidence: 0.5, evidence: [`commit:${sha}`] },
    date: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`);

  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const result = await record(client, {
    title: "Human decision",
    topic: "human-topic",
    context: "human rationale",
    decision: "Confirmed choice",
    commit: sha,
  });
  assert.equal(result.isError, false, result.text);

  const upgraded = JSON.parse(readFileSync(file, "utf8")) as {
    title: string;
    topic: string | null;
    provenance: { source: string };
  };
  assert.equal(upgraded.title, "Human decision");
  assert.equal(upgraded.topic, "human-topic");
  assert.equal(upgraded.provenance.source, "llm_draft+human_confirmed");
});

test("same-topic human re-record may refine the title without minting a duplicate", async (t) => {
  const { root, sha } = decisionRepo();
  const { client, server } = await connect(root);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* temp only */ }
  });

  const first = await record(client, {
    title: "Initial wording",
    topic: "stable-topic",
    decision: "Choice",
    commit: sha,
  });
  assert.equal(first.isError, false, first.text);

  const second = await record(client, {
    title: "Clearer wording",
    topic: "stable-topic",
    decision: "Choice, clarified",
    commit: sha,
  });
  assert.equal(second.isError, false, second.text);

  const saved = JSON.parse(readFileSync(
    join(root, ".hunch", "decisions", `${decisionId(sha)}.json`),
    "utf8",
  )) as { title: string; topic: string };
  assert.equal(saved.title, "Clearer wording");
  assert.equal(saved.topic, "stable-topic");
});
