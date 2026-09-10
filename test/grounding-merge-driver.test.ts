import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveGroundingConflicts } from "../src/core/groundingMerge.js";
import { installMergeDriver } from "../src/integrations/mergeDriver.js";

const COUNTS_LINE = (n: number) =>
  `This repo has **Hunch** — a curated graph. It currently holds **${n} decisions, 2 bugs, 28 constraints, 21 components, 3 policies**.`;

/** Real `git merge-file --diff3` output for three whole-file contents, so
 *  fixtures match exactly what git actually emits (marker spelling, label
 *  placement) rather than a hand-guessed approximation. */
function diff3(base: string, ours: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-diff3-fixture-"));
  try {
    const write = (name: string, text: string) => {
      const p = join(dir, name);
      execFileSync("sh", ["-c", `cat > ${JSON.stringify(p)}`], { input: text });
      return p;
    };
    const o = write("ours.txt", ours);
    const b = write("base.txt", base);
    const t = write("theirs.txt", theirs);
    try {
      return execFileSync("git", ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", o, b, t], { encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string | Buffer };
      return typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString() ?? "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveGroundingConflicts: a clean 3-way merge (no conflict markers) passes through untouched", () => {
  const text = diff3("a\nb\nc\n", "a\nb2\nc\n", "a\nb\nc\n"); // only ours changed
  assert.doesNotMatch(text, /<<<<<<</);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, text);
});

test("resolveGroundingConflicts: a hard conflict confined to the counts sentence resolves to ours, silently", () => {
  const base = `intro\n${COUNTS_LINE(240)}\noutro\n`;
  const ours = `intro\n${COUNTS_LINE(241)}\noutro\n`;
  const theirs = `intro\n${COUNTS_LINE(243)}\noutro\n`;
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours/, "sanity: git actually conflicted here");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, false);
  assert.equal(res.text, `intro\n${COUNTS_LINE(241)}\noutro\n`);
});

test("resolveGroundingConflicts: a conflict outside the counts sentence is left as a real conflict", () => {
  const base = "intro\nOLD PROSE\noutro\n";
  const ours = "intro\nOURS PROSE\noutro\n";
  const theirs = "intro\nTHEIRS PROSE\noutro\n";
  const text = diff3(base, ours, theirs);
  assert.match(text, /<<<<<<< ours/);
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.equal(res.text, text, "must not rewrite a conflict it can't safely resolve");
});

test("resolveGroundingConflicts: a counts-only hunk alongside a real prose conflict in the same file stays a conflict", () => {
  const base = `${COUNTS_LINE(240)}\nunchanged\nunchanged\nunchanged\nOLD PROSE\n`;
  const ours = `${COUNTS_LINE(241)}\nunchanged\nunchanged\nunchanged\nOURS PROSE\n`;
  const theirs = `${COUNTS_LINE(243)}\nunchanged\nunchanged\nunchanged\nTHEIRS PROSE\n`;
  const text = diff3(base, ours, theirs);
  const hunks = text.match(/<<<<<<< ours/g);
  assert.equal(hunks?.length, 2, "sanity: two independent hunks");
  const res = resolveGroundingConflicts(text);
  assert.equal(res.conflict, true);
  assert.equal(res.text, text, "must not partially resolve — the whole file stays a real conflict");
});

test("installMergeDriver: routes the five generated grounding docs through merge=hunch-grounding, alongside the existing .hunch/ JSON driver", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-mergedriver-grounding-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    installMergeDriver(root, "hunch");
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    for (const f of ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]) {
      assert.match(attrs, new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} merge=hunch-grounding$`, "m"));
    }
    assert.match(attrs, /^\.hunch\/\*\*\/\*\.json merge=hunch$/m, "existing JSON driver routing is untouched");
    const cfg = (key: string) => execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8" }).trim();
    assert.match(cfg("merge.hunch-grounding.driver"), /merge-driver-grounding/);
    assert.match(cfg("merge.hunch.driver"), /merge-driver/); // still registered, unaffected
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
