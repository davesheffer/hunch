import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshShellBaseline, shellWrittenFiles } from "../src/core/shellwrites.js";

function repo(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-shellwrites-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}
/** A write the fingerprint can see even inside one clock tick. */
function write(path: string, text: string, secondsAhead: number): void {
  writeFileSync(path, text);
  const at = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, at, at);
}
const session = () => `shellwrites-${process.pid}-${Math.random().toString(36).slice(2)}`;

test("without a baseline nothing is attributed; the first observation becomes the baseline", t => {
  const root = repo(t);
  const s = session();
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1);
  assert.deepEqual(shellWrittenFiles(root, s), [], "an earlier edit is not this command's write");
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/b.ts"]);
});

test("a command's writes are the dirty files whose fingerprint moved: new, modified again, untracked", t => {
  const root = repo(t);
  const s = session();
  write(join(root, "src", "a.ts"), "export const a = 2;\n", 1); // dirty before the prompt
  refreshShellBaseline(root, s);
  assert.deepEqual(shellWrittenFiles(root, s), [], "a read-only command wrote nothing");
  write(join(root, "src", "a.ts"), "export const a = 3;\n", 2); // already-dirty file written again
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 2);
  write(join(root, "src", "new.ts"), "export const n = 1;\n", 2);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/a.ts", "src/b.ts", "src/new.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), [], "the baseline moved forward");
});

test("Hunch's own state, deletions and reverts are not writes to ground", t => {
  const root = repo(t);
  const s = session();
  write(join(root, "src", "b.ts"), "export const b = 2;\n", 1);
  refreshShellBaseline(root, s);
  mkdirSync(join(root, ".hunch", "tasks"), { recursive: true });
  write(join(root, ".hunch", "tasks", "t.json"), "{}", 2);
  rmSync(join(root, "src", "a.ts"));
  execFileSync("git", ["-C", root, "checkout", "-q", "--", "src/b.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), []);
});

test("a renamed file is reported at its new path", t => {
  const root = repo(t);
  const s = session();
  refreshShellBaseline(root, s);
  execFileSync("git", ["-C", root, "mv", "src/a.ts", "src/renamed.ts"]);
  assert.deepEqual(shellWrittenFiles(root, s), ["src/renamed.ts"]);
});

test("outside a git repository or without a session, nothing is reported and nothing throws", t => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-shellwrites-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  refreshShellBaseline(dir, "s");
  assert.deepEqual(shellWrittenFiles(dir, "s"), []);
  const root = repo(t);
  assert.deepEqual(shellWrittenFiles(root, undefined), []);
  renameSync(join(root, "src"), join(root, "gone"));
  assert.doesNotThrow(() => shellWrittenFiles(root, "s"));
});
