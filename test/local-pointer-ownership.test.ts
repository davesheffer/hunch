import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import assert from "node:assert/strict";
import { cpSync, existsSync, linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { checkoutCommonDir } from "../src/extractors/git.js";

// `.hunch/local.json` is gitignored by convention only. A checkout can still ship
// one that names another checkout's overlay store; it must never be read from or
// pushed to unless this machine's own setup wrote the pointer.

const SECRET = "VICTIM_OVERLAY_ONLY_DECISION";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pointer Test");
  git(root, "config", "user.email", "pointer@test.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

type Fixture = { base: string; env: NodeJS.ProcessEnv; remote: string; victimStore: string; hostile: string };

function cli(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string) {
  return spawnSync(process.execPath, hunchCliArgs(...args), { cwd, env, input, encoding: "utf8", timeout: 90_000 });
}

/** A victim checkout with a private overlay (no team.json anywhere), and a hostile
 *  repository — as it arrives from `git clone` — committing a pointer at that overlay. */
function makeFixture(prefix: string): Fixture {
  const base = tempDir(prefix);
  const home = join(base, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  const env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", NO_COLOR: "1", CI: "1",
  });

  const seed = join(base, "memory-seed");
  initRepo(seed);
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  writeFileSync(join(seed, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  writeFileSync(join(seed, ".hunch", "decisions", "dec_victim0001.json"), `${JSON.stringify({
    id: "dec_victim0001", title: SECRET, status: "accepted", created_at: "2026-09-01T00:00:00.000Z",
    rationale: "victim-only memory", related_files: [], provenance: { source: "manual" }, confidence: 0.9,
  }, null, 2)}\n`);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: victim memory");
  const remote = join(base, "memory.git");
  git(base, "clone", "-q", "--bare", seed, remote);

  const victim = join(base, "victim");
  initRepo(victim);
  writeFileSync(join(victim, "README.md"), "# victim\n");
  git(victim, "add", "-A");
  git(victim, "commit", "-qm", "init");
  const setup = cli(victim, env, ["private", "--repo", remote, "--no-hook"]);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const victimStore = join(victim, ".hunch-private", ".hunch");

  const hostileSeed = join(base, "hostile-seed");
  initRepo(hostileSeed);
  mkdirSync(join(hostileSeed, ".hunch"), { recursive: true });
  mkdirSync(join(hostileSeed, "src"), { recursive: true });
  writeFileSync(join(hostileSeed, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(hostileSeed, ".hunch", "local.json"), `${JSON.stringify({ privateDir: victimStore, mode: "shared", autoCommit: true }, null, 2)}\n`);
  git(hostileSeed, "add", "-A");
  git(hostileSeed, "add", "-f", ".hunch/local.json");
  git(hostileSeed, "commit", "-qm", "fixture: shipped pointer");
  const hostile = join(base, "hostile");
  git(base, "clone", "-q", hostileSeed, hostile);
  return { base, env, remote, victimStore, hostile };
}

function storeOf(root: string, env: NodeJS.ProcessEnv): HunchStore {
  const saved = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  const savedHome = process.env.HOME;
  process.env.HOME = env.HOME;
  try {
    return new HunchStore(hunchPaths(root));
  } finally {
    if (saved === undefined) delete process.env.HUNCH_PRIVATE_DIR; else process.env.HUNCH_PRIVATE_DIR = saved;
    process.env.HOME = savedHome;
  }
}

test("a committed local.json never attaches another checkout's overlay (store, CLI capture, hook)", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-git-");
  try {
    const store = storeOf(f.hostile, f.env);
    try {
      assert.equal(store.hasPrivate, false, "the shipped pointer is ignored");
    } finally {
      store.close();
    }

    const before = git(f.base, "ls-remote", f.remote, "refs/heads/main");
    const victimHead = git(join(f.victimStore, ".."), "rev-parse", "HEAD");
    const victimStatus = git(join(f.victimStore, ".."), "status", "--porcelain", "--untracked-files=all");
    const captured = cli(f.hostile, f.env, [
      "record-constraint", "HOSTILE_RULE: never import axios in src/app.ts",
      "--scope", "src/app.ts", "--severity", "blocking", "--forbid-dep", "axios",
    ]);
    assert.doesNotMatch(captured.stdout + captured.stderr, /private memory committed/, captured.stdout + captured.stderr);
    assert.equal(git(f.base, "ls-remote", f.remote, "refs/heads/main"), before, "nothing is pushed to the victim's memory remote");
    assert.equal(git(join(f.victimStore, ".."), "rev-parse", "HEAD"), victimHead, "nothing is committed into the victim's overlay");
    assert.equal(git(join(f.victimStore, ".."), "status", "--porcelain", "--untracked-files=all"), victimStatus, "nothing is written into the victim's overlay");

    const hook = cli(f.hostile, f.env, ["hook", "--provider", "claude"],
      JSON.stringify({ hook_event_name: "SessionStart", cwd: f.hostile, session_id: "pointer" }));
    assert.equal(hook.status, 0, hook.stderr);
    assert.doesNotMatch(hook.stdout, new RegExp(SECRET), "the victim's memory is never served to the hook");
  } finally {
    cleanupDir(f.base);
  }
});

function refsOf(base: string, remote: string): string {
  return git(base, "ls-remote", remote);
}

test("outside Git, a shipped pointer is ignored even for a store inside the archive", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-archive-");
  try {
    // The same repository downloaded as an archive: no .git, the pointer still present.
    const archive = join(f.base, "archive");
    cpSync(f.hostile, archive, { recursive: true });
    rmSync(join(archive, ".git"), { recursive: true, force: true });
    const outside = storeOf(archive, f.env);
    try {
      assert.equal(outside.hasPrivate, false, "a pointer at another checkout's store is ignored");
    } finally {
      outside.close();
    }

    // An archive can also ship its own store whose origin is a remote the archive chose.
    const foreignSeed = join(f.base, "foreign-seed");
    initRepo(foreignSeed);
    writeFileSync(join(foreignSeed, "README.md"), "seed\n");
    git(foreignSeed, "add", "-A");
    git(foreignSeed, "commit", "-qm", "seed");
    const foreign = join(f.base, "foreign.git");
    git(f.base, "clone", "-q", "--bare", foreignSeed, foreign);
    const overlay = join(archive, ".hunch-private");
    git(f.base, "clone", "-q", foreign, overlay);
    git(overlay, "config", "user.name", "Pointer Test");
    git(overlay, "config", "user.email", "pointer@test.invalid");
    mkdirSync(join(overlay, ".hunch"), { recursive: true });
    writeFileSync(join(archive, ".hunch", "local.json"), `${JSON.stringify({ privateDir: ".hunch-private/.hunch", mode: "shared", autoCommit: true }, null, 2)}\n`);
    const inside = storeOf(archive, f.env);
    try {
      assert.equal(inside.hasPrivate, false, "a store the archive ships is ignored too");
    } finally {
      inside.close();
    }
    const before = refsOf(f.base, foreign);
    const captured = cli(archive, f.env, [
      "record-constraint", "ARCHIVE_RULE: never import axios in src/app.ts",
      "--scope", "src/app.ts", "--severity", "blocking", "--forbid-dep", "axios",
    ]);
    assert.doesNotMatch(captured.stdout + captured.stderr, /private memory committed/, captured.stdout + captured.stderr);
    assert.equal(refsOf(f.base, foreign), before, "nothing is pushed to the archive's chosen remote");
  } finally {
    cleanupDir(f.base);
  }
});

test("an archive inside an unrelated Git repository cannot borrow that repository's answer", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-nested-");
  try {
    const outer = join(f.base, "outer");
    initRepo(outer);
    const archive = join(outer, "vendor", "download");
    mkdirSync(join(outer, "vendor"), { recursive: true });
    cpSync(f.hostile, archive, { recursive: true });
    rmSync(join(archive, ".git"), { recursive: true, force: true });
    const store = storeOf(archive, f.env);
    try {
      assert.equal(store.hasPrivate, false, "the outer repository never vouches for the archive's pointer");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("a tracked .hunch symlink into another checkout is never followed", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-symlink-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const seed = join(f.base, "symlink-seed");
    initRepo(seed);
    writeFileSync(join(seed, "README.md"), "# linked\n");
    symlinkSync(join(victim, ".hunch"), join(seed, ".hunch"), "dir");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "fixture: linked memory dir");
    const clone = join(f.base, "symlink-clone");
    git(f.base, "clone", "-q", seed, clone);
    const store = storeOf(clone, f.env);
    try {
      assert.equal(store.hasPrivate, false, "the linked pointer is ignored");
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("this machine's own setup works in the main checkout and a linked worktree", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-own-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const main = storeOf(victim, f.env);
    try {
      assert.equal(main.hasPrivate, true, "the main checkout sees its overlay");
    } finally {
      main.close();
    }
    const linked = join(f.base, "victim-linked");
    git(victim, "worktree", "add", "-q", "-b", "side", linked);
    const side = storeOf(linked, f.env);
    try {
      assert.equal(side.hasPrivate, true, "a linked worktree sees the same overlay");
    } finally {
      side.close();
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("an unregistered per-worktree pointer is ignored with a warning until setup re-registers it", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-legacy-");
  try {
    // An older setup: per-worktree pointer only, no git-common-dir pointer.
    const victim = join(f.victimStore, "..", "..");
    rmSync(join(victim, ".git", "hunch", "local.json"), { force: true });
    const legacy = storeOf(victim, f.env);
    try {
      assert.equal(legacy.hasPrivate, false, "an unregistered pointer is not trusted");
      assert.match(legacy.overlayResolutionWarning() ?? "", /has not registered/);
    } finally {
      legacy.close();
    }
    const again = cli(victim, f.env, ["private", "--repo", f.remote, "--no-hook"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    const restored = storeOf(victim, f.env);
    try {
      assert.equal(restored.hasPrivate, true, "re-running setup restores the overlay");
      assert.equal(restored.overlayResolutionWarning(), null);
    } finally {
      restored.close();
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("committed files shaped like a repository never act as the registered pointer", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-fakegit-");
  try {
    // HEAD/config/objects/refs committed as ordinary files: Git's implicit discovery can
    // treat the directory as a repository whose git dir is checkout content.
    const seed = join(f.base, "fakegit-seed");
    initRepo(seed);
    const fake = join(seed, "evil");
    mkdirSync(join(fake, "objects", "info"), { recursive: true });
    mkdirSync(join(fake, "refs", "heads"), { recursive: true });
    mkdirSync(join(fake, "hunch"), { recursive: true });
    mkdirSync(join(fake, ".hunch"), { recursive: true });
    mkdirSync(join(seed, "evil-store", ".hunch"), { recursive: true });
    writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(fake, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n");
    writeFileSync(join(fake, "objects", "info", "keep"), "");
    writeFileSync(join(fake, "refs", "heads", "keep"), "");
    writeFileSync(join(seed, "evil-store", ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
    writeFileSync(join(fake, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
    const clone = join(f.base, "fakegit-clone");
    for (const [label, pointer] of [
      ["checkout-relative", "../evil-store/.hunch"],
      ["another checkout", f.victimStore],
    ] as const) {
      const body = `${JSON.stringify({ privateDir: pointer, mode: "shared", autoCommit: true }, null, 2)}\n`;
      writeFileSync(join(fake, "hunch", "local.json"), body);
      writeFileSync(join(fake, ".hunch", "local.json"), body);
      git(seed, "add", "-A");
      git(seed, "add", "-f", "evil");
      git(seed, "commit", "-qm", `fixture: ${label}`);
      rmSync(clone, { recursive: true, force: true });
      git(f.base, "clone", "-q", seed, clone);
      const store = storeOf(join(clone, "evil"), f.env);
      try {
        assert.equal(store.hasPrivate, false, `a ${label} pointer inside tracked repository-shaped files is ignored`);
      } finally {
        store.close();
      }
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("a shipped .git file naming another checkout's git dir never selects that checkout's store", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-gitfile-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const linked = join(f.base, "victim-linked");
    git(victim, "worktree", "add", "-q", "-b", "side", linked);
    const targets = ["../victim/.git", "../victim/.git/worktrees/victim-linked"];
    for (const target of targets) {
      const unpacked = join(f.base, `unpacked-${targets.indexOf(target)}`);
      mkdirSync(join(unpacked, "src"), { recursive: true });
      writeFileSync(join(unpacked, ".git"), `gitdir: ${target}\n`);
      writeFileSync(join(unpacked, "src", "app.ts"), "export const x = 1;\n");
      assert.equal(checkoutCommonDir(unpacked), "", `${target}: no git back-link names this directory`);
      const store = storeOf(unpacked, f.env);
      try {
        assert.equal(store.hasPrivate, false, `${target}: the other checkout's store is not selected`);
      } finally {
        store.close();
      }
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("a shipped git dir cannot reach another checkout's repository through a commondir file", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-commondir-");
  try {
    const victim = join(f.victimStore, "..", "..");
    for (const layout of ["file", "dir"] as const) {
      const unpacked = join(f.base, `unpacked-${layout}`);
      const fake = layout === "file" ? join(unpacked, ".fake") : join(unpacked, ".git");
      mkdirSync(fake, { recursive: true });
      mkdirSync(join(unpacked, "src"), { recursive: true });
      if (layout === "file") writeFileSync(join(unpacked, ".git"), "gitdir: .fake\n");
      writeFileSync(join(fake, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(fake, "commondir"), `${join(victim, ".git")}\n`);
      writeFileSync(join(fake, "gitdir"), `${join(unpacked, ".git")}\n`);
      writeFileSync(join(unpacked, "src", "app.ts"), "export const x = 1;\n");
      assert.equal(checkoutCommonDir(unpacked), "", `${layout}: a git dir outside the repository's worktree registry is refused`);
      const store = storeOf(unpacked, f.env);
      try {
        assert.equal(store.hasPrivate, false, `${layout}: the other checkout's store is not selected`);
      } finally {
        store.close();
      }
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("a shipped .git symlink into another checkout never selects that checkout's store", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-gitlink-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const unpacked = join(f.base, "unpacked-link");
    mkdirSync(join(unpacked, "src"), { recursive: true });
    writeFileSync(join(unpacked, "src", "app.ts"), "export const x = 1;\n");
    symlinkSync(join(victim, ".git"), join(unpacked, ".git"), "dir");
    const dropped = join(victim, "vendor", "dropped");
    mkdirSync(dropped, { recursive: true });
    symlinkSync(join("..", "..", ".git"), join(dropped, ".git"), "dir");
    for (const root of [unpacked, dropped]) {
      assert.equal(checkoutCommonDir(root), "", `${root}: a symlinked .git is not vouched for by core.worktree`);
      const store = storeOf(root, f.env);
      try {
        assert.equal(store.hasPrivate, false, `${root}: the other checkout's store is not selected`);
      } finally {
        store.close();
      }
    }
    assert.ok(checkoutCommonDir(victim), "the real checkout still resolves");
  } finally {
    cleanupDir(f.base);
  }
});

test("a submodule resolves its superproject-hosted git dir through core.worktree", { timeout: 60_000 }, () => {
  const base = tempDir("hunch-local-pointer-submodule-");
  try {
    const lib = join(base, "lib");
    initRepo(lib);
    git(lib, "commit", "-q", "--allow-empty", "-m", "lib");
    const app = join(base, "app");
    initRepo(app);
    git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    const common = checkoutCommonDir(join(app, "vendor", "lib"));
    assert.ok(common, "a real submodule is accepted");
    assert.match(common.replace(/\\/g, "/"), /\/\.git\/modules\/vendor\/lib$/);
  } finally {
    cleanupDir(base);
  }
});

test("an exported GIT_DIR or GIT_COMMON_DIR never changes which checkout resolves", { timeout: 60_000 }, () => {
  const base = tempDir("hunch-local-pointer-gitenv-");
  const saved = { dir: process.env.GIT_DIR, common: process.env.GIT_COMMON_DIR };
  try {
    const own = join(base, "own");
    const other = join(base, "other");
    initRepo(own);
    initRepo(other);
    mkdirSync(join(own, "src"), { recursive: true });
    const expected = checkoutCommonDir(own);
    assert.ok(expected, "the checkout resolves without hook variables");
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_COMMON_DIR = join(other, ".git");
    assert.equal(checkoutCommonDir(own), expected);
    process.env.GIT_DIR = ".git";
    delete process.env.GIT_COMMON_DIR;
    assert.equal(checkoutCommonDir(join(own, "src")), expected, "a relative hook GIT_DIR does not break a subdirectory");
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.common === undefined) delete process.env.GIT_COMMON_DIR; else process.env.GIT_COMMON_DIR = saved.common;
    cleanupDir(base);
  }
});

test("a shipped .git symlink to a linked worktree's .git file never selects that checkout's store", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-linklinked-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const linked = join(f.base, "victim-linked");
    git(victim, "worktree", "add", "-q", "-b", "side", linked);
    const targets = [join(linked, ".git"), join("..", "victim-linked", ".git")];
    for (const target of targets) {
      const unpacked = join(f.base, `unpacked-linked-${targets.indexOf(target)}`);
      mkdirSync(join(unpacked, "src"), { recursive: true });
      writeFileSync(join(unpacked, "src", "app.ts"), "export const x = 1;\n");
      symlinkSync(target, join(unpacked, ".git"), "file");
      for (const root of [unpacked, join(unpacked, "src")]) {
        assert.equal(checkoutCommonDir(root), "", `${target}: a symlinked .git cannot borrow a worktree back-link`);
      }
      const store = storeOf(unpacked, f.env);
      try {
        assert.equal(store.hasPrivate, false, `${target}: the other checkout's store is not selected`);
      } finally {
        store.close();
      }
    }
    assert.ok(checkoutCommonDir(linked), "the real linked worktree still resolves");
  } finally {
    cleanupDir(f.base);
  }
});

test("a hard link to a linked worktree's .git file never selects that checkout's store", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-hardlink-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const linked = join(f.base, "victim-linked");
    git(victim, "worktree", "add", "-q", "-b", "side", linked);
    const unpacked = join(f.base, "unpacked-hardlink");
    mkdirSync(join(unpacked, "src"), { recursive: true });
    writeFileSync(join(unpacked, "src", "app.ts"), "export const x = 1;\n");
    linkSync(join(linked, ".git"), join(unpacked, ".git"));
    for (const root of [unpacked, join(unpacked, "src")]) {
      assert.equal(checkoutCommonDir(root), "", `${root}: the back-link names another path`);
    }
    const store = storeOf(unpacked, f.env);
    try {
      assert.equal(store.hasPrivate, false, "the other checkout's store is not selected");
    } finally {
      store.close();
    }
    assert.ok(checkoutCommonDir(linked), "the real linked worktree still resolves");
  } finally {
    cleanupDir(f.base);
  }
});

test("a linked worktree added through another spelling of its path still resolves", { timeout: 60_000 }, () => {
  const base = realpathSync(tempDir("hunch-local-pointer-spelling-"));
  try {
    const main = join(base, "Code", "main");
    initRepo(main);
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const spellings: Array<[string, string]> = [];
    if (existsSync(join(base, "code"))) spellings.push([join(base, "code", "wt-case"), join(base, "Code", "wt-case")]);
    const firmlinked = join("/System/Volumes/Data", base);
    if (process.platform === "darwin" && existsSync(firmlinked)) spellings.push([join(firmlinked, "wt-firm"), join(base, "wt-firm")]);
    for (const [added, onDisk] of spellings) {
      git(main, "worktree", "add", "-q", "--detach", added);
      for (const root of [onDisk, added, join(added, "..", basename(added))]) {
        assert.ok(checkoutCommonDir(root), `${root}: the worktree Git set up resolves`);
      }
    }
  } finally {
    cleanupDir(base);
  }
});

test("a symlink inside a submodule that leads out of it never lends the submodule's repository", { timeout: 60_000 }, () => {
  const base = realpathSync(tempDir("hunch-local-pointer-escape-"));
  try {
    const lib = join(base, "lib");
    initRepo(lib);
    git(lib, "commit", "-q", "--allow-empty", "-m", "lib");
    const app = join(base, "app");
    initRepo(app);
    git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    const submodule = join(app, "vendor", "lib");
    const outside = join(base, "outside");
    mkdirSync(join(outside, "src"), { recursive: true });
    writeFileSync(join(outside, ".git"), `gitdir: ${join(app, ".git", "modules", "vendor", "lib")}\n`);
    symlinkSync(outside, join(submodule, "esc"), "dir");
    for (const root of [join(submodule, "esc"), join(submodule, "esc", "src")]) {
      assert.equal(checkoutCommonDir(root), "", `${root}: physically outside the submodule`);
    }
    assert.ok(checkoutCommonDir(submodule), "the submodule itself still resolves");
  } finally {
    cleanupDir(base);
  }
});
