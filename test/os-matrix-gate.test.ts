// OS matrix gate: every src file that branches on the host platform must be
// exercised by at least one test that runs in CI's Windows/macOS job
// (`platform-matrix-safety`), otherwise its win32/darwin branch is never run.
// A new platform-branching file without a mapping here fails; a mapping whose
// tests are all absent from the workflow's list fails.
// Scope: this proves each platform-branching module is imported by a test that
// runs on Windows/macOS CI, not that the specific platform branch executes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

/** src file -> tests that exercise it. `via` is the regex proving the test reaches
 *  it; default: a direct static import of the module. */
const MAPPING: Record<string, { tests: string[]; via?: RegExp }> = {
  "src/cli/update.ts": { tests: ["test/update.test.ts"] },
  "src/cli/verify.ts": { tests: ["test/test-selection.test.ts"], via: /hunchCliArgs\("verify"/ },
  "src/constitution/g2BehaviorDependencies.ts": { tests: ["test/dependency-snapshot-isolation.test.ts"] },
  "src/core/boundedSpawn.ts": { tests: ["test/bounded-spawn.test.ts"] },
  "src/core/machine.ts": { tests: ["test/workspaces.test.ts"] },
  "src/core/procstart.ts": { tests: ["test/procstart.test.ts", "test/lock-parity.test.ts"] },
  "src/core/spawnCommand.ts": { tests: ["test/spawn-command.test.ts"] },
  "src/core/taskReportEvidence.ts": { tests: ["test/task-verify-exit.test.ts"] },
  "src/core/taskSelection.ts": { tests: ["test/task-selection.test.ts"] },
  "src/core/updatecheck.ts": { tests: ["test/updatecheck.test.ts"] },
  "src/core/verifyLauncher.ts": { tests: ["test/verification-launcher.test.ts"] },
  "src/extractors/git.ts": { tests: ["test/fixture-environment.test.ts", "test/git-merge-range.test.ts"] },
  "src/extractors/workspaces.ts": { tests: ["test/workspaces.test.ts", "test/workspace-prune.test.ts"] },
  "src/integrations/claudeConfig.ts": { tests: ["test/claudeconfig.test.ts"] },
  "src/integrations/hooks.ts": { tests: ["test/init-shared-autocommit.test.ts", "test/workspace-ledger.test.ts"] },
  "src/integrations/providers.ts": { tests: ["test/providers.test.ts"] },
  "src/integrations/registry.ts": { tests: ["test/registry.test.ts"] },
  "src/serve/writelock.ts": { tests: ["test/lock-parity.test.ts"] },
  "src/store/hunchStore.ts": { tests: ["test/experiment.test.ts", "test/workspace-ledger.test.ts"] },
  "src/store/jsonStore.ts": { tests: ["test/migrate.test.ts", "test/lock-parity.test.ts"] },
  "src/synthesis/cliAdapter.ts": { tests: ["test/cli-adapter.test.ts"] },
  "src/synthesis/provider.ts": { tests: ["test/provider-exec.test.ts"] },
};

const PLATFORM = /process\.platform|\bplatform\(\)|["'](?:win32|darwin)["']/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Source with comments removed, so prose mentioning win32 doesn't count. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

function platformBranchingFiles(): string[] {
  return walk(join(ROOT, "src"))
    .filter((p) => PLATFORM.test(code(readFileSync(p, "utf8"))))
    .map(rel)
    .sort();
}

/** The test files the Windows/macOS job runs, parsed from the workflow. */
function osJobTests(): { run: string[]; receipt: string[] } {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  platform-matrix-safety:"));
  assert.ok(job.length > 1, "ci.yml has a platform-matrix-safety job");
  const end = job.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  const block = end === -1 ? job : job.slice(0, end + 1);
  assert.match(block, /os: \[[^\]]*windows-latest[^\]]*\]/);
  assert.match(block, /os: \[[^\]]*macos-latest[^\]]*\]/);
  const run = /id: matrix-safety[\s\S]*?\n\s+run: (node tooling\/run-tests\.mjs[^\n]*)/.exec(block);
  assert.ok(run, "matrix-safety step runs tooling/run-tests.mjs");
  const receipt = /tests:\[([^\]]*)\]/.exec(block);
  assert.ok(receipt, "platform receipt lists its tests");
  return {
    run: run[1]!.split(/\s+/).filter((t) => /^test\/.+\.test\.ts$/.test(t)),
    receipt: [...receipt[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
  };
}

test("every platform-branching src file has a mapping, and no mapping is stale", () => {
  const found = platformBranchingFiles();
  assert.deepEqual(Object.keys(MAPPING).sort(), found,
    "add new platform-branching files to MAPPING in test/os-matrix-gate.test.ts (and drop files that no longer branch)");
});

test("every mapped test exists and actually reaches its src file", () => {
  for (const [src, { tests, via }] of Object.entries(MAPPING)) {
    const mod = src.replace(/^src\//, "").replace(/\.ts$/, "");
    const proof = via ?? new RegExp(`from\\s+["']\\.\\./src/${mod.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\.js["']`);
    for (const t of tests) {
      assert.ok(existsSync(join(ROOT, t)), `${t} (mapped for ${src}) exists`);
      assert.match(readFileSync(join(ROOT, t), "utf8"), proof, `${t} reaches ${src}`);
    }
  }
});

test("every platform-branching src file runs on Windows and macOS in CI", () => {
  const { run, receipt } = osJobTests();
  assert.deepEqual(receipt, run, "the platform receipt lists exactly the tests the job ran");
  for (const t of run) assert.ok(existsSync(join(ROOT, t)), `${t} in the OS job exists`);
  const inJob = new Set(run);
  const uncovered = Object.entries(MAPPING).filter(([, { tests }]) => !tests.some((t) => inJob.has(t))).map(([src]) => src);
  assert.deepEqual(uncovered, [], "add a mapped test for each file to ci.yml's platform-matrix-safety run list and receipt");
});
