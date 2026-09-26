import { execFileSync } from 'node:child_process';
import { HunchStore } from '../src/store/hunchStore.js';
import { hunchPaths } from '../src/core/paths.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureState, captureBatchState } from '../src/store/stateCapture.js';
import { ScopeSchema, entityId } from '../src/core/stateContract.js';
import { tempStore, mkConstraint } from './helpers.js';
import { writeLocalPointer } from './fixtures.js';
import { partitionOf, readState, recordsState, writeState, subscribeState } from '../src/store/stateBinding.js';
import { stateHash } from '../src/core/stateContract.js';

function fixture() {
  const f = tempStore(), scope = partitionOf(f.store);
  const owner = { id: 'owner', kind: 'human', grants: [scope] }, outsider = { id: 'outsider', kind: 'agent', grants: [scope] }, reader = { id: 'reader', kind: 'agent', grants: [scope] };
  const visibility = { owner: owner.id, readers: [reader.id], writers: [] };
  const base = { schema: 'nuryel.derived/1', scope, subject: 'shared-topic', content: 'classified launch schedule', content_hash: stateHash('classified launch schedule'), dependencies: [{ kind: 'schema', name: 'schedule', fingerprint: stateHash('v1') }], transform_version: 'summary/v1', computed_at: '2026-09-13T12:00:00Z', valid_to: null, state: 'current', provenance: { source: 'agent_recorded', confidence: 0.8, evidence: ['test fixture'] }, visibility };
  const write = (record = base, principal = owner, key = 'visibility-create', extra = {}) => writeState(f.store, { schema: 'nuryel.state.write/1', principal, scope, facet: 'derived', record, idempotency_key: key, ...extra });
  const read = (principal = outsider) => readState(f.store, { schema: 'nuryel.state.read/1', principal, scope, subject: 'shared-topic' });
  const records = (id: string, principal = outsider) => recordsState(f.store, { schema: 'nuryel.state.records/1', principal, scope, ids: [id] });
  const stream = (principal = outsider) => subscribeState(f.store, { schema: 'nuryel.state.subscribe/1', principal, scope, after_seq: 0 });
  return { ...f, scope, owner, outsider, reader, visibility, base, write, read, records, stream };
}

test('visibility hides exact records, subject state and activity; readers cannot write or widen access', () => {
  const f = fixture();
  try {
    const saved = f.write();
    assert.equal(f.read().response.state_of_record?.current.length, 0);
    assert.deepEqual(f.records(saved.record_id).missing, [saved.record_id]);
    assert.deepEqual(f.records(saved.record_id).denied, []);
    assert.deepEqual(f.stream().events, []);
    assert.equal(f.stream().filtered, true);
    assert.ok(!JSON.stringify(f.read()).includes('classified'));
    assert.equal(f.read(f.reader).response.state_of_record?.current.length, 1);
    assert.throws(() => f.write(f.base, f.outsider), /not permitted/);
    assert.throws(() => f.write({ ...f.base, state: 'stale' }, f.reader, 'reader-mutation'), /not permitted/);
    assert.throws(() => f.write({ ...f.base, visibility: { ...f.visibility, readers: ['outsider'] } }, f.reader, 'reader-widens'), /not permitted/);
    assert.equal(f.records(saved.record_id, f.owner).records[saved.record_id]?.state, 'current');
  } finally { f.cleanup(); }
});

test('restricted conflicts and idempotency failures do not disclose incumbent identity or fields', () => {
  const f = fixture();
  try {
    const saved = f.write();
    const { visibility: _visibility, ...publicRecord } = f.base;
    for (const [record, key, extra] of [
      [publicRecord, 'visibility-create', {}],
      [{ ...publicRecord, computed_at: '2026-09-14T12:00:00Z', dependencies: [{ kind: 'schema', name: 'schedule', fingerprint: stateHash('v2') }] }, 'rival-current', {}],
      [publicRecord, 'supersede-hidden', { supersedes: saved.record_id }],
    ] as const) {
      assert.throws(() => f.write(record as typeof f.base, f.outsider, key, extra), e => e instanceof Error && /not permitted/.test(e.message) && !e.message.includes(saved.record_id) && !e.message.includes('classified'));
    }
  } finally { f.cleanup(); }
});

test('visibility changes require owner and explicit version; subscriptions honor both past and current audiences', () => {
  const f = fixture();
  try {
    const saved = f.write();
    const widened = { ...f.base, visibility: { ...f.visibility, readers: ['reader', 'outsider'] } };
    assert.throws(() => f.write(widened, f.owner, 'widen-no-version'), /expected_version/);
    const changed = f.write(widened, f.owner, 'owner-widens', { expected_version: saved.record_hash });
    assert.equal(f.read().response.state_of_record?.current.length, 1);
    assert.deepEqual(f.stream().events.map(e => e.change), ['updated'], 'newly admitted reader does not inherit historical restricted events');
    f.write(f.base, f.owner, 'owner-revokes', { expected_version: changed.record_hash });
    assert.deepEqual(f.stream().events, []);
    assert.deepEqual(f.records(saved.record_id).missing, [saved.record_id]);
  } finally { f.cleanup(); }
});

test('legacy context, omissions and linked records are filtered without changing original hashes', () => {
  const f = fixture();
  try {
    const secret = f.write();
    const c = mkConstraint({ id: 'con_private_example', statement: 'classified legacy rule', scope: ['**'], visibility: f.visibility });
    writeState(f.store, { schema: 'nuryel.state.write/1', scope: f.scope, principal: f.owner, facet: 'constraints', record: c, idempotency_key: 'private-constraint' });
    const linked = { ...f.base, visibility: undefined, transform_version: 'linked/v1', dependencies: [{ kind: 'record', id: secret.record_id, record_hash: secret.record_hash }], content: 'A summary with a restricted source', content_hash: stateHash('A summary with a restricted source') };
    const saved = f.write(linked as never, f.owner, 'public-linked-record');
    assert.deepEqual(f.records(saved.record_id).missing, [saved.record_id]);
    assert.deepEqual(f.records(saved.record_id, f.reader).records[saved.record_id], saved.record);
    const serialized = JSON.stringify(f.read());
    for (const hidden of [secret.record_id, saved.record_id, c.id, 'classified legacy']) assert.ok(!serialized.includes(hidden), hidden);
    const own = f.read(f.owner);
    assert.ok(JSON.stringify(own).includes(c.id));
    const declaration = JSON.parse(readFileSync(join(f.root, '.hunch/partition.json'), 'utf8'));
    assert.deepEqual(declaration.required_capabilities, ['nuryel.record-visibility/1']);
    assert.equal(ScopeSchema.safeParse(declaration).success, false, 'old strict partition readers fail closed');
  } finally { f.cleanup(); }
});

test('capture and review replay enforce visibility; hidden observation changes do not affect authorized page snapshots', () => {
  const f = fixture();
  try {
    const ref = { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-13T10:00:00Z' };
    const request = { schema: 'nuryel.state.capture/1', scope: f.scope, principal: f.owner, subject: 'shared-topic', statement: 'Office closes Friday.', relevance: { use: 'operational_fact', reason: 'Prepare visit.' }, evidence: [{ ref, source_text: 'Office closes Friday.', excerpt: 'Office closes Friday.' }], visibility: f.visibility };
    const saved = captureState(f.store, request);
    assert.throws(() => captureState(f.store, { ...request, principal: f.outsider }), /not permitted/);
    assert.equal(captureState(f.store, { ...request, principal: f.reader }).record_id, saved.record_id);
    assert.throws(() => captureState(f.store, { ...request, visibility: { ...f.visibility, readers: ['outsider'] } }), /different visibility/);
    const page = () => readState(f.store, { schema: 'nuryel.state.read/1', principal: f.outsider, scope: f.scope, subject: 'shared-topic', observed_page: {} }).response.state_of_record?.observed_page;
    const before = page();
    const reviews = captureBatchState(f.store, { schema: 'nuryel.state.capture-batch/1', principal: f.outsider, scope: f.scope, observations: [], sources: [{ ref, source_text: 'Office closes Thursday.' }], reviews: [{ record_id: saved.record_id, expected_hash: saved.record_hash, reason: 'Schedule changed.', evidence: [{ source: 0, excerpt: 'Office closes Thursday.' }] }] });
    assert.equal(reviews.reviews?.[0]?.status, 'refused');
    assert.ok(!JSON.stringify(reviews).includes('Friday'));
    captureState(f.store, { ...request, statement: 'Phone before arrival.', evidence: [{ ref, source_text: 'Phone before arrival.', excerpt: 'Phone before arrival.' }] });
    assert.deepEqual(page(), before);
    assert.equal(before?.total, 0);
  } finally { f.cleanup(); }
});

test('delegated writers cannot widen a protected audience by superseding under a new identity', () => {
  const f = fixture();
  try {
    const visibility = { ...f.visibility, writers: [f.reader.id] };
    const first = f.write({ ...f.base, visibility });
    const replacement = { ...f.base, visibility, dependencies: [{ kind: 'schema', name: 'schedule', fingerprint: stateHash('v2') }] };
    assert.throws(() => f.write({ ...replacement, visibility: undefined } as never, f.reader, 'writer-widens-supersede', { supersedes: first.record_id }), /not permitted/);
    const preserved = f.write(replacement, f.reader, 'writer-keeps-audience', { supersedes: first.record_id });
    assert.equal(preserved.outcome, 'superseded');
    assert.deepEqual(f.read().response.state_of_record?.current, []);
  } finally { f.cleanup(); }
});

test('protected writes refuse shared overlays where other older checkout readers cannot be gated', () => {
  const f = fixture(), overlay = tempStore(); let overlayStore: HunchStore | undefined;
  try {
    const privateDir = join(overlay.root, '.hunch'); execFileSync('git', ['init', '-q', overlay.root]);
    execFileSync('git', ['init', '-q', f.root]); writeLocalPointer(f.root, { privateDir, autoCommit: false });
    overlayStore = new HunchStore(hunchPaths(f.root));
    const user = { kind: 'user', id: 'owner' }, principal = { ...f.owner, grants: [user] };
    assert.throws(() => writeState(overlayStore!, { schema: 'nuryel.state.write/1', principal, scope: user, facet: 'derived', record: { ...f.base, scope: user }, idempotency_key: 'overlay-must-refuse' }), /dedicated partition home/);
    assert.equal(overlayStore.recs('derived').length, 0);
  } finally { overlayStore?.close(); overlay.cleanup(); f.cleanup(); }
});

test('authorized FTS candidate lists filter before the limit, including the LIKE fallback', () => {
  const f = fixture();
  try {
    f.store.json.put('constraints', mkConstraint({ id: 'con_hidden_rank', statement: 'needle', visibility: f.visibility }));
    f.store.json.put('constraints', mkConstraint({ id: 'con_visible_rank', statement: 'longer needle visible', visibility: undefined }));
    f.store.reindex();
    assert.equal(f.store.search('needle', 1, ['con_visible_rank'])[0]?.ref, 'con_visible_rank');
    assert.deepEqual(f.store.search('needle', 1, []), []);
    assert.deepEqual(f.store.search('---', 1, ['con_visible_rank']), []);
  } finally { f.cleanup(); }
});

test('visibility mode survives audience removal and rejects missing declared sources', () => {
  const f = fixture();
  try {
    const saved = f.write();
    f.write({ ...f.base, visibility: undefined } as never, f.owner, 'owner-removes-acl', { expected_version: saved.record_hash });
    const missing = { ...f.base, visibility: undefined, transform_version: 'missing-source/v1', dependencies: [{ kind: 'record', id: 'dec_missing_source', record_hash: stateHash('missing') }] };
    assert.throws(() => f.write(missing as never, f.owner, 'missing-source-write'), /not permitted/);
    assert.equal(f.stream().filtered, true, 'durable upgrade gate keeps protected mode after last ACL removal');
  } finally { f.cleanup(); }
});

test('hidden entity aliases and observation links disclose neither protected IDs nor projected content', () => {
  const f = fixture();
  try {
    const ref = { system: 'crm', object_type: 'event', object_key: '42', observed_at: '2026-09-13T10:00:00Z' };
    const entity = writeState(f.store, { schema: 'nuryel.state.write/1', principal: f.owner, scope: f.scope, facet: 'entities', idempotency_key: 'hidden-alias-entity', record: { id: entityId('customer', 'Secret customer'), schema: 'nuryel.entity/1', scope: f.scope, kind: 'customer', name: 'Secret customer', refs: [ref], attributes: {}, lifecycle: 'active', provenance: f.base.provenance, created_at: ref.observed_at, updated_at: ref.observed_at, visibility: f.visibility } });
    const record = f.write({ ...f.base, subject: entity.record_id }, f.owner, 'hidden-entity-summary');
    const outsiderRead = readState(f.store, { schema: 'nuryel.state.read/1', principal: f.outsider, scope: f.scope, subject: 'event:42' });
    for (const hidden of [entity.record_id, record.record_id, 'Secret customer']) assert.ok(!JSON.stringify(outsiderRead).includes(hidden));
    assert.throws(() => f.write({ ...f.base, visibility: undefined, subject: 'event:42' } as never, f.outsider, 'hidden-alias-collision'), e => e instanceof Error && /not permitted/.test(e.message) && !e.message.includes(entity.record_id));
    const fact = captureState(f.store, { schema: 'nuryel.state.capture/1', principal: f.owner, scope: f.scope, subject: entity.record_id, statement: 'Secret customer calls Friday.', relevance: { use: 'operational_fact', reason: 'Prepare follow-up.' }, evidence: [{ ref, source_text: 'Secret customer calls Friday.', excerpt: 'Secret customer calls Friday.' }], visibility: f.visibility });
    const link = writeState(f.store, { schema: 'nuryel.state.write/1', principal: f.owner, scope: f.scope, facet: 'relationships', idempotency_key: 'hidden-observation-link', record: { schema: 'nuryel.relationship/1', scope: f.scope, from: fact.record_id, to: 'public-subject', type: 'observation_about', reason: 'Source explicitly links these subjects.', observation_hash: fact.record_hash, lifecycle: 'active', evidence: { ...ref, content_hash: stateHash('association') }, provenance: f.base.provenance } });
    assert.deepEqual(f.records(link.record_id).missing, [link.record_id]);
    const projected = readState(f.store, { schema: 'nuryel.state.read/1', principal: f.outsider, scope: f.scope, subject: 'public-subject', observed_page: {} });
    assert.equal(projected.response.state_of_record?.observed_page?.total, 0);
    assert.ok(!JSON.stringify(projected).includes(fact.record_id));
  } finally { f.cleanup(); }
});
