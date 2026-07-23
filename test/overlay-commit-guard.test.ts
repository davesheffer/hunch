/**
 * Safety guard for the overlay auto-commit (bug_overlay_clobber): a Hunch memory sync is PURELY
 * additive JSON. commitAndPushHunch must REFUSE to commit any staged set that deletes files or
 * stages a non-.json file — because that means its dir resolved to a real code repo (e.g. the
 * overlay was never its own git repo), and committing/pushing there would clobber the user's code.
 * We shipped exactly that; this locks the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { commitAndPushHunch, repositoryUsesRemote, sameGitPublication } from "../src/extractors/git.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function repo(prefix: string): { root: string; git: (...a: string[]) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sameRemoteClones(prefix: string): {
  codeRoot: string;
  overlayRoot: string;
  remote: string;
  git: (cwd: string, ...args: string[]) => string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const remote = join(base, "shared.git");
  const seed = join(base, "seed");
  const codeRoot = join(base, "code");
  const overlayRoot = join(base, "overlay");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "t@t.co");
  git(seed, "config", "user.name", "T");
  writeFileSync(join(seed, "app.ts"), "export const publicCode = true;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "public code");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, codeRoot]);
  execFileSync("git", ["clone", "-q", remote, overlayRoot]);
  for (const clone of [codeRoot, overlayRoot]) {
    git(clone, "config", "user.email", "t@t.co");
    git(clone, "config", "user.name", "T");
    git(clone, "config", "commit.gpgsign", "false");
  }
  return {
    codeRoot,
    overlayRoot,
    remote,
    git,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function withoutPrivateEnv<T>(fn: () => T): T {
  const saved = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.HUNCH_PRIVATE_DIR = saved;
  }
}

test("commitAndPushHunch REFUSES a deleting / non-memory change — never commits over a code repo", () => {
  const { root, git, cleanup } = repo("hunch-clobber-");
  try {
    // a "project repo" with real source
    writeFileSync(join(root, "app.ts"), Array.from({ length: 30 }, (_, i) => `export const x${i} = ${i};`).join("\n"));
    git("add", "-A");
    git("commit", "-qm", "code");
    const before = git("rev-list", "--count", "HEAD");
    mkdirSync(join(root, ".hunch"), { recursive: true });

    // simulate the catastrophe: a staged DELETION of the source reaches commitAndPushHunch
    git("rm", "-q", "app.ts");
    const r = commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_x", { push: true, protectedRepoRoot: join(root, "..") });

    assert.equal(r, null, "the refusal is reported, not claimed as a commit");
    assert.equal(git("rev-list", "--count", "HEAD"), before, "no new commit — the guard refused the deletion");
    assert.match(git("ls-tree", "-r", "--name-only", "HEAD"), /app\.ts/, "app.ts is still in history, not clobbered");
  } finally { cleanup(); }
});

test("commitAndPushHunch DOES commit a clean memory-only (JSON) change", () => {
  const { root, git, cleanup } = repo("hunch-overlay-");
  try {
    mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), JSON.stringify({ id: "dec_1", title: "x" }));
    const r = commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_1", { push: true, protectedRepoRoot: join(root, "..") });

    assert.equal(r, "committed", "commit created; no upstream → not overclaimed as pushed");
    assert.equal(git("rev-list", "--count", "HEAD"), "1", "a memory commit was created");
    assert.match(git("ls-tree", "-r", "--name-only", "HEAD"), /decisions\/dec_1\.json/, "the JSON record was committed");
  } finally { cleanup(); }
});

test("commitAndPushHunch REFUSES a JSON-only nested overlay that resolves to the code repo", () => {
  const { root, git, cleanup } = repo("hunch-nested-overlay-");
  try {
    writeFileSync(join(root, "app.ts"), "export const publicCode = true;\n");
    git("add", "-A");
    git("commit", "-qm", "code");
    const before = git("rev-parse", "HEAD");

    const nested = join(root, "nested-private", ".hunch");
    mkdirSync(join(nested, "policies"), { recursive: true });
    writeFileSync(join(nested, "policies", "pol_secret.json"), JSON.stringify({ id: "pol_secret", private: true }));

    const r = commitAndPushHunch(nested, "hunch: private correction review", { push: true, protectedRepoRoot: root });

    assert.equal(r, null, "an ancestor code repository is never accepted as the overlay repository");
    assert.equal(git("rev-parse", "HEAD"), before, "no private-memory commit reached the public branch");
    assert.equal(git("diff", "--cached", "--name-only"), "", "the refusal happened before private bytes were staged");
    assert.doesNotMatch(git("ls-tree", "-r", "--name-only", "HEAD"), /pol_secret/, "private artifact absent from the public tree");
  } finally { cleanup(); }
});

test("commitAndPushHunch REFUSES even a mixed change (one JSON + one source file)", () => {
  const { root, git, cleanup } = repo("hunch-mixed-");
  try {
    git("commit", "-qm", "init", "--allow-empty");
    mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), "{}");
    writeFileSync(join(root, ".hunch", "rogue.ts"), "export const oops = 1;"); // a non-memory file sneaks in
    const before = git("rev-list", "--count", "HEAD");
    commitAndPushHunch(join(root, ".hunch"), "hunch: capture", { push: true, protectedRepoRoot: join(root, "..") });
    assert.equal(git("rev-list", "--count", "HEAD"), before, "mixed (non-JSON present) → refused entirely");
  } finally { cleanup(); }
});

test("commitAndPushHunch REFUSES the protected repository's direct public .hunch", () => {
  const { root, git, cleanup } = repo("hunch-direct-public-");
  try {
    writeFileSync(join(root, "app.ts"), "export const publicCode = true;\n");
    git("add", "-A");
    git("commit", "-qm", "code");
    const before = git("rev-parse", "HEAD");
    mkdirSync(join(root, ".hunch", "policies"), { recursive: true });
    writeFileSync(join(root, ".hunch", "policies", "pol_secret.json"), JSON.stringify({ id: "pol_secret" }));

    const result = commitAndPushHunch(join(root, ".hunch"), "hunch: private memory", {
      push: true,
      protectedRepoRoot: root,
    });

    assert.equal(result, null);
    assert.equal(git("rev-parse", "HEAD"), before, "the public branch was not advanced");
    assert.equal(git("diff", "--cached", "--name-only"), "", "identity refusal happens before staging");
    assert.doesNotMatch(git("ls-tree", "-r", "--name-only", "HEAD"), /pol_secret/);
  } finally { cleanup(); }
});

test("commitAndPushHunch REFUSES a symlink that resolves to the protected public .hunch", () => {
  const { root, git, cleanup } = repo("hunch-symlink-public-");
  try {
    writeFileSync(join(root, "app.ts"), "export const publicCode = true;\n");
    git("add", "-A");
    git("commit", "-qm", "code");
    const before = git("rev-parse", "HEAD");
    const publicHunch = join(root, ".hunch");
    mkdirSync(join(publicHunch, "proofs"), { recursive: true });
    writeFileSync(join(publicHunch, "proofs", "proof_secret.json"), JSON.stringify({ id: "proof_secret" }));
    const disguised = join(root, "private-looking-hunch");
    symlinkSync(publicHunch, disguised, "dir");

    const result = commitAndPushHunch(disguised, "hunch: private proof", {
      push: true,
      protectedRepoRoot: root,
    });

    assert.equal(result, null);
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.equal(git("diff", "--cached", "--name-only"), "", "realpath identity is checked before staging");
    assert.doesNotMatch(git("ls-tree", "-r", "--name-only", "HEAD"), /proof_secret/);
  } finally { cleanup(); }
});

test("commitAndPushHunch REFUSES a linked worktree .hunch from the protected public repository", () => {
  const { root, git, cleanup } = repo("hunch-linked-public-");
  const linked = `${root}-linked`;
  try {
    writeFileSync(join(root, "app.ts"), "export const publicCode = true;\n");
    git("add", "-A");
    git("commit", "-qm", "code");
    git("worktree", "add", "-q", "-b", "overlay-lookalike", linked);
    const publicBefore = git("rev-parse", "HEAD");
    const linkedBefore = execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    mkdirSync(join(linked, ".hunch", "evidence"), { recursive: true });
    writeFileSync(join(linked, ".hunch", "evidence", "ev_secret.json"), JSON.stringify({ id: "ev_secret" }));

    const result = commitAndPushHunch(join(linked, ".hunch"), "hunch: private evidence", {
      push: true,
      protectedRepoRoot: root,
    });

    assert.equal(result, null, "shared git-common-dir identity defeats the linked-worktree disguise");
    assert.equal(git("rev-parse", "HEAD"), publicBefore);
    assert.equal(execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), linkedBefore);
    assert.equal(execFileSync("git", ["-C", linked, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "");
  } finally {
    try { git("worktree", "remove", "--force", linked); } catch { /* cleanup best-effort */ }
    rmSync(linked, { recursive: true, force: true });
    cleanup();
  }
});

test("hunch private .hunch refuses before changing local config or repository HEAD", () => {
  const { root, git, cleanup } = repo("hunch-private-public-dir-");
  try {
    writeFileSync(join(root, "app.ts"), "export const publicCode = true;\n");
    writeFileSync(join(root, ".gitignore"), ".hunch/local.json\n");
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "manifest.json"), JSON.stringify({ schema_version: 1 }) + "\n");
    git("add", "-A");
    git("commit", "-qm", "code and public memory");
    const localConfig = join(root, ".hunch", "local.json");
    writeFileSync(localConfig, JSON.stringify({ sentinel: "KEEP_CONFIG_BYTES" }, null, 2) + "\n");
    const configBefore = readFileSync(localConfig, "utf8");
    const headBefore = git("rev-parse", "HEAD");
    const statusBefore = git("status", "--porcelain");

    const run = spawnSync(process.execPath, [tsx, cli, "private", ".hunch", "--no-hook"], {
      cwd: root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
      encoding: "utf8",
    });
    const output = `${run.stdout}\n${run.stderr}`;

    assert.notEqual(run.status, 0, output);
    assert.match(output, /must not resolve to the public \.hunch directory/i);
    assert.equal(readFileSync(localConfig, "utf8"), configBefore, "refusal preserves the existing local config byte-for-byte");
    assert.equal(git("rev-parse", "HEAD"), headBefore);
    assert.equal(git("status", "--porcelain"), statusBefore, "setup refusal leaves the working/index state unchanged");
    assert.equal(existsSync(join(root, ".hunch", ".git")), false, "the public memory directory was not initialized as an overlay repository");
  } finally { cleanup(); }
});

test("existing plain .hunch-private plus an empty memory remote never attaches or pushes the public repository", () => {
  const { root, git, cleanup } = repo("hunch-existing-private-dir-");
  const remotesRoot = mkdtempSync(join(tmpdir(), "hunch-overlay-remotes-"));
  const publicRemote = join(remotesRoot, "public.git");
  const memoryRemote = join(remotesRoot, "memory.git");
  const refs = (bare: string): string => execFileSync("git", [
    "--git-dir", bare, "for-each-ref", "--format=%(refname):%(objectname)",
  ], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "--bare", "-q", publicRemote]);
    execFileSync("git", ["init", "--bare", "-q", memoryRemote]);
    writeFileSync(join(root, "app.ts"), "export const publicCode = true;\n");
    git("add", "-A");
    git("commit", "-qm", "public code");
    git("remote", "add", "upstream", publicRemote);
    git("push", "-q", "-u", "upstream", "HEAD");
    mkdirSync(join(root, ".hunch-private"), { recursive: true });

    const publicConfigBefore = readFileSync(join(root, ".git", "config"), "utf8");
    const publicHeadBefore = git("rev-parse", "HEAD");
    const publicRemotesBefore = git("remote", "-v");
    const publicUpstreamBefore = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    const publicRefsBefore = refs(publicRemote);
    const memoryRefsBefore = refs(memoryRemote);

    const run = spawnSync(process.execPath, [tsx, cli, "private", "--repo", memoryRemote, "--no-hook"], {
      cwd: root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), publicConfigBefore,
      "the public repository did not acquire or repoint a memory remote");
    assert.equal(git("rev-parse", "HEAD"), publicHeadBefore);
    assert.equal(git("remote", "-v"), publicRemotesBefore);
    assert.equal(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), publicUpstreamBefore);
    assert.equal(refs(publicRemote), publicRefsBefore, "the public remote was not changed");
    assert.equal(refs(memoryRemote), memoryRefsBefore, "no public commit was pushed into the empty memory remote");
    assert.ok(existsSync(join(root, ".hunch-private", ".git")), "the existing directory became its own repository boundary");
    assert.equal(realpathSync(execFileSync("git", ["-C", join(root, ".hunch-private"), "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim()), realpathSync(memoryRemote), "the memory remote is attached only inside the standalone overlay");
  } finally {
    rmSync(remotesRoot, { recursive: true, force: true });
    cleanup();
  }
});

test("commitAndPushHunch REFUSES a standalone overlay clone that publishes to the protected code remote", () => {
  const fixture = sameRemoteClones("hunch-same-publication-");
  try {
    const publicHeadBefore = fixture.git(fixture.codeRoot, "rev-parse", "HEAD");
    const overlayHeadBefore = fixture.git(fixture.overlayRoot, "rev-parse", "HEAD");
    const remoteHeadBefore = execFileSync("git", [
      "--git-dir", fixture.remote, "rev-parse", "refs/heads/main",
    ], { encoding: "utf8" }).trim();
    const secret = join(fixture.overlayRoot, ".hunch", "policies", "pol_private_secret.json");
    mkdirSync(join(fixture.overlayRoot, ".hunch", "policies"), { recursive: true });
    writeFileSync(secret, JSON.stringify({ id: "pol_private_secret", statement: "PRIVATE_REMOTE_SENTINEL" }) + "\n");

    const result = commitAndPushHunch(join(fixture.overlayRoot, ".hunch"), "hunch: private policy", {
      push: true,
      protectedRepoRoot: fixture.codeRoot,
    });

    assert.equal(result, null, "different clones of one remote are the same publication boundary");
    assert.equal(fixture.git(fixture.codeRoot, "rev-parse", "HEAD"), publicHeadBefore);
    assert.equal(fixture.git(fixture.overlayRoot, "rev-parse", "HEAD"), overlayHeadBefore,
      "the overlay clone did not commit the private artifact into public history");
    assert.equal(execFileSync("git", ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
    }).trim(), remoteHeadBefore, "the shared remote was not advanced");
    assert.equal(fixture.git(fixture.overlayRoot, "diff", "--cached", "--name-only"), "",
      "publication identity is refused before staging");
    assert.doesNotMatch(fixture.git(fixture.overlayRoot, "ls-tree", "-r", "--name-only", "HEAD"), /pol_private_secret/);
    const remoteSecretSearch = spawnSync("git", [
      "--git-dir", fixture.remote, "grep", "-n", "PRIVATE_REMOTE_SENTINEL", "refs/heads/main",
    ], { encoding: "utf8" });
    assert.equal(remoteSecretSearch.status, 1, "the private sentinel is absent from the remote tree");
    assert.ok(existsSync(secret), "the refused local record remains available for safe reconfiguration/retry");
  } finally {
    fixture.cleanup();
  }
});

test("commitAndPushHunch disables merge hooks so remote identity cannot change before private push", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-overlay-remote-toctou-"));
  const publicRemote = join(base, "public.git");
  const privateRemote = join(base, "private.git");
  const seed = join(base, "seed");
  const memorySeed = join(base, "memory-seed");
  const codeRoot = join(base, "code");
  const overlayRoot = join(base, "overlay");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const refs = (remote: string): string => execFileSync("git", [
    "--git-dir", remote, "for-each-ref", "--format=%(refname):%(objectname)",
  ], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", publicRemote]);
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", privateRemote]);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "config", "user.email", "test@example.com");
    git(seed, "config", "user.name", "Test Human");
    writeFileSync(join(seed, "app.ts"), "export const publicCode = true;\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "shared base");
    git(seed, "remote", "add", "public", publicRemote);
    git(seed, "push", "-q", "public", "main");
    // The memory repository must have independent ancestry. Sharing even an old
    // code commit is now deliberately rejected as a contaminated publication.
    mkdirSync(memorySeed, { recursive: true });
    git(memorySeed, "init", "-q", "-b", "main");
    git(memorySeed, "config", "user.email", "test@example.com");
    git(memorySeed, "config", "user.name", "Test Human");
    mkdirSync(join(memorySeed, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(memorySeed, ".hunch", "decisions", "seed.json"),
      `${JSON.stringify({ id: "seed", title: "independent memory history" })}\n`);
    git(memorySeed, "add", "-A");
    git(memorySeed, "commit", "-qm", "memory base");
    git(memorySeed, "remote", "add", "private", privateRemote);
    git(memorySeed, "push", "-q", "private", "main");
    execFileSync("git", ["clone", "-q", publicRemote, codeRoot]);
    execFileSync("git", ["clone", "-q", privateRemote, overlayRoot]);
    for (const checkout of [codeRoot, overlayRoot]) {
      git(checkout, "config", "user.email", "test@example.com");
      git(checkout, "config", "user.name", "Test Human");
      git(checkout, "config", "commit.gpgsign", "false");
    }

    // Force the guarded flush to pull/merge after its local memory commit. A
    // hostile post-merge hook would rewrite the destination at the old TOCTOU
    // seam; machine sync must disable it before materializing the fetched tree.
    writeFileSync(join(memorySeed, ".hunch", "decisions", "upstream.json"),
      `${JSON.stringify({ id: "upstream", title: "private upstream update" })}\n`);
    git(memorySeed, "add", "-A");
    git(memorySeed, "commit", "-qm", "private upstream update");
    git(memorySeed, "push", "-q", "private", "main");
    mkdirSync(join(overlayRoot, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(overlayRoot, ".hunch", "decisions", "dec_private.json"),
      JSON.stringify({ id: "dec_private", sentinel: "PRIVATE_POST_MERGE_SENTINEL" }) + "\n");
    const hookMarker = join(base, "post-merge-ran");
    const hook = join(overlayRoot, ".git", "hooks", "post-merge");
    writeFileSync(hook,
      `#!/bin/sh\n: > ${JSON.stringify(hookMarker)}\ngit remote set-url origin ${JSON.stringify(publicRemote)}\n`);
    chmodSync(hook, 0o755);

    const publicRefsBefore = refs(publicRemote);
    const privateRefsBefore = refs(privateRemote);
    const codeHeadBefore = git(codeRoot, "rev-parse", "HEAD");
    const overlayHeadBefore = git(overlayRoot, "rev-parse", "HEAD");
    const result = commitAndPushHunch(join(overlayRoot, ".hunch"), "hunch: private memory", {
      push: true,
      protectedRepoRoot: codeRoot,
    });

    assert.equal(result, "pushed", "the guarded merge and private push complete without invoking repository hooks");
    assert.equal(existsSync(hookMarker), false, "the hostile post-merge hook never ran");
    assert.equal(refs(publicRemote), publicRefsBefore, "the public remote never advanced");
    assert.notEqual(refs(privateRemote), privateRefsBefore, "the private memory remote received the merged capture");
    assert.equal(git(codeRoot, "rev-parse", "HEAD"), codeHeadBefore);
    assert.notEqual(git(overlayRoot, "rev-parse", "HEAD"), overlayHeadBefore, "the private overlay advanced");
    assert.match(git(overlayRoot, "show", "HEAD:.hunch/decisions/dec_private.json"), /PRIVATE_POST_MERGE_SENTINEL/);
    assert.equal(realpathSync(git(overlayRoot, "remote", "get-url", "origin")), realpathSync(privateRemote),
      "the private remote identity remained unchanged");
    const leaked = spawnSync("git", [
      "--git-dir", publicRemote, "grep", "-n", "PRIVATE_POST_MERGE_SENTINEL", "refs/heads/main",
    ], { encoding: "utf8" });
    assert.equal(leaked.status, 1, "private memory never reached public history");
    const published = spawnSync("git", [
      "--git-dir", privateRemote, "grep", "-n", "PRIVATE_POST_MERGE_SENTINEL", "refs/heads/main",
    ], { encoding: "utf8" });
    assert.equal(published.status, 0, "private memory reached only the private memory remote");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("hunch private --repo refuses the code repository origin before cloning or attaching it", () => {
  const fixture = sameRemoteClones("hunch-cli-same-publication-");
  try {
    const publicConfigBefore = readFileSync(join(fixture.codeRoot, ".git", "config"), "utf8");
    const publicHeadBefore = fixture.git(fixture.codeRoot, "rev-parse", "HEAD");
    const publicStatusBefore = fixture.git(fixture.codeRoot, "status", "--porcelain");
    const remoteRefsBefore = execFileSync("git", [
      "--git-dir", fixture.remote, "for-each-ref", "--format=%(refname):%(objectname)",
    ], { encoding: "utf8" }).trim();

    const run = spawnSync(process.execPath, [tsx, cli, "private", "--repo", fixture.remote, "--no-hook"], {
      cwd: fixture.codeRoot,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
      encoding: "utf8",
    });
    const output = `${run.stdout}\n${run.stderr}`;

    assert.notEqual(run.status, 0, output);
    assert.match(output, /overlay remote must be different from every remote configured for the code repository/i);
    assert.equal(existsSync(join(fixture.codeRoot, ".hunch-private")), false, "preflight refusal happened before clone");
    assert.equal(existsSync(join(fixture.codeRoot, ".hunch", "local.json")), false, "no overlay pointer was written");
    assert.equal(readFileSync(join(fixture.codeRoot, ".git", "config"), "utf8"), publicConfigBefore,
      "the public repository's remote configuration is byte-identical");
    assert.equal(fixture.git(fixture.codeRoot, "rev-parse", "HEAD"), publicHeadBefore);
    assert.equal(fixture.git(fixture.codeRoot, "status", "--porcelain"), publicStatusBefore);
    assert.equal(execFileSync("git", [
      "--git-dir", fixture.remote, "for-each-ref", "--format=%(refname):%(objectname)",
    ], { encoding: "utf8" }).trim(), remoteRefsBefore, "CLI preflight did not mutate the code remote");
  } finally {
    fixture.cleanup();
  }
});

test("hunch private --repo resolves an existing overlay's relative remote before any attach, fetch, merge, or push", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-relative-overlay-remote-"));
  const publicRemote = join(base, "public.git");
  const seed = join(base, "seed");
  const codeRoot = join(base, "code");
  const overlayRoot = join(codeRoot, ".hunch-private");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const remoteRefs = (): string => execFileSync("git", [
    "--git-dir", publicRemote, "for-each-ref", "--format=%(refname):%(objectname)",
  ], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", publicRemote]);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "config", "user.email", "test@example.com");
    git(seed, "config", "user.name", "Test Human");
    writeFileSync(join(seed, "app.ts"), "export const publicCode = true;\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "public code");
    git(seed, "remote", "add", "origin", publicRemote);
    git(seed, "push", "-q", "-u", "origin", "main");

    execFileSync("git", ["clone", "-q", publicRemote, codeRoot]);
    execFileSync("git", ["clone", "-q", publicRemote, overlayRoot]);
    for (const checkout of [codeRoot, overlayRoot]) {
      git(checkout, "config", "user.email", "test@example.com");
      git(checkout, "config", "user.name", "Test Human");
      git(checkout, "config", "commit.gpgsign", "false");
    }
    git(overlayRoot, "remote", "remove", "origin");
    mkdirSync(join(overlayRoot, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(overlayRoot, ".hunch", "decisions", "dec_private.json"),
      JSON.stringify({ id: "dec_private", title: "PRIVATE_RELATIVE_REMOTE_SENTINEL" }) + "\n");
    git(overlayRoot, "add", "-A");
    git(overlayRoot, "commit", "-qm", "private memory");

    const publicRefsBefore = remoteRefs();
    const publicHeadBefore = git(codeRoot, "rev-parse", "HEAD");
    const overlayHeadBefore = git(overlayRoot, "rev-parse", "HEAD");
    const fetchHead = join(overlayRoot, ".git", "FETCH_HEAD");
    const fetchHeadBefore = existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null;
    const run = spawnSync(process.execPath, [
      tsx, cli, "private", "--repo", "../../public.git", "--no-hook", "--no-auto-commit",
    ], {
      cwd: codeRoot,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
      encoding: "utf8",
    });
    const output = `${run.stdout}\n${run.stderr}`;

    assert.notEqual(run.status, 0, output);
    assert.match(output, /overlay remote must be different|refusing to (?:attach|use) the overlay/i);
    assert.equal(remoteRefs(), publicRefsBefore, "the public remote was refused before any ref advanced");
    assert.equal(git(codeRoot, "rev-parse", "HEAD"), publicHeadBefore);
    assert.equal(git(overlayRoot, "rev-parse", "HEAD"), overlayHeadBefore);
    assert.equal(git(overlayRoot, "remote"), "", "the unsafe relative remote was never attached");
    assert.equal(existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null, fetchHeadBefore,
      "refusal happened before fetching the public remote into the overlay");
    assert.equal(existsSync(join(codeRoot, ".hunch", "local.json")), false, "no overlay pointer was written");
    const leaked = spawnSync("git", [
      "--git-dir", publicRemote, "grep", "-n", "PRIVATE_RELATIVE_REMOTE_SENTINEL", "refs/heads/main",
    ], { encoding: "utf8" });
    assert.equal(leaked.status, 1, "private memory never reached the public remote");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("hunch private accepts a final-component symlink to a distinct overlay and configures only its physical repository", () => {
  const project = repo("hunch-symlink-setup-project-");
  const physicalRoot = mkdtempSync(join(tmpdir(), "hunch-symlink-setup-real-"));
  const lexicalHolder = mkdtempSync(join(tmpdir(), "hunch-symlink-setup-holder-"));
  let store: HunchStore | null = null;
  try {
    writeFileSync(join(project.root, "app.ts"), "export const publicCode = true;\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "public code");
    const publicHeadBefore = project.git("rev-parse", "HEAD");
    const publicConfigBefore = readFileSync(join(project.root, ".git", "config"), "utf8");

    const realHunch = join(physicalRoot, ".hunch");
    mkdirSync(realHunch, { recursive: true });
    const linkedHunch = join(lexicalHolder, "linked-hunch");
    symlinkSync(realHunch, linkedHunch, "dir");

    const run = spawnSync(process.execPath, [
      tsx, cli, "private", linkedHunch, "--no-hook", "--no-auto-commit",
    ], {
      cwd: project.root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    assert.equal(realpathSync(execFileSync("git", ["-C", physicalRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim()), realpathSync(physicalRoot), "the physical overlay root was initialized as the repository");
    assert.ok(existsSync(join(physicalRoot, ".git")));
    assert.ok(existsSync(join(physicalRoot, ".gitattributes")), "merge attributes live with the physical overlay");
    assert.match(execFileSync("git", ["-C", physicalRoot, "config", "--get", "merge.hunch.driver"], {
      encoding: "utf8",
    }), /merge-driver/);
    assert.ok(existsSync(join(realHunch, "decisions")), "the Hunch layout was written through the final-component link");
    assert.ok(existsSync(join(realHunch, "constraints")));

    assert.equal(existsSync(join(lexicalHolder, ".git")), false, "the lexical holder was not initialized as a repository");
    assert.equal(existsSync(join(lexicalHolder, ".gitattributes")), false, "merge attributes were not written beside the link");
    assert.equal(readFileSync(join(project.root, ".git", "config"), "utf8"), publicConfigBefore,
      "the protected code repository did not receive overlay merge-driver configuration");
    assert.equal(project.git("rev-parse", "HEAD"), publicHeadBefore);

    const localPointer = JSON.parse(readFileSync(join(project.root, ".hunch", "local.json"), "utf8")) as {
      privateDir: string;
      autoCommit: boolean;
      mode: string;
    };
    assert.equal(localPointer.autoCommit, false);
    assert.equal(localPointer.mode, "private");
    assert.equal(realpathSync(resolve(project.root, localPointer.privateDir)), realpathSync(realHunch),
      "the per-worktree pointer resolves canonically to the physical store");
    const sharedPointer = JSON.parse(readFileSync(join(project.root, ".git", "hunch", "local.json"), "utf8")) as {
      privateDir: string;
      autoCommit: boolean;
      mode: string;
    };
    assert.equal(sharedPointer.autoCommit, false);
    assert.equal(sharedPointer.mode, "private");
    assert.equal(realpathSync(sharedPointer.privateDir), realpathSync(realHunch),
      "the shared worktree pointer remains valid through the final-component link");

    const savedPrivateDir = process.env.HUNCH_PRIVATE_DIR;
    delete process.env.HUNCH_PRIVATE_DIR;
    try {
      store = new HunchStore(hunchPaths(project.root));
      assert.ok(store.privateDir);
      assert.equal(realpathSync(store.privateDir), realpathSync(realHunch), "the stored pointer opens the intended overlay");
      assert.equal(store.privateAutoCommit, false);
      assert.equal(store.mode, "private");
    } finally {
      if (savedPrivateDir !== undefined) process.env.HUNCH_PRIVATE_DIR = savedPrivateDir;
    }
  } finally {
    store?.close();
    rmSync(lexicalHolder, { recursive: true, force: true });
    rmSync(physicalRoot, { recursive: true, force: true });
    project.cleanup();
  }
});

test("divergent repositories with shared code ancestry are never accepted as a memory publication", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-divergent-shared-ancestry-"));
  const seed = join(base, "seed");
  const codeRoot = join(base, "code");
  const overlayRoot = join(base, "contaminated-overlay");
  const memoryRemote = join(base, "memory.git");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const remoteRefs = (): string => execFileSync("git", [
    "--git-dir", memoryRemote, "for-each-ref", "--format=%(refname):%(objectname)",
  ], { encoding: "utf8" }).trim();
  try {
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "config", "user.email", "test@example.com");
    git(seed, "config", "user.name", "Test Human");
    writeFileSync(join(seed, "app.ts"), "export const sharedCodeAncestor = true;\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "code base");
    execFileSync("git", ["clone", "-q", seed, codeRoot]);
    execFileSync("git", ["clone", "-q", seed, overlayRoot]);
    for (const repoRoot of [codeRoot, overlayRoot]) {
      git(repoRoot, "config", "user.email", "test@example.com");
      git(repoRoot, "config", "user.name", "Test Human");
      git(repoRoot, "config", "commit.gpgsign", "false");
      git(repoRoot, "remote", "remove", "origin");
    }

    writeFileSync(join(codeRoot, "code-only.ts"), "export const newerCode = true;\n");
    git(codeRoot, "add", "code-only.ts");
    git(codeRoot, "commit", "-qm", "newer protected code");
    mkdirSync(join(overlayRoot, ".hunch/decisions"), { recursive: true });
    writeFileSync(join(overlayRoot, ".hunch/decisions/dec_first.json"),
      `${JSON.stringify({ id: "dec_first", title: "private memory on divergent tip" })}\n`);
    git(overlayRoot, "add", ".hunch/decisions/dec_first.json");
    git(overlayRoot, "commit", "-qm", "unique memory tip");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", memoryRemote]);
    git(overlayRoot, "remote", "add", "origin", memoryRemote);

    assert.notEqual(git(codeRoot, "rev-parse", "HEAD"), git(overlayRoot, "rev-parse", "HEAD"));
    assert.equal(sameGitPublication(codeRoot, overlayRoot), true,
      "a shared reachable root survives unique commits on both tips");
    assert.equal(repositoryUsesRemote(codeRoot, overlayRoot), true);

    const setup = spawnSync(process.execPath, [tsx, cli, "private", "--repo", overlayRoot, "--no-hook"], {
      cwd: codeRoot,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
      encoding: "utf8",
    });
    assert.notEqual(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
    assert.match(`${setup.stdout}\n${setup.stderr}`, /different from every remote configured for the code repository and from the code repository itself|publication/i);
    assert.equal(existsSync(join(codeRoot, ".hunch-private")), false);

    const savedPrivate = process.env.HUNCH_PRIVATE_DIR;
    process.env.HUNCH_PRIVATE_DIR = join(overlayRoot, ".hunch");
    try {
      assert.throws(() => new HunchStore(hunchPaths(codeRoot)), /unsafe private overlay|publication boundary/i,
        "direct pointer configuration is rejected too");
    } finally {
      if (savedPrivate === undefined) delete process.env.HUNCH_PRIVATE_DIR;
      else process.env.HUNCH_PRIVATE_DIR = savedPrivate;
    }

    const overlayHeadBefore = git(overlayRoot, "rev-parse", "HEAD");
    const remoteBefore = remoteRefs();
    writeFileSync(join(overlayRoot, ".hunch/decisions/dec_second.json"),
      `${JSON.stringify({ id: "dec_second", title: "must never publish code ancestry" })}\n`);
    const committed = commitAndPushHunch(join(overlayRoot, ".hunch"), "hunch: unsafe ancestry", {
      push: true,
      protectedRepoRoot: codeRoot,
    });
    assert.equal(committed, null);
    assert.equal(git(overlayRoot, "rev-parse", "HEAD"), overlayHeadBefore);
    assert.equal(git(overlayRoot, "diff", "--cached", "--name-only"), "");
    assert.equal(remoteRefs(), remoteBefore, "the memory remote receives neither code ancestry nor the new record");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sameGitPublication canonicalizes SCP/SSH and HTTPS default-port remote spellings without network access", () => {
  const scp = repo("hunch-remote-scp-");
  const ssh = repo("hunch-remote-ssh-");
  const httpsDefault = repo("hunch-remote-https-default-");
  const httpsImplicit = repo("hunch-remote-https-implicit-");
  try {
    scp.git("remote", "add", "origin", "git@github.com:OpenAI/example.git");
    ssh.git("remote", "add", "upstream", "ssh://git@github.com:22/openai/example");
    assert.equal(sameGitPublication(scp.root, ssh.root), true,
      "SCP syntax and explicit default-port SSH identify the same case-insensitive GitHub publication");

    httpsDefault.git("remote", "add", "origin", "https://GitHub.com:443/OpenAI/Example.git");
    httpsImplicit.git("remote", "add", "upstream", "https://github.com/openai/example");
    assert.equal(sameGitPublication(httpsDefault.root, httpsImplicit.root), true,
      "explicit and implicit HTTPS default ports identify the same publication");
  } finally {
    scp.cleanup();
    ssh.cleanup();
    httpsDefault.cleanup();
    httpsImplicit.cleanup();
  }
});

test("sameGitPublication canonicalizes Azure DevOps HTTPS, SSH, and legacy host aliases without network access", () => {
  const https = repo("hunch-remote-azure-https-");
  const ssh = repo("hunch-remote-azure-ssh-");
  const legacyHttps = repo("hunch-remote-azure-legacy-https-");
  const legacySsh = repo("hunch-remote-azure-legacy-ssh-");
  const differentRepo = repo("hunch-remote-azure-different-");
  const customPort = repo("hunch-remote-azure-custom-port-");
  try {
    https.git("remote", "add", "origin", "https://build-user@DEV.AZURE.COM.:443/Acme/Widgets/_git/API.git");
    ssh.git("remote", "add", "origin", "ssh://git@ssh.dev.azure.com:22/v3/acme/widgets/api");
    legacyHttps.git("remote", "add", "origin", "https://acme.visualstudio.com/widgets/_git/api");
    legacySsh.git("remote", "add", "origin", "git@vs-ssh.visualstudio.com:v3/acme/widgets/api");
    differentRepo.git("remote", "add", "origin", "git@ssh.dev.azure.com:v3/acme/widgets/not-api");
    customPort.git("remote", "add", "origin", "ssh://git@ssh.dev.azure.com:2222/v3/acme/widgets/api");

    assert.equal(sameGitPublication(https.root, ssh.root), true,
      "Azure HTTPS and explicit-default-port SSH identify the same publication");
    assert.equal(sameGitPublication(https.root, legacyHttps.root), true,
      "the legacy organization.visualstudio.com clone URL identifies the same publication");
    assert.equal(sameGitPublication(https.root, legacySsh.root), true,
      "the legacy vs-ssh.visualstudio.com clone URL identifies the same publication");
    assert.equal(repositoryUsesRemote(https.root, "git@ssh.dev.azure.com:v3/acme/widgets/api"), true,
      "the requested SSH spelling is refused when the code repository already configures the HTTPS publication");
    assert.equal(sameGitPublication(https.root, differentRepo.root), false,
      "provider aliasing never collapses distinct Azure repositories");
    assert.equal(sameGitPublication(https.root, customPort.root), false,
      "a non-default port remains a distinct publication endpoint");
  } finally {
    https.cleanup();
    ssh.cleanup();
    legacyHttps.cleanup();
    legacySsh.cleanup();
    differentRepo.cleanup();
    customPort.cleanup();
  }
});

test("HunchStore refuses an auto-commit-disabled privateDir nested in the protected code repository without its own Git boundary", () => {
  const project = repo("hunch-store-nested-unsafe-");
  try {
    writeFileSync(join(project.root, "app.ts"), "export const publicCode = true;\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "public code");
    const nestedHunch = join(project.root, "var", "deep", "private-memory", ".hunch");
    mkdirSync(nestedHunch, { recursive: true });
    mkdirSync(join(project.root, ".hunch"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "local.json"), JSON.stringify({
      privateDir: nestedHunch,
      autoCommit: false,
      mode: "private",
    }) + "\n");

    assert.throws(() => withoutPrivateEnv(() => {
      const unsafe = new HunchStore(hunchPaths(project.root));
      unsafe.close();
    }), /unsafe private overlay|standalone overlay repository/i,
    "storage containment is mandatory even when auto-commit is disabled");
    assert.equal(existsSync(join(project.root, "var", "deep", "private-memory", ".git")), false,
      "a read-side refusal never mutates the unsafe nested directory");
  } finally {
    project.cleanup();
  }
});

test("HunchStore refuses a nonexistent privateDir nested in the protected code repository before first write", () => {
  const project = repo("hunch-store-nested-missing-unsafe-");
  try {
    writeFileSync(join(project.root, "app.ts"), "export const publicCode = true;\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "public code");
    const nestedHunch = join(project.root, "not-created", "deep", "private-memory", ".hunch");
    mkdirSync(join(project.root, ".hunch"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "local.json"), JSON.stringify({
      privateDir: nestedHunch,
      autoCommit: false,
      mode: "private",
    }) + "\n");

    assert.equal(existsSync(join(project.root, "not-created")), false, "fixture starts with no private path");
    assert.throws(() => withoutPrivateEnv(() => {
      const unsafe = new HunchStore(hunchPaths(project.root));
      unsafe.close();
    }), /unsafe private overlay|standalone overlay repository/i,
    "repository identity resolves through the nearest existing ancestor");
    assert.equal(existsSync(join(project.root, "not-created")), false,
      "constructor refusal never creates the unsafe private path");
  } finally {
    project.cleanup();
  }
});

test("HunchStore treats malformed nested Git metadata as unsafe instead of a distinct publication", () => {
  const project = repo("hunch-store-nested-malformed-git-");
  try {
    writeFileSync(join(project.root, "app.ts"), "export const publicCode = true;\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "public code");
    const trap = join(project.root, "trap");
    const nestedHunch = join(trap, "missing", "deep", ".hunch");
    mkdirSync(trap, { recursive: true });
    writeFileSync(join(trap, ".git"), "gitdir: /definitely/missing/hunch-overlay-gitdir\n");
    mkdirSync(join(project.root, ".hunch"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "local.json"), JSON.stringify({
      privateDir: nestedHunch,
      autoCommit: false,
      mode: "private",
    }) + "\n");

    assert.throws(() => withoutPrivateEnv(() => {
      const unsafe = new HunchStore(hunchPaths(project.root));
      unsafe.close();
    }), /unsafe private overlay|standalone overlay repository/i,
    "unknown or malformed Git identity fails closed inside the public tree");
    assert.equal(existsSync(join(trap, "missing")), false, "no private store was created under the trap");
  } finally {
    project.cleanup();
  }
});

test("commitAndPushHunch disables hooks and commits only its exact validated memory paths", () => {
  const project = repo("hunch-memory-hook-injection-");
  try {
    writeFileSync(join(project.root, "app.ts"), "export const publicCode = true;\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "public code");
    mkdirSync(join(project.root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "decisions", "dec_safe.json"), JSON.stringify({ id: "dec_safe" }) + "\n");
    const hook = join(project.root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"privateDir\":\"/SECRET/hook-overlay\"}' > .hunch/local.json",
      "git add -f .hunch/local.json",
      "printf '%s\\n' 'HOOK_RAN' > hook-ran.txt",
    ].join("\n") + "\n");
    chmodSync(hook, 0o755);

    const result = commitAndPushHunch(join(project.root, ".hunch"), "hunch: public memory", { push: false });

    assert.equal(result, "committed");
    assert.match(project.git("ls-tree", "-r", "--name-only", "HEAD"), /\.hunch\/decisions\/dec_safe\.json/);
    assert.doesNotMatch(project.git("ls-tree", "-r", "--name-only", "HEAD"), /\.hunch\/local\.json/,
      "a hook cannot inject the private overlay pointer into the commit");
    assert.equal(existsSync(join(project.root, "hook-ran.txt")), false, "machine-generated memory commits do not execute repository hooks");
  } finally {
    project.cleanup();
  }
});

test("HunchStore accepts a nested privateDir whose parent is a distinct standalone Git repository", () => {
  const project = repo("hunch-store-nested-safe-");
  try {
    writeFileSync(join(project.root, "app.ts"), "export const publicCode = true;\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "public code");
    const overlayRoot = join(project.root, "var", "deep", "standalone-overlay");
    const nestedHunch = join(overlayRoot, ".hunch");
    mkdirSync(nestedHunch, { recursive: true });
    execFileSync("git", ["init", "-q", overlayRoot]);
    mkdirSync(join(project.root, ".hunch"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "local.json"), JSON.stringify({
      privateDir: nestedHunch,
      autoCommit: false,
      mode: "private",
    }) + "\n");

    const store = withoutPrivateEnv(() => new HunchStore(hunchPaths(project.root)));
    try {
      assert.equal(realpathSync(store.privateDir!), realpathSync(nestedHunch));
      assert.equal(store.hasPrivate, true);
      assert.equal(store.privateAutoCommit, false);
    } finally {
      store.close();
    }
  } finally {
    project.cleanup();
  }
});

test("public memory commit refuses a pre-staged package.json and preserves the user's index", () => {
  const project = repo("hunch-public-package-stage-");
  try {
    writeFileSync(join(project.root, "package.json"), JSON.stringify({ version: "1.0.0" }) + "\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "package baseline");
    writeFileSync(join(project.root, "package.json"), JSON.stringify({ version: "2.0.0" }) + "\n");
    project.git("add", "package.json");
    const cachedBefore = project.git("diff", "--cached", "--", "package.json");
    mkdirSync(join(project.root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "decisions", "dec_memory.json"), JSON.stringify({ id: "dec_memory" }) + "\n");
    const headBefore = project.git("rev-parse", "HEAD");

    const result = commitAndPushHunch(join(project.root, ".hunch"), "hunch: public memory", { push: false });

    assert.equal(result, null, "a public memory flush cannot absorb staged source/package work");
    assert.equal(project.git("rev-parse", "HEAD"), headBefore);
    assert.equal(project.git("diff", "--cached", "--name-only"), "package.json");
    assert.equal(project.git("diff", "--cached", "--", "package.json"), cachedBefore,
      "the user's staged package change is preserved byte-for-byte");
    assert.equal(project.git("diff", "--cached", "--name-only", "--", ".hunch"), "",
      "the refused Hunch record is unstaged for a later safe retry");
    assert.match(project.git("status", "--porcelain", "--", ".hunch"), /^\?\? \.hunch\//);
  } finally {
    project.cleanup();
  }
});

test("public memory commit never sweeps a pre-staged unrelated JSON file", () => {
  const project = repo("hunch-public-json-stage-");
  try {
    mkdirSync(join(project.root, "config"), { recursive: true });
    writeFileSync(join(project.root, "config", "settings.json"), JSON.stringify({ userChoice: "before" }) + "\n");
    project.git("add", "-A");
    project.git("commit", "-qm", "JSON baseline");
    writeFileSync(join(project.root, "config", "settings.json"), JSON.stringify({ userChoice: "PRIVATE_USER_STAGE" }) + "\n");
    project.git("add", "config/settings.json");
    const cachedBefore = project.git("diff", "--cached", "--", "config/settings.json");
    mkdirSync(join(project.root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(project.root, ".hunch", "decisions", "dec_memory.json"), JSON.stringify({ id: "dec_memory" }) + "\n");
    const headBefore = project.git("rev-parse", "HEAD");

    const result = commitAndPushHunch(join(project.root, ".hunch"), "hunch: public memory", { push: false });

    assert.equal(result, null, "JSON extension alone never grants a staged path to the memory commit");
    assert.equal(project.git("rev-parse", "HEAD"), headBefore);
    assert.equal(project.git("diff", "--cached", "--name-only"), "config/settings.json");
    assert.equal(project.git("diff", "--cached", "--", "config/settings.json"), cachedBefore,
      "the unrelated staged JSON remains in the user's index");
    assert.equal(project.git("diff", "--cached", "--name-only", "--", ".hunch"), "");
    assert.doesNotMatch(project.git("log", "-1", "--format=%B"), /hunch: public memory/);
  } finally {
    project.cleanup();
  }
});
