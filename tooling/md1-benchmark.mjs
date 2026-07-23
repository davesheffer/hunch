#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const BENCHMARK_BASELINE_REF = "610cd2e5673bf3c69ac984b4737e2d4a749ed374";
export const BENCHMARK_SCHEMA = "hunch.md1a.performance.v1";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const FIXTURE_DATE = "2026-07-10T10:00:00.000Z";
const FIXTURE_GIT_DATE = "2026-07-10T10:00:00Z";
const DEFAULTS = Object.freeze({ samples: 10, many: 16, files: 48 });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function integer(value, flag, minimum) {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`${flag} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${flag} must be at least ${minimum}`);
  return parsed;
}

function help() {
  return [
    "Deterministic MD-1a baseline/current performance benchmark.",
    "",
    "Usage: npm run bench:md1 -- [options]",
    "",
    `  --samples <n>     timed samples per case (default ${DEFAULTS.samples})`,
    `  --many <n>        bounded-many correction count (default ${DEFAULTS.many})`,
    `  --files <n>       deterministic TypeScript fixture files (default ${DEFAULTS.files})`,
    "  --case <selector> run only operation:home:count; repeatable",
    "                    operations: index, sync; homes: public, split_private",
    "                    count: 0, 1, many, or the exact --many value",
    "  --output <file>   atomically write the JSON receipt in addition to stdout",
    "  --keep-temp       retain disposable fixtures (path is printed to stderr)",
    "  --help            show this help",
    "",
    "The benchmark uses no remotes, forces deterministic synthesis, and routes all",
    "proxy variables to a closed loopback port. Fixture construction and one warm-up",
    "are outside timed samples. Peak RSS uses /usr/bin/time on macOS or Linux.",
  ].join("\n");
}

export function parseBenchmarkArgs(argv) {
  const parsed = { ...DEFAULTS, cases: [], output: null, keepTemp: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--keep-temp") parsed.keepTemp = true;
    else if (["--samples", "--many", "--files", "--case", "--output"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--samples") parsed.samples = integer(value, arg, 1);
      else if (arg === "--many") parsed.many = integer(value, arg, 2);
      else if (arg === "--files") parsed.files = integer(value, arg, 2);
      else if (arg === "--case") parsed.cases.push(value);
      else parsed.output = value;
      index += 1;
    } else throw new Error(`unknown benchmark argument: ${arg}`);
  }
  if (parsed.files < parsed.many) throw new Error("--files must be at least --many so every correction has a distinct concrete file");
  return parsed;
}

export function benchmarkScenarios(many) {
  const scenarios = [];
  for (const operation of ["index", "sync"]) {
    for (const home of ["public", "split_private"]) {
      for (const activeCorrections of [0, 1, many]) {
        scenarios.push({
          id: `${operation}.${home}.${activeCorrections}`,
          operation,
          home,
          active_corrections: activeCorrections,
        });
      }
    }
  }
  return scenarios;
}

function selectScenarios(options) {
  const all = benchmarkScenarios(options.many);
  if (!options.cases.length) return all;
  const selected = new Set(options.cases.map((selector) => {
    const [operation, home, rawCount, extra] = selector.split(":");
    const count = rawCount === "many" ? options.many : Number(rawCount);
    if (extra !== undefined || !["index", "sync"].includes(operation)
      || !["public", "split_private"].includes(home)
      || ![0, 1, options.many].includes(count)) {
      throw new Error(`invalid --case ${selector}; expected operation:home:count from the configured matrix`);
    }
    return `${operation}.${home}.${count}`;
  }));
  return all.filter((scenario) => selected.has(scenario.id));
}

function nearestRank(values, percentile) {
  if (!values.length) throw new Error("cannot summarize an empty sample set");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
}

export function summarizeSamples(samples) {
  if (!samples.length) throw new Error("cannot summarize an empty sample set");
  const summary = (key) => {
    const values = samples.map((sample) => sample[key]);
    return {
      min: Math.min(...values),
      p50: nearestRank(values, 0.5),
      p95: nearestRank(values, 0.95),
      max: Math.max(...values),
    };
  };
  return { wall_ms: summary("wall_ms"), peak_rss_bytes: summary("peak_rss_bytes") };
}

function run(command, args, options = {}) {
  const child = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const detail = [child.stderr, child.stdout].map((value) => value?.trim()).filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit ${child.status}${detail ? `:\n${detail}` : ""}`);
  }
  return { stdout: child.stdout, stderr: child.stderr, status: child.status };
}

function git(cwd, args, env = {}) {
  return run("git", args, { cwd, env: { ...process.env, ...env } }).stdout.trim();
}

function write(root, file, value) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function writeHunchJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, file);
}

function walkFiles(root, relativeRoot = "") {
  const dir = join(root, relativeRoot);
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

function sourceHash(root) {
  const files = [
    ...walkFiles(root, "src"),
    ...["package.json", "package-lock.json"].filter((file) => existsSync(join(root, file))),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function baselineCheckout(temp) {
  const commit = git(projectRoot, ["rev-parse", `${BENCHMARK_BASELINE_REF}^{commit}`]);
  if (commit !== BENCHMARK_BASELINE_REF) throw new Error(`pinned baseline ${BENCHMARK_BASELINE_REF} did not resolve exactly`);
  const target = join(temp, "baseline-source");
  run("git", ["clone", "-q", "--shared", "--no-checkout", projectRoot, target]);
  git(target, ["checkout", "-q", "--detach", BENCHMARK_BASELINE_REF]);
  if (!existsSync(join(projectRoot, "node_modules"))) throw new Error("node_modules is missing; run npm install before benchmarking");
  symlinkSync(join(projectRoot, "node_modules"), join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return target;
}

function isolatedEnvironment(home) {
  mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "HUNCH_PRIVATE_DIR" || key.endsWith("_API_KEY") || key.endsWith("_TOKEN")) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    HUNCH_SYNTH_PROVIDER: "deterministic",
    HUNCH_EMBEDDER: "none",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
    no_proxy: "",
  });
  return env;
}

function cliArgs(targetSource, args) {
  return [tsxCli, join(targetSource, "src", "cli", "index.ts"), ...args];
}

function runCli(targetSource, fixture, args, env) {
  return run(process.execPath, cliArgs(targetSource, args), { cwd: fixture.root, env });
}

function parsePeakRss(stderr) {
  if (process.platform === "darwin") {
    const match = stderr.match(/^\s*(\d+)\s+maximum resident set size\s*$/m);
    if (!match) throw new Error("could not parse macOS /usr/bin/time peak RSS");
    return Number(match[1]);
  }
  if (process.platform === "linux") {
    const match = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    if (!match) throw new Error("could not parse GNU /usr/bin/time peak RSS");
    return Number(match[1]) * 1024;
  }
  throw new Error("peak RSS measurement requires macOS or Linux /usr/bin/time");
}

function measureCli(targetSource, fixture, args, env) {
  if (!existsSync("/usr/bin/time")) throw new Error("peak RSS measurement requires /usr/bin/time");
  const timeFlag = process.platform === "darwin" ? "-l" : process.platform === "linux" ? "-v" : null;
  if (!timeFlag) throw new Error("peak RSS measurement is supported on macOS and Linux");
  const started = process.hrtime.bigint();
  const measured = run("/usr/bin/time", [timeFlag, process.execPath, ...cliArgs(targetSource, args)], {
    cwd: fixture.root,
    env,
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    wall_ms: Number(wallMs.toFixed(3)),
    peak_rss_bytes: parsePeakRss(measured.stderr),
  };
}

function fixtureSource(index, total) {
  const id = String(index).padStart(3, "0");
  const next = String((index + 1) % total).padStart(3, "0");
  return [
    `import { helper${next} } from "./module-${next}.js";`,
    `export function entry${id}(value: number): number {`,
    `  return helper${id}(value) + helper${next}(value);`,
    "}",
    `export function helper${id}(value: number): number {`,
    `  return value + ${index + 1};`,
    "}",
    `export function normalize${id}(value: number): number {`,
    `  return entry${id}(Math.max(0, value));`,
    "}",
    "",
  ].join("\n");
}

function initializeGitFixture(root, fileCount) {
  mkdirSync(root, { recursive: true });
  write(root, "package.json", JSON.stringify({
    name: "hunch-md1a-benchmark-fixture",
    private: true,
    type: "module",
    dependencies: { axios: "1.7.0" },
  }, null, 2) + "\n");
  for (let index = 0; index < fileCount; index += 1) {
    write(root, `src/module-${String(index).padStart(3, "0")}.ts`, fixtureSource(index, fileCount));
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Hunch Benchmark"]);
  git(root, ["config", "user.email", "benchmark@example.invalid"]);
  git(root, ["add", "package.json", "src"]);
  git(root, ["commit", "-qm", "fixture: deterministic MD-1a benchmark corpus"], {
    GIT_AUTHOR_NAME: "Hunch Benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
    GIT_AUTHOR_DATE: FIXTURE_GIT_DATE,
    GIT_COMMITTER_NAME: "Hunch Benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
    GIT_COMMITTER_DATE: FIXTURE_GIT_DATE,
  });
  return git(root, ["rev-parse", "HEAD"]);
}

function initializeMemoryHome(hunchDir) {
  mkdirSync(hunchDir, { recursive: true });
  writeHunchJson(join(hunchDir, "manifest.json"), { schema_version: 2 });
}

function correctionRecord(index) {
  const id = String(index).padStart(3, "0");
  return {
    id: `con_bench_${id}`,
    type: "architecture",
    statement: `Never import axios in benchmark module ${id}.`,
    scope: [`src/module-${id}.ts`],
    severity: "blocking",
    enforcement: "advisory_v1",
    match: null,
    forbids: { deps: ["axios"], symbols: [], patterns: [] },
    rationale: "Deterministic MD-1a benchmark correction.",
    source_decision: null,
    violations: [],
    status: "active",
    valid_from: FIXTURE_DATE,
    valid_to: null,
    provenance: {
      source: "human_confirmed",
      confidence: 1,
      evidence: ["md1a-performance-fixture"],
      last_verified: FIXTURE_DATE,
    },
  };
}

function countJsonFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")).length : 0;
}

function policyStates(hunchDir) {
  const dir = join(hunchDir, "policies");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => {
    const value = JSON.parse(readFileSync(join(dir, file), "utf8"));
    return value.state;
  });
}

function assertNoAuthority(fixture) {
  for (const hunchDir of [fixture.publicHunch, fixture.privateHunch].filter(Boolean)) {
    const active = policyStates(hunchDir).filter((state) => state === "active_advisory" || state === "active_blocking");
    if (active.length) throw new Error("benchmark setup unexpectedly activated a correction-derived policy");
  }
}

function createFixture(temp, variant, targetSource, scenario, fileCount, selectedOperations, env) {
  const slug = `${variant}-${scenario.home}-${scenario.active_corrections}`;
  const root = join(temp, "fixtures", slug, "repository");
  const publicHunch = join(root, ".hunch");
  const commit = initializeGitFixture(root, fileCount);
  initializeMemoryHome(publicHunch);

  let privateHunch = null;
  if (scenario.home === "split_private") {
    const overlayRoot = join(temp, "fixtures", slug, "overlay");
    mkdirSync(overlayRoot, { recursive: true });
    git(overlayRoot, ["init", "-q"]);
    privateHunch = join(overlayRoot, ".hunch");
    initializeMemoryHome(privateHunch);
    writeHunchJson(join(publicHunch, "local.json"), {
      privateDir: privateHunch,
      mode: "private",
      autoCommit: false,
    });
  } else {
    writeHunchJson(join(publicHunch, "local.json"), { autoCommit: false });
  }

  const fixture = { root, publicHunch, privateHunch, commit };
  runCli(targetSource, fixture, ["index"], env);
  runCli(targetSource, fixture, [
    "sync", "HEAD", "--quiet", "--no-commit",
    ...(scenario.home === "split_private" ? ["--private"] : []),
  ], env);

  const correctionHome = privateHunch ?? publicHunch;
  mkdirSync(join(correctionHome, "constraints"), { recursive: true });
  for (let index = 0; index < scenario.active_corrections; index += 1) {
    const correction = correctionRecord(index);
    writeHunchJson(join(correctionHome, "constraints", `${correction.id}.json`), correction);
  }

  const warmIndex = runCli(targetSource, fixture, ["index"], env);
  if (selectedOperations.has("sync")) {
    runCli(targetSource, fixture, [
      "sync", "HEAD", "--quiet", "--no-commit",
      ...(scenario.home === "split_private" ? ["--private"] : []),
    ], env);
  }

  const correctionCount = countJsonFiles(join(correctionHome, "constraints"));
  if (correctionCount !== scenario.active_corrections) {
    throw new Error(`fixture ${slug} has ${correctionCount} corrections, expected ${scenario.active_corrections}`);
  }
  const policyCount = countJsonFiles(join(correctionHome, "policies"));
  if (scenario.home === "split_private") {
    const leakedPublicRecords = ["constraints", "policies", "plans", "proofs", "evidence"]
      .reduce((total, kind) => total + countJsonFiles(join(publicHunch, kind)), 0);
    if (leakedPublicRecords !== 0) {
      throw new Error(`split-private fixture ${slug} leaked ${leakedPublicRecords} private correction artifact(s) into the public home`);
    }
  }
  if (variant === "current" && scenario.active_corrections > 0) {
    if (!warmIndex.stdout.includes("correction reviews:")) throw new Error(`current fixture ${slug} did not observe automatic correction retry`);
    if (policyCount !== scenario.active_corrections) {
      throw new Error(`current fixture ${slug} proved ${policyCount} policies, expected ${scenario.active_corrections}`);
    }
  }
  if (variant === "baseline" && policyCount !== 0) throw new Error(`baseline fixture ${slug} unexpectedly created MD-1a policies`);
  assertNoAuthority(fixture);
  const remotes = git(root, ["remote"]).split("\n").filter(Boolean).length
    + (privateHunch ? git(dirname(privateHunch), ["remote"]).split("\n").filter(Boolean).length : 0);
  if (remotes !== 0) throw new Error(`fixture ${slug} unexpectedly has ${remotes} git remote(s)`);
  return { ...fixture, prepared_policies: policyCount, remotes };
}

function operationArgs(scenario) {
  if (scenario.operation === "index") return ["index"];
  return [
    "sync", "HEAD", "--quiet", "--no-commit",
    ...(scenario.home === "split_private" ? ["--private"] : []),
  ];
}

function ratio(current, baseline) {
  return baseline === 0 ? null : Number((current / baseline).toFixed(4));
}

function comparisonFor(scenario, baselineCase, currentCase) {
  const measure = (field) => ({
    p50_delta: Number((currentCase.summary[field].p50 - baselineCase.summary[field].p50).toFixed(3)),
    p50_ratio: ratio(currentCase.summary[field].p50, baselineCase.summary[field].p50),
    p95_delta: Number((currentCase.summary[field].p95 - baselineCase.summary[field].p95).toFixed(3)),
    p95_ratio: ratio(currentCase.summary[field].p95, baselineCase.summary[field].p95),
  });
  return {
    scenario: scenario.id,
    baseline_case: baselineCase.id,
    current_case: currentCase.id,
    wall_ms: measure("wall_ms"),
    peak_rss_bytes: measure("peak_rss_bytes"),
  };
}

function atomicWrite(file, value) {
  const target = resolve(process.cwd(), file);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, target);
  return target;
}

export async function runBenchmark(options) {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("MD-1a peak-RSS benchmarking currently requires macOS or Linux");
  }
  if (!existsSync(tsxCli)) throw new Error(`tsx runner not found at ${tsxCli}; run npm install first`);
  const scenarios = selectScenarios(options);
  if (!scenarios.length) throw new Error("no benchmark scenarios selected");
  const temporary = mkdtempSync(join(tmpdir(), "hunch-md1a-benchmark-"));
  let receipt;
  try {
    const baselineSource = baselineCheckout(temporary);
    const environment = isolatedEnvironment(join(temporary, "home"));
    const variants = {
      baseline: { target: baselineSource },
      current: { target: projectRoot },
    };
    const scenarioFamilies = [...new Map(scenarios.map((scenario) => [
      `${scenario.home}.${scenario.active_corrections}`,
      { home: scenario.home, active_corrections: scenario.active_corrections },
    ])).values()];
    const fixtures = new Map();
    let fixtureRemotes = 0;
    for (const family of scenarioFamilies) {
      const operations = new Set(scenarios
        .filter((scenario) => scenario.home === family.home && scenario.active_corrections === family.active_corrections)
        .map((scenario) => scenario.operation));
      for (const [variant, details] of Object.entries(variants)) {
        const fixture = createFixture(temporary, variant, details.target, family, options.files, operations, environment);
        fixtures.set(`${variant}.${family.home}.${family.active_corrections}`, fixture);
        fixtureRemotes += fixture.remotes;
      }
    }

    const cases = [];
    const comparisons = [];
    for (const scenario of scenarios) {
      const samples = { baseline: [], current: [] };
      for (let sample = 0; sample < options.samples; sample += 1) {
        const order = sample % 2 === 0 ? ["baseline", "current"] : ["current", "baseline"];
        for (const variant of order) {
          const fixture = fixtures.get(`${variant}.${scenario.home}.${scenario.active_corrections}`);
          samples[variant].push(measureCli(variants[variant].target, fixture, operationArgs(scenario), environment));
          assertNoAuthority(fixture);
        }
      }
      const scenarioCases = {};
      for (const variant of ["baseline", "current"]) {
        const fixture = fixtures.get(`${variant}.${scenario.home}.${scenario.active_corrections}`);
        const entry = {
          id: `case_${variant}_${scenario.id.replaceAll(".", "_")}`,
          variant,
          operation: scenario.operation === "sync" ? "noop_sync" : "index",
          home: scenario.home,
          active_corrections: scenario.active_corrections,
          fixture_commit: fixture.commit,
          fixture_files: options.files,
          warmup_runs: 1,
          feature: {
            correction_retry: variant === "current" ? "automatic" : "unavailable",
            retry_state: scenario.active_corrections > 0 && variant === "current" ? "already_proved" : "empty_or_not_supported",
            prepared_non_authoritative_policies: fixture.prepared_policies,
          },
          samples: samples[variant],
          summary: summarizeSamples(samples[variant]),
        };
        cases.push(entry);
        scenarioCases[variant] = entry;
      }
      comparisons.push(comparisonFor(scenario, scenarioCases.baseline, scenarioCases.current));
    }

    const currentCommit = git(projectRoot, ["rev-parse", "HEAD"]);
    const body = {
      schema: BENCHMARK_SCHEMA,
      generated_at: new Date().toISOString(),
      baseline: {
        ref: `main@${BENCHMARK_BASELINE_REF.slice(0, 7)}`,
        commit: BENCHMARK_BASELINE_REF,
        source_hash: sourceHash(baselineSource),
      },
      current: {
        commit: currentCommit,
        worktree_changes: git(projectRoot, ["status", "--porcelain", "--untracked-files=all"]) !== "",
        source_hash: sourceHash(projectRoot),
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu_model: cpus()[0]?.model ?? "unknown",
        cpu_count: cpus().length,
        total_memory_bytes: totalmem(),
        timing: "process.hrtime.bigint",
        peak_rss: process.platform === "darwin" ? "/usr/bin/time -l (bytes)" : "/usr/bin/time -v (KiB normalized to bytes)",
      },
      configuration: {
        samples_per_case: options.samples,
        bounded_many: options.many,
        fixture_files: options.files,
        runner_hash: `sha256:${sha256(readFileSync(fileURLToPath(import.meta.url)))}`,
        percentile_method: "nearest-rank",
        sample_order: "baseline/current alternated by sample",
        timed_scope: "real source CLI after fixture setup and one warm-up",
      },
      safety: {
        network_access: "disabled-by-construction",
        synthesis_provider: "deterministic",
        proxy_route: "closed-loopback:9",
        fixture_remotes: fixtureRemotes,
        authority_grants: 0,
        private_data_in_public_fixture: false,
      },
      cases,
      comparisons,
    };
    const contentHash = `sha256:${sha256(JSON.stringify(stable(body)))}`;
    receipt = {
      id: `md1bench_${contentHash.slice("sha256:".length, "sha256:".length + 12)}`,
      content_hash: contentHash,
      ...body,
    };
  } finally {
    if (options.keepTemp) process.stderr.write(`MD-1a benchmark fixtures retained at ${temporary}\n`);
    else rmSync(temporary, { recursive: true, force: true });
  }
  if (options.output) atomicWrite(options.output, receipt);
  return receipt;
}

async function main() {
  try {
    const options = parseBenchmarkArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${help()}\n`);
      return;
    }
    const receipt = await runBenchmark(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`MD-1a benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
