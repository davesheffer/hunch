/**
 * Deterministic source-file discovery shared by code-analysis extractors.
 *
 * Git-tracked files are preferred so ignored and untracked build artifacts do not
 * enter the graph. A bounded recursive walk keeps the scanner useful for new or
 * non-Git repositories. This layer only discovers files; parsing and any AI-assisted
 * interpretation happen after discovery so traversal stays cheap and reproducible.
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isGitRepo, trackedFilesStrict } from "./git.js";

export type SourceDiscoveryStrategy = "git" | "filesystem";
export type SourceDiscoveryOperation = "git-list" | "read-directory";

export interface SourceDiscoveryDiagnostic {
  path: string;
  operation: SourceDiscoveryOperation;
  code: string;
  message: string;
}

export interface SourceDiscoveryResult {
  files: string[];
  strategy: SourceDiscoveryStrategy;
  complete: boolean;
  diagnostics: SourceDiscoveryDiagnostic[];
}

/** Injectable filesystem/Git seams keep failure behavior deterministic in tests. */
export interface SourceDiscoveryRuntime {
  readDirectory(dir: string): Dirent[];
  isGitRepository(root: string): boolean;
  listTrackedFiles(root: string, extensions: string[]): string[];
}

export interface SourceFileDiscoveryOptions {
  extensions: readonly string[];
  skipDirs?: ReadonlySet<string>;
  /** Maximum directory depth for the filesystem fallback. Root is depth 0. */
  walkMaxDepth?: number;
  /** Ignore dot-directories during the filesystem fallback. */
  skipHiddenDirs?: boolean;
  /** Prefer Git-tracked files when the root is a Git repository (default: true). */
  preferGit?: boolean;
}

const defaultRuntime: SourceDiscoveryRuntime = {
  readDirectory: (dir) => readdirSync(dir, { withFileTypes: true }),
  isGitRepository: isGitRepo,
  listTrackedFiles: trackedFilesStrict,
};

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";

export class IncompleteSourceDiscoveryError extends Error {
  constructor(readonly root: string, readonly result: SourceDiscoveryResult) {
    const summary = result.diagnostics
      .map((diagnostic) => `${diagnostic.operation}:${diagnostic.path}:${diagnostic.code}`)
      .join(", ");
    super(`Source discovery is incomplete for ${root}${summary ? ` (${summary})` : ""}`);
    this.name = "IncompleteSourceDiscoveryError";
  }
}

/** Return repository-relative POSIX paths plus explicit completeness diagnostics. */
export function discoverSourceFiles(
  root: string,
  options: SourceFileDiscoveryOptions,
  runtimeOverrides: Partial<SourceDiscoveryRuntime> = {},
): SourceDiscoveryResult {
  const runtime = { ...defaultRuntime, ...runtimeOverrides };
  const skipDirs = options.skipDirs ?? new Set<string>();
  const isSkippedPath = (file: string): boolean =>
    file.split(/[\\/]/).some((segment) => skipDirs.has(segment));
  const diagnostics: SourceDiscoveryDiagnostic[] = [];

  const maxDepth = options.walkMaxDepth ?? Number.POSITIVE_INFINITY;
  if (maxDepth !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    throw new RangeError("walkMaxDepth must be a non-negative integer or Infinity");
  }

  if (options.preferGit !== false) {
    try {
      // The marker preserves a visible failure when Git itself is unavailable:
      // isGitRepo() is intentionally fail-soft for its many advisory callers.
      if (existsSync(join(root, ".git")) || runtime.isGitRepository(root)) {
        const matched = runtime.listTrackedFiles(root, [...options.extensions]);
        const tracked = matched.filter((file) => !isSkippedPath(file)).sort();
        if (tracked.length > 0) {
          return {
            files: tracked,
            strategy: "git",
            complete: true,
            diagnostics,
          };
        }
      }
    } catch (error) {
      const code = errorCode(error);
      diagnostics.push({
        path: ".",
        operation: "git-list",
        code,
        message: `Git source discovery failed (${code})`,
      });
    }
  }

  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = runtime.readDirectory(dir)
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } catch (error) {
      const code = errorCode(error);
      const path = rel || ".";
      diagnostics.push({
        path,
        operation: "read-directory",
        code,
        message: `Could not read source directory ${path} (${code})`,
      });
      return;
    }

    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (options.skipHiddenDirs && entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile() && options.extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(childRel);
      }
    }
  };

  walk(root, "", 0);
  return {
    files: out,
    strategy: "filesystem",
    complete: diagnostics.length === 0,
    diagnostics,
  };
}
