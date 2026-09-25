import { cleanupDir, writeLocalPointer } from "./fixtures.js";
/**
 * The MCP binding of nuryel.state/1: four tools that are a thin transport over
 * src/store/stateBinding.ts. Exercised through a real MCP client over an in-memory
 * transport, so what an orchestrator sees (structuredContent, isError) is what is asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { entityId, stateHash } from "../src/core/stateContract.js";
import { writeLockPath } from "../src/serve/writelock.js";
// These suites exercise the specialist MCP tool groups; the everyday default hides them (src/mcp/toolset.ts).
process.env.HUNCH_MCP_TOOLS = "all";

const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "10042", version: "2", observed_at: "2026-09-07T12:00:00Z" };
const customer = entityId("customer", "דוגמה");

test("nuryel_* tools bind read / write / subscribe / capabilities over MCP with typed refusals", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-state-"));
  const seed = new HunchStore(hunchPaths(root));
  seed.json.ensureDirs();
  seed.reindex();
  seed.close();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-state-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(root);
  });

  const listed = await client.listTools();
  for (const name of ["nuryel_capabilities", "nuryel_read", "nuryel_write", "nuryel_subscribe", "nuryel_records", "nuryel_capture", "nuryel_capture_batch"]) {
    assert.ok(listed.tools.some((tool) => tool.name === name), `${name} is registered`);
  }

  const caps = await client.callTool({ name: "nuryel_capabilities", arguments: {} });
  const capabilities = caps.structuredContent as { protocol: string; repository: { kind: string; id: string }; partitions: string[] };
  assert.equal(capabilities.protocol, "nuryel.state/1");
  assert.equal(capabilities.repository.id, basename(root));
  const repo = capabilities.repository;
  const principal = { id: "sofia@david", kind: "agent", grants: [repo] };

  const base = { scope: repo, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ eventId: 10042 }) };
  const record = { schema: "nuryel.receipt/1", ...base, state: "verified", occurred_at: "2026-09-07T08:55:22Z", provenance: prov, invalidates: [customer] };
  const written = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "receipts", record, idempotency_key: "mcp-approval-a1" } });
  assert.ok(!written.isError, JSON.stringify(written.content));
  const result = written.structuredContent as { outcome: string; record_id: string; durability: string };
  assert.equal(result.outcome, "created");
  assert.match(result.record_id, /^nrc_[a-f0-9]{24}$/);
  assert.ok(["local", "committed", "pushed"].includes(result.durability));

  assert.ok(!existsSync(join(root, ".hunch", "write.lock")), "the MCP write took and released the partition write lock");
  assert.equal((result as { record?: { state?: string } }).record?.state, "verified", "the write result carries the stored record");
  const fetched = await client.callTool({ name: "nuryel_records", arguments: { principal, scope: repo, ids: [result.record_id, "nrc_000000000000000000000000"] } });
  const recs = fetched.structuredContent as { records: Record<string, { state?: string }>; facets: Record<string, string>; missing: string[] };
  assert.equal(recs.records[result.record_id]?.state, "verified");
  assert.equal(recs.facets[result.record_id], "receipts");
  assert.deepEqual(recs.missing, ["nrc_000000000000000000000000"]);
  const replay = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "receipts", record, idempotency_key: "mcp-approval-a1" } });
  assert.equal((replay.structuredContent as { outcome: string }).outcome, "replayed");

  const read = await client.callTool({ name: "nuryel_read", arguments: { principal, scope: repo, subject: customer } });
  assert.ok(!read.isError, JSON.stringify(read.content));
  const response = read.structuredContent as { receipt_id: string; state_of_record: { done: Array<{ id: string }>; invalidated_by: string[] }; denied_scopes: unknown[] };
  assert.match(response.receipt_id, /^hdr_[a-f0-9]{24}$/);
  assert.deepEqual(response.state_of_record.done.map((r) => r.id), [result.record_id]);
  assert.deepEqual(response.state_of_record.invalidated_by, [result.record_id]);
  assert.deepEqual(response.denied_scopes, []);
  assert.equal((response as { records?: Record<string, { state?: string }> }).records?.[result.record_id]?.state, "verified", "the record rides the read");
  assert.match((read.content as Array<{ text: string }>)[0]!.text, /State of record:\n- done receipt nrc_[a-f0-9]{24} · add_comment on crm event:10042 · verified/);

  const stream = await client.callTool({ name: "nuryel_subscribe", arguments: { principal, scope: repo, after_seq: 0 } });
  const changes = stream.structuredContent as { head_seq: number; events: Array<{ seq: number; change: string; record_id: string; cause: unknown }> };
  assert.equal(changes.head_seq, 1);
  assert.deepEqual(changes.events.map((e) => [e.seq, e.change, e.record_id]), [[1, "created", result.record_id]]);
  assert.deepEqual(changes.events[0]?.cause, { kind: "write", principal: "sofia@david" });

  const stranger = { id: "x", kind: "agent", grants: [{ kind: "user", id: "someone" }] };
  const refused = await client.callTool({ name: "nuryel_read", arguments: { principal: stranger, scope: repo, subject: customer } });
  assert.equal(refused.isError, true);
  assert.match((refused.content as Array<{ text: string }>)[0]!.text, /refused \[outside-grants\]/);

  const chosenId = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "receipts", record: { ...record, id: "nrc_000000000000000000000000" }, idempotency_key: "mcp-approval-a2" } });
  assert.equal(chosenId.isError, true);
  assert.match((chosenId.content as Array<{ text: string }>)[0]!.text, /refused \[identity\]/);

  const noHome = await client.callTool({ name: "nuryel_write", arguments: { principal: { ...principal, grants: [{ kind: "user", id: "david" }] }, scope: { kind: "user", id: "david" }, facet: "commitments", record: { provenance: prov }, idempotency_key: "mcp-no-home" } });
  assert.equal(noHome.isError, true);
  assert.match((noHome.content as Array<{ text: string }>)[0]!.text, /refused \[no-partition-home\]/);

  // The chain, rendered: a shipped receipt that rests on the first receipt and a change proof,
  // and a commitment closed by it — a reader follows the links from the text alone.
  const shippedBase = { scope: repo, actor: "claude-code@david", action_kind: "shipped", target: { system: "github", object_type: "pull_request", object_key: "acme/x#1", observed_at: "2026-09-09T11:00:00Z" }, request_fingerprint: stateHash({ pr: 1 }) };
  const restsOn = [
    { kind: "record", id: result.record_id, record_hash: result.record_hash },
    { kind: "external", ref: { system: "hunch", object_type: "change_proof", object_key: "hproof_813af1d712c7e16334c573e3", content_hash: stateHash({ proof: 1 }), observed_at: "2026-09-09T11:00:00Z" } },
  ];
  const shipped = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "receipts", record: { schema: "nuryel.receipt/1", ...shippedBase, state: "verified", occurred_at: "2026-09-09T11:00:00Z", invalidates: [customer], rests_on: restsOn, provenance: prov }, idempotency_key: "mcp-shipped-1" } });
  assert.ok(!shipped.isError, JSON.stringify(shipped.content));
  const shippedId = (shipped.structuredContent as { record_id: string }).record_id;
  const cBase = { scope: repo, subject: customer, title: "fix it", owner: "engineering", due: "2026-09-12" };
  const closed = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "commitments", record: { schema: "nuryel.commitment/1", ...cBase, status: "done", closed_by: shippedId, valid_from: "2026-09-08T09:05:00Z", valid_to: "2026-09-09T11:10:00Z", provenance: prov }, idempotency_key: "mcp-closed-1" } });
  assert.ok(!closed.isError, JSON.stringify(closed.content));
  const chain = await client.callTool({ name: "nuryel_read", arguments: { principal, scope: repo, subject: customer } });
  const chainText = (chain.content as Array<{ text: string }>)[0]!.text;
  assert.match(chainText, new RegExp(`- done receipt ${shippedId} · shipped on github pull_request:acme/x#1 · verified[^\\n]*\\n    rests on record ${result.record_id}\\n    rests on hunch change_proof:hproof_813af1d712c7e16334c573e3`));
  assert.match(chainText, new RegExp(`- done commitment ncm_[a-f0-9]{24} · done · due 2026-09-12 · owner engineering: fix it · closed by ${shippedId}`));
  const chainSor = (chain.structuredContent as { state_of_record: { depends_on: unknown[]; in_force: unknown[] } }).state_of_record;
  assert.equal(chainSor.depends_on.length, 2, "what the closure rests on rides the read");
  assert.deepEqual(chainSor.in_force, []);
  const badClose = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repo, facet: "commitments", record: { schema: "nuryel.commitment/1", ...cBase, title: "other", status: "done", closed_by: "nrc_000000000000000000000000", valid_from: "2026-09-08T09:05:00Z", valid_to: "2026-09-09T11:10:00Z", provenance: prov }, idempotency_key: "mcp-closed-bad" } });
  assert.equal(badClose.isError, true);
  assert.match((badClose.content as Array<{ text: string }>)[0]!.text, /refused \[conflict\].*write the receipt first/s);
});

test("MCP state writes lock the selected shared overlay home", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-mcp-overlay-lock-"));
  const root = join(dir, "repo");
  const overlayRoot = join(dir, "memory");
  const overlay = join(overlayRoot, ".hunch");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["init", "-q", overlayRoot]);
  writeLocalPointer(root, { privateDir: overlay, mode: "shared", autoCommit: false });
  const seed = new HunchStore(hunchPaths(root));
  seed.json.ensureDirs();
  seed.reindex();
  seed.close();
  const server = buildServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-overlay-lock-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    cleanupDir(dir);
  });

  const caps = await client.callTool({ name: "nuryel_capabilities", arguments: {} });
  const repository = (caps.structuredContent as { repository: { kind: string; id: string } }).repository;
  const principal = { id: "sofia@david", kind: "agent", grants: [repository] };
  const stale = JSON.stringify({ pid: 999_999, host: hostname(), nonce: "stale", at: new Date(0).toISOString() });
  const publicLock = writeLockPath(join(root, ".hunch"));
  const overlayLock = writeLockPath(overlay);
  writeFileSync(publicLock, stale);
  writeFileSync(overlayLock, stale);
  const old = new Date(Date.now() - 2 * 60_000);
  utimesSync(publicLock, old, old);
  utimesSync(overlayLock, old, old);

  const record = {
    schema: "nuryel.receipt/1",
    scope: repository,
    actor: "sofia@david",
    action_kind: "add_comment",
    target: { system: "crm", object_type: "event", object_key: "overlay-lock", observed_at: "2026-09-13T00:00:00Z" },
    request_fingerprint: stateHash({ overlayLock: true }),
    state: "verified",
    occurred_at: "2026-09-13T00:00:00Z",
    provenance: prov,
    invalidates: [],
  };
  const result = await client.callTool({ name: "nuryel_write", arguments: { principal, scope: repository, facet: "receipts", record, idempotency_key: "mcp-overlay-lock-1" } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.ok(existsSync(publicLock), "MCP did not steal the unrelated public lock");
  assert.equal(existsSync(overlayLock), false, "MCP acquired and released the shared overlay lock");
});

test("MCP preserves and renders exact field citations without implying verified support", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mcp-citations-"));
  const seed = new HunchStore(hunchPaths(root)); seed.json.ensureDirs(); seed.reindex(); seed.close();
  const server = buildServer(root), client = new Client({ name: "citation-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanupDir(root); });
  const scope = { kind: "repository", id: basename(root) }, principal = { id: "writer", kind: "agent", grants: [scope] };
  const dep = { kind: "external", ref: crmEvent }, content = '{"count":0,"confirmed":false}';
  const field_provenance = [{ selector: { kind: "json_pointer", path: "/count" }, value_hash: stateHash(0), dependency_hashes: [stateHash(dep)] }];
  const record = { schema: "nuryel.derived/1", scope, subject: "event:10042", content, content_hash: stateHash(content), dependencies: [dep], transform_version: "cited/v1", computed_at: "2026-09-13T10:00:00Z", valid_to: null, state: "current", provenance: prov, field_provenance };
  const written = await client.callTool({ name: "nuryel_write", arguments: { principal, scope, facet: "derived", record, idempotency_key: "cited-mcp-write" } });
  assert.ok(!written.isError, JSON.stringify(written.content));
  const id = (written.structuredContent as { record_id: string }).record_id;
  const read = await client.callTool({ name: "nuryel_read", arguments: { principal, scope, subject: "event:10042" } });
  assert.ok(!read.isError, JSON.stringify(read.content));
  assert.deepEqual((read.structuredContent as { records: Record<string, { field_provenance: unknown }> }).records[id]?.field_provenance, field_provenance);
  const text = (read.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /field \/count: 0 ← crm event:10042/);
  assert.match(text, /not verified support or freshness/);
});
