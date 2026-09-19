/**
 * Issue #316: linked worktrees share ONE `<git-common-dir>/hooks` directory.
 * Running `hunch init` / `hunch index` from a worktree that has its own
 * checkout or node_modules used to re-point the main checkout's hooks (and
 * every sibling worktree's) at that worktree's code — so `git worktree remove`
 * left every hook dead, and an advisory re-run silently downgraded a strict
 * pre-commit guard. An install from a worktree must keep the repo's existing
 * shared launcher instead.
 *
 * Every fixture is a temp repo and a temp worktree under os.tmpdir(), never a
 * real checkout or worktree of this repo (con_38bf8aa397) — that exact bug once
 * clobbered this repo's own hooks. Hook files are only ever read, never run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  installPostCommitHook, installPreCommitHook, installPostMergeHook, installPostCheckoutHook,
  hookStatus, formatHookInstall, sharedHooksNote,
  type HookInstall,
} from "../src/integrations/hooks.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A fake launcher on disk: `<dir>/dist/cli/index.js`, so hookInvocationHealth
 *  calls the invocation healthy (the file exists and ends in /cli/index.js). */
function launcher(dir: string): string {
  const entry = join(dir, "dist", "cli", "index.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "// fake hunch launcher — never executed by these tests\n");
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)}`;
}

interface Fixture {
  /** The main checkout. */
  main: string;
  /** A linked worktree of it. */
  wt: string;
  /** A SECOND linked worktree of it. */
  wt2: string;
  /** An invocation OUTSIDE every worktree (a "global" install). */
  global: string;
  /** A second such invocation (a different global install). */
  global2: string;
  /** An invocation inside the worktree's own node_modules. */
  local: string;
  /** An invocation inside the SECOND worktree's own node_modules. */
  local2: string;
  /** The absolute paths of the two global launchers' entry files. */
  globalEntry: string;
  global2Entry: string;
  /** The temp base holding all of the above. */
  base: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "hunch-wt316-")));
  const main = join(base, "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "hooks@test.invalid");
  git(main, "config", "user.name", "Shared Hooks");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");

  const wt = join(base, "wt");
  git(main, "worktree", "add", "-q", "-b", "wt", wt);
  const wt2 = join(base, "wt2");
  git(main, "worktree", "add", "-q", "-b", "wt2", wt2);

  return {
    main, wt, wt2, base,
    global: launcher(join(base, "global")),
    global2: launcher(join(base, "global2")),
    local: launcher(join(wt, "node_modules", "@davesheffer", "hunch")),
    local2: launcher(join(wt2, "node_modules", "@davesheffer", "hunch")),
    globalEntry: join(base, "global", "dist", "cli", "index.js"),
    global2Entry: join(base, "global2", "dist", "cli", "index.js"),
    cleanup: () => { rmSync(base, { recursive: true, force: true }); },
  };
}

const hookFile = (root: string, name: string): string => join(root, ".git", "hooks", name);
const read = (root: string, name: string): string => readFileSync(hookFile(root, name), "utf8");

/** Install all four hooks with one invocation. */
function installAll(root: string, inv: string, strict: boolean): Record<string, HookInstall> {
  return {
    postCommit: installPostCommitHook(root, inv),
    postMerge: installPostMergeHook(root, inv),
    postCheckout: installPostCheckoutHook(root, inv),
    preCommit: installPreCommitHook(root, inv, strict),
  };
}

const HOOK_NAMES = ["post-commit", "post-merge", "post-checkout", "pre-commit"];

test("1. a worktree-local install keeps every shared hook pointing at the repo's own Hunch", () => {
  const f = fixture();
  try {
    installAll(f.main, f.global, true);
    const before = Object.fromEntries(HOOK_NAMES.map((n) => [n, read(f.main, n)]));

    const after = installAll(f.wt, f.local, false);
    for (const [name, h] of Object.entries(after)) {
      assert.equal(h.action, "kept-shared", `${name} must be kept-shared`);
      assert.equal(h.sharedInvocation, f.global, `${name} reports the repo's shared invocation`);
    }
    assert.deepEqual(after.preCommit!.keptFlags, ["--strict"], "the strict guard is not downgraded to advisory");
    for (const name of HOOK_NAMES) {
      assert.equal(read(f.main, name), before[name], `${name} is byte-identical`);
      assert.ok(!read(f.main, name).includes(f.wt), `${name} does not mention the worktree path`);
    }
  } finally { f.cleanup(); }
});

test("2. a worktree install may ADD an option to the shared block, still without re-pointing it", () => {
  const f = fixture();
  try {
    installPreCommitHook(f.main, f.global, false);
    const h = installPreCommitHook(f.wt, f.local, true);
    assert.equal(h.action, "updated");
    assert.equal(h.sharedInvocation, f.global);
    const text = read(f.main, "pre-commit");
    assert.ok(text.includes(f.global), "the block still runs the global launcher");
    assert.match(text, /check --staged --strict/);
    assert.ok(!text.includes(f.wt), "the worktree path never reaches the shared hook");
  } finally { f.cleanup(); }
});

test("3. a global upgrade run from a worktree still re-points the shared hooks", () => {
  const f = fixture();
  try {
    installPostCommitHook(f.main, f.global);
    const h = installPostCommitHook(f.wt, f.global2);
    assert.equal(h.action, "updated");
    assert.equal(h.sharedInvocation, undefined, "nothing was substituted — the new invocation is not worktree-bound");
    const text = read(f.main, "post-commit");
    assert.ok(text.includes(f.global2), "re-pointed at the second global install");
    assert.ok(!text.includes(f.globalEntry), "the first global install is gone from the block");
  } finally { f.cleanup(); }
});

test("4. a STALE shared block with no healthy sibling is replaced by the worktree-local install", () => {
  const f = fixture();
  try {
    installPostCommitHook(f.main, f.global);
    rmSync(f.globalEntry, { force: true }); // the global install is gone: the block is stale
    const h = installPostCommitHook(f.wt, f.local);
    assert.equal(h.action, "updated");
    assert.equal(h.sharedInvocation, undefined);
    assert.ok(read(f.main, "post-commit").includes(f.wt), "with nothing healthy left, the worktree's own path is better than a dead one");
  } finally { f.cleanup(); }
});

test("5. a MISSING block adopts a healthy sibling's shared invocation, but a wholly unhooked repo does not", () => {
  const f = fixture();
  try {
    // post-commit is healthy and global; post-checkout was never installed
    // (the `hunch index` self-heal path, which agents run from worktrees).
    installPostCommitHook(f.main, f.global);
    const h = installPostCheckoutHook(f.wt, f.local);
    assert.ok(["created", "appended"].includes(h.action), `expected created/appended, got ${h.action}`);
    assert.equal(h.sharedInvocation, f.global, "it borrowed the sibling block's launcher");
    assert.ok(read(f.main, "post-checkout").includes(f.global));
    assert.ok(!read(f.main, "post-checkout").includes(f.wt));
  } finally { f.cleanup(); }

  const g = fixture();
  try {
    const h = installPostCommitHook(g.wt, g.local);
    assert.equal(h.action, "created", "nothing to inherit — the first install wins");
    assert.equal(h.sharedInvocation, undefined);
    assert.ok(read(g.main, "post-commit").includes(g.wt));
  } finally { g.cleanup(); }
});

test("6. a shared block already pointing INSIDE this worktree is updated normally", () => {
  const f = fixture();
  try {
    installPostCommitHook(f.main, f.local);
    const other = launcher(join(f.wt, "node_modules", "other"));
    const h = installPostCommitHook(f.wt, other);
    assert.equal(h.action, "updated");
    assert.equal(h.sharedInvocation, undefined, "the existing command is worktree-bound too — nothing to preserve");
    assert.ok(read(f.main, "post-commit").includes(other));
  } finally { f.cleanup(); }
});

test("7. regression: the MAIN checkout re-pointing its own hooks is untouched", () => {
  const f = fixture();
  try {
    installPostCommitHook(f.main, f.global);
    const h = installPostCommitHook(f.main, f.global2);
    assert.equal(h.action, "updated");
    assert.equal(h.sharedInvocation, undefined);
    assert.equal(h.keptFlags, undefined);
  } finally { f.cleanup(); }
});

test("8. installPostMergeHook from a worktree keeps both halves shared, without throwing", () => {
  const f = fixture();
  try {
    installPostMergeHook(f.main, f.global);
    const before = read(f.main, "post-merge");
    const h = installPostMergeHook(f.wt, f.local);
    assert.equal(h.action, "kept-shared");
    assert.equal(h.sharedInvocation, f.global);
    assert.equal(read(f.main, "post-merge"), before, "the shared post-merge hook is untouched");
  } finally { f.cleanup(); }
});

test("9. removing the worktree leaves every hook of the main checkout installed", () => {
  const f = fixture();
  try {
    installAll(f.main, f.global, true);
    installAll(f.wt, f.local, false);
    git(f.main, "worktree", "remove", "--force", f.wt);
    assert.deepEqual(hookStatus(f.main), { postCommit: true, preCommit: true, postMerge: true, postCheckout: true });
  } finally { f.cleanup(); }
});

test("10. sharedHooksNote reports what the shared blocks actually RUN, from either checkout", () => {
  const f = fixture();
  try {
    assert.deepEqual(sharedHooksNote(f.main, []), [], "an unhooked repo has nothing to warn about");

    // (a) the shared invocation was kept / substituted
    installAll(f.main, f.global, false);
    const kept = Object.values(installAll(f.wt, f.local, false));
    const a = sharedHooksNote(f.wt, kept);
    assert.equal(a.length, 1);
    assert.match(a[0]!, /^ {2}✓ linked worktree — sharing the repo's memory;/);
    assert.match(a[0]!, /shared by 3 worktrees/);
    assert.match(a[0]!, /keeps running the repo's Hunch, not this worktree's$/);

    // (b) a worktree-bound invocation actually sits in the shared hooks — the
    // SAME warning from the worktree and from the main checkout.
    const g = fixture();
    try {
      const wrote = Object.values(installAll(g.wt, g.local, false));
      for (const [where, root] of [["worktree", g.wt], ["main checkout", g.main]] as const) {
        const b = sharedHooksNote(root, root === g.wt ? wrote : []);
        assert.equal(b.length, 1, where);
        assert.match(b[0]!, /^ {2}⚠ shared hooks dir \(/, where);
        assert.match(b[0]!, /run Hunch from inside a linked worktree \(/, where);
        assert.ok(b[0]!.includes(g.wt), `${where} names the worktree that owns the launcher`);
      }
    } finally { g.cleanup(); }

    // (c) nothing worktree-bound involved at all, and no substitution happened
    const c = sharedHooksNote(f.wt, [{ path: "x", action: "unchanged" }]);
    assert.equal(c.length, 1);
    assert.match(c[0]!, /^ {2}✓ linked worktree — sharing the repo's hooks \+ memory \(hooks dir is shared by 3 worktrees: /);

    // (d) this run wrote nothing at all (every hook is owned elsewhere)
    const d = sharedHooksNote(f.wt, [{ path: "x", action: "managed-elsewhere" }]);
    assert.deepEqual(d, ["  ✓ linked worktree — sharing the repo's memory"]);
    assert.deepEqual(sharedHooksNote(f.wt, []), ["  ✓ linked worktree — sharing the repo's memory"]);
  } finally { f.cleanup(); }
});

test("11. formatHookInstall renders kept-shared and a substituted install truthfully", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hunch-wt316-fmt-")));
  try {
    const base: HookInstall = { path: join(root, "pre-commit"), action: "kept-shared", sharedInvocation: "node /g/cli/index.js" };
    assert.deepEqual(
      formatHookInstall(root, "pre-commit constraint guard", { ...base, keptFlags: ["--strict"] }, " (advisory)"),
      ["  ✓ pre-commit constraint guard kept — the shared hook keeps running node /g/cli/index.js with --strict (not re-pointed at this worktree) — to change its options, re-run `hunch init` with a Hunch that is not inside a linked worktree (a global install, or the main checkout's)"],
      "the requested detail is dropped — those options were NOT applied — and the way out is spelled out",
    );
    assert.deepEqual(
      formatHookInstall(root, "post-commit hook", base, " (learning loop)"),
      ["  ✓ post-commit hook kept — the shared hook keeps running node /g/cli/index.js (not re-pointed at this worktree)"],
    );
    assert.deepEqual(
      formatHookInstall(root, "post-commit hook", { path: base.path, action: "updated", sharedInvocation: "node /g/cli/index.js" }, " (learning loop)"),
      ["  ✓ post-commit hook updated (learning loop) — runs the repo's shared Hunch (node /g/cli/index.js), not this worktree's"],
    );
    assert.deepEqual(
      formatHookInstall(root, "post-commit hook", { path: base.path, action: "updated" }, " (learning loop)"),
      ["  ✓ post-commit hook updated (learning loop)"],
      "an ordinary install is unchanged",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("12. a block bound to ANOTHER linked worktree is not a shared launcher either", () => {
  const f = fixture();
  try {
    // The hooks were installed from wt2's own node_modules: they are already
    // doomed, so wt must not adopt them as "the repo's shared Hunch".
    installAll(f.main, f.local2, false);
    const h = installPostCommitHook(f.wt, f.local);
    assert.notEqual(h.action, "kept-shared", "wt2's launcher is no safer than wt's");
    assert.equal(h.sharedInvocation, undefined);

    const note = sharedHooksNote(f.wt, [h]);
    assert.equal(note.length, 1);
    assert.match(note[0]!, /^ {2}⚠ shared hooks dir \(/);
  } finally { f.cleanup(); }
});

test("13. a BARE repo's worktrees share the hooks dir, and the bare entry is not a worktree", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "hunch-wt316-bare-")));
  try {
    const bare = join(base, "repo.git");
    const seed = join(base, "seed");
    mkdirSync(seed, { recursive: true });
    git(base, "init", "-q", "--bare", "-b", "main", bare);
    git(base, "clone", "-q", bare, seed);
    git(seed, "config", "user.email", "hooks@test.invalid");
    git(seed, "config", "user.name", "Shared Hooks");
    git(seed, "config", "commit.gpgsign", "false");
    writeFileSync(join(seed, "README.md"), "bare fixture\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");

    const a = join(base, "a");
    const b = join(base, "b");
    git(bare, "worktree", "add", "-q", a, "main");
    git(bare, "worktree", "add", "-q", "-b", "b", b);
    const localA = launcher(join(a, "node_modules", "@davesheffer", "hunch"));
    const localB = launcher(join(b, "node_modules", "@davesheffer", "hunch"));

    // With a bare repo EVERY checkout is a linked worktree, so an install from
    // a is just as doomed as one from b — b must not adopt a's launcher.
    installPostCommitHook(a, localA);
    const h = installPostCommitHook(b, localB);
    assert.notEqual(h.action, "kept-shared");
    assert.equal(h.sharedInvocation, undefined);
    assert.match(sharedHooksNote(b, [h])[0]!, /^ {2}⚠ shared hooks dir \(/);

    // A healthy global launcher clears the warning, and the count is the two
    // real worktrees — the bare entry is a git dir, not a checkout.
    const global = launcher(join(base, "global"));
    const healed = installPostCommitHook(b, global);
    assert.equal(healed.action, "updated");
    const ok = sharedHooksNote(b, [healed]);
    assert.equal(ok.length, 1);
    assert.match(ok[0]!, /^ {2}✓ linked worktree — sharing the repo's hooks \+ memory \(hooks dir is shared by 2 worktrees: /);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("14. an install from wt with a launcher inside wt2 keeps the repo's unbound launcher", () => {
  const f = fixture();
  try {
    installPostCommitHook(f.main, f.global);
    const h = installPostCommitHook(f.wt, f.local2);
    assert.equal(h.action, "kept-shared", "the caller's own root is irrelevant — its launcher is worktree-bound");
    assert.equal(h.sharedInvocation, f.global);
    assert.ok(!read(f.main, "post-commit").includes(f.wt2));
  } finally { f.cleanup(); }
});

test("15. an install from the MAIN checkout with a worktree-bound launcher is gated too", () => {
  const f = fixture();
  try {
    installPostCommitHook(f.main, f.global);
    const h = installPostCommitHook(f.main, f.local);
    assert.equal(h.action, "kept-shared", "running from the main checkout does not make a doomed path safe");
    assert.equal(h.sharedInvocation, f.global);
    assert.ok(!read(f.main, "post-commit").includes(f.wt));
  } finally { f.cleanup(); }
});

test("16. a launcher path textually inside a worktree counts as bound even when it symlinks out", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    // <wt2>/node_modules/@davesheffer/hunch -> <base>/global: the FILE survives
    // `git worktree remove`, but the path the hook would run does not.
    const link = join(f.wt2, "node_modules", "linked");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(f.base, "global"), link, "dir");
    const viaLink = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(link, "dist", "cli", "index.js"))}`;

    installPostCommitHook(f.main, f.global);
    const h = installPostCommitHook(f.wt, viaLink);
    assert.equal(h.action, "kept-shared", "a path spelled through the worktree is bound to it");
    assert.equal(h.sharedInvocation, f.global);
    const note = sharedHooksNote(f.wt, [h]);
    assert.equal(note.length, 1);
    assert.match(note[0]!, /^ {2}✓ /, "nothing in the shared hooks is worktree-bound, so no warning");
  } finally { f.cleanup(); }
});

test("17. a SECOND init run from the worktree warns exactly as loudly as the first", () => {
  const f = fixture();
  try {
    const first = Object.values(installAll(f.wt, f.local, false));
    const a = sharedHooksNote(f.wt, first);
    assert.equal(a.length, 1);
    assert.match(a[0]!, /^ {2}⚠ shared hooks dir \(/);

    // The second run writes nothing at all — and the hooks are just as broken.
    const second = Object.values(installAll(f.wt, f.local, false));
    assert.ok(second.every((h) => h.action === "unchanged"), `expected all unchanged, got ${second.map((h) => h.action).join(",")}`);
    const b = sharedHooksNote(f.wt, second);
    assert.deepEqual(b, a, "the warning does not depend on this run having written something");
  } finally { f.cleanup(); }
});

test("18. the warning names only the hooks that are actually bound to a worktree", () => {
  const f = fixture();
  try {
    // The bad block goes in FIRST, while the repo has nothing healthy to
    // inherit — the only way a worktree path legitimately reaches the hooks.
    installPostCheckoutHook(f.wt, f.local);
    installPostCommitHook(f.main, f.global);
    installPostMergeHook(f.main, f.global);
    installPreCommitHook(f.main, f.global, false);
    const note = sharedHooksNote(f.main, []);
    assert.equal(note.length, 1);
    assert.match(note[0]!, /— post-checkout runs Hunch from inside a linked worktree \(/);
    assert.ok(!note[0]!.includes("post-commit"), "the healthy hooks are not accused");
    assert.match(note[0]!, /breaks it for every checkout of this repo/, "singular, because one hook is affected");
  } finally { f.cleanup(); }
});

test("19. rebuilding a stale own block from a sibling's launcher REPORTS the flags it drops", () => {
  const f = fixture();
  try {
    // A strict pre-commit guard pointing at a global install that then vanishes,
    // plus a healthy post-commit sibling to rebuild from.
    installPreCommitHook(f.main, f.global2, true);
    installPostCommitHook(f.main, f.global);
    rmSync(f.global2Entry, { force: true });

    const h = installPreCommitHook(f.wt, f.local, false);
    assert.equal(h.action, "updated");
    assert.equal(h.sharedInvocation, f.global, "rebuilt from the healthy sibling, not from the worktree");
    assert.deepEqual(h.droppedFlags, ["--strict"], "the guard was downgraded — say so");
    assert.match(formatHookInstall(f.main, "pre-commit constraint guard", h, " (advisory)").join("\n"), /--strict/);
  } finally { f.cleanup(); }
});

test("20. a flag-like segment in the launcher PATH is not mistaken for a block option", () => {
  const f = fixture();
  try {
    // The shared Hunch lives under a directory literally named `opt --strict x`.
    const odd = launcher(join(f.base, "opt --strict x", "global"));
    installPreCommitHook(f.main, odd, true);
    const before = read(f.main, "pre-commit");

    const h = installPreCommitHook(f.wt, f.local, false);
    assert.equal(h.action, "kept-shared", "the advisory re-run must not silently drop the real --strict");
    assert.deepEqual(h.keptFlags, ["--strict"]);
    assert.equal(read(f.main, "pre-commit"), before, "the strict guard is byte-identical");
  } finally { f.cleanup(); }
});

test("21. a relative core.hooksPath in a worktree is per-checkout, not shared", () => {
  const f = fixture();
  try {
    // husky's shape: `core.hooksPath=.githooks` resolves against whichever
    // checkout git runs in, so a worktree-local launcher there harms nobody else.
    git(f.main, "config", "core.hooksPath", ".githooks");
    mkdirSync(join(f.wt, ".githooks"), { recursive: true });
    writeFileSync(join(f.wt, ".gitignore"), ".githooks/\n");
    const h = installPostCommitHook(f.wt, f.local);
    assert.equal(h.sharedInvocation, undefined, "nothing shared to preserve");
    assert.deepEqual(sharedHooksNote(f.wt, [h]), ["  ✓ linked worktree — sharing the repo's memory"]);
  } finally { f.cleanup(); }
});
