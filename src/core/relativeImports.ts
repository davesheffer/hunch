import { dirname, join, posix } from "node:path";

function toPosix(path: string): string {
  return path.split(/[\\/]/).join(posix.sep);
}

/** Candidate source files for one static relative JS/TS import, in the same
 * deterministic precedence order used by the indexer. Bare packages, URLs,
 * absolute paths, and import-map aliases are deliberately unsupported. */
export function relativeImportCandidates(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith(".") || specifier.includes("\0")) return [];
  const base = toPosix(join(dirname(fromFile), specifier));
  return [...new Set([
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.jsx$/, ".tsx"),
    base + ".ts",
    base + ".tsx",
    base,
    base + ".js",
    toPosix(join(base, "index.ts")),
    toPosix(join(base, "index.tsx")),
    toPosix(join(base, "index.js")),
  ])];
}

/** Resolve against an exact file set. The first candidate preserves existing
 * indexer compatibility; callers that need ambiguity metadata can inspect the
 * returned matches instead of guessing a different target. */
export function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  availableFiles: Iterable<string>,
): { path: string | null; matches: string[] } {
  // Bare/non-relative specifiers have no candidates: skip the O(N) file-set copy.
  const candidates = relativeImportCandidates(fromFile, specifier);
  if (candidates.length === 0) return { path: null, matches: [] };
  const available: ReadonlySet<string> = availableFiles instanceof Set ? availableFiles : new Set(availableFiles);
  const matches = candidates.filter((candidate) => available.has(candidate));
  return { path: matches[0] ?? null, matches };
}
