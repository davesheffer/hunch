import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempStore } from './helpers.js';
import { captureBatchState } from '../src/store/stateCapture.js';
import { partitionOf, readState } from '../src/store/stateBinding.js';
import { stateHash } from '../src/core/stateContract.js';

test('observation pages expose older facts exactly once and refuse changed snapshots or another subject', () => {
  const f = tempStore();
  try {
    const scope = partitionOf(f.store), principal = { id: 'codex@david', kind: 'agent', grants: [scope] };
    const add = (start: number, count: number) => captureBatchState(f.store, {
      schema: 'nuryel.state.capture-batch/1', scope, principal,
      sources: [{ ref: { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-10T12:00:00Z' }, source_text: Array.from({ length: count }, (_, i) => `Fact ${start + i}.`).join(' ') }],
      observations: Array.from({ length: count }, (_, i) => ({ subject: 'event:42', statement: `Fact ${start + i}.`, relevance: { use: 'operational_fact', reason: 'Plan the next visit.' }, evidence: [{ source: 0, excerpt: `Fact ${start + i}.` }] })),
    });
    for (let i = 0; i < 3; i++) add(i * 32, 32);
    const request = { schema: 'nuryel.state.read/1', scope, principal, subject: 'event:42', facets: ['derived'] };
    const ordinary = readState(f.store, request).response.state_of_record!;
    assert.equal(ordinary.observed?.length, 64); assert.equal(ordinary.observed_truncated, true); assert.equal(ordinary.observed_page, undefined);
    const first = readState(f.store, { ...request, observed_page: {} }).response;
    const cursor = first.state_of_record!.observed_page!.next_cursor!;
    assert.equal(first.state_of_record!.observed_page!.total, 96); assert.equal(cursor.offset, 64);
    const second = readState(f.store, { ...request, observed_page: { cursor } }).response;
    assert.equal(second.state_of_record!.observed?.length, 32); assert.equal(second.state_of_record!.observed_truncated, false);
    assert.equal(second.state_of_record!.observed_page!.next_cursor, null);
    const refs = [...first.state_of_record!.observed!, ...second.state_of_record!.observed!];
    assert.equal(new Set(refs.map(r => r.id)).size, 96);
    for (const page of [first, second]) for (const ref of page.state_of_record!.observed!) assert.equal(stateHash(page.records![ref.id]), ref.record_hash);
    assert.throws(() => readState(f.store, { ...request, subject: 'other', observed_page: { cursor } }), /changed/);
    assert.throws(() => readState(f.store, { ...request, observed_page: { cursor: { ...cursor, offset: 999 } } }), /outside/);
    add(100, 1);
    assert.throws(() => readState(f.store, { ...request, observed_page: { cursor } }), /changed/);
    const denied = { ...principal, grants: [{ kind: 'user', id: 'stranger' }] };
    assert.throws(() => readState(f.store, { ...request, principal: denied, observed_page: {} }), /grants/);
    assert.throws(() => readState(f.store, { ...request, subject: undefined, observed_page: {} }), /subject/);
    assert.throws(() => readState(f.store, { ...request, scopes: [scope], observed_page: {} }), /single partition/);
    assert.throws(() => readState(f.store, { ...request, facets: ['receipts'], observed_page: {} }), /derived facet/);
    const empty = readState(f.store, { ...request, subject: 'empty', observed_page: {} }).response.state_of_record!;
    assert.deepEqual(empty.observed, []); assert.equal(empty.observed_page!.total, 0); assert.equal(empty.observed_page!.next_cursor, null);
  } finally { f.cleanup(); }
});
