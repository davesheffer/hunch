import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";
import { createServeApp } from "../src/serve/app.js";
import { initServeConfig, readServeConfig } from "../src/serve/config.js";
import { createStateClient } from "../src/client/state.js";
import { stateHash, type CaptureBatchResult } from "../src/core/stateContract.js";

test("MCP and HTTP share capture identity, lock, readback and per-item refusals", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-capture-bindings-"));
  const root = join(sandbox, "drawer"), file = join(sandbox, "serve.json");
  const scope = { kind: "user" as const, id: "david" };
  const init = initServeConfig({ file, scope, root, principal: { id: "codex@david", kind: "agent" } });
  const app = createServeApp(readServeConfig(file));
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "capture-test", version: "1" });
  try {
    await Promise.all([mcp.connect(ct), server.connect(st), new Promise<void>(r => app.listen(0, "127.0.0.1", r))]);
    const address = app.address(); assert.ok(address && typeof address === "object");
    const http = createStateClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: init.token! });
    const principal = { id: "kimi@david", kind: "agent", grants: [scope] };
    const source = { ref: { system: "crm", object_type: "note", object_key: "shared-note", observed_at: "2026-09-10T12:00:00Z" }, source_text: "Use the west entrance. Call Dana on Thursday." };
    const observation = { subject: "customer:test", statement: "Use the west entrance.", relevance: { use: "operational_fact" as const, reason: "Choose the correct entrance for visits." }, evidence: [{ source: 0, excerpt: "Use the west entrance." }] };
    const request = { scope, sources: [source], observations: [observation] };
    const concurrent = await Promise.all([
      http.captureBatch(request),
      mcp.callTool({ name: "nuryel_capture_batch", arguments: { principal, ...request } }).then(r => { assert.ok(!r.isError, JSON.stringify(r)); return r.structuredContent as CaptureBatchResult; }),
      http.captureBatch(request),
    ]);
    const writes = concurrent.flatMap(r => r.results).map(r => { assert.equal(r.status, "saved"); if (r.status !== "saved") throw new Error("refused"); return r.result; });
    assert.equal(writes.filter(r => r.outcome === "created").length, 1);
    assert.equal(new Set(writes.map(r => r.record_id)).size, 1);
    const single = await http.capture({ scope, subject: observation.subject, statement: observation.statement, relevance: observation.relevance, evidence: [{ ...source, excerpt: observation.evidence[0]!.excerpt }] });
    assert.equal(single.outcome, "replayed");
    const read = await mcp.callTool({ name: "nuryel_read", arguments: { principal: { ...principal, id: "claude@david" }, scope, subject: observation.subject } });
    assert.ok(!read.isError, JSON.stringify(read));
    const held = read.structuredContent as { state_of_record: { observed: { id: string }[]; current: unknown[] } };
    assert.equal(held.state_of_record.observed[0]?.id, single.record_id);
    assert.equal(held.state_of_record.current.length, 0);
    const linkRecord = { schema: 'nuryel.relationship/1', from: single.record_id, to: 'project:visits', type: 'observation_about', scope,
      observation_hash: single.record_hash, lifecycle: 'active', reason: 'User explicitly assigned this observation to visit planning.',
      evidence: { ...source.ref, content_hash: stateHash(source.source_text) }, provenance: { source: 'agent_recorded', confidence: 1, evidence: ['explicit assignment'] } };
    const link = await mcp.callTool({ name: 'nuryel_write', arguments: { principal, scope, facet: 'relationships', record: linkRecord, idempotency_key: 'test:observation-link' } });
    assert.ok(!link.isError, JSON.stringify(link));
    const projection = await http.read({ scope, subject: 'project:visits', facets: ['derived'] });
    assert.equal(projection.state_of_record?.observed?.[0]?.id, single.record_id);
    const replayLink = await http.write({ scope, facet: 'relationships', record: { ...linkRecord, evidence: { ...linkRecord.evidence, observed_at: '2026-09-11T12:00:00Z' } }, idempotency_key: 'test:observation-link-next' });
    assert.equal(replayLink.outcome, 'replayed');
    const batch = await http.captureBatch({ ...request, observations: [
      { ...observation, evidence: [{ source: 0, excerpt: "Not in source." }] },
      { ...observation, statement: "Call Dana on Thursday.", evidence: [{ source: 0, excerpt: "Call Dana on Thursday." }] },
    ] });
    assert.deepEqual(batch.results.map(r => r.status), ["refused", "saved"]);
    const newRecord = batch.results[1]!;
    assert.match(String(newRecord.status === "saved" && newRecord.result.record?.content), /codex@david/, "HTTP uses its authenticated principal");
    await assert.rejects(() => http.captureBatch({ ...request, scope: { kind: "user", id: "stranger" } }), /grant|scope|denied/i);
    const reviewed = await mcp.callTool({ name: 'nuryel_capture_batch', arguments: { principal, scope, observations: [],
      sources: [{ ref: source.ref, source_text: 'Use the east entrance now. Call Dana on Thursday.' }],
      reviews: [{ record_id: single.record_id, expected_hash: single.record_hash, reason: 'The source explicitly changes the entrance to east.', evidence: [{ source: 0, excerpt: 'Use the east entrance now.' }] }] } });
    assert.ok(!reviewed.isError, JSON.stringify(reviewed));
    assert.equal((reviewed.structuredContent as CaptureBatchResult).reviews?.[0]?.status, 'saved');
    assert.equal((await http.read({ scope, subject: 'project:visits', facets: ['derived'] })).state_of_record?.observed, undefined);
    const sentences = Array.from({ length: 65 }, (_, i) => `Planning fact ${i}.`);
    for (let i = 0; i < sentences.length; i += 32) {
      const result = await http.captureBatch({ scope, sources: [{ ...source, source_text: sentences.join(' ') }],
        observations: sentences.slice(i, i + 32).map(statement => ({ ...observation, subject: 'project:many', statement, evidence: [{ source: 0, excerpt: statement }] })) });
      assert.ok(result.results.every(r => r.status === 'saved'));
    }
    assert.ok((await http.capabilities(scope)).capabilities.includes('nuryel.observation-pages/1'));
    const pageOne = await http.read({ scope, subject: 'project:many', facets: ['derived'], observed_page: {} });
    assert.equal(pageOne.state_of_record?.observed?.length, 64);
    const pageTwo = await mcp.callTool({ name: 'nuryel_read', arguments: { principal, scope, subject: 'project:many', facets: ['derived'], observed_page: { cursor: pageOne.state_of_record!.observed_page!.next_cursor! } } });
    assert.ok(!pageTwo.isError, JSON.stringify(pageTwo));
    const finalPage = pageTwo.structuredContent as typeof pageOne;
    assert.equal(finalPage.state_of_record?.observed?.length, 1);
    assert.equal(finalPage.state_of_record?.observed_page?.next_cursor, null);
    assert.equal(new Set([...pageOne.state_of_record!.observed!, ...finalPage.state_of_record!.observed!].map(r => r.id)).size, 65);
    await assert.rejects(() => http.read({ scope, scopes: [scope], subject: 'project:many', observed_page: {} }), /single partition/);
    const union = await mcp.callTool({ name: 'nuryel_read', arguments: { principal, scope, scopes: [scope], subject: 'project:many', observed_page: {} } });
    assert.ok(union.isError);
  } finally {
    await mcp.close(); await server.close();
    await new Promise<void>(r => app.close(() => r())); app.closeStores();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
