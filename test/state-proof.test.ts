import { cleanupDir } from "./fixtures.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initServeConfig, readServeConfig, writeServeConfig } from '../src/serve/config.js';
import { createServeApp } from '../src/serve/app.js';
import { createStateClient } from '../src/client/state.js';

const origin = 'https://state.example.test';
test('key-bound credentials require fresh proof, resist replay across instances, and honor live rotation and revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hunch-proof-')), file = join(dir, 'serve.json');
  const scope = { kind: 'organization', id: 'proof' } as const;
  const keys = generateKeyPairSync('ed25519'), proofKey = keys.publicKey.export({ format: 'jwk' });
  let app: ReturnType<typeof createServeApp> | undefined, second: ReturnType<typeof createServeApp> | undefined;
  try {
    const initial = initServeConfig({ file, scope, root: join(dir, 'partition'), publicOrigin: origin, principal: { id: 'writer', kind: 'agent', proofKey } });
    assert.deepEqual(initial.config.principals[0].proof_key, proofKey);
    const { createStateProofSigner } = await import('../src/client/stateProof.js');
    app = createServeApp(readServeConfig(file));
    await new Promise<void>(r => app!.listen(0, '127.0.0.1', r));
    const local = 'http://127.0.0.1:' + (app.address() as {port:number}).port;
    const route = (url: string | URL | Request, options?: RequestInit) => fetch(String(url).replace(origin, local), options);
    const token = initial.token!;
    assert.equal((await route(origin + '/nuryel/v1/capabilities', { headers: { authorization: 'Bearer ' + token } })).status, 401);
    const signer = createStateProofSigner(keys.privateKey);
    const client = createStateClient({ baseUrl: origin, token, proof: signer, fetch: route as typeof fetch });
    const caps = await client.capabilities();
    assert.equal(caps.principal.id, 'writer');
    assert.ok(caps.capabilities.includes('nuryel.auth.dpop/1'));
    const url = origin + '/nuryel/v1/capabilities';
    const challenge = await route(url, { headers: { authorization: 'DPoP ' + token, dpop: await signer({ method: 'GET', url, token }) } });
    assert.equal(challenge.status, 401); const nonce = challenge.headers.get('dpop-nonce')!; assert.ok(nonce);
    const proof = await signer({ method: 'GET', url, token, nonce });
    const headers = { authorization: 'DPoP ' + token, dpop: proof };
    const { request: httpRequest } = await import('node:http');
    const duplicate = (name: 'Authorization' | 'DPoP') => new Promise<{ status?: number; body: string }>((accept, reject) => {
      // A raw header array suppresses Node's automatic Host header. Include it
      // so this reaches our ambiguity check instead of HTTP's missing-Host 400.
      const headers = ['Host', new URL(local).host, 'Authorization', 'DPoP ' + token, 'DPoP', proof, name, name === 'DPoP' ? proof : 'DPoP ' + token];
      const req = httpRequest(local + '/nuryel/v1/capabilities', { headers }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => accept({ status: res.statusCode, body }));
      }); req.once('error', reject); req.end();
    });
    for (const name of ['Authorization', 'DPoP'] as const) {
      const denied = await duplicate(name); assert.equal(denied.status, 401); assert.match(JSON.parse(denied.body).detail, /ambiguous/);
    }
    assert.equal((await route(url, { headers })).status, 200);
    assert.equal((await route(url, { headers })).status, 401);
    second = createServeApp(readServeConfig(file));
    await new Promise<void>(r => second!.listen(0, '127.0.0.1', r));
    assert.equal((await fetch('http://127.0.0.1:' + (second.address() as {port:number}).port + '/nuryel/v1/capabilities', { headers })).status, 401);
    const wrong = createStateProofSigner(generateKeyPairSync('ed25519').privateKey);
    await assert.rejects(createStateClient({ baseUrl: origin, token, proof: wrong, fetch: route as typeof fetch }).capabilities(), /proof/);
    const rotated = initServeConfig({ file, scope, root: join(dir, 'partition'), principal: { id: 'writer', kind: 'agent' } });
    assert.deepEqual(rotated.config.principals[0].proof_key, proofKey, 'rotation without a new key cannot silently remove binding');
    await assert.rejects(client.capabilities(), /unauthorized/);
    const current = createStateClient({ baseUrl: origin, token: rotated.token!, proof: signer, fetch: route as typeof fetch });
    assert.equal((await current.capabilities()).principal.id, 'writer');
    const secretFile = file + '.auth/nonce-key', secret = readFileSync(secretFile, 'utf8');
    writeFileSync(secretFile, 'corrupt');
    await assert.rejects(current.capabilities(), (error: unknown) => (error as {code:string}).code === 'proof-state-unavailable');
    writeFileSync(secretFile, secret);
    const nextKeys = generateKeyPairSync('ed25519');
    const rebound = initServeConfig({ file, scope, root: join(dir, 'partition'), principal: { id: 'writer', kind: 'agent', proofKey: nextKeys.publicKey.export({ format: 'jwk' }) as never } });
    await assert.rejects(createStateClient({ baseUrl: origin, token: rebound.token!, proof: signer, fetch: route as typeof fetch }).capabilities(), /proof/);
    assert.equal((await createStateClient({ baseUrl: origin, token: rebound.token!, proof: createStateProofSigner(nextKeys.privateKey), fetch: route as typeof fetch }).capabilities()).principal.id, 'writer');
    const savedConfig = readFileSync(file, 'utf8'); writeFileSync(file, '{broken');
    await assert.rejects(current.capabilities(), (error: unknown) => (error as {code:string}).code === 'configuration-unavailable');
    writeFileSync(file, savedConfig);
    const { file: _file, ...config } = readServeConfig(file); config.principals = []; writeServeConfig(file, config);
    await assert.rejects(current.capabilities(), /unauthorized/);
  } finally {
    for (const server of [app, second]) if (server) { await new Promise<void>(r => server.close(() => r())); server.closeStores(); }
    cleanupDir(dir);
  }
});

test('proof validation binds method, target, token, key, algorithm and time, and consumes jti atomically across processes', async () => {
  const { sign } = await import('node:crypto');
  const { spawn } = await import('node:child_process');
  const { verifyStateProof, StateProofError } = await import('../src/serve/stateProof.js');
  const { tokenProofHash } = await import('../src/core/stateProof.js');
  const dir = mkdtempSync(join(tmpdir(), 'hunch-proof-validation-'));
  const keys = generateKeyPairSync('ed25519'), key = keys.publicKey.export({ format: 'jwk' }) as never;
  const now = Math.floor(Date.now() / 1000), input = { key, method: 'POST', url: origin + '/nuryel/v1/write', token: 'temporary-fixture-token', stateDir: dir, now };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  let nonce: string | undefined;
  try {
    try { await verifyStateProof(input); } catch (error) { assert.ok(error instanceof StateProofError); nonce = error.nonce; }
    assert.ok(nonce);
    const claims = { jti: 'unique-proof-fixture-1', htm: input.method, htu: input.url, iat: now, ath: tokenProofHash(input.token), nonce };
    const header = { typ: 'dpop+jwt', alg: 'EdDSA', jwk: key };
    const proof = (body = claims, head: Record<string, unknown> = header) => {
      const message = encode(head) + '.' + encode(body);
      return message + '.' + sign(null, Buffer.from(message), keys.privateKey).toString('base64url');
    };
    for (const patch of [{ htm: 'GET' }, { htu: input.url + '?unexpected=1' }, { ath: tokenProofHash('other') }, { iat: now - 61 }, { iat: now + 6 }]) {
      await assert.rejects(verifyStateProof({ ...input, proof: proof({ ...claims, ...patch }) }), (error: unknown) => error instanceof StateProofError && error.code === 'invalid_dpop_proof');
    }
    for (const patch of [{ alg: 'none' }, { alg: 'HS256' }, { typ: 'JWT' }, { crit: ['unsupported'] }, { jwk: keys.privateKey.export({ format: 'jwk' }) }]) {
      await assert.rejects(verifyStateProof({ ...input, proof: proof(claims, { ...header, ...patch }) }), /proof/);
    }
    await assert.rejects(verifyStateProof({ ...input, proof: proof({ ...claims, nonce: 'invented' }) }), (error: unknown) => error instanceof StateProofError && error.code === 'use_dpop_nonce');
    const module = new URL('../src/serve/stateProof.ts', import.meta.url).href;
    const script = `const {verifyStateProof}=await import(process.argv[1]);try{await verifyStateProof(JSON.parse(process.argv[2]));process.stdout.write('accepted')}catch{process.stdout.write('refused')}`;
    const run = (value: string) => new Promise<string>((accept, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, module, JSON.stringify({ ...input, proof: value })]);
      let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
      child.once('error', reject); child.once('close', code => code === 0 ? accept(output) : reject(new Error(errors)));
    });
    assert.deepEqual((await Promise.all([run(proof()), run(proof({ ...claims, iat: now - 1 }))])).sort(), ['accepted', 'refused']);
    await assert.rejects(verifyStateProof({ ...input, proof: proof() }), /already used/);
    await verifyStateProof({ ...input, now: now + 60, proof: proof({ ...claims, jti: 'nonce-boundary-valid' }) });
    await assert.rejects(verifyStateProof({ ...input, now: now + 121, proof: proof({ ...claims, iat: now + 121, jti: 'nonce-boundary-expired' }) }), (error: unknown) => error instanceof StateProofError && error.code === 'use_dpop_nonce');
  } finally { cleanupDir(dir); }
});
