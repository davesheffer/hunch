import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tsxLoaderUrl } from "./helpers.js";
import { recallFailures } from "../src/core/failureRecall.js";
import { bugId } from "../src/core/ids.js";
import { hunchPaths } from "../src/core/paths.js";
import { BugSchema, type Bug } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";

const TEST = "session token refresh survives a clock skew";
const bug = (over: Partial<Bug> = {}): Bug => BugSchema.parse({ id: bugId(TEST), title: "Token refresh fails under clock skew",
  symptom: "expired token rejected", root_cause: "refresh compared local time to the server's issued-at without leeway",
  status: "fixed", lineage: { introduced_commit: null, detected: null, fixed_commit: "abcdef1234567890", recurrence_of: null,
    spawned_decision: null, spawned_constraint: null },
  provenance: { source: "agent_recorded", confidence: 0.8, evidence: [] }, ...over });
const spec = (name: string) => `✔ unrelated passes (1ms)\n✖ ${name} (2.1ms)\n  AssertionError: expected true\n`;

test("a failing test whose own bug was recorded is recalled with its cause and fix", () => {
  const recall = recallFailures(spec(TEST), [bug()]);
  assert.deepEqual(recall.bugs, [bugId(TEST)]);
  assert.match(recall.text, /seen before/);
  assert.match(recall.text, /without leeway/);
  assert.match(recall.text, /fixed in abcdef12/);
});

test("a bug that quotes the full failing test name is recalled", () => {
  const quoted = bug({ id: "bug_quoted", symptom: `CI: "${TEST}" fails after DST` });
  assert.deepEqual(recallFailures(spec(TEST), [quoted]).bugs, ["bug_quoted"]);
});

test("misses, short names, unrecognized output and already-recalled bugs stay silent", () => {
  assert.equal(recallFailures(spec("some other test that fails here"), [bug()]).text, "");
  assert.equal(recallFailures(spec("parses input"), [bug({ id: "bug_x", symptom: "it parses input wrong" })]).text, "");
  assert.equal(recallFailures("Error: command not found", [bug()]).text, "");
  assert.equal(recallFailures(`✔ ${TEST} (1ms)\n`, [bug()]).text, "", "a passing run is not a failure");
  assert.equal(recallFailures(spec(TEST), [bug()], [bugId(TEST)]).text, "");
});

// ---- end-to-end: the real `hunch hook` PostToolUseFailure path ----
const hookCli = resolve("src/cli/index.ts");
function repo(t: { after: (f: () => void) => void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-failrecall-")));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["-C", root, "init", "-q"]);
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("bugs", bug());
  store.reindex(); store.close();
  return root;
}
function failed(root: string, session: string, output: string, pipeline = "1"): string {
  return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), hookCli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: pipeline },
    input: JSON.stringify({ hook_event_name: "PostToolUseFailure", cwd: root, session_id: session, tool_name: "Bash",
      tool_input: { command: "npm test" }, error: output }), encoding: "utf8",
  });
}

test("the failure hook recalls a seen-before test failure once per session, and is silent on a miss", t => {
  const root = repo(t);
  const session = `failrecall-${process.pid}-${Math.random().toString(36).slice(2)}`;
  assert.equal(failed(root, session, spec("a brand new failing test name")).trim(), "", "no hit emits nothing");
  const first = failed(root, session, spec(TEST));
  assert.match(first, /seen before/);
  assert.match(first, new RegExp(bugId(TEST)));
  assert.doesNotMatch(failed(root, session, spec(TEST)), /seen before/, "the same bug is not recalled twice");
  assert.match(failed(root, `${session}-np`, spec(TEST), "0"), /seen before/, "recall does not depend on the pipeline");
});
