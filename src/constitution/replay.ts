import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hunchPathsForDir } from "../core/paths.js";
import { indexRepo } from "../extractors/indexer.js";
import { revExists } from "../extractors/git.js";
import { HunchStore } from "../store/hunchStore.js";
import { canonicalHash, proofEvaluationHash, policySemanticHash, proofPlanContentHash } from "./canonical.js";
import { evaluatePolicyOnSnapshot, graphSnapshot, type GraphSnapshot } from "./evaluator.js";
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
  current_snapshot?: GraphSnapshot;
}

interface SnapshotOutcome {
  commit: string;
  evaluation?: PolicyEvaluation;
  snapshot?: GraphSnapshot;
  error_code?: string;
}

const ZERO_SHA = "0".repeat(40);

function stableCommit(ref: string): string {
  return /^[a-f0-9]{40}$/.test(ref) ? ref : ZERO_SHA;
}

function safeEnvironment(home: string, gitConfig: string): NodeJS.ProcessEnv {
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

function unsafeLocalFilter(root: string, env: NodeJS.ProcessEnv): boolean {
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

function gitArgs(root: string, hooks: string, args: string[]): string[] {
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
    const raw = execFileSync("git", gitArgs(root, hooks, [
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
): ProofReplayResult {
  const plan = ProofPlanSchema.parse(inputPlan);
  const policyHash = policySemanticHash(policy);
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
  const env = safeEnvironment(session, gitConfig);
  const unsafeFilter = unsafeLocalFilter(root, env);
  const deadline = Date.now() + plan.budgets.max_minutes * 60_000;
  const cache = new Map<string, SnapshotOutcome>();
  const cacheStats = { hits: 0, misses: 0, rebuilds: 0, memory_hits: 0 };

  const evaluateCommit = (ref: string): SnapshotOutcome => {
    const commit = stableCommit(ref);
    const hit = cache.get(commit);
    if (hit) {
      cacheStats.memory_hits++;
      return hit;
    }
    if (unsafeFilter) {
      const outcome = { commit, error_code: "unsafe-local-filter-config" };
      cache.set(commit, outcome);
      return outcome;
    }
    if (commit === ZERO_SHA || !revExists(commit, root)) {
      const outcome = { commit, error_code: "commit-ref-unresolved" };
      cache.set(commit, outcome);
      return outcome;
    }
    if (Date.now() >= deadline) {
      const outcome = { commit, error_code: "timeout" };
      cache.set(commit, outcome);
      return outcome;
    }
    const cached = loadReplaySnapshot(root, commit, plan.data_class);
    if (cached.status === "hit" && cached.snapshot) {
      cacheStats.hits++;
      const outcome = { commit, snapshot: cached.snapshot, evaluation: evaluatePolicyOnSnapshot(policy, cached.snapshot) };
      cache.set(commit, outcome);
      return outcome;
    }
    if (cached.status === "invalid") cacheStats.rebuilds++;
    else cacheStats.misses++;

    const run = mkdtempSync(join(session, "commit-"));
    const checkout = join(run, "checkout");
    const graph = join(run, "graph");
    let added = false;
    let cleanupFailed = false;
    let store: HunchStore | undefined;
    let outcome: SnapshotOutcome;
    try {
      execFileSync("git", gitArgs(root, hooks, ["worktree", "add", "--detach", "--force", checkout, commit]), {
        env,
        timeout: Math.max(1, deadline - Date.now()),
        stdio: "ignore",
      });
      added = true;
      store = new HunchStore(hunchPathsForDir(graph));
      store.json.ensureDirs();
      indexRepo(store, checkout, { churn: false });
      const snapshot = graphSnapshot(store, root, { publicOnly: true, head: commit });
      if (Date.now() >= deadline) outcome = { commit, error_code: "timeout" };
      else {
        try { putReplaySnapshot(root, snapshot, plan.data_class); } catch { /* derived cache failure never changes proof semantics */ }
        outcome = { commit, snapshot, evaluation: evaluatePolicyOnSnapshot(policy, snapshot) };
      }
    } catch (e) {
      outcome = { commit, error_code: errorCode(e, added ? "snapshot-index-failed" : "worktree-create-failed") };
    } finally {
      try { store?.close(); } catch { /* derived cache cleanup continues */ }
      if (added) {
        try {
          execFileSync("git", gitArgs(root, hooks, ["worktree", "remove", "--force", checkout]), {
            env,
            timeout: 10_000,
            stdio: "ignore",
          });
        } catch {
          rmSync(checkout, { recursive: true, force: true });
          try {
            execFileSync("git", gitArgs(root, hooks, ["worktree", "remove", "--force", checkout]), {
              env,
              timeout: 10_000,
              stdio: "ignore",
            });
          } catch { cleanupFailed = true; }
        }
      }
      rmSync(run, { recursive: true, force: true });
    }
    if (cleanupFailed) outcome = { commit, error_code: "worktree-cleanup-failed" };
    cache.set(commit, outcome!);
    return outcome!;
  };

  try {
    const currentOutcome = evaluateCommit(plan.corpus.current_baseline.ref);
    const current = makeReceipt("current_baseline", plan.corpus.current_baseline.ref, policyHash, plan.corpus.current_baseline.expected, currentOutcome);
    const knownBad = plan.corpus.known_bad.map((fixture) =>
      makeReceipt("known_bad", fixture.ref, policyHash, fixture.expected, evaluateCommit(fixture.ref)));
    const knownGood = plan.corpus.known_good.map((fixture) =>
      makeReceipt("known_good", fixture.ref, policyHash, fixture.expected, evaluateCommit(fixture.ref)));
    const history = acceptedHistory(root, plan, env, hooks, Math.max(1, deadline - Date.now()));
    const accepted = history.error
      ? [makeReceipt("accepted_history", plan.corpus.accepted_history.to, policyHash, undefined, {
          commit: stableCommit(plan.corpus.accepted_history.to),
          error_code: history.error,
        })]
      : history.commits.map((commit) => makeReceipt("accepted_history", commit, policyHash, undefined, evaluateCommit(commit)));
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
      ...(currentOutcome.snapshot ? { current_snapshot: currentOutcome.snapshot } : {}),
    };
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
}
