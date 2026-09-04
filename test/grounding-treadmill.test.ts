/**
 * The stranded-grounding heal (fnd_b269d5c422): once a grounding doc went
 * stale-DIRTY (an earlier missed refresh), the clean-only rule skipped it on
 * every later capture flush forever, and each release needed a manual chore
 * commit to pass the gate's clean-tree check. A doc whose divergence from HEAD
 * is confined to the generated HUNCH block is now refreshed and staged; a doc
 * whose USER PROSE diverged stays untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { updateClaudeMd, stripManagedSection } from "../src/integrations/claudemd.js";
import { refreshCommittableGrounding } from "../src/integrations/providers.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** A committed repo whose CLAUDE.md holds user prose around a generated block. */
function fixture(): { root: string; store: HunchStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-treadmill-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  writeFileSync(join(root, "CLAUDE.md"), "# my project\n\nUser prose ABOVE.\n");
  updateClaudeMd(root, store); // seed the managed block
  writeFileSync(join(root, "CLAUDE.md"), readFileSync(join(root, "CLAUDE.md"), "utf8") + "\nUser prose BELOW.\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
  return { root, store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a doc dirty ONLY inside the managed block is refreshed and staged (treadmill heal)", () => {
  const { root, store, cleanup } = fixture();
  try {
    // Simulate the stranding: a stale generated block left dirty in the worktree
    // (counts drifted after an earlier flush missed the refresh).
    const file = join(root, "CLAUDE.md");
    const committed = readFileSync(file, "utf8");
    writeFileSync(file, committed.replace("## 🧠 Hunch (Engineering Memory)", "## 🧠 Hunch (STALE COUNTS)"));

    const changed = refreshCommittableGrounding(root, store);
    assert.ok(changed.some((p) => p.endsWith("CLAUDE.md")), "the stale-dirty doc is refreshed and returned for staging");
    const after = readFileSync(file, "utf8");
    assert.ok(after.includes("Hunch (Engineering Memory)"), "the block regenerated");
    assert.ok(after.includes("User prose ABOVE.") && after.includes("User prose BELOW."), "user prose intact");
  } finally {
    cleanup();
  }
});

test("a doc whose USER PROSE diverged from HEAD is never refreshed or staged", () => {
  const { root, store, cleanup } = fixture();
  try {
    const file = join(root, "CLAUDE.md");
    const edited = readFileSync(file, "utf8").replace("User prose ABOVE.", "User prose EDITED — uncommitted work.");
    writeFileSync(file, edited);

    const changed = refreshCommittableGrounding(root, store);
    assert.ok(!changed.some((p) => p.endsWith("CLAUDE.md")), "user-dirty doc is not staged");
    assert.equal(readFileSync(file, "utf8"), edited, "user-dirty doc is byte-untouched");
  } finally {
    cleanup();
  }
});

test("an untracked grounding doc stays the user's to stage", () => {
  const { root, store, cleanup } = fixture();
  try {
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n\nuser draft, never committed\n");
    const changed = refreshCommittableGrounding(root, store);
    assert.ok(!changed.some((p) => p.endsWith("AGENTS.md")), "untracked doc is not refreshed or staged");
  } finally {
    cleanup();
  }
});

/** An untracked-at-HEAD path is headFileContent's expected, silently-handled case
 *  (the same probe generatedDirtOnly runs for every grounding target on `hunch
 *  sync`/the post-commit flush). git's stderr is INHERITED unless stdio is set, so
 *  the probe used to print `fatal: path '…' exists on disk, but not in 'HEAD'` onto
 *  the caller's terminal — once per untracked doc — even though nothing failed. Only
 *  a child process can observe that leak; an in-process spy on process.stderr.write
 *  never sees a child's inherited write, which is why this needs a spawn. */
test("headFileContent stays silent for an untracked path", () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n\nuser draft, never committed\n");
    const script = [
      'import { headFileContent } from "./src/extractors/git.ts";',
      `const root = ${JSON.stringify(root)};`,
      'if (headFileContent(root, "AGENTS.md") !== null) throw new Error("expected null for untracked path");',
      'if (typeof headFileContent(root, "CLAUDE.md") !== "string") throw new Error("expected tracked content");',
    ].join("\n");
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "", "git's expected untracked-at-HEAD fatal must not reach the caller's stderr");
  } finally {
    cleanup();
  }
});

test("stripManagedSection removes exactly the generated block", () => {
  const { root, store, cleanup } = fixture();
  try {
    const text = readFileSync(join(root, "CLAUDE.md"), "utf8");
    const stripped = stripManagedSection(text);
    assert.ok(!stripped.includes("Hunch (Engineering Memory)"), "block gone");
    assert.ok(stripped.includes("User prose ABOVE.") && stripped.includes("User prose BELOW."), "prose kept");
    assert.equal(stripManagedSection("no markers here"), "no markers here", "marker-free text unchanged");
    void store;
  } finally {
    cleanup();
  }
});

test("tempStore sanity: fixture helpers stay importable", () => {
  const { cleanup } = tempStore();
  cleanup();
});
