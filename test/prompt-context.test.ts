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
  test(`${provider} one brief covers constraints for source and test files explicitly named in the prompt`, t => {
    const root = fixture(t);
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test", "file.test.ts"), "// regression\n");
    const store = new HunchStore(hunchPaths(root));
    store.json.put("constraints", mkConstraint({ id: "con_test", statement: "Retain regression assertions", scope: ["test/**"], severity: "blocking" }));
    store.reindex(); store.close();
    const output = hook(root, "Update src/file.ts and test/file.test.ts", provider);
    assert.match(output, /con_test/);
    assert.match(output, /Constraint coverage is complete for: src\/file\.ts, test\/file\.test\.ts/);
    const report = readTaskReport(root, listReportTasks(root)[0]!.task_id);
    assert.equal(report.deliveries.length, 1, "one budgeted brief, not another full context per file");
    assert.ok(report.deliveries[0]!.records.some(record => record.record_id === "con_test"));
  });

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

test("secondary prompt paths retain privacy exclusions and symlink refusal", t => {
  const root = fixture(t);
  symlinkSync(join(root, "src", "file.ts"), join(root, "linked.ts"));
  const output = hook(root, "Update src/file.ts and credentials.json config-secret.json linked.ts ../outside.ts package.json", "codex");
  const coverage = output.split("\n").find(line => line.startsWith("Constraint coverage"));
  assert.ok(coverage);
  assert.match(coverage, /src\/file\.ts, package\.json/);
  assert.doesNotMatch(coverage, /credentials|config-secret|linked\.ts|outside/);
});

test("a secondary file with constraints omitted by budget retains the manual lookup requirement", t => {
  const root = fixture(t);
  writeFileSync(join(root, "src", "second.ts"), "export const second = 2;\n");
  const store = new HunchStore(hunchPaths(root));
  for (let i = 0; i < 30; i++) store.json.put("constraints", mkConstraint({
    id: `con_second_${i}`, statement: `Additional rule ${i}: ${"keep this invariant explicit ".repeat(20)}`,
    scope: ["src/second.ts"], severity: "warning",
  }));
  store.reindex(); store.close();
  const output = hook(root, "Update src/file.ts and src/second.ts", "codex");
  const coverage = output.split("\n").find(line => line.startsWith("Constraint coverage"));
  assert.ok(coverage);
  assert.match(coverage, /src\/file\.ts/);
  assert.doesNotMatch(coverage, /src\/second\.ts/);
  assert.match(output, /check hunch_check_constraints before editing uncovered scope/);
});

test("constraint coverage is bounded to four distinct canonical prompt files", t => {
  const root = fixture(t);
  for (const name of ["a", "b", "c", "d"]) writeFileSync(join(root, "src", `${name}.ts`), `export const ${name} = 1;\n`);
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_fifth", statement: "Fifth file needs its own lookup", scope: ["src/d.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  const duplicate = existsSync(join(root, "SRC", "FILE.TS")) ? "SRC/FILE.TS" : "src/file.ts";
  const output = hook(root, `Update src/file.ts ${duplicate} src/a.ts src/b.ts src/c.ts src/d.ts`, "codex");
  const coverage = output.split("\n").find(line => line.startsWith("Constraint coverage"));
  assert.ok(coverage);
  assert.match(coverage, /src\/file\.ts, src\/a\.ts, src\/b\.ts, src\/c\.ts/);
  assert.doesNotMatch(coverage, /src\/d\.ts/);
  assert.doesNotMatch(output, /con_fifth/);
  assert.match(output, /check hunch_check_constraints before editing uncovered scope/);
});

test("prompt coverage retains the full blocking statement before certifying it", t => {
  const root = fixture(t);
  writeFileSync(join(root, "src", "second.ts"), "// second\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_long", statement: `${"Long context for the rule. ".repeat(10)}Never remove the audit check.`, scope: ["src/second.ts"], severity: "blocking" }));
  store.reindex(); store.close();
  const output = hook(root, "Update src/file.ts and src/second.ts", "codex");
  assert.match(output, /con_long/, "the rule headline is still delivered");
  const coverage = output.split("\n").find(line => line.startsWith("Constraint coverage"));
  assert.ok(coverage);
  assert.match(output, /Never remove the audit check\./, "the prohibition must actually be emitted");
  assert.match(coverage, /src\/second\.ts/);
});

test("prompt coverage retains long scope lists before certifying a named file", t => {
  const root = fixture(t);
  writeFileSync(join(root, "src", "second.ts"), "// second\n");
  const scope = ["src/second.ts", ...Array.from({ length: 12 }, (_, i) => `src/other-long-scope-${i}.ts`)];
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_long_scope", statement: "Retain the check for every scoped file.", scope, severity: "blocking" }));
  store.reindex(); store.close();
  const output = hook(root, "Update src/file.ts and src/second.ts", "codex");
  assert.ok(output.includes(`| scope ${scope.join(", ")} |`), "scope certification requires the complete emitted list");
  assert.match(output, /Constraint coverage is complete for: src\/file\.ts, src\/second\.ts/);
});

test("retired and expired global rules do not invalidate active constraint coverage", t => {
  const root = fixture(t);
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_retired_global", statement: "Retired rule", scope: ["**"], status: "retired" }));
  store.json.put("constraints", mkConstraint({ id: "con_expired_global", statement: "Expired rule", scope: [], valid_to: "2020-01-01T00:00:00Z" }));
  store.reindex(); store.close();
  const output = hook(root, "Update src/file.ts and package.json", "codex");
  assert.match(output, /Constraint coverage is complete for: src\/file\.ts, package\.json/);
});

test("a glob rule on an unindexed secondary file uses that file for anchor validation", t => {
  const root = fixture(t);
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "file.test.ts"), "// no symbols\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.put("constraints", mkConstraint({ id: "con_secondary_warning", statement: "Retain existing assertions", scope: ["test/**"], severity: "warning" }));
  store.reindex(); store.close();
  const output = hook(root, "Update src/file.ts and test/file.test.ts", "codex");
  assert.match(output, /con_secondary_warning/);
  assert.match(output, /Constraint coverage is complete for: src\/file\.ts, test\/file\.test\.ts/);
});

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
