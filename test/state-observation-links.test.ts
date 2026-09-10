import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStore } from './helpers.js';
import { captureState } from '../src/store/stateCapture.js';
import { partitionOf, readState, writeState } from '../src/store/stateBinding.js';
import { stateHash } from '../src/core/stateContract.js';

test('explicit observation links project one fact without merging subjects; retirement and staleness propagate', () => {
  const f = tempStore();
  try {
    const scope = partitionOf(f.store), principal = { id: 'kimi@david', kind: 'agent', grants: [scope] };
    const ref = { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-10T12:00:00Z' };
    const capture = (statement: string) => captureState(f.store, { schema: 'nuryel.state.capture/1', scope, principal, subject: 'event:42', statement,
      relevance: { use: 'constraint', reason: 'Plan the next visit.' }, evidence: [{ ref, source_text: statement, excerpt: statement }] });
    const fact = capture('Office closes Friday.'), unrelated = capture('Call Dana Thursday.');
    const read = (subject: string) => readState(f.store, { schema: 'nuryel.state.read/1', principal, scope, subject, facets: ['derived'] }).response;
    assert.equal(read('event:42').state_of_record?.observed?.length, 2, 'no customer required');
    assert.equal(read('customer:Site:7').state_of_record?.observed, undefined);
    const record = { schema: 'nuryel.relationship/1', from: fact.record_id, to: 'customer:Site:7', type: 'observation_about', scope,
      reason: 'CRM explicitly associates event 42 with Site:7.', observation_hash: fact.record_hash, lifecycle: 'active',
      evidence: { ...ref, content_hash: stateHash({ event: 42, location: 'Site:7' }) }, provenance: { source: 'agent_recorded', confidence: 1, evidence: ['CRM explicit location'] } };
    const write = (r: unknown, key: string) => writeState(f.store, { schema: 'nuryel.state.write/1', principal, scope, facet: 'relationships', record: r, idempotency_key: 'test-link:' + key });
    const linked = write(record, 'link');
    assert.equal(write(record, 'link').outcome, 'replayed');
    const nextRead = { ...record, evidence: { ...record.evidence, observed_at: '2026-09-11T12:00:00Z' } };
    const repeat = write(nextRead, 'new-read');
    assert.equal(repeat.outcome, 'replayed');
    assert.equal(repeat.record_hash, linked.record_hash, 'read time does not replace evidence or author');
    assert.throws(() => write({ ...nextRead, reason: 'Different payload' }, 'new-read'), /idempotency/);
    assert.equal(f.store.recs('derived').length, 2);
    assert.deepEqual(read(record.to).state_of_record?.observed?.map(r => r.id), [fact.record_id]);
    assert.equal(read(record.to).records?.[fact.record_id]?.subject, 'event:42');
    assert.equal(read(record.to).state_of_record?.current.length, 0);
    assert.equal(read(record.to).records?.[unrelated.record_id], undefined);
    write({ ...record, to: 'project:maintenance' }, 'project');
    assert.equal(read('project:maintenance').state_of_record?.observed?.[0]?.record_hash, fact.record_hash);
    write({ ...linked.record, lifecycle: 'retired' }, 'unlink');
    assert.equal(read(record.to).state_of_record?.observed, undefined);
    assert.equal(read('event:42').state_of_record?.observed?.length, 2, 'unlink preserves source');
    writeState(f.store, { schema: 'nuryel.state.write/1', principal, scope, facet: 'derived', record: { ...fact.record, state: 'stale' }, idempotency_key: 'test-link:stale', cause: { kind: 'external', ref } });
    assert.equal(read('project:maintenance').state_of_record?.observed, undefined, 'withdrawn fact disappears from every projection');
    assert.deepEqual(read('event:42').state_of_record?.observed?.map(r => r.id), [unrelated.record_id], 'unrelated fact survives');
    assert.throws(() => write(record, 'stale-link'), /no longer eligible/);
  } finally { f.cleanup(); }
});

test('links require an existing observation, matching hash, evidence and granted scope', () => {
  const f = tempStore();
  try {
    const scope = partitionOf(f.store), principal = { id: 'claude@david', kind: 'agent', grants: [scope] };
    const record = { schema: 'nuryel.relationship/1', from: 'nds_' + 'a'.repeat(24), to: 'customer:Site:7', type: 'observation_about', scope,
      observation_hash: stateHash('missing'), reason: 'Explicit relation', evidence: { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-10T12:00:00Z', content_hash: stateHash('binding') },
      provenance: { source: 'agent_recorded', confidence: 1, evidence: ['explicit source'] } };
    const request = { schema: 'nuryel.state.write/1', principal, scope, facet: 'relationships', record, idempotency_key: 'test-link:missing' };
    assert.throws(() => writeState(f.store, request), /absent from the granted partition/);
    assert.throws(() => writeState(f.store, { ...request, record: { ...record, evidence: undefined } }), /hashed external evidence/);
    assert.throws(() => writeState(f.store, { ...request, principal: { ...principal, grants: [{ kind: 'user', id: 'other' }] } }), /grants/);
    assert.equal(f.store.recs('relationships').length, 0);
  } finally { f.cleanup(); }
});
