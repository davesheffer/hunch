import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";
import {
  assertProjectDnaHostEvidence,
  type ProjectDnaHostEvidence,
} from "./projectDnaHostEvidence.js";

export const PROJECT_DNA_SCHEMA_VERSION = "hunch.project-dna/1" as const;
export const PROJECT_DNA_MATCH_SCHEMA_VERSION = "hunch.project-dna-match/1" as const;

const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PROFILE_ID = /^pdna_[a-f0-9]{24}$/;
const REPOSITORY_ID = /^pdnar_[a-f0-9]{24}$/;
const MATCH_ID = /^pdnam_[a-f0-9]{24}$/;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_HISTORY = 200;
const MIN_HISTORY = 5;
const MAX_EVIDENCE = 8;
const MAX_TRAITS = 64;
const MAX_FILE_BYTES = 256 * 1024;

export const PROJECT_DNA_CATEGORIES = ["communication", "engineering", "review", "culture", "vocabulary"] as const;
export type ProjectDnaCategory = (typeof PROJECT_DNA_CATEGORIES)[number];
export type ProjectDnaEvidenceKind = "git-history" | "committed-file" | "host-evidence";

export interface ProjectDnaEvidence {
  kind: ProjectDnaEvidenceKind;
  ref: string;
  revision: string;
  content_hash: string;
  sample_count: number;
  provenance: "committed-repository" | "host-provided";
  visibility: "repository";
}

export interface ProjectDnaTrait {
  id: string;
  category: ProjectDnaCategory;
  key: string;
  claim: string;
  confidence: number;
  observation_state: "observed";
  freshness: "current";
  contradiction: "none";
  evidence: ProjectDnaEvidence[];
}

export interface ProjectDnaProfile {
  schema: typeof PROJECT_DNA_SCHEMA_VERSION;
  profile_id: string;
  /** Clone-stable identity for the repository lineage, derived from its root commits. */
  repository_id: string;
  repository_revision: string;
  history_sample_count: number;
  source_files: string[];
  traits: ProjectDnaTrait[];
  content_hash: string;
}

export interface ProjectDnaDiscoveryOptions {
  /** A sealed batch selected and authorized by the host for this exact revision. */
  hostEvidence?: ProjectDnaHostEvidence;
}

export interface ProjectDnaArtifact {
  kind: "commit" | "pull_request" | "issue" | "message";
  title: string;
  body?: string;
}

export interface ProjectDnaMatchCheck {
  trait_id: string;
  key: string;
  applicable: boolean;
  passed: boolean | null;
  weight: number;
  detail: string;
}

export interface ProjectDnaMatch {
  schema: typeof PROJECT_DNA_MATCH_SCHEMA_VERSION;
  match_id: string;
  profile_id: string;
  repository_id: string;
  repository_revision: string;
  artifact_kind: ProjectDnaArtifact["kind"];
  score: number | null;
  applicable_checks: number;
  checks: ProjectDnaMatchCheck[];
  content_hash: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "with", "without", "add", "adds", "added", "fix", "fixes", "fixed",
  "update", "updates", "updated", "change", "changes", "changed", "remove", "removes", "removed", "merge",
]);

const SOURCE_FILES = [
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "AGENTS.md",
  "CLAUDE.md",
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C", LANG: "C" };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
  ]) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
  }
  return environment;
}

function gitBytes(root: string, args: string[], maxBuffer = MAX_GIT_OUTPUT): Buffer {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "buffer",
      env: gitEnvironment(),
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString("utf8").trim().replace(/[\r\n]+/g, " ");
    throw new Error(`could not inspect repository DNA${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }
}

function gitText(root: string, args: string[]): string {
  return gitBytes(root, args).toString("utf8").trim();
}

function exactCommit(root: string, ref: string): string {
  if (!ref.trim() || /[\0\r\n]/.test(ref) || ref.length > 1_024) throw new Error("Git revision is invalid");
  const revision = gitText(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!GIT_OBJECT.test(revision)) throw new Error("Git did not return an exact commit object");
  return revision;
}

function committedFile(root: string, revision: string, path: string): Buffer | null {
  const type = execFileSync("git", ["-C", root, "cat-file", "-t", `${revision}:${path}`], {
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  }).trim();
  if (type !== "blob") return null;
  const sizeText = gitText(root, ["cat-file", "-s", `${revision}:${path}`]);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return null;
  const bytes = gitBytes(root, ["show", `${revision}:${path}`], MAX_FILE_BYTES + 1);
  if (bytes.byteLength !== size || bytes.includes(0)) return null;
  return bytes;
}

function tryCommittedFile(root: string, revision: string, path: string): Buffer | null {
  try {
    return committedFile(root, revision, path);
  } catch {
    return null;
  }
}

function confidence(ratio: number, sampleCount: number, floor = 0.6): number {
  const boundedRatio = Math.max(0, Math.min(1, ratio));
  const sampleFactor = Math.min(1, sampleCount / 30);
  return Number(Math.max(floor, boundedRatio * (0.75 + 0.25 * sampleFactor)).toFixed(3));
}

function traitId(category: ProjectDnaCategory, key: string, claim: string): string {
  return `pdnat_${sha256(canonical({ category, key, claim })).slice("sha256:".length, "sha256:".length + 20)}`;
}

function makeTrait(
  category: ProjectDnaCategory,
  key: string,
  claim: string,
  confidenceValue: number,
  evidence: ProjectDnaEvidence[],
): ProjectDnaTrait {
  return {
    id: traitId(category, key, claim),
    category,
    key,
    claim,
    confidence: Number(Math.max(0, Math.min(1, confidenceValue)).toFixed(3)),
    observation_state: "observed",
    freshness: "current",
    contradiction: "none",
    evidence: [...evidence].sort((left, right) => compareCodeUnits(left.ref, right.ref)).slice(0, MAX_EVIDENCE),
  };
}

function historyEvidence(revision: string, subjects: string[]): ProjectDnaEvidence {
  return {
    kind: "git-history",
    ref: `git:subjects:${subjects.length}`,
    revision,
    content_hash: sha256(subjects.join("\0")),
    sample_count: subjects.length,
    provenance: "committed-repository",
    visibility: "repository",
  };
}

function fileEvidence(revision: string, path: string, bytes: Buffer): ProjectDnaEvidence {
  return {
    kind: "committed-file",
    ref: path,
    revision,
    content_hash: sha256(bytes),
    sample_count: 1,
    provenance: "committed-repository",
    visibility: "repository",
  };
}

function hostEvidenceEvidence(
  revision: string,
  hostEvidence: ProjectDnaHostEvidence,
  sampleCount: number,
): ProjectDnaEvidence {
  return {
    kind: "host-evidence",
    ref: `host:${hostEvidence.evidence_set_id}`,
    revision,
    content_hash: hostEvidence.content_hash,
    sample_count: sampleCount,
    provenance: "host-provided",
    visibility: "repository",
  };
}

function repositoryId(root: string, revision: string): string {
  const roots = gitText(root, ["rev-list", "--max-parents=0", revision, "--"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort(compareCodeUnits);
  if (!roots.length || roots.some((value) => !GIT_OBJECT.test(value))) {
    throw new Error("Git did not return a stable repository lineage identity");
  }
  return `pdnar_${sha256(canonical({ roots })).slice("sha256:".length, "sha256:".length + 24)}`;
}

function firstAlphabetic(value: string): string | null {
  const match = value.match(/[A-Za-z]/);
  return match?.[0] ?? null;
}

function conventionalSubject(subject: string): boolean {
  return /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)\r\n]{1,80}\))?!?:\s\S/.test(subject);
}

function collectHistoryTraits(revision: string, subjects: string[]): ProjectDnaTrait[] {
  if (subjects.length < MIN_HISTORY) return [];
  const evidence = [historyEvidence(revision, subjects)];
  const traits: ProjectDnaTrait[] = [];
  const count = subjects.length;
  const conventional = subjects.filter(conventionalSubject).length;
  const noTerminalPeriod = subjects.filter((subject) => !/[.!?]$/.test(subject.trim())).length;
  const lowercase = subjects.filter((subject) => {
    const first = firstAlphabetic(subject.replace(/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s*/, ""));
    return first !== null && first === first.toLowerCase();
  }).length;
  const issueRefs = subjects.filter((subject) => /(?:^|\s)#\d+\b/.test(subject)).length;

  if (conventional / count >= 0.7) {
    traits.push(makeTrait("communication", "commit.conventional", "Commit subjects usually use Conventional Commit prefixes.", confidence(conventional / count, count), evidence));
  }
  if (noTerminalPeriod / count >= 0.8) {
    traits.push(makeTrait("communication", "subject.no_terminal_punctuation", "Change titles usually omit terminal punctuation.", confidence(noTerminalPeriod / count, count), evidence));
  }
  if (lowercase / count >= 0.7) {
    traits.push(makeTrait("communication", "subject.lowercase_lead", "Change titles usually begin their descriptive phrase with lowercase wording.", confidence(lowercase / count, count), evidence));
  }
  if (issueRefs / count >= 0.45) {
    traits.push(makeTrait("communication", "subject.issue_reference", "Change titles frequently reference a GitHub issue number.", confidence(issueRefs / count, count), evidence));
  }

  const words = new Map<string, number>();
  for (const subject of subjects) {
    const normalized = subject
      .replace(/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s*/, "")
      .toLowerCase();
    for (const token of normalized.match(/[a-z][a-z0-9_-]{2,30}/g) ?? []) {
      if (STOP_WORDS.has(token) || /^\d+$/.test(token)) continue;
      words.set(token, (words.get(token) ?? 0) + 1);
    }
  }
  const vocabulary = [...words.entries()]
    .filter(([, occurrences]) => occurrences >= Math.max(3, Math.ceil(count * 0.08)))
    .sort((left, right) => right[1] - left[1] || compareCodeUnits(left[0], right[0]))
    .slice(0, 8);
  for (const [word, occurrences] of vocabulary) {
    traits.push(makeTrait(
      "vocabulary",
      `term.${word}`,
      `The repository repeatedly uses the term “${word}” in change titles.`,
      confidence(occurrences / count, count, 0.55),
      evidence,
    ));
  }
  return traits;
}

interface FileRule {
  category: ProjectDnaCategory;
  key: string;
  claim: string;
  pattern: RegExp;
}

const FILE_RULES: readonly FileRule[] = [
  {
    category: "review",
    key: "review.tests_expected",
    claim: "Contributions are expected to include or update tests when behavior changes.",
    pattern: /(?:must|required|please|should|ensure|include|add|write)[^\n.]{0,80}\btests?\b|\btests?\b[^\n.]{0,80}(?:must|required|should|expected)/i,
  },
  {
    category: "review",
    key: "review.focused_changes",
    claim: "Contributions are expected to stay focused and avoid unrelated changes.",
    pattern: /\b(?:small|focused|narrow|scoped)\b[^\n.]{0,60}\b(?:pull request|pr|change|commit)s?\b|\b(?:unrelated|drive-by)\b[^\n.]{0,60}\b(?:change|cleanup|refactor)s?\b/i,
  },
  {
    category: "culture",
    key: "culture.backward_compatibility",
    claim: "Backward compatibility is an explicit project concern.",
    pattern: /\bbackward(?:s)?[- ]compatib|\bbreaking change\b|\bpublic api\b[^\n.]{0,60}\bcompatib/i,
  },
  {
    category: "engineering",
    key: "engineering.documentation_expected",
    claim: "User-visible or public-facing changes are expected to update documentation.",
    pattern: /(?:must|required|please|should|ensure|include|update)[^\n.]{0,80}\b(?:docs?|documentation|readme|changelog)\b/i,
  },
  {
    category: "communication",
    key: "pr.explain_why",
    claim: "Pull requests are expected to explain motivation or rationale, not only the code change.",
    pattern: /\b(?:why|motivation|rationale|reason)\b[^\n]{0,100}\b(?:change|pull request|pr|solution|approach)\b|\bwhat and why\b/i,
  },
];

function collectFileTraits(revision: string, files: Array<{ path: string; bytes: Buffer }>): ProjectDnaTrait[] {
  const byKey = new Map<string, { rule: FileRule; evidence: ProjectDnaEvidence[] }>();
  for (const file of files) {
    const text = file.bytes.toString("utf8");
    for (const rule of FILE_RULES) {
      if (!rule.pattern.test(text)) continue;
      const entry = byKey.get(rule.key) ?? { rule, evidence: [] };
      entry.evidence.push(fileEvidence(revision, file.path, file.bytes));
      byKey.set(rule.key, entry);
    }
  }
  return [...byKey.values()].map(({ rule, evidence }) => makeTrait(
    rule.category,
    rule.key,
    rule.claim,
    Math.min(0.98, 0.8 + Math.min(3, evidence.length) * 0.05),
    evidence,
  ));
}

function collectHostEvidenceTraits(
  revision: string,
  hostEvidence: ProjectDnaHostEvidence | undefined,
): ProjectDnaTrait[] {
  if (!hostEvidence) return [];
  assertProjectDnaHostEvidence(hostEvidence);
  if (hostEvidence.repository_revision !== revision) {
    throw new Error("Project DNA host evidence revision does not match the repository revision");
  }

  const traits: ProjectDnaTrait[] = [];
  const pullRequests = hostEvidence.items.filter((item) => item.kind === "pull_request" && item.disposition === "merged");
  if (pullRequests.length >= MIN_HISTORY) {
    const titles = pullRequests.map((item) => item.title!);
    const evidence = [hostEvidenceEvidence(revision, hostEvidence, pullRequests.length)];
    const count = titles.length;
    const conventional = titles.filter(conventionalSubject).length;
    const noTerminalPeriod = titles.filter((title) => !/[.!?]$/.test(title.trim())).length;
    const lowercase = titles.filter((title) => {
      const first = firstAlphabetic(title.replace(/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s*/, ""));
      return first !== null && first === first.toLowerCase();
    }).length;
    const issueRefs = titles.filter((title) => /(?:^|\s)#\d+\b/.test(title)).length;

    if (conventional / count >= 0.7) {
      traits.push(makeTrait("communication", "pull_request.conventional_title", "Pull-request titles usually use Conventional Commit prefixes.", confidence(conventional / count, count), evidence));
    }
    if (noTerminalPeriod / count >= 0.8) {
      traits.push(makeTrait("communication", "pull_request.no_terminal_punctuation", "Pull-request titles usually omit terminal punctuation.", confidence(noTerminalPeriod / count, count), evidence));
    }
    if (lowercase / count >= 0.7) {
      traits.push(makeTrait("communication", "pull_request.lowercase_lead", "Pull-request titles usually begin their descriptive phrase with lowercase wording.", confidence(lowercase / count, count), evidence));
    }
    if (issueRefs / count >= 0.45) {
      traits.push(makeTrait("communication", "pull_request.issue_reference", "Pull-request titles frequently reference an issue number.", confidence(issueRefs / count, count), evidence));
    }

    const words = new Map<string, number>();
    for (const title of titles) {
      const seen = new Set((title
        .replace(/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s*/, "")
        .toLowerCase()
        .match(/[a-z][a-z0-9_-]{2,30}/g) ?? [])
        .filter((token) => !STOP_WORDS.has(token) && !/^\d+$/.test(token)));
      for (const token of seen) words.set(token, (words.get(token) ?? 0) + 1);
    }
    const vocabulary = [...words.entries()]
      .filter(([, occurrences]) => occurrences >= Math.max(3, Math.ceil(count * 0.2)))
      .sort((left, right) => right[1] - left[1] || compareCodeUnits(left[0], right[0]))
      .slice(0, 8);
    for (const [word, occurrences] of vocabulary) {
      traits.push(makeTrait(
        "vocabulary",
        `term.${word}`,
        `The repository repeatedly uses the term “${word}” in merged pull-request titles.`,
        confidence(occurrences / count, count, 0.55),
        evidence,
      ));
    }

    const bodies = pullRequests.map((item) => item.body).filter((body): body is string => body !== null);
    const rationaleCount = bodies.filter((body) => FILE_RULES.find((rule) => rule.key === "pr.explain_why")!.pattern.test(body)).length;
    if (rationaleCount >= 2 && rationaleCount / Math.max(1, bodies.length) >= 0.6) {
      traits.push(makeTrait(
        "communication",
        "pr.explain_why",
        "Pull requests are expected to explain motivation or rationale, not only the code change.",
        confidence(rationaleCount / bodies.length, bodies.length),
        [hostEvidenceEvidence(revision, hostEvidence, rationaleCount)],
      ));
    }
  }

  const maintainerReviews = hostEvidence.items.filter((item) =>
    item.kind === "review_comment" && item.author_role === "maintainer");
  for (const rule of FILE_RULES) {
    const matching = maintainerReviews.filter((item) => rule.pattern.test(item.body!));
    if (matching.length < 2) continue;
    traits.push(makeTrait(
      rule.category,
      rule.key,
      rule.claim,
      confidence(matching.length / maintainerReviews.length, matching.length, 0.65),
      [hostEvidenceEvidence(revision, hostEvidence, matching.length)],
    ));
  }
  return traits;
}

function dedupeTraits(traits: ProjectDnaTrait[]): ProjectDnaTrait[] {
  const byKey = new Map<string, ProjectDnaTrait>();
  for (const trait of traits) {
    const existing = byKey.get(trait.key);
    if (!existing || trait.confidence > existing.confidence) byKey.set(trait.key, trait);
  }
  return [...byKey.values()]
    .sort((left, right) => compareCodeUnits(`${left.category}\0${left.key}`, `${right.category}\0${right.key}`))
    .slice(0, MAX_TRAITS);
}

/**
 * Derive a deterministic repository DNA profile from one exact Git revision.
 *
 * This is intentionally observation, not authority: it reads bounded committed
 * history and bounded committed convention files. A host may additionally pass a
 * sealed, revision-bound evidence batch that it already authorized; discovery
 * never fetches a provider itself. It does not read the worktree, network, model
 * output, credentials, or private user state, and it never writes into the durable
 * Hunch graph by itself.
 */
export function discoverProjectDna(
  root: string,
  ref = "HEAD",
  options: ProjectDnaDiscoveryOptions = {},
): ProjectDnaProfile {
  const repositoryRevision = exactCommit(root, ref);
  const repositoryIdentity = repositoryId(root, repositoryRevision);
  const historyRaw = gitText(root, [
    "log", repositoryRevision, "--no-merges", `--max-count=${MAX_HISTORY}`, "--format=%s", "--",
  ]);
  const subjects = historyRaw ? historyRaw.split("\n").map((value) => value.trim()).filter(Boolean) : [];
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const path of SOURCE_FILES) {
    const bytes = tryCommittedFile(root, repositoryRevision, path);
    if (bytes) files.push({ path, bytes });
  }

  const traits = dedupeTraits([
    ...collectHistoryTraits(repositoryRevision, subjects),
    ...collectFileTraits(repositoryRevision, files),
    ...collectHostEvidenceTraits(repositoryRevision, options.hostEvidence),
  ]);
  const unsigned = {
    schema: PROJECT_DNA_SCHEMA_VERSION,
    repository_id: repositoryIdentity,
    repository_revision: repositoryRevision,
    history_sample_count: subjects.length,
    source_files: files.map((file) => file.path).sort(compareCodeUnits),
    traits,
  } as const;
  const profileId = `pdna_${sha256(canonical(unsigned)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...unsigned, profile_id: profileId };
  const profile: ProjectDnaProfile = { ...sealed, content_hash: sha256(canonical(sealed)) };
  assertProjectDnaProfile(profile);
  return profile;
}

function expectedTraitFields(): string[] {
  return ["id", "category", "key", "claim", "confidence", "observation_state", "freshness", "contradiction", "evidence"].sort(compareCodeUnits);
}

function assertExactFields(value: Record<string, unknown>, fields: string[], label: string): void {
  if (Object.keys(value).sort(compareCodeUnits).join("\0") !== [...fields].sort(compareCodeUnits).join("\0")) {
    throw new Error(`${label} fields are invalid`);
  }
}

export function assertProjectDnaProfile(value: unknown): asserts value is ProjectDnaProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project DNA profile is invalid");
  const profile = value as ProjectDnaProfile;
  assertExactFields(value as Record<string, unknown>, [
    "schema", "profile_id", "repository_id", "repository_revision", "history_sample_count", "source_files", "traits", "content_hash",
  ], "project DNA profile");
  if (profile.schema !== PROJECT_DNA_SCHEMA_VERSION || !PROFILE_ID.test(profile.profile_id)
    || !REPOSITORY_ID.test(profile.repository_id) || !GIT_OBJECT.test(profile.repository_revision) || !Number.isSafeInteger(profile.history_sample_count)
    || profile.history_sample_count < 0 || profile.history_sample_count > MAX_HISTORY
    || !Array.isArray(profile.source_files) || profile.source_files.length > SOURCE_FILES.length
    || profile.source_files.some((path) => typeof path !== "string" || !SOURCE_FILES.includes(path as (typeof SOURCE_FILES)[number]))
    || [...profile.source_files].sort(compareCodeUnits).join("\0") !== profile.source_files.join("\0")
    || !Array.isArray(profile.traits) || profile.traits.length > MAX_TRAITS || !SHA256.test(profile.content_hash)) {
    throw new Error("project DNA profile fields are invalid");
  }
  const seen = new Set<string>();
  for (const trait of profile.traits) {
    if (!trait || typeof trait !== "object" || Array.isArray(trait)) throw new Error("project DNA trait is invalid");
    assertExactFields(trait as unknown as Record<string, unknown>, expectedTraitFields(), "project DNA trait");
    if (!/^pdnat_[a-f0-9]{20}$/.test(trait.id) || !PROJECT_DNA_CATEGORIES.includes(trait.category)
      || !/^[a-z][a-z0-9_.-]{2,100}$/.test(trait.key) || !trait.claim.trim() || trait.claim.length > 500
      || !Number.isFinite(trait.confidence) || trait.confidence < 0 || trait.confidence > 1
      || trait.observation_state !== "observed" || trait.freshness !== "current" || trait.contradiction !== "none"
      || !Array.isArray(trait.evidence) || trait.evidence.length < 1 || trait.evidence.length > MAX_EVIDENCE
      || seen.has(trait.key)) {
      throw new Error("project DNA trait fields are invalid");
    }
    seen.add(trait.key);
    if (trait.id !== traitId(trait.category, trait.key, trait.claim)) throw new Error("project DNA trait identity is invalid");
    for (const evidence of trait.evidence) {
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("project DNA evidence is invalid");
      assertExactFields(evidence as unknown as Record<string, unknown>, [
        "kind", "ref", "revision", "content_hash", "sample_count", "provenance", "visibility",
      ], "project DNA evidence");
      const committedEvidence = evidence.kind === "git-history" || evidence.kind === "committed-file";
      const hostEvidence = evidence.kind === "host-evidence";
      if ((!committedEvidence && !hostEvidence) || !evidence.ref.trim() || evidence.ref.length > 512
        || evidence.revision !== profile.repository_revision || !SHA256.test(evidence.content_hash)
        || !Number.isSafeInteger(evidence.sample_count) || evidence.sample_count < 1 || evidence.sample_count > MAX_HISTORY
        || (committedEvidence && evidence.provenance !== "committed-repository")
        || (hostEvidence && (evidence.provenance !== "host-provided" || !/^host:pdnah_[a-f0-9]{24}$/.test(evidence.ref)))
        || evidence.visibility !== "repository") {
        throw new Error("project DNA evidence fields are invalid");
      }
    }
  }
  const { content_hash: _contentHash, profile_id: _profileId, ...base } = profile;
  const expectedProfileId = `pdna_${sha256(canonical(base)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...base, profile_id: profile.profile_id };
  if (profile.profile_id !== expectedProfileId || profile.content_hash !== sha256(canonical(sealed))) {
    throw new Error("project DNA profile seal is invalid");
  }
}

function artifactCheck(trait: ProjectDnaTrait, artifact: ProjectDnaArtifact): ProjectDnaMatchCheck {
  const title = artifact.title.trim();
  const first = firstAlphabetic(title.replace(/^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s*/, ""));
  const weight = Math.max(1, Math.round(trait.confidence * 100));
  switch (trait.key) {
    case "commit.conventional":
      return artifact.kind === "commit"
        ? { trait_id: trait.id, key: trait.key, applicable: true, passed: conventionalSubject(title), weight, detail: "Commit subject follows the repository's observed Conventional Commit pattern." }
        : { trait_id: trait.id, key: trait.key, applicable: false, passed: null, weight, detail: "This trait applies only to commit subjects." };
    case "subject.no_terminal_punctuation":
      return { trait_id: trait.id, key: trait.key, applicable: true, passed: !/[.!?]$/.test(title), weight, detail: "Title omits terminal punctuation." };
    case "subject.lowercase_lead":
      return { trait_id: trait.id, key: trait.key, applicable: first !== null, passed: first === null ? null : first === first.toLowerCase(), weight, detail: "Descriptive title wording begins lowercase." };
    case "subject.issue_reference":
      return { trait_id: trait.id, key: trait.key, applicable: true, passed: /(?:^|\s)#\d+\b/.test(title), weight, detail: "Title carries an issue reference." };
    case "pull_request.conventional_title":
      return artifact.kind === "pull_request"
        ? { trait_id: trait.id, key: trait.key, applicable: true, passed: conventionalSubject(title), weight, detail: "PR title follows the repository's observed Conventional Commit pattern." }
        : { trait_id: trait.id, key: trait.key, applicable: false, passed: null, weight, detail: "This trait applies only to pull-request titles." };
    case "pull_request.no_terminal_punctuation":
      return artifact.kind === "pull_request"
        ? { trait_id: trait.id, key: trait.key, applicable: true, passed: !/[.!?]$/.test(title), weight, detail: "PR title omits terminal punctuation." }
        : { trait_id: trait.id, key: trait.key, applicable: false, passed: null, weight, detail: "This trait applies only to pull-request titles." };
    case "pull_request.lowercase_lead":
      return artifact.kind === "pull_request"
        ? { trait_id: trait.id, key: trait.key, applicable: first !== null, passed: first === null ? null : first === first.toLowerCase(), weight, detail: "Descriptive PR-title wording begins lowercase." }
        : { trait_id: trait.id, key: trait.key, applicable: false, passed: null, weight, detail: "This trait applies only to pull-request titles." };
    case "pull_request.issue_reference":
      return artifact.kind === "pull_request"
        ? { trait_id: trait.id, key: trait.key, applicable: true, passed: /(?:^|\s)#\d+\b/.test(title), weight, detail: "PR title carries an issue reference." }
        : { trait_id: trait.id, key: trait.key, applicable: false, passed: null, weight, detail: "This trait applies only to pull-request titles." };
    case "pr.explain_why": {
      const body = artifact.body?.trim() ?? "";
      const applicable = artifact.kind === "pull_request";
      const passed = applicable ? /\b(?:why|because|motivation|rationale|reason)\b/i.test(body) : null;
      return { trait_id: trait.id, key: trait.key, applicable, passed, weight, detail: "PR body contains an explicit rationale signal." };
    }
    default:
      return { trait_id: trait.id, key: trait.key, applicable: false, passed: null, weight, detail: "Trait is orientation-only and has no deterministic artifact check yet." };
  }
}

/** Score only traits that have a deterministic check for the supplied artifact. */
export function evaluateProjectDnaMatch(profileValue: unknown, artifact: ProjectDnaArtifact): ProjectDnaMatch {
  assertProjectDnaProfile(profileValue);
  const profile = profileValue;
  if (!artifact || !(["commit", "pull_request", "issue", "message"] as const).includes(artifact.kind)
    || typeof artifact.title !== "string" || artifact.title.length < 1 || artifact.title.length > 1_000
    || (artifact.body !== undefined && (typeof artifact.body !== "string" || artifact.body.length > 20_000))) {
    throw new Error("project DNA artifact is invalid");
  }
  const checks = profile.traits.map((trait) => artifactCheck(trait, artifact));
  const applicable = checks.filter((check) => check.applicable && check.passed !== null);
  const totalWeight = applicable.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = applicable.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
  const score = totalWeight > 0 ? Number(((passedWeight / totalWeight) * 100).toFixed(1)) : null;
  const unsigned = {
    schema: PROJECT_DNA_MATCH_SCHEMA_VERSION,
    profile_id: profile.profile_id,
    repository_id: profile.repository_id,
    repository_revision: profile.repository_revision,
    artifact_kind: artifact.kind,
    score,
    applicable_checks: applicable.length,
    checks,
  } as const;
  // The identity is derived from the public envelope, rather than from artifact
  // bytes that are deliberately not retained. That makes a received match fully
  // self-validating without storing PR/issue bodies in Hunch.
  const matchId = `pdnam_${sha256(canonical(unsigned)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...unsigned, match_id: matchId };
  return { ...sealed, content_hash: sha256(canonical(sealed)) };
}

export function assertProjectDnaMatch(value: unknown): asserts value is ProjectDnaMatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project DNA match is invalid");
  const match = value as ProjectDnaMatch;
  assertExactFields(value as Record<string, unknown>, [
    "schema", "match_id", "profile_id", "repository_id", "repository_revision", "artifact_kind", "score", "applicable_checks", "checks", "content_hash",
  ], "project DNA match");
  if (match.schema !== PROJECT_DNA_MATCH_SCHEMA_VERSION || !MATCH_ID.test(match.match_id) || !PROFILE_ID.test(match.profile_id)
    || !REPOSITORY_ID.test(match.repository_id) || !GIT_OBJECT.test(match.repository_revision)
    || !(["commit", "pull_request", "issue", "message"] as const).includes(match.artifact_kind)
    || (match.score !== null && (!Number.isFinite(match.score) || match.score < 0 || match.score > 100))
    || !Number.isSafeInteger(match.applicable_checks) || match.applicable_checks < 0
    || !Array.isArray(match.checks) || match.applicable_checks > match.checks.length || !SHA256.test(match.content_hash)) {
    throw new Error("project DNA match fields are invalid");
  }
  const traitIds = new Set<string>();
  for (const check of match.checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("project DNA match check is invalid");
    assertExactFields(check as unknown as Record<string, unknown>, [
      "trait_id", "key", "applicable", "passed", "weight", "detail",
    ], "project DNA match check");
    if (!/^pdnat_[a-f0-9]{20}$/.test(check.trait_id) || traitIds.has(check.trait_id)
      || !/^[a-z][a-z0-9_.-]{2,100}$/.test(check.key)
      || typeof check.applicable !== "boolean"
      || !(check.passed === true || check.passed === false || check.passed === null)
      || (check.applicable ? check.passed === null : check.passed !== null)
      || !Number.isSafeInteger(check.weight) || check.weight < 1 || check.weight > 100
      || typeof check.detail !== "string" || !check.detail.trim() || check.detail.length > 500) {
      throw new Error("project DNA match check fields are invalid");
    }
    traitIds.add(check.trait_id);
  }
  const applicable = match.checks.filter((check) => check.applicable).length;
  if (applicable !== match.applicable_checks) throw new Error("project DNA match applicable count is invalid");
  const { content_hash: _contentHash, match_id: _matchId, ...base } = match;
  const expectedMatchId = `pdnam_${sha256(canonical(base)).slice("sha256:".length, "sha256:".length + 24)}`;
  const unsigned = { ...base, match_id: match.match_id };
  if (match.match_id !== expectedMatchId) throw new Error("project DNA match identity is invalid");
  if (match.content_hash !== sha256(canonical(unsigned))) throw new Error("project DNA match seal is invalid");
}
