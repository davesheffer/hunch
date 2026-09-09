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
  chain: { incidents: number; escalations_seen_by_engineer: number; decisions: number; shipped: number; closed: number; closures_seen_by_sofias: number; links_verified_by_orc: number; denied_to_orc: number; closure_causes: number };
  ledger: { head_seq: number; contiguous: boolean };
  replay: { partitions: number; ok: boolean; verified: number; divergences: string[] };
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
    // The chain (roadmap Gate 4), counted like everything else: every incident a sofia raised was
    // read by the engineer, decided in the repository partition, shipped with a receipt resting on
    // the decision + proof + escalation, closed BY that receipt, seen closed by every sofia,
    // verified link by link by the orc, and replayed from the ledger with the receipt as cause.
    const c = report.chain;
    assert.ok(c.incidents >= 1, "at least one incident was raised");
    assert.equal(c.escalations_seen_by_engineer, c.incidents, "the engineer found every escalation in force before acting");
    assert.equal(c.decisions, c.incidents);
    assert.equal(c.shipped, c.incidents);
    assert.equal(c.closed, c.incidents, "every escalation was closed in place by its receipt");
    assert.equal(c.closures_seen_by_sofias, c.incidents * 3, "every sofia saw every closure");
    assert.equal(c.links_verified_by_orc, c.incidents, "the orc verified decision, proof, escalation, closed_by and the receipt for every incident");
    assert.equal(c.closure_causes, c.incidents, "every closure event is caused by its receipt");
    assert.equal(c.denied_to_orc, 1, "the orc was refused the repository partition — named, never described");
    assert.ok((report.refusals["conflict"] ?? 0) >= 2, "a stale rests_on hash and a phantom closed_by were refused");
    assert.ok(report.replay.partitions >= 5, "every served partition (org, 3 sofias, the app repository) was replayed");
    assert.equal(report.replay.ok, true, `every partition's records are exactly what its ledger implies: ${report.replay.divergences.join(", ")}`);
    assert.ok(report.replay.verified > 0);
    assert.ok(existsSync(report.out), "farm-report.json was written");
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
