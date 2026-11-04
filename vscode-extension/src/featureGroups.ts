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
const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrNull = (v: unknown): boolean => v === null || isString(v);
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every(isString);

/** A move carries every field a move row reads; a version-skewed CLI's payload is
 *  dropped rather than thrown on while the tree renders. `kind` stays open so a
 *  newer CLI's move kind still shows. */
export function isMemoryMove(v: unknown): v is MemoryMove {
  return isObject(v) && isString(v.sha) && isString(v.shortSha) && isString(v.date) && isString(v.subject)
    && isString(v.kind) && isStrings(v.decisionIds) && isStrings(v.otherIds);
}

function isFeatureGroup(v: unknown): boolean {
  if (!isObject(v) || !isStringOrNull(v.landed) || !Array.isArray(v.moves) || !v.moves.every(isMemoryMove)) return false;
  const c = v.commit;
  return c === null || (isObject(c) && isString(c.sha) && isString(c.shortSha) && isString(c.date) && isString(c.subject));
}

/** Parse `hunch log --for --json`; null for anything that is not that shape, so an
 *  old CLI or a stray payload never renders as half a tree. */
export function parseMemoryFor(stdout: string): MemoryFor | null {
  let v: unknown;
  try { v = JSON.parse(stdout); } catch { return null; }
  if (!isObject(v) || (v.kind !== "branch" && v.kind !== "commit") || !isString(v.sha) || !isString(v.query) || !isStringOrNull(v.branch)) return null;
  if (v.merged !== null && !(isObject(v.merged) && isString(v.merged.status))) return null;
  if (!isStrings(v.notes) || !Array.isArray(v.groups) || !v.groups.every(isFeatureGroup)) return null;
  return v as unknown as MemoryFor;
}

/** Why grouping failed, as a warning row: the CLI's first stderr line, and a hint
 *  only where one is known (an older CLI without `--for`). An unknown ref or a
 *  folder outside git already says so in the message. */
export function featureFailure(log: { ok: boolean; stderr: string }): { message: string; hint: string } {
  if (log.ok) return { message: "unexpected output", hint: "the Hunch CLI and extension versions may differ" };
  const message = log.stderr.trim().split(/\r?\n/)[0] || "the CLI failed";
  return { message, hint: /unknown option '--for'/.test(message) ? "update the Hunch CLI" : "" };
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
