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
/** Fixture agent: records its arm (hunch server in the MCP config => current-hunch, diet-hunch when that server
 *  runs from the diet checkout), fixes the file, and prints a stream-json transcript whose init reports every
 *  configured server as connected. */
const AGENT = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
readFileSync(0, "utf8");
// Neutral user config: auto memory under the run's own config dir; the token leaks into the transcript (and, on
// request, into a commit) so the harness's redaction and git-object checks have something to find.
const configDir = process.env.CLAUDE_CONFIG_DIR;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (token && process.env.BENCH_FIXTURE_COMMIT_TOKEN) {
  writeFileSync("leaked-token.txt", token);
  spawnSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "add", "leaked-token.txt"]);
  spawnSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "leak"]);
}
const mcpServers = JSON.parse(readFileSync(process.argv[2], "utf8")).mcpServers ?? {};
const servers = Object.keys(mcpServers);
const arm = !servers.includes("hunch") ? "no-hunch" : /[\\\\/]diet[\\\\/]dist[\\\\/]/.test(mcpServers.hunch.args[0]) ? "diet-hunch" : "current-hunch";
appendFileSync(process.env.BENCH_FIXTURE_COUNTER, arm + "\\n");
writeFileSync("src/sum.mjs", "export const sum = (a, b) => a + b;\\n");
const hunch = arm !== "no-hunch";
const events = [
  { type: "system", subtype: "init", model: "fixture-model", apiKeySource: "none",
    ...(configDir ? { memory_paths: { auto: configDir + "/projects/repo/memory/MEMORY.md" } } : {}),
    mcp_servers: servers.map((name) => ({ name, status: "connected" })),
    tools: ["Read", "Edit", ...(hunch ? ["mcp__hunch__hunch_context"] : [])] },
  { type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: token ? "edited; env " + token : "edited" }] } },
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

  // --report-only takes token fields from run.json as recorded; --recount re-reads transcript.jsonl and leaves run.json alone.
  const tampered = join(out, "runs", TASK, "1-no-hunch", "run.json");
  const original = JSON.parse(readFileSync(tampered, "utf8")) as EfficiencyRun;
  writeFileSync(tampered, JSON.stringify({ ...original, cost: { ...original.cost, input_tokens: 999, main_input_tokens: undefined } }, null, 2) + "\n");
  const tamperedText = readFileSync(tampered, "utf8");
  const observed = () => (JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
    token_source: { kind: string; recounted_runs?: number };
    observations: Array<{ arm: string; run_index: number; input_tokens: number | null; main_input_tokens: number | null }>;
  });
  const row = () => observed().observations.find((o) => o.arm === "no-hunch" && o.run_index === 1)!;
  assert.equal((await runBenchmark({ ...opts, reportOnly: true })).exitCode, 0, logs.join("\n"));
  assert.equal(row().input_tokens, 999, "recorded source keeps run.json's value");
  assert.equal(row().main_input_tokens, null, "a field missing from an older run.json reads as null");
  assert.equal(observed().token_source.kind, "recorded");
  assert.equal((await runBenchmark({ ...opts, reportOnly: true, recount: true })).exitCode, 0, logs.join("\n"));
  assert.equal(row().input_tokens, 115, "recounted from the transcript");
  assert.equal(row().main_input_tokens, 115);
  assert.equal(observed().token_source.kind, "recounted");
  assert.equal(observed().token_source.recounted_runs, 4);
  assert.match(readFileSync(join(out, "report.md"), "utf8"), /recounted from transcript\.jsonl by harness `[0-9a-f]{40}(\+dirty)?` for 4 of 4 run\(s\)/);
  assert.equal(readFileSync(tampered, "utf8"), tamperedText, "run.json is never rewritten by a recount");
  assert.equal((await runBenchmark({ ...opts, recount: true })).exitCode, 1, "--recount without --report-only refuses");
  writeFileSync(tampered, JSON.stringify(original, null, 2) + "\n");

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
  // Gate A v5: invoked means the command word or node's/npx tsx's first argument, followed on the same line.
  for (const named of [
    "cp /home/dave/audited/dist/cli/index.js x",
    "cat /home/dave/audited/dist/cli/index.js\nls",
    "cat '/home/dave/audited/dist/cli/index.js'\n-v",
    "node x.js /home/dave/audited/dist/cli/index.js task",
    "echo x >& /home/dave/audited/dist/cli/index.js --help",
    "mynode /home/dave/audited/dist/cli/index.js task",
    "node -e 1 /home/dave/audited/dist/cli/index.js task",
    "node --require /home/dave/audited/dist/cli/index.js x.js",
    "node --import=x /home/dave/audited/dist/cli/index.js task",
    "cat /home/dave/audited/dist/cli/index.js\n-v",
  ]) assert.equal(isOutOfRepoAccess(named, denyRoots, runDir, [auditedCli]), true, `named, not invoked: ${JSON.stringify(named)}`);
  for (const invoked of [
    "/home/dave/audited/dist/cli/index.js task verify htask_1",
    "cd repo && node /home/dave/audited/dist/cli/index.js why src/x.ts",
    "npx tsx /home/dave/audited/dist/cli/index.js --help",
    "ls\n'node' '/home/dave/audited/dist/cli/index.js'\ttask verify htask_1",
    // Critic pass 1: realistic wrappers around node stay invocations.
    "timeout 600 node /home/dave/audited/dist/cli/index.js task verify htask_1 -- npm test",
    "HUNCH_SYNC=1 node /home/dave/audited/dist/cli/index.js sync",
    "env FOO=1 node /home/dave/audited/dist/cli/index.js --version",
    `OUT=$(node /home/dave/audited/dist/cli/index.js task verify htask_1 2>&1); echo "$OUT"`,
    "if node /home/dave/audited/dist/cli/index.js --help; then echo ok; fi",
    `bash -c "node /home/dave/audited/dist/cli/index.js why src/x.ts"`,
    "for t in a b; do node /home/dave/audited/dist/cli/index.js why $t; done",
    // Critic pass 2: continuations, node options, quoted subcommands.
    "'C:\\Program Files\\nodejs\\node.exe' \\\n  '/home/dave/audited/dist/cli/index.js' task verify htask_1 -- npm test",
    "node /home/dave/audited/dist/cli/index.js \\\n  task verify htask_1 -- npm test",
    "node --enable-source-maps /home/dave/audited/dist/cli/index.js task verify htask_1 -- npm test",
    "node --max-old-space-size=4096 /home/dave/audited/dist/cli/index.js why src/x.ts",
    `& 'C:\\Program Files\\nodejs\\node.exe' '/home/dave/audited/dist/cli/index.js' 'task' 'verify' 'htask_1'`,
  ]) assert.equal(isOutOfRepoAccess(invoked, denyRoots, runDir, [auditedCli]), false, `invoked: ${JSON.stringify(invoked)}`);
  // Critic pass 3: in a shell command node must itself be the command word; a prompt or todo runs nothing.
  const entry = "/home/dave/audited/dist/cli/index.js";
  for (const named of [
    `grep -n node ${entry} -A 3`,
    `grep -rn "node" ${entry} --include=*.js`,
    `rg node ${entry} -n`,
    `ls -la /usr/local/bin/node ${entry} --color`,
    `diff /usr/bin/node ${entry} -q`,
    `cp /usr/bin/node ${entry} -f`,
    `node --redirect-warnings ${entry} x.js`,
    `node --test-reporter-destination ${entry} x.test.js`,
    `node --check ${entry} task`,
    `node --eval=1 ${entry} task`,
    `cat x \\\r\n${entry} -n`,
    `cat \`echo -n\` ${entry} -n`,
    `a=(${entry} -x); cat "\${a[0]}"`,
    `node --title=x;cp ${entry} ./x`,
    `node --max-old-space-size=4096|cat ${entry}`,
    `git push -c "${entry} check"`,
  ]) assert.equal(isOutOfRepoAccess(named, denyRoots, runDir, [auditedCli]), true, `shell, named: ${JSON.stringify(named)}`);
  for (const invoked of [
    `node ${entry}`,
    `node ${entry} | head -20`,
    `node ${entry} 2>&1 | tail -20`,
    `node ${entry} 2>/dev/null`,
    `for c in why check; do node ${entry} $c src/x.ts; done`,
    `node ${entry} "$cmd" src/x.ts`,
    `node ${entry} "$@"`,
    `node ${entry} \\\r\n  task verify h`,
    `HUNCH_SYNC=1 ${entry} sync`,
    `if true; then ${entry} check; fi`,
    `time ${entry} check`,
    `timeout 600 ${entry} check`,
    `(${entry} task)`,
    `x=$( ${entry} check )`,
    `sh -c 'node ${entry} why src/x.ts'`,
    `cd repo && \\\n  node ${entry} task verify h -- npm test`,
    `HUNCH_SYNC=1 \\\n  node ${entry} sync`,
    `cd /work/repo/\nnode ${entry} task verify h -- npm test`,
  ]) assert.equal(isOutOfRepoAccess(invoked, denyRoots, runDir, [auditedCli]), false, `shell, invoked: ${JSON.stringify(invoked)}`);
  const prose = (text: string) => isOutOfRepoAccess(text, denyRoots, runDir, [auditedCli], undefined, true, false);
  assert.equal(prose(`Run node ${entry} task verify for the tests`), false, "a prompt quoting the verify instruction");
  assert.equal(prose(`Check with node ${entry}.`), false, "a sentence ending after the entry");
  assert.equal(prose(`Read ${entry} first`), true, "a prompt naming the file without a runner stays denied");
  assert.equal(prose(`see ${entry}.map`), true, "a sibling file in prose stays denied");
  // Known false positive (PILOT5 Gate A, self-contained-394 rep 2): the entrypoint stored in a shell variable and
  // invoked through it read as a bare mention. Allowed by the 2026-09-28 amendment before the next Gate A version:
  // dropped only when every expansion of the variable is itself an invocation.
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1 -- npm test`, denyRoots, runDir, [auditedCli]), false, "entrypoint assigned to a variable and only ever invoked through it");
  assert.equal(isOutOfRepoAccess(`export H="/home/dave/audited/dist/cli/index.js"; node "$H" --help`, denyRoots, runDir, [auditedCli]), false, "export form, quoted expansion");
  assert.equal(isOutOfRepoAccess(`H=/home/dave/audited/dist/cli/index.js; node \${H} why src/x.ts`, denyRoots, runDir, [auditedCli]), false, "unquoted assignment, braced expansion");
  const winAuditedCli = "C:\\Users\\x\\hunch-audited-v1.42.0\\dist\\cli\\index.js";
  assert.equal(
    isOutOfRepoAccess(
      `cd "C:/x/repo"; H='C:\\Users\\x\\hunch-audited-v1.42.0\\dist\\cli\\index.js'; node "$H" task verify htask_f8 --label "typecheck" -- npm run typecheck 2>&1 | tail -5; echo "exit $?"; node "$H" task verify htask_f8 --label "t" -- npx tsx --test test/a.test.ts 2>&1 | head -30`,
      denyRoots,
      runDir,
      [winAuditedCli],
    ),
    false,
    "two invocations through the same variable, Windows-style assigned path",
  );
  // Known false positive (PILOT5 Gate A v4, continuation-375 rep 1 current-hunch, DEVIATIONS (k)): an assignment the
  // agent never used named the entrypoint inside nested quotes. A standalone, unexported, never-mentioned shell
  // variable can't reach the path, so its value is dropped; every other use of the name keeps it denied.
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'`, denyRoots, runDir, [auditedCli]), false, "assigned but never used is no access");
  const observedV4 = `V="'C:/Program Files/nodejs/node.exe' '/home/dave/audited/dist/cli/index.js'"; '/c/Program Files/nodejs/node.exe' '/home/dave/audited/dist/cli/index.js' task verify htask_1 -- npx tsx --test test/a.test.ts 2>&1 | tail -20`;
  assert.equal(isOutOfRepoAccess(observedV4, denyRoots, runDir, [auditedCli]), false, "the observed v4 command: an unused assignment beside the real invocation");
  assert.equal(isOutOfRepoAccess(observedV4.replace("; ", "\n"), denyRoots, runDir, [auditedCli]), false, "the unused assignment on its own line");
  const unused = (command: string) => isOutOfRepoAccess(command, denyRoots, runDir, [auditedCli]);
  const value = `"'/usr/bin/node' '/home/dave/audited/dist/cli/index.js'"`;
  // DEVIATIONS (m): the real v4 transcript opened with `cd "<run repo>"`; the synthetic shape above had no cd.
  assert.equal(unused(`cd "${runDir.replace(/\\/g, "/")}/repo"; ${observedV4}; npm run typecheck 2>&1 | tail -5`), false, "the observed v4 command verbatim, cd prefix included");
  assert.equal(unused(`cd /tmp/elsewhere && V=${value} && echo ok`), false, "cd to a literal absolute path reads no variable");
  assert.equal(unused(`cd C:/work && V=${value}`), false, "cd to a drive path");
  assert.equal(unused(`V=${value}; cd -; cat index.js`), true, "cd - reads OLDPWD, stays denied");
  assert.equal(unused(`V=${value}; cd; cat x`), true, "a bare cd reads HOME, stays denied");
  assert.equal(unused(`V=${value}; cd v; cat index.js`), true, "a relative cd may resolve a named directory (cdablevars), stays denied");
  assert.equal(unused(`V=${value}; cd v/x; cat y`), true, "a relative cd with a slash (~v/x under cdablevars) stays denied");
  assert.equal(unused(`V=${value}; cd /tmp /x`), true, "cd with two arguments stays denied");
  assert.equal(unused(`V=${value}; cd /tmp > out.txt`), true, "cd with a redirection stays denied");
  assert.equal(unused(`V=${value}; "cd" /tmp`), true, "a quoted cd is not the accepted form");
  assert.equal(unused(`V=${value}; echo cd /tmp /x`), false, "cd as an argument is an ordinary word");
  assert.equal(unused(`V=${value} && echo ok`), false, "an && boundary after the unused assignment");
  assert.equal(unused(`V=${value}; cat "$V"`), true, "a later expansion keeps it denied");
  assert.equal(unused(`V=${value}; export V`), true, "exporting it keeps it denied");
  assert.equal(unused(`export V=${value}`), true, "an exported assignment stays denied");
  assert.equal(unused(`V=${value} node x.js`), true, "an environment prefix for a command stays denied");
  assert.equal(unused(`node x.js V=${value}`), true, "an assignment-shaped argument stays denied");
  assert.equal(unused(`V=${value}; node -e "console.log(process.env.V)"`), true, "the bare name anywhere keeps it denied");
  assert.equal(unused(`set -a; V=${value}`), true, "allexport exports it, stays denied");
  assert.equal(unused(`set -o allexport; V=${value}`), true, "allexport, long form, stays denied");
  assert.equal(unused(`bash <<EOF\nV=${value}\nEOF`), true, "a heredoc line stays denied");
  assert.equal(unused(`echo "x V=" ; cat /home/dave/audited/dist/cli/index.js ; echo " ; true "`), true, "an assignment shape inside quotes is not an assignment");
  assert.equal(unused(`V="$(cat /home/dave/audited/dist/cli/index.js)"`), true, "a command substitution in the value stays denied");
  assert.equal(unused(`V=\`cat /home/dave/audited/dist/cli/index.js\``), true, "a backtick substitution stays denied");
  assert.equal(unused(`V="/home/dave/audited/dist/cli/index.js /home/dave/hunch-private/x"`), true, "another deny root in the value still matches");
  assert.equal(unused(`cat \\\nV=${value}`), true, "a backslash-continued line is an argument, not a statement");
  // Critic review of the (k) rule: each of these reaches the path without naming the variable again.
  assert.equal(unused("cat ${V='/home/dave/audited/dist/cli/index.js'}"), true, "a ${V=…} default expansion is an argument, not a statement");
  assert.equal(unused("cat ${V=/home/dave/audited/dist/cli/index.js }"), true, "an unquoted ${V=… } default expansion stays denied");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; source ./helper.sh"), true, "a sourced script shares the shell");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; . ./helper.sh"), true, "the . builtin shares the shell");
  for (const set of ["set -e -a", "set -eo allexport", "set -euo pipefail -a", "set -o errexit -o allexport"]) {
    assert.equal(unused(`${set}; V=/home/dave/audited/dist/cli/index.js; node scripts/x.js`), true, `allexport through ${set}`);
  }
  assert.equal(unused("a=(V=/home/dave/audited/dist/cli/index.js); cat ${a[0]#*=}"), true, "an array element is not a statement");
  assert.equal(unused("hunch_cli=/home/dave/audited/dist/cli/index.js; for v in ${!hu*}; do cat \"${!v}\"; done"), true, "indirect expansion stays denied");
  assert.equal(unused("v=/home/dave/audited/dist/cli/index.js; for x in $(compgen -v); do cat \"${!x}\"; done"), true, "compgen introspection stays denied");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; declare -n r=${x:-V}; cat \"$r\""), true, "a nameref built from an expansion stays denied");
  assert.equal(unused("set -e; V=/home/dave/audited/dist/cli/index.js; echo ok"), true, "any set keeps it denied (the rest must be inert)");
  // Second critic pass: each of these read the file in real bash while the blocklist rule returned false.
  assert.equal(unused("HOME=/home/dave/audited/dist/cli/index.js; cat ~"), true, "an inherited name keeps its export; ~ reads HOME");
  assert.equal(unused("HOME=/home/dave/audited/dist/cli/index.js && node -e \"require('os').homedir()\""), true, "HOME is read by a child without being spelled");
  assert.equal(unused("NODE_OPTIONS='--require /home/dave/audited/dist/cli/index.js'; node -e 0"), true, "a name a child consumes stays denied");
  assert.equal(unused("OLDPWD=/home/dave/audited/dist/cli/index.js; cd -"), true, "a name the shell consumes stays denied");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; set | grep audited | cut -d= -f2- | xargs cat"), true, "a set listing fed to cat stays denied");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; cat $(set | grep audited | cut -d= -f2-)"), true, "a set listing in a substitution stays denied");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; eval cat '$'$(echo vv | cut -c1)"), true, "eval with a constructed name stays denied");
  assert.equal(unused("f(){ local -n r=$1; cat \"$r\"; }; V=/home/dave/audited/dist/cli/index.js; f $(echo vv | cut -c1)"), true, "a local nameref stays denied");
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; history | tail -1"), true, "history can replay the value");
  // Third critic pass: builtin spellings a word list misses; the rest must parse under a strict grammar instead.
  const xcat = "printenv | grep index.js | cut -d= -f2- | xargs cat";
  for (const command of [
    `\\set -a; V=/home/dave/audited/dist/cli/index.js; ${xcat}`,
    "V=/home/dave/audited/dist/cli/index.js; \\set | grep index.js | xargs cat",
    "V=/home/dave/audited/dist/cli/index.js; se\\t | grep index.js | xargs cat",
    "V=/home/dave/audited/dist/cli/index.js; \\declare -p | xargs cat",
    "V=/home/dave/audited/dist/cli/index.js; \\. ./h.sh",
    `s""et -a; V=/home/dave/audited/dist/cli/index.js; ${xcat}`,
    `V=/home/dave/audited/dist/cli/index.js; ."" ./h.sh`,
    `V=/home/dave/audited/dist/cli/index.js; sou""rce ./h.sh`,
    `'set' -a; V=/home/dave/audited/dist/cli/index.js; ${xcat}`,
    `shopt -so allexport; V=/home/dave/audited/dist/cli/index.js; ${xcat}`,
    "f() { set | xargs cat; }; V=/home/dave/audited/dist/cli/index.js; f",
    "V=/home/dave/audited/dist/cli/index.js; trap 'set | xargs cat' EXIT",
    "READNULLCMD=/home/dave/audited/dist/cli/index.js; </dev/null",
    "NULLCMD=/home/dave/audited/dist/cli/index.js; >/dev/stderr",
    "V=/home/dave/audited/dist/cli/index.js/../../core/x.js; echo ok",
    "V=/home/dave/audited/dist/cli/index.js; echo ok &",
    "V=/home/dave/audited/dist/cli/index.js; ls *",
  ]) assert.equal(unused(command), true, command);
  assert.equal(unused("V=/home/dave/audited/dist/cli/index.js; npx tsx --test test/a.test.ts 2>&1 | tail -20 > out.txt"), false, "a plain pipeline with redirections is inert");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; cat "$H" | head`, denyRoots, runDir, [auditedCli]), true, "an expansion that is not an invocation stays denied");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; cat "$H"`, denyRoots, runDir, [auditedCli]), true, "one non-invocation expansion denies the whole assignment even alongside an invocation");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js/../x'; node "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), true, "traversal off the assigned path is not the exact entrypoint, stays denied");
  assert.equal(isOutOfRepoAccess(`export H='/home/dave/audited/dist/cli/index.js'; echo $HOME`, denyRoots, runDir, [auditedCli]), true, "$HOME is not an expansion of H");
  assert.equal(isOutOfRepoAccess(`export H='/home/dave/audited/dist/cli/index.js'; node "$G" task verify htask_1`, denyRoots, runDir, [auditedCli]), true, "a different variable invoked stays denied");
  assert.equal(isOutOfRepoAccess(`xH='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; echo "$xH"`, denyRoots, runDir, [auditedCli]), true, "an assignment glued to a preceding word is a different variable name, stays denied");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, "invoked directly at a command boundary");
  assert.equal(isOutOfRepoAccess(`cli='/home/dave/audited/dist/cli/index.js'; node "$cli" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, "a name that also appears inside the assigned path");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; cat \${H%x}`, denyRoots, runDir, [auditedCli]), true, "a parameter-expansion form is not an invocation");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; cat "$H" -n`, denyRoots, runDir, [auditedCli]), true, "an expansion with a flag tail but not at command position stays denied");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; G="$H" bash -c 'cat "$G"'`, denyRoots, runDir, [auditedCli]), true, "copying the variable into a prefix assignment stays denied");
  assert.equal(isOutOfRepoAccess(`export H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; node -e "require('fs').readFileSync(process.env.H)"`, denyRoots, runDir, [auditedCli]), true, "the bare name read through the environment stays denied");
  assert.equal(isOutOfRepoAccess(`xH='/home/dave/audited/dist/cli/index.js'; H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; cat "$xH"`, denyRoots, runDir, [auditedCli]), true, "dropping one assignment never erases another variable's identical assignment");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; python3 -c "print(open('$H' if True else 0).read())"`, denyRoots, runDir, [auditedCli]), true, "an open paren is not a command boundary");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; arr=("$H" x); cat "\${arr[0]}"`, denyRoots, runDir, [auditedCli]), true, "copying the variable into an array stays denied");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; cat \\\n"$H" -n`, denyRoots, runDir, [auditedCli]), true, "a backslash-continued line is not a new command");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; node "$H" task verify htask_1; grep node "$H" -n`, denyRoots, runDir, [auditedCli]), true, "node as an argument word is not the interpreter");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; cat <<EOF\n$H\nEOF`, denyRoots, runDir, [auditedCli]), true, "a heredoc line is not an invocation");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; echo hi >& "$H" x`, denyRoots, runDir, [auditedCli]), true, "a >& redirection is not a command boundary");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; echo hi >| "$H" x`, denyRoots, runDir, [auditedCli]), true, "a >| redirection is not a command boundary");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; echo x |& "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, "a |& pipe is a command boundary");
  assert.equal(isOutOfRepoAccess(`cd repo && H='/home/dave/audited/dist/cli/index.js' && node.exe "$H" task verify htask_1 -h`, denyRoots, runDir, [auditedCli]), false, "&& boundaries, node.exe, and a -h flag that is not a reference");
  // Known false positive (PILOT5 Gate A v2, repeated-bug-360 rep 1 diet-hunch): on Windows the hook prints node's full
  // quoted path and the agent kept it in a variable too. Allowed by the Gate A v3 amendment: a double-quoted "$N" reads
  // as node only while every mention of N is an assignment of a node path or that expansion.
  const dietCli = "C:\\Users\\x\\hunch-hook-diet\\dist\\cli\\index.js";
  const withDiet = [...denyRoots, "C:\\Users\\x\\hunch-hook-diet"];
  const observed = `cd "C:/out/runs/task-1/1-current-hunch/repo"; N='/c/Program Files/nodejs/node.exe'; H='C:\\Users\\x\\hunch-hook-diet\\dist\\cli\\index.js'; "$N" "$H" task verify htask_e4f5045532804a976b4880b7 -- npx tsx --test test/change-ledger.test.ts test/change-ledger-cache.test.ts 2>&1 | grep -E '"exit_code"'; npx tsx --test test/change-ledger.test.ts test/change-ledger-cache.test.ts 2>&1 | grep -E "ℹ (pass|fail)"; "$N" "$H" task verify htask_e4f5045532804a976b4880b7 --timeout 1500 -- npm test > /tmp/full.txt 2>&1; grep -E '"exit_code"' /tmp/full.txt`;
  assert.equal(isOutOfRepoAccess(observed, withDiet, runDir, [dietCli]), false, "the observed v2 command: node path and entrypoint both in variables");
  assert.equal(isOutOfRepoAccess(observed.replaceAll('"$N"', "$N"), withDiet, runDir, [dietCli]), true, "the observed v2 command with an unquoted node variable stays denied");
  for (const name of ["NODE", "NODEJS", "node"]) {
    assert.equal(isOutOfRepoAccess(`${name}='C:\\Program Files\\nodejs\\node.exe'; H='/home/dave/audited/dist/cli/index.js'; "$${name}" "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, `a node variable named ${name}, a word of its own path`);
  }
  // Known false positive (PILOT5 Gate A v3, repeated-bug-360 rep 1 current-hunch): the entrypoint variable was named C,
  // and the node path's drive letter `C:` read as a second mention of it. A drive letter is not a variable reference.
  const auditedWin = "C:\\Users\\x\\hunch-audited-v1.42.0\\dist\\cli\\index.js";
  const withAudited = [...denyRoots, "C:\\Users\\x\\hunch-audited-v1.42.0"];
  const observedV3 = `cd "C:/out/runs/task-1/1-current-hunch/repo" && H='C:\\Program Files\\nodejs\\node.exe'; C='C:\\Users\\x\\hunch-audited-v1.42.0\\dist\\cli\\index.js'; "$H" "$C" task verify htask_d2f7b82f346359b7497c88b5 -- npx tsx --test test/change-ledger.test.ts test/change-ledger-cache.test.ts 2>&1 | grep -E "^# (pass|fail)|^not ok" ; "$H" "$C" task verify htask_d2f7b82f346359b7497c88b5 -- npm run typecheck 2>&1 | tail -3`;
  assert.equal(isOutOfRepoAccess(observedV3, withAudited, runDir, [auditedWin]), false, "the observed v3 command: entrypoint variable C beside drive letter C:");
  assert.equal(isOutOfRepoAccess(observedV3.replaceAll('"$H"', "$H"), withAudited, runDir, [auditedWin]), true, "the observed v3 command with an unquoted node variable stays denied");
  assert.equal(isOutOfRepoAccess(`C='/home/dave/audited/dist/cli/index.js'; '/c/Program Files/nodejs/node.exe' "$C" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, "an MSYS drive /c/ is not a mention of C");
  assert.equal(isOutOfRepoAccess(`C='/home/dave/audited/dist/cli/index.js'; node "$C" task verify htask_1; ls "$C:/x"`, denyRoots, runDir, [auditedCli]), true, "$C glued to :/ is still a reference");
  assert.equal(isOutOfRepoAccess(`C='/home/dave/audited/dist/cli/index.js'; node "$C" task verify htask_1; echo "\${C:-x}"`, denyRoots, runDir, [auditedCli]), true, "\${C:-x} is still a reference");
  assert.equal(isOutOfRepoAccess(`C='/home/dave/audited/dist/cli/index.js'; node "$C" task verify htask_1; printenv C`, denyRoots, runDir, [auditedCli]), true, "a bare C word is still a reference");
  assert.equal(isOutOfRepoAccess(`export E='C:\\Users\\x\\hunch-audited-v1.42.0\\dist\\cli\\index.js'; node "$E" task verify htask_1; cmd /c "type %E:/=\\%"`, withAudited, runDir, [auditedWin]), true, "a cmd %E:/=\\% substitution is still a reference");
  assert.equal(isOutOfRepoAccess(`C='C:\\Program Files\\nodejs\\node.exe'; H='C:\\Users\\x\\hunch-audited-v1.42.0\\dist\\cli\\index.js'; "$C" "$H" task verify htask_1; echo c:/x`, withAudited, runDir, [auditedWin]), false, "a single-letter node variable C beside drive letters c:");
  assert.equal(isOutOfRepoAccess(`N=/x/node; cat /home/dave/hunch-private"$N"`, denyRoots, runDir, [auditedCli]), true, "a deny root glued to a node variable still matches");
  assert.equal(isOutOfRepoAccess(`N=/x/node; ls /home/dave/audited"\${N}"; H='/home/dave/audited/dist/cli/index.js'; "$N" "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), true, "a deny root glued to a braced node variable still matches beside an invocation");
  assert.equal(isOutOfRepoAccess(`N="C:\\Program Files\\nodejs\\node.exe"; H='/home/dave/audited/dist/cli/index.js'; "\${N}" "$H" --help`, denyRoots, runDir, [auditedCli]), false, "double-quoted Windows node path, braced expansion");
  assert.equal(isOutOfRepoAccess(`export N=/usr/bin/node; H='/home/dave/audited/dist/cli/index.js'; "$N" "$H" why src/x.ts`, denyRoots, runDir, [auditedCli]), false, "export form, unquoted node path");
  assert.equal(isOutOfRepoAccess(`N='/c/Program Files/nodejs/node.exe'; H='/home/dave/audited/dist/cli/index.js'; "$N" "$H" task verify htask_1; "$N" --version`, denyRoots, runDir, [auditedCli]), false, "the node variable used for another invocation");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; '/c/Program Files/nodejs/node.exe' "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, "a single-quoted full node path as the interpreter");
  assert.equal(isOutOfRepoAccess(`H='/home/dave/audited/dist/cli/index.js'; & "C:\\Program Files\\nodejs\\node.exe" "$H" task verify htask_1`, denyRoots, runDir, [auditedCli]), false, "a double-quoted Windows node path as the interpreter");
  const viaVar = (prefix: string, call = `"$N" "$H" task verify htask_1`) => isOutOfRepoAccess(`${prefix}H='/home/dave/audited/dist/cli/index.js'; ${call}`, denyRoots, runDir, [auditedCli]);
  assert.equal(viaVar("N='/x/node.exe'; "), false, "the base form each case below changes once");
  assert.equal(viaVar("N=cat; "), true, "a variable holding another program stays denied");
  assert.equal(viaVar("N='/usr/bin/cat'; "), true, "a path not ending in node stays denied");
  assert.equal(viaVar("N='/x/node.exe'; N=cat; "), true, "a node variable reassigned to another program stays denied");
  assert.equal(viaVar("N='/x/node.exe'; N+=x; "), true, "a node variable appended to stays denied");
  assert.equal(viaVar("N='/x/node.exe'; read N; "), true, "a node variable read from input stays denied");
  assert.equal(viaVar("N='/x/node.exe'; ", `for N in cat; do :; done; "$N" "$H" task verify htask_1`), true, "a node variable rebound by a loop stays denied");
  assert.equal(viaVar("N='/x/node.exe'; ", `"\${N%.exe}" "$H" task verify htask_1`), true, "a parameter-expansion form of the node variable stays denied");
  assert.equal(viaVar(""), true, "a node variable never assigned in the command stays denied");
  assert.equal(viaVar("", `"$N" "$H" task verify htask_1; N='/x/node.exe'`), true, "a node variable expanded before its assignment stays denied");
  assert.equal(viaVar("N='/x/node.exe'; ", `$N "$H" task verify htask_1`), true, "an unquoted node variable stays denied (it word-splits)");
  assert.equal(viaVar(`N="$(command -v cat)/node"; `), true, "a node path built by expansion stays denied");
  assert.equal(viaVar("N='/x/node.exe'; ", `"$N" "$H" task verify htask_1; cat "$H"`), true, "the entrypoint read elsewhere still denies it");
  assert.equal(viaVar("N='/home/dave/audited/node'; "), true, "a deny root inside the node path still matches");
  assert.equal(viaVar("", `'/usr/bin/cat' "$H" task verify htask_1`), true, "a quoted non-node program as the interpreter stays denied");
  assert.equal(viaVar("", `echo '/x/node.exe' "$H" task verify htask_1`), true, "a quoted node path that is only an argument stays denied");
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

test("task benchmark runs three arms from two checkouts and reports each Hunch arm vs no-hunch plus diet vs current", async () => {
  const diet = join(root, "diet");
  writeStubAudited(diet);
  put(diet, "package.json", JSON.stringify({ type: "module", version: "0.0.0-diet" }) + "\n");
  const dietCli = join(diet, "dist", "cli", "index.js");
  put(diet, "dist/cli/index.js", readFileSync(dietCli, "utf8") + "// diet build\n");
  const dietRevision = commit(diet, "diet build", "2026-01-02 00:00:00 +0000");
  // A diet checkout at a new revision whose built CLI is byte-identical to the audited one.
  const dietSame = join(root, "diet-same");
  writeStubAudited(dietSame);
  put(dietSame, "package.json", JSON.stringify({ type: "module", version: "0.0.0-diet-same" }) + "\n");
  commit(dietSame, "diet not rebuilt", "2026-01-02 00:00:00 +0000");
  const three: BenchmarkArm[] = ["no-hunch", "current-hunch", "diet-hunch"];
  const out3 = join(root, "out-three");
  const threeOpts: RunBenchmarkOptions = { ...opts, arms: [...three], runs: 1, output: out3, dietRoot: diet };
  const spawned = readLines(counter).length;

  assert.equal((await runBenchmark({ ...threeOpts, dietRoot: undefined })).exitCode, 1);
  assert.ok(logs.some((line) => line.includes("needs --diet-root")), logs.join("\n"));
  assert.equal((await runBenchmark({ ...opts, output: join(root, "out-refused"), dietRoot: diet })).exitCode, 1);
  assert.ok(logs.some((line) => line.includes("--diet-root is only accepted")), logs.join("\n"));
  assert.equal((await runBenchmark({ ...threeOpts, output: join(root, "out-diet-audited"), dietRoot: opts.audited })).exitCode, 1);
  assert.ok(logs.some((line) => line.includes("is the audited root")), logs.join("\n"));
  assert.equal((await runBenchmark({ ...threeOpts, output: join(root, "out-diet-same"), dietRoot: dietSame })).exitCode, 1);
  assert.ok(logs.some((line) => line.includes("identical to the audited build")), logs.join("\n"));
  assert.equal(readLines(counter).length, spawned, "refusals spawn nothing");

  assert.equal((await runBenchmark(threeOpts)).exitCode, 0, logs.join("\n"));
  const manifest = JSON.parse(readFileSync(join(out3, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.manifest.arms, three);
  assert.deepEqual(manifest.manifest.diet, {
    revision: dietRevision, version: "0.0.0-diet", cli_sha256: createHash("sha256").update(readFileSync(dietCli)).digest("hex"),
  });
  assert.match(manifest.manifest.diet.cli_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!("cli_sha256" in manifest.manifest.audited), "the audited object is unchanged");
  assert.notEqual(manifest.manifest.audited.revision, dietRevision);
  assert.equal(manifest.environment.diet_root, diet);
  assert.deepEqual(readLines(counter).slice(spawned), armOrder(SEED, TASK, 1, three), "the fixture agent saw each arm's own checkout");
  const dirs = readdirSync(join(out3, "runs", TASK)).sort();
  assert.deepEqual(dirs, ["1-current-hunch", "1-diet-hunch", "1-no-hunch"]);
  for (const dir of dirs) {
    const run = JSON.parse(readFileSync(join(out3, "runs", TASK, dir, "run.json"), "utf8")) as EfficiencyRun;
    assert.equal(run.status, "completed", `${dir}: ${run.isolation_evidence.join(" | ")}`);
    assert.equal(run.audited_hunch_revision,
      run.arm === "diet-hunch" ? dietRevision : run.arm === "current-hunch" ? manifest.manifest.audited.revision : null);
    assert.equal(run.memory_revision, run.arm === "no-hunch" ? null : manifest.manifest.tasks[0].snapshot.public.sha256);
    assert.equal(run.cost.background_wakeups, 0);
    assert.deepEqual(run.cost.hook_injections?.total, { injections: 0, chars: 0 }, "the fixture hook writes stdout only, not output");
  }
  const report = JSON.parse(readFileSync(join(out3, "report.json"), "utf8"));
  assert.deepEqual(report.arms, { baseline: "no-hunch", treatment: "current-hunch" });
  assert.deepEqual(report.additional_pairs.map((p: { arms: unknown }) => p.arms), [{ baseline: "no-hunch", treatment: "diet-hunch" }]);
  assert.deepEqual(report.diet_vs_current.tasks, [TASK]);
  assert.match(readFileSync(join(out3, "report.md"), "utf8"), /## diet-hunch vs current-hunch/);
  assert.equal((await runBenchmark({ ...threeOpts, dietRoot: undefined, reportOnly: true, recount: true })).exitCode, 0, logs.join("\n"));

  // The two-arm manifest carries no diet key and no diet_root, so its hash is what it was before diet-hunch existed.
  const twoArm = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.ok(!("diet" in twoArm.manifest) && !("diet_root" in twoArm.environment));
});

/** A temp dir outside every git work tree (a machine's TMPDIR can itself sit in one); null when there is none. */
function gitFreeDir(): string | null {
  for (const base of [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]) {
    const dir = mkdtempSync(join(base, "hunch-bench-token-"));
    try { execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore", windowsHide: true }); } catch { return dir; }
    rmSync(dir, { recursive: true, force: true });
  }
  return null;
}

function gitDirsUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git") found.push(join(dir, entry.name));
    else found.push(...gitDirsUnder(join(dir, entry.name)));
  }
  return found;
}

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("neutral user config: own config dir per run, token and its path never left under the output", async (t) => {
  const tokenDir = gitFreeDir();
  if (tokenDir === null) { t.skip("no temp dir outside a git work tree"); return; }
  const token = "sk-ant-oat01-E2EFIXTURE0123456789abcdef";
  const tokenFile = join(tokenDir, "oauth-token.txt");
  writeFileSync(tokenFile, token + "\n");
  const outN = join(root, "out-neutral");
  const nOpts: RunBenchmarkOptions = { ...opts, runs: 1, output: outN, oauthTokenFile: tokenFile, claudeHome: join(root, "claude-home") };
  const leaks = (dir: string) => filesUnder(dir).filter((file) => readFileSync(file).includes(token));
  try {
    assert.equal((await runBenchmark({ ...nOpts, output: join(root, "out-neutral-both"), inheritUserConfig: true })).exitCode, 1);
    assert.ok(logs.some((line) => line.includes("are exclusive")), logs.join("\n"));

    assert.equal((await runBenchmark(nOpts)).exitCode, 0, logs.join("\n"));
    const manifestText = readFileSync(join(outN, "manifest.json"), "utf8");
    const file = JSON.parse(manifestText);
    assert.equal(file.manifest.user_config, "neutral");
    assert.equal(file.manifest.oauth_token, "present");
    assert.equal(file.environment.user_config, "neutral");
    assert.equal(file.environment.oauth_token, "present");
    for (const text of [manifestText, ...["report.json", "report.md", "progress.log"].map((name) => readFileSync(join(outN, name), "utf8")), logs.join("\n")]) {
      assert.ok(!text.includes(token) && !text.includes(tokenFile) && !text.includes(tokenDir), "no token or token path recorded");
    }
    for (const dir of readdirSync(join(outN, "runs", TASK))) {
      const run = JSON.parse(readFileSync(join(outN, "runs", TASK, dir, "run.json"), "utf8")) as EfficiencyRun;
      assert.equal(run.status, "completed", `${dir}: ${run.isolation_evidence.join(" | ")}`);
      assert.ok(run.isolation_evidence.some((note) => /^token_redactions: [1-9]/.test(note)), run.isolation_evidence.join(" | "));
      assert.ok(existsSync(join(outN, "runs", TASK, dir, "claude-config")));
      assert.ok(existsSync(join(outN, "runs", TASK, dir, "repo-changes.patch")), `${dir}/repo-changes.patch`);
      assert.match(readFileSync(join(outN, "runs", TASK, dir, "repo-changes.patch"), "utf8"), /src\/sum\.mjs/);
      assert.ok(run.isolation_evidence.includes("repo/.git removed (neutral mode)"), run.isolation_evidence.join(" | "));
    }
    assert.deepEqual(leaks(outN), []);

    // An interrupted run (a crash left the token in a file and in a commit of its repo) is scrubbed and its .git
    // removed before it is moved aside; the rerun, whose agent also commits the token, leaves neither behind.
    const crashed = join(outN, "runs", TASK, "1-no-hunch");
    rmSync(join(crashed, "run.json"));
    writeFileSync(join(crashed, "crash-left.txt"), token);
    git(join(crashed, "repo"), ["init", "-q", "-b", "main"]);
    writeFileSync(join(crashed, "repo", "leaked-token.txt"), token);
    commit(join(crashed, "repo"), "leak", "2026-01-03 00:00:00 +0000");
    process.env.BENCH_FIXTURE_COMMIT_TOKEN = "1";
    assert.equal((await runBenchmark(nOpts)).exitCode, 0, logs.join("\n"));
    assert.ok(existsSync(join(outN, "runs", TASK, "1-no-hunch.interrupted-1")));
    assert.deepEqual(gitDirsUnder(join(outN, "runs")), []);
    assert.deepEqual(leaks(outN), []);
    assert.ok(existsSync(join(crashed, "repo-changes.patch")));

    // A token committed into the run repo cannot be redacted in place: the repo's .git is removed, the patch redacted.
    const outC = join(root, "out-neutral-commit");
    assert.equal((await runBenchmark({ ...nOpts, output: outC, arms: ["no-hunch", "current-hunch"] })).exitCode, 0, logs.join("\n"));
    for (const dir of readdirSync(join(outC, "runs", TASK))) {
      const run = JSON.parse(readFileSync(join(outC, "runs", TASK, dir, "run.json"), "utf8")) as EfficiencyRun;
      assert.ok(run.isolation_evidence.includes("repo/.git removed (neutral mode)"), run.isolation_evidence.join(" | "));
      assert.match(readFileSync(join(outC, "runs", TASK, dir, "repo-changes.patch"), "utf8"), /leaked-token\.txt[\s\S]*<redacted-oauth-token>/);
      assert.equal(existsSync(join(outC, "runs", TASK, dir, "repo", ".git")), false);
    }
    assert.deepEqual(leaks(outC), []);
  } finally {
    delete process.env.BENCH_FIXTURE_COMMIT_TOKEN;
    rmSync(tokenDir, { recursive: true, force: true });
  }
});
