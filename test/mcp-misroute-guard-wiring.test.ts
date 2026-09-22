import { cleanupDir } from "./fixtures.js";
/**
 * Wiring the worktree-misroute guard (test/mcp-misroute-guard.test.ts covers its
 * detection core) into the four auto-committing write tools that carry file
 * evidence: hunch_record_decision, hunch_record_correction, hunch_record_finding,
 * and nuryel_write (across its decisions/findings/bugs/constraints facets).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServerWithRootControl } from "../src/mcp/server.js";

process.env.HUNCH_MCP_TOOLS = "all"; // exercise nuryel_write alongside the three legacy tools

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repo(prefix = "hunch-misroute-wire-"): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  git(root, "init", "-q");
  git(root, "config", "user.email", "mcp-misroute-wire@example.invalid");
  git(root, "config", "user.name", "MCP Misroute Wiring Test");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "seed.json"), "{}\n");
  writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  // Match the slash spelling emitted by Git's worktree porcelain on Windows.
  return process.platform === "win32" ? root.replace(/\\/g, "/") : root;
}

function repoWithWorktree(): { root: string; worktree: string; cleanup: () => void } {
  const root = repo();
  const worktree = `${root}-wt`;
  git(root, "worktree", "add", "-q", "-b", "feature-misroute-wire", worktree);
  return {
    root,
    worktree,
    cleanup: () => {
      try { git(root, "worktree", "remove", "--force", worktree); } catch { /* best effort */ }
      try { cleanupDir(worktree); } catch { /* temp only */ }
      try { cleanupDir(root); } catch { /* temp only */ }
    },
  };
}

async function connectedClient(root: string): Promise<{
  client: Client;
  control: ReturnType<typeof buildServerWithRootControl>;
  close: () => Promise<void>;
}> {
  const control = buildServerWithRootControl(root);
  const client = new Client({ name: "misroute-guard-wiring-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([control.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    control,
    close: async () => {
      await client.close().catch(() => {});
      await control.server.close().catch(() => {});
    },
  };
}

function seedSiblingFile(fixture: { root: string; worktree: string }, name: string): void {
  writeFileSync(join(fixture.worktree, name), "export const x = 1;\n");
  git(fixture.worktree, "add", "-A");
  git(fixture.worktree, "commit", "-qm", `add ${name}`);
}

test("hunch_record_decision refuses a write whose related_files exist only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "decision-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const result = await client.callTool({
    name: "hunch_record_decision",
    arguments: { decision: { title: "misrouted decision", related_files: ["decision-evidence.ts"] } },
  }) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(fixture.worktree), `refusal should name the worktree: ${text}`);
  assert.ok(/cwd/.test(text), `refusal should mention retrying with cwd: ${text}`);
});

test("hunch_record_correction refuses a write whose scope_hint_file exists only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "correction-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const result = await client.callTool({
    name: "hunch_record_correction",
    arguments: { rule: "never do the thing", scope_hint_file: "correction-evidence.ts" },
  }) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(fixture.worktree), `refusal should name the worktree: ${text}`);
});

test("hunch_record_finding refuses a write whose affected_files exist only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "finding-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const result = await client.callTool({
    name: "hunch_record_finding",
    arguments: { finding: { title: "misrouted finding", observation: "saw a thing", affected_files: ["finding-evidence.ts"] } },
  }) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(fixture.worktree), `refusal should name the worktree: ${text}`);
});

async function nuryelPrincipalAndScope(client: Client): Promise<{ principal: Record<string, unknown>; scope: Record<string, unknown> }> {
  const caps = await client.callTool({ name: "nuryel_capabilities", arguments: {} });
  const repository = (caps.structuredContent as { repository: Record<string, unknown> }).repository;
  return { principal: { id: "misroute-test@agent", kind: "agent", grants: [repository] }, scope: repository };
}

test("nuryel_write refuses a decisions-facet write whose related_files exist only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "nuryel-decision-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const { principal, scope } = await nuryelPrincipalAndScope(client);
  const result = await client.callTool({
    name: "nuryel_write",
    arguments: {
      principal, scope, facet: "decisions",
      record: { title: "misrouted nuryel decision", related_files: ["nuryel-decision-evidence.ts"] },
      idempotency_key: "misroute-decisions-1",
    },
  }) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.ok(text.includes(fixture.worktree), `refusal should name the worktree: ${text}`);
  assert.ok(/scope/.test(text), `nuryel_write's refusal should call out moving scope too: ${text}`);
});

test("nuryel_write refuses a findings-facet write whose affected_files exist only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "nuryel-finding-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const { principal, scope } = await nuryelPrincipalAndScope(client);
  const result = await client.callTool({
    name: "nuryel_write",
    arguments: {
      principal, scope, facet: "findings",
      record: { title: "misrouted nuryel finding", affected_files: ["nuryel-finding-evidence.ts"] },
      idempotency_key: "misroute-findings-1",
    },
  }) as { isError?: boolean };
  assert.equal(result.isError, true);
});

test("nuryel_write refuses a bugs-facet write whose affected_files exist only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "nuryel-bug-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const { principal, scope } = await nuryelPrincipalAndScope(client);
  const result = await client.callTool({
    name: "nuryel_write",
    arguments: {
      principal, scope, facet: "bugs",
      record: { title: "misrouted nuryel bug", affected_files: ["nuryel-bug-evidence.ts"] },
      idempotency_key: "misroute-bugs-1",
    },
  }) as { isError?: boolean };
  assert.equal(result.isError, true);
});

test("nuryel_write refuses a constraints-facet write whose scope exists only in a sibling worktree", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "nuryel-constraint-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const { principal, scope } = await nuryelPrincipalAndScope(client);
  const result = await client.callTool({
    name: "nuryel_write",
    arguments: {
      principal, scope, facet: "constraints",
      record: { statement: "misrouted nuryel constraint", scope: ["nuryel-constraint-evidence.ts"] },
      idempotency_key: "misroute-constraints-1",
    },
  }) as { isError?: boolean };
  assert.equal(result.isError, true);
});

test("a write in the correct worktree (matching cwd hint) is never refused by the guard", async (t) => {
  const fixture = repoWithWorktree();
  seedSiblingFile(fixture, "same-place-evidence.ts");
  const { client, close } = await connectedClient(fixture.root);
  t.after(async () => { await close(); fixture.cleanup(); });

  const result = await client.callTool({
    name: "hunch_record_decision",
    arguments: {
      decision: { title: "correctly-routed decision", related_files: ["same-place-evidence.ts"] },
      cwd: fixture.worktree,
    },
  }) as { isError?: boolean };
  assert.equal(!!result.isError, false);
});
