// Pure schedule and manifest helpers for `hunch task benchmark`: seeded arm order, the paired
// tie-break rule, and the canonical JSON the manifest hash is taken over.
// Design: bench/pilot5/GATE-A-HARNESS.md ("Schedule").
import { createHash } from "node:crypto";
import type { BenchmarkArm, EfficiencyRun } from "./types.js";

/** Statuses whose `success` counts toward the tie-break; invalid and breached runs never do. */
const TIE_BREAK_STATUSES: ReadonlySet<EfficiencyRun["status"]> = new Set(["completed", "timed_out", "agent_error"]);

/**
 * The 6 orderings of 3 index positions, in lexicographic order; `basePermutation`'s digest-derived
 * index selects one of these to seed the "rotate-3" three-arm rule.
 */
const PERMUTATIONS_OF_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/** Deterministic base permutation of exactly 3 arms, drawn once per seed+task from the digest. */
function basePermutation(digest: string, arms: readonly BenchmarkArm[]): BenchmarkArm[] {
  const index = Number.parseInt(digest.slice(0, 8), 16) % PERMUTATIONS_OF_3.length;
  return PERMUTATIONS_OF_3[index]!.map((i) => arms[i]!);
}

/**
 * Arm order for one repetition, keyed by sha256(`seed|task|1`).
 *
 * Two arms: the digest's last hex digit `& 1` keeps (0) or reverses (1) the order at rep 1; later
 * reps alternate (even reps reversed, odd reps as rep 1).
 *
 * Three arms ("rotate-3" rule): the digest picks one of the 6 base permutations of the arms, once
 * per seed+task. Repetition r, 0-based (`rep - 1`), runs that base permutation rotated left by
 * `r % 3`, so every 3 consecutive repetitions of a task run each arm in each position exactly once.
 */
export function armOrder(seed: string, taskId: string, rep: number, arms: readonly BenchmarkArm[]): BenchmarkArm[] {
  if (!Number.isInteger(rep) || rep < 1) throw new Error(`armOrder: rep must be an integer >= 1, got ${rep}`);
  const digest = createHash("sha256").update(`${seed}|${taskId}|1`).digest("hex");
  if (arms.length === 3) {
    const base = basePermutation(digest, arms);
    const shift = (rep - 1) % 3;
    return [...base.slice(shift), ...base.slice(0, shift)];
  }
  const first = (Number.parseInt(digest.at(-1) ?? "0", 16) & 1) === 0 ? [...arms] : [...arms].reverse();
  return rep % 2 === 0 ? first.reverse() : first;
}

/**
 * True when some arm has exactly two valid runs (completed, timed_out or agent_error) among
 * run_index 1..reps of one task and they disagree on `success`.
 */
export function needsTieBreak(runs: readonly EfficiencyRun[], arms: readonly BenchmarkArm[], reps = 2): boolean {
  return arms.some((arm) => {
    const valid = runs.filter((run) => run.arm === arm && run.run_index >= 1 && run.run_index <= reps && TIE_BREAK_STATUSES.has(run.status));
    return valid.length === 2 && valid[0]!.success !== valid[1]!.success;
  });
}

/**
 * Stable JSON: object keys sorted recursively, arrays kept in order, `undefined` object members
 * omitted, no whitespace. Throws on non-finite numbers and on values JSON cannot represent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} value`);
  }
}

/** sha256 hex over the canonical JSON of the manifest's hashed part. */
export function manifestSha256(manifest: unknown): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
