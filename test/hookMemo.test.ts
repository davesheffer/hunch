import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginHookInvocation, endHookInvocation, headAndBlob, hookActive } from "../src/core/hookMemo.js";
import { cochangeFor } from "../src/core/cochange.js";
import { siblingLessonsFor } from "../src/core/siblingfix.js";
import { noteEditedFiles, refreshShellBaseline, shellWrittenFiles } from "../src/core/shellwrites.js";
import { gitTouchedFiles, headUnmovedSince } from "../src/core/taskTouched.js";

function repo(t: { after: (f: () => void) => void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-hookmemo-")));
  t.after(() => cleanupDir(root));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  git("config", "user.email", "t@t");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

test("an Edit hook looks HEAD up once for co-change and sibling-fix, and the memo resets per invocation", (t) => {
  const root = repo(t);
  let misses = 0;
  const sibling = () => siblingLessonsFor(root, "src/a.ts", [], { cacheOnly: true, onMiss: () => { misses++; } });
  beginHookInvocation(); t.after(endHookInvocation);
  cochangeFor(root, "src/a.ts", { cache: false });
  // Take git away: a second HEAD lookup could not succeed, and a cacheOnly miss
  // is only reached once HEAD and the blob are known.
  renameSync(join(root, ".git"), join(root, ".git-off"));
  sibling();
  assert.equal(misses, 1, "the sibling-fix read used the HEAD the co-change lookup already took");
  beginHookInvocation(); t.after(endHookInvocation);
  sibling();
  assert.equal(misses, 1, "a new invocation asks git again (and finds none)");
});

test("headAndBlob is memoized per root and file inside an invocation, and not at all outside one", (t) => {
  const root = repo(t);
  beginHookInvocation(); t.after(endHookInvocation);
  assert.ok(hookActive());
  const first = headAndBlob(root, "src/a.ts", process.env, 5_000);
  assert.match(first.head ?? "", /^[0-9a-f]{40,64}$/);
  assert.match(first.blob ?? "", /^[0-9a-f]{40,64}$/);
  assert.equal(headAndBlob(root, "src/a.ts", process.env, 5_000), first, "same object back: no second lookup");
  const missing = headAndBlob(root, "src/new.ts", process.env, 5_000);
  assert.equal(missing.head, first.head, "an untracked file still yields HEAD");
  assert.equal(missing.blob, null);
});

test("headUnmovedSince reads the HEAD reflog; gitTouchedFiles still sees a commit made in the window", (t) => {
  const root = repo(t);
  const future = Date.now() + 3_600_000;
  assert.equal(headUnmovedSince(root, future), true, "no HEAD movement after a later start");
  assert.equal(headUnmovedSince(root, Date.now() - 3_600_000), false, "HEAD moved after an earlier start");
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("add", "-A");
  git("commit", "-q", "-m", "work");
  assert.ok(gitTouchedFiles(root, startedAt, null, { workingTree: false }).includes("src/b.ts"));
  const later = new Date(Date.now() + 3_600_000).toISOString();
  assert.deepEqual(gitTouchedFiles(root, later, new Date(Date.now() + 7_200_000).toISOString(), { workingTree: false }), []);
  utimesSync(join(root, "src", "b.ts"), new Date(), new Date());
});

test("noteEditedFiles moves only the edited entries; shell writes after it are still detected", (t) => {
  const root = repo(t);
  const s = `hookmemo-${process.pid}-${Math.random().toString(36).slice(2)}`;
  refreshShellBaseline(root, s);
  const at = new Date(Date.now() + 1000);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
  utimesSync(join(root, "src", "a.ts"), at, at);
  noteEditedFiles(root, s, undefined, ["src/a.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), [], "the edit tool's own write is not the shell's");
  const later = new Date(Date.now() + 2000);
  writeFileSync(join(root, "src", "a.ts"), "export const a = 3;\n");
  utimesSync(join(root, "src", "a.ts"), later, later);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/a.ts"]);
});

test("runHookCommand opens a memo scope itself, so the hook-only bundle and the daemon memoize too", async () => {
  const { runHookCommand } = await import("../src/cli/hookCommand.js");
  endHookInvocation();
  assert.equal(hookActive(), false);
  // Unrecognized input returns before any grounding; the scope is already open.
  await runHookCommand({ provider: "claude" }, async () => "{}");
  assert.equal(hookActive(), true);
  endHookInvocation();
});
