import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGroundingBlock, describeGroundingFreshness, parseGroundingCounts } from "../src/core/groundingLag.js";

const block = (counts: string, tail = "\n\n- `hunch_context(target)` — call FIRST.") =>
  `## 🧠 Hunch (Engineering Memory)\n\nThis repo has **Hunch**. It currently holds **${counts}**.${tail}`;

test("parseGroundingCounts reads the six counts and tolerates a missing findings clause", () => {
  const p = parseGroundingCounts(block("227 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings"));
  assert.deepEqual(p?.counts, { decisions: 227, bugs: 2, constraints: 28, components: 21, policies: 3, findings: 2 });
  const none = parseGroundingCounts(block("1 decisions, 1 bugs, 1 constraints, 1 components, 1 policies"));
  assert.equal(none?.counts.findings, 0);
  assert.equal(parseGroundingCounts("no counts here"), null);
});

test("identical blocks are fresh", () => {
  const b = block("227 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings");
  assert.deepEqual(classifyGroundingBlock(b, b), { kind: "fresh" });
});

test("the merge case: two branches each captured, the doc is one decision behind → lagging", () => {
  const committed = block("228 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings");
  const generated = block("229 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings");
  const v = classifyGroundingBlock(committed, generated);
  assert.equal(v.kind, "lagging");
  if (v.kind === "lagging") assert.deepEqual(v.behind, ["decisions"]);
  assert.match(describeGroundingFreshness("CLAUDE.md", v), /lag the store \(decisions 228 → 229\)/);
});

test("open findings may differ in either direction and still count as lag", () => {
  const committed = block("228 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 3 open findings");
  const generated = block("228 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 1 open findings");
  assert.equal(classifyGroundingBlock(committed, generated).kind, "lagging");
  const zero = block("228 decisions, 2 bugs, 28 constraints, 21 components, 3 policies");
  assert.equal(classifyGroundingBlock(committed, zero).kind, "lagging");
});

test("an append-only count ahead of the store is the never-committed-record defect → ahead", () => {
  const committed = block("228 decisions, 2 bugs, 28 constraints, 22 components, 3 policies, 2 open findings");
  const generated = block("228 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings");
  const v = classifyGroundingBlock(committed, generated);
  assert.equal(v.kind, "ahead");
  if (v.kind === "ahead") assert.deepEqual(v.ahead, ["components"]);
  assert.match(describeGroundingFreshness("CLAUDE.md", v), /AHEAD of the store \(components 22 → 21\)/);
});

test("one count behind and another ahead is still ahead — a missing record is never masked by lag", () => {
  const committed = block("227 decisions, 3 bugs, 28 constraints, 21 components, 3 policies, 2 open findings");
  const generated = block("229 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings");
  assert.equal(classifyGroundingBlock(committed, generated).kind, "ahead");
});

test("any difference outside the counts sentence is divergence, even with lagging counts", () => {
  const committed = block("228 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings", "\n\n- old tool line");
  const generated = block("229 decisions, 2 bugs, 28 constraints, 21 components, 3 policies, 2 open findings", "\n\n- new tool line");
  const v = classifyGroundingBlock(committed, generated);
  assert.equal(v.kind, "diverged");
  assert.match(describeGroundingFreshness("CLAUDE.md", v), /outside the record-counts sentence/);
  assert.equal(classifyGroundingBlock("no counts", block("1 decisions, 0 bugs, 0 constraints, 0 components, 0 policies")).kind, "diverged");
});
