/**
 * hunch path + hunch impact — the derived-query surface (shortestPath,
 * resolveNodeIds, prImpact). Read-only, advisory; composes the same primitives
 * as the check pipeline so impact and gating cannot disagree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { renderImpact } from "../src/core/checkreport.js";
import { prov } from "./helpers.js";

// jwt.ts ← session.ts ← charge.ts : a 2-hop dependency chain.
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-impact-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), `import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n`);
  writeFileSync(join(root, "src/auth/jwt.ts"), `export function jwtDecode(t){ return t; }\n`);
  writeFileSync(join(root, "src/billing/charge.ts"), `import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n`);
  return root;
}

function indexed() {
  const root = fixtureRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  const syms = store.json.loadAll("symbols");
  const idOf = (name: string) => syms.find((s) => s.name === name)!.id;
  const fileOf = (name: string) => syms.find((s) => s.name === name)!.file;
  return { store, root, idOf, fileOf, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("shortestPath finds the chain across edge direction, cycles terminate, unreachable → null", () => {
  const { store, idOf, cleanup } = indexed();
  try {
    const path = store.shortestPath(idOf("jwtDecode"), idOf("charge"));
    assert.ok(path, "a path exists");
    assert.equal(path![0].id, idOf("jwtDecode"), "starts at from");
    assert.equal(path![path!.length - 1].id, idOf("charge"), "ends at to");
    assert.ok(path!.some((n) => n.id === idOf("verifySession")), "goes through the middle of the chain");
    // same node → trivial path
    assert.equal(store.shortestPath(idOf("charge"), idOf("charge"))!.length, 1);
    // unreachable within a 0-hop budget → null (depth cap respected, no hang on cycles)
    assert.equal(store.shortestPath(idOf("jwtDecode"), idOf("charge"), 1), null);
  } finally { cleanup(); }
});

test("resolveNodeIds resolves by symbol name, exact file, and file suffix", () => {
  const { store, idOf, fileOf, cleanup } = indexed();
  try {
    assert.ok(store.resolveNodeIds("jwtDecode").includes(idOf("jwtDecode")), "by name");
    assert.ok(store.resolveNodeIds(fileOf("charge")).includes(idOf("charge")), "by exact file");
    assert.ok(store.resolveNodeIds("auth/jwt.ts").includes(idOf("jwtDecode")), "by file suffix");
    assert.deepEqual(store.resolveNodeIds("no-such-thing"), [], "unknown → empty");
  } finally { cleanup(); }
});

test("prImpact composes blast radius + constraints + decisions for a change", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const jwt = fileOf("jwtDecode"), session = fileOf("verifySession"), charge = fileOf("charge");
    store.json.put("constraints", {
      id: "con_billing", statement: "billing rounds half-up", scope: [charge],
      severity: "blocking", rationale: "money", provenance: prov(),
    } as never);
    store.json.put("decisions", {
      id: "dec_jwt", title: "JWT decode stays dependency-free", status: "accepted",
      context: "", decision: "no external jwt lib", consequences: [], alternatives_rejected: [],
      related_components: [], related_files: [jwt], supersedes: null, superseded_by: null,
      caused_by_bug: null, commit: null, retired: { symbols: [], deps: [] },
      provenance: prov(), date: new Date().toISOString(),
    } as never);
    store.reindex();

    const im = store.prImpact([jwt], "");
    const blastFiles = im.blast.map((b) => b.file);
    assert.ok(blastFiles.includes(session) && blastFiles.includes(charge), "blast reaches both dependents");
    assert.ok(!blastFiles.includes(jwt), "changed file excluded from its own blast");
    assert.ok(im.report.near.some((n) => n.id === "con_billing"), "constraint reached via blast radius is a near hit");
    assert.ok(im.decisions.some((d) => d.id === "dec_jwt"), "decision concerning the touched file is cited");

    const text = renderImpact(im, "test scope");
    assert.match(text, /dependent file\(s\)/);
    assert.match(text, /con_billing/);
    assert.match(text, /dec_jwt/);
  } finally { cleanup(); }
});
