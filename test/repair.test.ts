import { test } from "node:test";
import assert from "node:assert/strict";
import { renamesOf, planRepair, repairDecision, repairConstraint } from "../src/core/repair.js";
import type { Decision, Constraint } from "../src/core/types.js";

const D = (over: Partial<Decision> & { id: string }): Decision => ({
  id: over.id, title: `t ${over.id}`, decision: "d", status: over.status ?? "accepted",
  related_files: over.related_files ?? [], rejected_tripwires: over.rejected_tripwires ?? [],
  alternatives_rejected: [],
  provenance: { source: "llm_draft", confidence: 0.6, evidence: [] },
} as unknown as Decision);

const C = (over: Partial<Constraint> & { id: string }): Constraint => ({
  id: over.id, statement: `s ${over.id}`, severity: "warning", status: over.status ?? "active",
  scope: over.scope ?? [],
  provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] },
} as unknown as Constraint);

const TW = (scope: string[]) => ({
  alternative: "alt", scope, forbids: { deps: [], symbols: [], patterns: [] },
  provenance: { source: "llm_draft", confidence: 0.6, evidence: [] },
});

test("renamesOf: only true renames yield pairs; adds/deletes/copies never do", () => {
  const pairs = renamesOf([
    { status: "renamed", before: "src/a.ts", after: "src/b.ts" },
    { status: "copied", before: "src/a.ts", after: "src/c.ts" },
    { status: "deleted", before: "src/d.ts", after: null },
    { status: "added", before: null, after: "src/e.ts" },
    { status: "modified", before: "src/f.ts", after: "src/f.ts" },
  ]);
  assert.deepEqual(pairs, [{ before: "src/a.ts", after: "src/b.ts" }]);
});

test("planRepair: exact-path bindings are rewritten; globs and non-matches are never touched", () => {
  const d = D({
    id: "dec_1",
    related_files: ["src/old.ts", "src/other.ts"],
    rejected_tripwires: [TW(["src/old.ts", "src/**"])], // the glob must survive untouched
  });
  const c = C({ id: "con_1", scope: ["src/old.ts", "src/store/**"] });
  const plan = planRepair([{ before: "src/old.ts", after: "src/new.ts" }], [d], [c]);
  assert.equal(plan.rewrites.length, 3);
  assert.deepEqual(plan.records.sort(), ["constraints:con_1", "decisions:dec_1"]);

  const healedD = repairDecision(d, plan);
  assert.deepEqual(healedD.related_files, ["src/new.ts", "src/other.ts"]);
  assert.deepEqual(healedD.rejected_tripwires![0]!.scope, ["src/new.ts", "src/**"]);
  const healedC = repairConstraint(c, plan);
  assert.deepEqual(healedC.scope, ["src/new.ts", "src/store/**"]);
});

test("planRepair: superseded/rejected decisions and inactive constraints keep their history as written", () => {
  const dead = D({ id: "dec_dead", status: "superseded", related_files: ["src/old.ts"] });
  const gone = C({ id: "con_gone", status: "retired" as never, scope: ["src/old.ts"] });
  const plan = planRepair([{ before: "src/old.ts", after: "src/new.ts" }], [dead], [gone]);
  assert.equal(plan.rewrites.length, 0);
});

test("repairDecision/repairConstraint: untouched records return the same reference (no needless writes)", () => {
  const d = D({ id: "dec_u", related_files: ["src/unrelated.ts"] });
  const c = C({ id: "con_u", scope: ["src/unrelated.ts"] });
  const plan = planRepair([{ before: "src/old.ts", after: "src/new.ts" }], [d], [c]);
  assert.equal(repairDecision(d, plan), d);
  assert.equal(repairConstraint(c, plan), c);
});

test("planRepair: no renames → empty plan, zero work", () => {
  const plan = planRepair([], [D({ id: "dec_1", related_files: ["src/a.ts"] })], []);
  assert.deepEqual(plan, { rewrites: [], records: [] });
});
