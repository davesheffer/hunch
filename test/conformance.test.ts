import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { checkConformance } from "../src/core/conformance.js";
import type { Decision } from "../src/core/types.js";

const PROV = () => ({ source: "human_confirmed" as const, confidence: 1, evidence: [] });
const DEC = (id: string, conformance: unknown[]) =>
  ({
    id, title: id, status: "accepted", context: "", decision: "",
    consequences: [], alternatives_rejected: [], rejected_tripwires: [],
    related_components: [], related_files: [], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
    retired: { symbols: [], deps: [] }, conformance, provenance: PROV(), date: "2026-01-01T00:00:00Z",
  }) as unknown as Decision;

function indexedRepo(chargeBody: string) {
  const root = mkdtempSync(join(tmpdir(), "hunch-conf-"));
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/billing"), { recursive: true });
  writeFileSync(join(root, "src/auth/jwt.ts"), "export function jwtDecode(t){ return t; }\n");
  writeFileSync(join(root, "src/auth/session.ts"), 'import { jwtDecode } from "./jwt.js";\nexport function verifySession(t){ return jwtDecode(t); }\n');
  writeFileSync(join(root, "src/billing/charge.ts"), chargeBody);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("conformance proves code SATISFIES intent and catches direct-vs-transitive + existence", () => {
  const { store, cleanup } = indexedRepo('import { verifySession } from "../auth/session.js";\nexport function charge(t){ return verifySession(t); }\n');
  try {
    store.json.put("decisions", DEC("dec_verify", [{ assert: "calls", subject: "charge", object: "verifySession", transitive: false }]));
    store.json.put("decisions", DEC("dec_jwt_t", [{ assert: "calls", subject: "charge", object: "jwtDecode", transitive: true }]));
    store.json.put("decisions", DEC("dec_jwt_d", [{ assert: "calls", subject: "charge", object: "jwtDecode", transitive: false }]));
    store.json.put("decisions", DEC("dec_notcall", [{ assert: "not-calls", subject: "jwtDecode", object: "charge", transitive: true }]));
    store.json.put("decisions", DEC("dec_exist", [{ assert: "exists", subject: "verifySession" }]));
    store.json.put("decisions", DEC("dec_gone", [{ assert: "exists", subject: "ghostFn" }]));
    store.reindex();

    const r = checkConformance(store);
    const sat = (id: string) => r.find((x) => x.decision === id)!.satisfied;
    assert.equal(sat("dec_verify"), true, "charge directly calls verifySession");
    assert.equal(sat("dec_jwt_t"), true, "charge transitively reaches jwtDecode");
    assert.equal(sat("dec_jwt_d"), false, "charge does NOT directly call jwtDecode");
    assert.equal(sat("dec_notcall"), true, "jwtDecode never reaches charge");
    assert.equal(sat("dec_exist"), true, "verifySession exists");
    assert.equal(sat("dec_gone"), false, "ghostFn is gone → intent violated");
  } finally { cleanup(); }
});

test("Architectural Conformance: a controller bypassing the service layer to reach the DB flips satisfied→violated (the wedge)", () => {
  function layered(apiBody: string) {
    const root = mkdtempSync(join(tmpdir(), "hunch-arch-"));
    mkdirSync(join(root, "src/api"), { recursive: true });
    mkdirSync(join(root, "src/services"), { recursive: true });
    mkdirSync(join(root, "src/db"), { recursive: true });
    writeFileSync(join(root, "src/db/client.ts"), "export function dbQuery(sql){ return sql; }\n");
    writeFileSync(join(root, "src/services/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u){ return dbQuery(u); }\n');
    writeFileSync(join(root, "src/api/orders.ts"), apiBody);
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    store.reindex();
    return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
  }
  // "controllers must not reach the DB directly" — a layering rule no pattern-matcher can express.
  const INV = [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }];

  // through the service layer → invariant holds
  const ok = layered('import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
  try {
    ok.store.json.put("decisions", DEC("dec_layer", INV));
    ok.store.reindex();
    assert.equal(checkConformance(ok.store)[0]!.satisfied, true, "going through the service: architecture holds");
  } finally { ok.cleanup(); }

  // an AI "optimization" hits the DB directly (a legitimate internal import — passes any linter) → VIOLATED
  const bad = layered('import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
  try {
    bad.store.json.put("decisions", DEC("dec_layer", INV));
    bad.store.reindex();
    const r = checkConformance(bad.store);
    assert.equal(r[0]!.satisfied, false, "controller bypassed the service to reach the DB directly — architecture VIOLATED");
    assert.match(r[0]!.detail, /VIOLATED/);
  } finally { bad.cleanup(); }
});

test("conformance catches DRIFT: code that stopped honoring the intent flips to violated", () => {
  // charge no longer calls verifySession — the recorded intent is now false of the code.
  const { store, cleanup } = indexedRepo("export function charge(t){ return t; }\n");
  try {
    store.json.put("decisions", DEC("dec_verify", [{ assert: "calls", subject: "charge", object: "verifySession", transitive: true }]));
    store.reindex();
    const r = checkConformance(store);
    assert.equal(r[0]!.satisfied, false, "code drifted: charge no longer reaches verifySession");
    assert.match(r[0]!.detail, /VIOLATED/);
  } finally { cleanup(); }
});

test("duplicate symbol names cannot hide a forbidden edge or prove an ambiguous required edge", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-conf-ambiguous-"));
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(join(root, "src/db"), { recursive: true });
  writeFileSync(join(root, "src/db/first.ts"), "export function dbQuery(sql){ return sql; }\n");
  writeFileSync(join(root, "src/db/second.ts"), "export function dbQuery(sql){ return sql; }\n");
  writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/second.js";\nexport function listOrders(sql){ return dbQuery(sql); }\n');
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", DEC("dec_forbidden_ambiguous", [
      { assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false },
    ]));
    store.json.put("decisions", DEC("dec_required_ambiguous", [
      { assert: "calls", subject: "listOrders", object: "dbQuery", transitive: false },
    ]));
    store.json.put("decisions", DEC("dec_required_qualified", [
      { assert: "calls", subject: "listOrders", object: "src/db/second.ts:dbQuery", transitive: false },
    ]));

    const results = checkConformance(store);
    const result = (id: string) => results.find((candidate) => candidate.decision === id)!;
    assert.equal(result("dec_forbidden_ambiguous").satisfied, false,
      "any same-name forbidden target reached by the subject is a violation");
    assert.match(result("dec_forbidden_ambiguous").detail, /VIOLATED/);
    assert.equal(result("dec_required_ambiguous").satisfied, false,
      "a required relation cannot guess which duplicate symbol was intended");
    assert.match(result("dec_required_ambiguous").detail, /ambiguous required binding/i);
    assert.equal(result("dec_required_qualified").satisfied, true,
      "file-qualified required relations remain exact and provable");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
