/**
 * Delivery receipts (dec_925f4bcaad): the machine-local served ledger.
 * Observed telemetry, own database under .hunch-cache/ — never the reindexed
 * store — and never throwing: a lost receipt must never cost a delivery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordServed, servedSummary } from "../src/core/served.js";

test("served ledger: receipts accrue, aggregate per record, and split serve from refresh", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-served-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  recordServed(root, [
    { event: "served", kind: "constraints", record_id: "con_a", target: "src/a.ts", session_id: "s1", rank: 1, delivery_reason: "blocking-reserved", provenance_status: "current", token_cost: 42 },
    { event: "served", kind: "decisions", record_id: "dec_b", target: "src/a.ts", session_id: "s1", rank: 2, delivery_reason: "ranked", provenance_status: "unverified", token_cost: 35 },
  ]);
  recordServed(root, [
    { event: "refreshed", kind: "constraints", record_id: "con_a", target: "src/a.ts", session_id: "s2", rank: 1, delivery_reason: "blocking-reserved", provenance_status: "current", token_cost: 42 },
  ]);

  const summary = servedSummary(root);
  assert.equal(summary.total, 3);
  assert.equal(summary.distinct_records, 2);
  assert.equal(summary.distinct_sessions, 2);
  const conA = summary.rows.find((r) => r.record_id === "con_a");
  assert.deepEqual([conA?.serves, conA?.refreshes], [1, 1], "serve and refresh counted separately");
  assert.deepEqual([conA?.best_rank, conA?.average_token_cost], [1, 42]);
  assert.equal(summary.rows[0]?.record_id, "con_a", "ordered by serves+refreshes");
  assert.deepEqual(summary.recent[0], {
    at: summary.recent[0]?.at,
    session_id: "s2",
    event: "refreshed",
    kind: "constraints",
    record_id: "con_a",
    target: "src/a.ts",
    rank: 1,
    delivery_reason: "blocking-reserved",
    provenance_status: "current",
    token_cost: 42,
  });
});

test("served ledger: empty input is a no-op and an unwritable root reads as empty, never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-served-empty-"));
  recordServed(root, []);
  assert.equal(servedSummary(root).total, 0);
  rmSync(root, { recursive: true, force: true });

  // A root that cannot exist: recording and reading must both swallow, not throw.
  const impossible = join(root, "gone", "\0bad");
  recordServed(impossible, [{ event: "served", kind: "decisions", record_id: "dec_x", target: "src/x.ts" }]);
  assert.equal(servedSummary(impossible).total, 0, "unreadable ledger reads as empty");
});

test("served ledger: an old receipt database gains metadata columns additively", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-served-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, ".hunch-cache");
  mkdirSync(cache, { recursive: true });
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(cache, "served.db"));
  db.exec(`CREATE TABLE served (
    at TEXT NOT NULL,
    session TEXT,
    event TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    target TEXT NOT NULL
  )`);
  db.close();

  recordServed(root, [{
    event: "served",
    kind: "decisions",
    record_id: "dec_legacy",
    target: "src/legacy.ts",
    rank: 3,
    delivery_reason: "ranked",
    provenance_status: "unverified",
    token_cost: 19,
  }]);

  const summary = servedSummary(root);
  assert.equal(summary.total, 1);
  assert.deepEqual(
    [summary.recent[0]?.rank, summary.recent[0]?.delivery_reason, summary.recent[0]?.provenance_status, summary.recent[0]?.token_cost],
    [3, "ranked", "unverified", 19],
  );
});
