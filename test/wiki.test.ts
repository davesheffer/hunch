import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore, prov } from "./helpers.js";
import {
  assemblePack, packHash, renderPage, slugFor, readWikiManifestAt, writeWikiManifestAt,
  publicHome, privateHome, wikiStatus, generateWiki, computeWikiDrift, wikiSummary,
} from "../src/wiki/wiki.js";
import { computeDrift } from "../src/core/drift.js";
import { adoptedSlug } from "../src/wiki/adopt.js";
import { scanRepoDocs } from "../src/core/docscan.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";

const NOW = "2026-07-02T00:00:00Z";

const CMP = (over: Record<string, unknown> = {}) => ({
  id: "cmp_store", kind: "layer", name: "Store Layer", responsibility: "Persistence for the graph",
  paths: ["src/store/**"], status: "active", owners: [], fragility: 0.2,
  provenance: prov(0.9), created_at: NOW, updated_at: NOW,
  ...over,
});

const SYM = (over: Record<string, unknown> = {}) => ({
  id: "sym_a", file: "src/store/jsonStore.ts", name: "loadAll", kind: "function",
  signature_hash: "", calls: [], called_by: [],
  metrics: { loc: 40, churn_90d: 1, bug_count: 0, fan_in: 7, fan_out: 2 }, last_changed: "",
  ...over,
});

const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_atomic", title: "Atomic JSON writes", topic: null, status: "accepted",
  context: "Interrupted writes truncated the index.", decision: "Write temp file then rename.",
  consequences: ["crash-safe"], alternatives_rejected: ["in-place writes"], rejected_tripwires: [],
  related_components: [], related_files: ["src/store/jsonStore.ts"], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: NOW, valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: NOW,
  ...over,
});

const CON = (over: Record<string, unknown> = {}) => ({
  id: "con_atomic", type: "correctness", statement: "All JSON writes must be atomic",
  scope: ["src/store/**"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null,
  rationale: "partial write corrupts the index", source_decision: null, violations: [],
  status: "active", valid_from: NOW, valid_to: null, provenance: prov(0.9),
  ...over,
});

const BUG = (over: Record<string, unknown> = {}) => ({
  id: "bug_trunc", title: "Truncated index on crash", symptom: "empty JSON", root_cause: "non-atomic write",
  severity: "high", status: "fixed", affected_files: ["src/store/jsonStore.ts"], affected_symbols: [],
  lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null },
  provenance: prov(0.9),
  ...over,
});

function seed(store: HunchStore): void {
  store.json.put("components", CMP() as never);
  store.json.put("symbols", SYM() as never);
  store.json.put("decisions", DEC({ topic: "store.write-durability" }) as never);
  store.json.put("constraints", CON() as never);
  store.json.put("bugs", BUG() as never);
}

/** A public store WITH a private overlay (its own repo root, .hunch inside),
 *  wired via HUNCH_PRIVATE_DIR — the same shape `hunch private` scaffolds. */
function overlayStore(): { store: HunchStore; pub: string; overlayRoot: string; cleanup: () => void } {
  const pub = mkdtempSync(join(tmpdir(), "hunch-wiki-pub-"));
  const overlayRoot = mkdtempSync(join(tmpdir(), "hunch-wiki-priv-"));
  const priv = join(overlayRoot, ".hunch");
  mkdirSync(priv, { recursive: true });
  const prev = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = priv;
  const store = new HunchStore(hunchPaths(pub)); // reads HUNCH_PRIVATE_DIR at construction
  store.json.ensureDirs();
  return {
    store, pub, overlayRoot,
    cleanup: () => {
      store.close();
      if (prev === undefined) delete process.env.HUNCH_PRIVATE_DIR;
      else process.env.HUNCH_PRIVATE_DIR = prev;
      rmSync(pub, { recursive: true, force: true });
      rmSync(overlayRoot, { recursive: true, force: true });
    },
  };
}

test("assemblePack: ownership by path prefix pulls symbols, decisions, scoped constraints, bugs", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("symbols", SYM({ id: "sym_other", file: "src/cli/index.ts", name: "main" }) as never);
  store.json.put("decisions", DEC({ id: "dec_unrelated", related_files: ["src/cli/index.ts"] }) as never);
  store.json.put("constraints", CON({ id: "con_repo", scope: [] }) as never); // repo-wide → index page, not this pack

  const pack = assemblePack(store, CMP() as never);
  assert.deepEqual(pack.files, ["src/store/jsonStore.ts"]);
  assert.deepEqual(pack.symbols.map((s) => s.name), ["loadAll"]);
  assert.deepEqual(pack.decisions.map((d) => d.id), ["dec_atomic"]);
  assert.deepEqual(pack.constraints.map((c) => c.id), ["con_atomic"]);
  assert.deepEqual(pack.bugs.map((b) => b.id), ["bug_trunc"]);
});

test("assemblePack: superseded decisions are history, not page content", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("decisions", DEC({ id: "dec_old", status: "superseded", superseded_by: "dec_atomic" }) as never);
  const pack = assemblePack(store, CMP() as never);
  assert.deepEqual(pack.decisions.map((d) => d.id), ["dec_atomic"]);
});

test("assemblePack: component-level edges resolve to depends-on / used-by names", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("components", CMP({ id: "cmp_core", name: "Core", paths: ["src/core/**"] }) as never);
  store.json.put("edges", { id: "edge_1", from: "cmp_store", to: "cmp_core", type: "depends_on", reason: "", strength: 0.8, provenance: prov(0.9) } as never);
  const pack = assemblePack(store, CMP() as never);
  assert.deepEqual(pack.dependsOn, [{ id: "cmp_core", name: "Core", slug: null }]);
  assert.deepEqual(pack.usedBy, []);
});

test("assemblePack source boundary: 'public' never sees overlay records; 'all' unions them (LEAK CHECK)", (t) => {
  const { store, cleanup } = overlayStore();
  t.after(cleanup);
  seed(store);
  store.putPrivate("decisions", DEC({ id: "dec_priv", title: "sensitive call", related_files: ["src/store/jsonStore.ts"] }) as never);

  const pub = assemblePack(store, CMP() as never, "public");
  assert.deepEqual(pub.decisions.map((d) => d.id), ["dec_atomic"], "public pack must not see the overlay");
  const all = assemblePack(store, CMP() as never, "all");
  assert.deepEqual(all.decisions.map((d) => d.id).sort(), ["dec_atomic", "dec_priv"]);
});

test("packHash: stable across identical graphs, changes when a decision changes", (t) => {
  const a = tempStore(); t.after(a.cleanup);
  const b = tempStore(); t.after(b.cleanup);
  seed(a.store);
  seed(b.store);
  const ha = packHash(assemblePack(a.store, CMP() as never));
  const hb = packHash(assemblePack(b.store, CMP() as never));
  assert.equal(ha, hb, "same inputs → same hash, independent of store instance");

  b.store.json.put("decisions", DEC({ decision: "Write temp file then fsync then rename." }) as never);
  const hc = packHash(assemblePack(b.store, CMP() as never));
  assert.notEqual(ha, hc, "changed decision text → changed hash");
});

test("renderPage: deterministic skeleton carries hunch:topic pins, constraint ids, and no timestamps", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const pack = assemblePack(store, CMP() as never);
  const page = renderPage(pack, null);
  assert.match(page, /<!-- hunch:wiki cmp_store /);
  assert.match(page, /<!-- hunch:topic store\.write-durability dec_atomic -->/, "topic'd decision is PINNED for doc-anchor drift");
  assert.match(page, /con_atomic/);
  assert.match(page, /\| `loadAll` \| function \|/);
  assert.match(page, /bug_trunc/);
  assert.doesNotMatch(page, /2026-07-02/, "no timestamps in page bodies — regen must be byte-identical");
  assert.equal(page, renderPage(pack, null), "render is deterministic");
});

test("renderPage: prose slots in as Overview; absent prose leaves a complete template page", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const pack = assemblePack(store, CMP() as never);
  const withProse = renderPage(pack, "This layer persists the graph (dec_atomic).");
  assert.match(withProse, /## Overview\n\nThis layer persists the graph/);
  assert.doesNotMatch(renderPage(pack, null), /## Overview/);
});

test("slugFor: kebab-cases, dodges readme, and disambiguates collisions", () => {
  const taken = new Set<string>();
  assert.equal(slugFor("Store Layer", "cmp_abc123", taken), "store-layer");
  assert.equal(slugFor("Store  Layer!", "cmp_def456", taken), "store-layer-def456");
  assert.equal(slugFor("README", "cmp_xyz789", new Set()), "readme-xyz789");
});

test("adoptedSlug: distinct rels that kebab identically get deterministic disambiguation", () => {
  const taken = new Set<string>();
  const a = adoptedSlug("docs/api-v2.md", taken);
  const b = adoptedSlug("docs-api/v2.md", taken); // kebabs to the same base
  assert.equal(a, "docs-api-v2");
  assert.notEqual(b, a, "collision disambiguated");
  assert.match(b, /^docs-api-v2-[0-9a-f]{6}$/);
  assert.equal(adoptedSlug("docs-api/v2.md", new Set(["docs-api-v2"])), b, "suffix is deterministic per rel");
});

test("manifest: atomic write + tolerant read roundtrip; wikiSummary reflects PUBLIC adoption only", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const home = publicHome(root, "wiki");
  assert.equal(readWikiManifestAt(home.manifestPath), null, "no manifest before adoption");
  assert.equal(wikiSummary(root), null);
  writeWikiManifestAt(home.manifestPath, { version: 1, dir: "wiki", pages: { "wiki/store-layer.md": { component: "cmp_store", hash: "abc", generated: NOW } } });
  const m = readWikiManifestAt(home.manifestPath);
  assert.equal(m?.dir, "wiki");
  assert.equal(Object.keys(m!.pages).length, 1);
  assert.deepEqual(wikiSummary(root), { dir: "wiki", pages: 1 });
  void store;
});

test("generateWiki: writes pages + README + manifest; regen with unchanged graph is byte-identical and touches nothing on --heal", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");

  const first = await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.deepEqual(first.written, ["wiki/store-layer.md", "wiki/specs.md", "wiki/now.md", "wiki/graph.html", "wiki/README.md"]);
  assert.ok(existsSync(join(root, "wiki", "store-layer.md")));
  assert.ok(existsSync(join(root, "wiki", "specs.md")));
  assert.ok(existsSync(join(root, "wiki", "README.md")));
  const pageBefore = readFileSync(join(root, "wiki", "store-layer.md"), "utf8");
  const manifest = readWikiManifestAt(home.manifestPath);
  assert.equal(manifest?.pages["wiki/store-layer.md"]?.component, "cmp_store");

  const heal = await generateWiki(store, root, home, { now: "2026-07-03T00:00:00Z", only: "stale" });
  assert.equal(heal.written.length, 0, "fresh pages are not regenerated on --heal");
  assert.equal(heal.unchanged, 1);
  assert.equal(readWikiManifestAt(home.manifestPath)?.pages["wiki/store-layer.md"]?.generated, NOW, "fresh manifest entries keep their generation time");

  const all = await generateWiki(store, root, home, { now: "2026-07-03T00:00:00Z", only: "all" });
  assert.equal(all.written.length, 5);
  assert.equal(readFileSync(join(root, "wiki", "store-layer.md"), "utf8"), pageBefore, "identical graph → byte-identical page");
});

test("generateWiki: prose failure degrades to a template page, never fails generation", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const res = await generateWiki(store, root, publicHome(root, "wiki"), {
    now: NOW, only: "all",
    prose: async () => { throw new Error("CLI exploded"); },
  });
  assert.equal(res.written.length, 5); // component page + specs ledger + now + graph + index
  assert.doesNotMatch(readFileSync(join(root, "wiki", "store-layer.md"), "utf8"), /## Overview/);
});

test("generateWiki: removes orphaned pages when their component leaves the graph", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("components", CMP({ id: "cmp_gone", name: "Doomed", paths: ["src/doomed/**"] }) as never);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.ok(existsSync(join(root, "wiki", "doomed.md")));

  store.json.delete("components", "cmp_gone");
  const res = await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.deepEqual(res.removed, ["wiki/doomed.md"]);
  assert.ok(!existsSync(join(root, "wiki", "doomed.md")));
  assert.equal(readWikiManifestAt(home.manifestPath)?.pages["wiki/doomed.md"], undefined);
});

test("private home: pages + manifest land in the OVERLAY repo, render the union, and leak nothing into the public repo", async (t) => {
  const { store, pub, overlayRoot, cleanup } = overlayStore();
  t.after(cleanup);
  seed(store);
  store.putPrivate("decisions", DEC({ id: "dec_priv", title: "sensitive vendor call", topic: "store.vendor", related_files: ["src/store/jsonStore.ts"] }) as never);
  store.putPrivate("components", CMP({ id: "cmp_secret", name: "Secret Sauce", paths: ["src/secret/**"] }) as never);

  const home = privateHome(store);
  assert.ok(home, "overlay configured → private home exists");
  assert.equal(home!.pagesRoot, overlayRoot, "pages live in the overlay repo root");
  assert.equal(home!.source, "all");

  const res = await generateWiki(store, pub, home!, { now: NOW, only: "all" });
  assert.equal(res.written.length, 6, "public + private components + specs + now + graph + index all get pages");
  const page = readFileSync(join(overlayRoot, "wiki", "store-layer.md"), "utf8");
  assert.match(page, /dec_priv/, "private wiki renders overlay records");
  assert.match(readFileSync(join(overlayRoot, "wiki", "README.md"), "utf8"), /PRIVATE/, "index carries the do-not-publish banner");
  assert.ok(existsSync(join(overlayRoot, ".hunch", "wiki-manifest.json")), "manifest rides the overlay store");

  // LEAK CHECK: nothing wiki-related lands in the public repo.
  assert.ok(!existsSync(join(pub, "wiki")), "no pages in the public repo");
  assert.equal(readWikiManifestAt(publicHome(pub).manifestPath), null, "no public manifest");
  assert.equal(wikiSummary(pub), null, "committed grounding docs stay blind to the private wiki");
});

test("public home in an overlay-configured repo still renders public-only pages (LEAK CHECK)", async (t) => {
  const { store, pub, cleanup } = overlayStore();
  t.after(cleanup);
  seed(store);
  store.putPrivate("decisions", DEC({ id: "dec_priv", title: "sensitive vendor call", related_files: ["src/store/jsonStore.ts"] }) as never);

  await generateWiki(store, pub, publicHome(pub, "wiki"), { now: NOW, only: "all" });
  const pages = readdirSync(join(pub, "wiki")).map((f) => readFileSync(join(pub, "wiki", f), "utf8")).join("\n");
  assert.doesNotMatch(pages, /dec_priv|sensitive vendor call/, "overlay records must never reach committed pages");
});

test("wiki drift: no manifest → silent; graph change after generation → wiki-stale via computeDrift; heal clears it", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  mkdirSync(join(root, "src", "store"), { recursive: true });
  writeFileSync(join(root, "src", "store", "jsonStore.ts"), "export const x = 1;\n");
  const home = publicHome(root, "wiki");

  assert.equal(computeWikiDrift(store, root).length, 0, "no adoption → no findings");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.equal(computeWikiDrift(store, root).length, 0, "freshly generated → no findings");

  store.json.put("decisions", DEC({ id: "dec_fsync", title: "Also fsync before rename", related_files: ["src/store/jsonStore.ts"] }) as never);
  const findings = computeDrift(store, root).findings.filter((f) => f.kind === "wiki-stale");
  const pageFindings = findings.filter((f) => f.id === "wiki/store-layer.md");
  assert.equal(pageFindings.length, 1, "graph moved → the page is stale");
  assert.match(pageFindings[0]!.detail, /hunch wiki --heal/);
  assert.ok(findings.some((f) => f.id === "wiki/README.md"), "the index re-renders too (its decision counts moved)");

  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.equal(computeWikiDrift(store, root).length, 0, "--heal clears the drift");
});

test("wiki drift: the private home is checked too, and its findings say so", async (t) => {
  const { store, pub, cleanup } = overlayStore();
  t.after(cleanup);
  seed(store);
  const home = privateHome(store)!;
  await generateWiki(store, pub, home, { now: NOW, only: "all" });
  assert.equal(computeWikiDrift(store, pub).length, 0);

  store.putPrivate("decisions", DEC({ id: "dec_priv2", title: "new private decision", related_files: ["src/store/jsonStore.ts"] }) as never);
  const findings = computeWikiDrift(store, pub);
  const page = findings.find((f) => f.id === "wiki/store-layer.md");
  assert.ok(page, "the private home's page went stale");
  assert.match(page!.detail, /private overlay wiki/);
  assert.match(page!.detail, /--heal --private/);
  assert.ok(findings.every((f) => /private overlay wiki/.test(f.detail)), "no PUBLIC-home findings — the public wiki can't see the overlay");
});

test("wiki drift: a new component without a page and an orphaned manifest entry both surface", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });

  store.json.put("components", CMP({ id: "cmp_new", name: "Newcomer", paths: ["src/new/**"] }) as never);
  let findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/newcomer.md" && /no wiki page yet/.test(f.detail)));
  assert.ok(findings.some((f) => f.id === "wiki/README.md"), "index rows moved with the component set");

  store.json.delete("components", "cmp_new");
  store.json.delete("components", "cmp_store");
  findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/store-layer.md" && /no current artifact claims|no longer exists/.test(f.detail)), "abandoned page is an orphan");
});

test("docscan: pins to current decisions ground a doc; superseded pins, proposed-but-shipped, and all-missing refs grade stale; bare docs are unverified", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store); // dec_atomic, topic store.write-durability, live
  mkdirSync(join(root, "src", "store"), { recursive: true });
  writeFileSync(join(root, "src", "store", "jsonStore.ts"), "export const x = 1;\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "good.md"), "# Durability spec\n<!-- hunch:topic store.write-durability dec_atomic -->\nWrites are atomic. See src/store/jsonStore.ts.\n");
  writeFileSync(join(root, "docs", "bare.md"), "# Notes\nSome prose about src/store/jsonStore.ts.\n");
  writeFileSync(join(root, "docs", "shipped.md"), "# Plan\nStatus: proposed, not yet implemented.\nSee src/store/jsonStore.ts.\n");
  writeFileSync(join(root, "docs", "ghost.md"), "# Old\nSee src/store/gone.ts.\n");
  writeFileSync(join(root, "wiki-page.md"), "<!-- hunch:wiki cmp_x — generated -->\n# Not a spec\n");

  const docs = scanRepoDocs(store.json.loadAll("decisions"), root);
  const byRel = new Map(docs.map((d) => [d.rel, d] as const));
  assert.equal(byRel.get("docs/good.md")?.status, "grounded");
  assert.deepEqual(byRel.get("docs/good.md")?.topics, ["store.write-durability"]);
  assert.equal(byRel.get("docs/bare.md")?.status, "unverified");
  assert.equal(byRel.get("docs/shipped.md")?.status, "stale");
  assert.equal(byRel.get("docs/ghost.md")?.status, "stale");
  assert.equal(byRel.get("wiki-page.md"), undefined, "generated pages are views, not specs");

  store.json.put("decisions", DEC({ topic: "store.write-durability", status: "superseded", superseded_by: "dec_v2" }) as never);
  store.json.put("decisions", DEC({ id: "dec_v2", topic: "store.write-durability", title: "v2" }) as never);
  const regraded = scanRepoDocs(store.json.loadAll("decisions"), root);
  const good = regraded.find((d) => d.rel === "docs/good.md");
  assert.equal(good?.status, "stale", "superseding the pinned decision re-grades the doc");
  assert.match(good!.issues[0]!, /dec_v2/);
});

test("specs ledger: docs land on component pages by src-ref, the ledger page renders grades, and doc changes fire wiki-stale drift", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  mkdirSync(join(root, "src", "store"), { recursive: true });
  writeFileSync(join(root, "src", "store", "jsonStore.ts"), "export const x = 1;\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "durability.md"), "# Durability spec\n<!-- hunch:topic store.write-durability dec_atomic -->\nSee src/store/jsonStore.ts.\n");
  const home = publicHome(root, "wiki");

  await generateWiki(store, root, home, { now: NOW, only: "all" });
  const page = readFileSync(join(root, "wiki", "store-layer.md"), "utf8");
  assert.match(page, /## Docs & specs/);
  assert.match(page, /✅ grounded — \[Durability spec\]\(\.\.\/docs\/durability\.md\)/);
  const specs = readFileSync(join(root, "wiki", "specs.md"), "utf8");
  assert.match(specs, /## ✅ Grounded/);
  assert.match(specs, /durability\.md/);
  assert.ok(specs.startsWith("<!-- hunch:wiki _specs"), "the ledger is itself a generated view, excluded from scanning");
  assert.equal(computeWikiDrift(store, root).length, 0);

  // A NEW doc appears → the ledger snapshot moves → wiki-stale on specs.md; heal clears it.
  writeFileSync(join(root, "docs", "new-notes.md"), "# New notes\nUnanchored prose.\n");
  const findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/specs.md" && /doc freshness snapshot changed/.test(f.detail)));
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.equal(computeWikiDrift(store, root).length, 0, "--heal regenerates the ledger");
  assert.match(readFileSync(join(root, "wiki", "specs.md"), "utf8"), /new-notes\.md/);
});

test("specs ledger: the _specs manifest entry is never treated as an orphan", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  const res = await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.deepEqual(res.removed, [], "specs.md must not be orphan-removed");
  assert.equal(readWikiManifestAt(home.manifestPath)?.pages["wiki/specs.md"]?.component, "_specs");
});

test("adoption: a stale doc gets a wiki-managed copy — re-pinned to current decisions with graph-correction callouts; original untouched", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("decisions", DEC({ status: "superseded", superseded_by: "dec_v2" }) as never);
  store.json.put("decisions", DEC({ id: "dec_v2", topic: "store.write-durability", title: "fsync then rename", decision: "Also fsync before the rename.", supersedes: "dec_atomic" }) as never);
  mkdirSync(join(root, "docs"), { recursive: true });
  const original = "# Durability\n<!-- hunch:topic store.write-durability dec_atomic -->\nWe just rename, no fsync.\n";
  writeFileSync(join(root, "docs", "durability.md"), original);

  await generateWiki(store, root, publicHome(root, "wiki"), { now: NOW, only: "all" });

  const copyPath = join(root, "wiki", "docs", "docs-durability.md");
  assert.ok(existsSync(copyPath), "adopted copy exists under wiki/docs/");
  const copy = readFileSync(copyPath, "utf8");
  assert.ok(copy.startsWith("<!-- hunch:wiki doc:docs/durability.md"), "copy is a generated artifact (excluded from doc scanning)");
  assert.match(copy, /<!-- hunch:topic store\.write-durability dec_v2 -->/, "pin healed to the CURRENT decision");
  assert.doesNotMatch(copy, /<!-- hunch:topic store\.write-durability dec_atomic -->/);
  assert.match(copy, /🧭 Graph correction[\s\S]*dec_v2[\s\S]*fsync then rename/, "correction callout quotes the current decision");
  assert.match(copy, /We just rename, no fsync\./, "original prose preserved inside the copy");
  assert.equal(readFileSync(join(root, "docs", "durability.md"), "utf8"), original, "ORIGINAL file never touched");

  const specs = readFileSync(join(root, "wiki", "specs.md"), "utf8");
  assert.match(specs, /wiki-managed copy\]\(docs\/docs-durability\.md\)/, "ledger routes to the copy");
  assert.equal(readWikiManifestAt(publicHome(root).manifestPath)?.pages["wiki/docs/docs-durability.md"]?.component, "doc:docs/durability.md");
});

test("adoption lifecycle: source edit re-heals the copy; healing the ORIGINAL retires it; deleting the source retires it too", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("decisions", DEC({ status: "superseded", superseded_by: "dec_v2" }) as never);
  store.json.put("decisions", DEC({ id: "dec_v2", topic: "store.write-durability", title: "fsync then rename", supersedes: "dec_atomic" }) as never);
  mkdirSync(join(root, "docs"), { recursive: true });
  const src = join(root, "docs", "durability.md");
  writeFileSync(src, "# Durability\n<!-- hunch:topic store.write-durability dec_atomic -->\nOld prose.\n");
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.equal(computeWikiDrift(store, root).length, 0);

  // 1. Source edited (still stale) → adopted copy out of date → heal re-copies.
  writeFileSync(src, "# Durability\n<!-- hunch:topic store.write-durability dec_atomic -->\nOld prose, edited.\n");
  let findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => /adopted copy of "docs\/durability\.md" is out of date/.test(f.detail)));
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.match(readFileSync(join(root, "wiki", "docs", "docs-durability.md"), "utf8"), /edited/);
  assert.equal(computeWikiDrift(store, root).length, 0);

  // 2. Human heals the ORIGINAL (re-pins to current) → grade leaves "stale" → copy retires.
  writeFileSync(src, "# Durability\n<!-- hunch:topic store.write-durability dec_v2 -->\nNew prose matching the graph.\n");
  findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => /original healed or was removed/.test(f.detail)));
  const res = await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.ok(res.removed.includes("wiki/docs/docs-durability.md"));
  assert.ok(!existsSync(join(root, "wiki", "docs", "docs-durability.md")), "copy retired once the original is grounded");

  // 3. Doc goes stale again, then the SOURCE file is deleted → copy retires as well.
  writeFileSync(src, "# Durability\n<!-- hunch:topic store.write-durability dec_atomic -->\nStale again.\n");
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.ok(existsSync(join(root, "wiki", "docs", "docs-durability.md")));
  rmSync(src);
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.ok(!existsSync(join(root, "wiki", "docs", "docs-durability.md")), "deleting the source retires the copy");
});

test("adoption LEAK CHECK: a committed (public-home) copy is healed with PUBLIC decisions only — private text never reaches it", async (t) => {
  const { store, pub, overlayRoot, cleanup } = overlayStore();
  t.after(cleanup);
  seed(store);
  // Public old decision superseded; the CURRENT decision for the topic is PRIVATE.
  store.json.put("decisions", DEC({ status: "superseded", superseded_by: "dec_priv_v2" }) as never);
  store.putPrivate("decisions", DEC({ id: "dec_priv_v2", topic: "store.write-durability", title: "SECRET vendor fsync deal", decision: "Use the SECRET vendor call before rename.", supersedes: "dec_atomic" }) as never);
  mkdirSync(join(pub, "docs"), { recursive: true });
  writeFileSync(join(pub, "docs", "durability.md"), "# Durability\n<!-- hunch:topic store.write-durability dec_atomic -->\nOld prose.\n");

  // PUBLIC home: the only successor is PRIVATE, so the public store cannot vouch
  // either way — the doc grades UNVERIFIED (not stale), is NOT adopted, and no
  // committed surface carries a trace of the overlay.
  await generateWiki(store, pub, publicHome(pub, "wiki"), { now: NOW, only: "all" });
  assert.ok(!existsSync(join(pub, "wiki", "docs", "docs-durability.md")), "no public adoption when staleness is only privately visible");
  const pubSpecs = readFileSync(join(pub, "wiki", "specs.md"), "utf8");
  assert.match(pubSpecs, /◻ Unverified[\s\S]*durability\.md/, "publicly the doc is merely unverified");
  assert.doesNotMatch(pubSpecs, /SECRET|dec_priv_v2/, "the committed ledger is blind to the overlay");

  // PRIVATE home: union heals the copy with the private current decision — in the overlay repo only.
  await generateWiki(store, pub, privateHome(store)!, { now: NOW, only: "all" });
  const privCopy = readFileSync(join(overlayRoot, "wiki", "docs", "docs-durability.md"), "utf8");
  assert.match(privCopy, /dec_priv_v2/, "overlay copy is healed with the union");
  assert.match(privCopy, /<!-- hunch:topic store\.write-durability dec_priv_v2 -->/, "re-pinned to the private current decision in the overlay only");
});

test("tamper tripwire: a hand-edited page grades stale and --heal restores the derived view", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.equal(computeWikiDrift(store, root).length, 0);

  const page = join(root, "wiki", "store-layer.md");
  const generated = readFileSync(page, "utf8");
  writeFileSync(page, generated + "\nSneaky manual edit.\n");
  const findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/store-layer.md" && /edited by hand/.test(f.detail)));

  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.equal(readFileSync(page, "utf8"), generated, "--heal restores the derived bytes");
  assert.equal(computeWikiDrift(store, root).length, 0);
});

test("rename lifecycle: renaming a component orphans the old page path; --heal removes it and writes the new one", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.ok(existsSync(join(root, "wiki", "store-layer.md")));

  store.json.put("components", CMP({ name: "Storage Layer" }) as never); // same id, new name → new slug
  const findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/storage-layer.md" && /no wiki page yet/.test(f.detail)));
  assert.ok(findings.some((f) => f.id === "wiki/store-layer.md"), "the abandoned path is reported");

  const res = await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.ok(res.written.includes("wiki/storage-layer.md"));
  assert.ok(res.removed.includes("wiki/store-layer.md"), "old path removed — nothing generated is stranded");
  assert.ok(!existsSync(join(root, "wiki", "store-layer.md")));
  assert.equal(computeWikiDrift(store, root).length, 0);
});

test("index freshness: a repo-wide constraint change or a deleted README grades the index stale; --heal repairs it", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.equal(computeWikiDrift(store, root).length, 0);

  store.json.put("constraints", CON({ id: "con_repowide", scope: [], statement: "Never log secrets" }) as never);
  let findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/README.md" && /index's inputs moved/.test(f.detail)), "repo-wide invariants are index inputs");
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.match(readFileSync(join(root, "wiki", "README.md"), "utf8"), /Never log secrets/);
  assert.equal(computeWikiDrift(store, root).length, 0);

  rmSync(join(root, "wiki", "README.md"));
  findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/README.md"), "a deleted index is visible drift, not silence");
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.ok(existsSync(join(root, "wiki", "README.md")));
});

test("adopted-copy healing touches only marker pins — prose ids survive, and every pin on a line heals", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("decisions", DEC({ status: "superseded", superseded_by: "dec_v2" }) as never);
  store.json.put("decisions", DEC({ id: "dec_v2", topic: "store.write-durability", title: "fsync then rename", supersedes: "dec_atomic" }) as never);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "durability.md"),
    "# Durability\nProse mentions dec_atomic and dec_atomic2 inline. <!-- hunch:topic store.write-durability dec_atomic --> <!-- hunch:topic store.write-durability dec_atomic -->\nSee src/store/x.ts.\n",
  );
  await generateWiki(store, root, publicHome(root, "wiki"), { now: NOW, only: "all" });

  const copy = readFileSync(join(root, "wiki", "docs", "docs-durability.md"), "utf8");
  assert.match(copy, /Prose mentions dec_atomic and dec_atomic2 inline\./, "bare prose ids are never rewritten");
  assert.doesNotMatch(copy, /hunch:topic store\.write-durability dec_atomic\b.*-->.*hunch:topic store\.write-durability dec_atomic\b/, "no marker keeps the stale pin");
  assert.equal((copy.match(/hunch:topic store\.write-durability dec_v2/g) ?? []).length, 2, "BOTH markers on the line healed");
});

test("wiki pages ground the doc≠graph loop: superseding a pinned decision fires doc-anchor-stale on the PAGE", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  await generateWiki(store, root, publicHome(root, "wiki"), { now: NOW, only: "all" });

  store.json.put("decisions", DEC({ status: "superseded", superseded_by: "dec_fsync" }) as never);
  store.json.put("decisions", DEC({ id: "dec_fsync", topic: "store.write-durability", title: "fsync then rename", supersedes: "dec_atomic" }) as never);

  const findings = computeDrift(store, root).findings;
  const onPage = findings.filter((f) => f.kind === "doc-anchor-stale" && f.id === "wiki/store-layer.md");
  assert.equal(onPage.length, 1, "the generated page's pin goes stale like any prose pin");
  assert.match(onPage[0]!.detail, /dec_fsync/);
  assert.ok(findings.some((f) => f.kind === "wiki-stale"), "and the hash moved too — heal regenerates + re-pins");
});

test("now page: recent ledger + roadmap from proposed decisions; recording/accepting intent moves the page through drift", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  const page = readFileSync(join(root, "wiki", "now.md"), "utf8");
  assert.ok(page.startsWith("<!-- hunch:wiki _now"), "reserved generated artifact");
  assert.match(page, /## 🔥 Recent[\s\S]*Atomic JSON writes/);
  assert.match(page, /## 🗺 Roadmap[\s\S]*_Empty\./, "no proposed decisions → empty roadmap with guidance");
  assert.equal(computeWikiDrift(store, root).length, 0);

  // Record intent: a HUMAN-VOUCHED proposed decision → now-page stale → heal
  // renders it on the roadmap. An auto-drafted proposal (extracted/llm_draft)
  // is review-queue business: counted, never listed.
  store.json.put("decisions", DEC({ id: "dec_next", title: "Add cursor pagination", status: "proposed", context: "Deep pages time out.", valid_from: "2026-07-05T00:00:00Z", date: "2026-07-05T00:00:00Z", provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }) as never);
  store.json.put("decisions", DEC({ id: "dec_draft", title: "Auto-drafted from a commit", status: "proposed", valid_from: "2026-07-05T00:00:00Z", date: "2026-07-05T00:00:00Z" }) as never);
  let findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/now.md" && /activity ledger \/ roadmap moved/.test(f.detail)));
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  const mid = readFileSync(join(root, "wiki", "now.md"), "utf8");
  assert.match(mid, /## 🗺 Roadmap[\s\S]*Add cursor pagination[\s\S]*Deep pages time out/);
  assert.doesNotMatch(mid, /🗺[\s\S]*Auto-drafted from a commit/, "un-vouched drafts stay off the roadmap");
  assert.match(mid, /1 legacy un-vouched proposed decision\(s\) not shown/);
  assert.equal(computeWikiDrift(store, root).length, 0);
  store.json.delete("decisions", "dec_draft");

  // Ship it: proposed → accepted leaves the roadmap (and lands in Recent) automatically.
  store.json.put("decisions", DEC({ id: "dec_next", title: "Add cursor pagination", status: "accepted", valid_from: "2026-07-05T00:00:00Z", date: "2026-07-05T00:00:00Z" }) as never);
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  const after = readFileSync(join(root, "wiki", "now.md"), "utf8");
  assert.match(after, /## 🗺 Roadmap[\s\S]*_Empty\./, "accepted item left the roadmap by itself");
  assert.match(after, /## 🔥 Recent[\s\S]*Add cursor pagination/);
  assert.equal(readWikiManifestAt(home.manifestPath)?.pages["wiki/now.md"]?.component, "_now");
});

test("relation-link hashing: renaming a sibling re-renders the pages that LINK to it (dec_c205c26472 residual closed)", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("components", CMP({ id: "cmp_core", name: "Core", paths: ["src/core/**"] }) as never);
  store.json.put("edges", { id: "edge_1", from: "cmp_store", to: "cmp_core", type: "depends_on", reason: "", strength: 0.8, provenance: prov(0.9) } as never);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });
  assert.match(readFileSync(join(root, "wiki", "store-layer.md"), "utf8"), /\[Core\]\(core\.md\)/);
  assert.equal(computeWikiDrift(store, root).length, 0);

  store.json.put("components", CMP({ id: "cmp_core", name: "Kernel", paths: ["src/core/**"] }) as never); // rename → slug moves
  const findings = computeWikiDrift(store, root);
  assert.ok(findings.some((f) => f.id === "wiki/store-layer.md"), "the LINKING page goes stale, not just the renamed one");
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.match(readFileSync(join(root, "wiki", "store-layer.md"), "utf8"), /\[Kernel\]\(kernel\.md\)/, "link re-rendered to the new slug");
  assert.equal(computeWikiDrift(store, root).length, 0);
});

test("prose-heal: an adopted copy gains the reconciled overview; failure or absence keeps the deterministic copy byte-identical", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  store.json.put("decisions", DEC({ status: "superseded", superseded_by: "dec_v2" }) as never);
  store.json.put("decisions", DEC({ id: "dec_v2", topic: "store.write-durability", title: "fsync then rename", supersedes: "dec_atomic" }) as never);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "durability.md"), "# Durability\n<!-- hunch:topic store.write-durability dec_atomic -->\nOld prose.\n");
  const home = publicHome(root, "wiki");

  await generateWiki(store, root, home, { now: NOW, only: "all" });
  const plain = readFileSync(join(root, "wiki", "docs", "docs-durability.md"), "utf8");
  assert.doesNotMatch(plain, /Reconciled overview/);

  await generateWiki(store, root, home, {
    now: NOW, only: "all",
    adoptionProse: async (doc) => `This doc now reflects cursor durability for ${doc.rel} (dec_v2).`,
  });
  const healed = readFileSync(join(root, "wiki", "docs", "docs-durability.md"), "utf8");
  assert.match(healed, /## 🩹 Reconciled overview[\s\S]*cursor durability[\s\S]*deterministic, authoritative layer/);
  assert.match(healed, /🧭 Graph correction/, "deterministic corrections remain under the prose");

  await generateWiki(store, root, home, {
    now: NOW, only: "all",
    adoptionProse: async () => { throw new Error("CLI exploded"); },
  });
  assert.equal(readFileSync(join(root, "wiki", "docs", "docs-durability.md"), "utf8"), plain, "prose failure degrades to the exact deterministic copy");
});

test("memory graph page: embedded data, component links, tamper tripwire, heal", async (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  seed(store);
  const home = publicHome(root, "wiki");
  await generateWiki(store, root, home, { now: NOW, only: "all" });

  const page = readFileSync(join(root, "wiki", "graph.html"), "utf8");
  assert.match(page, /hunch:wiki _graph/, "carries the generated-artifact marker");
  assert.match(page, /"Store Layer"/, "embeds the component");
  assert.match(page, /"slug":"store-layer"/, "node click resolves to the component page slug");
  assert.match(page, /"2026-07-02"/, "decision dates ride in for the time scrubber");
  assert.match(page, /"docs":\[/, "repo docs embed with their freshness grades — the knowledge-base layer");
  assert.match(page, /"pendingReview":/, "the act-now panel gets the review count");
  assert.equal(readWikiManifestAt(home.manifestPath)?.pages["wiki/graph.html"]?.component, "_graph");

  // Hand edit → bytes tripwire → wiki-stale; heal regenerates byte-identically.
  writeFileSync(join(root, "wiki", "graph.html"), page + "<!-- vandalized -->");
  const findings = computeWikiDrift(store, root).filter((f) => f.id === "wiki/graph.html");
  assert.equal(findings.length, 1, "hand edit grades the graph page stale");
  await generateWiki(store, root, home, { now: NOW, only: "stale" });
  assert.equal(readFileSync(join(root, "wiki", "graph.html"), "utf8"), page, "heal restores the derived view");
  assert.equal(computeWikiDrift(store, root).length, 0);
});
