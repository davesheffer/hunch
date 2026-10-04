import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir } from "./fixtures.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { HOOK_PROVIDERS, type HookProvider } from "../src/core/agenthook.js";
import { readHookObservations } from "../src/core/hookObservations.js";
import { emptyState, onCommand, proofCheckpoint, type PipelineState } from "../src/core/pipeline.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { functionBodyHash } from "../src/core/siblingfix.js";
import { listReportTasks } from "../src/core/taskReport.js";

const entry = resolve("src/cli/index.ts");
const legacy = resolve("src/cli/main.ts");
function fixture(t: { after: (f: () => void) => void }, firmness = "advisory") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-startup-")));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  mkdirSync(join(root, ".tmp"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch/\n.hunch-cache/\n.tmp/\n");
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness }));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", root, "add", ".gitignore", "src/a.ts"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
  utimesSync(join(root, "src/a.ts"), 1_700_000_000, 1_700_000_000);
  return root;
}
function invoke(root: string, cli: string, input: unknown, args = ["hook"], imports: string[] = []) {
  const tmp = join(root, ".tmp");
  const result = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), ...imports.flatMap(x => ["--import", x]), cli, ...args], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "1", TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function payload(provider: HookProvider, event: string, tool = "Bash") {
  if (provider === "antigravity") return { conversationId: "s", toolCall: { name: tool, args: { command: "true" } } };
  if (provider === "windsurf") return { event, trajectory_id: "s", agent_action_name: tool, tool_info: { command: "true" }, tool_response: { exit_code: 1 } };
  return { hook_event_name: event, session_id: "s", agent_id: "agent-a", tool_name: tool, tool_input: { command: "true" }, tool_response: { exit_code: 1 } };
}
function rows(root: string) {
  return readHookObservations(root).map(({ at: _at, ...row }) => row).sort((a, b) => a.event.localeCompare(b.event));
}
function scratch(root: string, dir: string) {
  const path = join(root, ".tmp", dir);
  return existsSync(path) ? readdirSync(path).filter(x => x.endsWith(".json")).sort().map(x => JSON.parse(readFileSync(join(path, x), "utf8"))) : [];
}

test("simple hooks do not load the full command and store graph", t => {
  const root = fixture(t);
  const trace = join(root, ".tmp", "imports.txt");
  const loader = join(root, ".tmp", "trace-loader.mjs");
  writeFileSync(loader, `import { appendFileSync } from 'node:fs';\nexport async function resolve(s, c, next) { const r = await next(s, c); appendFileSync(${JSON.stringify(trace)}, r.url + '\\n'); return r; }\n`);
  const registration = "data:text/javascript," + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`);
  assert.deepEqual(invoke(root, entry, payload("claude", "PreToolUse"), ["hook"], [registration]), { status: 0, stdout: "", stderr: "" });
  const imported = readFileSync(trace, "utf8");
  assert.doesNotMatch(imported, /\/cli\/main\.ts|\/store\/hunchStore\.ts|\/node_modules\/zod\//);
  assert.equal(rows(root)[0]?.event, "PreToolUse", "delivery evidence survives the lightweight route");
});

test("simple hook output, delivery, baselines and pipeline facts match the full handler", t => {
  for (const provider of HOOK_PROVIDERS) for (const firmness of ["off", "advisory", "strict"]) {
    const a = fixture(t, firmness), b = fixture(t, firmness);
    const args = ["hook", "--provider", provider];
    const pre = payload(provider, "PreToolUse");
    assert.deepEqual(invoke(a, entry, pre, args), invoke(b, legacy, pre, args), `${provider}/${firmness}/pre`);
    assert.deepEqual(rows(a), rows(b));
    assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
    assert.equal(scratch(a, "hunch-hookcache").length, firmness === "off" ? 0 : 1);
    if (provider === "antigravity") continue; // Its dialect has no post-tool event.
    const seed = { ...emptyState(), editedFiles: ["src/a.ts"], editGeneration: 2, verifyAfterEdit: false, blocks: 1, proofActivity: 3 };
    for (const root of [a, b]) {
      mkdirSync(join(root, ".tmp", "hunch-pipeline"), { recursive: true });
      writeFileSync(join(root, ".tmp", "hunch-pipeline", "s.json"), JSON.stringify(seed));
    }
    for (const event of ["PostToolUseFailure", "PostToolUse"]) {
      const post = payload(provider, event, "Read");
      assert.deepEqual(invoke(a, entry, post, args), invoke(b, legacy, post, args));
      assert.deepEqual(rows(a), rows(b), "failure evidence remains sticky");
      assert.deepEqual(scratch(a, "hunch-pipeline"), [seed], "read activity cannot satisfy a check or erase edits");
      assert.deepEqual(scratch(a, "hunch-pipeline"), scratch(b, "hunch-pipeline"));
      assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
    }
  }
});

test("simple baselines remain isolated by session and agent", t => {
  const root = fixture(t);
  for (const [session_id, agent_id] of [["s", "a"], ["s", "b"], ["other", "a"]]) {
    assert.equal(invoke(root, entry, { ...payload("claude", "PreToolUse"), session_id, agent_id }).status, 0);
  }
  assert.equal(scratch(root, "hunch-hookcache").length, 3);
});

test("malformed and unknown input stays silent without recording a delivery", t => {
  const a = fixture(t), b = fixture(t);
  for (const input of ["{", "", "null", "[]", JSON.stringify({ hook_event_name: "Unknown" })]) {
    assert.deepEqual(invoke(a, entry, input), invoke(b, legacy, input));
    assert.deepEqual(invoke(a, entry, input), { status: 0, stdout: "", stderr: "" });
  }
  assert.deepEqual(rows(a), []);
});

test("prompt fallback receives the original stdin and opens the native task", t => {
  for (const cli of [entry, legacy]) {
    const root = fixture(t);
    const input = { hook_event_name: "UserPromptSubmit", cwd: root, session_id: "s", prompt_id: "p", prompt: "Fix the parser" };
    const result = invoke(root, cli, input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const [task] = listReportTasks(root);
    assert.ok(task);
    assert.match(result.stdout, new RegExp(task.task_id));
    assert.equal(task.state, "open");
    assert.equal(rows(root)[0]?.event, "UserPromptSubmit");
  }
});

test("shell, edit and skill post events still record their full pipeline facts", t => {
  for (const cli of [entry, legacy]) {
    const root = fixture(t);
    for (const [tool_name, tool_input] of [["Edit", { file_path: "src/a.ts", new_string: "3" }], ["Skill", { skill: "fable-mode" }], ["Bash", { command: "npm test" }]] as const) {
      const result = invoke(root, cli, { hook_event_name: "PostToolUse", session_id: "s", tool_name, tool_input, tool_response: { exit_code: 0 } });
      assert.equal(result.status, 0);
    }
    const [state] = scratch(root, "hunch-pipeline");
    assert.deepEqual(state.editedFiles, ["src/a.ts"]);
    assert.equal(state.editGeneration, 1);
    assert.equal(state.verifyAfterEdit, true);
  }
});

test("extra options, unknown providers and help retain Commander behavior", t => {
  const a = fixture(t), b = fixture(t);
  for (const args of [["--help"], ["hook", "--help"], ["hook", "--unknown"], ["hook", "--provider", "missing"], ["--initiator", "codex", "hook"], ["hook", "extra"]]) {
    assert.deepEqual(invoke(a, entry, "{}", args), invoke(b, legacy, "{}", args), args.join(" "));
  }
  assert.match(readFileSync(entry, "utf8"), /import "\.\/preflight\.js";[^]*?import/);
});

function traceImports(root: string) {
  const trace = join(root, ".tmp", "shell-imports.txt");
  const loader = join(root, ".tmp", "shell-loader.mjs");
  writeFileSync(loader, `import { appendFileSync } from "node:fs";\nexport async function resolve(s, c, next) { const r = await next(s, c); appendFileSync(${JSON.stringify(trace)}, r.url + "\\n"); return r; }\n`);
  const registration = "data:text/javascript," + encodeURIComponent(`import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(loader).href)});`);
  return { trace, registration };
}

test("no-write shell posts avoid main, store, functionhash and Zod loading", t => {
  for (const tool of ["Bash", "PowerShell"]) {
    const root = fixture(t);
    invoke(root, entry, payload("claude", "PreToolUse", tool));
    const { trace, registration } = traceImports(root);
    assert.deepEqual(invoke(root, entry, payload("claude", "PostToolUse", tool), ["hook"], [registration]), { status: 0, stdout: "", stderr: "" });
    assert.doesNotMatch(readFileSync(trace, "utf8"), /\/cli\/main\.ts|\/store\/hunchStore\.ts|\/(?:functionhash|siblingfix)\.ts|\/node_modules\/zod\//);
    assert.equal(rows(root).some(row => row.event === "PostToolUse"), true);
  }
});

function seedPipeline(root: string, state: PipelineState) {
  mkdirSync(join(root, ".tmp", "hunch-pipeline"), { recursive: true });
  writeFileSync(join(root, ".tmp", "hunch-pipeline", "s.json"), JSON.stringify(state));
}
function proofState(): PipelineState {
  return {
    ...emptyState(), editedFiles: ["src/a.ts"], editGeneration: 2, verifyAfterEdit: false,
    blocks: 1, proofActivity: 3,
    obligations: [{ id: "manual:check", origin: "manual", category: "behavior", phase: "after-edit",
      description: "Exercise the product behavior", command_alternatives: [["npm", "test"]],
      expected: { success: true, output_includes: ["passed"] }, status: "pending" }],
  };
}
function shellPayload(provider: HookProvider, tool: string, status: "success" | "failure" | "unknown", command = "npm test") {
  const response = status === "unknown" ? "passed" : { exit_code: status === "success" ? 0 : 1, output: "passed" };
  const event = status === "failure" ? "PostToolUseFailure" : "PostToolUse";
  if (provider === "windsurf") return { event: status === "failure" ? event : "post_run_command", trajectory_id: "s", agent_action_name: tool, tool_info: { command }, tool_response: response };
  if (provider === "cursor") return { event: status === "failure" ? event : "afterShellExecution", conversation_id: "s", tool_name: tool, tool_input: { command }, tool_response: response };
  return { hook_event_name: event, session_id: "s", agent_id: "agent-a", tool_name: tool, tool_input: { command }, tool_response: response };
}

test("shell outcomes and proof facts match main across providers, tools and firmness", t => {
  for (const provider of HOOK_PROVIDERS.filter(p => p !== "antigravity")) for (const firmness of ["off", "advisory", "strict"]) for (const tool of ["Bash", "PowerShell"]) {
    const a = fixture(t, firmness), b = fixture(t, firmness);
    const args = ["hook", "--provider", provider];
    for (const root of [a, b]) invoke(root, entry, payload(provider, "PreToolUse", tool), args);
    for (const status of ["success", "failure", "unknown"] as const) {
      const seed = proofState();
      // A nonmatching pending obligation exercises silent failed/unknown checks.
      if (status !== "success") seed.obligations[0]!.command_alternatives = [["git", "show"]];
      for (const root of [a, b]) seedPipeline(root, seed);
      const input = shellPayload(provider, tool, status);
      const { trace, registration } = traceImports(a);
      const result = invoke(a, entry, input, args, [registration]);
      assert.deepEqual(result, invoke(b, legacy, input, args), `${provider}/${firmness}/${tool}/${status}`);
      assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
      assert.doesNotMatch(readFileSync(trace, "utf8"), /\/cli\/main\.ts|\/store\/hunchStore\.ts|\/(?:functionhash|siblingfix)\.ts|\/node_modules\/zod\//);
      assert.deepEqual(rows(a), rows(b));
      assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
      assert.deepEqual(scratch(a, "hunch-pipeline"), scratch(b, "hunch-pipeline"));
      const [state] = scratch(a, "hunch-pipeline");
      const expected = firmness === "off" ? seed : proofCheckpoint(seed, onCommand(seed, "npm test", { status, output: "passed" }), { kind: "command", command: "npm test" }).state;
      assert.deepEqual(state, expected);
      assert.equal(state.proofActivity, firmness === "off" ? 3 : 4);
      assert.equal(state.verifyAfterEdit, firmness !== "off" && status !== "failure");
      assert.equal(state.obligations[0].status, firmness !== "off" && status === "success" ? "satisfied" : "pending");
      assert.equal(scratch(a, "hunch-hookcache").length, firmness === "off" ? 0 : 1);
    }
  }
});

test("shell writes fall back and ground new paths and dirty rewrites", t => {
  for (const tool of ["Bash", "PowerShell"]) for (const file of ["src/a.ts", "src/new.ts"]) {
    const a = fixture(t), b = fixture(t);
    for (const root of [a, b]) {
      const store = new HunchStore(hunchPaths(root));
      store.json.ensureDirs();
      store.json.put("constraints", mkConstraint({ id: "con_shellstartup", statement: "Keep this module free of side effects", scope: [file], severity: "blocking" }));
      store.reindex(); store.close();
      invoke(root, entry, payload("claude", "PreToolUse", tool));
      seedPipeline(root, proofState());
      writeFileSync(join(root, file), "export const a = 300;\n");
      utimesSync(join(root, file), 1_700_000_100, 1_700_000_100);
    }
    const { trace, registration } = traceImports(a);
    const input = shellPayload("claude", tool, "success");
    const result = invoke(a, entry, input, ["hook"], [registration]);
    assert.deepEqual(result, invoke(b, legacy, input));
    assert.match(result.stdout, /this shell command wrote/);
    assert.match(result.stdout, /Keep this module free of side effects/);
    assert.match(readFileSync(trace, "utf8"), /\/cli\/main\.ts/);
    assert.deepEqual(rows(a), rows(b));
    assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
    assert.deepEqual(scratch(a, "hunch-pipeline"), scratch(b, "hunch-pipeline"));
  }
});

test("stored lessons and proof reminders fall back with exact state and output", t => {
  for (const tool of ["Bash", "PowerShell"]) for (const scenario of ["lesson", "resolved-lesson", "cadence", "failed-proof", "unknown-proof"]) {
    const a = fixture(t), b = fixture(t);
    for (const root of [a, b]) {
      writeFileSync(join(root, "src/a.ts"), "export function a() {\n  const value = 2;\n  const result = value + 0;\n  return result;\n}\n");
      utimesSync(join(root, "src/a.ts"), 1_700_000_000, 1_700_000_000);
      invoke(root, entry, payload("claude", "PreToolUse", tool));
      const seed = proofState();
      if (scenario.includes("lesson")) assert.notEqual(functionBodyHash(root, "src/a.ts", "a"), null);
      if (scenario.includes("lesson")) seed.lessons = [{ id: "lesson-a", file: "src/a.ts", symbol: "a", sibling: "b", siblingFile: "src/b.ts", change: "Handle the edge case", callers: [], hash: functionBodyHash(root, "src/a.ts", "a"), reminded: scenario === "resolved-lesson" }];
      if (scenario === "cadence") {
        seed.proofActivity = 5;
        seed.obligations[0]!.command_alternatives = [["git", "show"]];
      }
      seedPipeline(root, seed);
    }
    const status = scenario === "failed-proof" ? "failure" : scenario === "unknown-proof" ? "unknown" : "success";
    const input = shellPayload("claude", tool, status);
    const { trace, registration } = traceImports(a);
    const result = invoke(a, entry, input, ["hook"], [registration]);
    assert.deepEqual(result, invoke(b, legacy, input), scenario);
    assert.match(readFileSync(trace, "utf8"), /\/cli\/main\.ts/);
    if (scenario === "resolved-lesson") assert.equal(result.stdout, "");
    else assert.notEqual(result.stdout, "", scenario);
    assert.deepEqual(rows(a), rows(b));
    assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
    assert.deepEqual(scratch(a, "hunch-pipeline"), scratch(b, "hunch-pipeline"));
    const [state] = scratch(a, "hunch-pipeline");
    assert.equal(state.proofActivity, scenario === "cadence" ? 6 : 4);
    if (scenario === "lesson") assert.equal(state.lessons[0].reminded, true);
    if (scenario.includes("proof")) assert.equal(state.obligations[0].last_attempt.outcome, status);
  }
});

test("Git inspection failure falls back without advancing the baseline", t => {
  for (const tool of ["Bash", "PowerShell"]) {
    const a = fixture(t), b = fixture(t);
    for (const root of [a, b]) {
      invoke(root, entry, payload("claude", "PreToolUse", tool));
      seedPipeline(root, proofState());
      renameSync(join(root, ".git"), join(root, ".tmp", "git"));
      writeFileSync(join(root, ".git"), "gitdir: .tmp/missing\n");
    }
    const baseline = scratch(a, "hunch-hookcache");
    const { trace, registration } = traceImports(a);
    const input = shellPayload("claude", tool, "success");
    assert.deepEqual(invoke(a, entry, input, ["hook"], [registration]), invoke(b, legacy, input));
    assert.match(readFileSync(trace, "utf8"), /\/cli\/main\.ts/);
    assert.deepEqual(rows(a), rows(b));
    assert.deepEqual(scratch(a, "hunch-hookcache"), baseline);
    assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
    assert.deepEqual(scratch(a, "hunch-pipeline"), scratch(b, "hunch-pipeline"));
  }
});

function directHandler(root: string, pipeline = "1") {
  const script = join(root, ".tmp", "direct-handler.mjs");
  writeFileSync(script, `import { readFileSync } from "node:fs";
import { handleSimpleHook } from ${JSON.stringify(pathToFileURL(resolve("src/cli/hookStartup.ts")).href)};
process.env.HUNCH_PIPELINE = ${JSON.stringify(pipeline)};
console.log(handleSimpleHook(readFileSync(0, "utf8"), "claude"));
`);
  return script;
}

test("shell fallback eligibility leaves observations, baseline and pipeline untouched", t => {
  for (const scenario of ["write", "lesson", "disabled-lesson", "checkpoint", "inspection-failure"]) {
    const root = fixture(t);
    invoke(root, entry, payload("claude", "PreToolUse"));
    const seed = proofState();
    if (scenario.includes("lesson")) seed.lessons = [{ id: "resolved", file: "src/a.ts", symbol: "a", sibling: "b", siblingFile: "src/b.ts", change: "Fix", callers: [], hash: null, reminded: true }];
    if (scenario === "checkpoint") {
      seed.proofActivity = 5;
      seed.obligations[0]!.command_alternatives = [["git", "show"]];
    }
    seedPipeline(root, seed);
    if (scenario === "write") {
      writeFileSync(join(root, "src/a.ts"), "export const a = 300;\n");
      utimesSync(join(root, "src/a.ts"), 1_700_000_100, 1_700_000_100);
    }
    if (scenario === "inspection-failure") {
      renameSync(join(root, ".git"), join(root, ".tmp", "git"));
      writeFileSync(join(root, ".git"), "gitdir: .tmp/missing\n");
    }
    const observations = rows(root), baseline = scratch(root, "hunch-hookcache"), pipeline = scratch(root, "hunch-pipeline");
    assert.deepEqual(invoke(root, directHandler(root, scenario === "disabled-lesson" ? "0" : "1"), shellPayload("claude", "Bash", "success")), { status: 0, stdout: "false\n", stderr: "" });
    assert.deepEqual(rows(root), observations, scenario);
    assert.deepEqual(scratch(root, "hunch-hookcache"), baseline, scenario);
    assert.deepEqual(scratch(root, "hunch-pipeline"), pipeline, scenario);
  }
});

test("off shell posts record delivery while leaving existing baseline and proof state intact", t => {
  for (const tool of ["Bash", "PowerShell"]) {
    const a = fixture(t), b = fixture(t);
    for (const root of [a, b]) {
      invoke(root, entry, payload("claude", "PreToolUse", tool));
      const seed = proofState();
      seed.proofActivity = 5;
      seed.lessons = [{ id: "lesson", file: "src/a.ts", symbol: "a", sibling: "b", siblingFile: "src/b.ts", change: "Fix", callers: [], hash: null, reminded: false }];
      seedPipeline(root, seed);
      writeFileSync(join(root, "src/a.ts"), "export const a = 300;\n");
      utimesSync(join(root, "src/a.ts"), 1_700_000_100, 1_700_000_100);
      writeFileSync(join(root, ".hunch/config.json"), JSON.stringify({ firmness: "off" }));
    }
    const baseline = scratch(a, "hunch-hookcache"), pipeline = scratch(a, "hunch-pipeline");
    const { trace, registration } = traceImports(a);
    const input = shellPayload("claude", tool, "failure");
    assert.deepEqual(invoke(a, entry, input, ["hook"], [registration]), invoke(b, legacy, input));
    assert.doesNotMatch(readFileSync(trace, "utf8"), /\/cli\/main\.ts|\/store\/hunchStore\.ts|\/(?:functionhash|siblingfix)\.ts|\/node_modules\/zod\//);
    assert.deepEqual(rows(a), rows(b));
    assert.equal(rows(a).some(row => row.event === "PostToolUseFailure"), true);
    assert.deepEqual(scratch(a, "hunch-hookcache"), baseline);
    assert.deepEqual(scratch(a, "hunch-pipeline"), pipeline);
    assert.deepEqual(scratch(a, "hunch-hookcache"), scratch(b, "hunch-hookcache"));
    assert.deepEqual(scratch(a, "hunch-pipeline"), scratch(b, "hunch-pipeline"));
  }
});

test("shell inspection defers advancing its captured fingerprint", t => {
  const root = fixture(t);
  invoke(root, entry, payload("claude", "PreToolUse"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 300;\n");
  utimesSync(join(root, "src/a.ts"), 1_700_000_100, 1_700_000_100);
  const script = join(root, ".tmp", "inspect.mjs");
  writeFileSync(script, `import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectShellWrites, shellWrittenFiles } from ${JSON.stringify(pathToFileURL(resolve("src/core/shellwrites.ts")).href)};
const root = process.cwd();
const cache = join(tmpdir(), "hunch-hookcache");
const file = join(cache, readdirSync(cache)[0]);
const before = readFileSync(file, "utf8");
const scan = inspectShellWrites(root, "s", "agent-a");
assert.deepEqual(scan.written, ["src/a.ts"]);
assert.equal(readFileSync(file, "utf8"), before);
writeFileSync(join(root, "src/a.ts"), "export const a = 400;");
utimesSync(join(root, "src/a.ts"), 1700000200, 1700000200);
scan.advance();
assert.equal(JSON.parse(readFileSync(file, "utf8"))["src/a.ts"], "1700000100000:22");
assert.deepEqual(shellWrittenFiles(root, "s", "agent-a"), ["src/a.ts"]);
const count = readdirSync(cache).length;
const first = inspectShellWrites(root, "new-session", "agent-a");
assert.deepEqual(first.written, []);
assert.equal(readdirSync(cache).length, count);
first.advance();
assert.equal(readdirSync(cache).length, count + 1);
const absent = inspectShellWrites(root, undefined);
assert.deepEqual(absent.written, []);
absent.advance();
assert.equal(readdirSync(cache).length, count + 1);
`);
  assert.deepEqual(invoke(root, script, ""), { status: 0, stdout: "", stderr: "" });
});
