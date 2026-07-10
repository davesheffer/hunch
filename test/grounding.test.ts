import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { renderHunchSection } from "../src/integrations/claudemd.js";

// The grounding documents each MCP tool's call signature. If a documented param name
// drifts from the tool's actual inputSchema key, an agent copies the wrong key and the
// call fails Zod validation ("expected string, received undefined"). Lock the signatures
// to the real param names in src/mcp/server.ts.
test("grounding tool signatures match the real MCP param names (no agent-misleading drift)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const md = renderHunchSection(store);

  assert.match(md, /hunch_query\(query\)/, "hunch_query param is `query`, not `question`");
  assert.match(md, /hunch_bug_lineage\(symptom_or_symbol\)/, "hunch_bug_lineage param is `symptom_or_symbol`");
  assert.match(md, /hunch_runbook\(task\)/, "hunch_runbook is advertised so agents can discover it");
  assert.match(md, /hunch_compare\(candidates\)/, "hunch_compare is advertised");
  assert.match(md, /hunch_conformance\(\)/, "hunch_conformance is advertised");
  assert.match(md, /hunch_policy_plan\(policy_id\)/, "the canonical ProofPlan is discoverable before proof review");
  assert.match(md, /hunch_policy_card\(policy_id\)/, "the deterministic proof-card review surface is discoverable across clients");
  assert.match(md, /raw replay receipts; only an explicit human activation grants authority/, "grounding separates proof evidence from authority");
  assert.match(md, /hunch_why\(target\)/);
  assert.match(md, /hunch_check_constraints\(scope\)/);
  assert.match(md, /hunch_get_dependents\(symbol\)/);

  // the old, wrong signatures must not reappear
  assert.doesNotMatch(md, /hunch_query\(question\)/);
  assert.doesNotMatch(md, /hunch_bug_lineage\(symptom\)/);
});
