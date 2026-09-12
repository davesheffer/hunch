import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPolicyEvaluations } from "../src/constitution/renderEvaluations.js";
import type { PolicyEvaluationSet } from "../src/constitution/service.js";

function receipt(id: string, result: string, explanation: string, extra: Partial<PolicyEvaluationSet> = {}): PolicyEvaluationSet {
  return {
    policy: { id, state: "active_advisory" },
    evaluation: { result, explanation, deterministic_hash: `sha1:${id.replace(/\W/g, "").padEnd(40, "0").slice(0, 40)}` },
    blocks: false, strict_error: false, ...extra,
  } as unknown as PolicyEvaluationSet;
}

test("identical non-evaluations are grouped into one actionable block; verdicts stay one per line", () => {
  const cause = "no dependency snapshot cache exists on this machine (.hunch-cache/behavior-deps)";
  const results = [
    receipt("pol_ok", "satisfied", "symbol:a does not reach symbol:b"),
    ...["pol_e1", "pol_e2", "pol_e3", "pol_e4"].map(id => receipt(id, "error", cause)),
    receipt("pol_bad", "violated", "symbol:x reaches symbol:y", { blocks: true }),
    receipt("pol_other", "error", "a different cause"),
  ];
  const lines = renderPolicyEvaluations(results);
  assert.equal(lines[0], "Constitution policy evaluation: 7 canonical receipt(s)");
  assert.equal(lines.filter(l => l.includes(cause)).length, 1, "one explanation for the four identical errors");
  assert.match(lines.join("\n"), /‼ 4 policies \[active_advisory\] error — same cause/);
  assert.match(lines.join("\n"), /policies: pol_e1, pol_e2, pol_e3, pol_e4/);
  assert.match(lines.join("\n"), /receipts: pol_e1=sha1:/, "every grouped receipt stays identifiable");
  assert.match(lines.join("\n"), /⛔ pol_bad \[active_advisory\] violated — BLOCK/);
  assert.match(lines.join("\n"), /✅ pol_ok \[active_advisory\] satisfied/);
  assert.match(lines.join("\n"), /‼ pol_other \[active_advisory\] error\n     a different cause/);
  assert.ok(lines.length < 4 * 3 + 3 * 3, "grouping shortens the output");
});

test("fewer than three identical non-evaluations, and any blocking receipt, are never grouped", () => {
  const cause = "same cause";
  const lines = renderPolicyEvaluations([
    receipt("pol_a", "error", cause), receipt("pol_b", "error", cause),
    receipt("pol_c", "error", cause, { blocks: true }), receipt("pol_d", "error", cause, { blocks: true }), receipt("pol_e", "error", cause, { blocks: true }),
  ]).join("\n");
  assert.doesNotMatch(lines, /policies:/);
  for (const id of ["pol_a", "pol_b", "pol_c", "pol_d", "pol_e"]) assert.match(lines, new RegExp(`‼ ${id} \\[active_advisory\\] error`));
  assert.equal((lines.match(/— BLOCK/g) ?? []).length, 3);
});
