import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { compareCandidates } from "../src/core/compare.js";
import type { Constraint } from "../src/core/types.js";

const PROV = () => ({ source: "human_confirmed" as const, confidence: 1, evidence: [] });

test("compare ranks the architecturally-clean candidate above one that hits a blocking invariant", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cmp-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  try {
    g("init"); g("config", "user.email", "t@t.co"); g("config", "user.name", "t");
    mkdirSync(join(root, "src/store"), { recursive: true });
    mkdirSync(join(root, "src/util"), { recursive: true });
    writeFileSync(join(root, "src/store/x.ts"), "export function x(){ return 1; }\n");
    writeFileSync(join(root, "src/util/y.ts"), "export function y(){ return 1; }\n");
    g("add", "-A"); g("commit", "-m", "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

    // "safe" — edits a file under no constraint
    g("checkout", "-b", "safe");
    writeFileSync(join(root, "src/util/y.ts"), "export function y(){ return 2; }\n");
    g("add", "-A"); g("commit", "-m", "tweak util");

    // "risky" — edits a file under a BLOCKING constraint
    g("checkout", base); g("checkout", "-b", "risky");
    writeFileSync(join(root, "src/store/x.ts"), "export function x(){ return 2; }\n");
    g("add", "-A"); g("commit", "-m", "tweak store");

    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.json.put("constraints", {
      id: "con_store", type: "correctness", statement: "Store writes must be atomic",
      scope: ["src/store/**"], severity: "blocking", enforcement: "advisory_v1",
      rationale: "a partial write corrupts the source of truth", source_decision: null,
      violations: [], status: "active", valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: PROV(),
    } as unknown as Constraint);
    store.reindex();

    const ranked = compareCandidates(store, root, base, ["risky", "safe"]);
    assert.equal(ranked[0]!.ref, "safe", "the clean candidate ranks first");
    assert.equal(ranked[0]!.verdict, "pass");
    assert.equal(ranked[1]!.ref, "risky");
    assert.ok(ranked[1]!.blocking >= 1 || ranked[1]!.direct >= 1, "risky trips the constraint");

    // a missing ref sorts last with an error, never crashes
    const withBad = compareCandidates(store, root, base, ["safe", "nope"]);
    assert.equal(withBad[withBad.length - 1]!.ref, "nope");
    assert.match(withBad[withBad.length - 1]!.error!, /not found/);

    store.close();
  } finally {
    cleanupDir(root);
  }
});
