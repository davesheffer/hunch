import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import type { Constraint } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { parseMemoryLog, MEMLOG_HEADER } from "../src/core/memorylog.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir } from "./helpers.js";
import { isolatedCliEnv } from "./fixtures.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function activeConstraint(id: string): Constraint {
  return {
    id,
    type: "architecture",
    statement: "never import axios in the public API",
    scope: ["src/**"],
    severity: "blocking",
    enforcement: "advisory_v1",
    match: null,
    forbids: { deps: ["axios"], symbols: [], patterns: [] },
    rationale: "keep the transport boundary in one place",
    source_decision: null,
    violations: [],
    status: "active",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  };
}

function initRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  git(root, "config", "commit.gpgsign", "false");
}

test("retire-constraint keeps a private constraint and reason out of the public checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-retire-private-"));
  const root = join(base, "public"), overlay = join(base, "overlay"), privateDir = join(overlay, ".hunch");
  try {
    mkdirSync(root); mkdirSync(overlay);
    initRepo(root); initRepo(overlay);
    const publicJson = new JsonStore(hunchPaths(root)); publicJson.ensureDirs();
    const privateJson = new JsonStore(hunchPathsForDir(privateDir)); privateJson.ensureDirs();
    const constraint = activeConstraint("con_private_retirement");
    privateJson.put("constraints", constraint);
    writeFileSync(join(root, ".gitignore"), ".hunch/local.json\n.hunch/hunch.sqlite*\n.hunch-cache/\n");
    writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir, autoCommit: false }));
    git(root, "add", "-A"); git(root, "commit", "-qm", "fixture public baseline");
    git(overlay, "add", "-A"); git(overlay, "commit", "-qm", "fixture private baseline");
    const publicHead = git(root, "rev-parse", "HEAD");
    const run = spawnSync(process.execPath, hunchCliArgs("retire-constraint", constraint.id, "--reason", "PRIVATE_RETIREMENT_REASON"), {
      cwd: root, encoding: "utf8", env: isolatedCliEnv({ HUNCH_PRIVATE_DIR: privateDir, NO_COLOR: "1" }),
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const retired = JSON.parse(readFileSync(join(privateDir, "constraints", `${constraint.id}.json`), "utf8"));
    assert.equal(retired.status, "retired"); assert.ok(retired.valid_to);
    assert.equal(existsSync(join(root, ".hunch/constraints", `${constraint.id}.json`)), false);
    assert.equal(git(root, "rev-parse", "HEAD"), publicHead);
    assert.doesNotMatch(git(root, "diff", "HEAD"), /PRIVATE_RETIREMENT_REASON|con_private_retirement/);
  } finally { cleanupDir(base); }
});

test("retire-constraint closes an active constraint's window, keeps the reason out of the commit subject, and CLAUDE.md drops it from Top invariants", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-retire-constraint-"));
  try {
    initRepo(root);
    writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
    const json = new JsonStore(hunchPaths(root));
    json.ensureDirs();
    const constraint = activeConstraint("con_axios_boundary");
    json.put("constraints", constraint);

    const store = new HunchStore(hunchPaths(root));
    updateClaudeMd(root, store);
    store.close();
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /con_axios_boundary/, "fixture sanity: the active constraint starts in Top invariants");

    git(root, "add", "-A");
    git(root, "commit", "-qm", "fixture: baseline with an active constraint");

    const run = spawnSync(process.execPath, hunchCliArgs("retire-constraint", constraint.id, "--reason", "superseded by the new gateway module"), {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /retired — window closed/);

    const closed = JSON.parse(readFileSync(join(root, ".hunch/constraints", `${constraint.id}.json`), "utf8")) as Constraint;
    assert.equal(closed.status, "retired");
    assert.ok(closed.valid_to, "valid_to is set to the retirement instant");

    // CLAUDE.md's Top invariants list regenerates in the SAME commit and drops it.
    const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.doesNotMatch(claudeMd, /con_axios_boundary/, "the retired constraint no longer appears in Top invariants");

    const subject = git(root, "log", "-1", "--format=%s");
    const body = git(root, "log", "-1", "--format=%b");
    assert.equal(subject, `hunch: retire constraint ${constraint.id}`);
    assert.doesNotMatch(subject, /superseded by the new gateway module/, "the --reason text must never land in the commit subject");
    assert.match(body, /superseded by the new gateway module/, "the --reason text lands in the commit body instead");

    // hunch log's deterministic classifier regexes the SUBJECT only for keywords like
    // "supersed"/"repair"/"adopt"/"capture" (src/core/memorylog.ts); a fixed, keyword-free
    // subject must not be misclassified as one of those existing move kinds.
    const nameStatus = git(root, "show", "--format=", "--name-status", "HEAD");
    const raw = `${MEMLOG_HEADER}${git(root, "rev-parse", "HEAD")}\tshort\t2026-01-02T00:00:00Z\t${subject}\n${nameStatus}`;
    const [move] = parseMemoryLog(raw);
    assert.notEqual(move?.kind, "supersede");
  } finally {
    cleanupDir(root);
  }
});

test("retire-constraint refuses a nonexistent id, without any write or commit", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-retire-constraint-missing-"));
  try {
    initRepo(root);
    const json = new JsonStore(hunchPaths(root));
    json.ensureDirs();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fixture: baseline");
    const headBefore = git(root, "rev-parse", "HEAD");

    const run = spawnSync(process.execPath, hunchCliArgs("retire-constraint", "con_does_not_exist"), {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(output, /constraint "con_does_not_exist" not found/);
    assert.equal(git(root, "rev-parse", "HEAD"), headBefore, "no commit is created");
  } finally {
    cleanupDir(root);
  }
});

test("retire-constraint idempotent-refuses an already-retired id, reporting the existing retirement date", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-retire-constraint-twice-"));
  try {
    initRepo(root);
    const json = new JsonStore(hunchPaths(root));
    json.ensureDirs();
    const retiredAlready: Constraint = { ...activeConstraint("con_already_retired"), status: "retired", valid_to: "2026-02-01T00:00:00.000Z" };
    json.put("constraints", retiredAlready);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fixture: already-retired constraint");
    const headBefore = git(root, "rev-parse", "HEAD");

    const run = spawnSync(process.execPath, hunchCliArgs("retire-constraint", retiredAlready.id), {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(output, /already retired/);
    assert.match(output, /2026-02-01/);
    assert.equal(git(root, "rev-parse", "HEAD"), headBefore, "no commit is created for a no-op refusal");

    const untouched = JSON.parse(readFileSync(join(root, ".hunch/constraints", `${retiredAlready.id}.json`), "utf8")) as Constraint;
    assert.equal(untouched.valid_to, "2026-02-01T00:00:00.000Z", "the original retirement instant is preserved, not overwritten");
  } finally {
    cleanupDir(root);
  }
});

test("retire-constraint warns when --reason has nowhere to land because auto-commit is off", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-retire-constraint-no-commit-"));
  try {
    initRepo(root);
    const json = new JsonStore(hunchPaths(root));
    json.ensureDirs();
    const constraint = activeConstraint("con_no_commit");
    json.put("constraints", constraint);
    writeFileSync(join(root, ".hunch", "local.json"), `${JSON.stringify({ autoCommit: false })}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fixture: baseline, auto-commit off");
    const headBefore = git(root, "rev-parse", "HEAD");

    const run = spawnSync(process.execPath, hunchCliArgs("retire-constraint", constraint.id, "--reason", "no longer needed"), {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /retired — window closed/);
    assert.match(output, /--reason is not recorded anywhere/);
    assert.equal(git(root, "rev-parse", "HEAD"), headBefore, "auto-commit is off, so no memory commit is created");

    const closed = JSON.parse(readFileSync(join(root, ".hunch/constraints", `${constraint.id}.json`), "utf8")) as Constraint;
    assert.equal(closed.status, "retired", "the retirement itself still lands on disk even without a commit");
  } finally {
    cleanupDir(root);
  }
});
