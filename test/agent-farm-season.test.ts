/**
 * The season (tooling/agent-farm/season.mjs): ten principals of different styles over one
 * organization drawer for a run of simulated days, driven by a conductor. A short season must end
 * with an empty problem list, every expected refusal observed at least once, the chain closed for
 * every incident, replay OK on every partition, and the crowding metric reported (a writer that
 * omits `supersedes` leaves several current summaries on a subject — measured, not hidden).
 * Imports from dist/, so it skips when dist/ is not built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SeasonReport {
  writes: { created: number; updated: number; replayed: number; superseded: number };
  refusals: { expected: Record<string, number>; unexpected: Record<string, number> };
  unexpected_successes: number;
  chain: { incidents: number; escalations_seen_by_engineer: number; decisions: number; shipped: number; closed: number; closures_seen: number; links_verified: number; phantom_refused: number; stale_rests_on_refused: number };
  crowding: { beside_human_confirmed: number; forged_downgraded: number; max_current_per_subject: number; subjects_with_many_current: number };
  captures: { saved: number; replayed: number; refused: number };
  replay: { partitions: number; ok: boolean; verified: number; divergences: string[] };
  audits: Array<{ day: string; kind: string }>;
  problems: string[];
  durations_ms: { total: number };
}

const distReady = existsSync(join(process.cwd(), "dist", "serve", "app.js"));

test("season: 21 simulated days, 10 principals, zero problems, every expected refusal observed, replay OK", { skip: distReady ? false : "dist/serve/app.js is missing — run `npm run build` first" }, async () => {
  const { runSeason } = (await import("../tooling/agent-farm/season.mjs")) as { runSeason: (opts: { days: number; customers: number; outDir: string; seed: string }) => Promise<SeasonReport> };
  const outDir = mkdtempSync(join(tmpdir(), "hunch-season-test-"));
  try {
    const report = await runSeason({ days: 21, customers: 6, outDir, seed: "season-test" });
    assert.deepEqual(report.problems, [], "the conductor, the orc and the replay found nothing to report");
    assert.equal(report.unexpected_successes, 0);
    assert.deepEqual(report.refusals.unexpected, {});
    for (const code of ["idempotency", "identity", "outside-grants", "conflict"]) assert.ok((report.refusals.expected[code] ?? 0) >= 1, `expected refusal ${code} observed`);
    assert.ok(report.chain.incidents >= 3, "incidents were raised");
    assert.equal(report.chain.escalations_seen_by_engineer, report.chain.incidents, "the engineer found every escalation in force");
    assert.equal(report.chain.closed, report.chain.incidents, "every escalation was closed by its receipt");
    assert.equal(report.chain.links_verified, report.chain.closed, "the orc verified every closure link by link");
    assert.equal(report.chain.phantom_refused, report.chain.incidents, "every phantom closure was refused");
    assert.ok(report.chain.stale_rests_on_refused >= report.chain.incidents, "every stale rests_on was refused");
    assert.ok(report.captures.saved > 0 && report.captures.replayed > 0 && report.captures.refused === 0, "observations were captured and replayed, none refused");
    assert.ok(report.crowding.forged_downgraded >= 1, "an agent's forged human_confirmed provenance was downgraded on disk");
    assert.ok(report.crowding.max_current_per_subject >= 1, "the crowding metric is reported");
    assert.equal(report.replay.ok, true, "every partition replays hash for hash");
    assert.ok(report.audits.some((a) => a.kind === "weekly"), "weekly audits ran");
    assert.ok(report.durations_ms.total < 180_000, `the season took ${report.durations_ms.total} ms`);
  } finally { rmSync(outDir, { recursive: true, force: true }); }
});
