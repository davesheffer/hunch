import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, prov } from "./helpers.js";
import { StubEmbedder, selectEmbedder, TransformersEmbedder } from "../src/store/embedder.js";

type Hit = { ref: string; kind: string; title: string; snippet: string; score: number };

/** Decode a stored Float32 BLOB the same way the store does (aligned copy). */
function decode(buf: Buffer, dim: number): Float32Array {
  const ab = new ArrayBuffer(dim * 4);
  new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, dim * 4));
  return new Float32Array(ab);
}
function floatEq(a: Float32Array, b: Float32Array, eps = 1e-6): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > eps) return false;
  return true;
}

/** Two decisions with DISJOINT token sets so semantic/keyword ranking is decidable. */
function seed() {
  const ctx = tempStore();
  const { store } = ctx;
  store.json.put("decisions", {
    id: "dec_redis", title: "Store sessions in Redis", status: "accepted",
    context: "a leaked token forced revocation", decision: "server side sessions in redis allow revocation",
    consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth/session.ts"],
    supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-05-01T00:00:00Z",
  } as never);
  store.json.put("decisions", {
    id: "dec_idem", title: "Idempotency key on charge", status: "accepted",
    context: "a duplicate webhook double charged a customer", decision: "an idempotency key prevents double billing duplicate payment",
    consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/billing/charge.ts"],
    supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.9), date: "2026-05-02T00:00:00Z",
  } as never);
  store.reindex();
  return ctx;
}

test("hybridSearch degrades to pure FTS when there are no embeddings (lean default)", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const fts = store.search("redis sessions", 12).map((h) => h.ref);
  // no embedder selected
  assert.deepEqual((await store.hybridSearch("redis sessions", 12, { embedder: null })).map((h) => h.ref), fts);
  // embedder present but embeddings table empty → still FTS
  assert.deepEqual((await store.hybridSearch("redis sessions", 12, { embedder: new StubEmbedder() })).map((h) => h.ref), fts);
});

test("embedAll round-trips Float32 vectors losslessly, incl. subarray views", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const emb = new StubEmbedder();
  const res = await store.embedAll(emb);
  assert.equal(res.embedded, res.total);
  assert.ok(res.total >= 2);

  const rows = store.db
    .prepare(`SELECT s.ref AS ref, s.title AS title, s.body AS body, e.vec AS vec
              FROM search s JOIN embeddings e ON e.ref = s.ref WHERE e.model = ?`)
    .all(emb.id) as Array<{ ref: string; title: string; body: string; vec: Buffer }>;
  assert.ok(rows.length >= 2);

  const stored: Float32Array[] = [];
  for (const r of rows) {
    const [expected] = await emb.embed([`${r.title}\n${r.body}`]); // byteOffset 0 (single text)
    const got = decode(r.vec, emb.dim);
    assert.equal(got.length, emb.dim);
    assert.ok(floatEq(got, expected!), `vector for ${r.ref} survived the BLOB round-trip`);
    stored.push(got);
  }
  // Distinct docs ⇒ distinct stored vectors. If a subarray view (byteOffset != 0)
  // had been written as the whole backing buffer, the rows would collide.
  assert.ok(!floatEq(stored[0]!, stored[1]!), "distinct docs stored distinct vectors (no subarray aliasing)");
});

test("hybridSearch fuses over populated embeddings end-to-end (exercises prod cosineRank + blobToVec)", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const emb = new StubEmbedder();
  await store.embedAll(emb);
  // This drives the REAL read path: query embedding → cosineRank (production
  // blobToVec decode) → rrfFuse. None of the other tests reach it.
  const hits = await store.hybridSearch("idempotency key prevents double billing duplicate payment", 12, { embedder: emb });
  assert.ok(hits.length >= 2, "fused results returned");
  assert.equal(hits[0]?.ref, "dec_idem", "the matching decision ranks first via fused semantic+keyword");
  assert.equal(new Set(hits.map((h) => h.ref)).size, hits.length, "no duplicate refs after fusion");
  assert.ok(hits[0]!.score > 0, "fused RRF score is positive");
});

test("semantic recall returns candidates when pure FTS finds nothing", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const q = "zzqqxx wgblort"; // tokens absent from every doc → FTS empty
  assert.equal(store.search(q, 12).length, 0, "precondition: keyword search is empty");
  const emb = new StubEmbedder();
  await store.embedAll(emb);
  const hits = await store.hybridSearch(q, 12, { embedder: emb });
  assert.ok(hits.length > 0, "the semantic leg surfaces candidates the keyword index can't (FTS-empty fusion branch)");
});

test("dim mismatch for a reused model id degrades to FTS, never throws RangeError", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  await store.embedAll(new StubEmbedder(32)); // store 32-dim vectors under id 'stub-v1'
  const fts = store.search("redis sessions", 12).map((h) => h.ref);
  // Query with a 64-dim embedder sharing the same model id: cosineRank filters on
  // `dim`, finds no matching-dim rows, and must fall back cleanly (not read past a blob).
  const hits = await store.hybridSearch("redis sessions", 12, { embedder: new StubEmbedder(64) });
  assert.deepEqual(hits.map((h) => h.ref), fts, "falls back to FTS when stored dim != query dim");
});

test("reindex prunes an embedding whose source text changed; re-embed restores it", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const emb = new StubEmbedder();
  await store.embedAll(emb);
  const full = store.embeddingStats(emb.id);
  assert.equal(full.embedded, full.total);

  const d = store.json.get("decisions", "dec_idem")!;
  store.json.put("decisions", { ...d, decision: `${d.decision} reworded with new tokens xyzzy` } as never);
  store.reindex(); // model-free prune of the now-stale vector

  const after = store.embeddingStats(emb.id);
  assert.equal(after.embedded, after.total - 1, "the changed doc's stale vector was pruned");

  await store.embedAll(emb); // only the missing one is re-embedded
  const restored = store.embeddingStats(emb.id);
  assert.equal(restored.embedded, restored.total);
});

test("reindex does NOT wipe embeddings for unchanged docs (RESET_SQL regression guard)", async (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const emb = new StubEmbedder();
  await store.embedAll(emb);
  const before = store.embeddingStats(emb.id).embedded;
  assert.ok(before >= 2);
  // reindex() runs on nearly every code path (query/context/MCP startup). It must
  // preserve vectors for docs that didn't change — embeddings are NOT in RESET_SQL.
  store.reindex();
  store.reindex();
  store.reindex();
  assert.equal(store.embeddingStats(emb.id).embedded, before, "embeddings survived repeated reindex");
});

test("rrfFuse: a doc strong in BOTH lists outranks one strong in only one", (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const fuse = (store as unknown as { rrfFuse(a: Hit[], b: Hit[], g: Hit[], n: number): Hit[] }).rrfFuse.bind(store);
  const mk = (ref: string): Hit => ({ ref, kind: "decisions", title: ref, snippet: "", score: 0 });
  const fts = [mk("A"), mk("B"), mk("C")]; // A best lexically
  const sem = [mk("B"), mk("A"), mk("D")]; // B best semantically; A high in both
  const out = fuse(fts, sem, [], 4).map((h) => h.ref);
  assert.equal(out[0], "A", "A ranks high in both lists → overall winner");
  assert.ok(out.indexOf("B") < out.indexOf("C"), "B (in both) beats C (fts-only)");
  assert.ok(out.indexOf("B") < out.indexOf("D"), "B (in both) beats D (sem-only)");
});

test("rrfFuse: lexical weight keeps an exact keyword hit above a semantic-only hit at equal rank", (t) => {
  const { store, cleanup } = seed();
  t.after(cleanup);
  const fuse = (store as unknown as { rrfFuse(a: Hit[], b: Hit[], g: Hit[], n: number): Hit[] }).rrfFuse.bind(store);
  const mk = (ref: string): Hit => ({ ref, kind: "decisions", title: ref, snippet: "", score: 0 });
  const out = fuse([mk("E")], [mk("F")], [], 2).map((h) => h.ref);
  assert.deepEqual(out, ["E", "F"], "equal rank → lexical (FTS) hit wins on the higher weight");
});

test("selectEmbedder honors HUNCH_EMBEDDER (stub / none)", async () => {
  const prev = process.env.HUNCH_EMBEDDER;
  process.env.HUNCH_EMBEDDER = "stub";
  assert.equal((await selectEmbedder())?.id, "stub-v1");
  process.env.HUNCH_EMBEDDER = "none";
  assert.equal(await selectEmbedder(), null);
  if (prev === undefined) delete process.env.HUNCH_EMBEDDER;
  else process.env.HUNCH_EMBEDDER = prev;
});

// Real-model inference is opt-in (downloads ~90MB); properly SKIPPED (not silently
// passed) in CI unless HUNCH_TEST_REAL_MODEL is set.
test(
  "TransformersEmbedder yields 384-dim normalized vectors",
  { skip: process.env.HUNCH_TEST_REAL_MODEL ? false : "set HUNCH_TEST_REAL_MODEL=1 to run (downloads ~90MB)" },
  async () => {
    const e = new TransformersEmbedder();
    const [v] = await e.embed(["the auth token expired and the session was revoked"]);
    assert.equal(v!.length, 384);
    let norm = 0;
    for (const x of v!) norm += x * x;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-2, "output is L2-normalized");
  },
);

// Hunch launched through npx (the MCP server and hooks `init` writes) or from a project
// install never resolves npm's global root, so `npm i -g @huggingface/transformers`
// (doctor's advice) used to leave semantic search off there.
test("transformers.js installed only in npm's global node_modules is still found", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { resolveTransformers } = await import("../src/store/embedder.js");
  const base = mkdtempSync(join(tmpdir(), "hunch-embed-global-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const hunchCopy = join(base, "npx", "node_modules", "@davesheffer", "hunch", "dist", "store");
  mkdirSync(hunchCopy, { recursive: true });
  const from = pathToFileURL(join(hunchCopy, "embedder.js")).href;
  const globalRoot = join(base, "prefix", "node_modules");
  const pkg = join(globalRoot, "@huggingface", "transformers");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@huggingface/transformers", main: "index.cjs" }));
  writeFileSync(join(pkg, "index.cjs"), "exports.pipeline = () => 'fake';\n");

  assert.equal(resolveTransformers(from, []), null, "not next to this copy of Hunch");
  const found = resolveTransformers(from, [join(base, "elsewhere", "node_modules"), globalRoot]);
  assert.equal(found, pathToFileURL(join(pkg, "index.cjs")).href);
  const mod = (await import(found!)) as { pipeline: () => string };
  assert.equal(mod.pipeline(), "fake", "the loader imports the global copy by its URL");
});

test("globalModuleDirs reads npm_config_global_prefix, then the prefix next to node", async () => {
  const { posix, win32 } = await import("node:path");
  const { globalModuleDirs } = await import("../src/store/embedder.js");
  assert.deepEqual(globalModuleDirs({ npm_config_global_prefix: "C:\\npm-global" }, "C:\\Program Files\\nodejs\\node.exe", "win32"),
    [win32.join("C:\\npm-global", "node_modules"), win32.join("C:\\Program Files\\nodejs", "node_modules")]);
  assert.deepEqual(globalModuleDirs({}, "/usr/local/bin/node", "linux"), [posix.join("/usr/local", "lib", "node_modules")]);
  assert.deepEqual(globalModuleDirs({ npm_config_global_prefix: "/usr/local" }, "/usr/local/bin/node", "darwin"),
    ["/usr/local/lib/node_modules"], "one directory, not two");
  assert.deepEqual(globalModuleDirs({ npm_config_global_prefix: "relative/prefix" }, "/opt/node/bin/node", "linux"),
    ["/opt/node/lib/node_modules"], "a relative prefix is ignored");
});
