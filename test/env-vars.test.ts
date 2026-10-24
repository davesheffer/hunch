/**
 * Real-effect tests for environment variables that had no coverage: adapter
 * config injection, harness obligation/probe injection, Codex/Cursor model
 * selection and the synthesis significance threshold. No model or network is
 * ever reached: provider CLIs are local fakes first on PATH, and module-load-time
 * variables are exercised in a fresh tsx child.
 */
import { cleanupDir, tempDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { __resetAvailabilityCacheForTests, resolveSynthesisProvider } from "../src/synthesis/provider.js";
import { compileExecutableProbes, environmentExecutableProbes, environmentExecutionObligations } from "../src/core/pipeline.js";

const IS_WIN = process.platform === "win32";
const SEP = IS_WIN ? ";" : ":";
const IDENTITY = ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "HUNCH_INITIATOR", "HUNCH_SYNTH_PROVIDER",
  "HUNCH_CLI_CONFIG", "HUNCH_REVIEW_CLI_CONFIG", "HUNCH_CODEX_MODEL", "HUNCH_CURSOR_MODEL", "HUNCH_SIG_MIN_LINES",
  "HUNCH_SYNTH_BASE_URL", "HUNCH_SYNTH_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

const FAKE = String.raw`
const fs = require("fs");
const name = process.argv[2];
const argv = process.argv.slice(3);
if (argv.includes("--version")) { process.stdout.write(name + " 0.0.0-fake\n"); process.exit(0); }
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, argv }) + "\n");
  if (name === "codex") process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fake prose" } }) + "\n");
  else process.stdout.write("fake prose");
});
`;

/** Fake claude/codex/cursor-agent so availability probes never reach a real CLI. */
function fakeBin(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "fake.cjs");
  writeFileSync(script, FAKE);
  for (const name of ["claude", "codex", "cursor-agent"]) {
    if (IS_WIN) writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" ${name} %*\r\n`);
    else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  return bin;
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of IDENTITY) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...overrides };
}

function inChild(script: string, env: NodeJS.ProcessEnv): string {
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout.trim().split("\n").at(-1)!;
}

const moduleUrl = (rel: string) => JSON.stringify(pathToFileURL(join(process.cwd(), rel)).href);

/** Select `provider` explicitly, draft prose through the fake CLI, return its argv. */
function providerArgv(provider: string, modelVar: string, model: string | undefined): string[] {
  const dir = tempDir("hunch-env-model-");
  try {
    const bin = fakeBin(dir);
    const log = join(dir, "calls.jsonl");
    const env = childEnv({ PATH: `${bin}${SEP}${process.env.PATH ?? ""}`, FAKE_LOG: log, HUNCH_SYNTH_PROVIDER: provider,
      ...(model === undefined ? {} : { [modelVar]: model }) });
    const out = inChild(`
      globalThis.fetch = async () => { throw new Error("network forbidden"); };
      const { resolveSynthesisProvider } = await import(${moduleUrl("src/synthesis/provider.ts")});
      const r = await resolveSynthesisProvider();
      if (r.provider.name !== ${JSON.stringify(provider)}) throw new Error("selected " + r.provider.name);
      await r.provider.draftProse("hello");
      console.log("ok");
    `, env);
    assert.equal(out, "ok");
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] });
    assert.equal(calls.length, 1);
    return calls[0]!.argv;
  } finally {
    cleanupDir(dir);
  }
}

const modelFlag = (argv: string[]) => (argv.includes("-m") ? argv[argv.indexOf("-m") + 1] : null);

test("HUNCH_CODEX_MODEL reaches codex exec as -m; an unsafe id or no value omits the flag", { timeout: 120_000 }, () => {
  assert.equal(modelFlag(providerArgv("codex-cli", "HUNCH_CODEX_MODEL", "gpt-5.1-codex")), "gpt-5.1-codex");
  assert.equal(modelFlag(providerArgv("codex-cli", "HUNCH_CODEX_MODEL", "x;calc&rm -rf /")), null, "shell metacharacters never reach argv");
  const plain = providerArgv("codex-cli", "HUNCH_CODEX_MODEL", undefined);
  assert.equal(modelFlag(plain), null);
  assert.deepEqual([plain[0], plain.at(-1)], ["exec", "-"]);
});

test("HUNCH_CURSOR_MODEL reaches cursor-agent as -m; an unsafe id or no value omits the flag", { timeout: 120_000 }, () => {
  assert.equal(modelFlag(providerArgv("cursor-agent", "HUNCH_CURSOR_MODEL", "sonnet-4.5")), "sonnet-4.5");
  assert.equal(modelFlag(providerArgv("cursor-agent", "HUNCH_CURSOR_MODEL", "bad model $(id)")), null);
  const plain = providerArgv("cursor-agent", "HUNCH_CURSOR_MODEL", undefined);
  assert.equal(modelFlag(plain), null);
  assert.ok(plain.includes("-p") && plain.includes("--trust"));
});

/** isSignificant() for a body-less, single-file, non-structural change of `lines` lines. */
function significant(sigMinLines: string | undefined, lines: number[]): boolean[] {
  const env = childEnv(sigMinLines === undefined ? {} : { HUNCH_SIG_MIN_LINES: sigMinLines });
  return JSON.parse(inChild(`
    const { isSignificant } = await import(${moduleUrl("src/synthesis/synthesize.ts")});
    const a = (n) => ({ addedSymbols: [], removedSymbols: [], changedSymbols: [], addedDeps: [], removedDeps: [], addedLines: n, removedLines: 0 });
    console.log(JSON.stringify(${JSON.stringify(lines)}.map((n) => isSignificant({ body: "" }, a(n), ["src/a.ts"]))));
  `, env)) as boolean[];
}

test("HUNCH_SIG_MIN_LINES moves the churn threshold for model synthesis; garbage keeps the default 12", { timeout: 120_000 }, () => {
  assert.deepEqual(significant(undefined, [11, 12]), [false, true], "default threshold is 12 lines");
  assert.deepEqual(significant("4", [3, 4, 11]), [false, true, true], "lower threshold makes small diffs significant");
  assert.deepEqual(significant("20", [12, 19, 20]), [false, false, true], "higher threshold demotes mid-size diffs");
  assert.deepEqual(significant("abc", [11, 12]), [false, true], "non-numeric falls back to 12");
  assert.deepEqual(significant("0", [11, 12]), [false, true], "zero falls back to 12");
});

test("HUNCH_SIG_MIN_LINES negative value should fall back to the default", () => {
  assert.deepEqual(significant("-5", [0, 11, 12]), [false, false, true]);
});

// ---------------------------------------------------------------- adapter configs

function withFakePath<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = tempDir("hunch-env-config-");
  const saved = process.env.PATH;
  process.env.PATH = `${fakeBin(dir)}${SEP}${saved ?? ""}`;
  __resetAvailabilityCacheForTests();
  return fn(dir).finally(() => {
    process.env.PATH = saved;
    __resetAvailabilityCacheForTests();
    cleanupDir(dir);
  });
}

const adapter = (name: string, probe: string) => ({
  name, command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], protocol: "stdin", probe_args: ["-e", probe],
});
const resolveFor = (env: NodeJS.ProcessEnv) => resolveSynthesisProvider({ env: { PATH: process.env.PATH, HUNCH_INITIATOR: "acme-agent", ...env } });

test("HUNCH_CLI_CONFIG: a valid adapter file binds a non-builtin initiator; without it the initiator is unavailable", { timeout: 60_000 }, async () => {
  await withFakePath(async (dir) => {
    const config = join(dir, "agents.json");
    writeFileSync(config, JSON.stringify([adapter("acme-agent", "process.exit(0)")]));
    const bound = await resolveFor({ HUNCH_CLI_CONFIG: config });
    assert.equal(bound.provider.name, "acme-agent");
    assert.equal(bound.source, "initiator");

    const unset = await resolveFor({});
    assert.equal(unset.source, "unavailable-initiator");
    assert.equal(unset.provider.name, "deterministic");

    writeFileSync(config, JSON.stringify([adapter("acme-agent", "process.exit(3)")]));
    const failingProbe = await resolveFor({ HUNCH_CLI_CONFIG: config });
    assert.equal(failingProbe.source, "unavailable-initiator", "an adapter whose probe fails is never selected");
  });
});

test("HUNCH_CLI_CONFIG: malformed, schema-invalid, oversized, directory, missing and traversal paths are refused before any adapter runs", { timeout: 60_000 }, async () => {
  await withFakePath(async (dir) => {
    const marker = join(dir, "probe-ran");
    const probe = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`;
    const write = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };
    const cases: Record<string, string> = {
      malformed: write("bad.json", "{ not json"),
      schema: write("schema.json", JSON.stringify([adapter("acme-agent", probe), { ...adapter("other", probe), shell: true }])),
      badName: write("name.json", JSON.stringify([adapter("Acme Agent", probe)])),
      duplicate: write("dup.json", JSON.stringify([adapter("acme-agent", probe), adapter("acme-agent", probe)])),
      oversized: write("big.json", JSON.stringify([{ ...adapter("acme-agent", probe), pad: "x".repeat(70 * 1024) }])),
      directory: dir,
      missing: join(dir, "nope.json"),
      traversal: join(dir, "..", "..", "..", "..", "..", "..", "..", "..", "package.json"),
    };
    for (const [label, path] of Object.entries(cases)) {
      await assert.rejects(resolveFor({ HUNCH_CLI_CONFIG: path }), Error, label);
    }
    assert.equal(existsSync(marker), false, "no adapter from a refused config was ever spawned");
  });
});

test("HUNCH_REVIEW_CLI_CONFIG is honoured as the adapter config fallback, and HUNCH_CLI_CONFIG takes precedence", { timeout: 60_000 }, async () => {
  await withFakePath(async (dir) => {
    const good = join(dir, "good.json");
    const other = join(dir, "other.json");
    writeFileSync(good, JSON.stringify([adapter("acme-agent", "process.exit(0)")]));
    writeFileSync(other, JSON.stringify([adapter("other-agent", "process.exit(0)")]));
    const review = await resolveFor({ HUNCH_REVIEW_CLI_CONFIG: good });
    assert.equal(review.provider.name, "acme-agent");
    assert.equal(review.source, "initiator");
    const cliWins = await resolveFor({ HUNCH_CLI_CONFIG: other, HUNCH_REVIEW_CLI_CONFIG: good });
    assert.equal(cliWins.source, "unavailable-initiator", "HUNCH_CLI_CONFIG shadows the review config");
    await assert.rejects(resolveFor({ HUNCH_REVIEW_CLI_CONFIG: join(dir, "missing.json") }), Error);
  });
});

// ---------------------------------------------------------------- harness injection

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { fn(); } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
}

const obligation = (id: string) => ({
  id, origin: "episode", category: "behavior", phase: "after-edit", description: "run the focused test",
  command_alternatives: [["npm", "test"]], expected: { success: true, output_includes: ["pass"] },
});

test("HUNCH_EXECUTION_OBLIGATIONS: valid JSON arms obligations; unset, malformed, non-array and invalid entries arm nothing", () => {
  withEnv("HUNCH_EXECUTION_OBLIGATIONS", undefined, () => assert.deepEqual(environmentExecutionObligations(), []));
  withEnv("HUNCH_EXECUTION_OBLIGATIONS", "", () => assert.deepEqual(environmentExecutionObligations(), []));
  withEnv("HUNCH_EXECUTION_OBLIGATIONS", "[{oops", () => assert.deepEqual(environmentExecutionObligations(), []));
  withEnv("HUNCH_EXECUTION_OBLIGATIONS", JSON.stringify(obligation("one")), () => assert.deepEqual(environmentExecutionObligations(), []));
  withEnv("HUNCH_EXECUTION_OBLIGATIONS", JSON.stringify([
    obligation("ok-1"), { ...obligation("bad id!") }, { ...obligation("bad-phase"), phase: "whenever" },
    { ...obligation("no-expect"), expected: {} }, obligation("ok-1"), obligation("ok-2"),
  ]), () => {
    const armed = environmentExecutionObligations();
    assert.deepEqual(armed.map((o) => o.id), ["ok-1", "ok-2"], "invalid and duplicate entries are dropped");
    assert.deepEqual(armed[0]!.command_alternatives, [["npm", "test"]]);
    assert.equal(armed[0]!.expected.success, true);
  });
});

const probe = (id: string, extra: Record<string, unknown> = {}) => ({
  id, origin: "episode", category: "behavior", claim: "the parser rejects empty input", falsifier: "empty input parses",
  command: "node probe.mjs", command_alternatives: [["node", "probe.mjs"]],
  expected_before: { success: false }, expected_after: { success: true }, ...extra,
});

test("HUNCH_EXECUTABLE_PROBES: a valid probe compiles to a baseline and a validation obligation; unsafe or malformed probes compile to nothing", () => {
  withEnv("HUNCH_EXECUTABLE_PROBES", undefined, () => assert.deepEqual(environmentExecutableProbes(), []));
  withEnv("HUNCH_EXECUTABLE_PROBES", "not json", () => assert.deepEqual(environmentExecutableProbes(), []));
  withEnv("HUNCH_EXECUTABLE_PROBES", JSON.stringify([probe("p1")]), () => {
    const compiled = compileExecutableProbes(environmentExecutableProbes());
    assert.deepEqual(compiled.map((o) => [o.id, o.phase, o.expected.success]), [["p1:baseline", "before-edit", false], ["p1:validation", "after-edit", true]]);
  });
  withEnv("HUNCH_EXECUTABLE_PROBES", JSON.stringify([
    probe("escape", { artifact: { path: ".hunch-probes/../../evil.mjs", content: "x" } }),
    probe("outside", { artifact: { path: "src/evil.mjs", content: "x" } }),
    probe("kept", { artifact: { path: ".hunch-probes/p.mjs", content: "process.exit(0)" } }),
  ]), () => {
    const probes = environmentExecutableProbes();
    assert.deepEqual(probes.map((p) => p.id), ["kept"], "artifact paths outside .hunch-probes/ are refused");
    assert.equal(probes[0]!.artifact?.path, ".hunch-probes/p.mjs");
  });
  withEnv("HUNCH_EXECUTABLE_PROBES", JSON.stringify([probe("no-falsifier", { falsifier: "" }), probe("a"), probe("b"), probe("c")]), () => {
    assert.deepEqual(environmentExecutableProbes().map((p) => p.id), ["a", "b"], "invalid probes are dropped; at most 3 entries are read");
  });
});
