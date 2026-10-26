import { cleanupDir } from "./fixtures.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outwardLinks, unlinkHint } from "../src/core/worktreeHazards.js";

const cleanup: string[] = [];
after(() => { for (const dir of cleanup) cleanupDir(dir); });
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

test("outwardLinks lists top-level links that resolve outside the worktree, and nothing else", () => {
  const wt = tmp("hunch-wth-wt-");
  const outside = tmp("hunch-wth-out-");
  mkdirSync(join(wt, "src"));
  writeFileSync(join(wt, "README.md"), "x");
  // A junction on Windows (no privilege needed), a directory symlink elsewhere.
  symlinkSync(outside, join(wt, "node_modules"), "junction");
  symlinkSync(join(wt, "src"), join(wt, "src-link"), "junction");
  const links = outwardLinks(wt);
  assert.deepEqual(links.map((l) => l.name), ["node_modules"], "the inward link and plain entries are not hazards");
  assert.ok(links[0]!.target.toLowerCase().includes("hunch-wth-out-"), links[0]!.target);
});

test("outwardLinks reads a missing worktree as no links, and a dangling link as a hazard", () => {
  assert.deepEqual(outwardLinks(join(tmpdir(), "hunch-wth-gone-does-not-exist")), []);
  const wt = tmp("hunch-wth-dangle-");
  const outside = tmp("hunch-wth-dangle-out-");
  symlinkSync(outside, join(wt, "deps"), "junction");
  cleanupDir(outside);
  assert.deepEqual(outwardLinks(wt).map((l) => l.name), ["deps"], "a link whose target is gone still must be unlinked first");
});

test("an inward link to an entry whose name starts with .. is not a hazard", () => {
  const wt = tmp("hunch-wth-dots-");
  mkdirSync(join(wt, "..cache"));
  symlinkSync(join(wt, "..cache"), join(wt, "cache-link"), "junction");
  assert.deepEqual(outwardLinks(wt), []);
});

test("unlinkHint removes the link, never the target", () => {
  const hint = unlinkHint("C:\\wt\\node_modules");
  if (process.platform === "win32") assert.equal(hint, 'cmd /c rmdir "C:\\wt\\node_modules"');
  else assert.equal(hint, 'rm "C:\\wt\\node_modules"');
  assert.doesNotMatch(hint, /\/s|-r/, "never a recursive delete");
});
