import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { promptContextTarget } from "../src/core/promptContext.js";
import { readTaskReport, listReportTasks } from "../src/core/taskReport.js";
import { servedSummary } from "../src/core/served.js";
import { renderHunchSection } from "../src/integrations/claudemd.js";
import { stopVerdict } from "../src/core/pipeline.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
const localTmp = join(process.cwd(), ".agent-test-tmp");
const sentinel = "PRIVATE_PROMPT_SENTINEL";

function fixture(t: { after: (f: () => void) => void }): string {
  mkdirSync(localTmp, { recursive: true });
  const root = mkdtempSync(join(localTmp, "prompt-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".tmp"));
  writeFileSync(join(root, "src", "file.ts"), "export const file = 1;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "credentials.json"), "{}\n");
  writeFileSync(join(root, "config-secret.json"), "{}\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_file", statement: "File rule", scope: ["src/file.ts"], severity: "blocking" }));
  store.json.put("constraints", mkConstraint({ id: "con_global", statement: "Global rule", scope: [], severity: "blocking" }));
  store.reindex();
  store.close();
  return root;
}

function hook(root: string, prompt: string, provider = "claude", extra: Record<string, unknown> = {}) {
  const tmp = join(root, ".tmp");
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", provider], {
    cwd: root,
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, HUNCH_PRIVATE_DIR: "", HUNCH_TASK_SELECTION: "0", HUNCH_PIPELINE: "1" },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, session_id: `session-${provider}`, prompt_id: "prompt-a", prompt, ...extra }),
    encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output).hookSpecificOutput?.additionalContext as string ?? "" : "";
}

test("first explicit safe file resolves to a canonical path", t => {
  const root = fixture(t);
  assert.equal(promptContextTarget(root, "read `src/file.ts:27` then package.json"), "src/file.ts");
  assert.equal(promptContextTarget(root, "inspect 'package.json:2'"), "package.json");
  assert.equal(promptContextTarget(root, "missing.ts then src/file.ts"), "src/file.ts");
  for (const prompt of ["general task", "missing.ts", "../src/file.ts", `/tmp/nope.ts`, `${root}/src/file.ts`, ".hunch/config.json", "src", "config-secret.json", "credentials.json"]) {
    assert.equal(promptContextTarget(root, prompt), null, prompt);
  }
  symlinkSync(join(root, "src", "file.ts"), join(root, "linked.ts"));
  symlinkSync(join(root, "src"), join(root, "linked-src"));
  assert.equal(promptContextTarget(root, "linked.ts"), null);
  assert.equal(promptContextTarget(root, "linked-src/file.ts"), null);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} native prompt delivers a file brief with task evidence and global rules`, t => {
    const root = fixture(t);
    const output = hook(root, `Update \`src/file.ts:12\` ${sentinel}`, provider);
    const [task] = listReportTasks(root);
    assert.ok(task);
    const report = readTaskReport(root, task.task_id);
    assert.equal(report.deliveries.length, 1);
    const [delivery] = report.deliveries;
    assert.equal(delivery?.target, "src/file.ts");
    assert.match(output, new RegExp(`task ${task.task_id} · occurrence ${delivery!.occurrence_id}`));
    assert.match(output, /This satisfies this task's initial context step/);
    assert.match(output, /con_file/);
    assert.match(output, /con_global/);
    assert.ok(delivery!.records.some((item) => item.record_id === "con_file"));
    assert.ok(delivery!.records.some((item) => item.record_id === "con_global"));
    const served = servedSummary(root).recent;
    assert.ok(served.some((row) => row.record_id === "con_file" && row.target === "src/file.ts"));
    assert.ok(served.some((row) => row.record_id === "con_global" && row.target === "src/file.ts"));
    const cache = join(root, ".hunch-cache");
    for (const file of readdirSync(cache)) {
      if (file.endsWith(".db")) assert.equal(readFileSync(join(cache, file)).includes(Buffer.from(sentinel)), false, file);
    }
    const pipeline = join(root, ".tmp", "hunch-pipeline", `session-${provider}.json`);
    assert.ok(existsSync(pipeline));
    assert.doesNotMatch(readFileSync(pipeline, "utf8"), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
  });

  test(`${provider} fallback keeps manual context guidance for unsafe or nonauthoritative prompts`, t => {
    const root = fixture(t);
    for (const [index, [prompt, extra]] of ([
      ["general task", {}], ["unknown.ts", {}], ["../src/file.ts", {}],
      ["src/file.ts", { cwd: localTmp }], ["src/file.ts", { agent_id: "subagent" }],
      ["<task-notification>\nsrc/file.ts", {}],
    ] as Array<[string, Record<string, unknown>]>).entries()) {
      const output = hook(root, prompt, provider, { prompt_id: `fallback-${index}`, ...extra });
      assert.doesNotMatch(output, /task-linked prompt-hook brief for src\/file.ts/, prompt);
      if (index === 0) assert.match(output, /hunch_context call with the task and known files/);
    }
  });
}

test("unsupported provider receives no automatic brief", t => {
  const root = fixture(t);
  assert.doesNotMatch(hook(root, "src/file.ts", "cursor"), /task-linked prompt-hook brief for src\/file.ts/);
});

test("native filesystem casing keeps exact file constraints and canonical receipts", t => {
  const root = fixture(t);
  if (!existsSync(join(root, "SRC", "FILE.TS"))) { t.skip("case-sensitive filesystem"); return; }
  assert.equal(promptContextTarget(root, "SRC/FILE.TS"), "src/file.ts");
  const output = hook(root, "Update SRC/FILE.TS", "codex");
  assert.match(output, /con_file/);
  const task = listReportTasks(root)[0]!;
  assert.equal(readTaskReport(root, task.task_id).deliveries[0]!.target, "src/file.ts");
});

test("advertised team memory keeps the validated manual route instead of public-only context", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".hunch", "team.json"), "invalid team config");
  const output = hook(root, "Update src/file.ts", "codex");
  assert.doesNotMatch(output, /This satisfies this task's initial context step/);
  assert.match(output, /hunch_context/);
  for (const task of listReportTasks(root)) assert.equal(readTaskReport(root, task.task_id).deliveries.length, 0);
});

test("continuing with an automatic file slice preserves pending obligations from every origin", t => {
  const root = fixture(t);
  hook(root, "Update src/file.ts", "codex");
  const path = join(root, ".tmp", "hunch-pipeline", "session-codex.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.obligations = ["memory", "episode", "manual"].map(origin => ({
    id: `${origin}:pending`, origin, category: "behavior", phase: "after-edit",
    description: "Verify the retained requirement", command_alternatives: [["node", "check"]],
    expected: { success: true }, status: "pending",
  }));
  writeFileSync(path, JSON.stringify(state));
  hook(root, "Continue updating src/file.ts", "codex", { prompt_id: "prompt-b" });
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(after.obligations, state.obligations);
  assert.equal(stopVerdict(after, "firm").block, true);
});

test("generated routing keeps the manual first-context path", t => {
  const root = fixture(t);
  const store = new HunchStore(hunchPaths(root));
  t.after(() => store.close());
  assert.match(renderHunchSection(store, root), /otherwise call `hunch_context\(target\)` first, before reading or editing/);
});
