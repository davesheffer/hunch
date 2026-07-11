import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SyntaxNode } from "tree-sitter";
import { shortHash } from "../core/ids.js";
import type { Decision } from "../core/types.js";
import { loadNativeTreeSitter } from "../extractors/nativeTreeSitter.js";
import type { HunchStore } from "../store/hunchStore.js";
import { commitMeta, revExists } from "../extractors/git.js";
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
import { dependencySnapshotForCommit } from "./g2BehaviorDependencies.js";
import {
  NODE_TEST_REPORTER_SOURCE,
  exactNodeTestPattern,
  nodeTestIsolationFlag,
  nodeTestReporterEvents,
} from "./nodeTestEvidence.js";

export type G2BehaviorRunnerKind = "node-test" | "node-test-tsx";

export type G2BehaviorHumanDisposition = "selected" | "rejected";

export interface G2BehaviorCandidateReviewOptions extends G2CandidateReviewOptions {
  /** Build one finite review batch directly from an exact current human-confirmed
   * decision instead of requiring a rejected structural proxy first. */
  decisionId?: string;
}

export interface G2BehaviorReviewResolution {
  id: string;
  candidate_id: string;
  candidate_hash: string;
  review_hash: string;
  replay_id: string;
  replay_hash: string;
  disposition: G2BehaviorHumanDisposition;
  actor: string;
  reason: string;
  created_at: string;
}

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
  grounding: "rejected_proxy_plus_added_test" | "human_decision_plus_added_test" | "human_decision_plus_modified_test";
  data_class: "private";
  authority: "none";
  writes: "none";
  proof_status: "not_run";
  human_review?: G2BehaviorReviewResolution;
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
  selected_candidates?: number;
  rejected_candidates?: number;
  unreviewed_candidates?: number;
  commits_without_added_tests: string[];
  extraction_failures: Array<{ commit: string; file: string; error: string }>;
  items: G2BehaviorCandidate[];
  has_more: boolean;
  limitations: string[];
  data_class: "private";
  authority: "none";
  writes: "none";
  proof_status: "not_run";
  grounding_mode?: "human_decision_plus_added_test";
  source_decision_id?: string;
  source_grounding_hash?: string;
}

export interface G2BehaviorReplayLeg {
  commit: string;
  expected: "failed" | "passed";
  result: "failed" | "passed" | "error";
  exit_code: number | null;
  error_code?: string;
  dependency_snapshot_id?: string;
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

interface DirectDecisionCommit {
  commit: string;
  subject: string;
  date: string;
  changedFiles: Set<string>;
  decisionId: string;
  knownBad: string;
  groundingHash: string;
}

const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const LIMITATIONS = [
  "Candidates cover newly named node:test test()/it() cases in human-grounded fixing commits; renamed or modified existing tests require explicit review.",
  "Replay transplants the exact known-good test file into disposable known-bad and known-good worktrees and executes one named test without a shell.",
  "Replay never installs historical dependencies or runs package lifecycle scripts; missing dependency snapshots remain explicit diagnostic errors.",
  "A confirmed diagnostic receipt is not Policy IR, corpus evidence, a Constitution proof, activation authority, or G2 approval.",
];
const DIRECT_TEST_DELTA_LIMITATIONS = [
  "Direct decision candidates cover newly named node:test test()/it() cases and existing literal-named cases whose body contains an added fixing-commit line.",
  ...LIMITATIONS.slice(1),
];

const { Parser, typescript: tsLanguage, tsx: tsxLanguage } = loadNativeTreeSitter();

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

interface LiteralNodeTestCase {
  name: string;
  startLine: number;
  endLine: number;
}

function decodeJsStringBody(raw: string): string | null {
  let out = "";
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[++index];
    if (next == null) return null;
    const simple: Record<string, string> = {
      b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0",
    };
    if (next in simple) {
      if (next === "0" && /[0-9]/.test(raw[index + 1] ?? "")) return null;
      out += simple[next]!;
      continue;
    }
    if (next === "x") {
      const hex = raw.slice(index + 1, index + 3);
      if (!/^[a-fA-F0-9]{2}$/.test(hex)) return null;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (next === "u") {
      if (raw[index + 1] === "{") {
        const end = raw.indexOf("}", index + 2);
        if (end < 0) return null;
        const hex = raw.slice(index + 2, end);
        const codePoint = /^[a-fA-F0-9]{1,6}$/.test(hex) ? Number.parseInt(hex, 16) : -1;
        if (codePoint < 0 || codePoint > 0x10ffff) return null;
        out += String.fromCodePoint(codePoint);
        index = end;
      } else {
        const hex = raw.slice(index + 1, index + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex)) return null;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      }
      continue;
    }
    if (next === "\n") continue;
    if (next === "\r") {
      if (raw[index + 1] === "\n") index++;
      continue;
    }
    out += next;
  }
  return out;
}

function literalTestName(raw: string): string | null {
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || raw.at(-1) !== quote) return null;
  const body = raw.slice(1, -1);
  if (quote === "`" && body.includes("${")) return null;
  const name = decodeJsStringBody(body);
  if (name == null) return null;
  return name.trim() ? name : null;
}

function literalNodeTestCases(file: string, source: string): LiteralNodeTestCase[] {
  const language = /\.[cm]?[jt]sx$/.test(file) && /x$/.test(file) ? tsxLanguage : tsLanguage;
  const parser = new Parser();
  parser.setLanguage(language as never);
  let tree;
  try {
    tree = parser.parse(source, undefined, { bufferSize: Math.max(32 * 1024, source.length * 2 + 1024) });
  } catch {
    return [];
  }
  const cases: LiteralNodeTestCase[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      const first = args?.namedChildren[0];
      if (fn?.type === "identifier" && (fn.text === "test" || fn.text === "it")
        && first && (first.type === "string" || first.type === "template_string")) {
        const name = literalTestName(first.text);
        if (name) cases.push({ name, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
      }
    }
    node.namedChildren.forEach(visit);
  };
  visit(tree.rootNode);
  return cases;
}

function addedLineNumbers(root: string, knownBad: string, knownGood: string, file: string): Set<number> {
  let diff: string;
  try {
    diff = execFileSync("git", ["-C", root, "diff", "--unified=0", "--no-ext-diff", knownBad, knownGood, "--", file], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Set();
  }
  const added = new Set<number>();
  let nextLine: number | null = null;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (nextLine == null || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.add(nextLine++);
    } else if (!line.startsWith("-") || line.startsWith("---")) {
      nextLine++;
    }
  }
  return added;
}

function runnerFor(file: string, name: string, exact = false): G2BehaviorCandidate["runner"] {
  const kind: G2BehaviorRunnerKind = /\.(?:[cm]?js)$/.test(file) ? "node-test" : "node-test-tsx";
  const pattern = exact ? exactNodeTestPattern(name) : name;
  return {
    kind,
    argv: kind === "node-test"
      ? ["node", "--test", `--test-name-pattern=${pattern}`, file]
      : ["node", "tsx", "--test", `--test-name-pattern=${pattern}`, file],
  };
}

export function g2BehaviorCandidateHash(candidate: G2BehaviorCandidate): string {
  const { human_review: _humanReview, ...body } = candidate;
  return canonicalHash(body);
}

export function g2BehaviorReplayContentHash(receipt: G2BehaviorReplayReceipt): string {
  const { id: _id, content_hash: _contentHash, ...body } = receipt;
  return canonicalHash(body);
}

export function g2BehaviorReviewContentHash(report: G2BehaviorCandidateReview): string {
  const { id: _id, content_hash: _contentHash, ...body } = report;
  return canonicalHash(body);
}

function currentHumanDecision(store: HunchStore, decisionId: string): Decision {
  if (!/^dec_[A-Za-z0-9_-]+$/.test(decisionId)) throw new Error("G2 behavior decision id is invalid");
  const decision = store.getRec("decisions", decisionId);
  if (!decision) throw new Error(`G2 behavior decision ${decisionId} does not exist`);
  if (decision.status !== "accepted" || decision.superseded_by || decision.valid_to) {
    throw new Error(`G2 behavior decision ${decisionId} is not current and accepted`);
  }
  if (!decision.provenance.source.includes("human_confirmed")) {
    throw new Error(`G2 behavior decision ${decisionId} is not human-confirmed`);
  }
  if (!decision.commit) throw new Error(`G2 behavior decision ${decisionId} has no exact fixing commit`);
  return decision;
}

function directDecisionCommit(store: HunchStore, root: string, decisionId: string): DirectDecisionCommit {
  const decision = currentHumanDecision(store, decisionId);
  const meta = commitMeta(decision.commit!, root);
  if (!meta) throw new Error(`G2 behavior decision ${decisionId} fixing commit is unavailable`);
  let knownBad: string;
  try {
    knownBad = execFileSync("git", ["-C", root, "rev-parse", `${meta.sha}^`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`G2 behavior decision ${decisionId} fixing commit has no first parent`);
  }
  if (!FULL_SHA.test(knownBad)) throw new Error(`G2 behavior decision ${decisionId} first parent is invalid`);
  return {
    commit: meta.sha,
    subject: meta.subject,
    date: meta.date,
    changedFiles: new Set(meta.files),
    decisionId: decision.id,
    knownBad,
    groundingHash: canonicalHash(decision),
  };
}

function directDecisionReview(
  store: HunchStore,
  root: string,
  opts: G2BehaviorCandidateReviewOptions,
  behaviorResolutions: G2BehaviorReviewResolution[],
  since: string,
  maxCommits: number,
  limit: number,
): G2BehaviorCandidateReview {
  const commit = directDecisionCommit(store, root, opts.decisionId!);
  const candidates: G2BehaviorCandidate[] = [];
  const failures: G2BehaviorCandidateReview["extraction_failures"] = [];
  let hasModifiedTestCandidate = false;
  for (const file of [...commit.changedFiles].filter(safeTestFile).sort()) {
    const after = fileAt(root, commit.commit, file);
    if (after == null) {
      failures.push({ commit: commit.commit, file, error: "known-good test source unavailable" });
      continue;
    }
    const before = fileAt(root, commit.knownBad, file) ?? "";
    const previous = new Set(literalNodeTestCases(file, before).map((candidate) => candidate.name));
    const addedLines = addedLineNumbers(root, commit.knownBad, commit.commit, file);
    const afterCases = literalNodeTestCases(file, after);
    const modified = new Set(afterCases
      .filter((candidate) => previous.has(candidate.name)
        && [...addedLines].some((line) => line >= candidate.startLine && line <= candidate.endLine))
      .map((candidate) => candidate.name));
    const names = [...new Set(afterCases.map((candidate) => candidate.name))]
      .filter((candidate) => !previous.has(candidate) || modified.has(candidate))
      .sort();
    for (const name of names) {
      const grounding = previous.has(name) ? "human_decision_plus_modified_test" as const : "human_decision_plus_added_test" as const;
      if (grounding === "human_decision_plus_modified_test") hasModifiedTestCandidate = true;
      const sourceHash = canonicalHash(after);
      const seed = canonicalHash({
        grounding,
        decision_id: commit.decisionId,
        commit: commit.commit,
        file,
        name,
        source_hash: sourceHash,
      });
      candidates.push({
        id: `g2behavior_${shortHash(seed)}`,
        commit: commit.commit,
        commit_subject: commit.subject,
        commit_date: commit.date,
        statement: name,
        test: { file, name, source_hash: sourceHash },
        runner: runnerFor(file, name, true),
        decision_ids: [commit.decisionId],
        source_candidate_ids: [],
        source_attestation_ids: [],
        proposed_corpus: {
          known_bad: { ref: commit.knownBad, expected: "failed" },
          known_good: { ref: commit.commit, expected: "passed" },
          observed: false,
        },
        grounding,
        data_class: "private",
        authority: "none",
        writes: "none",
        proof_status: "not_run",
      });
    }
  }
  for (const candidate of candidates) {
    const resolution = behaviorResolutions.find((entry) => (
      entry.candidate_id === candidate.id && entry.candidate_hash === g2BehaviorCandidateHash(candidate)
    ));
    if (resolution) candidate.human_review = resolution;
  }
  candidates.sort((left, right) => left.test.file.localeCompare(right.test.file) || left.test.name.localeCompare(right.test.name));
  const items = candidates.slice(0, limit);
  const reviewCounts = candidates.some((candidate) => candidate.human_review !== undefined) ? {
    selected_candidates: candidates.filter((candidate) => candidate.human_review?.disposition === "selected").length,
    rejected_candidates: candidates.filter((candidate) => candidate.human_review?.disposition === "rejected").length,
    unreviewed_candidates: candidates.filter((candidate) => candidate.human_review === undefined).length,
  } : {};
  const body = {
    structural_review_hash: commit.groundingHash,
    since,
    max_commits: maxCommits,
    limit,
    grounded_rejections_scanned: 0,
    candidate_commits: candidates.length ? 1 : 0,
    behavior_candidates: candidates.length,
    ...reviewCounts,
    commits_without_added_tests: candidates.length ? [] : [commit.commit],
    extraction_failures: failures,
    items,
    has_more: candidates.length > items.length,
    limitations: hasModifiedTestCandidate ? DIRECT_TEST_DELTA_LIMITATIONS : LIMITATIONS,
    data_class: "private" as const,
    authority: "none" as const,
    writes: "none" as const,
    proof_status: "not_run" as const,
    grounding_mode: "human_decision_plus_added_test" as const,
    source_decision_id: commit.decisionId,
    source_grounding_hash: commit.groundingHash,
  };
  const contentHash = canonicalHash(body);
  return { id: `g2behaviorcandidates_${shortHash(contentHash)}`, content_hash: contentHash, ...body };
}

export function buildG2BehaviorCandidateReview(
  store: HunchStore,
  root: string,
  opts: G2BehaviorCandidateReviewOptions = {},
  resolutions: G2CandidateReviewResolution[] = [],
  behaviorResolutions: G2BehaviorReviewResolution[] = [],
): G2BehaviorCandidateReview {
  const since = (opts.since ?? "180d").trim();
  if (!since || since.length > 100) throw new Error("G2 behavior candidate since window must be a non-empty bounded string");
  const maxCommits = positiveBound(opts.maxCommits ?? 100, "G2 behavior candidate maxCommits", 200);
  const limit = positiveBound(opts.limit ?? 30, "G2 behavior candidate limit", 100);
  if (opts.decisionId) return directDecisionReview(store, root, opts, behaviorResolutions, since, maxCommits, limit);
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
  for (const candidate of candidates) {
    const resolution = behaviorResolutions.find((entry) => (
      entry.candidate_id === candidate.id && entry.candidate_hash === g2BehaviorCandidateHash(candidate)
    ));
    if (resolution) candidate.human_review = resolution;
  }
  candidates.sort((left, right) => right.commit_date.localeCompare(left.commit_date)
    || left.commit.localeCompare(right.commit)
    || left.test.file.localeCompare(right.test.file)
    || left.test.name.localeCompare(right.test.name));
  const items = candidates.slice(0, limit);
  const reviewCounts = candidates.some((candidate) => candidate.human_review !== undefined) ? {
    selected_candidates: candidates.filter((candidate) => candidate.human_review?.disposition === "selected").length,
    rejected_candidates: candidates.filter((candidate) => candidate.human_review?.disposition === "rejected").length,
    unreviewed_candidates: candidates.filter((candidate) => candidate.human_review === undefined).length,
  } : {};
  const body = {
    structural_review_hash: structural.content_hash,
    since,
    max_commits: maxCommits,
    limit,
    grounded_rejections_scanned: rejected.length,
    candidate_commits: commits.size,
    behavior_candidates: candidates.length,
    ...reviewCounts,
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

function errorLeg(
  commit: string,
  expected: "failed" | "passed",
  errorCode: string,
  dependencySnapshotId?: string,
): G2BehaviorReplayLeg {
  return {
    commit,
    expected,
    result: "error",
    exit_code: null,
    error_code: errorCode,
    ...(dependencySnapshotId ? { dependency_snapshot_id: dependencySnapshotId } : {}),
  };
}

export function nodeTestInfrastructureError(output: string): string | null {
  if (/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/.test(output)) return "dependency-snapshot-unavailable";
  if (/Could not locate the bindings file|NODE_MODULE_VERSION|Module did not self-register|dlopen\(/.test(output)) return "dependency-snapshot-unavailable";
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
  const dependencySnapshot = dependencySnapshotForCommit(root, commit);
  const dependencySnapshotId = dependencySnapshot?.snapshot.id;
  let added = false;
  let leg: G2BehaviorReplayLeg;
  try {
    execFileSync("git", replayGitArgs(root, hooks, ["worktree", "add", "--detach", "--force", checkout, commit]), {
      env,
      timeout: budgetMs,
      stdio: "ignore",
    });
    added = true;
    if (dependencySnapshot) {
      symlinkSync(dependencySnapshot.nodeModules, join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    }
    const testFile = join(checkout, candidate.test.file);
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, source);
    const exactEvidence = candidate.grounding === "human_decision_plus_added_test";
    const reporter = join(run, "reporter.mjs");
    const patternArg = candidate.runner.argv.find((arg) => arg.startsWith("--test-name-pattern="))
      ?? `--test-name-pattern=${candidate.test.name}`;
    if (exactEvidence) writeFileSync(reporter, NODE_TEST_REPORTER_SOURCE);
    const testArgs = exactEvidence
      ? [
          "--test",
          nodeTestIsolationFlag(),
          patternArg,
          `--test-reporter=${pathToFileURL(reporter).href}`,
          "--test-reporter-destination=stdout",
          candidate.test.file,
        ]
      : ["--test", patternArg, candidate.test.file];
    let args: string[] | null;
    if (candidate.runner.kind === "node-test") {
      args = testArgs;
    } else {
      const tsx = dependencySnapshot ? join(dependencySnapshot.nodeModules, "tsx", "dist", "cli.mjs") : "";
      args = existsSync(tsx) ? [tsx, ...testArgs] : null;
    }
    if (!args) {
      leg = errorLeg(commit, expected, "dependency-snapshot-unavailable", dependencySnapshotId);
    } else {
      const result = spawnSync(process.execPath, args, {
        cwd: checkout,
        env,
        encoding: "utf8",
        timeout: budgetMs,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "runner-failed";
        leg = errorLeg(commit, expected, code, dependencySnapshotId);
      } else if (result.signal) {
        leg = errorLeg(commit, expected, result.signal === "SIGTERM" ? "timeout" : "runner-signaled", dependencySnapshotId);
      } else {
        const exitCode = result.status ?? null;
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        if (exactEvidence) {
          const matches = nodeTestReporterEvents(result.stdout ?? "")
            .filter((event) => event.name === candidate.test.name && !event.skip && !event.todo);
          if (matches.length === 0) {
            leg = errorLeg(commit, expected, nodeTestInfrastructureError(output) ?? "selected-test-not-executed", dependencySnapshotId);
          } else if (matches.length > 1) {
            leg = errorLeg(commit, expected, "selected-test-ambiguous", dependencySnapshotId);
          } else if (matches[0]!.type === "test:pass" && exitCode === 0) {
            leg = { commit, expected, result: "passed", exit_code: exitCode, ...(dependencySnapshotId ? { dependency_snapshot_id: dependencySnapshotId } : {}) };
          } else if (matches[0]!.type === "test:fail" && exitCode !== 0) {
            leg = { commit, expected, result: "failed", exit_code: exitCode, ...(dependencySnapshotId ? { dependency_snapshot_id: dependencySnapshotId } : {}) };
          } else {
            leg = errorLeg(commit, expected, "runner-outcome-inconsistent", dependencySnapshotId);
          }
        } else {
          const infrastructureError = exitCode === 0 ? null : nodeTestInfrastructureError(output);
          leg = infrastructureError
            ? errorLeg(commit, expected, infrastructureError, dependencySnapshotId)
            : {
                commit,
                expected,
                result: exitCode === 0 ? "passed" : "failed",
                exit_code: exitCode,
                ...(dependencySnapshotId ? { dependency_snapshot_id: dependencySnapshotId } : {}),
              };
        }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : added ? "runner-setup-failed" : "worktree-create-failed";
    leg = errorLeg(commit, expected, code, dependencySnapshotId);
  } finally {
    if (added) {
      const cleanupFailed = cleanupReplayWorktree(root, hooks, env, run, checkout);
      if (cleanupFailed) leg = errorLeg(commit, expected, "worktree-cleanup-failed", dependencySnapshotId);
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

  mkdirSync(join(root, ".hunch-cache", "worktrees"), { recursive: true });
  const session = mkdtempSync(join(tmpdir(), "hunch-behavior-"));
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
