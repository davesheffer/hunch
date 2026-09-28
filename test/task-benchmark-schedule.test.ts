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

test("armOrder reverses the given order on an odd last hex digit", () => {
  const task = taskWithBit(1);
  assert.deepEqual(armOrder(SEED, task, 1, ARMS), ["current-hunch", "no-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 2, ARMS), ["no-hunch", "current-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 3, ARMS), ["current-hunch", "no-hunch"]);
  assert.deepEqual(armOrder(SEED, task, 4, ARMS), ["no-hunch", "current-hunch"]);
  assert.throws(() => armOrder(SEED, task, 0, ARMS));
});

const THREE: BenchmarkArm[] = ["no-hunch", "current-hunch", "diet-hunch"];
/** The 6 index-orderings `armOrder`'s "rotate-3" rule picks from, mirroring its own lexicographic list. */
const PERM_INDEX_ORDERS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];
/** Independently-computed base permutation for a seed+task, mirroring `armOrder`'s digest draw. */
const basePermutation = (seed: string, task: string): BenchmarkArm[] => {
  const digest = createHash("sha256").update(`${seed}|${task}|1`).digest("hex");
  const index = Number.parseInt(digest.slice(0, 8), 16) % PERM_INDEX_ORDERS.length;
  return PERM_INDEX_ORDERS[index]!.map((i) => THREE[i]!);
};
const rotateLeft = <T,>(arr: readonly T[], shift: number): T[] => {
  const s = shift % arr.length;
  return [...arr.slice(s), ...arr.slice(0, s)];
};

test("armOrder rotates a seeded base permutation for three arms so each position sees every arm once per 3 reps", () => {
  for (const task of ["t0", "t1", "t2", "t3", "continuation-375", "self-contained-394"]) {
    const base = basePermutation(SEED, task);
    for (const rep of [1, 2, 3, 4, 5]) {
      const order = armOrder(SEED, task, rep, THREE);
      assert.deepEqual(order, armOrder(SEED, task, rep, THREE), `${task} rep ${rep} is deterministic`);
      assert.deepEqual(order, rotateLeft(base, (rep - 1) % 3), `${task} rep ${rep} matches the rotated base permutation`);
    }
    for (let position = 0; position < 3; position++) {
      const seen = new Set([1, 2, 3].map((rep) => armOrder(SEED, task, rep, THREE)[position]));
      assert.equal(seen.size, 3, `${task} position ${position} sees all three arms across reps 1-3`);
    }
  }
  assert.deepEqual(THREE, ["no-hunch", "current-hunch", "diet-hunch"], "input is not mutated");
});

test("armOrder's three-arm base permutation differs across tasks for a fixed seed", () => {
  const bases = new Set(["t0", "t1", "t2", "t3", "t4", "t5"].map((task) => JSON.stringify(basePermutation(SEED, task))));
  assert.ok(bases.size >= 2, "at least two distinct base permutations across tasks");
});

test("armOrder covers each position exactly twice across 6 repetitions of three arms", () => {
  for (const task of ["t0", "t1", "t2"]) {
    for (let position = 0; position < 3; position++) {
      const counts = new Map<BenchmarkArm, number>();
      for (let rep = 1; rep <= 6; rep++) {
        const arm = armOrder(SEED, task, rep, THREE)[position]!;
        counts.set(arm, (counts.get(arm) ?? 0) + 1);
      }
      for (const arm of THREE) assert.equal(counts.get(arm), 2, `${task} position ${position} arm ${arm} runs twice in 6 reps`);
    }
  }
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
  assert.equal(needsTieBreak([run("diet-hunch", 1, true), run("diet-hunch", 2, false)], ARMS), false);
  assert.equal(needsTieBreak([run("diet-hunch", 1, true), run("diet-hunch", 2, false)], [...ARMS, "diet-hunch"]), true, "a third arm counts");
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
