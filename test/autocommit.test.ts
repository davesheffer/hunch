/**
 * Auto-commit in EVERY mode (default ON): the store-level `autoCommit` default, the
 * public-store commit-only flush (never push/merge the user's code branch — the
 * bug_overlay_clobber lesson), and the `--no-auto-commit` opt-out plumbing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitAndPushHunch } from "../src/extractors/git.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { flushCapture, flushMemoryHome } from "../src/integrations/sync.js";

const g = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cfg = (repo: string): void => { g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T"); };

/** A plain project repo with an initial commit (the PUBLIC-store case). */
function projectRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-autocommit-"));
  g(root, "init", "-b", "main", "."); cfg(root);
  writeFileSync(join(root, "app.ts"), "export const x = 1;\n");
  g(root, "add", "-A"); g(root, "commit", "-q", "-m", "code");
  mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
  writeFileSync(join(root, ".hunch", "manifest.json"), '{"schema_version":1}\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withoutPrivateEnv<T>(fn: () => T): T {
  const saved = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  try { return fn(); } finally { if (saved !== undefined) process.env.HUNCH_PRIVATE_DIR = saved; }
}

test("commitAndPushHunch push:false COMMITS the memory but never touches the remote", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-nopush-"));
  try {
    const remote = join(base, "remote.git");
    g(base, "init", "--bare", "-b", "main", remote);
    const repo = join(base, "repo");
    g(base, "clone", "-q", remote, repo); cfg(repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "code"); g(repo, "push", "-q", "origin", "main");
    const before = g(repo, "rev-parse", "origin/main");

    mkdirSync(join(repo, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(repo, ".hunch", "decisions", "dec_1.json"), "{}\n");
    commitAndPushHunch(join(repo, ".hunch"), "hunch: capture dec_1", { push: false });

    assert.match(g(repo, "log", "-1", "--format=%s"), /capture dec_1/); // committed locally…
    assert.equal(g(remote, "rev-parse", "main"), before); // …but the remote never moved
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("commitAndPushHunch never commits a force-tracked .hunch/local.json overlay pointer", () => {
  const { root, cleanup } = projectRepo();
  try {
    writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: "/safe/placeholder" }) + "\n");
    g(root, "add", "-f", ".hunch/local.json", ".hunch/manifest.json");
    g(root, "commit", "-q", "-m", "track legacy local config");
    const before = g(root, "rev-parse", "HEAD");

    writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: "/SECRET/private-overlay" }) + "\n");
    writeFileSync(join(root, ".hunch", "decisions", "dec_safe.json"), "{}\n");
    const result = commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_safe", { push: false });

    assert.equal(result, null);
    assert.equal(g(root, "rev-parse", "HEAD"), before, "no automatic commit was created");
    assert.doesNotMatch(g(root, "show", "HEAD:.hunch/local.json"), /SECRET/,
      "the machine-local private pointer never enters history");
    assert.equal(g(root, "diff", "--cached", "--name-only", "--", ".hunch"), "",
      "the refused memory set is left unstaged");
  } finally { cleanup(); }
});

test("store.autoCommit defaults ON with no local.json; an explicit false opts out (and kills privateAutoCommit)", () => {
  const { root, cleanup } = projectRepo();
  try {
    withoutPrivateEnv(() => {
      const on = new HunchStore(hunchPaths(root));
      assert.equal(on.autoCommit, true); // absent config → ON in every mode
      assert.equal(on.privateAutoCommit, false); // …but private needs an overlay
      on.close();

      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }) + "\n");
      const off = new HunchStore(hunchPaths(root));
      assert.equal(off.autoCommit, false);
      off.close();

      const overlay = join(root, ".hunch-private", ".hunch");
      mkdirSync(overlay, { recursive: true });
      g(join(root, ".hunch-private"), "init", "-q");
      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay }) + "\n");
      const shared = new HunchStore(hunchPaths(root));
      assert.equal(shared.privateAutoCommit, true); // overlay configured, no opt-out → ON
      shared.close();
    });
  } finally { cleanup(); }
});

test("flushCapture: a PUBLIC capture auto-commits .hunch/ in the project repo (commit-only); opt-out returns null", () => {
  const { root, cleanup } = projectRepo();
  try {
    withoutPrivateEnv(() => {
      g(root, "add", "-A"); g(root, "commit", "-q", "-m", "track .hunch");
      writeFileSync(join(root, ".hunch", "decisions", "dec_pub.json"), "{}\n");
      const store = new HunchStore(hunchPaths(root));
      const r = flushCapture(store, hunchPaths(root).hunch, false, "hunch: capture dec_pub");
      store.close();
      assert.equal(r, "committed");
      assert.match(g(root, "log", "-1", "--format=%s"), /capture dec_pub/);
      assert.equal(g(root, "status", "--porcelain", "--", ".hunch"), ""); // clean — nothing left staged

      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }) + "\n");
      writeFileSync(join(root, ".hunch", "decisions", "dec_off.json"), "{}\n");
      const off = new HunchStore(hunchPaths(root));
      const r2 = flushCapture(off, hunchPaths(root).hunch, false, "hunch: capture dec_off");
      off.close();
      assert.equal(r2, null); // opted out → no commit
      assert.match(g(root, "log", "-1", "--format=%s"), /capture dec_pub/); // HEAD unchanged
    });
  } finally { cleanup(); }
});

test("flushCapture public path skips QUIETLY (no commit) when the user has non-memory files staged, then sweeps later", () => {
  const { root, cleanup } = projectRepo();
  try {
    withoutPrivateEnv(() => {
      g(root, "add", "-A"); g(root, "commit", "-q", "-m", "track .hunch");
      writeFileSync(join(root, "app.ts"), "export const x = 2;\n");
      g(root, "add", "app.ts"); // the user's own staged work
      writeFileSync(join(root, ".hunch", "decisions", "dec_wip.json"), "{}\n");
      const store = new HunchStore(hunchPaths(root));
      const skipped = flushCapture(store, hunchPaths(root).hunch, false, "hunch: capture dec_wip");
      assert.equal(skipped, null); // reports the skip honestly — never claims "committed"
      assert.doesNotMatch(g(root, "log", "-1", "--format=%s"), /capture dec_wip/); // backstop refused
      assert.match(g(root, "diff", "--cached", "--name-only"), /app\.ts/); // user's stage intact

      g(root, "commit", "-q", "-m", "user ships their work"); // stage cleared
      const r = flushCapture(store, hunchPaths(root).hunch, false, "hunch: capture dec_wip");
      store.close();
      assert.equal(r, "committed");
      assert.match(g(root, "log", "-1", "--format=%s"), /capture dec_wip/); // swept up next flush
    });
  } finally { cleanup(); }
});

test("flushMemoryHome honors an explicit public Constitution home even when shared mode routes ordinary captures private", () => {
  const { root, cleanup } = projectRepo();
  try {
    withoutPrivateEnv(() => {
      const overlayRoot = join(root, ".hunch-private");
      const overlayHunch = join(overlayRoot, ".hunch");
      mkdirSync(join(overlayHunch, "policies"), { recursive: true });
      g(overlayRoot, "init", "-q", "-b", "main", "."); cfg(overlayRoot);
      writeFileSync(join(overlayHunch, "manifest.json"), '{"schema_version":1}\n');
      g(overlayRoot, "add", "-A"); g(overlayRoot, "commit", "-q", "-m", "private seed");
      const privateHead = g(overlayRoot, "rev-parse", "HEAD");

      writeFileSync(join(root, ".gitignore"), ".hunch/local.json\n.hunch-private/\n");
      g(root, "add", ".gitignore", ".hunch/manifest.json");
      g(root, "commit", "-q", "-m", "track public memory home");
      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({
        privateDir: overlayHunch,
        autoCommit: true,
        mode: "shared",
      }) + "\n");
      mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
      writeFileSync(join(root, ".hunch", "policies", "pol_public.json"),
        '{"id":"pol_public","data_class":"public"}\n');
      writeFileSync(join(overlayHunch, "policies", "pol_private_pending.json"),
        '{"id":"pol_private_pending","data_class":"private"}\n');

      const store = new HunchStore(hunchPaths(root));
      assert.equal(store.unified, true);
      assert.equal(store.captureHome(false), "private", "ordinary shared captures still route to the overlay");
      const result = flushMemoryHome(store, hunchPaths(root).hunch, "public", "hunch: publish public policy");
      store.close();

      assert.equal(result, "committed");
      assert.match(g(root, "show", "HEAD:.hunch/policies/pol_public.json"), /pol_public/);
      assert.equal(g(overlayRoot, "rev-parse", "HEAD"), privateHead,
        "the explicit public flush never commits the private overlay");
      assert.match(g(overlayRoot, "status", "--porcelain", "--", ".hunch/policies/pol_private_pending.json"), /^\?\?/,
        "a pending private artifact remains untouched for its own home flush");
    });
  } finally { cleanup(); }
});
