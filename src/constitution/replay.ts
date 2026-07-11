import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { revExists } from "../extractors/git.js";
import { canonicalHash, proofEvaluationHash, proofPlanContentHash } from "./canonical.js";
import { assertCompositionBinding, policyProofHash } from "./composition.js";
import { evaluateCompositePolicyOnSnapshot, evaluatePolicyOnSnapshot, type GraphSnapshot } from "./evaluator.js";
import { loadReplaySnapshot, putReplaySnapshot } from "./replayCache.js";
import {
  POLICY_EVALUATOR,
  ProofPlanSchema,
  ReplayReceiptSchema,
  type PolicyEvaluation,
  type PolicyEvaluationResult,
  type PolicySpec,
  type ProofPlan,
  type ReplayReceipt,
} from "./schema.js";

export type ReplayLeg = ReplayReceipt["leg"];

export interface ProofReplayResult {
  current: ReplayReceipt;
  known_bad: ReplayReceipt[];
  known_good: ReplayReceipt[];
  accepted_history: ReplayReceipt[];
  replay_receipts: ReplayReceipt[];
  selected_history_commits: string[];
  history_complete: boolean;
  cache_stats: { hits: number; misses: number; rebuilds: number; memory_hits: number };
  worker_stats: { limit: number; peak: number; scheduled: number };
  current_snapshot?: GraphSnapshot;
}

export interface ReplayExecutionOptions {
  /** Operational scheduling only; never enters canonical proof semantics. */
  maxWorkers?: number;
  composition?: PolicySpec[];
}

interface SnapshotOutcome {
  commit: string;
  evaluation?: PolicyEvaluation;
  snapshot?: GraphSnapshot;
  error_code?: string;
}

interface ReplayWorkerMessage {
  commit: string;
  snapshot?: GraphSnapshot;
  error_code?: string;
}

interface ActiveReplayWorker {
  commit: string;
  run: string;
  checkout: string;
  resultFile: string;
  errorFile: string;
  child: ChildProcess;
}

const ZERO_SHA = "0".repeat(40);
export const DEFAULT_REPLAY_WORKERS = 4;
export const MAX_REPLAY_WORKERS = 8;
const POLL_STATE = new Int32Array(new SharedArrayBuffer(4));

function stableCommit(ref: string): string {
  return /^[a-f0-9]{40}$/.test(ref) ? ref : ZERO_SHA;
}

export function replaySafeEnvironment(home: string, gitConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
  };
}

export function hasUnsafeReplayFilter(root: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const raw = execFileSync("git", ["-C", root, "config", "--local", "--name-only", "--get-regexp", "^filter\\."], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim().split("\n").some((key) => key && !key.startsWith("filter.lfs."));
  } catch {
    return false;
  }
}

export function replayGitArgs(root: string, hooks: string, args: string[]): string[] {
  return [
    "-C", root,
    "-c", `core.hooksPath=${hooks}`,
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "filter.lfs.required=false",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    ...args,
  ];
}

function errorCode(error: unknown, fallback: string): string {
  const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  return e.code === "ETIMEDOUT" || e.killed || e.signal === "SIGTERM" ? "timeout" : fallback;
}

function workerLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_REPLAY_WORKERS;
  return Math.max(1, Math.min(MAX_REPLAY_WORKERS, Math.trunc(value)));
}

function replayWorkerUrl(): URL {
  const source = new URL("./replayWorker.ts", import.meta.url);
  return existsSync(fileURLToPath(source)) ? source : new URL("./replayWorker.js", import.meta.url);
}

function replayWorkerArgs(taskFile: string, resultFile: string): string[] {
  const worker = replayWorkerUrl();
  return worker.pathname.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx"), fileURLToPath(worker), taskFile, resultFile]
    : [fileURLToPath(worker), taskFile, resultFile];
}

export function cleanupReplayWorktree(
  root: string,
  hooks: string,
  env: NodeJS.ProcessEnv,
  run: string,
  checkout: string,
): boolean {
  let failed = false;
  try {
    execFileSync("git", replayGitArgs(root, hooks, ["worktree", "remove", "--force", checkout]), {
      env,
      timeout: 10_000,
      stdio: "ignore",
    });
  } catch {
    rmSync(checkout, { recursive: true, force: true });
    try {
      execFileSync("git", replayGitArgs(root, hooks, ["worktree", "remove", "--force", checkout]), {
        env,
        timeout: 10_000,
        stdio: "ignore",
      });
    } catch { failed = true; }
  }
  rmSync(run, { recursive: true, force: true });
  return failed;
}

function makeReceipt(
  leg: ReplayLeg,
  commit: string,
  policyHash: string,
  expected: PolicyEvaluationResult | undefined,
  outcome: SnapshotOutcome,
): ReplayReceipt {
  const body = {
    leg,
    commit: stableCommit(commit),
    ...(expected ? { expected } : {}),
    policy_hash: policyHash,
    evaluator: { ...POLICY_EVALUATOR },
    result: outcome.evaluation?.result ?? "error" as const,
    ...(outcome.snapshot ? { graph_hash: outcome.snapshot.graph_hash } : {}),
    ...(outcome.evaluation ? { evaluation_hash: proofEvaluationHash(outcome.evaluation) } : {}),
    ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
  };
  return ReplayReceiptSchema.parse({ ...body, deterministic_hash: canonicalHash(body) });
}

function acceptedHistory(
  root: string,
  plan: ProofPlan,
  env: NodeJS.ProcessEnv,
  hooks: string,
  timeout: number,
): { commits: string[]; error?: string } {
  const selector = plan.corpus.accepted_history;
  if (selector.max_commits === 0) return { commits: [] };
  if (![selector.from, selector.to].every((ref) => /^[a-f0-9]{40}$/.test(ref) && revExists(ref, root))) {
    return { commits: [], error: "history-ref-unresolved" };
  }
  try {
    const raw = execFileSync("git", replayGitArgs(root, hooks, [
      "rev-list",
      ...(selector.first_parent ? ["--first-parent"] : []),
      "--reverse",
      `${selector.from}..${selector.to}`,
    ]), { env, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });
    const excluded = new Set([...selector.exclude, selector.to]);
    const all = raw.trim().split("\n").filter((sha) => /^[a-f0-9]{40}$/.test(sha) && !excluded.has(sha));
    return { commits: all.slice(-selector.max_commits) };
  } catch (e) {
    return { commits: [], error: errorCode(e, "history-enumeration-failed") };
  }
}

/** Execute an immutable ProofPlan with the current in-process static evaluator.
 * Repository hooks, user-global Git configuration, overlay discovery, project
 * scripts, provider calls, and project tests are outside this path. Every
 * disposable worktree and derived graph is removed in a finally block. */
export function replayProofPlan(
  root: string,
  policy: PolicySpec,
  inputPlan: ProofPlan,
  opts: ReplayExecutionOptions = {},
): ProofReplayResult {
  const plan = ProofPlanSchema.parse(inputPlan);
  const composition = opts.composition ?? [];
  const policyHash = policyProofHash(policy, composition);
  assertCompositionBinding(policy, composition, plan.composition);
  const evaluate = (snapshot: GraphSnapshot): PolicyEvaluation => composition.length
    ? evaluateCompositePolicyOnSnapshot(policy, composition, snapshot)
    : evaluatePolicyOnSnapshot(policy, snapshot);
  if (plan.content_hash !== proofPlanContentHash(plan)) throw new Error(`proof plan ${plan.id} content hash mismatch`);
  if (plan.policy_id !== policy.id || plan.policy_candidate_hash !== policyHash) {
    throw new Error(`proof plan ${plan.id} does not match policy ${policy.id} semantics`);
  }
  if (plan.evaluator.name !== POLICY_EVALUATOR.name || plan.evaluator.version !== POLICY_EVALUATOR.version) {
    throw new Error(`proof plan ${plan.id} requires evaluator ${plan.evaluator.name}@${plan.evaluator.version}`);
  }

  const cacheBase = join(root, ".hunch-cache", "worktrees");
  mkdirSync(cacheBase, { recursive: true });
  const session = mkdtempSync(join(cacheBase, "replay-"));
  const hooks = join(session, "hooks-disabled");
  const gitConfig = join(session, "global.gitconfig");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(gitConfig, "");
  const env = replaySafeEnvironment(session, gitConfig);
  const unsafeFilter = hasUnsafeReplayFilter(root, env);
  const deadline = Date.now() + plan.budgets.max_minutes * 60_000;
  const outcomes = new Map<string, SnapshotOutcome>();
  const cacheStats = { hits: 0, misses: 0, rebuilds: 0, memory_hits: 0 };
  const workerStats = { limit: workerLimit(opts.maxWorkers), peak: 0, scheduled: 0 };
  const active: ActiveReplayWorker[] = [];

  try {
    const history = acceptedHistory(root, plan, env, hooks, Math.max(1, deadline - Date.now()));
    const requestedRefs = [
      plan.corpus.current_baseline.ref,
      ...plan.corpus.known_bad.map((fixture) => fixture.ref),
      ...plan.corpus.known_good.map((fixture) => fixture.ref),
      ...history.commits,
    ];
    const uniqueCommits: string[] = [];
    const seen = new Set<string>();
    for (const ref of requestedRefs) {
      const commit = stableCommit(ref);
      if (seen.has(commit)) cacheStats.memory_hits++;
      else {
        seen.add(commit);
        uniqueCommits.push(commit);
      }
    }

    const pending: string[] = [];
    for (const commit of uniqueCommits) {
      if (unsafeFilter) {
        outcomes.set(commit, { commit, error_code: "unsafe-local-filter-config" });
        continue;
      }
      if (commit === ZERO_SHA || !revExists(commit, root)) {
        outcomes.set(commit, { commit, error_code: "commit-ref-unresolved" });
        continue;
      }
      if (Date.now() >= deadline) {
        outcomes.set(commit, { commit, error_code: "timeout" });
        continue;
      }
      const cached = loadReplaySnapshot(root, commit, plan.data_class);
      if (cached.status === "hit" && cached.snapshot) {
        cacheStats.hits++;
        outcomes.set(commit, {
          commit,
          snapshot: cached.snapshot,
          evaluation: evaluate(cached.snapshot),
        });
        continue;
      }
      if (cached.status === "invalid") cacheStats.rebuilds++;
      else cacheStats.misses++;
      pending.push(commit);
    }

    while (pending.length || active.length) {
      while (pending.length && active.length < workerStats.limit && Date.now() < deadline) {
        const commit = pending.shift()!;
        const run = mkdtempSync(join(session, "commit-"));
        const checkout = join(run, "checkout");
        const graph = join(run, "graph");
        let added = false;
        try {
          execFileSync("git", replayGitArgs(root, hooks, ["worktree", "add", "--detach", "--force", checkout, commit]), {
            env,
            timeout: Math.max(1, deadline - Date.now()),
            stdio: "ignore",
          });
          added = true;
          const taskFile = join(run, "task.json");
          const resultFile = join(run, "result.json");
          const errorFile = join(run, "worker.stderr");
          writeFileSync(taskFile, JSON.stringify({ checkout, graph, root, commit }));
          const errorLog = openSync(errorFile, "w");
          let child: ChildProcess;
          try {
            child = spawn(process.execPath, replayWorkerArgs(taskFile, resultFile), {
              cwd: root,
              env,
              stdio: ["ignore", "ignore", errorLog],
            });
          } finally {
            closeSync(errorLog);
          }
          child.unref();
          active.push({ commit, run, checkout, resultFile, errorFile, child });
          workerStats.scheduled++;
          workerStats.peak = Math.max(workerStats.peak, active.length);
        } catch (e) {
          const cleanupFailed = added ? cleanupReplayWorktree(root, hooks, env, run, checkout) : false;
          if (!added) rmSync(run, { recursive: true, force: true });
          outcomes.set(commit, {
            commit,
            error_code: cleanupFailed
              ? "worktree-cleanup-failed"
              : errorCode(e, added ? "snapshot-index-failed" : "worktree-create-failed"),
          });
        }
      }

      let progressed = false;
      for (let index = active.length - 1; index >= 0; index--) {
        const task = active[index]!;
        const hasResult = existsSync(task.resultFile);
        const failedToStart = !hasResult && existsSync(task.errorFile) && statSync(task.errorFile).size > 0;
        if (!hasResult && !failedToStart) continue;
        active.splice(index, 1);
        let message: ReplayWorkerMessage;
        try {
          if (failedToStart) {
            task.child.kill("SIGTERM");
            throw new Error("worker process failed before producing a result");
          }
          message = JSON.parse(readFileSync(task.resultFile, "utf8")) as ReplayWorkerMessage;
        } catch {
          message = { commit: task.commit, error_code: "snapshot-index-failed" };
        }
        const cleanupFailed = cleanupReplayWorktree(root, hooks, env, task.run, task.checkout);
        let outcome: SnapshotOutcome;
        if (cleanupFailed) outcome = { commit: task.commit, error_code: "worktree-cleanup-failed" };
        else if (Date.now() >= deadline) outcome = { commit: task.commit, error_code: "timeout" };
        else if (message.commit !== task.commit || !message.snapshot) {
          outcome = { commit: task.commit, error_code: message.error_code ?? "snapshot-index-failed" };
        } else {
          try { putReplaySnapshot(root, message.snapshot, plan.data_class); } catch { /* derived cache failure never changes proof semantics */ }
          outcome = {
            commit: task.commit,
            snapshot: message.snapshot,
            evaluation: evaluate(message.snapshot),
          };
        }
        outcomes.set(task.commit, outcome);
        progressed = true;
      }

      if (Date.now() >= deadline) {
        for (const task of active.splice(0)) {
          task.child.kill("SIGTERM");
          const cleanupFailed = cleanupReplayWorktree(root, hooks, env, task.run, task.checkout);
          outcomes.set(task.commit, { commit: task.commit, error_code: cleanupFailed ? "worktree-cleanup-failed" : "timeout" });
        }
        for (const commit of pending.splice(0)) outcomes.set(commit, { commit, error_code: "timeout" });
        break;
      }
      if (!progressed && active.length) Atomics.wait(POLL_STATE, 0, 0, 10);
    }

    const outcomeFor = (ref: string): SnapshotOutcome =>
      outcomes.get(stableCommit(ref)) ?? { commit: stableCommit(ref), error_code: "snapshot-index-failed" };
    const currentOutcome = outcomeFor(plan.corpus.current_baseline.ref);
    const current = makeReceipt("current_baseline", plan.corpus.current_baseline.ref, policyHash, plan.corpus.current_baseline.expected, currentOutcome);
    const knownBad = plan.corpus.known_bad.map((fixture) =>
      makeReceipt("known_bad", fixture.ref, policyHash, fixture.expected, outcomeFor(fixture.ref)));
    const knownGood = plan.corpus.known_good.map((fixture) =>
      makeReceipt("known_good", fixture.ref, policyHash, fixture.expected, outcomeFor(fixture.ref)));
    const accepted = history.error
      ? [makeReceipt("accepted_history", plan.corpus.accepted_history.to, policyHash, undefined, {
          commit: stableCommit(plan.corpus.accepted_history.to),
          error_code: history.error,
        })]
      : history.commits.map((commit) => makeReceipt("accepted_history", commit, policyHash, undefined, outcomeFor(commit)));
    const receipts = [current, ...knownBad, ...knownGood, ...accepted];
    return {
      current,
      known_bad: knownBad,
      known_good: knownGood,
      accepted_history: accepted,
      replay_receipts: receipts,
      selected_history_commits: history.commits,
      history_complete: !history.error && accepted.every((receipt) => receipt.error_code !== "timeout"),
      cache_stats: cacheStats,
      worker_stats: workerStats,
      ...(currentOutcome.snapshot ? { current_snapshot: currentOutcome.snapshot } : {}),
    };
  } finally {
    for (const task of active.splice(0)) {
      task.child.kill("SIGTERM");
      try { cleanupReplayWorktree(root, hooks, env, task.run, task.checkout); } catch { /* primary replay error remains visible */ }
    }
    rmSync(session, { recursive: true, force: true });
  }
}
