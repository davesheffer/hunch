import { test } from "node:test";
import assert from "node:assert/strict";
import { armConfinement, isOutOfRepoAccess, parseArms, type ConfinementRoots } from "../src/benchmark/orchestrate.js";

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
