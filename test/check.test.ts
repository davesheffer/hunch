import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { prov } from "./helpers.js";

// jwt.ts ← session.ts ← charge.ts : a 2-hop dependency chain.
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-check-"));
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
  const fileOf = (name: string) => syms.find((s) => s.name === name)!.file;
  return { store, root, fileOf, cleanup: () => { store.close(); cleanupDir(root); } };
}

test("blastRadiusFiles collapses transitive dependents to files (nearest depth wins, self excluded)", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const jwt = fileOf("jwtDecode"), session = fileOf("verifySession"), charge = fileOf("charge");
    const byFile = new Map(store.blastRadiusFiles(jwt).map((b) => [b.file, b.depth]));
    assert.ok(byFile.has(session), "session.ts (direct dependent) in blast radius");
    assert.ok(byFile.has(charge), "charge.ts (transitive dependent) in blast radius");
    assert.ok(byFile.get(session)! < byFile.get(charge)!, "direct dependent is nearer than transitive");
    assert.ok(!byFile.has(jwt), "the edited file itself is excluded");
  } finally { cleanup(); }
});

test("near-violation: a constraint is reached through the blast radius, not just direct scope", () => {
  const { store, fileOf, cleanup } = indexed();
  try {
    const jwt = fileOf("jwtDecode"), charge = fileOf("charge");
    store.json.put("constraints", {
      id: "con_billing", statement: "billing rounds half-up", scope: [charge],
      severity: "blocking", rationale: "money", provenance: prov(),
    } as never);
    store.reindex();
    // Editing jwt.ts touches the billing invariant's scope only INDIRECTLY:
    assert.equal(store.checkConstraints(jwt).length, 0, "no direct hit");
    const reached = store.blastRadiusFiles(jwt).flatMap((b) => store.checkConstraints(b.file)).map((c) => c.id);
    assert.ok(reached.includes("con_billing"), "billing constraint surfaced via blast radius");
  } finally { cleanup(); }
});
