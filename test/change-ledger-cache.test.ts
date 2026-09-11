import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendChanges, emptyLedger, ledgerFile, LedgerSchema, readLedger, writeLedger } from '../src/store/changeLedger.js';
import { stateHash } from '../src/core/stateContract.js';

const scope = { kind: 'user' as const, id: 'cache-test' };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hunch-ledger-cache-'));
  appendChanges(dir, scope, [{ facet: 'derived', record_id: 'nds_fixture', record_hash: stateHash('one'), change: 'created', invalidates: ['subject:one'] }],
    { key: 'first', entry: { record_id: 'nds_fixture', record_hash: stateHash('one'), facet: 'derived' } });
  return { dir, file: ledgerFile(dir, scope), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('unchanged ledger validates once; returned nested objects cannot poison later reads', () => {
  const f = fixture(), parse = mock.method(LedgerSchema, 'parse');
  try {
    const first = readLedger(f.dir, scope), expected = structuredClone(first);
    first.events[0]!.invalidates.push('forged'); first.idempotency.first!.record_hash = stateHash('forged'); first.scope.id = 'forged';
    const second = readLedger(f.dir, scope); assert.deepEqual(second, expected);
    second.events.length = 0; second.idempotency.first!.seq = 999;
    assert.deepEqual(readLedger(f.dir, scope), expected);
    assert.equal(parse.mock.callCount(), 1);
  } finally { parse.mock.restore(); f.cleanup(); }
});

test('a separate writer replacing equal-length bytes with the same mtime is visible immediately', () => {
  const f = fixture();
  try {
    const before = readLedger(f.dir, scope), stats = statSync(f.file);
    const text = readFileSync(f.file, 'utf8').replaceAll(stateHash('one'), stateHash('two'));
    const writer = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', f.file, text], { encoding: 'utf8' });
    assert.equal(writer.status, 0, writer.stderr); utimesSync(f.file, stats.atime, stats.mtime);
    assert.equal(statSync(f.file).size, stats.size);
    const after = readLedger(f.dir, scope); assert.notDeepEqual(after, before);
    assert.equal(after.events[0]!.record_hash, stateHash('two'));
    assert.equal(after.idempotency.first!.record_hash, stateHash('two'));
  } finally { f.cleanup(); }
});

test('changed corruption, scope mismatch and sequence gaps never fall back to a cached ledger', () => {
  const f = fixture();
  try {
    const original = readLedger(f.dir, scope);
    for (const malformed of ['{', JSON.stringify({ ...original, scope: { ...scope, id: 'other' } }),
      JSON.stringify({ ...original, head_seq: 4 }),
      JSON.stringify({ ...original, events: [{ ...original.events[0], seq: 2 }] })]) {
      writeFileSync(f.file, malformed); assert.throws(() => readLedger(f.dir, scope));
      writeLedger(f.dir, original); assert.deepEqual(readLedger(f.dir, scope), original);
    }
    unlinkSync(f.file); assert.deepEqual(readLedger(f.dir, scope), emptyLedger(scope));
    writeLedger(f.dir, original); assert.deepEqual(readLedger(f.dir, scope), original);
  } finally { f.cleanup(); }
});

test('cache evicts old partitions and does not retain oversized source snapshots', () => {
  const fixtures = Array.from({ length: 5 }, fixture), parse = mock.method(LedgerSchema, 'parse');
  try {
    for (const f of fixtures) readLedger(f.dir, scope);
    assert.equal(parse.mock.callCount(), 5);
    readLedger(fixtures[4]!.dir, scope); assert.equal(parse.mock.callCount(), 5);
    readLedger(fixtures[0]!.dir, scope); assert.equal(parse.mock.callCount(), 6);
    const f = fixtures[0]!;
    writeFileSync(f.file, ' '.repeat(1024 * 1024) + readFileSync(f.file, 'utf8'));
    readLedger(f.dir, scope); readLedger(f.dir, scope); assert.equal(parse.mock.callCount(), 8);
  } finally { parse.mock.restore(); for (const f of fixtures) f.cleanup(); }
});

test('legacy optional defaults are preserved on cached reads', () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ schema: 'nuryel.ledger/1', scope, head_seq: 0, events: [] }));
    assert.deepEqual(readLedger(f.dir, scope), emptyLedger(scope));
    assert.deepEqual(readLedger(f.dir, scope), emptyLedger(scope));
  } finally { f.cleanup(); }
});
