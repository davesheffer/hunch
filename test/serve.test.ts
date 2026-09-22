import { cleanupDir } from "./fixtures.js";
/**
 * `hunch serve` — the HTTP binding of nuryel.state/1 and the served partition host — driven
 * through the typed client. The rules are the store binding's; these tests assert the transport:
 * bearer → principal, grants before anything, problem+json refusals, the write lock, and that a
 * served partition declares its own scope so user/organization state needs no overlay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BODY_LIMIT_BYTES, createServeApp } from "../src/serve/app.js";
import { hashToken, initServeConfig, readServeConfig, resolvePrincipal } from "../src/serve/config.js";
import { STALE_AFTER_MS, withWriteLock, writeLockPath } from "../src/serve/writelock.js";
import { createStateClient, StateClientError } from "../src/client/state.js";
import { stateHash, assertChangeSequence } from "../src/core/stateContract.js";
import { partitionOf } from "../src/store/stateBinding.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The CJS `node:fs` binding the ESM named imports are projected from: assigning
 *  on it plus `syncBuiltinESMExports()` is what lets a test patch a syscall that
 *  `src/` imported as a named ESM binding (same pattern as test/store.test.ts). */
const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

const david = { kind: "user" as const, id: "david" };
const acme = { kind: "organization" as const, id: "acme" };
const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "10042", observed_at: "2026-09-08T10:00:00Z" };

function served() {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-"));
  const file = join(dir, "hunch-serve.json");
  const userInit = initServeConfig({ file, scope: david, root: join(dir, "david"), principal: { id: "sofia@david", kind: "agent" } });
  const orgInit = initServeConfig({ file, scope: acme, root: join(dir, "acme"), principal: { id: "orc", kind: "service", grants: [acme, david] } });
  const config = readServeConfig(file);
  const app = createServeApp(config, { version: "test" });
  const cleanup = async () => { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); cleanupDir(dir); };
  return { dir, file, config, app, sofiaToken: userInit.token!, orcToken: orgInit.token!, cleanup };
}

async function listen(app: ReturnType<typeof createServeApp>): Promise<string> {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const address = app.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

test("operator view serves a public shell with no partition data and keeps reads authenticated", async () => {
  const { app, sofiaToken, cleanup } = served();
  try {
    const base = await listen(app);
    const page = await fetch(`${base}/operator`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(page.headers.get("content-security-policy")!, /connect-src 'self'/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /Shared state/);
    for (const secret of [sofiaToken, "sofia@david", "organization/acme"]) assert.ok(!html.includes(secret));
    for (const [path, type] of [["operator.js", "text/javascript"], ["operator.css", "text/css"]]) {
      const asset = await fetch(`${base}/${path}`);
      assert.equal(asset.status, 200);
      assert.ok(asset.headers.get("content-type")?.startsWith(type!));
      assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    }
    const denied = await fetch(`${base}/nuryel/v1/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: david, subject: "customer:c1" }) });
    assert.equal(denied.status, 401);
    const foreign = await fetch(`${base}/nuryel/v1/read`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: JSON.stringify({ scope: acme, subject: "customer:c1" }) });
    assert.equal(foreign.status, 403);
  } finally { await cleanup(); }
});

test("health answers liveness to anyone but names the served partitions only to an authenticated caller", async () => {
  const { app, sofiaToken, cleanup } = served();
  try {
    const base = await listen(app);
    const anonymous = await fetch(`${base}/nuryel/v1/health`);
    assert.equal(anonymous.status, 200);
    const text = await anonymous.text();
    assert.deepEqual(JSON.parse(text), { ok: true, version: "test", protocol: "nuryel.state/1" });
    for (const name of ["david", "acme", "partitions"]) assert.ok(!text.includes(name), `unauthenticated health must not mention ${name}`);

    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    assert.deepEqual((await sofia.health()).partitions, ["user/david", "organization/acme"], "a token holder still discovers the served partitions");
    const wrong = await fetch(`${base}/nuryel/v1/health`, { headers: { authorization: "Bearer nyt_wrong" } });
    assert.equal(wrong.status, 401, "a presented credential is checked, never silently downgraded to anonymous");
  } finally { await cleanup(); }
});

test("5xx problems carry a generic detail; the specifics go to the server log only", async () => {
  const { dir, file, sofiaToken, cleanup } = served();
  const logged: string[] = [];
  const log = (line: string) => { logged.push(line); };
  const lockDir = join(dir, "david", ".hunch");
  const hostName = hostname();
  // A lock held by a live same-host process we cannot disprove is never stolen,
  // so the write times out. It must NOT name our own pid: a lock carrying our pid
  // whose nonce we do not hold is a predecessor's and is reclaimed (issue #287).
  // The child is spawned INSIDE the try so the finally always kills it — a throw
  // between the spawn and the try would otherwise leak a 30 s process.
  let holder: ReturnType<typeof spawn> | undefined;
  let locked: ReturnType<typeof createServeApp> | undefined;
  let broken: ReturnType<typeof createServeApp> | undefined;
  const secretPath = join(dir, "private-internal-path");
  try {
    holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
    const holderPid = holder.pid!;
    writeFileSync(writeLockPath(lockDir), JSON.stringify({ pid: holderPid, host: hostName, nonce: "held", at: new Date().toISOString() }));
    locked = createServeApp(readServeConfig(file), { version: "test", log, writeLockTimeoutMs: 30 });
    broken = createServeApp(readServeConfig(file), { version: "test", log, openStore: () => { throw new Error(`EACCES: permission denied, open '${secretPath}'`); } });
    const lockedClient = createStateClient({ baseUrl: await listen(locked), token: sofiaToken });
    const commitment = { schema: "nuryel.commitment/1", scope: david, subject: "customer:c1", title: "locked", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov };
    await assert.rejects(lockedClient.write({ scope: david, facet: "commitments", record: commitment, idempotency_key: "locked-1" }), (e: StateClientError) => {
      assert.equal(e.status, 503);
      assert.equal(e.code, "write-lock-timeout");
      const body = JSON.stringify(e.problem);
      for (const leak of [lockDir, "write.lock", String(holderPid), hostName]) assert.ok(!body.includes(leak), `problem body must not include ${leak}: ${body}`);
      return true;
    });
    assert.ok(logged.some((line) => line.includes("write-lock-timeout") && line.includes(String(holderPid))), "the operator still sees who holds the lock");

    const brokenClient = createStateClient({ baseUrl: await listen(broken), token: sofiaToken });
    await assert.rejects(brokenClient.read({ scope: david, subject: "customer:c1" }), (e: StateClientError) => {
      assert.equal(e.status, 500);
      assert.equal(e.code, "internal");
      assert.ok(!JSON.stringify(e.problem).includes(secretPath), "an internal error message never reaches the caller");
      return true;
    });
    assert.ok(logged.some((line) => line.includes(secretPath)), "the internal error is logged server-side");

    // Contract refusals stay as informative as before.
    await assert.rejects(lockedClient.write({ scope: acme, facet: "commitments", record: commitment, idempotency_key: "outside-1" }), (e: StateClientError) => e.status === 403 && /user\/david|organization\/acme/.test(e.problem.detail));
  } finally {
    for (const app of [locked, broken]) { if (!app) continue; await new Promise<void>((r) => app.close(() => r())); app.closeStores(); }
    try { holder?.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(writeLockPath(lockDir), { force: true });
    await cleanup();
  }
});

test("serve init declares the partition, mints a token once, stores only its hash, and refuses grants the server does not serve", () => {
  const { dir, file, config, sofiaToken, cleanup } = served();
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "david", ".hunch", "partition.json"), "utf8")), david);
    assert.ok(existsSync(join(dir, "david", ".hunch", "manifest.json")));
    assert.match(readFileSync(join(dir, "david", ".gitignore"), "utf8"), /\.hunch\/\*\.sqlite/, "the partition ignores its derived index");
    assert.equal(config.partitions.length, 2);
    const sofia = config.principals.find((p) => p.id === "sofia@david")!;
    assert.equal(sofia.token_sha256, hashToken(sofiaToken));
    assert.ok(!readFileSync(file, "utf8").includes(sofiaToken), "the plaintext token is never written");
    assert.deepEqual(resolvePrincipal(config, sofiaToken)?.grants, [david]);
    assert.equal(resolvePrincipal(config, "nope"), undefined);
    assert.throws(() => initServeConfig({ file, scope: acme, root: join(dir, "david") }), /already declares partition user\/david/);
    const store = new HunchStore(hunchPaths(join(dir, "david")));
    try { assert.deepEqual(partitionOf(store), david, "the store knows the partition it IS"); } finally { store.close(); }
  } finally { void cleanup(); }
});

test("HTTP: bearer resolves the principal, grants gate every route, refusals are problem+json, and the typed client round-trips the three verbs", async () => {
  const { app, sofiaToken, orcToken, dir, cleanup } = served();
  try {
    const base = await listen(app);
    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    const orc = createStateClient({ baseUrl: base, token: orcToken });
    const nobody = createStateClient({ baseUrl: base, token: "nyt_wrong" });

    assert.equal((await sofia.health()).protocol, "nuryel.state/1");
    await assert.rejects(nobody.capabilities(), (e: StateClientError) => e.status === 401 && e.code === "unauthorized");
    const caps = await sofia.capabilities();
    assert.deepEqual(caps.repository, david, "a served partition reports itself, not a directory name");
    assert.deepEqual(caps.principal.grants, [david]);

    // A user-partition write needs no overlay: the partition IS the store.
    const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ c: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
    const created = await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "sofia-approval-http-1" });
    assert.equal(created.outcome, "created");
    assert.match(created.record_id, /^nrc_[a-f0-9]{24}$/);
    assert.ok(existsSync(join(dir, "david", ".hunch", "receipts", `${created.record_id}.json`)), "landed in the served partition directory");
    assert.ok(existsSync(join(dir, "david", ".hunch", "changes")), "with its ledger beside it");
    assert.equal((await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "sofia-approval-http-1" })).outcome, "replayed");

    // The body may not name a principal; the token did. Grants are decided from the config.
    await assert.rejects(sofia.write({ scope: acme, facet: "receipts", record: receipt, idempotency_key: "sofia-into-org-1" }), (e: StateClientError) => {
      assert.equal(e.status, 403); assert.equal(e.code, "outside-grants"); return true;
    });
    const smuggled = await fetch(`${base}/nuryel/v1/read`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: JSON.stringify({ scope: acme, principal: { id: "orc", kind: "service", grants: [acme] } }) });
    assert.equal(smuggled.status, 403, "a principal in the body is ignored");

    // Typed refusals carry the binding's code and the incumbent.
    await assert.rejects(sofia.write({ scope: david, facet: "receipts", record: { ...receipt, state: "failed" }, idempotency_key: "sofia-approval-http-1" }), (e: StateClientError) => {
      assert.equal(e.status, 409); assert.equal(e.code, "idempotency"); assert.equal(e.problem.conflict?.incumbent_id, created.record_id); return true;
    });
    await assert.rejects(sofia.write({ scope: david, facet: "receipts", record: { ...receipt, id: "nrc_000000000000000000000000" }, idempotency_key: "sofia-approval-http-2" }), (e: StateClientError) => e.status === 422 && e.code === "identity");
    await assert.rejects(sofia.write({ scope: david, facet: "receipts", record: { provenance: prov }, idempotency_key: "sofia-approval-http-3" }), (e: StateClientError) => e.status === 400 && e.code === "malformed");

    // ORC holds both partitions: it reads Sofia's user state and writes organization state.
    const read = await orc.read({ scope: david, subject: "customer:c1" });
    assert.match(read.receipt_id, /^hdr_[a-f0-9]{24}$/);
    assert.deepEqual(read.state_of_record?.invalidated_by, [created.record_id]);
    assert.equal(read.envelope.receipt_id, read.receipt_id, "the envelope rides along over HTTP");
    const orgWrite = await orc.write({ scope: acme, facet: "commitments", record: { schema: "nuryel.commitment/1", scope: acme, subject: "customer:c1", title: "quarterly review", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov }, idempotency_key: "orc-commitment-1" });
    assert.equal(orgWrite.outcome, "created");
    assert.ok(existsSync(join(dir, "acme", ".hunch", "commitments", `${orgWrite.record_id}.json`)));
    await assert.rejects(sofia.subscribe({ scope: acme, after_seq: 0 }), (e: StateClientError) => e.status === 403);
    const byId = await orc.records({ scope: david, ids: [created.record_id, "nrc_000000000000000000000000"] });
    assert.equal((byId.records[created.record_id] as { state?: string })?.state, "verified", "records by id over HTTP");
    assert.deepEqual(byId.missing, ["nrc_000000000000000000000000"]);
    assert.equal((created as { record?: { state?: string } }).record?.state, "verified", "the write result carries the stored record over HTTP");
    const stream = await orc.subscribe({ scope: david, after_seq: 0 });
    assert.equal(stream.head_seq, 1);
    assert.doesNotThrow(() => assertChangeSequence(stream.events, 0));
    assert.deepEqual(stream.events[0]?.cause, { kind: "write", principal: "sofia@david" });

    const big = await fetch(`${base}/nuryel/v1/write`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: Buffer.alloc(BODY_LIMIT_BYTES + 1, 97) });
    assert.equal(big.status, 413, "an actually oversized body is rejected");
    const malformed = await fetch(`${base}/nuryel/v1/write`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json" }, body: "[" });
    assert.equal(malformed.status, 400, "malformed JSON is a typed client error");
    assert.equal((await sofia.health()).ok, true, "the server remains usable after rejected bodies");
  } finally { await cleanup(); }
});

test("union read: `scopes` gives a principal granted several partitions ONE state_of_record; an ungranted extra is named in denied_scopes, not refused", async () => {
  const { app, sofiaToken, orcToken, cleanup } = served();
  try {
    const base = await listen(app);
    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    const orc = createStateClient({ baseUrl: base, token: orcToken });
    const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ u: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
    const done = await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "union-receipt-1" });
    const open = await orc.write({ scope: acme, facet: "commitments", record: { schema: "nuryel.commitment/1", scope: acme, subject: "customer:c1", title: "quarterly review", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov }, idempotency_key: "union-commitment-1" });

    // ORC holds both drawers: one call, both partitions, every ref tagged with its own scope.
    const union = await orc.read({ scope: david, scopes: [david, acme], subject: "customer:c1" });
    assert.match(union.receipt_id, /^hdr_[a-f0-9]{24}$/);
    assert.deepEqual(union.scope, david, "the primary scope leads");
    assert.deepEqual(union.scopes, [david, acme]);
    assert.equal(union.receipts?.length, 2);
    assert.equal(union.receipts?.[0]?.receipt_id, union.receipt_id, "receipt_id stays the primary's");
    assert.deepEqual(union.receipts?.map((r) => r.scope), [david, acme]);
    assert.ok(union.receipts?.every((r) => /^hdr_[a-f0-9]{24}$/.test(r.receipt_id)));
    assert.deepEqual(union.denied_scopes, []);
    assert.deepEqual(union.state_of_record?.done.map((r) => [r.id, r.scope]), [[done.record_id, david]]);
    assert.deepEqual(union.state_of_record?.in_force.map((r) => [r.id, r.scope]), [[open.record_id, acme]]);
    assert.deepEqual(union.state_of_record?.invalidated_by, [done.record_id]);
    assert.deepEqual(Object.keys(union.records ?? {}).sort(), [done.record_id, open.record_id].sort(), "records from both partitions ride along");
    assert.equal(union.envelope.receipt_id, union.receipt_id, "the envelope is the primary's");

    // Sofia holds only user/david: the same request answers from david and NAMES acme — 200, not 403.
    const partial = await sofia.read({ scope: david, scopes: [david, acme], subject: "customer:c1" });
    assert.deepEqual(partial.scopes, [david]);
    assert.deepEqual(partial.denied_scopes, [acme]);
    assert.equal(partial.receipts?.length, 1);
    assert.deepEqual(partial.state_of_record?.done.map((r) => r.id), [done.record_id]);
    assert.deepEqual(partial.state_of_record?.in_force, []);
    assert.ok(!(open.record_id in (partial.records ?? {})), "nothing from the ungranted partition is described");

    // Without `scopes` nothing changes: a single-partition read carries neither `scopes` nor `receipts`.
    const single = await orc.read({ scope: acme, subject: "customer:c1" });
    assert.equal(single.scopes, undefined);
    assert.equal(single.receipts, undefined);
    assert.deepEqual(single.state_of_record?.in_force.map((r) => r.id), [open.record_id]);

    // The primary scope is still gated as before; a malformed `scopes` is a typed 400.
    await assert.rejects(sofia.read({ scope: acme, scopes: [david], subject: "customer:c1" }), (e: StateClientError) => e.status === 403 && e.code === "outside-grants");
    await assert.rejects(orc.read({ scope: david, scopes: [], subject: "customer:c1" }), (e: StateClientError) => e.status === 400 && e.code === "invalid-scope");
  } finally { await cleanup(); }
});

test("concurrent writes to one partition serialize under the write lock: the ledger stays contiguous", async () => {
  const { app, sofiaToken, dir, cleanup } = served();
  try {
    const base = await listen(app);
    const sofia = createStateClient({ baseUrl: base, token: sofiaToken });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sofia.write({
      scope: david, facet: "commitments",
      record: { schema: "nuryel.commitment/1", scope: david, subject: "customer:c1", title: `task ${i}`, owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov },
      idempotency_key: `parallel-commitment-${i}`,
    })));
    assert.deepEqual(results.map((r) => r.outcome), Array(6).fill("created"));
    const stream = await sofia.subscribe({ scope: david, after_seq: 0 });
    assert.equal(stream.head_seq, 6);
    assert.doesNotThrow(() => assertChangeSequence(stream.events, 0));
    assert.ok(!existsSync(writeLockPath(join(dir, "david", ".hunch"))), "the lock is released");
  } finally { await cleanup(); }
});

test("the write lock is held across a sync section and released on throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-"));
  try {
    let inside = 0, max = 0;
    const work = () => withWriteLock(dir, async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 15)); inside--; });
    await Promise.all([work(), work(), work()]);
    assert.equal(max, 1, "never two holders");
    await assert.rejects(withWriteLock(dir, () => { throw new Error("boom"); }), /boom/);
    assert.ok(!existsSync(writeLockPath(dir)));
  } finally { cleanupDir(dir); }
});

/** A child that stays alive until we kill it. */
function spawnSleeper(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
  if (typeof child.pid !== "number") throw new Error("child did not start");
  return { pid: child.pid, kill: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
}

/** A pid that is certainly dead: spawned, exited, and reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 100)); // let the kernel reap the zombie
  return pid;
}

const BOOT = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

test("the write lock never steals a stale-looking lock held by a live same-host process (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-live-"));
  const child = spawnSleeper();
  try {
    const path = writeLockPath(dir);
    // A LIVE, unrelated same-host pid and no token: nothing disproves it, so the
    // lock stays its owner's however old the file looks.
    writeFileSync(path, JSON.stringify({ pid: child.pid, host: hostname(), nonce: "other", at: new Date().toISOString() }));
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(path, old, old);
    let entered = false;
    await assert.rejects(
      withWriteLock(dir, () => { entered = true; }, { timeoutMs: 25 }),
      /write lock .* held by pid/,
    );
    assert.equal(entered, false, "a live same-host owner must keep the lock despite its age");
    assert.ok(existsSync(path), "the live owner's lock remains intact");
  } finally { child.kill(); cleanupDir(dir); }
});

/**
 * BEHAVIOUR CHANGE vs origin/main. An own-pid + foreign-nonce record with NO
 * token: main NEVER stole it (the pid is alive, so the lock was authoritative
 * forever — issue #287's deadlock). Now the AGE rule decides it, on EVERY
 * platform: a nonce we do not hold proves only that the lock is not OURS, never
 * that its writer is dead. "Our pid" can belong to a live neighbour in another
 * pid space that shares our hostname and volume — two containers sharing them
 * but not the pid namespace on linux (k8s sidecars, `--net=host`), and off linux
 * a linux GUEST of this machine (WSL2 shares the Windows hostname and /mnt/c,
 * Docker Desktop bind mounts). So a FRESH such lock is left alone and only an
 * over-STALE_AFTER_MS one is taken over. The loop over all three platforms runs
 * through the token seam and now proves that the platform no longer matters.
 */
for (const platform of ["darwin", "win32", "linux"] as const) {
  test(`an own-pid lock with a foreign nonce and no token: the age rule on ${platform} (issue #287)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-reuse-"));
    try {
      const path = writeLockPath(dir);
      // The container-restart shape on a platform with no process-instance token:
      // the record names OUR pid on OUR host, so `kill(pid, 0)` succeeds forever.
      // The nonce says only that the lock is not one WE took.
      writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "recycled", at: new Date().toISOString() }));
      const seam = { self: null, of: () => null, platform };
      let entered = false;
      // FRESH: the age rule has nothing to say yet, so the possible neighbour keeps it.
      await assert.rejects(
        withWriteLock(dir, () => { entered = true; }, { timeoutMs: 50, startToken: seam }),
        /write lock .* held by pid/,
        "a tokenless own-pid record may be a live neighbour's lock",
      );
      assert.equal(entered, false);
      assert.ok(existsSync(path), "nothing is removed while only the pid says 'alive'");
      // Past STALE_AFTER_MS the ordinary age rule takes it, as for any lock.
      const old = new Date(Date.now() - (STALE_AFTER_MS + 30_000));
      utimesSync(path, old, old);
      await withWriteLock(dir, () => { entered = true; }, { timeoutMs: 2_000, startToken: seam });
      assert.equal(entered, true, "the recycled-pid lock is taken over, not waited on forever");
      assert.ok(!existsSync(path), "the reclaimed lock is released after the write");
    } finally { cleanupDir(dir); }
  });
}

test("the write lock reclaims our own pid when the recorded TOKEN is a predecessor's (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-token-reuse-"));
  try {
    const path = writeLockPath(dir);
    // Same boot, same namespace, different start ticks: a different instance of
    // this pid wrote that lock. Fresh mtime, so only identity can settle it.
    //
    // NOT the container-restart story. "recycled" is SAME-namespace pid reuse —
    // the process died and the kernel handed its number to a new one on this
    // boot. A container restarted in a NEW pid namespace (or a lock from before
    // a reboot) reads "unprobeable" instead and falls back to the age rule, so
    // writes refuse for up to STALE_AFTER_MS (~60 s; 10 s for `.rmw-lock`)
    // rather than taking over instantly the way main did on a dead pid.
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "recycled", at: new Date().toISOString(), start: `${BOOT}:1:9:100` }));
    let entered = false;
    await withWriteLock(dir, () => { entered = true; }, {
      timeoutMs: 2_000,
      startToken: { self: `${BOOT}:1:9:200`, of: () => `${BOOT}:1:9:200` },
    });
    assert.equal(entered, true, "a recycled token is proof, whatever the lock's age");
    assert.ok(!existsSync(path), "the reclaimed lock is released after the write");
  } finally { cleanupDir(dir); }
});

test("the write lock never steals a lock whose recorded TOKEN is our own live instance (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-token-same-"));
  try {
    const path = writeLockPath(dir);
    const self = `${BOOT}:1:9:200`;
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "ours", at: new Date().toISOString(), start: self }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    let entered = false;
    await assert.rejects(
      withWriteLock(dir, () => { entered = true; }, { timeoutMs: 50, startToken: { self, of: () => self } }),
      /write lock .* held by pid/,
      "an identical token is the genuine owner — age and mtime say nothing",
    );
    assert.equal(entered, false);
    assert.ok(existsSync(path), "the live owner's lock remains intact");
  } finally { cleanupDir(dir); }
});

test("the write lock reclaims a lock whose pid now belongs to an unrelated live process (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-reuse-child-"));
  const child = spawnSleeper();
  try {
    const path = writeLockPath(dir);
    writeFileSync(path, JSON.stringify({ pid: child.pid, host: hostname(), nonce: "recycled", at: new Date().toISOString(), start: `${BOOT}:1:9:100` }));
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(path, old, old);
    let entered = false;
    await withWriteLock(dir, () => { entered = true; }, {
      timeoutMs: 2_000,
      startToken: { self: `${BOOT}:1:9:200`, of: () => `${BOOT}:1:9:999` },
    });
    assert.equal(entered, true, "a live process whose token differs never owned this lock");
    assert.ok(!existsSync(path), "the reclaimed lock is released after the write");
  } finally { child.kill(); cleanupDir(dir); }
});

test("a live unrelated pid WITHOUT a token keeps the lock — the remaining macOS/Windows gap (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-legacy-gap-"));
  const child = spawnSleeper();
  try {
    const path = writeLockPath(dir);
    // No `start` in the record (a legacy lock, or any lock written off linux):
    // the pid is alive and not ours, and there is no spawn-free way to tell
    // whether it is the same process instance. It keeps the lock. Documented,
    // not fixed — the safe direction is never to steal on a guess.
    writeFileSync(path, JSON.stringify({ pid: child.pid, host: hostname(), nonce: "legacy", at: new Date().toISOString() }));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(path, old, old);
    let entered = false;
    await assert.rejects(
      withWriteLock(dir, () => { entered = true; }, { timeoutMs: 50 }),
      /write lock .* held by pid/,
    );
    assert.equal(entered, false);
    assert.ok(existsSync(path), "a live pid we cannot disprove keeps its lock");
  } finally { child.kill(); cleanupDir(dir); }
});

test("an UNPROBEABLE owner (another boot / namespace) falls back to the age rule (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-unprobeable-"));
  try {
    const path = writeLockPath(dir);
    const pid = await deadPid();
    // The token was written under a different boot id, so this pid NUMBER means
    // nothing under ours: its death is not evidence that the owner died. Only
    // age may steal, exactly as for a foreign host.
    writeFileSync(path, JSON.stringify({ pid, host: hostname(), nonce: "other-boot", at: new Date().toISOString(), start: "0000ffff-0000-0000-0000-000000000000:1:9:100" }));
    const seam = { self: `${BOOT}:1:9:200`, of: () => null };
    let entered = false;
    await assert.rejects(
      withWriteLock(dir, () => { entered = true; }, { timeoutMs: 50, startToken: seam }),
      /write lock/,
      "a dead pid from another namespace proves nothing; the fresh lock stands",
    );
    assert.equal(entered, false);
    assert.ok(existsSync(path), "the lock is not removed on meaningless pid evidence");
    // Past STALE_AFTER_MS the age rule takes it, like any foreign-host lock.
    const old = new Date(Date.now() - (STALE_AFTER_MS + 30_000));
    utimesSync(path, old, old);
    let ran = false;
    await withWriteLock(dir, () => { ran = true; }, { timeoutMs: 5_000, startToken: seam });
    assert.equal(ran, true, "past the stale age an unprobeable lock is taken over");
    assert.ok(!existsSync(path), "the lock is released afterwards");
  } finally { cleanupDir(dir); }
});

/** The skew repro runs twice over the identity seam:
 *  - "real probe" is whatever this platform can prove (on linux the holder's own
 *    token matches, so the token path keeps the lock);
 *  - "no identity" strips the token path entirely, so the ONLY thing standing
 *    between the contender and the holder's own lock is the held-nonce row of
 *    the decision table. On linux that row is what CI would otherwise never
 *    exercise, because the real probe answers first. */
const skewSeams: [string, { self: string | null; of: (pid: number) => string | null } | undefined][] = [
  ["real probe", undefined],
  ["no identity (held-nonce row only)", { self: null, of: () => null }],
];

for (const backMs of [30_000, 10 * 60_000]) {
  for (const [label, startToken] of skewSeams) {
    test(`a LIVE holder's lock back-dated ${backMs / 1000}s by clock skew is never stolen — ${label} (issue #287)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-skew-"));
      try {
        const path = writeLockPath(dir);
        const opts = startToken ? { startToken } : {};
        let inside = 0;
        let max = 0;
        let stolen: unknown;
        await withWriteLock(dir, async () => {
          inside++;
          max = Math.max(max, inside);
          // Exactly the reviewer's repro: a filesystem/host clock disagreement, an
          // NTP step or a suspend makes a HELD lock look arbitrarily old. Nothing
          // in the decision may read a clock, so the holder keeps it.
          const back = new Date(Date.now() - backMs);
          utimesSync(path, back, back);
          await assert.rejects(
            withWriteLock(dir, async () => { inside++; max = Math.max(max, inside); inside--; }, { timeoutMs: 100, ...opts })
              .catch((error) => { stolen = error; throw error; }),
            /write lock .* held by pid/,
          );
          inside--;
        }, { timeoutMs: 5_000, ...opts });
        assert.equal(max, 1, "the holder count never exceeds 1");
        assert.ok(stolen instanceof Error, "the contender timed out rather than stealing");
        assert.ok(!existsSync(path), "the holder released its own lock");
      } finally { cleanupDir(dir); }
    });
  }
}

test("regression guard: in-process contenders over one stale lock never overlap (issue #287)", async () => {
  // NOTE: this does NOT demonstrate the cross-process takeover race. Node is
  // single-threaded and `judge stale → rm → open` is one synchronous stretch
  // here, so on origin/main it cannot fail either. It only guards against a
  // future edit that puts an await inside that stretch. The real race is
  // exercised by the deterministic takeover-race test below.
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-takeover-"));
  try {
    const pid = await deadPid();
    const path = writeLockPath(dir);
    writeFileSync(path, JSON.stringify({ pid, host: hostname(), nonce: "dead", at: new Date().toISOString() }));
    let inside = 0;
    let max = 0;
    let ran = 0;
    await Promise.all(Array.from({ length: 8 }, () => withWriteLock(dir, async () => {
      inside++;
      max = Math.max(max, inside);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      ran++;
      inside--;
    }, { timeoutMs: 10_000 })));
    assert.equal(max, 1, "the write lock is mutually exclusive across a stale-lock takeover");
    assert.equal(ran, 8, "every contender eventually ran");
    assert.ok(!existsSync(path), "the lock is released afterwards");
  } finally { cleanupDir(dir); }
});

test("DETERMINISTIC: a contender under the claim re-judges and never removes the winner's LIVE lock (issue #287)", async () => {
  // The takeover race, made repeatable. On origin/main "judge stale → rm →
  // create" is not atomic: contender B judges the corpse stale, contender A
  // wins the whole sequence in between, and B's `rm` then deletes A's FRESH
  // live lock and lets a second writer in. The multi-process smoke test below
  // hits that window only by luck; here A is INJECTED into it.
  //
  // The injection point is B's own fs calls, patched one-shot: whichever of
  // B's `mkdirSync(<lock>.reclaim)` (this branch) or `rmSync(<lock>)` (main,
  // which has no claim) fires first, A's entire protocol runs before it. On
  // this branch B then holds the claim, re-judges under it, sees A's live lock
  // and removes nothing.
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-deterministic-"));
  const child = spawnSleeper();
  // Captured OUTSIDE the try so the finally can always undo the patch, even when
  // an assertion (or the patch itself) throws midway.
  const originalFs = { mkdirSync: fs.mkdirSync, rmSync: fs.rmSync };
  try {
    const path = writeLockPath(dir);
    const claim = `${path}.reclaim`;
    const corpse = await deadPid();
    // A plain corpse: a provably dead same-host pid, so B judges it stale.
    writeFileSync(path, JSON.stringify({ pid: corpse, host: hostname(), nonce: "corpse", at: new Date().toISOString() }));

    const originalMkdirSync = fs.mkdirSync;
    const originalRmSync = fs.rmSync;
    const originalWriteFileSync = fs.writeFileSync;
    let fired = 0;
    // Contender A's whole sequence, over the ORIGINAL syscalls so it cannot
    // re-enter the patch: claim, remove the corpse, publish a LIVE lock owned by
    // a real running child, release the claim. Strictly one-shot: B may reach
    // several patched calls, but A only ever runs its protocol once.
    const simulateA = (): void => {
      if (fired > 0) return;
      fired++;
      try { originalMkdirSync(claim); } catch { return; } // A loses the claim: nothing further
      try {
        originalRmSync(path, { force: true });
        originalWriteFileSync(path, JSON.stringify({ pid: child.pid, host: hostname(), nonce: "winner-A", at: new Date().toISOString() }));
      } finally {
        try { originalRmSync(claim, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    };
    const isLockPath = (p: unknown): boolean => String(p).replace(/\\/g, "/") === path.replace(/\\/g, "/");
    const isClaimPath = (p: unknown): boolean => String(p).replace(/\\/g, "/") === claim.replace(/\\/g, "/");
    fs.mkdirSync = ((target: Parameters<typeof originalMkdirSync>[0], options?: never) => {
      if (isClaimPath(target)) simulateA();
      return originalMkdirSync(target, options);
    }) as typeof fs.mkdirSync;
    fs.rmSync = ((target: Parameters<typeof originalRmSync>[0], options?: Parameters<typeof originalRmSync>[1]) => {
      if (isLockPath(target)) simulateA(); // origin/main's path: no claim is ever taken
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;
    syncBuiltinESMExports();

    let entered = false;
    let rejection: unknown;
    try {
      await withWriteLock(dir, () => { entered = true; }, { timeoutMs: 300 });
    } catch (error) { rejection = error; }
    fs.mkdirSync = originalMkdirSync;
    fs.rmSync = originalRmSync;
    syncBuiltinESMExports();

    assert.equal(fired, 1, "contender A was injected exactly once");
    assert.ok(rejection instanceof Error, `B must refuse, not enter the mutex behind A (entered=${entered})`);
    assert.equal(entered, false, "two writers must never be inside the write lock");
    assert.ok(existsSync(path), "A's live lock still exists — B removed nothing");
    const survivor = JSON.parse(readFileSync(path, "utf8")) as { pid: number; nonce: string };
    assert.equal(survivor.pid, child.pid, "the surviving lock is A's, owned by the live child");
    assert.equal(survivor.nonce, "winner-A");
    assert.ok(!existsSync(claim), "no claim directory is left behind");
  } finally {
    fs.mkdirSync = originalFs.mkdirSync;
    fs.rmSync = originalFs.rmSync;
    syncBuiltinESMExports();
    child.kill();
    cleanupDir(dir);
  }
});

test("stress SMOKE: concurrent PROCESSES racing one stale write lock never overlap (issue #287)", async () => {
  // NOT a reliable reproducer — origin/main fails only ~1–25% of runs, because
  // the losing contender has to land its `rm` inside the winner's few-syscall
  // window. The deterministic takeover-race test below is the regression proof;
  // this one is kept as a stress smoke test over the real, unpatched syscalls.
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-procs-"));
  try {
    const pid = await deadPid();
    const path = writeLockPath(dir);
    // One corpse, N processes that all judge it stale in the same tick: without a
    // serialized takeover the second remover deletes the FIRST winner's fresh
    // lock and two writers run inside the mutex at once.
    writeFileSync(path, JSON.stringify({ pid, host: hostname(), nonce: "dead", at: new Date().toISOString() }));
    const marker = join(dir, "holder");
    const child = [
      `import { withWriteLock } from "${process.env.RACE_WRITELOCK ?? "./src/serve/writelock.ts"}";`,
      'import { openSync, closeSync, rmSync, appendFileSync } from "node:fs";',
      'const dir = process.env.RACE_DIR; const marker = process.env.RACE_MARKER; const tag = process.env.RACE_TAG;',
      'const startAt = Number(process.env.RACE_START_AT);',
      'while (Date.now() < startAt) { /* spin to a common start */ }',
      'let acquired = 0;',
      'for (let round = 0; round < 4; round++) {',
      '  await withWriteLock(dir, async () => {',
      // The overlap proof is a hard fact, not a timestamp comparison: only one
      // holder can create this file with "wx".
      '    const fd = openSync(marker, "wx");',
      '    closeSync(fd);',
      '    acquired++;',
      '    await new Promise((r) => setTimeout(r, 30));',
      '    rmSync(marker, { force: true });',
      '  }, { timeoutMs: 30000 });',
      '}',
      'appendFileSync(process.env.RACE_LOG, `${tag} ${acquired}\\n`);',
    ].join("\n");
    const log = join(dir, "race.log");
    const children = ["a", "b", "c", "d", "e", "f"].map((tag) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", child], {
      cwd: process.cwd(),
      env: { ...process.env, RACE_DIR: dir, RACE_MARKER: marker, RACE_LOG: log, RACE_TAG: tag, RACE_START_AT: String(Date.now() + 1200) },
      stdio: ["ignore", "ignore", "pipe"],
    }));
    const exits = await Promise.all(children.map((c) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      c.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      c.on("exit", (code) => resolve({ code, stderr }));
    })));
    for (const exit of exits) assert.equal(exit.code, 0, `a racing writer failed (an EEXIST on the holder marker means two holders): ${exit.stderr}`);
    const lines = readFileSync(log, "utf8").trim().split("\n").sort();
    assert.deepEqual(lines, ["a 4", "b 4", "c 4", "d 4", "e 4", "f 4"], "every child acquired the lock in every round");
    assert.ok(!existsSync(marker), "no holder marker is left behind");
    assert.ok(!existsSync(writeLockPath(dir)), "the lock is released afterwards");
  } finally { cleanupDir(dir); }
});

test("a live reclaim claim blocks takeover; a stranded one is cleared (issue #287)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-writelock-claim-"));
  try {
    const pid = await deadPid();
    const path = writeLockPath(dir);
    writeFileSync(path, JSON.stringify({ pid, host: hostname(), nonce: "dead", at: new Date().toISOString() }));
    const claim = `${path}.reclaim`;
    mkdirSync(claim);
    let entered = false;
    await assert.rejects(
      withWriteLock(dir, () => { entered = true; }, { timeoutMs: 100 }),
      /write lock/,
      "another contender holds the claim: this one must not remove the lock",
    );
    assert.equal(entered, false);
    assert.ok(existsSync(path), "the stale lock is only removed by the claim holder");
    // A claimer that crashed inside the (microsecond) claimed section leaves the
    // claim behind; age is what makes it reclaimable.
    const stranded = new Date(Date.now() - 60_000);
    utimesSync(claim, stranded, stranded);
    let ran = false;
    await withWriteLock(dir, () => { ran = true; }, { timeoutMs: 5_000 });
    assert.equal(ran, true, "a stranded claim is cleared and the takeover proceeds");
    assert.ok(!existsSync(claim), "no claim directory is left behind");
    assert.ok(!existsSync(path), "the lock is released afterwards");
  } finally { cleanupDir(dir); }
});

test("HTTP writes lock the shared overlay home, leaving a public lock owned by another writer intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-overlay-lock-"));
  const root = join(dir, "david");
  const overlayRoot = join(dir, "memory");
  const overlay = join(overlayRoot, ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", overlayRoot]);
  const file = join(dir, "hunch-serve.json");
  const init = initServeConfig({ file, scope: david, root, principal: { id: "sofia@david", kind: "agent" } });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, mode: "shared", autoCommit: false }) + "\n");
  const publicLock = writeLockPath(join(root, ".hunch"));
  try {
    // A live writer in the public checkout may be old enough to trip age-based
    // stealing. Shared-mode state belongs to the overlay, so this request must
    // leave that unrelated public lock untouched.
    writeFileSync(publicLock, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "public-writer", at: new Date().toISOString() }));
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(publicLock, old, old);
    const app = createServeApp(readServeConfig(file), { version: "test" });
    try {
      const base = await listen(app);
      const sofia = createStateClient({ baseUrl: base, token: init.token! });
      const result = await sofia.write({
        scope: david,
        facet: "commitments",
        record: { schema: "nuryel.commitment/1", scope: david, subject: "customer:overlay-lock", title: "overlay lock", owner: "david", due: "2026-09-30", status: "open", valid_from: "2026-09-08T10:00:00Z", valid_to: null, provenance: prov },
        idempotency_key: "overlay-lock-http-1",
      });
      assert.equal(result.outcome, "created");
      assert.ok(existsSync(publicLock), "the public writer's lock was not stolen");
      assert.ok(existsSync(join(overlay, "commitments", `${result.record_id}.json`)), "the record landed in the shared overlay");
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
      app.closeStores();
    }
  } finally { cleanupDir(dir); }
});

test("CLI: `hunch serve init --config <file>` honors the path from any cwd (1.26.0 handed it to the parent command)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-cli-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "hunch-serve-cli-cwd-"));
  try {
    const cli = join(process.cwd(), "src", "cli", "index.ts");
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const out = execFileSync(process.execPath, [tsx, cli, "serve", "init", "--config", join(dir, "cfg.json"), "--partition", "user:cli", "--root", join(dir, "cli"), "--principal", "p", "--port", "27780", "--json"], { cwd: elsewhere, encoding: "utf8", env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic" } });
    const parsed = JSON.parse(out.trim().split(/\r?\n/).at(-1)!) as { config: string; token: string | null };
    assert.equal(parsed.config, join(dir, "cfg.json"));
    assert.ok(existsSync(join(dir, "cfg.json")), "written where asked");
    assert.ok(!existsSync(join(elsewhere, "hunch-serve.json")), "and not into the cwd");
    assert.ok(parsed.token && !readFileSync(join(dir, "cfg.json"), "utf8").includes(parsed.token));
    assert.equal(readServeConfig(join(dir, "cfg.json")).port, 27780, "--port after init reaches init, not the parent");
  } finally { cleanupDir(dir); cleanupDir(elsewhere); }
});

test("a served partition that is a git repository commits every write: durability is committed, not local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-serve-durable-"));
  try {
    const file = join(dir, "hunch-serve.json");
    const root = join(dir, "david");
    const init = initServeConfig({ file, scope: david, root, principal: { id: "sofia@david", kind: "agent" } });
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "test"]);
    const app = createServeApp(readServeConfig(file), { version: "test" });
    try {
      const base = await listen(app);
      const sofia = createStateClient({ baseUrl: base, token: init.token! });
      const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ d: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: [] };
      const created = await sofia.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "durable-1" });
      assert.equal(created.outcome, "created");
      assert.equal(created.durability, "committed", "the flush ran under the write lock and still committed");
      const log = execFileSync("git", ["-C", root, "log", "--format=%s", "--name-only"], { encoding: "utf8" });
      assert.match(log, /nuryel: write nrc_/);
      assert.match(log, /\.hunch\/receipts\/nrc_[a-f0-9]{24}\.json/, "the record is in the commit");
      assert.match(log, /\.hunch\/changes\/user-david-[a-f0-9]{8}\.json/, "the ledger rides the same commit");
      assert.match(log, /\.hunch\/partition\.json/, "the partition declaration is committed");
      assert.doesNotMatch(log, /write\.lock|hunch\.sqlite/, "derived artifacts never enter a commit");
      assert.ok(!existsSync(writeLockPath(join(root, ".hunch"))));
    } finally { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); }
  } finally { cleanupDir(dir); }
});

test("HTTP and typed client round-trip field citations and refuse stale value bindings", async () => {
  const { app, sofiaToken, cleanup } = served();
  try {
    const client = createStateClient({ baseUrl: await listen(app), token: sofiaToken });
    const caps = await client.capabilities();
    assert.ok(caps.capabilities.includes("nuryel.field-provenance/1"));
    const dependency = { kind: "external", ref: crmEvent }, content = "😀 Ready.";
    const field_provenance = [{ selector: { kind: "text", start: 2, end: 8 }, value_hash: stateHash("Ready."), dependency_hashes: [stateHash(dependency)] }];
    const record = { schema: "nuryel.derived/1", scope: david, subject: "customer:cited", content, content_hash: stateHash(content), dependencies: [dependency], transform_version: "cited/v1", computed_at: "2026-09-13T10:00:00Z", valid_to: null, state: "current", provenance: prov, field_provenance };
    const written = await client.write({ scope: david, facet: "derived", record, idempotency_key: "cited-http-write" });
    assert.deepEqual(written.record?.field_provenance, field_provenance);
    const read = await client.read({ scope: david, subject: "customer:cited" });
    assert.deepEqual(read.records?.[written.record_id]?.field_provenance, field_provenance);
    const exact = await client.records({ scope: david, ids: [written.record_id] });
    assert.deepEqual(exact.records[written.record_id]?.field_provenance, field_provenance);
    await assert.rejects(client.write({ scope: david, facet: "derived", record: { ...record, field_provenance: [{ ...field_provenance[0], value_hash: stateHash("Changed") }] }, idempotency_key: "cited-http-invalid" }), (e: StateClientError) => e.status === 400 && e.code === "malformed" && /value_hash/.test(e.message));
  } finally { await cleanup(); }
});

test('HTTP authenticates visibility across partitions and concurrent users, including source revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hunch-http-visibility-')), file = join(dir, 'serve.json');
  initServeConfig({ file, scope: david, root: join(dir, 'user') });
  const ownerToken = initServeConfig({ file, scope: acme, root: join(dir, 'org'), principal: { id: 'owner', kind: 'human', grants: [david, acme] } }).token!;
  const readerToken = initServeConfig({ file, scope: acme, root: join(dir, 'org'), principal: { id: 'reader', kind: 'agent', grants: [david, acme] } }).token!;
  const app = createServeApp(readServeConfig(file));
  try {
    const base = await listen(app), owner = createStateClient({ baseUrl: base, token: ownerToken }), reader = createStateClient({ baseUrl: base, token: readerToken });
    const visibility = { owner: 'owner', readers: ['reader'], writers: [] };
    const content = 'Restricted CRM schedule';
    const source = await owner.write({ scope: david, facet: 'derived', idempotency_key: 'cross-private-source', record: { schema: 'nuryel.derived/1', scope: david, subject: 'customer:restricted', content, content_hash: stateHash(content), dependencies: [{ kind: 'schema', name: 'crm', fingerprint: stateHash('v1') }], transform_version: 'schedule/v1', computed_at: '2026-09-13T10:00:00Z', valid_to: null, state: 'current', provenance: prov, visibility } });
    const linked = await owner.write({ scope: acme, facet: 'derived', idempotency_key: 'cross-linked-record', record: { ...source.record, id: undefined, visibility: undefined, scope: acme, transform_version: 'linked/v1', dependencies: [{ kind: 'record', scope: david, id: source.record_id, record_hash: source.record_hash }] } });
    assert.ok((await reader.records({ scope: acme, ids: [linked.record_id] })).records[linked.record_id]);
    await owner.write({ scope: david, facet: 'derived', idempotency_key: 'revoke-source-reader', expected_version: source.record_hash, record: { ...source.record, visibility: { ...visibility, readers: [] } } });
    const [own, denied] = await Promise.all([owner.read({ scope: acme, subject: 'customer:restricted' }), reader.read({ scope: acme, subject: 'customer:restricted' })]);
    assert.equal(own.state_of_record?.current.length, 1);
    assert.deepEqual(denied.state_of_record?.current, []);
    assert.ok(!JSON.stringify(denied).includes(source.record_id));
    assert.deepEqual((await reader.records({ scope: acme, ids: [linked.record_id] })).missing, [linked.record_id]);
    assert.deepEqual((await reader.subscribe({ scope: acme, after_seq: 0 })).events, []);
    const spoof = await fetch(base + '/nuryel/v1/records', { method: 'POST', headers: { authorization: 'Bearer ' + readerToken, 'content-type': 'application/json' }, body: JSON.stringify({ principal: { id: 'owner', kind: 'human', grants: [david, acme] }, scope: david, ids: [source.record_id] }) });
    assert.deepEqual((await spoof.json() as { missing: string[] }).missing, [source.record_id]);
    await assert.rejects(reader.write({ scope: david, facet: 'derived', idempotency_key: 'cross-private-source', record: source.record! }), (e: StateClientError) => e.status === 403 && !JSON.stringify(e.problem).includes(source.record_id));
  } finally { await new Promise<void>(r => app.close(() => r())); app.closeStores(); cleanupDir(dir); }
});

test("MCP over streamable HTTP: the nuryel_* tools behind the same credential, grants and refusals as the REST routes", async () => {
  const { app, sofiaToken, orcToken, cleanup } = served();
  try {
    const base = await listen(app);
    const connect = async (token: string) => {
      const client = new McpClient({ name: "serve-mcp-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/nuryel/v1/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    };
    // No credential → the same 401 problem as every other route; MCP is never a way around auth.
    const anon = new McpClient({ name: "anon", version: "1.0.0" });
    await assert.rejects(anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/nuryel/v1/mcp`))), /401/);
    // GET is refused: the server is stateless, there is no stream to open.
    const get = await fetch(`${base}/nuryel/v1/mcp`, { headers: { authorization: `Bearer ${sofiaToken}` } });
    assert.equal(get.status, 405);

    const sofia = await connect(sofiaToken);
    const tools = (await sofia.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["nuryel_capabilities", "nuryel_capture", "nuryel_capture_batch", "nuryel_read", "nuryel_records", "nuryel_subscribe", "nuryel_write"]);
    const caps = await sofia.callTool({ name: "nuryel_capabilities", arguments: {} });
    const capsOut = caps.structuredContent as { protocol: string; principal: { id: string; grants: unknown[] } };
    assert.equal(capsOut.protocol, "nuryel.state/1");
    assert.equal(capsOut.principal.id, "sofia@david");

    const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ mcp: 1 }), state: "verified", occurred_at: "2026-09-16T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
    const write = async (client: InstanceType<typeof McpClient>, args: Record<string, unknown>) => client.callTool({ name: "nuryel_write", arguments: args });
    const created = await write(sofia, { scope: david, facet: "receipts", record: receipt, idempotency_key: "mcp-receipt-1" });
    assert.equal(created.isError, undefined);
    const createdOut = created.structuredContent as { outcome: string; record_id: string; record_hash: string };
    assert.equal(createdOut.outcome, "created");
    // Replay returns the original; the same key with a different payload is refused with the REST problem body.
    const replayed = await write(sofia, { scope: david, facet: "receipts", record: receipt, idempotency_key: "mcp-receipt-1" });
    assert.equal((replayed.structuredContent as { outcome: string; record_id: string }).outcome, "replayed");
    assert.equal((replayed.structuredContent as { record_id: string }).record_id, createdOut.record_id);
    const changed = await write(sofia, { scope: david, facet: "receipts", record: { ...receipt, occurred_at: "2026-09-16T11:00:00Z" }, idempotency_key: "mcp-receipt-1" });
    assert.equal(changed.isError, true);
    const refusal = changed.structuredContent as { status: number; title: string; detail: string };
    assert.equal(refusal.status, 409);
    assert.equal(refusal.title, "idempotency");
    assert.match((changed.content as Array<{ text: string }>)[0]!.text, /refused \[idempotency\] \(409\)/);
    // A smuggled principal in the arguments is ignored: the credential decided who wrote.
    const smuggled = await write(sofia, { scope: david, facet: "receipts", principal: { id: "orc", kind: "service", grants: [acme] }, record: { ...receipt, request_fingerprint: stateHash({ mcp: 2 }) }, idempotency_key: "mcp-receipt-2" });
    assert.equal((smuggled.structuredContent as { outcome: string }).outcome, "created");
    // Outside grants → 403, as a tool error, never a silent empty answer.
    const outside = await sofia.callTool({ name: "nuryel_read", arguments: { scope: acme, subject: "customer:c1" } });
    assert.equal(outside.isError, true);
    assert.equal((outside.structuredContent as { status: number; title: string }).title, "outside-grants");

    // The write is visible to another principal over REST and the other way round: one store, one ledger.
    const orc = createStateClient({ baseUrl: base, token: orcToken });
    const rest = await orc.read({ scope: david, subject: "customer:c1" });
    assert.ok(rest.state_of_record!.done.some((r) => r.id === createdOut.record_id));
    const orcMcp = await connect(orcToken);
    const read = await orcMcp.callTool({ name: "nuryel_read", arguments: { scope: david, subject: "customer:c1" } });
    const readOut = read.structuredContent as { state_of_record: { done: Array<{ id: string }> }; records: Record<string, unknown>; envelope: { text: string } };
    assert.ok(readOut.state_of_record.done.some((r) => r.id === createdOut.record_id));
    assert.ok(readOut.records[createdOut.record_id]);
    assert.equal(typeof readOut.envelope.text, "string");
    const events = await orcMcp.callTool({ name: "nuryel_subscribe", arguments: { scope: david, after_seq: 0 } });
    assert.equal((events.structuredContent as { events: unknown[] }).events.length, 2);
    await sofia.close(); await orcMcp.close();
  } finally {
    await cleanup();
  }
});
