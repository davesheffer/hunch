import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { constraintId } from "../src/core/ids.js";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fileSnapshot(root: string): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else files.push([relative(root, file), readFileSync(file).toString("base64")]);
    }
  };
  walk(root);
  return files;
}

function privateDecision(id: string): Decision {
  return {
    id,
    title: "Private transport decision",
    topic: "private.transport",
    status: "accepted",
    context: "This context must remain private.",
    decision: "Keep the private transport boundary.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/api.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["private-review"] },
    date: "2026-07-18T00:00:00.000Z",
  };
}

test("record-constraint rejects a public reference to a private-only decision before any public write or commit", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-record-constraint-home-"));
  const publicRoot = join(sandbox, "code");
  const overlayRoot = join(sandbox, "private-memory");
  const privateHunch = join(overlayRoot, ".hunch");
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(overlayRoot, { recursive: true });

  try {
    git(publicRoot, "init", "-q");
    git(publicRoot, "config", "user.email", "test@example.com");
    git(publicRoot, "config", "user.name", "Test Human");
    git(publicRoot, "config", "commit.gpgsign", "false");
    writeFileSync(join(publicRoot, "src.ts"), "export const value = 1;\n");
    const publicJson = new JsonStore(hunchPaths(publicRoot));
    publicJson.ensureDirs();

    git(overlayRoot, "init", "-q");
    const privateJson = new JsonStore(hunchPathsForDir(privateHunch));
    privateJson.ensureDirs();
    const sourceDecision = privateDecision("dec_private_transport");
    privateJson.put("decisions", sourceDecision);

    git(publicRoot, "add", "-A");
    git(publicRoot, "commit", "-qm", "fixture: public baseline");
    const headBefore = git(publicRoot, "rev-parse", "HEAD");
    const statusBefore = git(publicRoot, "status", "--porcelain=v1", "--untracked-files=all");
    const publicMemoryBefore = fileSnapshot(join(publicRoot, ".hunch"));
    const statement = "never import axios in the public API";

    const run = spawnSync(process.execPath, [
      tsx,
      cli,
      "record-constraint",
      statement,
      "--scope",
      "src/**",
      "--forbid-dep",
      "axios",
      "--source-decision",
      sourceDecision.id,
    ], {
      cwd: publicRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HUNCH_PRIVATE_DIR: privateHunch,
        HUNCH_SYNTH_PROVIDER: "deterministic",
        NO_COLOR: "1",
      },
    });
    const output = `${run.stdout}${run.stderr}`;

    assert.notEqual(run.status, 0, output);
    assert.match(output, /refusing to record public constraint/i);
    assert.match(output, /exists only in the private overlay/i);
    assert.equal(git(publicRoot, "rev-parse", "HEAD"), headBefore, "no public memory commit is created");
    assert.deepEqual(fileSnapshot(join(publicRoot, ".hunch")), publicMemoryBefore, "no public memory file is created or rewritten");
    assert.equal(
      git(publicRoot, "status", "--porcelain=v1", "--untracked-files=all"),
      statusBefore,
      "the public working tree and index remain byte-clean",
    );
    assert.equal(
      existsSync(join(publicRoot, ".hunch/constraints", `${constraintId(statement)}.json`)),
      false,
      "the rejected constraint is never written publicly",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
