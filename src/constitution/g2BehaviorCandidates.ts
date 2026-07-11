import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { shortHash } from "../core/ids.js";
import type { HunchStore } from "../store/hunchStore.js";
import { revExists } from "../extractors/git.js";
import { canonicalHash } from "./canonical.js";
import {
  buildG2CandidateReview,
  positiveBound,
  type G2CandidateReviewOptions,
  type G2CandidateReviewResolution,
} from "./g2Candidates.js";
import {
  cleanupReplayWorktree,
  hasUnsafeReplayFilter,
  replayGitArgs,
  replaySafeEnvironment,
} from "./replay.js";

export type G2BehaviorRunnerKind = "node-test" | "node-test-tsx";

export interface G2BehaviorCandidate {
  id: string;
  commit: string;
  commit_subject: string;
  commit_date: string;
  statement: string;
  test: {
    file: string;
    name: string;
    source_hash: string;
  };
  runner: {
    kind: G2BehaviorRunnerKind;
    argv: string[];
  };
  decision_ids: string[];
  source_candidate_ids: string[];
  source_attestation_ids: string[];
  proposed_corpus: {
    known_bad: { ref: string; expected: "failed" };
    known_good: { ref: string; expected: "passed" };
    observed: false;
  };
  grounding: "rejected_proxy_plus_added_test";
  data_class: "private";
  authority: "none";
  writes: "none";
  proof_status: "not_run";
}

export interface G2BehaviorCandidateReview {
  id: string;
  content_hash: string;
  structural_review_hash: string;
  since: string;
  max_commits: number;
  limit: number;
  grounded_rejections_scanned: number;
  candidate_commits: number;
  behavior_candidates: number;
  commits_without_added_tests: string[];
  extraction_failures: Array<{ commit: string; file: string; error: string }>;
  items: G2BehaviorCandidate[];
  has_more: boolean;
  limitations: string[];
  data_class: "private";
  authority: "none";
  writes: "none";
  proof_status: "not_run";
}

export interface G2BehaviorReplayLeg {
  commit: string;
  expected: "failed" | "passed";
  result: "failed" | "passed" | "error";
  exit_code: number | null;
  error_code?: string;
}

export interface G2BehaviorReplayReceipt {
  id: string;
  content_hash: string;
  candidate_id: string;
  candidate_hash: string;
  review_hash: string;
  test: G2BehaviorCandidate["test"];
  runner: G2BehaviorCandidate["runner"];
  known_bad: G2BehaviorReplayLeg;
  known_good: G2BehaviorReplayLeg;
  verdict: "behavior_confirmed" | "inconclusive";
  budget_ms: number;
  limitations: string[];
  data_class: "private";
  authority: "none";
  effects: "diagnostic_only";
  writes: "disposable_only";
}

interface RejectedCommit {
  commit: string;
  subject: string;
  date: string;
  changedFiles: Set<string>;
  decisionIds: Set<string>;
  sourceCandidateIds: Set<string>;
  sourceAttestationIds: Set<string>;
  knownBad: string;
}

const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const LIMITATIONS = [
  "Candidates cover newly named node:test test()/it() cases in human-grounded fixing commits; renamed or modified existing tests require explicit review.",
  "Replay transplants the exact known-good test file into disposable known-bad and known-good worktrees and executes one named test without a shell.",
  "Replay never installs historical dependencies or runs package lifecycle scripts; missing dependency snapshots remain explicit diagnostic errors.",
  "A confirmed diagnostic receipt is not Policy IR, corpus evidence, a Constitution proof, activation authority, or G2 approval.",
];

function safeTestFile(file: string): boolean {
  return !!file
    && !isAbsolute(file)
    && !file.includes("\\")
    && !file.includes("\0")
    && !file.split("/").some((part) => part === ".." || part === ".")
    && TEST_FILE.test(file);
}

function fileAt(root: string, commit: string, file: string): string | null {
  if (!FULL_SHA.test(commit) || !safeTestFile(file)) return null;
  try {
    return execFileSync("git", ["-C", root, "show", `${commit}:${file}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function decodeEscaped(raw: string): string {
  let out = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char !== "\\" || index + 1 >= raw.length) {
      out += char;
      continue;
    }
    const next = raw[++index]!;
    out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
  }
  return out;
}

/** Extract literal node:test names without interpreting source or template expressions. */
export function addedNodeTestNames(source: string): string[] {
  const names = new Set<string>();
  const start = /\b(?:test|it)\s*\(\s*/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(source))) {
    const quote = source[match.index + match[0].length];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let raw = "";
    let escaped = false;
    let closed = false;
    let cursor = match.index + match[0].length + 1;
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]!;
      if (escaped) {
        raw += `\\${char}`;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        closed = true;
        break;
      }
      if (quote === "`" && char === "$" && source[cursor + 1] === "{") {
        raw = "";
        break;
      }
      raw += char;
    }
    if (closed && raw.trim()) names.add(decodeEscaped(raw));
    start.lastIndex = Math.max(start.lastIndex, cursor + 1);
  }
  return [...names].sort();
}

function runnerFor(file: string, name: string): G2BehaviorCandidate["runner"] {
  const kind: G2BehaviorRunnerKind = /\.(?:[cm]?js)$/.test(file) ? "node-test" : "node-test-tsx";
  return {
    kind,
    argv: kind === "node-test"
      ? ["node", "--test", `--test-name-pattern=${name}`, file]
      : ["node", "tsx", "--test", `--test-name-pattern=${name}`, file],
  };
}

export function g2BehaviorCandidateHash(candidate: G2BehaviorCandidate): string {
  return canonicalHash(candidate);
}

export function g2BehaviorReviewContentHash(report: G2BehaviorCandidateReview): string {
  const { id: _id, content_hash: _contentHash, ...body } = report;
  return canonicalHash(body);
}

export function buildG2BehaviorCandidateReview(
  store: HunchStore,
  root: string,
  opts: G2CandidateReviewOptions = {},
  resolutions: G2CandidateReviewResolution[] = [],
): G2BehaviorCandidateReview {
  const since = (opts.since ?? "180d").trim();
  if (!since || since.length > 100) throw new Error("G2 behavior candidate since window must be a non-empty bounded string");
  const maxCommits = positiveBound(opts.maxCommits ?? 100, "G2 behavior candidate maxCommits", 200);
  const limit = positiveBound(opts.limit ?? 30, "G2 behavior candidate limit", 100);
  const structural = buildG2CandidateReview(store, root, { since, maxCommits, limit: 100 }, resolutions);
  const rejected = structural.items.filter((candidate) => candidate.human_review?.disposition === "rejected"
    && candidate.attestation.status !== "unattested_structural_coincidence");
  const commits = new Map<string, RejectedCommit>();
  for (const candidate of rejected) {
    const review = candidate.human_review!;
    const current = commits.get(candidate.commit) ?? {
      commit: candidate.commit,
      subject: candidate.commit_subject,
      date: candidate.commit_date,
      changedFiles: new Set<string>(),
      decisionIds: new Set<string>(),
      sourceCandidateIds: new Set<string>(),
      sourceAttestationIds: new Set<string>(),
      knownBad: candidate.proposed_corpus.known_bad.ref,
    };
    candidate.changed_files.forEach((file) => current.changedFiles.add(file));
    candidate.attestation.decision_ids.forEach((id) => current.decisionIds.add(id));
    current.sourceCandidateIds.add(candidate.id);
    current.sourceAttestationIds.add(review.id);
    commits.set(candidate.commit, current);
  }

  const candidates: G2BehaviorCandidate[] = [];
  const failures: G2BehaviorCandidateReview["extraction_failures"] = [];
  const withoutTests: string[] = [];
  for (const commit of [...commits.values()].sort((left, right) => left.commit.localeCompare(right.commit))) {
    let found = false;
    for (const file of [...commit.changedFiles].filter(safeTestFile).sort()) {
      const after = fileAt(root, commit.commit, file);
      if (after == null) {
        failures.push({ commit: commit.commit, file, error: "known-good test source unavailable" });
        continue;
      }
      const before = fileAt(root, commit.knownBad, file) ?? "";
      const previous = new Set(addedNodeTestNames(before));
      for (const name of addedNodeTestNames(after).filter((candidate) => !previous.has(candidate))) {
        found = true;
        const sourceHash = canonicalHash(after);
        const seed = canonicalHash({ commit: commit.commit, file, name, source_hash: sourceHash });
        candidates.push({
          id: `g2behavior_${shortHash(seed)}`,
          commit: commit.commit,
          commit_subject: commit.subject,
          commit_date: commit.date,
          statement: name,
          test: { file, name, source_hash: sourceHash },
          runner: runnerFor(file, name),
          decision_ids: [...commit.decisionIds].sort(),
          source_candidate_ids: [...commit.sourceCandidateIds].sort(),
          source_attestation_ids: [...commit.sourceAttestationIds].sort(),
          proposed_corpus: {
            known_bad: { ref: commit.knownBad, expected: "failed" },
            known_good: { ref: commit.commit, expected: "passed" },
            observed: false,
          },
          grounding: "rejected_proxy_plus_added_test",
          data_class: "private",
          authority: "none",
          writes: "none",
          proof_status: "not_run",
        });
      }
    }
    if (!found) withoutTests.push(commit.commit);
  }
  candidates.sort((left, right) => right.commit_date.localeCompare(left.commit_date)
    || left.commit.localeCompare(right.commit)
    || left.test.file.localeCompare(right.test.file)
    || left.test.name.localeCompare(right.test.name));
  const items = candidates.slice(0, limit);
  const body = {
    structural_review_hash: structural.content_hash,
    since,
    max_commits: maxCommits,
    limit,
    grounded_rejections_scanned: rejected.length,
    candidate_commits: commits.size,
    behavior_candidates: candidates.length,
    commits_without_added_tests: withoutTests.sort(),
    extraction_failures: failures.sort((left, right) => left.commit.localeCompare(right.commit) || left.file.localeCompare(right.file)),
    items,
    has_more: candidates.length > items.length,
    limitations: LIMITATIONS,
    data_class: "private" as const,
    authority: "none" as const,
    writes: "none" as const,
    proof_status: "not_run" as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `g2behaviorcandidates_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}

function errorLeg(commit: string, expected: "failed" | "passed", errorCode: string): G2BehaviorReplayLeg {
  return { commit, expected, result: "error", exit_code: null, error_code: errorCode };
}

export function nodeTestInfrastructureError(output: string): string | null {
  if (/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(output)) return "dependency-snapshot-unavailable";
  if (/does not provide an export named|Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(output)) return "test-load-failed";
  return null;
}

function runLeg(
  root: string,
  session: string,
  hooks: string,
  env: NodeJS.ProcessEnv,
  candidate: G2BehaviorCandidate,
  commit: string,
  expected: "failed" | "passed",
  source: string,
  budgetMs: number,
): G2BehaviorReplayLeg {
  if (!FULL_SHA.test(commit) || !revExists(commit, root)) return errorLeg(commit, expected, "commit-ref-unresolved");
  const run = mkdtempSync(join(session, `${expected}-`));
  const checkout = join(run, "checkout");
  let added = false;
  let leg: G2BehaviorReplayLeg;
  try {
    execFileSync("git", replayGitArgs(root, hooks, ["worktree", "add", "--detach", "--force", checkout, commit]), {
      env,
      timeout: budgetMs,
      stdio: "ignore",
    });
    added = true;
    const testFile = join(checkout, candidate.test.file);
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, source);
    let args: string[] | null;
    if (candidate.runner.kind === "node-test") {
      args = ["--test", `--test-name-pattern=${candidate.test.name}`, candidate.test.file];
    } else {
      const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
      args = existsSync(tsx) ? [tsx, "--test", `--test-name-pattern=${candidate.test.name}`, candidate.test.file] : null;
    }
    if (!args) {
      leg = errorLeg(commit, expected, "runner-unavailable");
    } else {
      const result = spawnSync(process.execPath, args, {
        cwd: checkout,
        env,
        encoding: "utf8",
        timeout: budgetMs,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "runner-failed";
        leg = errorLeg(commit, expected, code);
      } else if (result.signal) {
        leg = errorLeg(commit, expected, result.signal === "SIGTERM" ? "timeout" : "runner-signaled");
      } else {
        const exitCode = result.status ?? null;
        const infrastructureError = exitCode === 0 ? null : nodeTestInfrastructureError(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
        leg = infrastructureError
          ? errorLeg(commit, expected, infrastructureError)
          : { commit, expected, result: exitCode === 0 ? "passed" : "failed", exit_code: exitCode };
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : added ? "runner-setup-failed" : "worktree-create-failed";
    leg = errorLeg(commit, expected, code);
  } finally {
    if (added) {
      const cleanupFailed = cleanupReplayWorktree(root, hooks, env, run, checkout);
      if (cleanupFailed) leg = errorLeg(commit, expected, "worktree-cleanup-failed");
    } else {
      rmSync(run, { recursive: true, force: true });
    }
  }
  return leg!;
}

export function replayG2BehaviorCandidate(
  root: string,
  report: G2BehaviorCandidateReview,
  candidateId: string,
  reviewHash: string,
  opts: { timeoutMs?: number } = {},
): G2BehaviorReplayReceipt {
  if (report.content_hash !== g2BehaviorReviewContentHash(report)
    || report.id !== `g2behaviorcandidates_${shortHash(report.content_hash)}`) {
    throw new Error(`G2 behavior candidate review ${report.id} content hash mismatch`);
  }
  if (reviewHash !== report.content_hash) throw new Error("behavior candidate review hash does not match the exact current review packet");
  const candidate = report.items.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`behavior candidate ${candidateId} is not present in review ${report.id}`);
  const budgetMs = positiveBound(opts.timeoutMs ?? 30_000, "G2 behavior replay timeoutMs", 120_000);
  const source = fileAt(root, candidate.proposed_corpus.known_good.ref, candidate.test.file);
  if (source == null || canonicalHash(source) !== candidate.test.source_hash) {
    throw new Error(`behavior candidate ${candidate.id} known-good test source hash mismatch`);
  }

  const cacheBase = join(root, ".hunch-cache", "worktrees");
  mkdirSync(cacheBase, { recursive: true });
  const session = mkdtempSync(join(cacheBase, "behavior-"));
  const hooks = join(session, "hooks-disabled");
  const gitConfig = join(session, "global.gitconfig");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(gitConfig, "");
  const env = replaySafeEnvironment(session, gitConfig);
  let knownBad: G2BehaviorReplayLeg;
  let knownGood: G2BehaviorReplayLeg;
  try {
    if (hasUnsafeReplayFilter(root, env)) {
      knownBad = errorLeg(candidate.proposed_corpus.known_bad.ref, "failed", "unsafe-local-filter-config");
      knownGood = errorLeg(candidate.proposed_corpus.known_good.ref, "passed", "unsafe-local-filter-config");
    } else {
      knownBad = runLeg(root, session, hooks, env, candidate, candidate.proposed_corpus.known_bad.ref, "failed", source, budgetMs);
      knownGood = runLeg(root, session, hooks, env, candidate, candidate.proposed_corpus.known_good.ref, "passed", source, budgetMs);
    }
  } finally {
    rmSync(session, { recursive: true, force: true });
  }
  const verdict = knownBad.result === "failed" && knownGood.result === "passed"
    ? "behavior_confirmed" as const
    : "inconclusive" as const;
  const body = {
    candidate_id: candidate.id,
    candidate_hash: g2BehaviorCandidateHash(candidate),
    review_hash: report.content_hash,
    test: candidate.test,
    runner: candidate.runner,
    known_bad: knownBad,
    known_good: knownGood,
    verdict,
    budget_ms: budgetMs,
    limitations: LIMITATIONS,
    data_class: "private" as const,
    authority: "none" as const,
    effects: "diagnostic_only" as const,
    writes: "disposable_only" as const,
  };
  const contentHash = canonicalHash(body);
  return { id: `g2behaviorreplay_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}
