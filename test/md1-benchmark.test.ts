import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_BASELINE_REF,
  benchmarkScenarios,
  summarizeSamples,
} from "../tooling/md1-benchmark.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("MD-1a benchmark uses the pinned baseline, complete matrix, and nearest-rank p50/p95", () => {
  assert.equal(BENCHMARK_BASELINE_REF, "610cd2e5673bf3c69ac984b4737e2d4a749ed374");
  const scenarios = benchmarkScenarios(16);
  assert.equal(scenarios.length, 12);
  assert.deepEqual(new Set(scenarios.map((scenario) => scenario.operation)), new Set(["index", "sync"]));
  assert.deepEqual(new Set(scenarios.map((scenario) => scenario.home)), new Set(["public", "split_private"]));
  assert.deepEqual(new Set(scenarios.map((scenario) => scenario.active_corrections)), new Set([0, 1, 16]));

  assert.deepEqual(summarizeSamples([
    { wall_ms: 40, peak_rss_bytes: 400 },
    { wall_ms: 10, peak_rss_bytes: 100 },
    { wall_ms: 30, peak_rss_bytes: 300 },
    { wall_ms: 20, peak_rss_bytes: 200 },
  ]), {
    wall_ms: { min: 10, p50: 20, p95: 40, max: 40 },
    peak_rss_bytes: { min: 100, p50: 200, p95: 400, max: 400 },
  });
});

test("MD-1a benchmark smoke-runs the real baseline and automatic retry CLIs without a remote", {
  skip: !["darwin", "linux"].includes(process.platform),
  timeout: 120_000,
}, () => {
  const run = spawnSync(process.execPath, [
    "tooling/md1-benchmark.mjs",
    "--samples", "1",
    "--many", "2",
    "--files", "4",
    "--case", "sync:public:1",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 110_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.schema, "hunch.md1a.performance.v1");
  assert.equal(receipt.baseline.commit, BENCHMARK_BASELINE_REF);
  assert.equal(receipt.cases.length, 2);
  const baseline = receipt.cases.find((entry: { variant: string }) => entry.variant === "baseline");
  const current = receipt.cases.find((entry: { variant: string }) => entry.variant === "current");
  assert.equal(baseline.feature.correction_retry, "unavailable");
  assert.equal(current.feature.correction_retry, "automatic");
  assert.equal(current.active_corrections, 1);
  assert.equal(current.samples.length, 1);
  assert.ok(current.summary.wall_ms.p50 > 0);
  assert.ok(current.summary.peak_rss_bytes.p50 > 0);
  assert.equal(receipt.comparisons.length, 1);
  assert.equal(receipt.safety.network_access, "disabled-by-construction");
  assert.equal(receipt.safety.fixture_remotes, 0);
});
