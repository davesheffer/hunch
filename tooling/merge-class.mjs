#!/usr/bin/env node
// Merge-class classifier for rung 2 of the development loop
// (docs/autonomous-development.md, "2 — auto-merge, bounded class").
//
// A PR may be auto-merged only when EVERY changed file falls inside the declared
// bounded class: documentation, tests, memory captures, generated locale copies
// and version-pin syncs. Anything else — source, workflows, package manifests,
// release tooling — is "outside" and needs rung 1 (a human merge). The class is
// a path allowlist, deterministic, with no model involved; a file the allowlist
// does not name is outside by construction, never assumed harmless.
//
// The workflow that consumes this is wired by a human (workflow edits are on the
// "never" rung). Usage:
//   node tooling/merge-class.mjs --base origin/main [--json] [--require-bounded]
// Exit 0 always unless --require-bounded is set, then 1 when the class is "outside".
import { execFileSync } from "node:child_process";
import process from "node:process";

/** Ordered allowlist. The first rule that matches a path names its group; a path
 *  matching no rule is outside. Rules are plain prefix / exact / suffix tests so
 *  the classification stays readable without a glob library. */
export const BOUNDED_CLASS = Object.freeze([
  { group: "docs", test: (p) => p.startsWith("docs/") && p.endsWith(".md") },
  { group: "docs", test: (p) => ["README.md", "CHANGELOG.md", "ROADMAP.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"].includes(p) },
  { group: "tests", test: (p) => p.startsWith("test/") && /\.(ts|mjs|js|json|txt|md)$/.test(p) },
  { group: "tests", test: (p) => p.startsWith("test/fixtures/") },
  // Memory captures: graph records the agent may land by itself (con_039cee7367).
  // Store configuration is excluded: it changes what the store IS, not what it holds.
  { group: "memory", test: (p) => p.startsWith(".hunch/") && !["config.json", "local.json", "team.json"].includes(p.slice(".hunch/".length)) && !p.startsWith(".hunch/pending-") },
  // Harness grounding blocks Hunch regenerates from the graph after a capture
  // (src/integrations/providers.ts); generated, never hand-edited.
  { group: "memory", test: (p) => GENERATED_GROUNDING.includes(p) },
  // Generated locale copies of docs/changelog/site text.
  { group: "locales", test: (p) => /^site\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(?:changelog|index|docs|cookbook)\.html$/.test(p) },
  { group: "locales", test: (p) => p.startsWith("site/blog/") && p.endsWith(".html") },
]);

/** Paths that are outside the class NO MATTER what else matches. Kept explicit so
 *  a future allowlist rule cannot widen into them by accident. */
/** Files `hunch init` / a capture regenerate from the graph for each harness. */
export const GENERATED_GROUNDING = Object.freeze([".github/copilot-instructions.md", ".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]);

export const ALWAYS_OUTSIDE = Object.freeze([
  (p) => p.startsWith(".github/") && !GENERATED_GROUNDING.includes(p),
  (p) => p === "package.json" || p === "package-lock.json",
  (p) => p.startsWith("src/") || p.startsWith("tooling/") || p.startsWith("vscode-extension/"),
  (p) => p.startsWith(".hunch/config.json") || p.startsWith(".hunch/local.json") || p.startsWith(".hunch/team.json"),
]);

export function classifyPath(path) {
  const p = String(path).replace(/\\/g, "/").replace(/^\.\//, "");
  if (ALWAYS_OUTSIDE.some((test) => test(p))) return { path: p, group: "outside" };
  const rule = BOUNDED_CLASS.find((r) => r.test(p));
  return { path: p, group: rule ? rule.group : "outside" };
}

/** Classify a whole change. `class` is "bounded" only when every file is in the
 *  allowlist and there is at least one file; an empty change is "outside" (there
 *  is nothing to merge and nothing to trust). */
export function classifyChange(paths) {
  const files = [...new Set(paths.map((p) => String(p).trim()).filter(Boolean))].sort().map(classifyPath);
  const outside = files.filter((f) => f.group === "outside").map((f) => f.path);
  const groups = [...new Set(files.filter((f) => f.group !== "outside").map((f) => f.group))].sort();
  return {
    schema: "hunch.merge-class/1",
    class: files.length && !outside.length ? "bounded" : "outside",
    groups,
    files,
    outside,
  };
}

export function changedPaths(base, cwd = process.cwd()) {
  const out = execFileSync("git", ["diff", "--name-only", "-z", `${base}...HEAD`], { cwd, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

export function renderText(result) {
  const lines = [`merge class: ${result.class}${result.groups.length ? ` (${result.groups.join(", ")})` : ""}`];
  for (const f of result.files) lines.push(`  ${f.group === "outside" ? "✗" : "✓"} ${f.path} [${f.group}]`);
  if (result.class === "outside") lines.push(result.files.length ? `${result.outside.length} file(s) outside the bounded class — rung 1 (human merge).` : "no changed files.");
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { base: "origin/main", json: false, requireBounded: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--require-bounded") opts.requireBounded = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.base) throw new Error("--base needs a ref");
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = classifyChange(changedPaths(opts.base, opts.cwd));
  process.stdout.write((opts.json ? JSON.stringify(result, null, 2) : renderText(result)) + "\n");
  return opts.requireBounded && result.class !== "bounded" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { process.exit(main()); }
  catch (error) { process.stderr.write(`merge-class: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(2); }
}
