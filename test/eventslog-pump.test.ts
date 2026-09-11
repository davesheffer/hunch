/**
 * The strict hook's catch-log must not kill the public memory pump (round-3 audit #1).
 *
 * `.hunch/events.log` is append-only with no rotation. It was neither gitignored nor
 * commit-eligible: the public flush stages the store with ordinary ignore semantics,
 * and stagedMemoryPaths returned null for any non-.json staged path — which unstages
 * everything and aborts, SILENTLY for public stores. So from the first strict pre-edit
 * deny onward, every capture reported success while nothing was ever committed again.
 *
 * NOTE: this repo is incidentally immune because its own .gitignore carries `*.log`,
 * which is exactly why two prior audits and months of dogfooding never saw it. These
 * fixtures deliberately do NOT ignore it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPushHunch } from "../src/extractors/git.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };

function repo(): { root: string; hunch: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-eventslog-"));
  g(root, "init", "-b", "main", ".");
  g(root, "config", "user.email", "t@example.com");
  g(root, "config", "user.name", "T");
  const hunch = join(root, ".hunch");
  mkdirSync(join(hunch, "decisions"), { recursive: true });
  writeFileSync(join(hunch, "manifest.json"), '{"schema_version":2}\n');
  // Deliberately NO *.log ignore rule — the defect's precondition.
  writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n");
  g(root, "add", "-A");
  g(root, "commit", "-qm", "seed");
  return { root, hunch, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const writeDec = (hunch: string, id: string): void =>
  writeFileSync(join(hunch, "decisions", `${id}.json`), JSON.stringify({ id }) + "\n");

const committedDecisions = (root: string): string[] =>
  execFileSync("git", ["-C", root, "ls-files", ".hunch/decisions"], { encoding: "utf8" }).split("\n").filter(Boolean);

test("a capture still commits after the strict hook writes .hunch/events.log (#1)", () => {
  const { root, hunch, cleanup } = repo();
  try {
    writeDec(hunch, "dec_before");
    assert.equal(commitAndPushHunch(hunch, "capture 1", { push: false, protectedRepoRoot: root }), "committed");
    assert.deepEqual(committedDecisions(root), [".hunch/decisions/dec_before.json"]);

    // The first strict pre-edit deny appends its catch-log into the PUBLIC store.
    writeFileSync(join(hunch, "events.log"), JSON.stringify({ at: "2026-08-06T00:00:00Z", kind: "constraint" }) + "\n");

    writeDec(hunch, "dec_after");
    const result = commitAndPushHunch(hunch, "capture 2", { push: false, protectedRepoRoot: root });
    assert.equal(result, "committed", "the pump must survive its own catch-log — this returned null before the fix");
    assert.ok(committedDecisions(root).includes(".hunch/decisions/dec_after.json"), "the later record is actually committed, not left untracked");

    // And the log itself is never committed, nor left staged (a permanently dirty
    // index is what the release gate reads as an unstable tree).
    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    assert.ok(!tracked.includes("events.log"), "the catch-log is never committed");
    const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
    assert.equal(staged, "", "nothing is left staged behind");
  } finally {
    cleanup();
  }
});

test("EVERY skipped derived artifact is unstaged, not just the catch-log (#1)", () => {
  const { root, hunch, cleanup } = repo();
  try {
    // Regression guard on the fix's own first cut: skipping a derived artifact without
    // unstaging it leaves it in the index forever, because the commit is `--only` over
    // the memory paths. The old `return null` path swept the index clean as a side
    // effect of aborting; the skip path has to do it deliberately.
    writeFileSync(join(hunch, "events.log"), "{}\n");
    writeFileSync(join(hunch, "hunch.sqlite-wal"), "derived\n");
    mkdirSync(join(hunch, "decisions"), { recursive: true });
    writeFileSync(join(hunch, "decisions", "dec_tmp.json.tmp1234"), "partial\n");
    writeDec(hunch, "dec_real");

    assert.equal(commitAndPushHunch(hunch, "capture", { push: false, protectedRepoRoot: root }), "committed");
    const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
    assert.equal(staged, "", `no derived artifact may be left staged, found: ${staged}`);
    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    for (const artifact of ["events.log", "hunch.sqlite-wal", ".tmp1234"]) {
      assert.ok(!tracked.includes(artifact), `${artifact} must never be committed`);
    }
  } finally {
    cleanup();
  }
});

test("the pump still REFUSES a genuine topology violation (no over-permissive regression) (#1)", () => {
  const { root, hunch, cleanup } = repo();
  try {
    // A non-JSON file that is NOT a known derived artifact must still abort the
    // memory commit — that guard is what protects against .hunch resolving to the
    // project repo (bug_overlay_clobber).
    writeDec(hunch, "dec_x");
    writeFileSync(join(hunch, "smuggled.txt"), "not a record\n");
    const result = commitAndPushHunch(hunch, "capture with foreign file", { push: false, protectedRepoRoot: root });
    assert.equal(result, null, "a foreign non-JSON file must still refuse the commit");
    assert.deepEqual(committedDecisions(root), [], "nothing was committed");
  } finally {
    cleanup();
  }
});

test("the post-merge hook's pending-commit-repairs queue is never committed, even on a pre-existing gitignore", () => {
  const { root, hunch, cleanup } = repo();
  try {
    // Deliberately mirrors the existing installation this queue file threatens most:
    // repo() seeds a .gitignore that predates the pending-commit-repairs.json entry
    // (ensureGitignore's own idempotent-once-installed design means an existing
    // repo's gitignore never gets it retroactively) — so this file is exercising
    // exactly the "gitignore is stale" case, not relying on it being ignored.
    writeDec(hunch, "dec_before");
    assert.equal(commitAndPushHunch(hunch, "capture 1", { push: false, protectedRepoRoot: root }), "committed");

    writeFileSync(join(hunch, "pending-commit-repairs.json"), JSON.stringify([{ id: "dec_x", from: "a", to: "b" }]) + "\n");
    writeDec(hunch, "dec_after");
    const result = commitAndPushHunch(hunch, "capture 2", { push: false, protectedRepoRoot: root });
    assert.equal(result, "committed");
    assert.ok(committedDecisions(root).includes(".hunch/decisions/dec_after.json"));

    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    assert.ok(!tracked.includes("pending-commit-repairs.json"), "the local-only repair queue is never committed into shared memory");
    const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
    assert.equal(staged, "", "nothing is left staged behind");
  } finally {
    cleanup();
  }
});

test("the post-merge hook's dropped-commit-repairs tombstone file is never committed, even on a pre-existing gitignore", () => {
  const { root, hunch, cleanup } = repo();
  try {
    writeDec(hunch, "dec_before");
    assert.equal(commitAndPushHunch(hunch, "capture 1", { push: false, protectedRepoRoot: root }), "committed");

    writeFileSync(join(hunch, "dropped-commit-repairs.json"), JSON.stringify([{ id: "dec_x", from: "a" }]) + "\n");
    writeDec(hunch, "dec_after");
    const result = commitAndPushHunch(hunch, "capture 2", { push: false, protectedRepoRoot: root });
    assert.equal(result, "committed");
    assert.ok(committedDecisions(root).includes(".hunch/decisions/dec_after.json"));

    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    assert.ok(!tracked.includes("dropped-commit-repairs.json"), "the local-only tombstone file is never committed into shared memory");
    const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim();
    assert.equal(staged, "", "nothing is left staged behind");
  } finally {
    cleanup();
  }
});

test("ensureGitignore covers the catch-log for NEW repos (#1)", async () => {
  const { root, cleanup } = repo();
  try {
    const { ensureGitignore } = await import("../src/integrations/gitignore.js");
    ensureGitignore(root);
    const text = execFileSync("git", ["-C", root, "check-ignore", "-v", ".hunch/events.log"], { encoding: "utf8" });
    assert.match(text, /events\.log/, "a freshly initialized repo ignores the catch-log outright");
    void readdirSync(root);
    void existsSync(root);
  } finally {
    cleanup();
  }
});
