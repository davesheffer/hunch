import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { armOrder, canonicalJson, manifestSha256, needsTieBreak } from "../src/benchmark/schedule.js";
import type { BenchmarkArm, EfficiencyRun } from "../src/benchmark/types.js";

const SEED = "pilot5-gate-a-v1";
const ARMS: BenchmarkArm[] = ["no-hunch", "current-hunch"];
const lowBit = (seed: string, task: string) =>
  Number.parseInt(createHash("sha256").update(`${seed}|${task}|1`).digest("hex").at(-1)!, 16) & 1;
/** First task id `t<n>` whose rep-1 digest ends in a hex digit with the wanted low bit. */
const taskWithBit = (bit: number) => {
  for (let n = 0; ; n++) if (lowBit(SEED, `t${n}`) === bit) return `t${n}`;
};

test("armOrder keeps the given order on an even last hex digit and alternates by repetition", () => {
  const task = taskWithBit(0);
  assert.deepEqual(armOrder(SEED, task, 1, ARMS), ["no-hunch", "current-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 2, ARMS), ["current-hunch", "no-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 3, ARMS), ["no-hunch", "current-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 4, ARMS), ["current-hunch", "no-hunch"]);
  assert.deepEqual(ARMS, ["no-hunch", "current-hunch"], "input is not mutated");
});

test("armOrder reverses the given order on an odd last hex digit, including three arms", () => {
  const task = taskWithBit(1);
  assert.deepEqual(armOrder(SEED, task, 1, ARMS), ["current-hunch", "no-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 2, ARMS), ["no-hunch", "current-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 3, ARMS), ["current-hunch", "no-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 4, ARMS), ["no-hunch", "current-hunch"]);
  const three: BenchmarkArm[] = ["no-hunch", "current-hunch", "optimized-hunch"];
  assert.deepEqual(armOrder(SEED, task, 1, three), ["optimized-hunch", "current-hunch", "no-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 2, three), three);
  assert.deepEqual(armOrder(SEED, taskWithBit(0), 1, three), three);
  assert.throws(() => armOrder(SEED, task, 0, ARMS));
});

const run = (arm: BenchmarkArm, run_index: number, success: boolean, status: EfficiencyRun["status"] = "completed") =>
  ({ task_id: "t", arm, run_index, success, status }) as EfficiencyRun;

test("needsTieBreak fires only when one arm's two valid runs disagree", () => {
  assert.equal(needsTieBreak([], ARMS), false);
  assert.equal(needsTieBreak([run("no-hunch", 1, true), run("no-hunch", 2, true), run("current-hunch", 1, false), run("current-hunch", 2, false)], ARMS), false);
  assert.equal(needsTieBreak([run("no-hunch", 1, true), run("no-hunch", 2, false), run("current-hunch", 1, true), run("current-hunch", 2, true)], ARMS), true);
  // timed_out and agent_error are valid runs; their failure disagrees with a success.
  assert.equal(needsTieBreak([run("current-hunch", 1, true), run("current-hunch", 2, false, "timed_out")], ARMS), true);
  assert.equal(needsTieBreak([run("current-hunch", 1, false, "agent_error"), run("current-hunch", 2, true)], ARMS), true);
  // invalid_exposure / isolation_breach runs are ignored, leaving fewer than two valid runs.
  assert.equal(needsTieBreak([run("no-hunch", 1, true), run("no-hunch", 2, false, "invalid_exposure")], ARMS), false);
  assert.equal(needsTieBreak([run("no-hunch", 1, false, "isolation_breach"), run("no-hunch", 2, true)], ARMS), false);
  // run_index 3 (the tie-break itself) never counts.
  assert.equal(needsTieBreak([run("no-hunch", 1, true), run("no-hunch", 3, false)], ARMS), false);
  assert.equal(needsTieBreak([run("no-hunch", 1, true), run("no-hunch", 2, true), run("no-hunch", 3, false)], ARMS), false);
  // Arms outside the requested list are not considered.
  assert.equal(needsTieBreak([run("optimized-hunch", 1, true), run("optimized-hunch", 2, false)], ARMS), false);
});

test("canonicalJson sorts keys recursively, keeps array order and omits undefined members", () => {
  const a = { b: 1, a: { d: [3, { z: 1, y: 2 }, [2, 1]], c: "x" }, u: undefined, n: null, t: true };
  const b = { t: true, n: null, a: { c: "x", d: [3, { y: 2, z: 1 }, [2, 1]] }, b: 1 };
  const expected = '{"a":{"c":"x","d":[3,{"y":2,"z":1},[2,1]]},"b":1,"n":null,"t":true}';
  assert.equal(canonicalJson(a), expected);
  assert.equal(canonicalJson(b), expected);
  assert.equal(canonicalJson([undefined, "s\"q"]), '[null,"s\\"q"]');
  assert.throws(() => canonicalJson({ x: Number.NaN }));
  assert.throws(() => canonicalJson([Number.POSITIVE_INFINITY]));
});

test("manifestSha256 hashes the canonical form and is key-order independent", () => {
  const manifest = { schema: "hunch.context-efficiency-manifest/1", seed: SEED, arms: ARMS, tasks: { t1: { starting_commit: "abc" } } };
  const reordered = { tasks: { t1: { starting_commit: "abc" } }, arms: ARMS, seed: SEED, schema: "hunch.context-efficiency-manifest/1" };
  const expected = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(manifestSha256(manifest), expected);
  assert.equal(manifestSha256(reordered), expected);
  assert.notEqual(manifestSha256({ ...manifest, seed: "other" }), expected);
  assert.notEqual(manifestSha256({ ...manifest, arms: [...ARMS].reverse() }), expected);
});
