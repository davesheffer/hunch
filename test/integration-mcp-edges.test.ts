import { cleanupDir, tempDir } from "./fixtures.js";
/**
 * End-to-end coverage of the component edges that cross OUT of src/mcp (and the one
 * that crosses INTO it from src/core): a real MCP client over an in-memory transport
 * drives buildServer, and each test asserts on the downstream module's observable
 * effect — files on disk, git history, lock ordering, measured surfaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { stateHash } from "../src/core/stateContract.js";
import { withWriteLock, writeLockPath } from "../src/serve/writelock.js";
import { generateWiki, publicHome } from "../src/wiki/wiki.js";
import { measureFootprint } from "../src/core/footprint.js";
import { mkConstraint } from "./helpers.js";
// The wiki-status and nuryel_* tools sit outside the everyday default toolset (src/mcp/toolset.ts).
process.env.HUNCH_MCP_TOOLS = "all";

type Mcp = { client: Client; close: () => Promise<void> };

async function connect(root: string): Promise<Mcp> {
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integration-mcp-edges", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); } };
}

function seedStore(root: string, extra?: (store: HunchStore) => void): void {
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    extra?.(store);
    store.reindex();
  } finally {
    store.close();
  }
}

const text = (r: { content?: unknown }): string =>
  ((r.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("\n");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("mcp->integrations: hunch_record_correction refreshes existing CLAUDE.md grounding in place (manual mode)", async (t) => {
  const root = tempDir("hunch-edge-grounding-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "billing.ts"), "export const charge = () => 1;\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Project notes\n\nHand-written prose that must survive.\n");
  seedStore(root);
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));
  const mcp = await connect(root);
  t.after(async () => { await mcp.close(); cleanupDir(root); });

  const rule = "never round invoice totals before tax";
  const res = await mcp.client.callTool({ name: "hunch_record_correction", arguments: { rule, scope_hint_file: "src/billing.ts" } });
  assert.ok(!res.isError, text(res));

  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.match(claude, /Hand-written prose that must survive\./, "user prose is preserved by the merge-writer");
  assert.match(claude, /<!-- HUNCH:START/, "the integration rendered its grounding block");
  assert.ok(claude.includes(rule), "the new rule propagated into the committed grounding doc");
  assert.ok(!existsSync(join(root, "AGENTS.md")), "refresh-only: no grounding doc is scaffolded that the project does not have");
});

test("mcp->integrations: hunch_record_correction auto-commits the captured constraint into git (flushCapture)", async (t) => {
  const root = tempDir("hunch-edge-flush-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "edge@test.invalid");
  git(root, "config", "user.name", "Edge Test");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "billing.ts"), "export const charge = () => 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "feat/test"); // capture auto-commits skip the default branch (1.47.1)
  seedStore(root);
  const mcp = await connect(root);
  t.after(async () => { await mcp.close(); cleanupDir(root); });

  const res = await mcp.client.callTool({ name: "hunch_record_correction", arguments: { rule: "never retry a declined card charge", scope_hint_file: "src/billing.ts" } });
  assert.ok(!res.isError, text(res));

  const ids = readdirSync(join(root, ".hunch", "constraints")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  assert.equal(ids.length, 1, "exactly one constraint captured");
  const id = ids[0]!;
  assert.equal(git(root, "log", "-1", "--format=%s"), `hunch: capture ${id}`, "the integration created the memory commit");
  const files = git(root, "show", "--name-only", "--format=", "HEAD").split(/\r?\n/);
  assert.ok(files.includes(`.hunch/constraints/${id}.json`), `HEAD carries the constraint record: ${files.join(", ")}`);
  assert.equal(git(root, "status", "--porcelain", "--", `.hunch/constraints/${id}.json`), "", "the record is clean in the worktree after the flush");
});

test("mcp->wiki: hunch_wiki_status reports a generated wiki fresh, then flags a hand-edited page", async (t) => {
  const root = tempDir("hunch-edge-wiki-");
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  writeFileSync(join(root, "src", "auth", "session.ts"), "export function verifySession(t: string) { return t; }\n");
  writeFileSync(join(root, "src", "auth", "token.ts"), "export function mint() { return 'x'; }\n");
  const store = new HunchStore(hunchPaths(root));
  let written: string[];
  try {
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    store.reindex();
    written = (await generateWiki(store, root, publicHome(root), { now: "2026-10-22T00:00:00.000Z", only: "all" })).written;
  } finally {
    store.close();
  }
  const mcp = await connect(root);
  t.after(async () => { await mcp.close(); cleanupDir(root); });

  const fresh = await mcp.client.callTool({ name: "hunch_wiki_status", arguments: {} });
  assert.ok(!fresh.isError, text(fresh));
  assert.match(text(fresh), /Everything fresh/, text(fresh));
  assert.doesNotMatch(text(fresh), /No wiki adopted/);

  const page = written.find((p) => p.endsWith(".md") && !/\/(index|now|specs|graph)\.md$/.test(p.replace(/\\/g, "/")));
  assert.ok(page, `a component page was generated: ${written.join(", ")}`);
  const abs = join(root, ...page.replace(/\\/g, "/").split("/"));
  writeFileSync(abs, readFileSync(abs, "utf8") + "\nA hand edit.\n");
  const stale = await mcp.client.callTool({ name: "hunch_wiki_status", arguments: {} });
  assert.ok(!stale.isError, text(stale));
  assert.doesNotMatch(text(stale), /Everything fresh/);
  assert.match(text(stale), /edited by hand/, text(stale));
});

test("mcp->wiki: hunch_now surfaces a live proposed decision on the roadmap via nowData", async (t) => {
  const root = tempDir("hunch-edge-now-");
  seedStore(root);
  const mcp = await connect(root);
  t.after(async () => { await mcp.close(); cleanupDir(root); });

  const before = await mcp.client.callTool({ name: "hunch_now", arguments: {} });
  assert.match(text(before), /Roadmap — live proposed decisions \(0\)/, text(before));

  const rec = await mcp.client.callTool({ name: "hunch_record_decision", arguments: {
    decision: { title: "Adopt a ledger for edge receipts", topic: "edge.receipts", decision: "Receipts go to an append-only ledger.", status: "proposed" },
  } });
  assert.ok(!rec.isError, text(rec));

  const after = await mcp.client.callTool({ name: "hunch_now", arguments: {} });
  const body = text(after);
  assert.match(body, /Roadmap — live proposed decisions \(1\)/, body);
  assert.match(body, /• Adopt a ledger for edge receipts/, body);
});

test("mcp->serve: nuryel_write waits on the partition write lock held by another writer", async (t) => {
  const root = tempDir("hunch-edge-lock-");
  seedStore(root);
  const mcp = await connect(root);
  t.after(async () => { await mcp.close(); cleanupDir(root); });

  const caps = await mcp.client.callTool({ name: "nuryel_capabilities", arguments: {} });
  const repo = (caps.structuredContent as { repository: { kind: string; id: string } }).repository;
  const principal = { id: "edge@test", kind: "agent", grants: [repo] };
  const record = {
    schema: "nuryel.receipt/1", scope: repo, actor: "edge@test", action_kind: "add_comment",
    target: { system: "crm", object_type: "event", object_key: "77", version: "1", observed_at: "2026-10-22T00:00:00Z" },
    request_fingerprint: stateHash({ eventId: 77 }), state: "verified", occurred_at: "2026-10-22T00:00:00Z",
    provenance: { source: "imported:edge", confidence: 0.9, evidence: ["edge row 77"] },
  };

  const hunchDir = hunchPaths(root).hunch;
  const order: string[] = [];
  let release!: () => void;
  let lockTaken!: () => void;
  const taken = new Promise<void>((r) => { lockTaken = r; });
  const holder = withWriteLock(hunchDir, async () => {
    order.push("holder:acquired");
    lockTaken();
    await new Promise<void>((r) => { release = r; });
    order.push("holder:released");
  });
  await taken;
  assert.ok(existsSync(writeLockPath(hunchDir)), "the serve lock file is held");

  const write = mcp.client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "receipts", record, idempotency_key: "edge-lock-1" } })
    .then((r) => { order.push("write:done"); return r; });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(order, ["holder:acquired"], "the MCP write is blocked while another writer holds the lock");

  release();
  await holder;
  const result = await write;
  assert.ok(!result.isError, text(result));
  assert.deepEqual(order, ["holder:acquired", "holder:released", "write:done"]);
  assert.equal((result.structuredContent as { outcome: string }).outcome, "created");
  assert.ok(!existsSync(writeLockPath(hunchDir)), "the write released the lock it took");
});

test("core->mcp: measureFootprint measures the live MCP tool surface and hunch_context result", async (t) => {
  const root = tempDir("hunch-edge-footprint-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "edge.ts"), "export const edge = 1;\n");
  seedStore(root, (store) => {
    store.json.put("constraints", mkConstraint({ id: "con_edge_footprint", statement: "Edge module results stay machine-readable.", scope: ["src/edge.ts"] }));
  });
  const mcp = await connect(root);
  t.after(async () => { await mcp.close(); cleanupDir(root); });
  const tools = (await mcp.client.listTools()).tools;

  const report = await measureFootprint(root, { target: "src/edge.ts" });
  const byId = new Map(report.surfaces.map((s) => [s.id, s]));
  const list = byId.get("mcp.tools_list");
  assert.ok(list, "the tools/list surface was measured through buildServer");
  assert.equal(list.detail?.tools, tools.length, "footprint saw exactly the tools the MCP server registers");
  assert.equal(list.detail?.description_chars, tools.reduce((n, tl) => n + (tl.description ?? "").length, 0));
  const ctx = byId.get("mcp.hunch_context");
  assert.ok(ctx && ctx.chars > 0, "hunch_context was called over MCP and its result measured");
  for (const id of ["mcp.hunch_task.start", "mcp.hunch_task.finish"]) {
    assert.ok((byId.get(id)?.chars ?? 0) > 0, `${id} measured from a real MCP task lifecycle`);
  }
});
