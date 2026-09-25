import { cleanupDir } from "./fixtures.js";
/**
 * Tool results must stay within the budget as a whole, not only their text
 * (issue #371): hunch_context names a few omitted records and counts the rest,
 * and hunch_findings lists gists with a limit, full text by id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hunchPaths } from "../src/core/paths.js";
import { findingId } from "../src/core/ids.js";
import type { Finding } from "../src/core/types.js";
import { buildServer, compactOmissions, firstSentence } from "../src/mcp/server.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { prov } from "./helpers.js";

const LONG_TAIL = " This second sentence is detail the list view must not carry.".repeat(20);

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-result-budget-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "context.ts"), "export const context = true;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  for (let i = 0; i < 20; i++) {
    store.json.put("constraints", {
      id: `con_budget_${String(i).padStart(2, "0")}`,
      type: "architecture",
      statement: `Warning invariant number ${i} about the context module, worded long enough to cost real budget.`,
      scope: ["src/context.ts"],
      severity: "warning",
      enforcement: "advisory_v1",
      match: null,
      forbids: null,
      rationale: "Fixture for omission compaction.",
      source_decision: null,
      violations: [],
      status: "active",
      valid_from: "2026-08-15T00:00:00.000Z",
      valid_to: null,
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    });
  }
  for (let i = 0; i < 15; i++) {
    const title = `Finding number ${i}`;
    const finding: Finding = {
      id: findingId(title),
      title,
      observation: `Gap ${i} observed in the context module, long enough to stand as its own gist.${LONG_TAIL}`,
      evidence: ["measured"],
      method: null,
      severity: "medium",
      triage: "open",
      affected_files: ["src/context.ts", "src/a.ts", "src/b.ts", "src/c.ts"],
      affected_symbols: [],
      violates_constraint: null,
      spawned_decision: null,
      observed_at: "2026-09-20T00:00:00.000Z",
      resolved_commit: null,
      provenance: prov(),
    };
    store.json.put("findings", finding);
  }
  store.reindex();
  store.close();
  return root;
}

async function connect(t: { after: (fn: () => Promise<void>) => void }, root: string) {
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "result-budget-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); cleanupDir(root); });
  return (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
}

const textOf = (result: { content: unknown }): string =>
  (result.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");

test("hunch_context names at most a few omitted records and counts every one by reason", async (t) => {
  const call = await connect(t, fixture());
  const result = await call("hunch_context", { target: "src/context.ts", budget_tokens: 120 });
  assert.ok(!result.isError, textOf(result));
  const structured = result.structuredContent as {
    omitted: Array<{ record_id: string; reason: string }>;
    omitted_total: number;
    omitted_by_reason: Record<string, number>;
  };
  assert.ok(structured.omitted_total > 5, `fixture must overflow the sample (got ${structured.omitted_total})`);
  assert.equal(structured.omitted.length, 5);
  assert.equal(
    Object.values(structured.omitted_by_reason).reduce((sum, n) => sum + n, 0),
    structured.omitted_total,
    "the reason counts account for every omission",
  );
  assert.ok(structured.omitted_by_reason.budget > 0);
  assert.equal(structured.omitted[0]?.reason, "budget", "budget omissions (drillable via hunch_why) are sampled first");
  assert.equal((structured as { omitted_truncated?: boolean }).omitted_truncated, true);
});

test("the omission sample keeps an id for every reason, budget first, and passes a short list through whole", () => {
  const item = (reason: string, n: number) => ({ kind: "decisions", record_id: `dec_${reason}_${n}`, reason, detail: "d" });
  const base = { omitted: [
    ...[1, 2, 3, 4, 5, 6].map((n) => item("budget", n)),
    item("stale-provenance", 1), item("stale-provenance", 2), item("retired", 1),
  ] } as unknown as Parameters<typeof compactOmissions>[0];
  const compact = compactOmissions(base);
  assert.deepEqual(compact.omitted.map((o) => o.record_id), ["dec_budget_1", "dec_retired_1", "dec_stale-provenance_1", "dec_budget_2", "dec_stale-provenance_2"]);
  assert.deepEqual(compact.omitted_by_reason, { budget: 6, "stale-provenance": 2, retired: 1 });
  assert.equal(compact.omitted_total, 9);
  assert.equal(compact.omitted_truncated, true);

  const short = compactOmissions({ omitted: [item("retired", 1), item("budget", 1)] } as unknown as Parameters<typeof compactOmissions>[0]);
  assert.equal(short.omitted.length, 2);
  assert.equal(short.omitted_truncated, false);
});

test("a finding's gist reads past datelines, abbreviations and list numbers", () => {
  assert.equal(firstSentence("Observed 2026-09-14. The outbox retries permanent refusals forever, so the queue never drains. More."),
    "Observed 2026-09-14. The outbox retries permanent refusals forever, so the queue never drains.");
  assert.match(firstSentence("Some checks are unnecessary, i.e. they re-run the same command with identical input every time. Tail."), /identical input every time\.$/);
  assert.match(firstSentence("1. outbox retries refusals and never gives up on a permanently rejected write request. 2. other"), /^1\. outbox .*request\.$/);
  assert.equal(firstSentence("short"), "short");
  assert.equal(firstSentence(""), "");
  assert.ok(firstSentence("x".repeat(500)).length <= 200);
});

test("hunch_findings lists first sentences under a limit and returns one finding in full by id", async (t) => {
  const call = await connect(t, fixture());
  const listed = textOf(await call("hunch_findings", {}));
  assert.match(listed, /^15 finding\(s\)/);
  assert.equal((listed.match(/^• /gm) ?? []).length, 12, "default cap");
  assert.doesNotMatch(listed, /second sentence/, "list view carries only the first sentence");
  assert.match(listed, /\(\+1\)/, "long concern lists are shortened");
  assert.match(listed, /\+3 more/);

  const limited = textOf(await call("hunch_findings", { limit: 2 }));
  assert.equal((limited.match(/^• /gm) ?? []).length, 2);
  assert.match(limited, /\+13 more/);

  const one = textOf(await call("hunch_findings", { id: findingId("Finding number 3") }));
  assert.match(one, /second sentence/, "id lookup returns the full observation");
  assert.match(one, /src\/c\.ts/);
  assert.match(textOf(await call("hunch_findings", { id: "fnd_missing" })), /No finding "fnd_missing"/);
});
