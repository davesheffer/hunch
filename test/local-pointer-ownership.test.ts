import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import assert from "node:assert/strict";
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { checkoutCommonDir, claimSeparateGitDir } from "../src/extractors/git.js";

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
    HUNCH_TEAM_CLONE_TIMEOUT_MS: "120000", // parallel load can stall a local clone past the production bound
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

const REFUSED = /has not registered in the git common dir, so Hunch refuses/;

/** The store fails closed on an unregistered pointer: it never opens (so it can neither
 *  serve another checkout's memory nor demote captures to the public .hunch/). */
function assertRefused(root: string, env: NodeJS.ProcessEnv, label: string): void {
  assert.throws(() => storeOf(root, env).close(), REFUSED, label);
}

test("a committed local.json never attaches another checkout's overlay (store, CLI capture, hook)", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-git-");
  try {
    assertRefused(f.hostile, f.env, "the shipped pointer is refused");

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
    assertRefused(archive, f.env, "a pointer at another checkout's store is refused");

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
    assertRefused(archive, f.env, "a store the archive ships is refused too");
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
    assertRefused(archive, f.env, "the outer repository never vouches for the archive's pointer");
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
    // The pointer behind the link is never followed, and never silently dropped either:
    // opening public here would route captures past the overlay the pointer names.
    assert.throws(() => storeOf(clone, f.env).close(), /never followed/, "the linked pointer fails closed");
  } finally {
    cleanupDir(f.base);
  }
});

test("a symlinked, non-file, or malformed pointer fails closed; a UTF-8 BOM is tolerated", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-malformed-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const local = join(victim, ".hunch", "local.json");
    const registered = join(victim, ".git", "hunch", "local.json");
    const localBytes = readFileSync(local, "utf8");
    const registeredBytes = readFileSync(registered, "utf8");
    const opensPrivate = (label: string): void => {
      const store = storeOf(victim, f.env);
      try {
        assert.equal(store.hasPrivate, true, label);
      } finally {
        store.close();
      }
    };

    // A symlinked local.json (even one pointing at the registered pointer) is never followed.
    const elsewhere = join(f.base, "elsewhere-local.json");
    writeFileSync(elsewhere, localBytes);
    rmSync(local);
    symlinkSync(elsewhere, local, "file");
    assert.throws(() => storeOf(victim, f.env).close(), /never followed[\s\S]*hunch private <dir>/, "symlinked local.json");
    rmSync(local);
    mkdirSync(local);
    assert.throws(() => storeOf(victim, f.env).close(), /not a plain file/, "a directory named local.json");
    rmSync(local, { recursive: true });

    // A leading BOM is stripped, in both pointer files.
    writeFileSync(local, `\uFEFF${localBytes}`);
    writeFileSync(registered, `\uFEFF${registeredBytes}`);
    opensPrivate("BOM-prefixed pointers still open the registered overlay");

    // Any other invalid JSON refuses and names the file.
    const trailingComma = (bytes: string): string => bytes.replace(/\n\}\s*$/, ",\n}\n");
    writeFileSync(registered, registeredBytes);
    writeFileSync(local, trailingComma(localBytes));
    assert.throws(() => storeOf(victim, f.env).close(), (error: Error) =>
      error.message.includes(local) && /is not valid JSON[\s\S]*refuses/.test(error.message), "trailing comma, per-worktree");
    writeFileSync(local, localBytes);
    writeFileSync(registered, trailingComma(registeredBytes));
    assert.throws(() => storeOf(victim, f.env).close(), (error: Error) =>
      error.message.includes(registered) && /is not valid JSON/.test(error.message), "trailing comma, registration");
    writeFileSync(registered, "[]\n");
    assert.throws(() => storeOf(victim, f.env).close(), /is not a JSON object/, "non-object registration");

    // Absent per-worktree pointer: unchanged behavior (the registration alone opens).
    writeFileSync(registered, registeredBytes);
    rmSync(local);
    opensPrivate("the registered pointer alone opens the overlay");
  } finally {
    cleanupDir(f.base);
  }
});

test("an invalid privateDir or mode key refuses rather than silently opening public", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-invalid-keys-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const local = join(victim, ".hunch", "local.json");
    const registered = join(victim, ".git", "hunch", "local.json");
    const registeredBytes = readFileSync(registered, "utf8");
    const refusesInvalidKey = (body: unknown, label: string): void => {
      writeFileSync(registered, registeredBytes); // keep the registration valid; only the per-worktree pointer is under test
      writeFileSync(local, `${JSON.stringify(body)}\n`);
      assert.throws(() => storeOf(victim, f.env).close(), /has an invalid (privateDir|mode)/, label);
    };
    refusesInvalidKey({ privateDir: 5, mode: "shared" }, "numeric privateDir");
    refusesInvalidKey({ privateDir: "" }, "empty privateDir");
    refusesInvalidKey({ privateDir: "   " }, "whitespace-only privateDir");
    refusesInvalidKey({ privateDir: null }, "null privateDir");
    refusesInvalidKey({ mode: "bogus", privateDir: "/x" }, "bogus mode");
  } finally {
    cleanupDir(f.base);
  }
});

test("a registered common-dir pointer with a non-absolute privateDir refuses", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-relative-registered-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const local = join(victim, ".hunch", "local.json");
    const registered = join(victim, ".git", "hunch", "local.json");
    rmSync(local, { force: true }); // isolate the registered (common-dir) pointer
    writeFileSync(registered, `${JSON.stringify({ privateDir: "relative/overlay", mode: "shared" }, null, 2)}\n`);
    assert.throws(() => storeOf(victim, f.env).close(), /has a non-absolute privateDir/, "relative registered privateDir");
  } finally {
    cleanupDir(f.base);
  }
});

test("a symlinked registered common-dir pointer is never followed", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-registered-symlink-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const local = join(victim, ".hunch", "local.json");
    const registered = join(victim, ".git", "hunch", "local.json");
    const registeredBytes = readFileSync(registered, "utf8");
    rmSync(local, { force: true }); // isolate the registered (common-dir) pointer
    const elsewhere = join(f.base, "elsewhere-registered.json");
    writeFileSync(elsewhere, registeredBytes);
    rmSync(registered);
    symlinkSync(elsewhere, registered, "file");
    assert.throws(() => storeOf(victim, f.env).close(), /never followed[\s\S]*hunch private <dir>/, "symlinked registered local.json");
  } finally {
    cleanupDir(f.base);
  }
});

test("a per-worktree pointer naming a different store than the registration warns and uses the registered one", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-mismatch-");
  try {
    const victim = join(f.victimStore, "..", "..");
    const local = join(victim, ".hunch", "local.json");
    const other = join(f.base, "other-store", ".hunch");
    mkdirSync(other, { recursive: true });
    const pointer = JSON.parse(readFileSync(local, "utf8")) as Record<string, unknown>;
    writeFileSync(local, `${JSON.stringify({ ...pointer, privateDir: other }, null, 2)}\n`);
    const store = storeOf(victim, f.env);
    try {
      assert.equal(realpathSync(store.privateDir!), realpathSync(f.victimStore), "the registered store is used");
      const warning = store.overlayResolutionWarning();
      assert.ok(warning, "the ignored pointer is reported");
      assert.ok(warning.includes(other), warning);
      assert.ok(warning.includes(store.privateDir!), warning);
      assert.match(warning, /ignored/);
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

function publicMemoryFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".json") && entry.name !== "local.json") out.push(`${path}:${readFileSync(path, "utf8")}`);
    }
  };
  walk(join(root, ".hunch"));
  return out.sort();
}

test("a pre-v0.33 per-worktree pointer fails closed, writes nothing public, until the named command re-registers it", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-legacy-");
  try {
    // An older setup: per-worktree pointer only, no git-common-dir pointer.
    const victim = join(f.victimStore, "..", "..");
    rmSync(join(victim, ".git", "hunch", "local.json"), { force: true });
    assertRefused(victim, f.env, "an unregistered pointer never demotes the store to public mode");
    const before = publicMemoryFiles(victim);
    const captured = cli(victim, f.env, [
      "record-constraint", "LEGACY_RULE: never import axios in src/app.ts",
      "--scope", "src/app.ts", "--severity", "blocking", "--forbid-dep", "axios",
    ]);
    assert.notEqual(captured.status, 0, "a capture is refused");
    const message = captured.stdout + captured.stderr;
    assert.match(message, REFUSED);
    writeFileSync(join(victim, "src.txt"), "change\n");
    git(victim, "add", "src.txt");
    git(victim, "commit", "-qm", "a commit the post-commit hook would capture");
    const synced = cli(victim, f.env, ["sync", "--from-hook", "--quiet"]);
    assert.doesNotMatch(synced.stdout, /captured|✓/, synced.stdout + synced.stderr);
    assert.deepEqual(publicMemoryFiles(victim), before, "no hook, sync, or capture writes public memory");
    assert.equal(git(victim, "status", "--porcelain", "--", ".hunch"), "", "nothing public is staged or left for sync to commit");

    // The refusal names the exact command; running it re-registers ownership.
    const command = /`hunch (private|shared) ([^`]+)`/.exec(message);
    assert.ok(command, message);
    const again = cli(victim, f.env, [command[1], ...command[2].split(" "), "--no-hook"]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    const restored = storeOf(victim, f.env);
    try {
      assert.equal(restored.hasPrivate, true, "re-registering restores the overlay");
      assert.equal(restored.overlayResolutionWarning(), null);
    } finally {
      restored.close();
    }
  } finally {
    cleanupDir(f.base);
  }
});

test("a failed fresh setup in a --separate-git-dir checkout leaves no back-link behind", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-separate-rollback-");
  try {
    const checkout = join(f.base, "separate");
    const gitDir = join(f.base, "separate-git");
    git(f.base, "init", "-q", "-b", "main", `--separate-git-dir=${gitDir}`, checkout);
    git(checkout, "config", "user.name", "Pointer Test");
    git(checkout, "config", "user.email", "pointer@test.invalid");
    git(checkout, "config", "commit.gpgsign", "false");
    writeFileSync(join(checkout, "README.md"), "# separate\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-qm", "init");
    // Fails after the shared pointer (and the back-link claim) are written.
    const failed = cli(checkout, { ...f.env, HUNCH_TEST_FAIL_OVERLAY_MIGRATION_AFTER_PUBLIC_DROP: "1" },
      ["private", "--repo", f.remote, "--migrate", "--no-hook"]);
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.match(failed.stdout + failed.stderr, /injected late overlay migration failure/);
    assert.equal(existsSync(join(gitDir, "hunch", "checkout-root")), false, "the back-link is rolled back");
    assert.equal(existsSync(join(gitDir, "hunch", "local.json")), false, "the registration is rolled back");
    assert.equal(existsSync(join(gitDir, "hunch")), false, "the hunch/ dir setup created is removed");
    assert.equal(checkoutCommonDir(checkout), "", "the git dir is unclaimed again");
  } finally {
    cleanupDir(f.base);
  }
});

test("a --separate-git-dir checkout registers through setup and opens private; a borrowed .git file does not", { timeout: 180_000 }, () => {
  const f = makeFixture("hunch-local-pointer-separate-");
  try {
    const checkout = join(f.base, "separate");
    const gitDir = join(f.base, "separate-git");
    git(f.base, "init", "-q", "-b", "main", `--separate-git-dir=${gitDir}`, checkout);
    git(checkout, "config", "user.name", "Pointer Test");
    git(checkout, "config", "user.email", "pointer@test.invalid");
    git(checkout, "config", "commit.gpgsign", "false");
    writeFileSync(join(checkout, "README.md"), "# separate\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-qm", "init");
    assert.equal(checkoutCommonDir(checkout), "", "Git alone records no back-link for a separate git dir");
    const setup = cli(checkout, f.env, ["private", "--repo", f.remote, "--no-hook"]);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.doesNotMatch(setup.stdout, /could not register/, setup.stdout);
    assert.equal(checkoutCommonDir(checkout), realpathSync(gitDir), "setup claimed the separate git dir");
    const store = storeOf(checkout, f.env);
    try {
      assert.equal(store.hasPrivate, true, "the registered overlay opens");
      assert.equal(store.mode, "private");
    } finally {
      store.close();
    }

    // An unpacked tree whose .git file names that git dir borrows nothing.
    const unpacked = join(f.base, "unpacked-separate");
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(join(unpacked, ".git"), `gitdir: ${gitDir}\n`);
    assert.equal(checkoutCommonDir(unpacked), "", "the back-link names the real checkout");
    assert.equal(claimSeparateGitDir(unpacked), "", "a live checkout's git dir is never re-claimed");
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
      assertRefused(join(clone, "evil"), f.env, `a ${label} pointer inside tracked repository-shaped files is refused`);
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
