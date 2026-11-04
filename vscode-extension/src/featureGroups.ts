/**
 * The Hunch Memory view's "group by feature commit" mode: which memory led to which
 * code commit on the checked-out branch.
 *
 * Data comes from `hunch log --for <branch> --json` (the CLI owns git and the
 * attribution rules; this module only validates and labels its output). No vscode
 * import, so the labels are unit-tested without the editor.
 */
import type { MemoryMove } from "./memoryView.js";
import { owningFolder } from "./workspace.js";

/** Mirrors src/core/memorylog.FeatureCommit (JSON consumer). */
export interface FeatureCommit {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
}

/** Mirrors src/core/memorylog.FeatureGroup (JSON consumer). */
export interface FeatureGroup {
  /** null for memory after the line's last code commit. */
  commit: FeatureCommit | null;
  /** the default-branch commit that carries `commit`; null when not landed or unknown. */
  landed: string | null;
  moves: MemoryMove[];
}

/** Mirrors src/extractors/featurelog.MemoryFor (JSON consumer). */
export interface MemoryFor {
  query: string;
  kind: "branch" | "commit";
  sha: string;
  branch: string | null;
  merged: { status: string; method: string | null; evidence: string[]; pr?: number } | null;
  groups: FeatureGroup[];
  notes: string[];
}

/** What to pass to `--for`: the branch name, or HEAD (a commit) when there is none —
 *  a detached checkout, or no git repository the editor knows of. */
export function featureQuery(branch: string | undefined): string {
  return branch || "HEAD";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse `hunch log --for --json`; null for anything that is not that shape, so an
 *  old CLI or a stray payload never renders as half a tree. */
export function parseMemoryFor(stdout: string): MemoryFor | null {
  let v: unknown;
  try { v = JSON.parse(stdout); } catch { return null; }
  if (!isObject(v) || (v.kind !== "branch" && v.kind !== "commit") || typeof v.sha !== "string") return null;
  if (!Array.isArray(v.notes) || !v.notes.every((n) => typeof n === "string")) return null;
  if (!Array.isArray(v.groups) || !v.groups.every((g) => isObject(g) && Array.isArray(g.moves) && (g.commit === null || isObject(g.commit)))) return null;
  return v as unknown as MemoryFor;
}

/** The top row: what was asked for and how it reached the default branch. */
export function headerText(r: MemoryFor): { label: string; description: string } {
  if (r.kind === "commit") return { label: r.sha.slice(0, 7), description: `commit ${r.query}` };
  const v = r.merged;
  const description = !v ? "default branch"
    : v.status === "merged" ? `merged (${v.method}${v.pr ? `, PR #${v.pr}` : ""})` : v.status;
  return { label: r.branch ?? r.query, description };
}

/** One feature-commit row. */
export function groupText(g: FeatureGroup): { label: string; description: string } {
  const count = `${g.moves.length} move${g.moves.length === 1 ? "" : "s"}`;
  const landed = g.landed ? ` · landed ${g.landed.slice(0, 7)}` : "";
  if (!g.commit) return { label: "After the last code commit", description: `${g.landed ? "" : "in progress · "}${count}${landed}` };
  return { label: g.commit.subject, description: `${g.commit.shortSha} · ${count}${landed}` };
}

/** The git repository (by root path) that owns the Hunch root; undefined when none does. */
export function repoFor(repoRoots: readonly string[], root: string): string | undefined {
  return owningFolder(repoRoots, root);
}
