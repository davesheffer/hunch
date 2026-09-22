import { cleanupDir } from "./fixtures.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStore } from './helpers.js';
import { readState, writeState, recordsState, subscribeState, partitionOf, mergeReadResponses } from '../src/store/stateBinding.js';
import { stateHash } from '../src/core/stateContract.js';

const source = { kind: 'external', ref: { system: 'handbook', object_type: 'rule', object_key: 'communication', version: '1', observed_at: '2026-09-13T10:00:00Z' } };
const record = (value = 'Use concise status updates.', key = 'communication.status') => ({ schema: 'nuryel.convention/1', key, value, status: 'accepted', valid_from: '2026-09-13T10:00:00Z', valid_to: null, review_by: '2099-01-01T00:00:00Z', sources: [source], provenance: { source: 'human_confirmed', confidence: 1, evidence: ['Handbook rule reviewed'] } });

test('conventions are explicit reviewed records with stable identity, replay, supersession, and advisory bounded delivery', () => {
  const { store, cleanup } = tempStore();
  const scope = partitionOf(store), human = { id: 'human', kind: 'human', grants: [scope] }, agent = { ...human, id: 'agent', kind: 'agent' };
  const write = (body: Record<string, unknown>, key: string, extra = {}, principal = human) => writeState(store, { schema: 'nuryel.state.write/1', principal, scope, facet: 'conventions', record: body, idempotency_key: key, ...extra });
  const read = () => readState(store, { schema: 'nuryel.state.read/1', principal: agent, scope, task: 'prepare a status update' }).response;
  try {
    const first = write(record(), 'convention-first');
    assert.match(first.record_id, /^ncv_/);
    assert.equal(write(record(), 'convention-first').outcome, 'replayed');
    assert.throws(() => write(record('Use a long narrative.'), 'convention-conflict'), /already has an accepted convention/);
    assert.throws(() => write(record('Use a long narrative.'), 'agent-accepts', {}, agent), /human/);
    const proposed = write({ ...record('Use a long narrative.'), status: 'proposed' }, 'agent-proposes', {}, agent);
    assert.equal(proposed.record!.provenance && (proposed.record!.provenance as {source:string}).source, 'agent_recorded');
    const answer = read();
    assert.equal(answer.conventions?.advisory, true);
    assert.equal(answer.conventions?.items.length, 2);
    assert.ok(answer.conventions?.items.every(item => item.conflict));
    assert.equal(answer.records![first.record_id].value, record().value);
    const next = write(record('Use a short bullet list.'), 'human-supersedes', { supersedes: first.record_id, expected_version: first.record_hash });
    assert.equal(next.outcome, 'superseded');
    assert.ok(!read().conventions?.items.some(item => item.ref.id === first.record_id));
    assert.equal(recordsState(store, { schema: 'nuryel.state.records/1', scope, principal: human, ids: [first.record_id] }).records[first.record_id].valid_to !== null, true);
    const events = subscribeState(store, { schema: 'nuryel.state.subscribe/1', scope, principal: human, after_seq: 0 });
    assert.ok(events.events.some(event => event.record_id === first.record_id && event.change === 'superseded'));
    assert.equal(store.search('communication.status').some(hit => hit.ref === next.record_id), true);
  } finally { cleanup(); }
});

test('HTTP conventions preserve user/team/org scope, detect union conflicts, enforce review identity and withhold restricted records', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { initServeConfig, readServeConfig } = await import('../src/serve/config.js');
  const { createServeApp } = await import('../src/serve/app.js');
  const { createStateClient } = await import('../src/client/state.js');
  const dir = mkdtempSync(join(tmpdir(), 'hunch-conventions-')), file = join(dir, 'serve.json');
  const scopes = [{ kind: 'organization', id: 'acme' }, { kind: 'team', id: 'engineering' }, { kind: 'user', id: 'alex' }] as const;
  for (const scope of scopes) initServeConfig({ file, scope, root: join(dir, scope.kind) });
  const { token } = initServeConfig({ file, scope: scopes[0], root: join(dir, 'organization'), principal: { id: 'reviewer', kind: 'human', grants: [...scopes] } });
  const other = initServeConfig({ file, scope: scopes[0], root: join(dir, 'organization'), principal: { id: 'agent', kind: 'agent', grants: [scopes[0]] } });
  const app = createServeApp(readServeConfig(file));
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + (app.address() as {port:number}).port;
  const client = createStateClient({ baseUrl, token: token! }), reader = createStateClient({ baseUrl, token: other.token! });
  try {
    assert.ok((await client.capabilities()).capabilities.includes('nuryel.convention/1'));
    const ids: string[] = [];
    for (const scope of scopes) {
      const saved = await client.write({ scope, facet: 'conventions', record: record('Use ' + scope.kind + ' style.'), idempotency_key: 'scope-' + scope.kind });
      ids.push(saved.record_id);
    }
    assert.equal(new Set(ids).size, 3);
    const union = await client.read({ scope: scopes[0], scopes: [...scopes], task: 'write an update' });
    assert.equal(union.conventions?.items.length, 3);
    assert.ok(union.conventions?.items.every(item => item.conflict && item.currentness === 'recorded'));
    assert.equal(union.conventions?.advisory, true);
    const limited = await reader.read({ scope: scopes[0], scopes: [...scopes] });
    assert.equal(limited.conventions?.items.length, 1); assert.equal(limited.conventions?.items[0].conflict, false);
    assert.deepEqual(limited.denied_scopes, [scopes[1], scopes[2]]);
    assert.ok(!JSON.stringify(limited).includes(ids[1]));
    await assert.rejects(reader.write({ scope: scopes[0], facet: 'conventions', record: record('Override the human.'), idempotency_key: 'agent-forgery' }), /human/);
    const hidden = await client.write({ scope: scopes[0], facet: 'conventions', record: { ...record('A private preference.', 'private.rule'), visibility: { owner: 'reviewer', readers: [], writers: [] } }, idempotency_key: 'private-convention' });
    assert.deepEqual((await reader.records({ scope: scopes[0], ids: [hidden.record_id] })).missing, [hidden.record_id]);
    assert.ok(!JSON.stringify(await reader.read({ scope: scopes[0] })).includes('private.rule'));
  } finally { await new Promise<void>(r => app.close(() => r())); app.closeStores(); cleanupDir(dir); }
});

test('convention delivery marks moved sources and expired review stale, and caps merged record bodies', async () => {
  const { conventionDelivery, conventionSupplements } = await import('../src/core/conventionDelivery.js');
  const { ConventionSchema } = await import('../src/core/stateRecords.js');
  const { conventionId } = await import('../src/core/stateContract.js');
  const { store, cleanup } = tempStore();
  try {
    const scope = partitionOf(store), principal = { id: 'reviewer', kind: 'human', grants: [scope] };
    const original = { id: 'con_source', statement: 'Original source.' };
    const raw = { ...record(), scope, sources: [{ kind: 'record', id: original.id, record_hash: stateHash(original) }] };
    const exact = ConventionSchema.parse({ ...raw, id: conventionId(raw as never) });
    assert.equal(conventionDelivery([exact], () => original)?.items[0].currentness, 'recorded');
    assert.equal(conventionDelivery([exact], () => ({ ...original, statement: 'Changed.' }))?.items[0].currentness, 'stale');
    assert.equal(conventionDelivery([exact])?.items[0].currentness, 'stale');
    const expired = ConventionSchema.parse({ ...exact, valid_from: '2020-01-01T00:00:00Z', review_by: '2021-01-01T00:00:00Z' });
    assert.equal(conventionDelivery([expired], () => original)?.items[0].currentness, 'stale');
    assert.throws(() => ConventionSchema.parse({ ...exact, sources: [{ kind: 'schema', name: 'invented', fingerprint: stateHash('x') }] }), /exact record/);
    assert.throws(() => ConventionSchema.parse({ ...exact, review_by: '2019-01-01T00:00:00Z' }), /after valid_from/);
    for (let i = 0; i < 20; i++) writeState(store, { schema: 'nuryel.state.write/1', scope, principal, facet: 'conventions', record: record('x'.repeat(1200), 'rule.' + String(i).padStart(2, '0')), idempotency_key: 'bounded-convention-' + i }, { deferReindex: true });
    const answer = readState(store, { schema: 'nuryel.state.read/1', scope, principal, subject: 'unrelated' }).response;
    const merged = mergeReadResponses(answer, [answer]);
    assert.equal(merged.conventions?.truncated, true);
    assert.ok(merged.conventions!.items.length <= 16);
    assert.equal(Object.keys(merged.records!).length, merged.conventions!.items.length);
    assert.ok(Buffer.byteLength(JSON.stringify(Object.values(merged.records!))) < 17000);
    assert.match(conventionSupplements(store.recs('conventions'))[0].text, /incomplete/);
  } finally { cleanup(); }
});
