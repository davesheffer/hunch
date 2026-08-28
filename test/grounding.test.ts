import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, mkConstraint } from "./helpers.js";
import { renderHunchSection } from "../src/integrations/claudemd.js";

// The grounding documents each MCP tool's call signature. If a documented param name
// drifts from the tool's actual inputSchema key, an agent copies the wrong key and the
// call fails Zod validation ("expected string, received undefined"). Lock the signatures
// to the real param names in src/mcp/server.ts.
test("grounding tool signatures match the real MCP param names (no agent-misleading drift)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const md = renderHunchSection(store);

  assert.match(md, /hunch_context\(target\)/, "hunch_context param is `target`, not `target_or_task`");
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
  assert.doesNotMatch(md, /hunch_context\(target_or_task\)/);
  assert.doesNotMatch(md, /hunch_query\(question\)/);
  assert.doesNotMatch(md, /hunch_bug_lineage\(symptom\)/);
});

// A retired constraint has an explicitly closed valid-time window — the invariant it
// describes is no longer true. Rendering it into "Top invariants (do not break)" tells
// every future agent to enforce a rule that's already been withdrawn.
test("renderHunchSection excludes retired constraints from Top invariants", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);

  store.json.put("constraints", mkConstraint({
    id: "con_retired0001", statement: "RETIRED_INVARIANT_MUST_NOT_APPEAR", severity: "blocking",
    status: "retired", valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-06-01T00:00:00.000Z",
  }));
  store.json.put("constraints", mkConstraint({
    id: "con_active0001", statement: "ACTIVE_INVARIANT_MUST_APPEAR", severity: "blocking",
  }));

  const md = renderHunchSection(store);
  assert.doesNotMatch(md, /RETIRED_INVARIANT_MUST_NOT_APPEAR/);
  assert.match(md, /ACTIVE_INVARIANT_MUST_APPEAR/);
});

// Retiring a constraint by hand-editing its JSON (the only path that exists today, per
// #21) can close valid_to without also flipping status — hunchStore.ts's own staleness
// check already treats either signal as dead (`status === "retired" || !!valid_to`); the
// render must agree, or a hand-retired constraint keeps appearing as "do not break".
test("renderHunchSection excludes a constraint whose valid_to is closed even if status wasn't flipped", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);

  store.json.put("constraints", mkConstraint({
    id: "con_closed0001", statement: "CLOSED_VALID_TO_MUST_NOT_APPEAR", severity: "blocking",
    status: "active", valid_to: "2026-06-01T00:00:00.000Z",
  }));

  const md = renderHunchSection(store);
  assert.doesNotMatch(md, /CLOSED_VALID_TO_MUST_NOT_APPEAR/);
});

// renderHunchSection caps "Top invariants" at 8 entries. Retired constraints sorting
// ahead of active ones (by severity) must not consume those slots and starve real,
// still-enforced invariants out of the rendered list entirely.
test("renderHunchSection doesn't let retired constraints starve active ones out of the top-8 slice", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);

  for (let i = 0; i < 8; i++) {
    store.json.put("constraints", mkConstraint({
      id: `con_retired000${i}`, statement: `RETIRED_${i}_MUST_NOT_APPEAR`, severity: "blocking", status: "retired",
      valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-06-01T00:00:00.000Z",
    }));
  }
  store.json.put("constraints", mkConstraint({
    id: "con_active0001", statement: "ACTIVE_MUST_SURVIVE_SLICE", severity: "advisory",
  }));

  const md = renderHunchSection(store);
  assert.match(md, /ACTIVE_MUST_SURVIVE_SLICE/);
});
