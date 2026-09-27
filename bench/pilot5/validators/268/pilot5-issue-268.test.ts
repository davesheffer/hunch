import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../src/core/taskReportEvidence.js";

// Issue #268: `hunch task verify` defaulted to a 120s timeout, so an agent
// running a real full suite through the wrapper without an explicit
// --timeout recorded a misleading "timed out / failed" check even when the
// suite would have passed. The fix raises the default well past 120s.
test("pilot5 #268: hunch task verify default check timeout is raised past the old 120s budget", () => {
  assert.ok(
    DEFAULT_CHECK_TIMEOUT_MS > 120_000,
    `expected DEFAULT_CHECK_TIMEOUT_MS to be raised above the old 120000ms budget that turned a passing full suite into a recorded failed check, got ${DEFAULT_CHECK_TIMEOUT_MS}`
  );
});
