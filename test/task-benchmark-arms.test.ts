import { test } from "node:test";
import assert from "node:assert/strict";
import {
  armConfinement, excludedSkillNames, excludedSkillsCheck, excludedSkillsLoaded, isOutOfRepoAccess, parseArms, parseExcludedPaths,
  type ConfinementRoots,
} from "../src/benchmark/orchestrate.js";

test("parseExcludedPaths accepts repo-relative POSIX paths and refuses absolute, traversal, empty and .hunch paths", () => {
  assert.deepEqual(parseExcludedPaths([]), []);
  assert.deepEqual(parseExcludedPaths([".claude/skills/fable-mode/", "docs", "docs"]), [".claude/skills/fable-mode", "docs"]);
  for (const bad of ["../x", "a/../b", "/abs", "", "./x", "a//b", "C:/x", "a\\b", "*.md", ".hunch", ".hunch/x", "docs/caf\u00e9", "a\tb", "\u05e9"]) {
    assert.throws(() => parseExcludedPaths([bad]), /--exclude-path/, JSON.stringify(bad));
  }
});

test("excludedSkillsLoaded flags a loaded skill named by an excluded .claude/skills or .agents/skills <name> path only", () => {
  const excluded = [".claude/skills/fable-mode", "docs/fable-mode"];
  assert.deepEqual(excludedSkillsLoaded(["review", "fable-mode"], excluded), ["fable-mode"]);
  assert.deepEqual(excludedSkillsLoaded(["review"], excluded), []);
  assert.deepEqual(excludedSkillsLoaded(null, excluded), []);
  assert.deepEqual(excludedSkillsLoaded(["fable-mode"], ["docs/fable-mode", ".claude/skills"]), [], "only a direct skill dir names a skill");
  assert.deepEqual(excludedSkillsLoaded(["x", "y"], [".agents/skills/x"]), ["x"], ".agents/skills is a skill root too");
  assert.deepEqual(excludedSkillNames([".agents/skills/x", ".claude/skills/x", ".claude/skills/y/SKILL.md", "docs"]), ["x"]);
});

test("excludedSkillsCheck: none without a skill exclusion; fails on a loaded excluded skill or a missing skills list", () => {
  assert.equal(excludedSkillsCheck(null, []), null);
  assert.equal(excludedSkillsCheck(null, ["docs", ".claude/commands"]), null);
  assert.deepEqual(excludedSkillsCheck(["review"], [".agents/skills/x"]), { ok: true, detail: "no excluded skill loaded (1 skill(s))" });
  assert.deepEqual(excludedSkillsCheck(["x"], [".agents/skills/x"]), { ok: false, detail: "excluded skill(s) loaded: x" });
  assert.deepEqual(excludedSkillsCheck(null, [".claude/skills/x"]), { ok: false, detail: "no excluded skill loaded (init has no skills list)" });
  // A skill root or a prefix of one names no skill, but still needs the init skills list.
  for (const root of [".claude", ".claude/skills", ".agents", ".agents/skills"]) {
    assert.equal(excludedSkillsCheck(null, [root])?.ok, false, root);
    assert.equal(excludedSkillsCheck([], [root])?.ok, true, root);
  }
});

test("parseArms accepts two or three distinct arms and refuses duplicates, unknown arms and other counts", () => {
  assert.deepEqual(parseArms(["no-hunch", "current-hunch"]), ["no-hunch", "current-hunch"]);
  assert.deepEqual(parseArms(["current-hunch", "no-hunch"]), ["current-hunch", "no-hunch"], "two-arm order is kept");
  assert.deepEqual(parseArms(["no-hunch", "diet-hunch"], "/d"), ["no-hunch", "diet-hunch"]);
  assert.deepEqual(parseArms(["current-hunch", "diet-hunch"], "/d"), ["current-hunch", "diet-hunch"]);
  assert.deepEqual(parseArms(["no-hunch", "current-hunch", "diet-hunch"], "/d"), ["no-hunch", "current-hunch", "diet-hunch"]);
  assert.deepEqual(parseArms(["diet-hunch", "no-hunch", "current-hunch"], "/d"), ["diet-hunch", "no-hunch", "current-hunch"]);
  const refused = /two or three distinct arms from no-hunch, current-hunch, diet-hunch/;
  for (const arms of [
    [], ["no-hunch"], ["no-hunch", "no-hunch"], ["no-hunch", "current-hunch", "current-hunch"],
    ["no-hunch", "current-hunch", "diet-hunch", "no-hunch"], ["no-hunch", "optimized-hunch"], ["no-hunch", "current-hunch", "other"],
  ]) {
    assert.throws(() => parseArms(arms, "/d"), refused, JSON.stringify(arms));
  }
});

test("parseArms requires --diet-root iff diet-hunch is an arm (report-only aside) and refuses it otherwise", () => {
  assert.throws(() => parseArms(["no-hunch", "diet-hunch"]), /diet-hunch, which needs --diet-root/);
  assert.throws(() => parseArms(["no-hunch", "current-hunch", "diet-hunch"], null), /needs --diet-root/);
  assert.throws(() => parseArms(["no-hunch", "current-hunch", "diet-hunch"], ""), /needs --diet-root/);
  assert.throws(() => parseArms(["no-hunch", "current-hunch"], "/d"), /--diet-root is only accepted when --arms includes diet-hunch/);
  assert.throws(() => parseArms(["no-hunch", "current-hunch"], "/d", true), /only accepted/, "refused in report-only too");
  assert.deepEqual(parseArms(["no-hunch", "current-hunch", "diet-hunch"], null, true), ["no-hunch", "current-hunch", "diet-hunch"],
    "--report-only never touches a checkout, like --audited");
});

const roots: ConfinementRoots = {
  sourceRepo: "C:\\src\\hunch", privateRepo: "C:\\src\\hunch-private", auditedRoot: "C:\\bench\\hunch-audited",
  dietRoot: "C:\\bench\\hunch-diet", controller: "C:\\bench\\controller", out: "C:\\out",
};
const auditedCli = "C:/bench/hunch-audited/dist/cli/index.js";
const dietCli = "C:/bench/hunch-diet/dist/cli/index.js";
const runDir = "C:\\out\\runs\\task-1\\1-arm";
const breach = (arm: "no-hunch" | "current-hunch" | "diet-hunch", value: string, given: ConfinementRoots = roots) => {
  const { denyRoots, commands } = armConfinement(arm, given);
  return isOutOfRepoAccess(value, denyRoots, [runDir], commands, "C:/Users/x");
};

test("armConfinement denies both Hunch checkouts to every arm and allows each Hunch arm only its own CLI", () => {
  for (const arm of ["no-hunch", "current-hunch", "diet-hunch"] as const) {
    const { denyRoots } = armConfinement(arm, roots);
    assert.ok(denyRoots.includes(roots.auditedRoot) && denyRoots.includes(roots.dietRoot!), `${arm} is denied both checkouts`);
  }
  assert.deepEqual(armConfinement("no-hunch", roots).commands, []);
  assert.equal(armConfinement("current-hunch", roots).commands.length, 1);
  assert.equal(armConfinement("diet-hunch", roots).commands.length, 1);
  // Two arms (no diet root): exactly the deny roots and allowance of before the diet arm existed.
  const twoArm = { ...roots, dietRoot: null };
  assert.deepEqual(armConfinement("current-hunch", twoArm).denyRoots, [roots.sourceRepo, roots.privateRepo, roots.auditedRoot, roots.controller, roots.out]);

  const verify = (cli: string) => `& 'C:\\Program Files\\nodejs\\node.exe' '${cli}' task verify htask_1 -- npm test`;
  assert.equal(breach("current-hunch", verify(auditedCli)), false, "current-hunch invokes its own CLI");
  assert.equal(breach("diet-hunch", verify(dietCli)), false, "diet-hunch invokes its own CLI");
  assert.equal(breach("current-hunch", verify(dietCli)), true, "current-hunch invoking the diet CLI is denied");
  assert.equal(breach("diet-hunch", verify(auditedCli)), true, "diet-hunch invoking the audited CLI is denied");
  assert.equal(breach("no-hunch", verify(auditedCli)), true, "no-hunch invokes neither");
  assert.equal(breach("no-hunch", verify(dietCli)), true, "no-hunch invokes neither");
  const viaVariable = (cli: string) => `H='${cli}'; node "$H" task verify htask_1 -- npm test`;
  assert.equal(breach("diet-hunch", viaVariable(dietCli)), false, "own CLI through a shell variable");
  assert.equal(breach("current-hunch", viaVariable(dietCli)), true, "the other arm's CLI through a shell variable is denied");
  assert.equal(breach("diet-hunch", viaVariable(auditedCli)), true, "the other arm's CLI through a shell variable is denied");
  assert.equal(breach("diet-hunch", "cat C:/bench/hunch-diet/dist/core/x.js"), true, "other diet files stay denied");
  assert.equal(breach("current-hunch", "cat C:/bench/hunch-diet/package.json"), true, "the diet root is a deny root for current-hunch");
  assert.equal(breach("current-hunch", "cat C:/bench/hunch-diet/package.json", { ...roots, dietRoot: null }), false,
    "without a diet arm the diet path is not a deny root");
});
