import { test } from "node:test";
import assert from "node:assert/strict";
import { measureFootprint } from "../src/core/footprint.js";
import { tempStore } from "./helpers.js";

// Context-footprint ceilings in characters (#372), set at measured × 1.10 rounded up to
// the next 500 on an empty temp store. Ratchet — lower when a cut lands; raising needs a
// reason in the PR.
const CEILINGS: Record<string, number> = {
  "mcp.tools_list": 41_500,
  "mcp.tools_list.core": 32_500,
  "mcp.hunch_context": 1_000,
  "grounding.block": 2_000,
  "hook.session.pipeline_loop": 1_000,
  "hook.prompt.reminder": 500,
  "hook.prompt.task_instruction": 1_000,
  "hook.prompt.task_instruction.compact": 500,
};

test("footprint: every surface is measured, non-empty, and under its ceiling", async () => {
  // Pin the default (core) toolset so a developer's HUNCH_MCP_TOOLS can't move the numbers.
  const saved = process.env.HUNCH_MCP_TOOLS;
  delete process.env.HUNCH_MCP_TOOLS;
  const { root, cleanup } = tempStore();
  try {
    const report = await measureFootprint(root);
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
  } finally {
    cleanup();
    if (saved !== undefined) process.env.HUNCH_MCP_TOOLS = saved;
  }
});
