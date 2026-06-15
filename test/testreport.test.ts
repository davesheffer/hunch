import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestReport } from "../src/extractors/testreport.js";

// A realistic node:test TAP fragment: one pass (with diagnostics), one fail
// (with a YAML error/stack block), one skip.
const TAP = `TAP version 13
# Subtest: adds two numbers
ok 1 - adds two numbers
  ---
  duration_ms: 1.2
  ...
# Subtest: divides correctly
not ok 2 - divides correctly
  ---
  duration_ms: 0.8
  failureType: 'testCodeFailure'
  error: 'Expected 5 to equal 4'
  code: 'ERR_ASSERTION'
  stack: |-
    at Test.<anonymous> (file:///x/test/math.test.ts:12:3)
  ...
ok 3 - pending feature # SKIP not built yet
1..3`;

test("parseTap splits passes from failures and captures the diagnostic block", () => {
  const r = parseTestReport(TAP);
  assert.equal(r.recognized, true);
  assert.deepEqual(r.passed, ["adds two numbers"]); // skip is neither pass nor fail
  assert.equal(r.failures.length, 1);
  const f = r.failures[0]!;
  assert.equal(f.test, "divides correctly");
  assert.match(f.message, /Expected 5 to equal 4/); // YAML error carried into message
  assert.match(f.message, /math\.test\.ts:12/); // stack carried too
});

test("parseTap tolerates the optional `- ` separator and bare names", () => {
  const r = parseTestReport("ok 1 passing\nnot ok 2 failing");
  assert.deepEqual(r.passed, ["passing"]);
  assert.equal(r.failures[0]!.test, "failing");
});

test("parseTap marks non-TAP output unrecognized (caller falls back, never silent-green)", () => {
  const r = parseTestReport("Error: build blew up\n  at foo (x.js:1:1)\nnpm ERR! exit 1");
  assert.equal(r.recognized, false);
  assert.equal(r.failures.length, 0);
  assert.equal(r.passed.length, 0);
});

test("parseTap does NOT capture sibling result lines into a failure's message", () => {
  const r = parseTestReport(`not ok 1 - first fail
  ---
  error: 'boom'
  ...
not ok 2 - second fail`);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures[0]!.message, /boom/);
  assert.doesNotMatch(r.failures[0]!.message, /second fail/); // block stopped at sibling
  assert.equal(r.failures[1]!.test, "second fail");
});

test("parseTap ignores SKIP/TODO directives for pass list", () => {
  const r = parseTestReport("ok 1 - real pass\nok 2 - later # TODO\nok 3 - skip me # SKIP");
  assert.deepEqual(r.passed, ["real pass"]);
});

// node:test's default non-TTY reporter (what this repo's `npm test` actually
// emits) is spec, not TAP — `hunch test` must parse it.
const SPEC = `✔ adds two numbers (1.2ms)
✖ divides correctly (0.8ms)
  AssertionError [ERR_ASSERTION]: Expected 5 to equal 4
      at Test.<anonymous> (file:///x/test/math.test.ts:12:3)
✔ another pass (0.1ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1`;

test("parseTestReport handles the node:test spec reporter (✔/✖ + durations)", () => {
  const r = parseTestReport(SPEC);
  assert.equal(r.recognized, true);
  assert.deepEqual(r.passed.sort(), ["adds two numbers", "another pass"]);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]!.test, "divides correctly"); // duration suffix stripped
  assert.match(r.failures[0]!.message, /Expected 5 to equal 4/);
  assert.match(r.failures[0]!.message, /math\.test\.ts:12/);
});

test("parseTestReport dedupes a failure echoed in the spec recap, and fail beats pass", () => {
  const r = parseTestReport(`✔ flaky (1ms)
✖ flaky (2ms)
✖ flaky (3ms)`);
  assert.equal(r.failures.length, 1); // deduped
  assert.deepEqual(r.passed, []); // fail wins over the earlier pass
});
