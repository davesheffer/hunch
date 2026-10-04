import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir } from "./fixtures.js";
import { tsxLoaderUrl } from "./helpers.js";
import { HOOK_PROVIDERS, type HookProvider } from "../src/core/agenthook.js";
import { readHookObservations } from "../src/core/hookObservations.js";
import { emptyState } from "../src/core/pipeline.js";
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
