import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { analyzeDiff } from "../src/extractors/diff.js";
import { isVetoBlocker } from "../src/core/strictgate.js";
import { verdict, reportFailsStrict, renderText, renderMarkdown } from "../src/core/checkreport.js";
import type { Decision, RejectedTripwire } from "../src/core/types.js";

function mkDecision(over: Partial<Decision> & { id: string }): Decision {
  return {
    title: "Read-only visualization layer", status: "accepted", context: "",
    decision: "read directly from committed JSON, no backend dependency", consequences: [],
    alternatives_rejected: [], rejected_tripwires: [], related_components: [],
    related_files: ["vscode-extension/src/extension.ts"], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function tw(over: Partial<RejectedTripwire> = {}): RejectedTripwire {
  return {
    alternative: "extension queries MCP/API server for data",
    scope: ["vscode-extension/**"],
    forbids: { deps: ["axios"], symbols: [], patterns: [] },
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] },
    ...over,
  };
}

// A minimal unified diff that ADDS the given lines to one file.
function diffAdding(file: string, ...added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1 +1,${added.length + 1} @@`,
    ...added.map((l) => `+${l}`),
    " const unchanged = 1;",
  ].join("\n");
}

const EXT = "vscode-extension/src/extension.ts";

test("vetoHits: dep tier blocks when the tripwire is human-confirmed and in scope (the axios demo)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: [tw()] }));
    const hits = store.vetoHits(analyzeDiff(diffAdding(EXT, 'import axios from "axios";')), [EXT]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.tier, "dep");
    assert.equal(hits[0]!.decision, "dec_ext");
    assert.equal(hits[0]!.blocks, true, "confirmed tripwire → fails the commit");
    assert.match(hits[0]!.alternative, /MCP\/API server/);
    assert.equal(hits[0]!.chosen, "read directly from committed JSON, no backend dependency");
  } finally {
    cleanup();
  }
});

test("vetoHits: an llm_draft tripwire WARNS but never blocks, even at high confidence (progressive enforcement)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_ext",
      rejected_tripwires: [tw({ provenance: { source: "llm_draft", confidence: 0.99, evidence: [] } })],
    }));
    const hits = store.vetoHits(analyzeDiff(diffAdding(EXT, 'import axios from "axios";')), [EXT]);
    assert.equal(hits.length, 1, "still surfaces as advisory");
    assert.equal(hits[0]!.blocks, false, "unconfirmed tripwire is advisory regardless of confidence");
  } finally {
    cleanup();
  }
});

test("auto-trust model: an accepted decision with an llm_draft source (auto-captured memory) grounds but NEVER blocks", () => {
  const { store, cleanup } = tempStore();
  try {
    // Exactly what synthesis now writes under the auto-trust model: status `accepted`
    // (in-force advisory memory, so it grounds + ranks) but source `llm_draft` — it
    // must NEVER arm a hard block. Enforcement keys on the human vouch, not status.
    store.json.put("decisions", mkDecision({
      id: "dec_auto", status: "accepted",
      provenance: { source: "llm_draft", confidence: 0.78, evidence: [] },
      rejected_tripwires: [tw({ provenance: { source: "llm_draft", confidence: 0.78, evidence: [] } })],
    }));
    const hits = store.vetoHits(analyzeDiff(diffAdding(EXT, 'import axios from "axios";')), [EXT]);
    assert.equal(hits.length, 1, "still surfaces as advisory memory");
    assert.equal(hits[0]!.blocks, false, "auto-trusted (llm_draft) memory never blocks — dec_a466655539 intact");
  } finally {
    cleanup();
  }
});

test("vetoHits: out-of-scope edit does not match (glob scope gate)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: [tw()] }));
    const hits = store.vetoHits(analyzeDiff(diffAdding("src/server/api.ts", 'import axios from "axios";')), ["src/server/api.ts"]);
    assert.equal(hits.length, 0, "scope vscode-extension/** does not cover src/server/**");
  } finally {
    cleanup();
  }
});

test("vetoHits: dep added in an OUT-OF-SCOPE file does not fire via an unrelated in-scope edit", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: [tw()] }));
    // axios is added in src/server.ts (out of scope); the in-scope extension file is
    // also touched but adds NO axios. A global-dep gate would false-positive here.
    const diff = [
      "diff --git a/src/server.ts b/src/server.ts",
      "--- a/src/server.ts",
      "+++ b/src/server.ts",
      "@@ -0,0 +1 @@",
      '+import axios from "axios";',
      `diff --git a/${EXT} b/${EXT}`,
      `--- a/${EXT}`,
      `+++ b/${EXT}`,
      "@@ -0,0 +1 @@",
      "+const label = 1;",
    ].join("\n");
    const hits = store.vetoHits(analyzeDiff(diff), ["src/server.ts", EXT]);
    assert.equal(hits.length, 0, "dep must be imported within the tripwire's scope to fire");
  } finally {
    cleanup();
  }
});

test("vetoHits: a string literal naming the dep (not an import) does not trip the dep tier", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: [tw()] }));
    // axios is genuinely imported out of scope (so addedDeps has it), and the in-scope
    // file merely mentions "axios" in a string — must NOT be read as re-importing it.
    const diff = [
      "diff --git a/src/server.ts b/src/server.ts",
      "--- a/src/server.ts",
      "+++ b/src/server.ts",
      "@@ -0,0 +1 @@",
      '+import axios from "axios";',
      `diff --git a/${EXT} b/${EXT}`,
      `--- a/${EXT}`,
      `+++ b/${EXT}`,
      "@@ -0,0 +1 @@",
      '+const provider = "axios";',
    ].join("\n");
    const hits = store.vetoHits(analyzeDiff(diff), ["src/server.ts", EXT]);
    assert.equal(hits.length, 0, "dep tier needs an actual import in scope, not a string literal");
  } finally {
    cleanup();
  }
});

test("vetoHits: a superseded decision's tripwire is ignored (not the current design)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_old", status: "superseded", superseded_by: "dec_new", rejected_tripwires: [tw()],
    }));
    const hits = store.vetoHits(analyzeDiff(diffAdding(EXT, 'import axios from "axios";')), [EXT]);
    assert.equal(hits.length, 0);
  } finally {
    cleanup();
  }
});

test("vetoHits: symbol tier matches a whole-word identifier, not a substring (prefetch ≠ fetch)", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_sym", related_files: ["src/data.ts"],
      rejected_tripwires: [tw({ scope: ["src/**"], forbids: { deps: [], symbols: ["fetch"], patterns: [] } })],
    }));
    const hit = store.vetoHits(analyzeDiff(diffAdding("src/data.ts", "const d = await fetch(url);")), ["src/data.ts"]);
    assert.equal(hit.length, 1);
    assert.equal(hit[0]!.tier, "symbol");
    assert.equal(hit[0]!.blocks, true);

    const noHit = store.vetoHits(analyzeDiff(diffAdding("src/data.ts", "const d = await prefetch(url);")), ["src/data.ts"]);
    assert.equal(noHit.length, 0, "prefetch must not trip the `fetch` tripwire");
  } finally {
    cleanup();
  }
});

test("vetoHits: pattern tier blocks only when the tripwire is human-confirmed", () => {
  const { store, cleanup } = tempStore();
  try {
    const forbids = { deps: [], symbols: [], patterns: ["/api/"] };
    store.json.put("decisions", mkDecision({
      id: "dec_pat_h", related_files: ["src/data.ts"],
      rejected_tripwires: [tw({ scope: ["src/**"], forbids })],
    }));
    const human = store.vetoHits(analyzeDiff(diffAdding("src/data.ts", 'const u = "/api/memory";')), ["src/data.ts"]);
    assert.equal(human[0]!.tier, "pattern");
    assert.equal(human[0]!.blocks, true);

    store.json.put("decisions", mkDecision({
      id: "dec_pat_d", related_files: ["src/data.ts"],
      rejected_tripwires: [tw({ scope: ["src/**"], forbids, provenance: { source: "llm_draft", confidence: 0.99, evidence: [] } })],
    }));
    const drafted = store.vetoHits(analyzeDiff(diffAdding("src/data.ts", 'const u = "/api/memory";')), ["src/data.ts"]);
    assert.ok(drafted.some((h) => h.decision === "dec_pat_d" && h.blocks === false), "drafted pattern is advisory");
  } finally {
    cleanup();
  }
});

test("vetoHits: a stale decision never blocks, even with a confirmed tripwire", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({ id: "dec_ext", rejected_tripwires: [tw()] }));
    const hits = store.vetoHits(analyzeDiff(diffAdding(EXT, 'import axios from "axios";')), [EXT], new Set(["dec_ext"]));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.blocks, false, "freshness gate downgrades a stale decision to advisory");
  } finally {
    cleanup();
  }
});

test("buildCheckReport surfaces a confirmed veto end-to-end → BLOCK verdict + rendered receipt", () => {
  const { store, cleanup } = tempStore();
  try {
    store.json.put("decisions", mkDecision({
      id: "dec_49916d02c9", title: "Read-only visualization layer over committed .hunch/ JSON",
      rejected_tripwires: [tw()],
    }));
    const diff = diffAdding(EXT, 'import axios from "axios";', "const data = await axios.get('/api/memory');");
    const report = store.buildCheckReport([EXT], diff, { strict: true });

    assert.equal(report.vetoes.length, 1);
    assert.equal(report.vetoBlocking, 1);
    assert.equal(verdict(report), "block");
    assert.equal(reportFailsStrict(report), true);

    const txt = renderText(report);
    assert.match(txt, /you rejected:/);
    assert.match(txt, /dec_49916d02c9/);
    const md = renderMarkdown(report);
    assert.match(md, /Reverses a decision you rejected/);
  } finally {
    cleanup();
  }
});

test("isVetoBlocker: confirmed blocks every non-semantic tier; draft never does; semantic never does", () => {
  const inForce = { status: "accepted", superseded_by: null };
  const human = { provenance: { source: "human_confirmed" } };
  const draft = { provenance: { source: "llm_draft" } };
  const composite = { provenance: { source: "llm_draft+human_confirmed" } };

  for (const tier of ["dep", "symbol", "pattern"] as const) {
    assert.equal(isVetoBlocker(inForce, human, tier, false), true, `${tier} + confirmed → blocks`);
    assert.equal(isVetoBlocker(inForce, draft, tier, false), false, `${tier} + draft → advisory`);
    assert.equal(isVetoBlocker(inForce, composite, tier, false), true, `${tier} + composite source → blocks (.includes)`);
    assert.equal(isVetoBlocker(inForce, human, tier, true), false, `${tier} + stale → advisory`);
  }
  assert.equal(isVetoBlocker(inForce, human, "semantic", false), false, "semantic never blocks");
  assert.equal(isVetoBlocker({ status: "superseded", superseded_by: "dec_x" }, human, "dep", false), false, "superseded never blocks");

  // token-aware: a lookalike source must NOT pass the human gate
  const lookalike = { provenance: { source: "not_human_confirmed" } };
  assert.equal(isVetoBlocker(inForce, lookalike, "dep", false), false, "lookalike source is not human-confirmed");
});
