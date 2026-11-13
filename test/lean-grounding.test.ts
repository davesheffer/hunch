import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkConstraint, tempStore } from "./helpers.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leanGroundingEnabled, renderHunchSection, renderHunchSectionAs, updateClaudeMd } from "../src/integrations/claudemd.js";
import { writeAgentsMd } from "../src/integrations/providers.js";
import { parseGroundingCounts, groundingTemplate, groundingVariant, classifyGroundingBlock } from "../src/core/groundingLag.js";
import { buildServer, MCP_INSTRUCTIONS, MCP_INSTRUCTIONS_LEAN, mcpInstructions } from "../src/mcp/server.js";

function withLean<T>(on: boolean, fn: () => T): T {
  const prior = process.env.HUNCH_LEAN_GROUNDING;
  process.env.HUNCH_LEAN_GROUNDING = on ? "1" : "0";
  try { return fn(); }
  finally {
    if (prior === undefined) delete process.env.HUNCH_LEAN_GROUNDING;
    else process.env.HUNCH_LEAN_GROUNDING = prior;
  }
}

test("lean-grounding: the flag is read at call time", () => {
  const prior = process.env.HUNCH_LEAN_GROUNDING;
  try {
    process.env.HUNCH_LEAN_GROUNDING = "1";
    assert.equal(leanGroundingEnabled(), true);
    assert.equal(mcpInstructions(), MCP_INSTRUCTIONS_LEAN);
    delete process.env.HUNCH_LEAN_GROUNDING;
    assert.equal(leanGroundingEnabled(), true, "lean is the default");
    assert.equal(mcpInstructions(), MCP_INSTRUCTIONS_LEAN);
    process.env.HUNCH_LEAN_GROUNDING = "0";
    assert.equal(leanGroundingEnabled(), false);
    assert.equal(mcpInstructions(), MCP_INSTRUCTIONS);
  } finally {
    if (prior === undefined) delete process.env.HUNCH_LEAN_GROUNDING;
    else process.env.HUNCH_LEAN_GROUNDING = prior;
  }
});

test("lean-grounding: the block keeps counts and invariants, drops the per-moment tool list, and is full under flag 0", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("constraints", mkConstraint({ id: "con_lean00001", statement: "Keep module a free of side effects", scope: ["src/a.ts"], severity: "blocking" }));
  const full = withLean(false, () => renderHunchSection(store, root));
  const lean = withLean(true, () => renderHunchSection(store, root));
  assert.match(full, /\*\*Start:\*\*/);
  assert.doesNotMatch(lean, /\*\*Start:\*\*|\*\*Record:\*\*|hunch_policy_/);
  assert.ok(lean.length < full.length / 2, `lean ${lean.length} vs full ${full.length}`);
  // Same counts and template: grounding-lag checks read the lean block like the full one.
  assert.deepEqual(parseGroundingCounts(lean)?.counts, parseGroundingCounts(full)?.counts);
  assert.equal(groundingTemplate(lean), groundingTemplate(full));
  assert.match(lean, /### ⛔ Top invariants \(do not break\)\n- \*\*\[blocking\]\*\* Keep module a free of side effects _\(scope: src\/a\.ts; con_lean00001\)_/);
  assert.match(lean, /^<!-- HUNCH:START/);
  assert.match(lean, /<!-- HUNCH:END -->$/);
});

test("lean-grounding: the compact MCP instructions keep the task contract", async (t) => {
  const lean = MCP_INSTRUCTIONS_LEAN;
  assert.ok(lean.length < MCP_INSTRUCTIONS.length * 0.75, `lean ${lean.length} vs full ${MCP_INSTRUCTIONS.length}`);
  for (const tool of ["hunch_task", "hunch_context", "hunch_check_constraints", "hunch_why", "hunch_bug_lineage", "hunch_record_correction", "hunch_record_decision"]) assert.ok(lean.includes(tool), tool);
  assert.match(lean, /its instruction said that host closes the task AND the task used no Hunch/);
  assert.match(lean, /A task you started with hunch_task is always finished by you/);
  assert.match(lean, /hunch_record_correction when a human corrects you/);
  assert.match(lean, /Record only what the human decides or corrects/);
  assert.doesNotMatch(lean, /claude code only|anthropic|skippable/i);

  const { root, cleanup } = tempStore();
  const prior = process.env.HUNCH_LEAN_GROUNDING;
  process.env.HUNCH_LEAN_GROUNDING = "1";
  const server = buildServer(root);
  if (prior === undefined) delete process.env.HUNCH_LEAN_GROUNDING;
  else process.env.HUNCH_LEAN_GROUNDING = prior;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lean-grounding-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanup(); });
  assert.equal(client.getInstructions(), MCP_INSTRUCTIONS_LEAN);
});

/** Run `fn` with HUNCH_LEAN_GROUNDING set to `value` (undefined = unset), restoring it after. */
function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.HUNCH_LEAN_GROUNDING;
  if (value === undefined) delete process.env.HUNCH_LEAN_GROUNDING;
  else process.env.HUNCH_LEAN_GROUNDING = value;
  try { return fn(); }
  finally {
    if (prior === undefined) delete process.env.HUNCH_LEAN_GROUNDING;
    else process.env.HUNCH_LEAN_GROUNDING = prior;
  }
}

test("lean-grounding: the lean block carries the variant stamp after the template marker, the full block none, plus one contract line", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const full = withFlag("0", () => renderHunchSection(store, root));
  const lean = withFlag("1", () => renderHunchSection(store, root));
  assert.doesNotMatch(full, /hunch:variant/);
  assert.match(lean, /<!-- hunch:template \d+ -->\n<!-- hunch:variant lean -->\n/);
  assert.equal(groundingVariant(lean), "lean");
  assert.equal(groundingVariant(full), "full");
  assert.match(lean, /hunch_context\(target, task_id\)/);
  assert.match(lean, /hunch_check_constraints/);
  assert.equal(lean.split("\n").filter((l) => l.startsWith("Per task:")).length, 1);
  assert.doesNotMatch(lean, /claude|cursor|codex|windsurf|copilot/i);
});

test("lean-grounding: with the flag unset a refresh keeps a lean block lean, byte-stable", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  withFlag("1", () => updateClaudeMd(root, store));
  const first = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.equal(groundingVariant(first), "lean");
  withFlag(undefined, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), first);
  withFlag(undefined, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), first);
  withFlag(undefined, () => { writeAgentsMd(root, store); });
  withFlag("1", () => { writeAgentsMd(root, store); });
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  withFlag(undefined, () => { writeAgentsMd(root, store); });
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), agents);
});

test("lean-grounding: flag 0 turns an existing lean block full and keeps it full; unset leaves it full; flag 1 migrates it", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  withFlag("1", () => updateClaudeMd(root, store));
  withFlag("0", () => updateClaudeMd(root, store));
  const full = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.equal(groundingVariant(full), "full");
  withFlag("0", () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), full);
  withFlag(undefined, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), full, "the default never migrates an existing block");
  withFlag("1", () => updateClaudeMd(root, store));
  const migrated = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.equal(groundingVariant(migrated), "lean");
  withFlag(undefined, () => updateClaudeMd(root, store));
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), migrated, "and keeps a migrated block lean");
});

test("lean-grounding: a lean block is fresh against a lean render with the flag unset", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  withFlag("1", () => updateClaudeMd(root, store));
  const doc = readFileSync(join(root, "CLAUDE.md"), "utf8");
  withFlag(undefined, () => {
    const committed = groundingBlockContent(doc)!;
    const rendered = renderHunchSectionAs(store, root, groundingVariant(committed));
    assert.equal(classifyGroundingBlock(committed, groundingBlockContent(rendered) ?? rendered.trim()).kind, "fresh");
    const fullRender = renderHunchSectionAs(store, root, "full");
    assert.notEqual(classifyGroundingBlock(committed, groundingBlockContent(fullRender) ?? fullRender.trim()).kind, "fresh");
  });
});

test("lean-grounding: the render with the flag unset is the lean variant; flag 0 is the explicit full variant with no stamp", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const unset = withFlag(undefined, () => renderHunchSection(store, root));
  assert.equal(unset, renderHunchSectionAs(store, root, "lean"));
  const full = withFlag("0", () => renderHunchSection(store, root));
  assert.equal(full, renderHunchSectionAs(store, root, "full"));
  assert.doesNotMatch(full, /hunch:variant/);
  assert.match(full, /Use the `hunch_\*` MCP tools by moment:/);
});

function groundingBlockContent(text: string): string | null {
  const i = text.indexOf("<!-- HUNCH:START — auto-generated, do not edit by hand -->");
  const j = text.indexOf("<!-- HUNCH:END -->");
  if (i === -1 || j === -1 || j < i) return null;
  return text.slice(i + "<!-- HUNCH:START — auto-generated, do not edit by hand -->".length, j).trim();
}
