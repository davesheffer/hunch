/**
 * The agent farm (tooling/agent-farm) runs K concurrent agents against an in-process `hunch serve`
 * and must end the day with zero contradictions, a contiguous ledger, every deliberate refusal
 * observed, and at least one agent reusing another's current summary instead of recomputing it.
 * It imports from dist/, so the test skips (with a clear message) when dist/ is not built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FarmReport {
  writes: { created: number; updated: number; replayed: number; superseded: number };
  refusals: Record<string, number>;
  reads: number;
  reuse_rate: number;
  contradictions: number;
  ledger: { head_seq: number; contiguous: boolean };
  durations_ms: { total: number; per_agent_avg: number };
  problems: string[];
  out: string;
}

const distReady = existsSync(join(process.cwd(), "dist", "serve", "app.js"));

test("agent farm: 3 sofias x 4 customers end the day with zero contradictions and a contiguous ledger", { skip: distReady ? false : "dist/serve/app.js is missing — run `npm run build` first" }, async () => {
  const { runFarm } = (await import("../tooling/agent-farm/lib.mjs")) as { runFarm: (opts: { agents: number; customers: number; outDir: string }) => Promise<FarmReport> };
  const outDir = mkdtempSync(join(tmpdir(), "hunch-agent-farm-test-"));
  try {
    const started = Date.now();
    const report = await runFarm({ agents: 3, customers: 4, outDir });
    assert.ok(Date.now() - started < 60_000, `the day took ${Date.now() - started} ms`);
    assert.deepEqual(report.problems, [], "the orc and the engineer found nothing to report");
    assert.equal(report.contradictions, 0);
    assert.equal(report.ledger.contiguous, true);
    assert.ok(report.ledger.head_seq > 0);
    assert.ok((report.refusals["outside-grants"] ?? 0) >= 1, "a sofia was refused another sofia's drawer");
    assert.ok((report.refusals["idempotency"] ?? 0) >= 1, "a reused key with a changed payload was refused");
    assert.ok((report.refusals["identity"] ?? 0) >= 1, "a chosen id was refused");
    assert.ok(report.writes.created > 0);
    assert.ok(report.writes.replayed > 0, "the shared commitment replayed for the second writer");
    assert.ok(report.reuse_rate > 0, "at least one sofia reused another's current summary");
    assert.ok(existsSync(report.out), "farm-report.json was written");
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
