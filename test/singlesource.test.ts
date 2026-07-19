/**
 * Single source of truth — the memory-resolution contract:
 *  · captureHome routes every capture to ONE home per mode (public / private-split / shared-unified)
 *  · the shared pointer + mode ride the git common dir so all worktrees agree
 *  · team.json auto-discovery wires a fresh clone to the team store (ensureTeamOverlay)
 *  · putWhereItLives updates a record in the store that holds it (never forks a copy)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { ensureSharedOverlayPointer } from "../src/integrations/worktree.js";
import { ensureTeamOverlay, writeTeamConfig, readTeamConfig, safeGitUrl } from "../src/integrations/team.js";
import { ensureGitignore } from "../src/integrations/gitignore.js";
import { installMergeDriver } from "../src/integrations/mergeDriver.js";
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

function standaloneOverlay(root: string): string {
  const overlayRoot = join(root, ".hunch-private");
  const overlay = join(overlayRoot, ".hunch");
  mkdirSync(overlay, { recursive: true });
  g(overlayRoot, "init", "-q");
  return overlay;
}

test("captureHome: one home per record in every mode — public, private-split, shared-unified", () => {
  const { root, cleanup } = repo();
  try {
    withoutPrivateEnv(() => {
      const overlay = standaloneOverlay(root);

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
      const overlay = standaloneOverlay(root);
      assert.ok(ensureSharedOverlayPointer(root, overlay, true, "shared"));

      const wt = join(root, "..", `${basename(root)}-wt`);
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
      const overlayRoot = dirname(wired!);
      assert.match(readFileSync(join(overlayRoot, ".gitignore"), "utf8"), /\.hunch\/\*\.sqlite/);
      assert.match(g(overlayRoot, "config", "--get", "merge.hunch.driver"), /merge-driver/);
      // Existing pointers are also an upgrade seam: repair clone-local capabilities
      // removed from an older overlay without recloning or changing its pointer.
      rmSync(join(overlayRoot, ".gitignore"), { force: true });
      rmSync(join(overlayRoot, ".gitattributes"), { force: true });
      g(overlayRoot, "config", "--unset", "merge.hunch.driver");
      assert.equal(ensureTeamOverlay(clone), null); // idempotent routing, active capability repair
      assert.match(readFileSync(join(overlayRoot, ".gitignore"), "utf8"), /\.hunch\/\*\.sqlite/);
      assert.match(readFileSync(join(overlayRoot, ".gitattributes"), "utf8"), /merge=hunch/);
      assert.match(g(overlayRoot, "config", "--get", "merge.hunch.driver"), /merge-driver/);
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("team.json URL gate: flag smuggling, ext:: transport, and file:// never reach git clone (drive-by RCE guard)", () => {
  // team.json is COMMITTED — attacker-controlled in a cloned repo, auto-consumed on MCP start.
  assert.equal(safeGitUrl("--upload-pack=touch$IFS/tmp/pwned"), null); // argument smuggling
  assert.equal(safeGitUrl("-oProxyCommand=evil"), null);
  assert.equal(safeGitUrl("ext::sh -c evil"), null); // git ext transport = command execution
  assert.equal(safeGitUrl("file:///etc"), null);
  assert.equal(safeGitUrl(""), null);
  assert.equal(safeGitUrl("https://github.com/team/memory.git"), "https://github.com/team/memory.git");
  assert.equal(safeGitUrl("https://alice@github.com/team/memory.git"), null, "HTTPS usernames are userinfo");
  assert.equal(safeGitUrl("https://alice:secret@github.com/team/memory.git"), null, "HTTPS credentials must not enter team.json");
  assert.equal(safeGitUrl("https://alice%3Asecret@github.com/team/memory.git"), null, "encoded userinfo is still userinfo");
  assert.equal(safeGitUrl("git@github.com:team/memory.git"), "git@github.com:team/memory.git");
  assert.equal(safeGitUrl("ssh://git@host/team/memory.git"), "ssh://git@host/team/memory.git");
  assert.equal(safeGitUrl("/mnt/shared/memory.git"), "/mnt/shared/memory.git"); // network-mount / local remote

  // readTeamConfig applies the gate, so no consumer (init/doctor/MCP start) ever sees a hostile URL.
  const { root, cleanup } = repo();
  try {
    withoutPrivateEnv(() => {
      writeFileSync(join(root, ".hunch", "team.json"), JSON.stringify({ shared_repo: "--upload-pack=evil" }) + "\n");
      assert.equal(readTeamConfig(root), null);
      assert.equal(ensureTeamOverlay(root), null); // and auto-wiring refuses outright

      const safe = { shared_repo: "https://github.com/team/memory.git" };
      writeTeamConfig(root, safe);
      const safeBytes = readFileSync(join(root, ".hunch", "team.json"), "utf8");
      assert.throws(
        () => writeTeamConfig(root, { shared_repo: "https://alice:secret@github.com/team/memory.git" }),
        /refusing to write unsafe team repository URL/,
        "the write boundary must reject before replacing a previously safe config",
      );
      assert.equal(readFileSync(join(root, ".hunch", "team.json"), "utf8"), safeBytes);
      assert.doesNotMatch(safeBytes, /alice|secret/);

      writeFileSync(join(root, ".hunch", "team.json"), JSON.stringify({
        shared_repo: "https://alice:secret@github.com/team/memory.git",
      }) + "\n");
      assert.equal(readTeamConfig(root), null, "the read boundary rejects a manually committed credential URL");
    });
  } finally { cleanup(); }
});

test("team overlay clone rejects symlink entries before any integration write can escape the overlay", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-symlink-"));
  try {
    withoutPrivateEnv(() => {
      const victim = join(base, "victim.txt");
      writeFileSync(victim, "outside must stay unchanged\n");

      // A Git remote can carry a symlink as an ordinary tracked entry. Cloning it
      // materializes the link before auto-discovery installs its runtime ignore.
      const memRemote = join(base, "memory.git");
      g(base, "init", "--bare", "-b", "main", memRemote);
      const seed = join(base, "seed");
      mkdirSync(join(seed, ".hunch"), { recursive: true });
      g(seed, "init", "-b", "main", "."); cfg(seed);
      writeFileSync(join(seed, ".hunch", "manifest.json"), '{"schema_version":1}\n');
      symlinkSync(victim, join(seed, ".gitignore"));
      g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "malicious symlink");
      g(seed, "remote", "add", "origin", memRemote); g(seed, "push", "-q", "origin", "main");

      const project = join(base, "project");
      mkdirSync(join(project, ".hunch"), { recursive: true });
      g(project, "init", "-b", "main", "."); cfg(project);
      writeTeamConfig(project, { shared_repo: memRemote });

      const wired = ensureTeamOverlay(project);
      assert.equal(readFileSync(victim, "utf8"), "outside must stay unchanged\n");
      assert.equal(wired, null, "unsafe overlay must not be wired");
      assert.equal(existsSync(join(project, ".hunch", "local.json")), false);
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("team overlay clone rejects a symlinked .hunch before ensureDirs can create external state", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-hunchlink-"));
  try {
    withoutPrivateEnv(() => {
      const victimDir = join(base, "outside");
      mkdirSync(victimDir);

      const memRemote = join(base, "memory.git");
      g(base, "init", "--bare", "-b", "main", memRemote);
      const seed = join(base, "seed");
      mkdirSync(seed);
      g(seed, "init", "-b", "main", "."); cfg(seed);
      symlinkSync(victimDir, join(seed, ".hunch"));
      g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "malicious hunch symlink");
      g(seed, "remote", "add", "origin", memRemote); g(seed, "push", "-q", "origin", "main");

      const project = join(base, "project");
      mkdirSync(join(project, ".hunch"), { recursive: true });
      g(project, "init", "-b", "main", "."); cfg(project);
      writeTeamConfig(project, { shared_repo: memRemote });

      const wired = ensureTeamOverlay(project);
      assert.equal(existsSync(join(victimDir, "decisions")), false, "ensureDirs must not follow .hunch outside the clone");
      assert.equal(wired, null, "unsafe overlay must not be wired");
      assert.equal(existsSync(join(project, ".hunch", "local.json")), false);
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("team overlay clone rejects symlinked Hunch children so later record writes stay contained", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-childlink-"));
  try {
    withoutPrivateEnv(() => {
      const victimDir = join(base, "outside-decisions");
      const victimFile = join(base, "outside-manifest.json");
      mkdirSync(victimDir);
      writeFileSync(victimFile, '{"outside":true}\n');

      const memRemote = join(base, "memory.git");
      g(base, "init", "--bare", "-b", "main", memRemote);
      const seed = join(base, "seed");
      mkdirSync(join(seed, ".hunch"), { recursive: true });
      g(seed, "init", "-b", "main", "."); cfg(seed);
      symlinkSync(victimDir, join(seed, ".hunch", "decisions"));
      symlinkSync(victimFile, join(seed, ".hunch", "manifest.json"));
      g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "malicious nested links");
      g(seed, "remote", "add", "origin", memRemote); g(seed, "push", "-q", "origin", "main");

      const project = join(base, "project");
      mkdirSync(join(project, ".hunch"), { recursive: true });
      g(project, "init", "-b", "main", "."); cfg(project);
      writeTeamConfig(project, { shared_repo: memRemote });

      assert.equal(ensureTeamOverlay(project), null, "nested links must prevent auto-wiring");
      assert.equal(existsSync(join(project, ".hunch", "local.json")), false);
      assert.equal(readFileSync(victimFile, "utf8"), '{"outside":true}\n');
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("integration capability writers independently refuse symlinked top-level files", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-writers-"));
  try {
    const root = join(base, "overlay");
    mkdirSync(root);
    g(root, "init", "-b", "main", "."); cfg(root);
    const victim = join(base, "outside.txt");
    writeFileSync(victim, "outside must stay unchanged\n");

    symlinkSync(victim, join(root, ".gitattributes"));
    assert.throws(() => installMergeDriver(root, "hunch"), /refusing to write unsafe integration config/);
    rmSync(join(root, ".gitattributes"));

    symlinkSync(victim, join(root, ".gitignore"));
    assert.throws(() => ensureGitignore(root), /refusing to write unsafe integration config/);
    assert.equal(readFileSync(victim, "utf8"), "outside must stay unchanged\n");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("team overlay clone rejects a non-file capability entry before creating any Hunch state", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-nonfile-"));
  try {
    withoutPrivateEnv(() => {
      const memRemote = join(base, "memory.git");
      g(base, "init", "--bare", "-b", "main", memRemote);
      const seed = join(base, "seed");
      mkdirSync(join(seed, ".hunch"), { recursive: true });
      mkdirSync(join(seed, ".gitignore"));
      g(seed, "init", "-b", "main", "."); cfg(seed);
      writeFileSync(join(seed, ".hunch", "manifest.json"), '{"schema_version":1}\n');
      writeFileSync(join(seed, ".gitignore", "tracked.txt"), "not a config file\n");
      g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "non-file capability entry");
      g(seed, "remote", "add", "origin", memRemote); g(seed, "push", "-q", "origin", "main");

      const project = join(base, "project");
      mkdirSync(join(project, ".hunch"), { recursive: true });
      g(project, "init", "-b", "main", "."); cfg(project);
      writeTeamConfig(project, { shared_repo: memRemote });

      assert.equal(ensureTeamOverlay(project), null);
      const cloned = join(project, ".hunch-private");
      assert.equal(existsSync(join(cloned, ".gitattributes")), false, "validation must precede capability writes");
      assert.equal(existsSync(join(cloned, ".hunch", "decisions")), false, "validation must precede ensureDirs");
      assert.equal(existsSync(join(project, ".hunch", "local.json")), false);
    });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("putWhereItLives updates the holding store — an overlay record never forks a public copy", () => {
  const { root, cleanup } = repo();
  try {
    withoutPrivateEnv(() => {
      const overlay = standaloneOverlay(root);
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
