/**
 * The MCP binding of nuryel.state/1: four tools that are a thin transport over
 * src/store/stateBinding.ts. Exercised through a real MCP client over an in-memory
 * transport, so what an orchestrator sees (structuredContent, isError) is what is asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { buildServer } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { entityId, stateHash } from "../src/core/stateContract.js";

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
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  for (const name of ["nuryel_capabilities", "nuryel_read", "nuryel_write", "nuryel_subscribe", "nuryel_records"]) {
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
});
