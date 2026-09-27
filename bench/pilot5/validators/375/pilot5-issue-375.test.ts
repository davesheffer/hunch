// PILOT5 hidden validator for davesheffer/hunch#375 (continuation card).
// Derived from the issue's own fixture and expectation ("six finished tasks on
// src/config.ts, three sharing one constraint lesson and three with no lesson;
// one UserPromptSubmit, then five identical pre-edit calls" -> FULL, delta, ...)
// and from the fix's regression test "a crowded task selection does not change
// after its own delivery" (test/hook-dedupe-stability.test.ts in a6eb1c60).
// Adapted to accept any correct fix: it drives the public `hunch hook` CLI for
// every pre-edit provider, uses only APIs present at the starting commit, names
// no option or function the fix introduced, and recognises a delta only by the
// "unchanged this session" line the #373 dedupe already emits at the start.
// A guard at the end keeps "always answer with a delta" from passing: a changed
// record must still re-send the full block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import { finishReportTask, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { persistTaskRecord } from "../src/core/taskRecord.js";
import { HunchStore, type AssembledContext } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint } from "../src/core/types.js";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const tsxSpec = import.meta.resolve("tsx");
const tsxLoader = tsxSpec.startsWith("file:") ? tsxSpec : pathToFileURL(tsxSpec).href;

const constraint = (statement: string): Constraint => ({
  id: "con_pilot5_375", type: "architecture", statement, scope: ["src/config.ts"],
  severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null,
  violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null,
  provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
} as Constraint);

function context(withConstraint: boolean): AssembledContext {
  return {
    target: "src/config.ts", constraints: withConstraint ? [constraint("Preserve existing settings")] : [],
    decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500,
  } as unknown as AssembledContext;
}

const lesson = () => ({
  record_id: "con_pilot5_375", kind: "constraints", title: "Preserve existing settings",
  lesson: "Merge settings.", content_hash: reportHash("fixture revision"), recorded_at: "2026-09-11T00:00:00.000Z",
});

/** The issue's fixture: one invariant on src/config.ts and six finished tasks
 *  anchored to it, three sharing the constraint lesson and three with none. */
function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pilot5-375-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, "src", "config.ts"), "export const settings = {};\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", constraint("Preserve existing settings"));
  store.reindex();
  for (let i = 0; i < 6; i++) {
    const prior = startReportTask(root, `Earlier settings work ${i}`);
    const shares = i < 3;
    recordTaskDelivery(root, prior.task_id, buildDeliveryEnvelope(context(shares)), shares ? [lesson()] : [], undefined, "src/config.ts");
    finishReportTask(root, prior.task_id);
    assert.ok(persistTaskRecord(root, store, prior.task_id, { flush: false }), `fixture task ${i} must persist`);
  }
  store.close();
  return root;
}

/** The dedupe cache is keyed by session id; every test gets its own. */
let seq = 0;
const sessionId = () => `pilot5-375-${process.pid}-${Date.now()}-${seq++}`;

function hookEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HUNCH_")) env[k] = v;
  env.HUNCH_PIPELINE = "0";
  return env;
}

function runHook(root: string, provider: string, session: string, payload: Record<string, unknown>) {
  const output = execFileSync(process.execPath, ["--import", tsxLoader, cli, "hook", "--provider", provider], {
    cwd: root, env: hookEnv(),
    input: JSON.stringify({ cwd: root, session_id: session, prompt_id: "prompt-375", turn_id: "turn-1", ...payload }),
    encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}

/** The pre-edit payload each provider's own tool contract carries for one file. */
const PRE_EDIT: Record<string, (root: string) => Record<string, unknown>> = {
  claude: (root) => ({
    hook_event_name: "PreToolUse", tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "config.ts"), new_string: "merge settings" },
  }),
  codex: () => ({
    hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { input: ["*** Begin Patch", "*** Update File: src/config.ts", "@@", "-export const settings = {};", "+export const settings = { merged: true };", "*** End Patch", ""].join("\n") },
  }),
};

const DELTA = /unchanged this session/;

for (const provider of Object.keys(PRE_EDIT)) {
  test(`#375 ${provider}: five identical pre-edit calls with >3 tasks per file give FULL then deltas`, { timeout: 300_000 }, t => {
    const root = fixture(t);
    const session = sessionId();
    runHook(root, provider, session, { hook_event_name: "UserPromptSubmit", prompt: "merge the settings" });
    const payload = PRE_EDIT[provider]!(root);
    const ground = () => (runHook(root, provider, session, payload)?.hookSpecificOutput?.additionalContext ?? "") as string;

    const calls = [ground(), ground(), ground(), ground(), ground()];
    const shape = calls.map((c) => (DELTA.test(c) ? "delta" : "FULL")).join(", ");
    assert.doesNotMatch(calls[0]!, DELTA, "the first call is the full grounding block");
    assert.match(calls[0]!, /Preserve existing settings/, "the full block carries the file's invariant");
    assert.match(calls[0]!, /Earlier settings work/, "the fixture must actually deliver its finished tasks");
    assert.equal(shape, "FULL, delta, delta, delta, delta",
      `no record changed between calls, so only the first may be FULL (got: ${shape}); the picked task set must not move after its own delivery`);

    // Guard: a record the block renders changes, so the full block must come back.
    const store = new HunchStore(hunchPaths(root));
    store.json.put("constraints", constraint("Preserve existing settings AND never delete keys"));
    store.reindex();
    store.close();
    const changed = ground();
    assert.doesNotMatch(changed, DELTA, "a changed constraint statement must re-send the FULL block");
    assert.match(changed, /never delete keys/, "and the full block must carry the new statement");
  });
}
