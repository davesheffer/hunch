import { cleanupDir } from "./fixtures.js";
/**
 * Memory lane Phase 1, part 2 (hunch-private#62): `hunch log --for <commit|branch>`
 * attributes each memory commit to the feature commit it led to.
 *
 * Rule: memory committed on a branch while HEAD = C1, before the next code commit
 * C2 on that branch's first-parent line, belongs to C2. Memory after the last code
 * commit is in progress. When the branch lands on the default branch, each feature
 * commit maps to the commit that carries it there: the merge commit, the squash
 * commit, or the rebased copy (by patch-id). Unknown stays unknown, never guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commitAndPushHunch } from "../src/extractors/git.js";
import { attributeLine, type LineCommit, type MemoryMove } from "../src/core/memorylog.js";
import { memoryFor, type MemoryFor } from "../src/extractors/featurelog.js";

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function repo(): { root: string; hunch: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-logfor-"));
  git(root, "init", "-q", "-b", "main", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  const hunch = join(root, ".hunch");
  for (const d of ["decisions", "findings", "tasks"]) mkdirSync(join(hunch, d), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n");
  writeFileSync(join(root, "app.ts"), "export const a = 0;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "feat: seed");
  return { root, hunch, cleanup: () => cleanupDir(root) };
}

let n = 0;
/** A code commit touching its own file, so patch-ids stay distinct and cherry-picks apply. */
function code(root: string, subject: string): string {
  writeFileSync(join(root, `f${++n}.ts`), `export const v${n} = ${n};\n`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", subject);
  return git(root, "rev-parse", "HEAD");
}

/** A public memory commit through the real writer (it carries the code-link trailers). */
function memory(hunch: string, dir: string, id: string): void {
  mkdirSync(join(hunch, dir), { recursive: true }); // a checkout drops a directory left empty
  writeFileSync(join(hunch, dir, `${id}.json`), JSON.stringify({ id }) + "\n");
  assert.equal(commitAndPushHunch(hunch, `hunch: capture ${id}`, { push: false }), "committed");
}

/** group → [feature commit subject | "(after)", landed sha | null, record ids oldest first]. */
const shape = (r: MemoryFor): Array<[string, string | null, string[]]> =>
  r.groups.map((g) => [
    g.commit?.subject ?? "(after)",
    g.landed,
    [...g.moves].reverse().flatMap((m) => [...m.decisionIds, ...m.otherIds]),
  ]);

// ---- the pure rule ------------------------------------------------------------

const move = (sha: string, id: string): MemoryMove => ({
  sha, shortSha: sha.slice(0, 7), date: "2026-11-04T00:00:00Z", subject: `hunch: capture ${id}`, kind: "capture",
  decisionIds: [id], otherIds: [], added: 1, modified: 0, deleted: 0, files: [`.hunch/decisions/${id}.json`],
  codeBranch: null, codeHead: null,
});
const line = (sha: string, opts: { memory?: string; code?: string; parents?: number }): LineCommit => ({
  sha, shortSha: sha.slice(0, 7), date: "2026-11-04T00:00:00Z",
  subject: opts.code ?? `hunch: capture ${opts.memory}`,
  parents: Array.from({ length: opts.parents ?? 1 }, (_, i) => `p${i}`),
  memoryOnly: !opts.code,
  move: opts.memory ? move(sha, opts.memory) : null,
});

test("attributeLine: memory belongs to the next code commit; memory after the last one trails", () => {
  // newest first, as git emits it
  const groups = attributeLine([
    line("m4", { memory: "dec_d" }),
    line("c3", { code: "feat: c3" }),
    line("c2", { code: "feat: c2", memory: "dec_c" }), // a code commit that also changed memory
    line("m2", { memory: "dec_b" }),
    line("m1", { memory: "dec_a" }),
    line("c1", { code: "feat: c1" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.commit?.sha ?? null, g.moves.map((m) => m.sha)]),
    [[null, ["m4"]], ["c2", ["c2", "m2", "m1"]]],
    "c3 and c1 carry no memory and are not listed; moves are newest first",
  );
  assert.equal(groups.every((g) => g.landed === null), true, "landing is the extractor's job");
});

test("attributeLine: a merge commit's own memory diff is the other side's, not its own", () => {
  const groups = attributeLine([
    line("x", { code: "Merge branch 'main' into feat/b", memory: "dec_ffff", parents: 2 }),
    line("m1", { memory: "dec_a" }),
  ]);
  assert.deepEqual(groups.map((g) => [g.commit?.sha, g.moves.map((m) => m.sha)]), [["x", ["m1"]]]);
});

// ---- against real git ----------------------------------------------------------

test("--for <branch>: unmerged feature branch groups memory by feature commit, the tail in progress", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    code(root, "feat: c1");
    memory(hunch, "decisions", "dec_a");
    memory(hunch, "tasks", "htask_0a1b2c");
    code(root, "feat: c2");
    memory(hunch, "findings", "fnd_9f8e");

    const r = memoryFor(root, "feat/b");
    assert.equal(r.kind, "branch");
    assert.equal(r.branch, "feat/b");
    assert.equal(r.merged?.status, "unmerged");
    assert.deepEqual(shape(r), [
      ["(after)", null, ["fnd_9f8e"]],
      ["feat: c2", null, ["dec_a", "htask_0a1b2c"]],
    ], "task and finding ids are listed alongside decisions");
  } finally { cleanup(); }
});

test("--for <branch>: memory committed on main before the fork is not the branch's", () => {
  const { root, hunch, cleanup } = repo();
  try {
    memory(hunch, "decisions", "dec_ffff");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_b");
    code(root, "feat: c1");
    assert.deepEqual(shape(memoryFor(root, "feat/b")), [["feat: c1", null, ["dec_b"]]]);
  } finally { cleanup(); }
});

test("--for <branch>: a merge of main into the branch does not pull main's memory in", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_b");
    code(root, "feat: c1");
    git(root, "switch", "-q", "main");
    memory(hunch, "decisions", "dec_ffff");
    code(root, "feat: main work");
    git(root, "switch", "-q", "feat/b");
    git(root, "merge", "-q", "--no-ff", "--no-edit", "main");
    code(root, "feat: c2");
    assert.deepEqual(shape(memoryFor(root, "feat/b")), [["feat: c1", null, ["dec_b"]]]);
  } finally { cleanup(); }
});

test("--for <branch>: a squash-merged branch maps every feature commit to the squash commit", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_a");
    code(root, "feat: c1");
    memory(hunch, "decisions", "dec_b");
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--squash", "feat/b");
    git(root, "commit", "-qm", "feat: b (#7)");
    const squash = git(root, "rev-parse", "HEAD");

    const r = memoryFor(root, "feat/b");
    assert.equal(r.merged?.method, "squash");
    assert.deepEqual(shape(r), [["(after)", squash, ["dec_b"]], ["feat: c1", squash, ["dec_a"]]]);
  } finally { cleanup(); }
});

test("--for <branch>: a rebase-merged branch maps each feature commit to its copy by patch-id", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_a");
    code(root, "feat: c1");
    memory(hunch, "decisions", "dec_b");
    code(root, "feat: c2");
    git(root, "switch", "-q", "main");
    code(root, "feat: main moved on");
    git(root, "cherry-pick", "main..feat/b");
    const copies = git(root, "log", "--format=%H %s", "-n4").split("\n").map((l) => l.split(" "));
    const copyOf = (subject: string): string => copies.find((c) => c.slice(1).join(" ") === subject)![0]!;

    const r = memoryFor(root, "feat/b");
    assert.equal(r.merged?.method, "rebase");
    assert.deepEqual(shape(r), [
      ["feat: c2", copyOf("feat: c2"), ["dec_b"]],
      ["feat: c1", copyOf("feat: c1"), ["dec_a"]],
    ]);
  } finally { cleanup(); }
});

test("--for <default branch> and --for <merge commit>: a merged branch's memory lands with its merge", () => {
  const { root, hunch, cleanup } = repo();
  try {
    memory(hunch, "decisions", "dec_ffff");
    code(root, "feat: main c1");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_a");
    code(root, "feat: c1");
    memory(hunch, "decisions", "dec_b");
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "Merge pull request #9 from me/feat/b", "feat/b");
    const merge = git(root, "rev-parse", "HEAD");
    git(root, "branch", "-q", "-D", "feat/b");

    const main = memoryFor(root, "main");
    assert.equal(main.kind, "branch");
    assert.deepEqual(shape(main), [
      ["(after)", merge, ["dec_b"]],
      ["feat: c1", merge, ["dec_a"]],
      ["feat: main c1", null, ["dec_ffff"]],
    ]);

    const byCommit = memoryFor(root, merge.slice(0, 10));
    assert.equal(byCommit.kind, "commit");
    assert.deepEqual(shape(byCommit), [["(after)", merge, ["dec_b"]], ["feat: c1", merge, ["dec_a"]]]);
  } finally { cleanup(); }
});

test("--for <branch>: a merge-committed branch that still exists maps to its merge commit", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_a");
    code(root, "feat: c1");
    git(root, "switch", "-q", "main");
    code(root, "feat: main moved on");
    git(root, "merge", "-q", "--no-ff", "--no-edit", "feat/b");
    const merge = git(root, "rev-parse", "HEAD");
    code(root, "feat: later");

    const r = memoryFor(root, "feat/b");
    assert.equal(r.merged?.method, "ancestry");
    assert.deepEqual(shape(r), [["feat: c1", merge, ["dec_a"]]]);
  } finally { cleanup(); }
});

test("--for <commit>: the memory captured before that commit, back to the previous code commit", () => {
  const { root, hunch, cleanup } = repo();
  try {
    memory(hunch, "decisions", "dec_0001");
    const c1 = code(root, "feat: c1");
    memory(hunch, "decisions", "dec_a");
    memory(hunch, "decisions", "dec_b");
    const c2 = code(root, "feat: c2");
    memory(hunch, "decisions", "dec_af7e");

    assert.deepEqual(shape(memoryFor(root, c2)), [["feat: c2", null, ["dec_a", "dec_b"]]]);
    assert.deepEqual(shape(memoryFor(root, c1)), [["feat: c1", null, ["dec_0001"]]]);
    const mem = memoryFor(root, "HEAD");
    assert.deepEqual(mem.groups, [], "a memory commit is not a feature commit");
    assert.match(mem.notes.join("\n"), /memory commit/);
  } finally { cleanup(); }
});

test("--for: an unknown commit or branch is an error, and an option-like query is not run as one", () => {
  const { root, cleanup } = repo();
  try {
    assert.throws(() => memoryFor(root, "no-such-branch"), /not a branch or commit/);
    assert.throws(() => memoryFor(root, "--output=x"), /not a branch or commit/);
  } finally { cleanup(); }
});

test("hunch log --for <branch> --json emits the attribution", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_a");
    code(root, "feat: c1");
    const r = spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), join(process.cwd(), "src/cli/index.ts"), "log", "--for", "feat/b", "--json"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as MemoryFor;
    assert.equal(out.branch, "feat/b");
    assert.deepEqual(shape(out), [["feat: c1", null, ["dec_a"]]]);
  } finally { cleanup(); }
});

// ---- review fixes: clones, shallow history, octopus and transparent merges ------

test("attributeLine: a merge the caller does not own is transparent, so memory passes through it", () => {
  const l = [
    line("c2", { code: "feat: c2" }),
    line("x", { code: "Merge branch 'main' into feat/b", parents: 2 }),
    line("m1", { memory: "dec_b" }),
    line("c1", { code: "feat: c1" }),
  ];
  assert.deepEqual(attributeLine(l, () => false).map((g) => [g.commit?.sha, g.moves.map((m) => m.sha)]), [["c2", ["m1"]]]);
  assert.deepEqual(attributeLine(l).map((g) => [g.commit?.sha, g.moves.map((m) => m.sha)]), [["x", ["m1"]]], "owning is the default");
});

/** A second checkout of `root` (a shallow one at `depth` through a file:// URL, since a plain path ignores --depth). */
function clone(root: string, depth?: number): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hunch-logfor-clone-"));
  const src = depth ? pathToFileURL(root).href : root;
  git(dir, "clone", "-q", ...(depth ? ["--depth", String(depth), "--no-local"] : []), src, ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  return { dir, cleanup: () => cleanupDir(dir) };
}

test("--for HEAD in a clone is the checked-out commit, and origin/<branch> is that branch", () => {
  const { root, hunch, cleanup } = repo();
  let cl: ReturnType<typeof clone> | null = null;
  try {
    memory(hunch, "decisions", "dec_0a");
    code(root, "feat: c1");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_0b");
    code(root, "feat: c2");
    git(root, "switch", "-q", "main");
    cl = clone(root);

    const head = memoryFor(cl.dir, "HEAD");
    assert.equal(head.kind, "commit", "HEAD is not refs/remotes/origin/HEAD, which would be a branch");
    assert.deepEqual(shape(head), [["feat: c1", null, ["dec_0a"]]]);

    const remote = memoryFor(cl.dir, "origin/feat/b");
    assert.equal(remote.kind, "branch");
    assert.equal(remote.branch, "feat/b");
    assert.deepEqual(shape(remote), [["feat: c2", null, ["dec_0b"]]]);
  } finally { cl?.cleanup(); cleanup(); }
});

test("--for in a shallow clone: memory below the boundary is not attributed to it", () => {
  const { root, hunch, cleanup } = repo();
  let cl: ReturnType<typeof clone> | null = null;
  try {
    memory(hunch, "decisions", "dec_01d");
    code(root, "feat: c1");
    memory(hunch, "decisions", "dec_0a");
    code(root, "feat: c2");
    memory(hunch, "decisions", "dec_0b");
    code(root, "feat: c3");
    cl = clone(root, 3); // c3, dec_0b and c2 as the boundary

    const r = memoryFor(cl.dir, "main");
    assert.deepEqual(shape(r), [["feat: c3", null, ["dec_0b"]]], "the boundary commit owns nothing");
    assert.match(r.notes.join("\n"), /shallow clone/);
    const c3 = memoryFor(cl.dir, "HEAD");
    assert.deepEqual(shape(c3), [["feat: c3", null, ["dec_0b"]]]);
  } finally { cl?.cleanup(); cleanup(); }
});

test("--for <default branch>: every side of an octopus merge lands at the merge", () => {
  const { root, hunch, cleanup } = repo();
  try {
    for (const [b, id] of [["feat/x", "dec_0a"], ["feat/y", "dec_0b"]] as const) {
      git(root, "switch", "-q", "-c", b, "main");
      memory(hunch, "decisions", id);
      code(root, `feat: ${b}`);
    }
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "octopus", "feat/x", "feat/y");
    const merge = git(root, "rev-parse", "HEAD");
    assert.equal(git(root, "rev-list", "--parents", "-n1", merge).split(" ").length, 4, "an octopus merge");

    assert.deepEqual(shape(memoryFor(root, "main")), [
      ["feat: feat/x", merge, ["dec_0a"]],
      ["feat: feat/y", merge, ["dec_0b"]],
    ]);
  } finally { cleanup(); }
});

test("--for: main merged into a feature branch is transparent, by branch and by commit", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/b");
    code(root, "feat: c1");
    memory(hunch, "decisions", "dec_0b");
    git(root, "switch", "-q", "main");
    memory(hunch, "decisions", "dec_ffff");
    code(root, "feat: main work");
    git(root, "switch", "-q", "feat/b");
    git(root, "merge", "-q", "--no-ff", "--no-edit", "main");
    const mergeSha = git(root, "rev-parse", "HEAD");
    const c2 = code(root, "feat: c2");

    assert.deepEqual(shape(memoryFor(root, "feat/b")), [["feat: c2", null, ["dec_0b"]]]);
    assert.deepEqual(shape(memoryFor(root, c2)), [["feat: c2", null, ["dec_0b"]]]);
    const m = memoryFor(root, mergeSha);
    assert.deepEqual(m.groups, []);
    assert.match(m.notes.join("\n"), /sync merge/);
  } finally { cleanup(); }
});

test("--for: a merge made on local main and not yet pushed owns its memory, by branch and by HEAD", () => {
  const { root, cleanup } = repo();
  let cl: ReturnType<typeof clone> | null = null;
  try {
    cl = clone(root);
    const hunch = join(cl.dir, ".hunch");
    git(cl.dir, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_0b");
    code(cl.dir, "feat: b1");
    git(cl.dir, "switch", "-q", "main");
    memory(hunch, "decisions", "dec_0c");
    git(cl.dir, "merge", "-q", "--no-ff", "-m", "merge b", "feat/b");
    const merge = git(cl.dir, "rev-parse", "HEAD");

    const want: Array<[string, string | null, string[]]> = [["merge b", null, ["dec_0c"]], ["feat: b1", merge, ["dec_0b"]]];
    assert.deepEqual(shape(memoryFor(cl.dir, "main")), want);
    assert.deepEqual(shape(memoryFor(cl.dir, "HEAD")), want, "origin/main does not have the merge yet; local main does");
  } finally { cl?.cleanup(); cleanup(); }
});

test("--for: a feature merged into a feature lands with it, its memory not lost", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/a");
    memory(hunch, "decisions", "dec_0a");
    code(root, "feat: a1");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_0b");
    code(root, "feat: b1");
    git(root, "switch", "-q", "feat/a");
    git(root, "merge", "-q", "--no-ff", "-m", "merge b into a", "feat/b");
    memory(hunch, "decisions", "dec_0c");
    code(root, "feat: a2");
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "land a", "feat/a");
    const land = git(root, "rev-parse", "HEAD");

    const want: Array<[string, string | null, string[]]> = [
      ["feat: a2", land, ["dec_0c"]],
      ["feat: b1", land, ["dec_0b"]],
      ["feat: a1", land, ["dec_0a"]],
    ];
    assert.deepEqual(shape(memoryFor(root, "main")), want);
    assert.deepEqual(shape(memoryFor(root, "feat/a")), want);
  } finally { cleanup(); }
});

test("--for: with no default branch every merge owns its memory, and the output says so", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "branch", "-q", "-m", "trunk");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_0b");
    code(root, "feat: b1");
    git(root, "switch", "-q", "trunk");
    memory(hunch, "decisions", "dec_0a");
    git(root, "merge", "-q", "--no-ff", "-m", "merge b", "feat/b");
    const merge = git(root, "rev-parse", "HEAD");
    code(root, "feat: t2");

    const want: Array<[string, string | null, string[]]> = [["merge b", null, ["dec_0a"]], ["feat: b1", merge, ["dec_0b"]]];
    const byBranch = memoryFor(root, "trunk");
    assert.deepEqual(shape(byBranch), want, "dec_0a was captured before the merge, not before t2");
    assert.match(byBranch.notes.join("\n"), /no default branch/);
    const byCommit = memoryFor(root, merge);
    assert.deepEqual(shape(byCommit), want);
    assert.match(byCommit.notes.join("\n"), /no default branch/);
  } finally { cleanup(); }
});

test("--for: stacked branches landed in turn count each memory once, at the landing that brought it", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/a");
    memory(hunch, "decisions", "dec_0a1");
    code(root, "feat: a1");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_0b1");
    code(root, "feat: b1");
    git(root, "switch", "-q", "feat/a");
    memory(hunch, "decisions", "dec_0a2");
    code(root, "feat: a2");
    git(root, "switch", "-q", "feat/b");
    git(root, "merge", "-q", "--no-ff", "-m", "sync a into b", "feat/a");
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "land a", "feat/a");
    const landA = git(root, "rev-parse", "HEAD");
    git(root, "merge", "-q", "--no-ff", "-m", "land b", "feat/b");
    const landB = git(root, "rev-parse", "HEAD");

    assert.deepEqual(shape(memoryFor(root, "main")), [
      ["feat: b1", landB, ["dec_0b1"]],
      ["feat: a2", landA, ["dec_0a2"]],
      ["feat: a1", landA, ["dec_0a1"]],
    ]);
    assert.deepEqual(shape(memoryFor(root, "feat/b")), [["feat: b1", landB, ["dec_0b1"]]], "a2 landed with feat/a, not with feat/b");
    assert.deepEqual(shape(memoryFor(root, landB)), [["feat: b1", landB, ["dec_0b1"]]]);
  } finally { cleanup(); }
});

test("--for: an integration branch merged into a feature and back counts its memory once", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "develop");
    memory(hunch, "decisions", "dec_0d1");
    code(root, "feat: d1");
    git(root, "switch", "-q", "-c", "feat/x");
    memory(hunch, "decisions", "dec_0e1");
    code(root, "feat: x1");
    git(root, "switch", "-q", "develop");
    memory(hunch, "decisions", "dec_0d2");
    code(root, "feat: d2");
    git(root, "switch", "-q", "feat/x");
    git(root, "merge", "-q", "--no-ff", "-m", "sync develop", "develop");
    code(root, "feat: x2");
    git(root, "switch", "-q", "develop");
    git(root, "merge", "-q", "--no-ff", "-m", "merge x", "feat/x");
    const mergeX = git(root, "rev-parse", "HEAD");

    assert.deepEqual(shape(memoryFor(root, "develop")), [
      ["feat: x1", mergeX, ["dec_0e1"]],
      ["feat: d2", null, ["dec_0d2"]],
      ["feat: d1", null, ["dec_0d1"]],
    ], "d2 came back through the sync merge but is develop's own");
  } finally { cleanup(); }
});

test("--for <branch>: an unlanded branch's nested feature keeps the merge that brought it in", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/a");
    memory(hunch, "decisions", "dec_0a");
    code(root, "feat: a1");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_0b");
    code(root, "feat: b1");
    git(root, "switch", "-q", "feat/a");
    git(root, "merge", "-q", "--no-ff", "-m", "merge b into a", "feat/b");
    const merge = git(root, "rev-parse", "HEAD");
    memory(hunch, "decisions", "dec_0c");
    code(root, "feat: a2");

    assert.deepEqual(shape(memoryFor(root, "feat/a")), [
      ["feat: a2", null, ["dec_0c"]],
      ["feat: b1", merge, ["dec_0b"]],
      ["feat: a1", null, ["dec_0a"]],
    ]);
  } finally { cleanup(); }
});

// ---- critic round 4: local main in branch reads, criss-cross, the commit line --

test("--for <branch>: a sync merge of unpushed local main does not pull main's memory in", () => {
  const { root, hunch, cleanup } = repo();
  let cl: ReturnType<typeof clone> | null = null;
  try {
    cl = clone(root);
    const h = join(cl.dir, ".hunch");
    git(cl.dir, "switch", "-q", "-c", "feat/x");
    memory(h, "decisions", "dec_1a");
    code(cl.dir, "feat: x1");
    git(cl.dir, "switch", "-q", "main");
    memory(h, "decisions", "dec_1e");
    code(cl.dir, "feat: main work unpushed");
    git(cl.dir, "switch", "-q", "feat/x");
    git(cl.dir, "merge", "-q", "--no-ff", "-m", "sync main", "main");
    memory(h, "decisions", "dec_1b");
    code(cl.dir, "feat: x2");

    assert.deepEqual(shape(memoryFor(cl.dir, "feat/x")), [
      ["feat: x2", null, ["dec_1b"]],
      ["feat: x1", null, ["dec_1a"]],
    ], "the branch read and the commit read agree that the sync merge brought nothing new");
  } finally { cl?.cleanup(); cleanup(); }
});

test("--for <branch>: a branch merged into local main but not pushed lands at the local merge", () => {
  const { root, cleanup } = repo();
  let cl: ReturnType<typeof clone> | null = null;
  try {
    cl = clone(root);
    const h = join(cl.dir, ".hunch");
    git(cl.dir, "switch", "-q", "-c", "feat/x");
    memory(h, "decisions", "dec_1c");
    code(cl.dir, "feat: x1");
    git(cl.dir, "switch", "-q", "main");
    git(cl.dir, "merge", "-q", "--no-ff", "-m", "merge x", "feat/x");
    const merge = git(cl.dir, "rev-parse", "HEAD");

    const r = memoryFor(cl.dir, "feat/x");
    assert.deepEqual(shape(r), [["feat: x1", merge, ["dec_1c"]]]);
    assert.ok(r.notes.some((n) => /not pushed/.test(n)), r.notes.join("\n"));
  } finally { cl?.cleanup(); cleanup(); }
});

test("--for <branch>: a branch whose commits landed through another branch says so", () => {
  const { root, hunch, cleanup } = repo();
  try {
    git(root, "switch", "-q", "-c", "feat/a");
    memory(hunch, "decisions", "dec_2a");
    code(root, "feat: a1");
    git(root, "switch", "-q", "main");
    git(root, "switch", "-q", "-c", "feat/b");
    memory(hunch, "decisions", "dec_2b");
    code(root, "feat: b1");
    git(root, "switch", "-q", "feat/a");
    git(root, "merge", "-q", "--no-ff", "-m", "merge b into a", "feat/b");
    git(root, "switch", "-q", "feat/b");
    git(root, "merge", "-q", "--no-ff", "-m", "merge a into b", "feat/a");
    git(root, "switch", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "land a", "feat/a");
    git(root, "merge", "-q", "--no-ff", "-m", "land b", "feat/b");

    const r = memoryFor(root, "feat/b");
    assert.deepEqual(shape(r), []);
    assert.ok(r.notes.some((n) => /another/.test(n)), r.notes.join("\n"));
  } finally { cleanup(); }
});

test("--for <commit>: main's memory from before the fork is not the branch's first commit's", () => {
  const { root, hunch, cleanup } = repo();
  try {
    code(root, "feat: c0");
    memory(hunch, "decisions", "dec_3a");
    git(root, "switch", "-q", "-c", "feat/x");
    const x1 = code(root, "feat: x1");

    assert.deepEqual(shape(memoryFor(root, x1)), [], "--for feat/x agrees: dec_3a trails on main");
    assert.deepEqual(shape(memoryFor(root, "feat/x")), []);
  } finally { cleanup(); }
});
