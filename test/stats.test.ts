import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPathsForDir } from "../src/core/paths.js";
import { appendEvent, readEvents, type HunchEvent } from "../src/core/events.js";
import { computeStats, type StatsInput } from "../src/core/stats.js";
import type { Bug, Constraint, Decision } from "../src/core/types.js";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "hunch-stats-"));
  mkdirSync(join(dir, ".hunch"), { recursive: true });
  return { paths: hunchPathsForDir(join(dir, ".hunch")), dir };
}

test("catch-log round-trips and skips corrupt lines", () => {
  const { paths, dir } = tmpPaths();
  try {
    assert.deepEqual(readEvents(paths), []); // missing log → []
    appendEvent(paths, { at: "2026-07-09T00:00:00Z", kind: "constraint", file: "a.ts", constraint: "con_1" });
    appendEvent(paths, { at: "2026-07-09T01:00:00Z", kind: "veto", file: "b.ts", decision: "dec_1" });
    const got = readEvents(paths);
    assert.equal(got.length, 2);
    assert.equal(got[0]?.kind, "constraint");
    assert.equal(got[1]?.decision, "dec_1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal record fixtures — only the fields computeStats reads. */
const prov = { source: "human_confirmed", confidence: 1, created_at: "", last_verified: "" } as Decision["provenance"];
function dec(over: Partial<Decision>): Decision {
  return { id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "", consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov, date: "", ...over } as Decision;
}
function bug(over: Partial<Bug>): Bug {
  return { id: "bug_x", title: "t", symptom: "", root_cause: "", severity: "medium", status: "open", affected_files: [], affected_symbols: [], lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null }, provenance: prov, ...over } as Bug;
}
function con(over: Partial<Constraint>): Constraint {
  return { id: "con_x", type: "architecture", statement: "s", scope: [], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_to: null, provenance: prov, ...over } as Constraint;
}

const base = (over: Partial<StatsInput>): StatsInput => ({
  decisions: [], constraints: [], bugs: [], componentIds: [], runbooksCount: 0, events: [],
  staleConstraints: 0, now: Date.parse("2026-07-09T12:00:00Z"), windowStart: Date.parse("2026-07-02T12:00:00Z"), windowLabel: "7d", ...over,
});

test("honest zeros: no events → 0 caught, payback 0, but stock still counts", () => {
  const s = computeStats(base({ decisions: [dec({}), dec({ id: "dec_y", status: "proposed" })], constraints: [con({})] }));
  assert.equal(s.return.lifetime.violations_caught, 0);
  assert.equal(s.return.lifetime.bugs_reprevented, 0);
  assert.equal(s.compounding.payback_ratio, 0);
  assert.equal(s.stock.decisions.total, 2);
  assert.equal(s.stock.decisions.proposed, 1);
  assert.equal(s.stock.invariants.locked, 1); // active+blocking+human_confirmed
});

test("bugs_reprevented counts ONLY a regressed-linked block", () => {
  const events: HunchEvent[] = [{ at: "2026-07-09T00:00:00Z", kind: "veto", file: "a.ts", decision: "dec_r" }];
  const regressed = computeStats(base({
    events,
    decisions: [dec({ id: "dec_r", caused_by_bug: "bug_r" })],
    bugs: [bug({ id: "bug_r", status: "regressed" })],
  }));
  assert.equal(regressed.return.lifetime.bugs_reprevented, 1);
  assert.equal(regressed.return.lifetime.violations_caught, 1);

  // same event, but the bug is only 'fixed' (never came back) → not re-prevented
  const notYet = computeStats(base({
    events,
    decisions: [dec({ id: "dec_r", caused_by_bug: "bug_r" })],
    bugs: [bug({ id: "bug_r", status: "fixed" })],
  }));
  assert.equal(notYet.return.lifetime.bugs_reprevented, 0);
  assert.equal(notYet.return.lifetime.violations_caught, 1); // still a real catch
});

test("coverage = distinct existing components named by a decision ÷ total", () => {
  const s = computeStats(base({
    decisions: [dec({ related_components: ["cmp_a", "cmp_a", "cmp_ghost"] })], // dup + dangling
    componentIds: ["cmp_a", "cmp_b"],
  }));
  assert.equal(s.stock.coverage.components_with_decision, 1); // cmp_a only (cmp_ghost doesn't exist)
  assert.equal(s.stock.coverage.pct, 0.5);
});

test("window bounds the recent return; lifetime does not", () => {
  const events: HunchEvent[] = [
    { at: "2026-06-01T00:00:00Z", kind: "constraint", file: "old.ts", constraint: "con_1" }, // before window
    { at: "2026-07-08T00:00:00Z", kind: "constraint", file: "new.ts", constraint: "con_1" }, // in window
  ];
  const s = computeStats(base({ events }));
  assert.equal(s.return.window.violations_caught, 1);
  assert.equal(s.return.lifetime.violations_caught, 2);
});
