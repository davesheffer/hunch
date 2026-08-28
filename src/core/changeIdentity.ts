/**
 * Commit-metadata-independent identity for one exact repository change.
 *
 * The identity hashes Git's raw tree delta (modes, paths and blob object IDs),
 * not a commit SHA or prose diff. A branch range and its squash commit therefore
 * share one change ID when they produce the same exact tree transition. Unlike
 * `git patch-id`, whitespace-only, binary and mode changes remain significant.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";

export const CHANGE_IDENTITY_SCHEMA_VERSION = "hunch.change-identity/1" as const;
export const CHANGE_IDENTITY_ALGORITHM = "git-raw-tree-delta-sha256/1" as const;

const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CHANGE_ID = /^hchg_[a-f0-9]{24}$/;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_CHANGED_FILES = 16_384;

export interface ChangeIdentity {
  schema: typeof CHANGE_IDENTITY_SCHEMA_VERSION;
  algorithm: typeof CHANGE_IDENTITY_ALGORITHM;
  change_id: string;
  base_revision: string;
  head_revision: string;
  base_tree: string;
  head_tree: string;
  delta_hash: string;
  /** Git's looser interoperability identifier; never the Hunch authority. */
  patch_id: string | null;
  file_count: number;
  paths_hash: string;
  content_hash: string;
}

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

function gitText(root: string, args: string[], input?: Buffer): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: gitEnvironment(),
      input,
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString("utf8").trim().replace(/[\r\n]+/g, " ");
    throw new Error(`could not derive exact Git change identity${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }
}

function gitBytes(root: string, args: string[]): Buffer {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "buffer",
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString("utf8").trim().replace(/[\r\n]+/g, " ");
    throw new Error(`could not derive exact Git change identity${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }
}

function exactCommit(root: string, ref: string): string {
  if (!ref.trim() || /[\0\r\n]/.test(ref) || ref.length > 1_024) throw new Error("Git revision is invalid");
  const revision = gitText(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!GIT_OBJECT.test(revision)) throw new Error("Git did not return an exact commit object");
  return revision;
}

function patchId(root: string, base: string, head: string): string | null {
  const diff = gitBytes(root, [
    "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
    base, head, "--",
  ]);
  const result = spawnSync("git", ["patch-id", "--stable"], {
    cwd: root,
    env: gitEnvironment(),
    input: diff,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("could not derive interoperable Git patch ID");
  const value = result.stdout.trim().split(/\s+/)[0] ?? "";
  if (!value) return null;
  if (!GIT_OBJECT.test(value)) throw new Error("Git returned an invalid patch ID");
  return value;
}

/** Derive one deterministic receipt from two commit-ish references. */
export function deriveChangeIdentity(root: string, baseRef: string, headRef = "HEAD"): ChangeIdentity {
  const baseRevision = exactCommit(root, baseRef);
  const headRevision = exactCommit(root, headRef);
  const baseTree = gitText(root, ["rev-parse", "--verify", `${baseRevision}^{tree}`]);
  const headTree = gitText(root, ["rev-parse", "--verify", `${headRevision}^{tree}`]);
  if (!GIT_OBJECT.test(baseTree) || !GIT_OBJECT.test(headTree)) throw new Error("Git tree identity is invalid");

  const rawDelta = gitBytes(root, [
    "diff-tree", "--no-commit-id", "--raw", "--full-index", "-r", "-z", "--no-renames",
    baseRevision, headRevision, "--",
  ]);
  if (rawDelta.byteLength === 0) throw new Error("exact Git change is empty");
  const rawPaths = gitBytes(root, ["diff", "--name-only", "-z", "--no-renames", baseRevision, headRevision, "--"]);
  const pathLengths: number[] = [];
  let start = 0;
  for (let index = 0; index < rawPaths.length; index++) {
    if (rawPaths[index] !== 0) continue;
    pathLengths.push(index - start);
    start = index + 1;
  }
  if (!rawPaths.length || rawPaths[rawPaths.length - 1] !== 0 || start !== rawPaths.length
    || !pathLengths.length || pathLengths.length > MAX_CHANGED_FILES
    || pathLengths.some((length) => length < 1 || length > 4_096)) {
    throw new Error("exact Git change has an invalid or unbounded file set");
  }

  const deltaHash = sha256(rawDelta);
  const changeSeed = canonical({ algorithm: CHANGE_IDENTITY_ALGORITHM, delta_hash: deltaHash });
  const changeId = `hchg_${sha256(changeSeed).slice("sha256:".length, "sha256:".length + 24)}`;
  const unsigned = {
    schema: CHANGE_IDENTITY_SCHEMA_VERSION,
    algorithm: CHANGE_IDENTITY_ALGORITHM,
    change_id: changeId,
    base_revision: baseRevision,
    head_revision: headRevision,
    base_tree: baseTree,
    head_tree: headTree,
    delta_hash: deltaHash,
    patch_id: patchId(root, baseRevision, headRevision),
    file_count: pathLengths.length,
    paths_hash: sha256(rawPaths),
  } as const;
  const identity: ChangeIdentity = { ...unsigned, content_hash: sha256(canonical(unsigned)) };
  assertChangeIdentity(identity);
  return identity;
}

/** Validate an identity without trusting any caller-supplied seal. */
export function assertChangeIdentity(value: unknown): asserts value is ChangeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("change identity is invalid");
  const identity = value as ChangeIdentity;
  const expectedFields = [
    "schema", "algorithm", "change_id", "base_revision", "head_revision", "base_tree", "head_tree",
    "delta_hash", "patch_id", "file_count", "paths_hash", "content_hash",
  ];
  if (Object.keys(value as Record<string, unknown>).sort(compareCodeUnits).join("\0") !== expectedFields.sort(compareCodeUnits).join("\0")
    || identity.schema !== CHANGE_IDENTITY_SCHEMA_VERSION || identity.algorithm !== CHANGE_IDENTITY_ALGORITHM
    || !CHANGE_ID.test(identity.change_id) || !GIT_OBJECT.test(identity.base_revision)
    || !GIT_OBJECT.test(identity.head_revision) || !GIT_OBJECT.test(identity.base_tree)
    || !GIT_OBJECT.test(identity.head_tree) || !SHA256.test(identity.delta_hash)
    || (identity.patch_id !== null && !GIT_OBJECT.test(identity.patch_id))
    || !Number.isSafeInteger(identity.file_count) || identity.file_count < 1 || identity.file_count > MAX_CHANGED_FILES
    || !SHA256.test(identity.paths_hash) || !SHA256.test(identity.content_hash)) {
    throw new Error("change identity fields are invalid");
  }
  const expectedChange = `hchg_${sha256(canonical({ algorithm: identity.algorithm, delta_hash: identity.delta_hash }))
    .slice("sha256:".length, "sha256:".length + 24)}`;
  const { content_hash: _contentHash, ...unsigned } = identity;
  if (identity.change_id !== expectedChange || identity.content_hash !== sha256(canonical(unsigned))) {
    throw new Error("change identity seal is invalid");
  }
}

export function changesAreEquivalent(left: unknown, right: unknown): boolean {
  assertChangeIdentity(left);
  assertChangeIdentity(right);
  return left.algorithm === right.algorithm
    && left.change_id === right.change_id
    && left.delta_hash === right.delta_hash;
}
