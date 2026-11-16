import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

/** #512: the traced run records what the CLI actually parsed and which env vars were read,
 *  and tooling/trace-gate.mjs fails a registry entry that claims coverage no run exercised. */
const ROOT = process.cwd();
const REGISTER = pathToFileURL(join(ROOT, "tooling/test-trace-register.mjs")).href;
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(ROOT, "src/cli/index.ts");
type Trace = { argv1: string | null; cli: string[]; env: string[] };

function traced(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Trace[] {
  const run = spawnSync(process.execPath, args, {
    cwd: dir, encoding: "utf8", timeout: 120_000,
    env: isolatedCliEnv({ ...env, HUNCH_TEST_TRACE: join(dir, "trace"), NODE_OPTIONS: `--import=${JSON.stringify(REGISTER)}` }),
  });
  assert.equal(run.error, undefined);
  assert.doesNotMatch(run.stderr, /only accepts|ERR_INVALID_OBJECT_DEFINE_PROPERTY/, "the env proxy must forward writes");
  assert.notEqual(run.status, 3, `env writes did not take effect: ${run.stderr}`);
  if (args.includes("--json")) assert.ok(JSON.parse(run.stdout), "the traced CLI still prints its report");
  return readdirSync(join(dir, "trace")).flatMap((f) => readFileSync(join(dir, "trace", f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Trace));
}

test("trace register records the CLI's parsed flags keyed like the options registry, and env reads but not env copies", (t) => {
  const dir = tempDir("hunch-trace-");
  t.after(() => cleanupDir(dir));
  // The CLI records its own flags (src/cli/testTrace.ts), so the bundled dist CLI does too.
  // HUNCH_INITIATOR set: the preAction hook then assigns process.env, which must not throw.
  const cli = traced(dir, [TSX, CLI, "--initiator", "claude", "integrations", "check", "--harness", "claude", "--json"], { HUNCH_INITIATOR: "claude" })
    .filter((r) => r.cli.length);
  assert.equal(cli.length, 1, JSON.stringify(cli));
  assert.deepEqual(cli[0]!.cli, ["--initiator", "integrations check --harness", "integrations check --json"]);

  const script = join(dir, "env.mjs");
  writeFileSync(script, [
    "import { spawnSync } from 'node:child_process';",
    // Copies enumerate then read every key: none of them is a read of HUNCH_TRACE_COPIED_ONLY.
    "void Object.entries(process.env); void JSON.stringify(process.env); spawnSync(process.execPath, ['-e', ''], { env: process.env });",
    "if (Object.hasOwn(process.env, 'HUNCH_TRACE_OWN')) void process.env.HUNCH_TRACE_OWN;",
    "const copy = { ...process.env }; void copy; void process.env.HUNCH_TRACE_READ; void ('HUNCH_TRACE_IN' in process.env);",
    // Writes go straight through: assignment over an existing variable, Object.assign, delete.
    "process.env.PATH = process.env.PATH; process.env.HUNCH_TRACE_SET = '1'; void process.env.HUNCH_TRACE_SET;",
    "Object.assign(process.env, { HUNCH_TRACE_READ: '2' }); delete process.env.HUNCH_TRACE_EMPTY;",
    "if (process.env.HUNCH_TRACE_READ !== '2' || 'HUNCH_TRACE_EMPTY' in process.env) process.exit(3);",
  ].join("\n"));
  const [rec] = traced(dir, [script], { HUNCH_TRACE_READ: "1", HUNCH_TRACE_IN: "1", HUNCH_TRACE_OWN: "1", HUNCH_TRACE_COPIED_ONLY: "1", HUNCH_TRACE_EMPTY: "" }).filter((r) => r.argv1 === script);
  assert.ok(rec, "the plain script wrote its trace");
  assert.ok(["HUNCH_TRACE_READ", "HUNCH_TRACE_IN", "HUNCH_TRACE_SET", "HUNCH_TRACE_OWN"].every((n) => rec.env.includes(n)), rec.env.join(","));
  assert.equal(rec.env.includes("HUNCH_TRACE_COPIED_ONLY"), false, `copying the environment is not a read: ${rec.env.join(",")}`);
  assert.deepEqual(rec.cli, [], "a non-CLI process records no flags");
});

test("trace gate fails a claimed-but-unexercised entry, honours and ratchets the baseline", (t) => {
  const dir = tempDir("hunch-trace-gate-");
  t.after(() => cleanupDir(dir));
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "trace", "shard-1"), { recursive: true });
  const covered = { tests: [{ file: "test/x.test.ts", title: "x" }] };
  writeFileSync(join(dir, "test/cli-options-surface.json"), JSON.stringify({ "a --seen": covered, "a --unseen": covered, "a --todo": { todo: "later" } }));
  writeFileSync(join(dir, "test/env-surface.json"), JSON.stringify({ SEEN_VAR: covered, UNSEEN_VAR: covered }));
  writeFileSync(join(dir, "trace/shard-1/trace-shard-1.jsonl"), `${JSON.stringify({ cli: ["a --seen"], env: ["SEEN_VAR"] })}\n`);
  const baseline = join(dir, "baseline.json");
  const gate = (...extra: string[]) => spawnSync(process.execPath, [join(ROOT, "tooling/trace-gate.mjs"), "--root", dir, "--dir", join(dir, "trace"), "--baseline", baseline, ...extra], { encoding: "utf8" });

  const fail = gate();
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
  assert.match(fail.stderr, /cli a --unseen: listed as covered, but no test exercised it/);
  assert.match(fail.stderr, /env UNSEEN_VAR: listed as covered/);
  assert.doesNotMatch(fail.stderr, /a --seen\b|env SEEN_VAR|a --todo/);

  assert.equal(gate("--seed", "--expect-shards", "1").status, 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(baseline, "utf8")).cli), ["a --unseen"]);
  const pass = gate();
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);

  writeFileSync(join(dir, "trace/shard-1/trace-2-2.jsonl"), `${JSON.stringify({ cli: ["a --unseen"], env: [] })}\n`);
  const shrink = gate();
  assert.equal(shrink.status, 0);
  assert.match(shrink.stdout, /cli a --unseen: now exercised; delete it from the baseline/);

  writeFileSync(join(dir, "trace/shard-1/trace-shard-1.jsonl"), "");
  const partial = gate("--expect-shards", "2");
  assert.equal(partial.status, 1, "an empty or missing shard is partial evidence");
  assert.match(partial.stderr, /trace-shard-1\.jsonl.*\(empty\)/);
  writeFileSync(join(dir, "trace/shard-1/trace-shard-1.jsonl"), `${JSON.stringify({ cli: [], env: ["SEEN_VAR"] })}\n`);
  const noCli = gate("--expect-shards", "1");
  assert.equal(noCli.status, 1, "a shard that never reached the CLI is partial evidence");
  assert.match(noCli.stderr, /trace-shard-1\.jsonl has no CLI record/);
  for (const value of ["0", "x", "1.5"]) {
    const usage = gate("--expect-shards", value);
    assert.equal(usage.status, 2, `--expect-shards ${value} is a usage error`);
    assert.match(usage.stderr, /--expect-shards needs an integer >= 1/);
  }
  assert.equal(gate("--expect-shards").status, 2, "a bare --expect-shards is a usage error");
  const seedAlone = gate("--seed");
  assert.equal(seedAlone.status, 2, "--seed without --expect-shards would seed from partial evidence");
  assert.match(seedAlone.stderr, /--seed needs --expect-shards/);

  writeFileSync(join(dir, "trace/shard-1/trace-3-3.jsonl"), `${JSON.stringify({ cli: [], env: [] })}\n${JSON.stringify({ cli: "a --seen", env: [] })}\n`);
  const shape = gate();
  assert.equal(shape.status, 1);
  assert.match(shape.stderr, /trace-3-3\.jsonl:2: invalid trace record/);
  assert.doesNotMatch(shape.stderr, /\n\s+at /, "no stack trace");
  writeFileSync(join(dir, "trace/shard-1/trace-3-3.jsonl"), "");

  // A coverage gap (UNSEEN_VAR is not frozen once the baseline is gone) passes report-only.
  writeFileSync(baseline, JSON.stringify({ cli: {}, env: {} }));
  const strict = gate();
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  const report = gate("--report-only");
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.match(report.stderr, /ERROR env UNSEEN_VAR: listed as covered/);

  writeFileSync(join(dir, "trace/shard-1/trace-bad.jsonl"), "{\"cli\": [\n");
  const bad = gate();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /trace-bad\.jsonl:1: unreadable trace record/);

  const none = spawnSync(process.execPath, [join(ROOT, "tooling/trace-gate.mjs"), "--root", dir, "--dir", join(dir, "empty")], { encoding: "utf8" });
  assert.equal(none.status, 1, "no evidence is a failure, never a pass");
});

test("the compiled hook fast path records hook --provider under HUNCH_TEST_TRACE", (t) => {
  const dist = join(ROOT, "dist/cli/index.js");
  if (!existsSync(dist)) { t.skip("dist/cli/index.js not built"); return; }
  const dir = tempDir("hunch-trace-hook-");
  t.after(() => cleanupDir(dir));
  const run = spawnSync(process.execPath, [dist, "hook", "--provider", "claude"], {
    cwd: dir, encoding: "utf8", input: "", timeout: 120_000,
    env: isolatedCliEnv({ HUNCH_TEST_TRACE: join(dir, "trace") }),
  });
  assert.equal(run.error, undefined);
  const keys = existsSync(join(dir, "trace")) ? readdirSync(join(dir, "trace")).flatMap((f) => readFileSync(join(dir, "trace", f), "utf8").trim().split("\n").flatMap((l) => (JSON.parse(l) as Trace).cli)) : [];
  assert.ok(keys.includes("hook --provider"), `${keys.join(",")} ${run.stderr}`);
});
