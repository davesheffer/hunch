import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalHash } from "./canonical.js";

export type BehaviorWorkspaceKind = "staged" | "working";

export interface BehaviorWorkspaceMetadata {
  kind: BehaviorWorkspaceKind;
  base_commit: string;
  snapshot_hash: string;
  files: string[];
}

interface UntrackedFile {
  file: string;
  content_hash: string;
  mode: number;
  content: Buffer;
}

export interface BehaviorWorkspaceSnapshot {
  metadata: BehaviorWorkspaceMetadata;
  patch: Buffer;
  untracked: UntrackedFile[];
}

export class BehaviorWorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;
const WORKSPACE_PATHS = [".", ":(exclude).hunch/**", ":(exclude).hunch-cache/**"];

function bufferSha1(value: Buffer): string {
  return `sha1:${createHash("sha1").update(value).digest("hex")}`;
}

function git(root: string, args: string[], env: NodeJS.ProcessEnv, maxBuffer = MAX_PATCH_BYTES): Buffer {
  const run = spawnSync("git", ["-C", root, ...args], {
    env,
    encoding: "buffer",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code === "ENOBUFS" ? "workspace-snapshot-too-large" : "workspace-git-failed";
    throw new BehaviorWorkspaceError(code, `workspace Git command failed: ${args[0]}`);
  }
  if (run.status !== 0) throw new BehaviorWorkspaceError("workspace-git-failed", `workspace Git command exited ${run.status}: ${args[0]}`);
  return run.stdout ?? Buffer.alloc(0);
}

function safeRelative(root: string, file: string): string {
  if (!file || file.includes("\0") || file.includes("\\") || isAbsolute(file)) {
    throw new BehaviorWorkspaceError("workspace-path-unsafe", "workspace contains an unsafe path");
  }
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new BehaviorWorkspaceError("workspace-path-unsafe", "workspace contains an unsafe path");
  }
  const absolute = resolve(root, file);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new BehaviorWorkspaceError("workspace-path-unsafe", "workspace path escapes the repository");
  }
  return file;
}

function nulList(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function captureBehaviorWorkspace(
  root: string,
  baseCommit: string,
  kind: BehaviorWorkspaceKind,
  env: NodeJS.ProcessEnv,
): BehaviorWorkspaceSnapshot {
  const diffArgs = ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (kind === "staged") diffArgs.push("--cached");
  diffArgs.push(baseCommit, "--", ...WORKSPACE_PATHS);
  const patch = git(root, diffArgs, env);
  const changedArgs = ["diff", "--name-only", "-z", "--diff-filter=ACMRD"];
  if (kind === "staged") changedArgs.push("--cached");
  changedArgs.push(baseCommit, "--", ...WORKSPACE_PATHS);
  const changed = nulList(git(root, changedArgs, env)).map((file) => safeRelative(root, file));
  const untrackedNames = kind === "working"
    ? nulList(git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...WORKSPACE_PATHS], env))
    : [];
  if (untrackedNames.length > MAX_UNTRACKED_FILES) {
    throw new BehaviorWorkspaceError("workspace-snapshot-too-large", `workspace has more than ${MAX_UNTRACKED_FILES} untracked files`);
  }
  let untrackedBytes = 0;
  const untracked = untrackedNames.map((raw): UntrackedFile => {
    const file = safeRelative(root, raw);
    const absolute = resolve(root, file);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new BehaviorWorkspaceError("workspace-file-unsupported", `workspace untracked path is not a regular file: ${file}`);
    }
    untrackedBytes += stat.size;
    if (untrackedBytes > MAX_UNTRACKED_BYTES) {
      throw new BehaviorWorkspaceError("workspace-snapshot-too-large", "workspace untracked content exceeds the 8 MiB limit");
    }
    const content = readFileSync(absolute);
    return { file, content_hash: bufferSha1(content), mode: stat.mode & 0o777, content };
  });
  const files = [...new Set([...changed, ...untracked.map((entry) => entry.file)])].sort();
  if (files.length > 10_000) {
    throw new BehaviorWorkspaceError("workspace-snapshot-too-large", "workspace has more than 10000 changed files");
  }
  const snapshotHash = canonicalHash({
    kind,
    base_commit: baseCommit,
    patch_hash: bufferSha1(patch),
    untracked: untracked.map(({ content: _content, ...entry }) => entry),
  });
  return {
    metadata: { kind, base_commit: baseCommit, snapshot_hash: snapshotHash, files },
    patch,
    untracked,
  };
}

export function applyBehaviorWorkspace(
  root: string,
  checkout: string,
  snapshot: BehaviorWorkspaceSnapshot,
  env: NodeJS.ProcessEnv,
): void {
  if (snapshot.patch.length) {
    const apply = spawnSync("git", ["-C", checkout, "apply", "--binary", "--whitespace=nowarn"], {
      env,
      input: snapshot.patch,
      encoding: "buffer",
      maxBuffer: MAX_PATCH_BYTES,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    if (apply.error || apply.status !== 0) {
      throw new BehaviorWorkspaceError("workspace-patch-apply-failed", "workspace patch could not be applied to the disposable checkout");
    }
  }
  for (const entry of snapshot.untracked) {
    const file = safeRelative(root, entry.file);
    const destination = resolve(checkout, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.content);
    chmodSync(destination, entry.mode);
  }
}
