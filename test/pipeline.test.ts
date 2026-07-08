import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyDomains,
  emptyState,
  isProductPath,
  loadPipelineState,
  onCommand,
  onEdit,
  onPrompt,
  onSkill,
  savePipelineState,
  stopVerdict,
} from "../src/core/pipeline.js";

test("isProductPath: docs, .claude and .hunch are not gated", () => {
  assert.equal(isProductPath("README.md"), false);
  assert.equal(isProductPath("docs/notes.mdx"), false);
  assert.equal(isProductPath(".claude/skills/x/SKILL.md"), false);
  assert.equal(isProductPath(".hunch/decisions/d.json"), false);
  assert.equal(isProductPath("src/core/pipeline.ts"), true);
  assert.equal(isProductPath("packages\\zod\\src\\v4\\core\\util.ts"), true);
});

test("classifyDomains: paths activate the right profiles", () => {
  assert.ok(classifyDomains("src/store/db.ts").includes("backend"));
  assert.ok(classifyDomains("site/components/Nav.tsx").includes("frontend"));
  assert.ok(classifyDomains("test/check.test.ts").includes("tests"));
  assert.ok(classifyDomains(".github/workflows/ci.yml").includes("infra"));
});

test("edit marks unverified; matching command after edit re-verifies", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  assert.equal(st.verifyAfterEdit, false);
  assert.deepEqual(st.editedFiles, ["src/core/topics.ts"]);
  st = onCommand(st, "npx tsx --test test/topics.test.ts");
  assert.equal(st.verifyAfterEdit, true);
});

test("verify-shaped command BEFORE any edit does not pre-satisfy the gate", () => {
  let st = onCommand(emptyState(), "npm test");
  st = onEdit(st, "src/core/topics.ts");
  assert.equal(st.verifyAfterEdit, false);
});

test("non-verify command does not satisfy the gate", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onCommand(st, "git status");
  assert.equal(st.verifyAfterEdit, false);
});

test("bespoke node -e / node --test checks count as verification", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onCommand(st, 'node -e "assert(require(\'./x\'))"');
  assert.equal(st.verifyAfterEdit, true);
  let st2 = onEdit(emptyState(), "src/core/topics.ts");
  st2 = onCommand(st2, "node --test test/");
  assert.equal(st2.verifyAfterEdit, true);
});

test("a command naming an edited file counts as verification", () => {
  let st = onEdit(emptyState(), "site/changelog.html");
  st = onCommand(st, "htmlhint site/changelog.html");
  assert.equal(st.verifyAfterEdit, true);
  // ...but a command naming an unrelated file does not
  let st2 = onEdit(emptyState(), "site/changelog.html");
  st2 = onCommand(st2, "cat README.md");
  assert.equal(st2.verifyAfterEdit, false);
});

test("doc-only edits never arm the gate", () => {
  const st = onEdit(emptyState(), "README.md");
  assert.equal(st.verifyAfterEdit, true);
  assert.equal(st.editedFiles.length, 0);
});

test("review-class skill satisfies the gate", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onSkill(st, "code-review");
  assert.equal(st.verifyAfterEdit, true);
});

test("stopVerdict: blocks only at firm/strict, max twice, resets on prompt", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  assert.equal(stopVerdict(st, "advisory").block, false);
  assert.equal(stopVerdict(st, "off").block, false);

  const v1 = stopVerdict(st, "firm");
  assert.ok(v1.block);
  assert.match(v1.block ? v1.reason : "", /VERIFY unsatisfied/);
  st = v1.block ? v1.state : st;

  const v2 = stopVerdict(st, "strict");
  assert.ok(v2.block);
  st = v2.block ? v2.state : st;

  // third block refused — never a lockout
  assert.equal(stopVerdict(st, "firm").block, false);

  // new user prompt refills the budget
  st = onPrompt(st);
  assert.equal(st.blocks, 0);
  assert.ok(stopVerdict(st, "firm").block);
});

test("stopVerdict: verified state never blocks", () => {
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onCommand(st, "npm run typecheck && tsc");
  assert.equal(stopVerdict(st, "strict").block, false);
});

test("state round-trip survives save/load; garbage session id yields fresh state", () => {
  const id = `pipeline-test-${process.pid}`;
  let st = onEdit(emptyState(), "src/core/topics.ts");
  st = onPrompt(st);
  savePipelineState(id, st);
  const back = loadPipelineState(id);
  assert.equal(back.turn, 1);
  assert.equal(back.verifyAfterEdit, false);
  assert.deepEqual(back.editedFiles, ["src/core/topics.ts"]);
  const fresh = loadPipelineState("no-such-session-ever");
  assert.equal(fresh.turn, 0);
  assert.equal(fresh.verifyAfterEdit, true);
});
