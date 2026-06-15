import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore } from "./helpers.js";
import { captureTestRun } from "../src/synthesis/synthesize.js";
import type { TestReport } from "../src/extractors/testreport.js";

// Force the deterministic provider so the loop needs no credentials/network.
process.env.HUNCH_SYNTH_PROVIDER = "deterministic";

const report = (o: Partial<TestReport>): TestReport => ({
  failures: [],
  passed: [],
  recognized: true,
  ...o,
});

test("captureTestRun captures a failing test as an open Bug", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    const cap = await captureTestRun(store, root, {
      report: report({ failures: [{ test: "auth rejects expired token", message: "auth rejects expired token\nAssertionError: expected 401" }] }),
      status: 1, cmd: "npm test", output: "",
    });
    assert.equal(cap.fallback, false);
    assert.equal(cap.results.length, 1);
    const bug = cap.results[0]!.bug;
    assert.equal(bug.status, "open");
    assert.match(bug.provenance.evidence.join(" "), /test:auth rejects expired token/);
    assert.ok(store.json.get("bugs", bug.id), "bug persisted to the store");
  } finally { cleanup(); }
});

test("captureTestRun resolves an open Bug when its test passes (loop closed)", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    const first = await captureTestRun(store, root, {
      report: report({ failures: [{ test: "T", message: "T\nboom" }] }), status: 1, cmd: "x", output: "",
    });
    const id = first.results[0]!.bug.id;
    const second = await captureTestRun(store, root, {
      report: report({ passed: ["T"] }), status: 0, cmd: "x", output: "",
    });
    assert.equal(second.fixed.length, 1);
    assert.equal(second.fixed[0]!.id, id);
    assert.equal(store.json.get("bugs", id)!.status, "fixed");
  } finally { cleanup(); }
});

test("captureTestRun falls back to one coarse Bug on unrecognized failing output", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    const cap = await captureTestRun(store, root, {
      report: report({ recognized: false }), status: 1, cmd: "make test", output: "Segmentation fault\ncore dumped",
    });
    assert.equal(cap.fallback, true);
    assert.equal(cap.results.length, 1);
    assert.match(cap.results[0]!.bug.provenance.evidence.join(" "), /test:make test/);
  } finally { cleanup(); }
});

test("captureTestRun does NOT fabricate bugs when unrecognized output exits 0", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    const cap = await captureTestRun(store, root, {
      report: report({ recognized: false }), status: 0, cmd: "x", output: "all good",
    });
    assert.equal(cap.results.length, 0);
    assert.equal(cap.fallback, false);
  } finally { cleanup(); }
});

test("captureTestRun promotes a Constraint when a failure recurs", async () => {
  const { store, root, cleanup } = tempStore();
  try {
    const symptom = "payment gateway times out under concurrent load";
    await captureTestRun(store, root, {
      report: report({ failures: [{ test: "checkout first", message: `checkout first\n${symptom}` }] }), status: 1, cmd: "x", output: "",
    });
    const cap = await captureTestRun(store, root, {
      report: report({ failures: [{ test: "checkout second", message: `checkout second\n${symptom}` }] }), status: 1, cmd: "x", output: "",
    });
    const r = cap.results[0]!;
    assert.ok(r.bug.lineage.recurrence_of, "second near-identical failure flagged as a recurrence");
    assert.ok(r.constraint, "a recurrence auto-promotes a regression Constraint");
    assert.equal(r.bug.lineage.spawned_constraint, r.constraint!.id);
  } finally { cleanup(); }
});
