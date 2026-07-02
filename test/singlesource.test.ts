/**
 * Single source of truth — the memory-resolution contract:
 *  · captureHome routes every capture to ONE home per mode (public / private-split / shared-unified)
 *  · the shared pointer + mode ride the git common dir so all worktrees agree
 *  · team.json auto-discovery wires a fresh clone to the team store (ensureTeamOverlay)
 *  · putWhereItLives updates a record in the store that holds it (never forks a copy)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { ensureSharedOverlayPointer } from "../src/integrations/worktree.js";
import { ensureTeamOverlay, writeTeamConfig, readTeamConfig } from "../src/integrations/team.js";
import { mainWorktreeRoot } from "../src/extractors/git.js";
import type { Decision } from "../src/core/types.js";

const g = (cwd: string, ...a: string[]): string =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cfg = (repo: string): void => { g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T"); };

function repo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-ssot-"));
  g(root, "init", "-b", "main", "."); cfg(root);
  writeFileSync(join(root, "app.ts"), "export const x = 1;\n");
  g(root, "add", "-A"); g(root, "commit", "-q", "-m", "code");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "manifest.json"), '{"schema_version":1}\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function dec(id: string): Decision {
  const now = new Date().toISOString();
  return {
    id, title: id, status: "accepted", context: "", decision: "d", topic: null,
    consequences: [], alternatives_rejected: [], rejected_tripwires: [],
    related_components: [], related_files: [], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: now, valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: now,
  } as unknown as Decision;
}

function withoutPrivateEnv<T>(fn: () => T): T {
  const saved = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  try { return fn(); } finally { if (saved !== undefined) process.env.HUNCH_PRIVATE_DIR = saved; }
}

test("captureHome: one home per record in every mode — public, private-split, shared-unified", () => {
  const { root, cleanup } = repo();
  try {
    withoutPrivateEnv(() => {
      const overlay = join(root, ".hunch-private", ".hunch");
      mkdirSync(overlay, { recursive: true });

      // No overlay → public mode: everything public.
      const pub = new HunchStore(hunchPaths(root));
      assert.equal(pub.mode, "public");
      assert.equal(pub.captureHome(false), "public");
      pub.close();

      // Private mode (and legacy configs with NO mode field) → split routing.
      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay }) + "\n");
      const legacy = new HunchStore(hunchPaths(root));
      assert.equal(legacy.mode, "private"); // absent mode reads private — upgrade-safe
      assert.equal(legacy.unified, false);
      assert.equal(legacy.captureHome(false), "public");
      assert.equal(legacy.captureHome(true), "private");
      legacy.close();

      // Shared mode → unified: EVERY capture routes to the overlay.
      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, mode: "shared" }) + "\n");
      const shared = new HunchStore(hunchPaths(root));
      assert.equal(shared.mode, "shared");
      assert.equal(shared.unified, true);
      assert.equal(shared.captureHome(false), "private");
      const d = dec("dec_unified");
      shared.putCapture("decisions", d);
      assert.ok(existsSync(join(overlay, "decisions", "dec_unified.json"))); // landed in the overlay…
      assert.ok(!existsSync(join(root, ".hunch", "decisions", "dec_unified.json"))); // …and ONLY there
      shared.close();
    });
  } finally { cleanup(); }
});

test("the git-common-dir pointer carries the mode — a fresh worktree routes unified like every other consumer", () => {
  const { root, cleanup } = repo();
  try {
    withoutPrivateEnv(() => {
      const overlay = join(root, ".hunch-private", ".hunch");
      mkdirSync(overlay, { recursive: true });
      assert.ok(ensureSharedOverlayPointer(root, overlay, true, "shared"));

      const wt = join(root, "..", `${root.split("/").pop()}-wt`);
      g(root, "worktree", "add", "-q", wt, "-b", "wt-branch");
      try {
        mkdirSync(join(wt, ".hunch"), { recursive: true }); // no local.json here — must fall back to the shared pointer
        const store = new HunchStore(hunchPaths(wt));
        assert.equal(store.mode, "shared");
        assert.equal(store.unified, true);
        assert.equal(store.captureHome(false), "private"); // the worktree homes captures in the SAME store
        store.close();
        // realpath both sides: git resolves the macOS /var → /private/var symlink
        assert.equal(realpathSync(mainWorktreeRoot(wt)), realpathSync(root)); // stable anchor = the main checkout
      } finally {
        g(root, "worktree", "remove", "--force", wt);
      }
    });
  } finally { cleanup(); }
});

test("team.json auto-discovery: a fresh clone wires itself to the shared store (mode=shared, unified)", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-"));
  try {
    withoutPrivateEnv(() => {
      // The team's shared memory repo (bare remote + a seeded clone that pushed).
      const memRemote = join(base, "memory.git");
      g(base, "init", "--bare", "-b", "main", memRemote);
      const seed = join(base, "seed");
      mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
      g(seed, "init", "-b", "main", "."); cfg(seed);
      writeFileSync(join(seed, ".hunch", "decisions", "dec_team.json"), JSON.stringify(dec("dec_team")) + "\n");
      g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "seed");
      g(seed, "remote", "add", "origin", memRemote); g(seed, "push", "-q", "origin", "main");

      // The PROJECT repo commits a team.json advertising that store; teammate B clones it.
      const proj = join(base, "proj");
      mkdirSync(join(proj, ".hunch"), { recursive: true });
      g(proj, "init", "-b", "main", "."); cfg(proj);
      writeFileSync(join(proj, "app.ts"), "export const x = 1;\n");
      writeTeamConfig(proj, { shared_repo: memRemote });
      g(proj, "add", "-A"); g(proj, "commit", "-q", "-m", "project + team.json");
      const clone = join(base, "teammate");
      g(base, "clone", "-q", proj, clone); cfg(clone);

      assert.deepEqual(readTeamConfig(clone), { shared_repo: memRemote });
      const wired = ensureTeamOverlay(clone);
      assert.ok(wired, "fresh clone should auto-wire from team.json");
      const store = new HunchStore(hunchPaths(clone));
      assert.equal(store.mode, "shared");
      assert.equal(store.unified, true);
      assert.ok(store.recs("decisions").some((d) => d.id === "dec_team")); // the team's memory is visible
      store.close();
      assert.equal(ensureTeamOverlay(clone), null); // idempotent: already wired → no-op
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("putWhereItLives updates the holding store — an overlay record never forks a public copy", () => {
  const { root, cleanup } = repo();
  try {
    withoutPrivateEnv(() => {
      const overlay = join(root, ".hunch-private", ".hunch");
      mkdirSync(overlay, { recursive: true });
      writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, mode: "shared" }) + "\n");
      const store = new HunchStore(hunchPaths(root));
      store.putCapture("decisions", dec("dec_upd")); // lands in the overlay (unified)
      store.putWhereItLives("decisions", { ...dec("dec_upd"), title: "updated" });
      assert.ok(!existsSync(join(root, ".hunch", "decisions", "dec_upd.json"))); // no public fork
      const upd = JSON.parse(readFileSync(join(overlay, "decisions", "dec_upd.json"), "utf8")) as { title: string };
      assert.equal(upd.title, "updated");
      store.close();
    });
  } finally { cleanup(); }
});
