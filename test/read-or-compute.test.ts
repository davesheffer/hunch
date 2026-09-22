/**
 * readOrCompute (TS client helper) against a real `hunch serve`: reuse on an unchanged dependency
 * set without computing, supersede on a changed one, request-scoped idempotency keys, and a client
 * canonical hash that stays byte for byte with the server's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServeApp } from "../src/serve/app.js";
import { initServeConfig, readServeConfig } from "../src/serve/config.js";
import { createStateClient, readOrCompute, StateClientError } from "../src/client/state.js";
import { canonicalJson, stateHash as clientStateHash } from "../src/client/readOrCompute.js";
import { stateHash } from "../src/core/stateContract.js";
import { canonicalize } from "../src/core/stateCanonical.js";

const scope = { kind: "organization" as const, id: "acme" };
const provenance = { source: "agent_recorded", confidence: 0.8, evidence: ["readOrCompute test"] };
const event = (key: string, version: string) => ({ kind: "external" as const, ref: { system: "crm", object_type: "event", object_key: key, version, observed_at: "2026-09-17T10:00:00Z" } });
const schemaDep = { kind: "schema" as const, name: "summary", fingerprint: stateHash("summary/v1") };

async function served() {
  const dir = mkdtempSync(join(tmpdir(), "hunch-read-or-compute-"));
  const file = join(dir, "hunch-serve.json");
  const { token } = initServeConfig({ file, scope, root: join(dir, "acme"), principal: { id: "writer", kind: "agent" } });
  const app = createServeApp(readServeConfig(file), { version: "test" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const address = app.address();
  const client = createStateClient({ baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, token: token! });
  const cleanup = async () => { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); rmSync(dir, { recursive: true, force: true }); };
  return { client, cleanup };
}

test("client canonical form and hash match the server's byte for byte", async () => {
  const values: unknown[] = [
    "Python summary: שלום \u{1F331}",
    { b: [1, "é", null, true, 2.5], a: { "\u{1F331}": 1, "￿": 2, z: "x\n\t\"\\ " }, u: undefined },
    [event("7", "v1"), schemaDep],
    0, -0, 1e21, 1e-7, "",
  ];
  for (const value of values) {
    assert.equal(canonicalJson(value), JSON.stringify(canonicalize(value)));
    assert.equal(await clientStateHash(value), stateHash(value));
  }
  assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson(JSON.parse('{"__proto__": 1}')), /__proto__/);
});

test("readOrCompute reuses an unchanged dependency set without computing, supersedes on a changed one, and never retries", async () => {
  const { client, cleanup } = await served();
  try {
    let computed = 0;
    const base = { scope, subject: "customer:c1", transform_version: "summary/v1", provenance };
    const compute = (text: string) => () => { computed++; return text; };

    const first = await readOrCompute(client, { ...base, dependencies: [event("7", "v1"), schemaDep], compute: compute("Open: renewal quote."), now: () => "2026-09-17T10:00:00.000Z" });
    assert.equal(first.reused, false);
    assert.equal(computed, 1);
    assert.ok(!first.reused && first.write.outcome === "created" && first.superseded === null);
    assert.match(first.record.id, /^nds_[a-f0-9]{24}$/);
    assert.equal(first.record.content_hash, stateHash("Open: renewal quote."));

    // Same set, other order: reused, compute never runs.
    const again = await readOrCompute(client, { ...base, dependencies: [schemaDep, event("7", "v1")], compute: compute("must not run") });
    assert.equal(again.reused, true);
    assert.equal(computed, 1);
    assert.equal(again.record.id, first.record.id);

    // A dependency moved: computed once, written as the current statement, the old one superseded.
    const moved = await readOrCompute(client, { ...base, dependencies: [event("7", "v2"), schemaDep], compute: compute("Closed: quote accepted."), now: () => "2026-09-17T11:00:00.000Z" });
    assert.equal(moved.reused, false);
    assert.equal(computed, 2);
    assert.ok(!moved.reused && moved.superseded === first.record.id);
    assert.notEqual(moved.record.id, first.record.id);
    const read = await client.read({ scope, subject: "customer:c1", facets: ["derived"] });
    const current = read.state_of_record!.current.filter((r) => r.facet === "derived").map((r) => r.id);
    assert.deepEqual(current, [moved.record.id], "one current statement per subject and transform");

    // Transform versions are separate statements.
    const other = await readOrCompute(client, { ...base, transform_version: "summary/v2", dependencies: [event("7", "v2"), schemaDep], compute: compute("v2 wording") });
    assert.ok(!other.reused && other.superseded === null);

    await assert.rejects(readOrCompute(client, { ...base, dependencies: [], compute: compute("x") }), /at least one dependency/);
    await assert.rejects(readOrCompute(client, { ...base, subject: "customer:c3", dependencies: [schemaDep], compute: () => "" }), /non-empty content/);
    // A refusal surfaces as the typed error; the helper does not retry.
    await assert.rejects(readOrCompute(client, { ...base, scope: { kind: "organization", id: "elsewhere" }, dependencies: [schemaDep], compute: compute("x") }), (e: StateClientError) => e instanceof StateClientError && e.status === 403);
  } finally { await cleanup(); }
});

test("readOrCompute keeps the superseded statement's audience, and an explicit audience change carries the predecessor's expected_version", async () => {
  const { client, cleanup } = await served();
  try {
    const base = { scope, subject: "customer:private", transform_version: "summary/v1", provenance };
    const owned = { owner: "writer", readers: [], writers: [] };
    const first = await readOrCompute(client, { ...base, visibility: owned, dependencies: [event("1", "v1")], compute: () => "owner only" });
    assert.ok(!first.reused);
    assert.deepEqual(first.record.visibility, owned);

    // No visibility given: the audience carries forward, so the supersede is not an audience change.
    const moved = await readOrCompute(client, { ...base, dependencies: [event("1", "v2")], compute: () => "still owner only" });
    assert.ok(!moved.reused && moved.superseded === first.record.id);
    assert.deepEqual(moved.record.visibility, owned);

    // An explicit change needs the predecessor's version; the helper sends its record hash.
    const widened = { owner: "writer", readers: ["reviewer"], writers: [] };
    const changed = await readOrCompute(client, { ...base, visibility: widened, dependencies: [event("1", "v3")], compute: () => "reviewer can read" });
    assert.ok(!changed.reused && changed.superseded === moved.record.id);
    assert.deepEqual(changed.record.visibility, widened);
  } finally { await cleanup(); }
});

test("the idempotency key names the request: same evidence with new wording or a new computed_at is a different key (the pilot's stuck-outbox bug)", async () => {
  const keys: string[] = [];
  const spy = {
    read: async () => ({ schema: "nuryel.state.read/1", receipt_id: "hdr_000000000000000000000000", scope, state_of_record: null, denied_scopes: [] }) as never,
    records: async () => { throw new Error("no records lookup expected"); },
    write: async (request: { idempotency_key: string; record: Record<string, unknown> }) => { keys.push(request.idempotency_key); return { schema: "nuryel.state.write/1", record_id: "nds_000000000000000000000000", record_hash: stateHash(request.record), durability: "committed", outcome: "created", conflict: null } as never; },
  };
  const request = { scope, subject: "customer:c2", transform_version: "summary/v1", dependencies: [event("9", "v1")], provenance };
  await readOrCompute(spy, { ...request, compute: () => "Wording A", now: () => "2026-09-17T12:00:00.000Z" });
  await readOrCompute(spy, { ...request, compute: () => "Wording B", now: () => "2026-09-17T12:00:00.000Z" });
  await readOrCompute(spy, { ...request, compute: () => "Wording A", now: () => "2026-09-17T12:05:00.000Z" });
  await readOrCompute(spy, { ...request, compute: () => "Wording A", now: () => "2026-09-17T12:00:00.000Z" });
  assert.equal(new Set(keys.slice(0, 3)).size, 3, "wording and computed_at each change the key");
  assert.equal(keys[3], keys[0], "the same request is the same key, so a resend replays");
  assert.ok(keys[0]!.includes((await clientStateHash("Wording A")).slice(7, 23)));
  assert.ok(keys.every((k) => k.length >= 8 && k.length <= 256));
});
