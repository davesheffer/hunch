import { cleanupDir } from "./fixtures.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isOutOfRepoAccess, runBenchmark, type RunBenchmarkOptions } from "../src/benchmark/orchestrate.js";
import { armOrder } from "../src/benchmark/schedule.js";
import type { BenchmarkArm, EfficiencyRun } from "../src/benchmark/types.js";

const CUTOFF = "2026-01-15T00:00:00Z";
const TASK = "fix-sum";
const ARMS: BenchmarkArm[] = ["no-hunch", "current-hunch"];
const SEED = "e2e-seed";
const TSX_STUB = `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, process.argv.slice(2).filter((arg) => arg !== "--test"), { stdio: "inherit", windowsHide: true });
process.exit(result.status ?? 1);
`;
/** Fixture agent: records its arm (hunch server in the MCP config => current-hunch), fixes the file,
 *  and prints a stream-json transcript whose init reports every configured server as connected. */
const AGENT = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
readFileSync(0, "utf8");
const servers = Object.keys(JSON.parse(readFileSync(process.argv[2], "utf8")).mcpServers ?? {});
const arm = servers.includes("hunch") ? "current-hunch" : "no-hunch";
appendFileSync(process.env.BENCH_FIXTURE_COUNTER, arm + "\\n");
writeFileSync("src/sum.mjs", "export const sum = (a, b) => a + b;\\n");
const hunch = arm === "current-hunch";
const events = [
  { type: "system", subtype: "init", model: "fixture-model", apiKeySource: "none",
    mcp_servers: servers.map((name) => ({ name, status: "connected" })),
    tools: ["Read", "Edit", ...(hunch ? ["mcp__hunch__hunch_context"] : [])] },
  { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "edited" }] } },
];
if (hunch) {
  // The audited SessionStart hook always emits: stand in for its injected context.
  events.splice(1, 0, { type: "system", subtype: "hook_response", hook_event: "SessionStart",
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx dec_bbbbbbbbbb" } }) });
  events.push({ type: "assistant", message: { id: "msg_2", content: [{ type: "tool_use", id: "tu_2", name: "mcp__hunch__hunch_context", input: {} }] } });
  events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "see dec_bbbbbbbbbb" }] } });
}
events.push({ type: "result", subtype: "success", is_error: false, num_turns: 2,
  usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 } });
for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
`;
const VALIDATOR = `import { sum } from "../src/sum.mjs";
if (sum(2, 3) !== 5) { console.error("sum is broken"); process.exit(1); }
console.log("sum ok");
`;

let root = "";
let emptyHooks = "";
let counter = "";
let out = "";
let opts: RunBenchmarkOptions;
const logs: string[] = [];

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${emptyHooks}`, ...args,
  ], { cwd, encoding: "utf8", env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, windowsHide: true }).trim();
}

function put(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function commit(repo: string, message: string, date: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
}

/** Stand-in for an audited Hunch build (as in task-benchmark-isolation.test.ts), committed clean. */
function writeStubAudited(dir: string): void {
  initRepo(dir);
  put(dir, "package.json", JSON.stringify({ type: "module", version: "0.0.0-stub" }) + "\n");
  put(dir, "dist/integrations/scaffold.js", String.raw`import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function installClaudeHooks(root, cmd) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  const entry = { hooks: [{ type: "command", command: cmd }] };
  const file = join(root, ".claude", "settings.json");
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [entry], UserPromptSubmit: [entry], PreToolUse: [{ matcher: "Edit|Write|MultiEdit", ...entry }] } }, null, 2) + "\n");
  return { path: file, action: "created" };
}
export function writeSlashCommands(root) {
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "capture.md"), "Stub capture\n<!-- hunch:generated -->\n");
  return { written: [], skipped: [] };
}
`);
  put(dir, "dist/cli/index.js", String.raw`import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
const BLOCK = "<!-- HUNCH:START — stub -->\nstub grounding dec_aaaaaaaaaa\n<!-- HUNCH:END -->";
const END = "<!-- HUNCH:END -->";
if (args === "grounding --refresh") {
  const text = readFileSync("CLAUDE.md", "utf8");
  const start = text.indexOf("<!-- HUNCH:START");
  const end = text.indexOf(END);
  writeFileSync("CLAUDE.md", start === -1 ? text + BLOCK + "\n" : text.slice(0, start) + BLOCK + text.slice(end + END.length));
  process.exit(0);
}
if (args === "index") process.exit(process.env.HUNCH_PRIVATE_DIR ? 0 : 3);
if (args === "footprint --json") {
  process.stdout.write(JSON.stringify({ schema: "hunch.footprint/1", surfaces: [{ id: "mcp.tools_list", chars: 1234 }] }));
  process.exit(0);
}
process.exit(2);
`);
  commit(dir, "stub audited", "2026-01-01 00:00:00 +0000");
}

const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const runDirs = (): string[] => readdirSync(join(out, "runs", TASK)).sort();
const runJson = (dir: string): EfficiencyRun => JSON.parse(readFileSync(join(out, "runs", TASK, dir, "run.json"), "utf8")) as EfficiencyRun;

before(() => {
  root = mkdtempSync(join(tmpdir(), "hunch-ctx-eff-e2e-"));
  emptyHooks = join(root, "fixture-hooks");
  mkdirSync(emptyHooks);

  const source = join(root, "source");
  initRepo(source);
  put(source, "CLAUDE.md", "# Fixture\n\n<!-- HUNCH:START — auto -->\n- dec_aaaaaaaaaa\n<!-- HUNCH:END -->\n");
  put(source, "src/sum.mjs", "export const sum = (a, b) => a - b;\n");
  put(source, "node_modules/tsx/dist/cli.mjs", TSX_STUB);
  put(source, ".hunch/decisions/dec_aaaaaaaaaa.json", JSON.stringify({ id: "dec_aaaaaaaaaa", created_at: "2025-12-31T00:00:00Z" }) + "\n");
  put(source, ".hunch/decisions/dec_cccccccccc.json", JSON.stringify({ id: "dec_cccccccccc", created_at: "2026-03-01T00:00:00Z" }) + "\n");
  commit(source, "c1", "2026-01-01 00:00:00 +0000");
  put(source, "README.md", "Fixture\n");
  put(source, ".hunch/decisions/dec_bbbbbbbbbb.json", JSON.stringify({ id: "dec_bbbbbbbbbb", created_at: "2026-01-31T00:00:00Z" }) + "\n");
  const start = commit(source, "c2", "2026-02-01 00:00:00 +0000");

  const overlay = join(root, "overlay");
  initRepo(overlay);
  put(overlay, ".hunch/findings/fnd_pppppppppp.json", JSON.stringify({ id: "fnd_pppppppppp", created_at: "2026-01-09T00:00:00Z" }) + "\n");
  commit(overlay, "p1", "2026-01-10 00:00:00 +0000");

  const audited = join(root, "audited");
  writeStubAudited(audited);

  const suiteDir = join(root, "suite");
  put(suiteDir, "validators/sum.test.mjs", VALIDATOR);
  put(suiteDir, "suite.json", JSON.stringify({
    schema: "hunch.context-efficiency-suite/1", id: "e2e", kind: "retrospective", timeout_ms: 60_000, validator_timeout_ms: 60_000,
    tasks: [{
      id: TASK, issue_number: 1, category: "self-contained", prompt: "Fix sum.\n\nsum(2, 3) must be 5.", starting_commit: start,
      memory: { cutoff_at: CUTOFF, eligible_record_ids: ["dec_aaaaaaaaaa", "dec_bbbbbbbbbb"], relevance_expected: "relevant" },
      validator: { file: "validators/sum.test.mjs", sha256: createHash("sha256").update(VALIDATOR).digest("hex") },
    }],
  }, null, 2));
  put(root, "agent/agent.mjs", AGENT);
  put(root, "runner.json", JSON.stringify({ schema: "hunch.benchmark-runner/1", provider: "fixture", executable: join(root, "agent", "agent.mjs"), model: "fixture", effort: null }));

  counter = join(root, "counter.txt");
  process.env.BENCH_FIXTURE_COUNTER = counter;
  out = join(root, "out");
  opts = {
    suite: join(suiteDir, "suite.json"), arms: [...ARMS], runs: 2, seed: SEED, runnerConfig: join(root, "runner.json"), output: out,
    sourceRepo: source, mainRef: "main", privateRepo: overlay, privateRef: "main", audited,
    noNpmCi: true, allowDirtyController: true, userInstructionsFile: join(root, "no-user-claude.md"), log: (line) => logs.push(line),
  };
});

after(() => {
  delete process.env.BENCH_FIXTURE_COUNTER;
  if (root) cleanupDir(root);
});

test("task benchmark runs, resumes, reruns an interrupted run, rebuilds the report, and refuses a changed manifest", async () => {
  const first = await runBenchmark(opts);
  assert.equal(first.exitCode, 0, logs.join("\n"));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest.schema, "hunch.context-efficiency-manifest/1");
  assert.equal(manifest.manifest.runner_config.executable, "agent.mjs");
  assert.equal(manifest.manifest.user_instructions_sha256, null);
  assert.equal(manifest.manifest.audited.version, "0.0.0-stub");
  assert.match(manifest.manifest_sha256, /^[0-9a-f]{64}$/);

  // Four runs (1 task x 2 reps x 2 arms), spawned in armOrder per rep.
  assert.deepEqual(runDirs(), ["1-current-hunch", "1-no-hunch", "2-current-hunch", "2-no-hunch"]);
  const spawns = readLines(counter);
  assert.deepEqual(spawns, [...armOrder(SEED, TASK, 1, ARMS), ...armOrder(SEED, TASK, 2, ARMS)]);
  assert.equal(readLines(join(out, "progress.log")).length, 4);
  for (const dir of runDirs()) {
    assert.ok(existsSync(join(out, "runs", TASK, dir, "exposure.json")), `${dir}/exposure.json`);
    const run = runJson(dir);
    assert.equal(run.status, "completed", `${dir}: ${run.isolation_evidence.join(" | ")}`);
    assert.equal(run.success, true);
    assert.equal(run.quality.outcome, "passed");
    assert.equal(run.manifest_sha256, manifest.manifest_sha256);
    assert.equal(run.evidence_kind, "fixture");
    assert.equal(run.cost.input_tokens, 115);
    if (run.arm === "current-hunch") {
      assert.deepEqual(run.selected_memory_ids, ["dec_aaaaaaaaaa", "dec_bbbbbbbbbb"]);
      assert.deepEqual(run.delivered_eligible_ids, ["dec_aaaaaaaaaa", "dec_bbbbbbbbbb"]);
      assert.equal(run.memory_revision, manifest.manifest.tasks[0].snapshot.public.sha256);
      assert.ok(run.cost.hunch_context_estimated_tokens > 0);
    } else {
      assert.deepEqual(run.selected_memory_ids, []);
      assert.equal(run.memory_revision, null);
      assert.equal(run.cost.hunch_context_estimated_tokens, 0);
    }
  }
  assert.match(readFileSync(join(out, "report.md"), "utf8").split("\n")[0]!, /FIXTURE EVIDENCE/);

  // Resume: nothing is spawned again.
  assert.equal((await runBenchmark(opts)).exitCode, 0, logs.join("\n"));
  assert.equal(readLines(counter).length, 4);
  assert.equal(readLines(join(out, "progress.log")).length, 4);

  // A run dir without run.json is moved aside and rerun.
  rmSync(join(out, "runs", TASK, "2-no-hunch", "run.json"));
  assert.equal((await runBenchmark(opts)).exitCode, 0, logs.join("\n"));
  assert.ok(existsSync(join(out, "runs", TASK, "2-no-hunch.interrupted-1")));
  assert.equal(runJson("2-no-hunch").status, "completed");
  assert.deepEqual(readLines(counter).slice(4), ["no-hunch"]);
  assert.equal(readLines(join(out, "progress.log")).length, 5);

  // --report-only rebuilds report.md from the run.json files.
  writeFileSync(join(out, "report.md"), "stale\n");
  const reportOnly = await runBenchmark({ ...opts, reportOnly: true });
  assert.equal(reportOnly.exitCode, 0, logs.join("\n"));
  assert.match(readFileSync(join(out, "report.md"), "utf8").split("\n")[0]!, /FIXTURE EVIDENCE/);

  // F6: --report-only takes arms from the manifest; an explicit --arms mismatch refuses,
  // but the CLI default (armsExplicit unset) never triggers the check.
  const reversedArms = [...ARMS].reverse();
  const implicitReversed = await runBenchmark({ ...opts, reportOnly: true, arms: reversedArms });
  assert.equal(implicitReversed.exitCode, 0, logs.join("\n"));
  const explicitReversed = await runBenchmark({ ...opts, reportOnly: true, arms: reversedArms, armsExplicit: true });
  assert.equal(explicitReversed.exitCode, 1);
  assert.ok(logs.some((line) => line.includes("!= manifest arms")), logs.join("\n"));

  // A changed seed changes the manifest: exit 2, no new run dir, no spawn.
  const dirsBefore = runDirs();
  const changed = await runBenchmark({ ...opts, seed: "another-seed" });
  assert.equal(changed.exitCode, 2);
  assert.deepEqual(runDirs(), dirsBefore);
  assert.equal(readLines(counter).length, 5);
  assert.ok(logs.some((line) => line.includes("first differing key: seed")), logs.join("\n"));
});

test("isOutOfRepoAccess flags deny roots outside the run dir and traversal, in either path style", () => {
  const denyRoots = ["C:\\src\\hunch", "/home/dave/hunch-private", "/home/dave/audited", "C:\\out"];
  const runDir = "C:\\out\\runs\\task-1\\1-current-hunch";
  assert.equal(isOutOfRepoAccess(join(runDir, "notes.md"), denyRoots, runDir), false, "own run dir is allowed");
  assert.equal(isOutOfRepoAccess("C:/out/runs/task-1/1-current-hunch/notes.md", denyRoots, runDir), false, "forward-slash own run dir");
  assert.equal(isOutOfRepoAccess("cd /c/out/runs/task-1/1-current-hunch/repo && grep -rn foo \"C:\\out\\runs\\task-1\\1-current-hunch\\repo\\src\"", denyRoots, runDir), false, "own run dir inside a shell command, MSYS and Windows style");
  assert.equal(isOutOfRepoAccess("C:\\src\\hunch-bench\\x", denyRoots, runDir), false, "a deny root is matched on a path boundary only");
  assert.equal(isOutOfRepoAccess("C:\\out\\runs\\task-1\\2-no-hunch\\transcript.jsonl", denyRoots, runDir), true, "a sibling run dir is denied");
  assert.equal(isOutOfRepoAccess("C:\\out\\runs\\task-1\\1-current-hunch.interrupted-1\\transcript.jsonl", denyRoots, runDir), true, "an earlier interrupted attempt is denied");
  assert.equal(isOutOfRepoAccess("ls C:/out/snapshots/task-1/public", denyRoots, runDir), true, "the frozen snapshots are denied");
  assert.equal(isOutOfRepoAccess("cat /c/src/hunch/.hunch/x.json", denyRoots, runDir), true, "MSYS-style deny root");
  assert.equal(isOutOfRepoAccess("C:\\src\\hunch\\package.json", denyRoots, runDir), true, "Windows-style deny root");
  assert.equal(isOutOfRepoAccess("/home/dave/hunch-private/.hunch/decisions", denyRoots, runDir), true, "POSIX-style deny root");
  assert.equal(isOutOfRepoAccess("../../../etc/passwd", denyRoots, runDir), true, "POSIX traversal");
  assert.equal(isOutOfRepoAccess("..\\..\\..\\Windows\\win.ini", denyRoots, runDir), true, "Windows traversal");
  assert.equal(isOutOfRepoAccess("/HOME/DAVE/HUNCH-PRIVATE/x", denyRoots, runDir), true, "case-insensitive deny root");
  const auditedCli = "/home/dave/audited/dist/cli/index.js";
  assert.equal(isOutOfRepoAccess("& 'C:\\Program Files\\nodejs\\node.exe' '/home/dave/audited/dist/cli/index.js' task verify htask_1 -- npm test", denyRoots, runDir, [auditedCli]), false, "the allowed audited CLI entrypoint");
  assert.equal(isOutOfRepoAccess("node /home/dave/audited/dist/cli/index.js task verify htask_1 -- npm test", denyRoots, runDir), true, "the entrypoint is denied without the allowance");
  assert.equal(isOutOfRepoAccess("cat /home/dave/audited/dist/core/taskReportEvidence.js", denyRoots, runDir, [auditedCli]), true, "other audited files stay denied");
  assert.equal(isOutOfRepoAccess("cat /home/dave/audited/dist/cli/index.js.map", denyRoots, runDir, [auditedCli]), true, "the allowance is an exact path, not a prefix");
  assert.equal(isOutOfRepoAccess("/home/dave/audited/dist/cli/index.js/../../core/x.js", denyRoots, runDir, [auditedCli]), true, "traversal off the entrypoint is not dropped");
  assert.equal(isOutOfRepoAccess(`node -e "require('path').dirname('/home/dave/audited/dist/cli/index.js')"`, denyRoots, runDir, [auditedCli]), true, "the entrypoint embedded in code, not invoked, is denied");
  assert.equal(isOutOfRepoAccess('"C:\\Program Files\\nodejs\\node.exe" "/home/dave/audited/dist/cli/index.js" why src/x.ts', denyRoots, runDir, [auditedCli]), false, "any subcommand after the invoked entrypoint is dropped");
  for (const tail of [" --help", " --version", " --timeout 900 task verify htask_1 -- npm test"]) {
    assert.equal(isOutOfRepoAccess(`& 'C:\\Program Files\\nodejs\\node.exe' '/home/dave/audited/dist/cli/index.js'${tail}`, denyRoots, runDir, [auditedCli]), false, `flag invocation: ${JSON.stringify(tail)}`);
  }
  assert.equal(isOutOfRepoAccess("/home/dave/audited/dist/cli/index.js", denyRoots, runDir, [auditedCli]), true, "a bare mention (a Read of the entrypoint) stays denied");
  assert.equal(isOutOfRepoAccess('import { x } from "../../../src/core/io.js";', denyRoots, runDir, [], "/home/dave", false), false, "file content skips the traversal rule");
  assert.equal(isOutOfRepoAccess('const p = "/home/dave/hunch-private/x";', denyRoots, runDir, [], "/home/dave", false), true, "file content still hits deny roots");
  assert.equal(isOutOfRepoAccess("../.././../etc/passwd", denyRoots, runDir), true, "traversal tolerating a ./ segment");
  assert.equal(isOutOfRepoAccess("..//..//..//etc/passwd", denyRoots, runDir), true, "traversal tolerating repeated separators");
  assert.equal(isOutOfRepoAccess("ls ../src", denyRoots, runDir), false, "a single .. is not a traversal run");
  const home = "/home/dave";
  assert.equal(isOutOfRepoAccess("cat ~/hunch-private/x", denyRoots, runDir, [], home), true, "~ home form");
  assert.equal(isOutOfRepoAccess("cat $HOME/hunch-private/x", denyRoots, runDir, [], home), true, "$HOME home form");
  assert.equal(isOutOfRepoAccess('ls "$env:USERPROFILE\\hunch-private"', denyRoots, runDir, [], home), true, "$env:USERPROFILE home form");
  assert.equal(isOutOfRepoAccess("ls ~/notes", denyRoots, runDir, [], home), false, "a home path outside the deny roots is allowed");
});
