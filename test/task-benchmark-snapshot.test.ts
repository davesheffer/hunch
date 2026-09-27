import { cleanupDir } from "./fixtures.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildMemorySnapshot } from "../src/benchmark/memorySnapshot.js";

const CUTOFF = "2026-05-01T00:00:00Z";

let root = "";
let source = "";
let emptyHooks = "";
const commits: Record<string, string> = {};

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${emptyHooks}`, ...args,
  ], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    windowsHide: true,
  }).trim();
}

function put(repo: string, rel: string, content: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

function record(id: string, createdAt: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, created_at: createdAt, ...extra }) + "\n";
}

function commit(repo: string, message: string, date: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

function listRel(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? listRel(join(dir, e.name), rel) : [rel];
  }).sort();
}

const A = "decisions/dec_aaaaaaaaaa.json";
const B = "decisions/dec_bbbbbbbbbb.json";
const C = "decisions/dec_cccccccccc.json";
const D = "decisions/dec_dddddddddd.json";
const F = "findings/fnd_ffffffffff.json";
const G = "decisions/dec_gggggggggg.json";
const H = "findings/fnd_hhhhhhhhhh.json";

before(() => {
  root = mkdtempSync(join(tmpdir(), "hunch-task-bench-snap-"));
  emptyHooks = join(root, "fixture-hooks");
  mkdirSync(emptyHooks);
  source = join(root, "source");
  mkdirSync(source);
  git(source, ["init", "-q", "-b", "main"]);
  put(source, "src/a.ts", "export const a = 1;\n");
  put(source, `.hunch/${A}`, record("dec_aaaaaaaaaa", "2026-03-31T00:00:00Z", { v: 1 }));
  put(source, `.hunch/${F}`, record("fnd_ffffffffff", "2026-03-31T00:00:00Z"));
  put(source, `.hunch/${G}`, record("dec_gggggggggg", "2026-06-01T00:00:00Z"));
  put(source, `.hunch/${H}`, record("fnd_hhhhhhhhhh", "2026-03-31T00:00:00Z"));
  put(source, ".hunch/team.json", JSON.stringify({ url: "https://example.invalid/team" }) + "\n");
  commits.m1 = commit(source, "m1", "2026-04-01 00:00:00 +0000");

  git(source, ["checkout", "-q", "-b", "x"]);
  put(source, `.hunch/${B}`, record("dec_bbbbbbbbbb", "2026-04-09T00:00:00Z", { branch: "x" }));
  commits.x1 = commit(source, "x1", "2026-04-10 00:00:00 +0000");

  git(source, ["checkout", "-q", "-b", "y", commits.m1!]);
  put(source, `.hunch/${C}`, record("dec_cccccccccc", "2026-04-11T00:00:00Z"));
  commits.y1 = commit(source, "y1", "2026-04-12 00:00:00 +0000");

  git(source, ["checkout", "-q", "main"]);
  rmSync(join(source, ".hunch", H));
  put(source, "src/a.ts", "export const a = 2;\n");
  commits.m2 = commit(source, "m2", "2026-04-20 00:00:00 +0000");

  put(source, `.hunch/${A}`, record("dec_aaaaaaaaaa", "2026-03-31T00:00:00Z", { v: 2 }));
  put(source, `.hunch/${D}`, record("dec_dddddddddd", "2026-03-01T00:00:00Z"));
  put(source, `.hunch/${H}`, record("fnd_hhhhhhhhhh", "2026-03-31T00:00:00Z", { readded: true }));
  rmSync(join(source, ".hunch", F));
  commits.m3 = commit(source, "m3", "2026-05-05 00:00:00 +0000");

  git(source, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge x", "x"], "2026-05-10 00:00:00 +0000");
  commits.m4 = git(source, ["rev-parse", "HEAD"]);
});

after(() => {
  if (root) cleanupDir(root);
});

test("buildMemorySnapshot reads each public path from its last pre-cutoff commit reachable from the starting commit", () => {
  const dest = join(root, "snapshots", "one");
  const opts = { sourceRepo: source, sourceRef: "main", startingCommit: commits.m4!, privateRepo: null, cutoffIso: CUTOFF, dest };
  const snap = buildMemorySnapshot(opts);
  const pub = join(dest, "public");

  assert.equal(snap.public.revision, commits.m2, "the main commit is the last first-parent commit at or before the cutoff");
  assert.equal(snap.public.starting_commit, commits.m4);
  assert.equal(snap.private, null);
  assert.deepEqual(listRel(pub), [A, B, F]);
  assert.equal(snap.public.files, 3);

  // a. modified on main after the cutoff: the pre-cutoff content.
  assert.equal(readFileSync(join(pub, A), "utf8"), record("dec_aaaaaaaaaa", "2026-03-31T00:00:00Z", { v: 1 }));
  // b. committed on a branch before the cutoff, merged after it: the branch content.
  assert.equal(readFileSync(join(pub, B), "utf8"), record("dec_bbbbbbbbbb", "2026-04-09T00:00:00Z", { branch: "x" }));
  // e. in the main commit's tree, deleted on main after the cutoff: the pre-cutoff content.
  assert.equal(readFileSync(join(pub, F), "utf8"), record("fnd_ffffffffff", "2026-03-31T00:00:00Z"));
  assert.deepEqual(snap.public.sources, { [A]: commits.m1, [B]: commits.x1, [F]: commits.m1 });

  const reasons = Object.fromEntries(snap.public.dropped.map((d) => [d.path, d.reason]));
  // c. only on an unmerged branch: never a candidate.
  assert.equal(C in reasons, false);
  // d. added on main after the cutoff: unreachable before it.
  assert.equal(reasons[D], "no pre-cutoff commit reachable from the starting commit");
  // deleted by the last pre-cutoff commit that touched it, re-added after the cutoff.
  assert.equal(reasons[H], `deleted at ${commits.m2}`);
  // f. committed before the cutoff but captured after it.
  assert.equal(reasons[G], "capture created_at=2026-06-01T00:00:00Z >= cutoff");
  // g. store pointer.
  assert.equal(reasons["team.json"], "store pointer would point outside the snapshot");
  assert.deepEqual(Object.keys(reasons).sort(), [G, D, "findings/fnd_hhhhhhhhhh.json", "team.json"].sort());

  const recorded = JSON.parse(readFileSync(join(dest, "snapshot.json"), "utf8"));
  assert.deepEqual(recorded, snap);

  // h. a matching frozen snapshot is reused; an edited one is refused.
  assert.deepEqual(buildMemorySnapshot(opts), snap);
  assert.throws(() => buildMemorySnapshot({ ...opts, startingCommit: commits.m3! }), /no longer matches/);
  writeFileSync(join(pub, A), record("dec_aaaaaaaaaa", "2026-03-31T00:00:00Z", { v: 99 }));
  assert.throws(() => buildMemorySnapshot(opts), /no longer matches/);
});

test("buildMemorySnapshot is deterministic across destinations", () => {
  const opts = { sourceRepo: source, sourceRef: "main", startingCommit: commits.m4!, privateRepo: null, cutoffIso: CUTOFF };
  const first = buildMemorySnapshot({ ...opts, dest: join(root, "snapshots", "det-1") });
  const second = buildMemorySnapshot({ ...opts, dest: join(root, "snapshots", "det-2") });
  assert.deepEqual(second, first);
  assert.throws(() => buildMemorySnapshot({ ...opts, startingCommit: "no-such-ref", dest: join(root, "snapshots", "bad") }), /rev-parse/);
});
