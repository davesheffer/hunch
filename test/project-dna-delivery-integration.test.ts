import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { discoverProjectDna } from "../src/core/projectDna.js";
import { projectDnaDeliverySupplement } from "../src/core/projectDnaDelivery.js";
import { hunchPaths } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
// These suites exercise specialist MCP tool groups; the everyday default hides them (src/mcp/toolset.ts).
process.env.HUNCH_MCP_TOOLS = "all";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch DNA delivery test",
  GIT_AUTHOR_EMAIL: "hunch-dna-delivery@example.test",
  GIT_COMMITTER_NAME: "Hunch DNA delivery test",
  GIT_COMMITTER_EMAIL: "hunch-dna-delivery@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("a sealed DNA profile becomes a bounded advisory delivery supplement", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-delivery-"));
  t.after(() => cleanupDir(root));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "CONTRIBUTING.md"), "Behavior changes must include tests. Keep pull requests small and focused.\n");
  writeFileSync(join(root, "value.txt"), "0\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fix: initialize mutation fixture");
  for (let index = 1; index <= 5; index++) {
    writeFileSync(join(root, "value.txt"), `${index}\n`);
    git(root, "add", "value.txt");
    git(root, "commit", "-qm", `fix: update mutation fixture ${index}`);
  }

  const profile = discoverProjectDna(root);
  const supplement = projectDnaDeliverySupplement(profile, 3);
  assert.ok(supplement);
  assert.equal(supplement.id, profile.profile_id);
  assert.equal(supplement.kind, "project-dna");
  assert.equal(supplement.priority, 425);
  assert.match(supplement.text, /PROJECT DNA/);
  assert.match(supplement.text, new RegExp(profile.repository_revision));
  assert.match(supplement.text, /never override Hunch decisions, constraints, policy/i);
  assert.equal((supplement.text.match(/^• /gm) ?? []).length <= 4, true, "trait cap plus optional omission marker stays bounded");
});

test("normal MCP context delivery includes Project DNA and exposes sealed profile deltas", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-mcp-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "CONTRIBUTING.md"), "Behavior changes must include tests. Keep pull requests small and focused.\n");
  writeFileSync(join(root, "value.txt"), "0\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fix: initialize mutation fixture");
  for (let index = 1; index <= 5; index++) {
    writeFileSync(join(root, "value.txt"), `${index}\n`);
    git(root, "add", "value.txt");
    git(root, "commit", "-qm", `fix: update mutation fixture ${index}`);
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.reindex();
  store.close();

  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "project-dna-mcp-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(root);
  });

  const tools = (await client.listTools()).tools;
  assert.ok(tools.some((tool) => tool.name === "hunch_project_dna" && tool.outputSchema));
  assert.ok(tools.some((tool) => tool.name === "hunch_project_dna_delta" && tool.outputSchema));

  const context = await client.callTool({
    name: "hunch_context",
    arguments: { target: "mutation fixture", budget_tokens: 900 },
  });
  const contextEnvelope = context.structuredContent as {
    text: string;
    supplements: Array<{ id: string; kind: string; delivered: boolean }>;
  };
  assert.match(contextEnvelope.text, /PROJECT DNA/);
  assert.equal(contextEnvelope.supplements.some((item) => item.kind === "project-dna" && item.delivered), true);

  const deltaResult = await client.callTool({
    name: "hunch_project_dna_delta",
    arguments: { from_ref: "HEAD~1", to_ref: "HEAD" },
  });
  const delta = deltaResult.structuredContent as { schema: string; repository_id: string; changed: boolean };
  assert.equal(delta.schema, "hunch.project-dna-delta/1");
  assert.match(delta.repository_id, /^pdnar_[a-f0-9]{24}$/);
  assert.equal(delta.changed, true);
});
