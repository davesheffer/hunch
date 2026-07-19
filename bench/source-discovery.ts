/**
 * Deterministic local benchmark for the source-discovery and full-index paths.
 *
 * It generates equivalent Git and non-Git repositories, validates correctness on
 * every timed sample, then reports distribution statistics. No model or network
 * is involved, and no absolute pass/fail latency threshold is imposed.
 *
 * Usage:
 *   npm run bench:scanner
 *   npm run bench:scanner -- --files 5000 --runs 7 --index-runs 3
 *   npm run bench:scanner -- --files 200 --runs 2 --index-runs 1 --json
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { hunchPaths } from "../src/core/paths.js";
import { discoverSourceFiles } from "../src/extractors/sourceFiles.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { HunchStore } from "../src/store/hunchStore.js";

const argv = process.argv.slice(2);
const intFlag = (name: string, fallback: number): number => {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(argv[index + 1]) : fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
};

const FILES = intFlag("files", 1_000);
const DEPTH = intFlag("depth", 8);
const RUNS = intFlag("runs", 5);
const INDEX_RUNS = intFlag("index-runs", 2);
const JSON_OUTPUT = argv.includes("--json");
const EXTENSIONS = [".ts"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".hunch", "coverage", ".next", "out"]);

interface Summary {
  operation: string;
  samples: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  filesPerSecond: number;
}

const rounded = (value: number): number => Math.round(value * 100) / 100;
const percentile = (sorted: number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!;

function summarize(operation: string, samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    operation,
    samples: samples.length,
    minMs: rounded(sorted[0]!),
    meanMs: rounded(meanMs),
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(sorted[sorted.length - 1]!),
    filesPerSecond: rounded(FILES / (meanMs / 1_000)),
  };
}

function createFixture(root: string): void {
  for (let index = 0; index < FILES; index++) {
    const directory = join(root, "src", `layer-${index % DEPTH}`, `bucket-${Math.floor(index / DEPTH) % 16}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `file-${String(index).padStart(6, "0")}.ts`),
      `export function fn_${index}(input: number){ return input + ${index}; }\n`,
    );
  }

  const noiseFiles = Math.max(1, Math.floor(FILES / 10));
  for (let index = 0; index < noiseFiles; index++) {
    const directory = join(root, index % 2 === 0 ? "dist" : "node_modules/pkg");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `noise-${index}.ts`), `export const noise_${index} = ${index};\n`);
  }
}

function initializeGit(root: string): void {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-f", "-A");
  git("-c", "user.email=bench@hunch.local", "-c", "user.name=Hunch Benchmark", "commit", "-qm", "benchmark fixture");
}

function digest(files: string[]): string {
  return createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);
}

function timeDiscovery(root: string, expectedStrategy: "git" | "filesystem"): { samples: number[]; digest: string } {
  const samples: number[] = [];
  let expectedDigest = "";
  for (let run = 0; run < RUNS + 1; run++) {
    const start = performance.now();
    const result = discoverSourceFiles(root, { extensions: EXTENSIONS, skipDirs: SKIP_DIRS });
    const elapsed = performance.now() - start;
    assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
    assert.equal(result.strategy, expectedStrategy);
    assert.equal(result.files.length, FILES);
    const currentDigest = digest(result.files);
    if (!expectedDigest) expectedDigest = currentDigest;
    assert.equal(currentDigest, expectedDigest, "discovery order/content changed between runs");
    if (run > 0) samples.push(elapsed); // first pass is an untimed warm-up
  }
  return { samples, digest: expectedDigest };
}

function timeIndex(root: string): { cold: number[]; repeat: number[]; symbols: number } {
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  try {
    const start = performance.now();
    const first = indexRepo(store, root, { churn: false });
    const cold = [performance.now() - start];
    assert.equal(first.files, FILES);
    assert.equal(first.skipped, 0);
    assert.equal(first.symbols, FILES);

    const expectedIds = store.json.loadAll("symbols").map((symbol) => symbol.id).sort();
    const repeat: number[] = [];
    for (let run = 0; run < INDEX_RUNS; run++) {
      const repeatStart = performance.now();
      const result = indexRepo(store, root, { churn: false });
      repeat.push(performance.now() - repeatStart);
      assert.equal(result.files, FILES);
      assert.equal(result.symbols, FILES);
      assert.deepEqual(store.json.loadAll("symbols").map((symbol) => symbol.id).sort(), expectedIds);
    }
    return { cold, repeat, symbols: first.symbols };
  } finally {
    store.close();
  }
}

const base = mkdtempSync(join(tmpdir(), "hunch-source-bench-"));
try {
  delete process.env.HUNCH_PRIVATE_DIR;
  const filesystemRoot = join(base, "filesystem");
  const gitRoot = join(base, "git");
  mkdirSync(filesystemRoot);
  mkdirSync(gitRoot);
  createFixture(filesystemRoot);
  createFixture(gitRoot);
  initializeGit(gitRoot);

  const filesystem = timeDiscovery(filesystemRoot, "filesystem");
  const git = timeDiscovery(gitRoot, "git");
  assert.equal(filesystem.digest, git.digest, "Git and filesystem strategies discovered different source sets");
  const index = timeIndex(gitRoot);

  const summaries = [
    summarize("discover:filesystem", filesystem.samples),
    summarize("discover:git", git.samples),
    summarize("index:cold", index.cold),
    summarize("index:repeat", index.repeat),
  ];
  const report = {
    fixture: { sourceFiles: FILES, ignoredNoiseFiles: Math.max(1, Math.floor(FILES / 10)), depthBuckets: DEPTH },
    correctness: { fileSetDigest: filesystem.digest, symbols: index.symbols, complete: true },
    results: summaries,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Source scanner benchmark — ${FILES} source files + ${report.fixture.ignoredNoiseFiles} ignored noise files`);
    console.log(`Correctness: complete=true, symbols=${index.symbols}, file-set=${filesystem.digest}`);
    console.log("| operation | samples | min ms | mean ms | p50 ms | p95 ms | max ms | files/s |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of summaries) {
      console.log(`| ${row.operation} | ${row.samples} | ${row.minMs} | ${row.meanMs} | ${row.p50Ms} | ${row.p95Ms} | ${row.maxMs} | ${row.filesPerSecond} |`);
    }
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
