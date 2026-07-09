import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { renderMarkdown } from "../src/core/checkreport.js";
import type { Decision, Constraint } from "../src/core/types.js";

const CON = (id: string, statement: string, scope: string[]): Constraint => ({
  id, type: "correctness", statement, scope, severity: "warning", enforcement: "advisory_v1",
  rationale: "", source_decision: null, violations: [], status: "active",
  valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
} as unknown as Constraint);

const DEC = (id: string, title: string): Decision => ({
  id, title, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  date: "2026-01-01T00:00:00Z",
} as unknown as Decision);

/** A public store, optionally with a private overlay wired via HUNCH_PRIVATE_DIR. */
function setup(withPrivate: boolean): { store: HunchStore; pub: string; priv: string | null; cleanup: () => void } {
  const pub = mkdtempSync(join(tmpdir(), "hunch-pub-"));
  const priv = withPrivate ? mkdtempSync(join(tmpdir(), "hunch-priv-")) : null;
  const prev = process.env.HUNCH_PRIVATE_DIR;
  if (priv) process.env.HUNCH_PRIVATE_DIR = priv;
  else delete process.env.HUNCH_PRIVATE_DIR;
  const store = new HunchStore(hunchPaths(pub)); // reads HUNCH_PRIVATE_DIR at construction
  store.json.ensureDirs();
  return {
    store, pub, priv,
    cleanup: () => {
      store.close();
      if (prev === undefined) delete process.env.HUNCH_PRIVATE_DIR;
      else process.env.HUNCH_PRIVATE_DIR = prev;
      rmSync(pub, { recursive: true, force: true });
      if (priv) rmSync(priv, { recursive: true, force: true });
    },
  };
}

test("private overlay: recs() unions public + private, but public-only loadAll never sees private (LEAK CHECK)", () => {
  const { store, cleanup } = setup(true);
  try {
    store.json.put("decisions", DEC("dec_pub", "public decision"));
    store.putPrivate("decisions", DEC("dec_priv", "sensitive decision"));
    assert.deepEqual(store.recs("decisions").map((d) => d.id).sort(), ["dec_priv", "dec_pub"]); // queries see both
    assert.deepEqual(store.json.loadAll("decisions").map((d) => d.id), ["dec_pub"]); // public writer sees only public
  } finally { cleanup(); }
});

test("private overlay: putPrivate writes nothing into the public .hunch/ tree (filesystem LEAK CHECK)", () => {
  const { store, pub, cleanup } = setup(true);
  try {
    store.putPrivate("decisions", DEC("dec_priv", "sensitive"));
    const pubDecisions = join(pub, ".hunch", "decisions");
    const files = existsSync(pubDecisions) ? readdirSync(pubDecisions) : [];
    assert.ok(!files.some((f) => f.includes("dec_priv")), "private record leaked into public .hunch/");
  } finally { cleanup(); }
});

test("private overlay: local causal receipts and search resolution keep private provenance", () => {
  const { store, cleanup } = setup(true);
  try {
    const decision = DEC("dec_private_cause", "private architecture decision");
    const constraint = CON("con_private_cause", "private constraint", ["src/**"]);
    constraint.source_decision = decision.id;
    store.putPrivate("decisions", decision);
    store.putPrivate("constraints", constraint);
    assert.equal(store.resolve(decision.id)?.record, store.getPrivateRec("decisions", decision.id));
    assert.equal(store.causalChain(constraint.id).decision?.id, decision.id);
  } finally { cleanup(); }
});

test("private overlay: hasPrivate reflects HUNCH_PRIVATE_DIR; putPrivate throws when unset", () => {
  const off = setup(false);
  try {
    assert.equal(off.store.hasPrivate, false);
    assert.throws(() => off.store.putPrivate("decisions", DEC("dec_x", "x")), /private store/i);
  } finally { off.cleanup(); }

  const on = setup(true);
  try {
    assert.equal(on.store.hasPrivate, true);
  } finally { on.cleanup(); }
});

test("private overlay: a publicOnly report renders NO private constraint (CI PR-comment leak guard)", () => {
  const { store, cleanup } = setup(true);
  try {
    store.json.put("constraints", CON("con_pub", "Public rule", ["src/**"]));
    store.putPrivate("constraints", CON("con_priv", "SENSITIVE pricing rule", ["src/**"]));
    store.reindex();
    const files = ["src/x.ts"];
    const diff = "diff --git a/src/x.ts b/src/x.ts\n";
    const local = renderMarkdown(store.buildCheckReport(files, diff, { strict: true }));
    assert.match(local, /SENSITIVE pricing rule/);          // local/merged: private IS enforced + visible
    const posted = renderMarkdown(store.buildCheckReport(files, diff, { strict: true, publicOnly: true }));
    assert.doesNotMatch(posted, /SENSITIVE pricing rule/);  // public-only (CI comment): private EXCLUDED
    assert.match(posted, /Public rule/);                    // public constraint still rendered
  } finally { cleanup(); }
});

test("private overlay: resolves from gitignored .hunch/local.json when NO env var is set", () => {
  const pub = mkdtempSync(join(tmpdir(), "hunch-pub-"));
  const priv = mkdtempSync(join(tmpdir(), "hunch-priv-"));
  const prev = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR; // prove it works with NO env
  try {
    mkdirSync(join(pub, ".hunch"), { recursive: true });
    writeFileSync(join(pub, ".hunch", "local.json"), JSON.stringify({ privateDir: priv }));
    const store = new HunchStore(hunchPaths(pub));
    store.json.ensureDirs();
    assert.equal(store.hasPrivate, true); // picked up from local.json, not env
    store.json.put("decisions", DEC("dec_pub", "public"));
    store.putPrivate("decisions", DEC("dec_priv", "sensitive"));
    assert.deepEqual(store.recs("decisions").map((d) => d.id).sort(), ["dec_priv", "dec_pub"]);
    assert.deepEqual(store.json.loadAll("decisions").map((d) => d.id), ["dec_pub"]); // public-only excludes private
    store.close();
  } finally {
    if (prev === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = prev;
    rmSync(pub, { recursive: true, force: true });
    rmSync(priv, { recursive: true, force: true });
  }
});

test("private overlay: a RELATIVE privateDir in local.json resolves against the repo root (portable, OS-clean)", () => {
  const pub = mkdtempSync(join(tmpdir(), "hunch-pub-"));
  const prev = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  try {
    mkdirSync(join(pub, ".hunch"), { recursive: true });
    writeFileSync(join(pub, ".hunch", "local.json"), JSON.stringify({ privateDir: ".hunch-private/.hunch" }));
    const store = new HunchStore(hunchPaths(pub));
    assert.equal(store.hasPrivate, true);
    assert.equal(store.privateDir, resolve(pub, ".hunch-private/.hunch")); // resolved under root, not cwd
    store.putPrivate("decisions", DEC("dec_p", "p"));
    assert.ok(existsSync(join(pub, ".hunch-private", ".hunch", "decisions", "dec_p.json")));
    store.close();
  } finally {
    if (prev === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = prev;
    rmSync(pub, { recursive: true, force: true });
  }
});

test("private overlay: HUNCH_PRIVATE_DIR env overrides .hunch/local.json", () => {
  const pub = mkdtempSync(join(tmpdir(), "hunch-pub-"));
  const envDir = mkdtempSync(join(tmpdir(), "hunch-env-"));
  const localDir = mkdtempSync(join(tmpdir(), "hunch-local-"));
  const prev = process.env.HUNCH_PRIVATE_DIR;
  try {
    mkdirSync(join(pub, ".hunch"), { recursive: true });
    writeFileSync(join(pub, ".hunch", "local.json"), JSON.stringify({ privateDir: localDir }));
    process.env.HUNCH_PRIVATE_DIR = envDir; // env should win
    const store = new HunchStore(hunchPaths(pub));
    store.json.ensureDirs();
    store.putPrivate("decisions", DEC("dec_env", "from env dir"));
    // the record landed in the ENV dir, not the local.json dir
    assert.ok(existsSync(join(envDir, "decisions", "dec_env.json")));
    assert.ok(!existsSync(join(localDir, "decisions", "dec_env.json")));
    store.close();
  } finally {
    if (prev === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = prev;
    for (const d of [pub, envDir, localDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("private overlay: with no private store, recs() equals the public loadAll", () => {
  const { store, cleanup } = setup(false);
  try {
    store.json.put("decisions", DEC("dec_pub", "public"));
    assert.deepEqual(store.recs("decisions").map((d) => d.id), ["dec_pub"]);
  } finally { cleanup(); }
});

test("private overlay: supersedePrivate closes a private decision in the private store (MCP private-supersede fix)", () => {
  const { store, pub, cleanup } = setup(true);
  try {
    store.putPrivate("decisions", DEC("dec_old", "old private decision"));
    const by: Decision = { ...DEC("dec_new", "new private decision"), valid_from: "2026-06-01T00:00:00Z", supersedes: "dec_old" };
    store.putPrivate("decisions", by);

    const closed = store.supersedePrivate("dec_old", by);
    assert.ok(closed, "supersedePrivate returned null");
    assert.equal(closed!.status, "superseded");
    assert.equal(closed!.superseded_by, "dec_new");
    assert.equal(closed!.valid_to, "2026-06-01T00:00:00Z"); // window closed at by.valid_from

    // the close persisted in the PRIVATE store (visible via the unioned read)
    assert.equal(store.recs("decisions").find((d) => d.id === "dec_old")?.status, "superseded");

    // a supersedes edge was written into the private overlay
    const edge = store.recs("edges").find((e) => e.type === "supersedes" && e.to === "dec_old");
    assert.ok(edge, "supersedes edge missing");
    assert.equal(edge!.from, "dec_new");

    // LEAK CHECK: nothing landed in the public .hunch/ tree
    const pubDec = join(pub, ".hunch", "decisions");
    const pubFiles = existsSync(pubDec) ? readdirSync(pubDec) : [];
    assert.ok(!pubFiles.some((f) => f.includes("dec_old") || f.includes("dec_new")), "private supersede leaked into public store");
  } finally { cleanup(); }
});

test("private overlay: supersedePrivate returns null when no private store is configured", () => {
  const { store, cleanup } = setup(false);
  try {
    assert.equal(store.supersedePrivate("dec_x", DEC("dec_y", "y")), null);
  } finally { cleanup(); }
});
