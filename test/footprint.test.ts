import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureFootprint } from "../src/core/footprint.js";
import { mkConstraint, tempStore } from "./helpers.js";

// Context-footprint ceilings in characters (#372), set at measured × 1.10 rounded up to
// the next 500 on the seeded temp store below (hunch_context: measured × 1.10, #371; the
// grounding block rose with the seeded constraints, not with a code change). Ratchet —
// lower when a cut lands; raising needs a reason in the PR.
const CEILINGS: Record<string, number> = {
  "mcp.tools_list": 41_500,
  "mcp.tools_list.core": 32_500,
  "mcp.hunch_context": 3_600,
  "mcp.hunch_task.start": 1_500,
  "mcp.hunch_task.finish": 1_000,
  "grounding.block": 3_500,
  "hook.session.pipeline_loop": 1_000,
  "hook.prompt.reminder": 500,
  "hook.prompt.task_instruction": 1_000,
  "hook.prompt.task_instruction.compact": 500,
};

test("footprint: every surface is measured, non-empty, and under its ceiling", async () => {
  // Pin the default (core) toolset so a developer's HUNCH_MCP_TOOLS can't move the numbers.
  const saved = process.env.HUNCH_MCP_TOOLS;
  delete process.env.HUNCH_MCP_TOOLS;
  const { store, root, cleanup } = tempStore();
  try {
    // A FILE target with more records than the budget holds, so the hunch_context
    // result carries per-record lines and omissions as it does on a real repo.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "context.ts"), "export const context = true;\n");
    for (let i = 0; i < 40; i++) {
      store.json.put("constraints", mkConstraint({
        id: `con_footprint_${String(i).padStart(2, "0")}`,
        statement: `Warning invariant number ${i} about the context module, worded long enough to cost real budget.`,
        scope: ["src/context.ts"],
      }));
    }
    store.reindex();
    const report = await measureFootprint(root, { target: "src/context.ts" });
    assert.equal(report.schema, "hunch.footprint/1");
    assert.equal(report.estimate, "chars/4");
    assert.ok(report.unmeasured.length > 0);
    for (const s of report.surfaces) {
      assert.ok(s.chars > 0, `${s.id} measured 0 chars`);
      assert.equal(s.est_tokens, Math.ceil(s.chars / 4));
      const ceiling = CEILINGS[s.id];
      assert.ok(ceiling !== undefined, `${s.id} has no ceiling`);
      assert.ok(s.chars <= ceiling, `${s.id}: ${s.chars} chars exceeds ceiling ${ceiling}`);
    }
    assert.deepEqual(Object.keys(CEILINGS).sort(), report.surfaces.map(s => s.id).sort());

    // The host shows the model one channel; whichever it is must fit the budget (#371).
    const context = report.surfaces.find(s => s.id === "mcp.hunch_context")!;
    const detail = context.detail!;
    assert.equal(context.chars, Math.max(detail.content_chars!, detail.structured_chars!));
    assert.ok(detail.content_chars! > 0 && detail.structured_chars! > 0);
    const budgetChars = detail.budget_tokens! * 4;
    assert.ok(context.chars <= budgetChars * 1.25, `hunch_context shows ${context.chars} chars for a ${budgetChars}-char budget`);
  } finally {
    cleanup();
    if (saved !== undefined) process.env.HUNCH_MCP_TOOLS = saved;
  }
});
