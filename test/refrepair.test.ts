import assert from "node:assert/strict";
import test from "node:test";
import { repairDecisionReference } from "../src/core/refrepair.js";
import type { Decision } from "../src/core/types.js";

function decision(): Decision {
  return {
    id: "dec_ref_repair",
    title: "Keep the runbook private",
    topic: null,
    status: "accepted",
    context: "",
    decision: "Use a private runbook.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [".hunch-private/docs/runbooks.md", "src/cli/index.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: {
      source: "human_confirmed",
      confidence: 1,
      evidence: [".hunch-private/docs/runbooks.md", "docs/runbooks.md"],
      last_verified: "2026-01-01T00:00:00.000Z",
    },
    date: "2026-01-01T00:00:00.000Z",
  };
}

test("repairDecisionReference updates exact scope and provenance references together", () => {
  const result = repairDecisionReference(decision(), ".hunch-private/docs/runbooks.md", "docs/runbooks.md");
  assert.ok(result);
  assert.equal(result.relatedFiles, 1);
  assert.equal(result.evidence, 1);
  assert.deepEqual(result.decision.related_files, ["docs/runbooks.md", "src/cli/index.ts"]);
  assert.deepEqual(result.decision.provenance.evidence, ["docs/runbooks.md"]);
  assert.equal(result.decision.provenance.last_verified, "2026-01-01T00:00:00.000Z");
});

test("repairDecisionReference refuses a partial or absent match", () => {
  assert.equal(repairDecisionReference(decision(), ".hunch-private/docs", "docs"), null);
});
