import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { cleanupDir } from "./helpers.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function overlayDecision(id: string): Decision {
  return {
    id,
    title: `Overlay decision ${id}`,
    topic: null,
    status: "accepted",
    context: "fixture",
    decision: "d",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
}

// issue #294: `hunch supersede` resolved both ids and closed the old one against
// the PUBLIC store only (`store.json`), so a private-overlay `old` (private mode,
// with no `local.json` opting into unified "shared" mode) always failed "--by
// decision ... not found", and even a resolvable overlay decision could never be
// superseded from the CLI.
test("supersede resolves and closes a decision that lives in the private overlay (issue #294)", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-supersede-private-"));
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
    git(publicRoot, "add", "-A");
    git(publicRoot, "commit", "-qm", "fixture: public baseline");
    const publicHeadBefore = git(publicRoot, "rev-parse", "HEAD");

    git(overlayRoot, "init", "-q");
    git(overlayRoot, "config", "user.email", "test@example.com");
    git(overlayRoot, "config", "user.name", "Test Human");
    git(overlayRoot, "config", "commit.gpgsign", "false");
    const privateJson = new JsonStore(hunchPathsForDir(privateHunch));
    privateJson.ensureDirs();
    const oldDecision = overlayDecision("dec_overlay_old");
    const newDecision = overlayDecision("dec_overlay_new");
    privateJson.put("decisions", oldDecision);
    privateJson.put("decisions", newDecision);
    git(overlayRoot, "add", "-A");
    git(overlayRoot, "commit", "-qm", "fixture: overlay baseline");

    const run = spawnSync(process.execPath, hunchCliArgs("supersede", oldDecision.id, "--by", newDecision.id), {
      cwd: publicRoot,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: privateHunch, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /superseded by/);

    const closed = JSON.parse(readFileSync(join(privateHunch, "decisions", `${oldDecision.id}.json`), "utf8")) as Decision;
    assert.equal(closed.status, "superseded");
    assert.equal(closed.superseded_by, newDecision.id);
    assert.ok(closed.valid_to);

    const edges = JSON.parse(readFileSync(join(privateHunch, "edges/index.json"), "utf8")) as Array<{ from: string; to: string }>;
    assert.ok(
      edges.some((e) => e.from === newDecision.id && e.to === oldDecision.id),
      "supersedeIn writes a supersedes edge alongside the closed decision",
    );

    // The close must land in the overlay repo, and only the overlay repo.
    assert.match(git(overlayRoot, "log", "-1", "--format=%s"), /^hunch: supersede/, "the flush commits to the overlay repo");
    assert.equal(git(publicRoot, "rev-parse", "HEAD"), publicHeadBefore, "the public repo is never touched");
    assert.equal(existsSync(join(publicRoot, ".hunch/decisions", `${oldDecision.id}.json`)), false, "the superseded record is never written to the public store");
  } finally {
    cleanupDir(sandbox);
  }
});

// A private `--by` must never close a public `old`: `getRec` resolves overlay-first
// across the union of both stores, so before this fix a public `old` + a private-only
// `by` would resolve and link successfully, writing the private decision's id into the
// closed record, its `supersedes` edge, and a commit in the PUBLIC repo — the exact
// public/private boundary `decisionInStore` (store-specific, not union) exists to hold.
test("supersede refuses a private --by against a public old, instead of leaking its id into the public store", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-supersede-cross-store-"));
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
    const publicJson = new JsonStore(hunchPaths(publicRoot));
    publicJson.ensureDirs();
    const oldDecision = overlayDecision("dec_public_old");
    publicJson.put("decisions", oldDecision);
    git(publicRoot, "add", "-A");
    git(publicRoot, "commit", "-qm", "fixture: public baseline");
    const publicHeadBefore = git(publicRoot, "rev-parse", "HEAD");

    git(overlayRoot, "init", "-q");
    git(overlayRoot, "config", "user.email", "test@example.com");
    git(overlayRoot, "config", "user.name", "Test Human");
    git(overlayRoot, "config", "commit.gpgsign", "false");
    const privateJson = new JsonStore(hunchPathsForDir(privateHunch));
    privateJson.ensureDirs();
    const newDecision = overlayDecision("dec_secret_new");
    privateJson.put("decisions", newDecision);
    git(overlayRoot, "add", "-A");
    git(overlayRoot, "commit", "-qm", "fixture: overlay baseline");

    const run = spawnSync(process.execPath, hunchCliArgs("supersede", oldDecision.id, "--by", newDecision.id), {
      cwd: publicRoot,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: privateHunch, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(output, /not found in the public store/);

    const untouched = JSON.parse(readFileSync(join(publicRoot, ".hunch/decisions", `${oldDecision.id}.json`), "utf8")) as Decision;
    assert.equal(untouched.status, "accepted", "the public decision stays open, not silently closed by a private id");
    assert.equal(untouched.superseded_by, null);
    assert.equal(git(publicRoot, "rev-parse", "HEAD"), publicHeadBefore, "nothing is committed to the public repo");
  } finally {
    cleanupDir(sandbox);
  }
});

// decisionMemoryHome defaults an unresolvable id to "public", so resolving --by before
// old would blame --by ("not found in the public store") for an old that doesn't exist
// anywhere -- a real, misleading claim, not just an unhelpful message. old must be
// checked, and its own store established, before --by is looked up at all.
test("supersede reports a missing old decision as missing, not as a --by lookup failure", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-supersede-missing-old-"));
  const publicRoot = join(sandbox, "code");
  mkdirSync(publicRoot, { recursive: true });

  try {
    git(publicRoot, "init", "-q");
    git(publicRoot, "config", "user.email", "test@example.com");
    git(publicRoot, "config", "user.name", "Test Human");
    git(publicRoot, "config", "commit.gpgsign", "false");
    const publicJson = new JsonStore(hunchPaths(publicRoot));
    publicJson.ensureDirs();
    git(publicRoot, "add", "-A");
    git(publicRoot, "commit", "-qm", "fixture: public baseline");

    const run = spawnSync(process.execPath, hunchCliArgs("supersede", "dec_does_not_exist", "--by", "dec_also_missing"), {
      cwd: publicRoot,
      encoding: "utf8",
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(output, /decision "dec_does_not_exist" not found/);
    assert.doesNotMatch(output, /--by/, "old's absence must not be reported as a --by failure");
  } finally {
    cleanupDir(sandbox);
  }
});
