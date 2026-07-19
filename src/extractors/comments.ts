/**
 * Inline intent capture (roadmap addendum #2). A developer marks intent right where
 * it lives in the code — `hunch-why: <reason>` (in a comment → a Decision) or
 * `hunch-rule: <invariant>` (→ a file-scoped Constraint) — and Hunch lifts it into
 * the graph, deterministically. The third capture source alongside commit synthesis and
 * correction capture. The tag must follow a comment marker (the slash pair, #, *, --,
 * <!--, ;) so a matching STRING literal in code isn't mistaken for intent. (Line-based,
 * so a tagged line that is itself a string literal can still false-positive — advisory.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toPosixTarget } from "../core/paths.js";
import { discoverSourceFiles, type SourceDiscoveryResult } from "./sourceFiles.js";

const EXTS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rb", ".java", ".rs", ".php", ".cs", ".kt", ".swift", ".scala",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".sql", ".sh",
];
const SKIP = new Set(["node_modules", ".git", ".hunch", ".hunch-private", "dist", "build", "out", "vendor", ".next"]);
const TAG = /(?:\/\/|#|\*|--|<!--|;)\s*hunch-(why|rule)\s*:\s*(.+?)\s*(?:\*\/|-->|$)/i;

export interface InlineIntent {
  kind: "why" | "rule";
  text: string;
  file: string; // repo-relative POSIX path
  line: number;
}

/** Tracked source files (git ls-files); falls back to a bounded walk outside git. */
function sourceFiles(root: string): SourceDiscoveryResult {
  return discoverSourceFiles(root, {
    extensions: EXTS,
    skipDirs: SKIP,
    walkMaxDepth: 8,
    skipHiddenDirs: true,
  });
}

export interface InlineIntentScanResult {
  intents: InlineIntent[];
  discovery: SourceDiscoveryResult;
}

export function scanInlineIntent(root: string): InlineIntentScanResult {
  const discovery = sourceFiles(root);
  const out: InlineIntent[] = [];
  for (const rel of discovery.files) {
    let content: string;
    try {
      content = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (!content.includes("hunch-")) continue; // cheap skip before the per-line scan
    const file = toPosixTarget(rel);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = TAG.exec(lines[i]!);
      if (m) out.push({ kind: m[1]!.toLowerCase() as "why" | "rule", text: m[2]!.trim(), file, line: i + 1 });
    }
  }
  return { intents: out, discovery };
}

/** Backward-compatible convenience wrapper for callers that only need captures. */
export function extractInlineIntent(root: string): InlineIntent[] {
  return scanInlineIntent(root).intents;
}
