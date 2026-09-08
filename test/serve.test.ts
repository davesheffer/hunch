/**
 * `hunch serve` — the HTTP binding of nuryel.state/1 and the served partition host — driven
 * through the typed client. The rules are the store binding's; these tests assert the transport:
 * bearer → principal, grants before anything, problem+json refusals, the write lock, and that a
 * served partition declares its own scope so user/organization state needs no overlay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServeApp } from "../src/serve/app.js";
import { hashToken, initServeConfig, readServeConfig, resolvePrincipal } from "../src/serve/config.js";
import { withWriteLock, writeLockPath } from "../src/serve/writelock.js";
import { createStateClient, StateClientError } from "../src/client/state.js";
import { stateHash, assertChangeSequence } from "../src/core/stateContract.js";
import { partitionOf } from "../src/store/stateBinding.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

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
  const cleanup = async () => { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, file, config, app, sofiaToken: userInit.token!, orcToken: orgInit.token!, cleanup };
}

async function listen(app: ReturnType<typeof createServeApp>): Promise<string> {
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const address = app.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

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

    const big = await fetch(`${base}/nuryel/v1/write`, { method: "POST", headers: { authorization: `Bearer ${sofiaToken}`, "content-type": "application/json", "content-length": String(2 * 1024 * 1024) }, body: "{}" }).catch(() => null);
    if (big) assert.equal(big.status, 413);
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
