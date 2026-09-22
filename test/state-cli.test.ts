import { cleanupDir } from "./fixtures.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServeApp } from '../src/serve/app.js';
import { initServeConfig, readServeConfig } from '../src/serve/config.js';
import { stateHash } from '../src/core/stateContract.js';

const cli = resolve('dist/cli/index.js');
async function invoke(args: string[], input = '', env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, 'state', ...args], { env: { ...process.env, HUNCH_STATE_TOKEN: '', HUNCH_STATE_URL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
  return { code, stdout, stderr };
}

test('state CLI uses the real authenticated contract for writes, reads, records, subscriptions and typed refusals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hunch-state-cli-')), file = join(dir, 'serve.json'), tokenFile = join(dir, 'token');
  const scope = { kind: 'organization', id: 'cli' };
  const { token } = initServeConfig({ file, scope, root: dir, principal: { id: 'writer', kind: 'agent' } });
  writeFileSync(tokenFile, token! + '\n', { mode: 0o600 });
  const app = createServeApp(readServeConfig(file));
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
  const env = { HUNCH_STATE_URL: url, HUNCH_STATE_TOKEN: token! };
  try {
    const caps = await invoke(['capabilities'], '', env);
    assert.equal(caps.code, 0, caps.stderr);
    assert.equal(JSON.parse(caps.stdout).protocol, 'nuryel.state/1');
    const content = 'A CLI-created summary';
    const request = { scope, facet: 'derived', idempotency_key: 'cli-summary-write', record: { schema: 'nuryel.derived/1', scope, subject: 'customer:c1', content, content_hash: stateHash(content), dependencies: [{ kind: 'schema', name: 'example', fingerprint: stateHash('example') }], computed_at: '2026-09-13T10:00:00Z', transform_version: 'cli/v1', valid_to: null, state: 'current', provenance: { source: 'agent_recorded', confidence: 0.8, evidence: ['CLI fixture'] } } };
    const written = await invoke(['write', '--input', '-'], JSON.stringify(request), env);
    assert.equal(written.code, 0, written.stderr);
    const saved = JSON.parse(written.stdout); assert.equal(saved.outcome, 'created');
    const replay = await invoke(['write', '--input', '-'], JSON.stringify(request), env);
    assert.equal(JSON.parse(replay.stdout).outcome, 'replayed');
    const read = await invoke(['read', '--scope', 'organization:cli', '--subject', 'customer:c1'], '', env);
    assert.equal(read.code, 0, read.stderr); assert.equal(JSON.parse(read.stdout).records[saved.record_id].content, content);
    const records = await invoke(['--url', url, '--token-file', tokenFile, 'records', '--scope', 'organization:cli', '--ids', saved.record_id]);
    assert.equal(records.code, 0, records.stderr); assert.equal(JSON.parse(records.stdout).records[saved.record_id].content, content);
    const stream = await invoke(['subscribe', '--scope', 'organization:cli', '--after', '0'], '', env);
    assert.equal(stream.code, 0, stream.stderr);
    const events = JSON.parse(stream.stdout); assert.equal(events.events[0].record_id, saved.record_id); assert.equal(events.resync, false); assert.equal(events.floor_seq, 0);
    const refused = await invoke(['write', '--input', '-'], JSON.stringify({ ...request, record: { ...request.record, content: 'changed', content_hash: stateHash('changed') } }), env);
    assert.equal(refused.code, 1); assert.equal(JSON.parse(refused.stderr).title, 'idempotency'); assert.equal(refused.stdout, '');
    const unauthorized = await invoke(['read', '--scope', 'organization:cli', '--subject', 'customer:c1'], '', { ...env, HUNCH_STATE_TOKEN: 'nyt_wrong' });
    assert.equal(unauthorized.code, 1); assert.equal(JSON.parse(unauthorized.stderr).title, 'unauthorized');
    for (const output of [caps, written, read, records, stream, refused, unauthorized]) assert.ok(!(output.stdout + output.stderr).includes(token!));
    const fileInput = join(dir, 'read.json'); writeFileSync(fileInput, JSON.stringify({ scope, subject: 'customer:c1' }));
    assert.equal((await invoke(['read', '--input', fileInput], '', env)).code, 0);
    assert.equal((await invoke(['write', '--input', '-'], '[]', env)).code, 1);
    assert.equal((await invoke(['read', '--input', '-', '--scope', 'organization:other'], JSON.stringify({ scope }), env)).code, 1);
  } finally { await new Promise<void>(r => app.close(() => r())); app.closeStores(); cleanupDir(dir); }
});

test('state CLI refuses unsupported capabilities and redirects, times out, and bounds input before sending writes', async () => {
  const { createServer } = await import('node:http');
  let mode = 'unsupported';
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(307, { location: '/redirected' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ protocol: 'nuryel.state/1', capabilities: [] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const env = { HUNCH_STATE_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port, HUNCH_STATE_TOKEN: 'test-token' };
  try {
    const unsupported = await invoke(['read', '--scope', 'organization:test'], '', env);
    assert.equal(unsupported.code, 1); assert.equal(JSON.parse(unsupported.stderr).title, 'unsupported');
    assert.equal(paths.length, 1); assert.ok(paths[0].startsWith('/nuryel/v1/capabilities'));
    paths.length = 0; mode = 'redirect';
    const redirected = await invoke(['capabilities'], '', env);
    assert.equal(redirected.code, 1); assert.equal(paths.length, 1); assert.ok(!paths.includes('/redirected'));
    paths.length = 0; mode = 'timeout';
    const timeout = await invoke(['--timeout', '50', 'capabilities'], '', env);
    assert.equal(timeout.code, 1); assert.equal(JSON.parse(timeout.stderr).title, 'client-error');
    assert.equal(paths.length, 1);
    paths.length = 0;
    const oversized = await invoke(['write'], JSON.stringify({ content: 'x'.repeat(1024 * 1024) }), env);
    assert.equal(oversized.code, 1); assert.match(JSON.parse(oversized.stderr).detail, /1 MiB/); assert.equal(paths.length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
