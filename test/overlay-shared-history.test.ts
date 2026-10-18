import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { commitAndPushHunch, sharedHistoryOverlayAccepted } from "../src/extractors/git.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { ensureSharedOverlayPointer } from "../src/integrations/worktree.js";
import { cleanupDir, tempDir, writeLocalPointer } from "./fixtures.js";

// An overlay that began as a copy of the code repository shares its root commit.
// That is refused by default; a waiver registered in the git common dir accepts
// exactly that overlay while every remote/same-repository clause stays enforced.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });

const CODE_REMOTE = "https://127.0.0.1:9/acme/code.git";
const OVERLAY_REMOTE = "https://127.0.0.1:9/acme/private.git";

function commonPointer(root: string): string {
  const raw = git(root, "rev-parse", "--git-common-dir").trim();
  return join(isAbsolute(raw) ? raw : resolve(root, raw), "hunch", "local.json");
}

function fixture(): { base: string; code: string; overlay: string; restore: () => void } {
  const base = tempDir("hunch-overlay-shared-history-");
  const code = join(base, "code");
  const overlay = join(base, "overlay");
  const savedPrivate = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  mkdirSync(code, { recursive: true });
  git(code, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.test"], ["commit.gpgsign", "false"]]) git(code, "config", k!, v!);
  writeFileSync(join(code, "README.md"), "public code\n");
  git(code, "add", "README.md");
  git(code, "commit", "-qm", "public root");
  git(code, "remote", "add", "origin", CODE_REMOTE);
  mkdirSync(join(code, ".hunch"));
  // The overlay starts as a clone of the code repo (shared root commit), then
  // gets its own remote and private-only content.
  execFileSync("git", ["clone", "-q", code, overlay], { stdio: "pipe" });
  git(overlay, "remote", "set-url", "origin", OVERLAY_REMOTE);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.test"], ["commit.gpgsign", "false"]]) git(overlay, "config", k!, v!);
  git(overlay, "rm", "-q", "README.md");
  mkdirSync(join(overlay, ".hunch"));
  writeFileSync(join(overlay, ".hunch", "keep.json"), "{}\n");
  git(overlay, "add", ".hunch");
  git(overlay, "commit", "-qm", "private memory");
  writeLocalPointer(code, { privateDir: join(overlay, ".hunch"), mode: "private" });
  return {
    base, code, overlay,
    restore: () => {
      if (savedPrivate === undefined) delete process.env.HUNCH_PRIVATE_DIR;
      else process.env.HUNCH_PRIVATE_DIR = savedPrivate;
      cleanupDir(base);
    },
  };
}

function register(code: string, overlay: string, extra: Record<string, unknown>): void {
  writeFileSync(commonPointer(code), `${JSON.stringify({ privateDir: join(overlay, ".hunch"), mode: "private", ...extra }, null, 2)}\n`);
}

const UNSAFE = /Unsafe private overlay.*publication boundary/;

test("a shared-history overlay is refused without a waiver", () => {
  const f = fixture();
  try {
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
    assert.equal(sharedHistoryOverlayAccepted(f.overlay, f.code), false);
  } finally { f.restore(); }
});

// writeLocalPointer copies only privateDir/autoCommit/mode into the common dir, so
// an acceptSharedHistoryOverlay passed to it lands in the per-worktree file alone.
test("a waiver shipped in the per-worktree .hunch/local.json is ignored", () => {
  const f = fixture();
  try {
    writeLocalPointer(f.code, { privateDir: join(f.overlay, ".hunch"), mode: "private", acceptSharedHistoryOverlay: f.overlay });
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
  } finally { f.restore(); }
});

test("a registered waiver naming a different overlay, or a relative path, is not honored", () => {
  const f = fixture();
  try {
    const other = join(f.base, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: other });
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: "../overlay" });
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: true });
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
  } finally { f.restore(); }
});

test("a registered waiver for this exact overlay opens it and lets its memory auto-commit", () => {
  const f = fixture();
  try {
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: f.overlay });
    const store = new HunchStore(hunchPaths(f.code));
    try {
      assert.equal(store.sharedHistoryAccepted, true);
      assert.ok(store.privateDir);
    } finally { store.close(); }

    writeFileSync(join(f.overlay, ".hunch", "note.json"), "{\"a\":1}\n");
    const prevTimeout = process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS;
    process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS = "5000";
    try {
      const outcome = commitAndPushHunch(join(f.overlay, ".hunch"), "test capture", { protectedRepoRoot: f.code });
      assert.equal(outcome, "committed", "commit lands; the unreachable remote only fails the push");
    } finally {
      if (prevTimeout === undefined) delete process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS;
      else process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS = prevTimeout;
    }
    assert.match(git(f.overlay, "log", "-1", "--format=%s"), /test capture/);
  } finally { f.restore(); }
});

test("without the waiver the auto-commit guard still refuses the shared-history overlay", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.overlay, ".hunch", "note.json"), "{\"a\":1}\n");
    assert.equal(commitAndPushHunch(join(f.overlay, ".hunch"), "test capture", { protectedRepoRoot: f.code }), null);
    assert.match(git(f.overlay, "log", "-1", "--format=%s"), /private memory/);
  } finally { f.restore(); }
});

test("the waiver never covers a shared remote identity", () => {
  const f = fixture();
  try {
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: f.overlay });
    git(f.overlay, "remote", "add", "public", CODE_REMOTE.replace(/\.git$/, ""));
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
  } finally { f.restore(); }
});

test("the waiver never covers a local remote pointing at the code repository", () => {
  const f = fixture();
  try {
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: f.overlay });
    git(f.overlay, "remote", "add", "code", f.code);
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
  } finally { f.restore(); }
});

test("the waiver never covers an overlay nested inside the code repository", () => {
  const f = fixture();
  try {
    const nested = join(f.code, ".hunch-private");
    execFileSync("git", ["clone", "-q", f.code, nested], { stdio: "pipe" });
    git(nested, "remote", "set-url", "origin", OVERLAY_REMOTE);
    mkdirSync(join(nested, ".hunch"));
    writeLocalPointer(f.code, { privateDir: join(nested, ".hunch"), mode: "private" });
    register(f.code, nested, { acceptSharedHistoryOverlay: nested });
    assert.throws(() => new HunchStore(hunchPaths(f.code)), UNSAFE);
  } finally { f.restore(); }
});

test("re-registering the same overlay (hunch init / worktree) keeps the waiver; a different overlay drops it", () => {
  const f = fixture();
  try {
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: f.overlay });
    assert.equal(ensureSharedOverlayPointer(f.code, join(f.overlay, ".hunch"), true, "private"), true);
    new HunchStore(hunchPaths(f.code)).close();

    const other = join(f.base, "other");
    mkdirSync(join(other, ".hunch"), { recursive: true });
    git(other, "init", "-q");
    assert.equal(ensureSharedOverlayPointer(f.code, join(other, ".hunch"), true, "private"), true);
    assert.equal(JSON.parse(readFileSync(commonPointer(f.code), "utf8")).acceptSharedHistoryOverlay, undefined);
  } finally { f.restore(); }
});

test("a linked worktree inherits the waiver from the shared git common dir", () => {
  const f = fixture();
  try {
    register(f.code, f.overlay, { acceptSharedHistoryOverlay: f.overlay });
    const linked = join(f.base, "linked");
    git(f.code, "worktree", "add", "-q", "-b", "side", linked);
    mkdirSync(join(linked, ".hunch"), { recursive: true });
    const store = new HunchStore(hunchPaths(linked));
    try { assert.equal(store.sharedHistoryAccepted, true); } finally { store.close(); }
  } finally { f.restore(); }
});

test("a stale waiver on an overlay with independent history reports no shared history", () => {
  const f = fixture();
  try {
    const independent = join(f.base, "independent");
    mkdirSync(join(independent, ".hunch"), { recursive: true });
    git(independent, "init", "-q", "-b", "main");
    for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.test"], ["commit.gpgsign", "false"]]) git(independent, "config", k!, v!);
    writeFileSync(join(independent, ".hunch", "keep.json"), "{}\n");
    git(independent, "add", ".hunch");
    git(independent, "commit", "-qm", "independent root");
    git(independent, "remote", "add", "origin", OVERLAY_REMOTE);
    writeLocalPointer(f.code, { privateDir: join(independent, ".hunch"), mode: "private" });
    register(f.code, independent, { acceptSharedHistoryOverlay: independent });
    const store = new HunchStore(hunchPaths(f.code));
    try { assert.equal(store.sharedHistoryAccepted, false); } finally { store.close(); }
  } finally { f.restore(); }
});
