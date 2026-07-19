/**
 * Inline intent capture (roadmap addendum #2). A developer marks intent right where
 * it lives in the code — `hunch-why: <reason>` (in a comment → a Decision) or
 * `hunch-rule: <invariant>` (→ a file-scoped Constraint) — and Hunch lifts it into
 * the graph, deterministically. The third capture source alongside commit synthesis and
 * correction capture. The tag must follow a comment marker (the slash pair, #, *, --,
 * <!--, ;) so a matching STRING literal in code isn't mistaken for intent. (Line-based,
 * so a tagged line that is itself a string literal can still false-positive — advisory.)
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { trackedFiles } from "./git.js";
import { toPosixTarget } from "../core/paths.js";
import { createRepoFileReader } from "../core/safeRepoFile.js";

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
function sourceFiles(root: string): string[] {
  const tracked = trackedFiles(root, EXTS);
  if (tracked.length) return tracked;
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) {
        out.push(r);
      }
    }
  };
  walk(root, "", 0);
  return out;
}

export function extractInlineIntent(root: string): InlineIntent[] {
  const out: InlineIntent[] = [];
  const readSourceFile = createRepoFileReader(root);
  for (const rel of sourceFiles(root)) {
    const content = readSourceFile(rel);
    if (content === null) continue;
    if (!content.includes("hunch-")) continue; // cheap skip before the per-line scan
    const file = toPosixTarget(rel);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = TAG.exec(lines[i]!);
      if (m) out.push({ kind: m[1]!.toLowerCase() as "why" | "rule", text: m[2]!.trim(), file, line: i + 1 });
    }
  }
  return out;
}
