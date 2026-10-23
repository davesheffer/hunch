/** Exercise an already-running older HTTP server against newly protected records.
 * node tooling/verify-state-upgrade.mjs /path/to/older/@davesheffer/hunch
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { initServeConfig } from '../dist/serve/config.js';
import { HunchStore } from '../dist/store/hunchStore.js';
import { hunchPaths } from '../dist/core/paths.js';
import { writeState } from '../dist/store/stateBinding.js';
// Validate before creating the temp dir: a refused run must leave nothing behind.
assert.ok(process.argv[2], 'pass an existing older package installation');
const older = resolve(process.argv[2]), dir = mkdtempSync(join(tmpdir(), 'hunch-old-reader-'));
let child, store;
try {
  const scope = { kind: 'organization', id: 'upgrade' }, file = join(dir, 'serve.json');
  const principal = { id: 'owner', kind: 'human', grants: [scope] };
  const { token } = initServeConfig({ file, scope, root: dir, principal });
  const script = `import {pathToFileURL} from 'node:url';
    const old=process.argv[1], file=process.argv[2];
    const {createServeApp}=await import(pathToFileURL(old+'/dist/serve/app.js'));
    const {readServeConfig}=await import(pathToFileURL(old+'/dist/serve/config.js'));
    const app=createServeApp(readServeConfig(file));
    app.listen(0,'127.0.0.1',()=>process.stdout.write(String(app.address().port)+'\\n'));
    process.on('SIGTERM',()=>app.close(()=>{app.closeStores();process.exit(0)}));`;
  child = spawn(process.execPath, ['--input-type=module', '-e', script, older, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((accept, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error('older server startup timed out: ' + errors)), 15000);
    child.stderr.on('data', data => { errors += data; });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('older server exited ' + code + ': ' + errors)); });
    child.stdout.on('data', data => { output += data; if (/^\d+\n/.test(output)) { clearTimeout(timeout); accept(Number(output.trim())); } });
  });
  const call = (route, body) => fetch(`http://127.0.0.1:${port}/nuryel/v1/${route}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ scope, ...body }) });
  assert.equal((await call('read', { subject: 'launch' })).status, 200, 'warm the old server/store before changing files');
  store = new HunchStore(hunchPaths(dir));
  const record = { id: 'con_upgrade_secret', type: 'correctness', statement: 'secret launch exception', scope: ['launch'], severity: 'warning', enforcement: 'advisory_v1', match: null, forbids: null, rationale: '', source_decision: null, violations: [], status: 'active', valid_to: null, provenance: { source: 'human_confirmed', confidence: 1, evidence: ['test'] }, visibility: { owner: 'owner', readers: [], writers: [] } };
  writeState(store, { schema: 'nuryel.state.write/1', principal, scope, facet: 'constraints', record, idempotency_key: 'protected-upgrade' });
  for (const [route, body] of [['read', { subject: 'launch' }], ['records', { ids: [record.id] }], ['subscribe', { after_seq: 0 }], ['write', { facet: 'constraints', record, idempotency_key: 'old-must-refuse' }], ['capture', { subject: 'launch', statement: 'an assertion', relevance: { use: 'operational_fact', reason: 'test' }, evidence: [{ ref: { system: 'test', object_type: 'event', object_key: '1', observed_at: '2026-09-13T10:00:00Z' }, source_text: 'an assertion', excerpt: 'an assertion' }] }]]) {
    const response = await call(route, body), text = await response.text();
    assert.equal(response.status, 400, route + ': ' + text);
    assert.equal(JSON.parse(text).title, 'unsupported', route);
    assert.ok(!text.includes(record.statement), route + ' disclosed protected content');
  }
  console.log('PASS: already-running older server refuses read, records, subscribe, write and capture after protected-partition upgrade.');
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  store?.close(); rmSync(dir, { recursive: true, force: true });
}
