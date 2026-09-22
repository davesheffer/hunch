/**
 * Workspace ledger — one record per MACHINE per repository describing that machine's
 * git worktrees and local branches, with deterministic merged verdicts
 * (docs/workspace-ledger.md). A LEAF module (zod + ids + provenance only) so types.ts
 * can register the kind without a cycle, like stateRecords.ts.
 *
 * Security posture, in code: the schema is `.strict()` with bounded lengths, every
 * branch name must be a git-valid ref component, every free-text field passes the
 * credential filter, and NOTHING here reads a record back as authority — the
 * aggregation below produces DISPLAY rows and a recommended action; `prune --apply`
 * (Phase 3) re-snapshots live git and never acts on a stored record.
 */
import { z } from "zod";
import { shortHash } from "./ids.js";
import { ProvenanceSchema, isCredentialFreeValue } from "./provenance.js";

export const WORKSPACE_SCHEMA_VERSION = "hunch.workspace/1" as const;
/** Record bounds. The extractor keeps the most recently committed entries and says so in
 *  provenance, so a huge repository degrades to a truncated record, never to a crash. */
export const MAX_WORKTREES = 512;
export const MAX_BRANCHES = 4096;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const MACHINE_ID = /^mac_[0-9a-f]{32}$/;
export const MACHINE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A branch name git would accept (`git check-ref-format --branch`), fail-closed: no
 *  leading `-` (flag smuggling), no control/whitespace characters, no `..`, `@{`,
 *  `.lock` suffix, leading/trailing `.` or `/`, and bounded length. Every real branch
 *  from `for-each-ref` passes; a crafted record cannot smuggle an argument. */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 256) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.startsWith(".") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//") || name.endsWith(".lock") || name === "@") return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  return !name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
}

const BranchName = z.string().refine(isSafeBranchName, { message: "branch name must be a git-valid, flag-free ref" });
/** `origin/feature` — a remote-tracking short ref: remote name plus a safe branch name. */
const UpstreamName = z.string().max(320).refine((v) => {
  const slash = v.indexOf("/");
  return slash > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.slice(0, slash)) && isSafeBranchName(v.slice(slash + 1));
}, { message: "upstream must be <remote>/<branch>" });
/** C0/C1 control characters, including newline and ESC: a stored string carrying one could
 *  forge extra lines or terminal escapes in output a human reads (a printed command). */
export const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;
const credentialFree = (label: string, max: number) =>
  z.string().min(1).max(max)
    .refine((v) => !CONTROL_CHARS.test(v), { message: `${label} must not contain control characters or newlines` })
    .refine(isCredentialFreeValue, { message: `${label} must not carry credential material` });

export const WorkspaceWorktreeSchema = z.object({
  /** Stable, path-free handle (hash of the path) so branches can point at a worktree in
   *  `branches` publish mode, where the path itself is omitted. */
  id: z.string().regex(/^wt_[0-9a-f]{8}$/),
  path: credentialFree("worktree path", 1024).nullable(),
  branch: BranchName.nullable(),
  head: z.string().regex(SHA),
  is_main: z.boolean(),
  /** null = could not be determined (the path no longer exists). */
  dirty: z.boolean().nullable(),
  locked: z.boolean(),
  prunable: z.boolean(),
  last_commit_at: z.string().regex(ISO).nullable(),
}).strict();
export type WorkspaceWorktree = z.infer<typeof WorkspaceWorktreeSchema>;

/** `no-commits`: the branch head lies on the default branch's first-parent history, so the
 *  branch holds no commits of its own (freshly created, or fast-forwarded into the default
 *  branch). Ancestry alone would call it merged; it is never offered for deletion. */
export const MERGED_STATUSES = ["merged", "unmerged", "no-commits", "unknown"] as const;
export const MERGED_METHODS = ["ancestry", "squash", "rebase"] as const;

export const MergedVerdictSchema = z.object({
  status: z.enum(MERGED_STATUSES),
  method: z.enum(MERGED_METHODS).nullable(),
  evidence: z.array(z.string().max(256)
    .refine((v) => !CONTROL_CHARS.test(v), { message: "verdict evidence must not contain control characters or newlines" })
    .refine(isCredentialFreeValue, { message: "verdict evidence must not carry credential material" })).max(8),
  /** The pull request that landed a merged branch, read from the LOCAL merge / squash commit
   *  subject ("Merge pull request #N from …", "… (#N)") — never fetched from a forge. */
  pr: z.number().int().min(1).max(100_000_000).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.status === "merged") !== (v.method !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a merged verdict names its method; any other verdict has none" });
  }
  if (v.pr !== undefined && v.status !== "merged") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pr"], message: "only a merged verdict can name a pull request" });
  }
});
export type MergedVerdict = z.infer<typeof MergedVerdictSchema>;

export const WorkspaceBranchSchema = z.object({
  name: BranchName,
  head: z.string().regex(SHA),
  is_default: z.boolean(),
  upstream: UpstreamName.nullable(),
  upstream_gone: z.boolean(),
  ahead: z.number().int().min(0).max(1_000_000).nullable(),
  behind: z.number().int().min(0).max(1_000_000).nullable(),
  last_commit_at: z.string().regex(ISO).nullable(),
  /** The worktree (by id) checked out on this branch, if any. */
  worktree: z.string().regex(/^wt_[0-9a-f]{8}$/).nullable(),
  merged: MergedVerdictSchema,
}).strict();
export type WorkspaceBranch = z.infer<typeof WorkspaceBranchSchema>;

export const WorkspaceSchema = z.object({
  schema: z.literal(WORKSPACE_SCHEMA_VERSION),
  id: z.string().regex(/^ws_[0-9a-f]{12}$/),
  machine: z.object({
    id: z.string().regex(MACHINE_ID),
    label: z.string().regex(MACHINE_LABEL),
    platform: z.string().regex(/^[a-z0-9]{1,16}$/),
  }).strict(),
  /** The existing privacy-safe repository label (`stableRepositoryName`): a digest of the
   *  canonical fetch remote, never a URL or a path. */
  repository: credentialFree("repository label", 256),
  publish: z.enum(["full", "branches"]),
  observed_at: z.string().regex(ISO),
  fetched_at: z.string().regex(ISO).nullable(),
  default_branch: z.object({ name: BranchName, ref: UpstreamName.or(BranchName), head: z.string().regex(SHA) }).strict().nullable(),
  worktrees: z.array(WorkspaceWorktreeSchema).max(MAX_WORKTREES),
  branches: z.array(WorkspaceBranchSchema).max(MAX_BRANCHES),
  provenance: ProvenanceSchema,
}).strict().superRefine((record, ctx) => {
  if (record.id !== workspaceId(record.machine.id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "workspace id must derive from the machine id" });
  }
  if (record.publish === "branches" && record.worktrees.some((w) => w.path !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["worktrees"], message: "branches publish mode carries no worktree paths" });
  }
  const worktreeIds = new Set(record.worktrees.map((w) => w.id));
  if (worktreeIds.size !== record.worktrees.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["worktrees"], message: "worktree ids must be unique" });
  }
  const names = new Set<string>();
  for (const [index, branch] of record.branches.entries()) {
    if (names.has(branch.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches", index], message: "branch names must be unique" });
    names.add(branch.name);
    if (branch.worktree !== null && !worktreeIds.has(branch.worktree)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branches", index, "worktree"], message: "branch points at a worktree this record does not carry" });
    }
  }
  if (record.provenance.evidence.length > 64 || record.provenance.evidence.some((e) => e.length > 512 || !isCredentialFreeValue(e))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "workspace provenance must remain bounded and credential-free" });
  }
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** One record per machine: the id derives from the machine id, so a re-snapshot
 *  UPDATES the machine's record and two machines can never collide on a file. */
export function workspaceId(machineId: string): string {
  return "ws_" + machineId.replace(/^mac_/, "").slice(0, 12);
}

/** Path-free worktree handle. */
export function worktreeId(path: string): string {
  return "wt_" + shortHash(path, 8);
}

/** The same observation, published under `publish`: `branches` drops every worktree path
 *  (the default), `full` keeps them. Pure, so a caller that already took a live snapshot
 *  (paths included, for its own display) can publish it without re-running git. */
export function withPublishMode(record: Workspace, publish: "full" | "branches"): Workspace {
  if (record.publish === publish) return record;
  return WorkspaceSchema.parse({
    ...record,
    publish,
    worktrees: record.worktrees.map((w) => ({ ...w, path: publish === "full" ? w.path : null })),
  });
}

/** True when two snapshots of the same machine describe the same workspace, ignoring the
 *  observation stamps — so an idle machine's hook does not commit a new record per
 *  checkout. Provenance is constant per build and is compared too. */
export function sameWorkspaceContent(a: Workspace, b: Workspace): boolean {
  const strip = (w: Workspace) => JSON.stringify({ ...w, observed_at: null, fetched_at: null });
  return strip(a) === strip(b);
}

// ---- aggregation (pure; display + recommendation only) ------------------------------------

export interface AggregateOptions {
  /** Records older than this many days are reported as unverified. */
  staleAfterDays?: number;
  now?: Date;
}

export interface WorktreeRow {
  machine: string;
  worktree_id: string;
  /** null in `branches` publish mode. */
  path: string | null;
  branch: string | null;
  head: string;
  dirty: boolean | null;
  locked: boolean;
  prunable: boolean;
  last_commit_at: string | null;
  seen_at: string;
  unverified: boolean;
}

export interface BranchRow {
  name: string;
  /** Machine labels that hold this branch locally. */
  machines: string[];
  /** Machine labels with a worktree checked out on it. */
  worktree_on: string[];
  /** Machine labels whose worktree on it has uncommitted changes. */
  dirty_on: string[];
  /** Distinct heads across machines; more than one means the local branches diverged. */
  heads: string[];
  is_default: boolean;
  upstream: string | null;
  upstream_gone: boolean;
  ahead: number | null;
  behind: number | null;
  last_commit_at: string | null;
  merged: MergedVerdict;
  /** Machine labels whose record is older than the staleness window. */
  unverified_on: string[];
  action: string;
}

export const DEFAULT_STALE_AFTER_DAYS = 7;

export function isUnverified(record: Pick<Workspace, "observed_at">, opts: AggregateOptions = {}): boolean {
  const now = (opts.now ?? new Date()).getTime();
  const days = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const observed = Date.parse(record.observed_at);
  return !Number.isFinite(observed) || now - observed > days * 86_400_000;
}

/** Same machine id → the newest observation wins; a stale duplicate never shadows a fresh one. */
export function latestPerMachine(records: readonly Workspace[]): Workspace[] {
  const byMachine = new Map<string, Workspace>();
  for (const r of records) {
    const prev = byMachine.get(r.machine.id);
    if (!prev || Date.parse(r.observed_at) > Date.parse(prev.observed_at)) byMachine.set(r.machine.id, r);
  }
  return [...byMachine.values()].sort((a, b) => a.machine.label.localeCompare(b.machine.label));
}

export function worktreeRows(records: readonly Workspace[], opts: AggregateOptions = {}): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  for (const r of latestPerMachine(records)) {
    const unverified = isUnverified(r, opts);
    for (const w of r.worktrees) {
      rows.push({
        machine: r.machine.label, worktree_id: w.id, path: w.path, branch: w.branch, head: w.head,
        dirty: w.dirty, locked: w.locked, prunable: w.prunable, last_commit_at: w.last_commit_at,
        seen_at: r.observed_at, unverified,
      });
    }
  }
  return rows;
}

function daysIdle(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86_400_000) : null;
}

/** The recommendation rules from docs/workspace-ledger.md — deterministic text an agent
 *  or a human reads; nothing executes it. */
export function recommendAction(row: Omit<BranchRow, "action">, opts: AggregateOptions = {}): string {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const suffix = row.unverified_on.length ? ` (unverified: ${row.unverified_on.join(", ")})` : "";
  if (row.is_default) return "keep: default branch";
  if (row.heads.length > 1) return `review: local heads differ across ${row.machines.join(", ")}${suffix}`;
  if (row.merged.status === "merged") {
    if (row.dirty_on.length) return `keep: dirty worktree on ${row.dirty_on.join(", ")}${suffix}`;
    const parts = [`delete local on ${row.machines.join(", ")}`];
    if (row.worktree_on.length) parts.push(`prune worktree on ${row.worktree_on.join(", ")}`);
    return parts.join("; ") + suffix;
  }
  // Unmerged: a dirty worktree is not a reason to keep (the branch is kept anyway) but
  // it is what the reader needs to know before touching the branch on that machine.
  const dirty = row.dirty_on.length ? `; dirty worktree on ${row.dirty_on.join(", ")}` : "";
  if (row.merged.status === "unknown") return `review: merge state unknown${dirty}${suffix}`;
  if (row.merged.status === "no-commits") return `keep: no commits of its own${dirty}${suffix}`;
  if (row.upstream === null || row.upstream_gone) {
    const idle = daysIdle(row.last_commit_at, now);
    const why = row.upstream_gone ? "upstream deleted, unmerged work" : "unpushed";
    if (idle !== null && idle > staleDays) return `review: ${why}, ${idle}d idle${dirty}${suffix}`;
    return `keep: ${why}${dirty}${suffix}`;
  }
  return `keep${dirty}${suffix}`;
}

/** Merge verdicts across machines for one branch at one head: any machine that PROVED a
 *  merge (with evidence) wins over machines that could not tell; `unknown` never
 *  outranks `unmerged`, so an offline machine cannot mask real unmerged work. */
function bestVerdict(verdicts: MergedVerdict[]): MergedVerdict {
  return verdicts.find((v) => v.status === "merged")
    ?? verdicts.find((v) => v.status === "unmerged")
    ?? verdicts.find((v) => v.status === "no-commits")
    ?? verdicts[0]
    ?? { status: "unknown", method: null, evidence: [] };
}

export function branchRows(records: readonly Workspace[], opts: AggregateOptions = {}): BranchRow[] {
  const latest = latestPerMachine(records);
  const byName = new Map<string, Array<{ record: Workspace; branch: WorkspaceBranch; unverified: boolean }>>();
  for (const record of latest) {
    const unverified = isUnverified(record, opts);
    for (const branch of record.branches) {
      const list = byName.get(branch.name) ?? [];
      list.push({ record, branch, unverified });
      byName.set(branch.name, list);
    }
  }
  const rows: BranchRow[] = [];
  for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const worktreeOf = (e: { record: Workspace; branch: WorkspaceBranch }) =>
      e.branch.worktree ? e.record.worktrees.find((w) => w.id === e.branch.worktree) : undefined;
    const withUpstream = entries.find((e) => e.branch.upstream !== null) ?? entries[0]!;
    const partial: Omit<BranchRow, "action"> = {
      name,
      machines: entries.map((e) => e.record.machine.label),
      worktree_on: entries.filter((e) => worktreeOf(e)).map((e) => e.record.machine.label),
      dirty_on: entries.filter((e) => worktreeOf(e)?.dirty === true).map((e) => e.record.machine.label),
      heads: [...new Set(entries.map((e) => e.branch.head))],
      is_default: entries.some((e) => e.branch.is_default),
      upstream: withUpstream.branch.upstream,
      upstream_gone: entries.some((e) => e.branch.upstream_gone),
      ahead: withUpstream.branch.ahead,
      behind: withUpstream.branch.behind,
      last_commit_at: entries.map((e) => e.branch.last_commit_at).filter((d): d is string => !!d).sort().at(-1) ?? null,
      merged: bestVerdict(entries.map((e) => e.branch.merged)),
      unverified_on: entries.filter((e) => e.unverified).map((e) => e.record.machine.label),
    };
    rows.push({ ...partial, action: recommendAction(partial, opts) });
  }
  return rows;
}

/** "2h ago" / "9d ago" for the SEEN column. */
export function ago(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- prune planning (pure) -----------------------------------------------------------------
//
// The plan for THIS machine is computed from its LIVE record only (never a stored one) and
// names exactly the commands `prune --apply` would run: `git worktree remove -- <path>` and
// `git branch -d -- <name>` — never `--force`, never `-D`, never a remote. Other machines get
// the same commands PRINTED from their stored records; nothing executes them.

export interface PruneStep {
  branch: string;
  head: string;
  /** Worktree checked out on the branch, when one exists and can be removed first. */
  worktree: { id: string; path: string | null } | null;
  commands: string[];
  why: string;
  /** How the merge was proven; squash and rebase merges are invisible to `git branch -d`. */
  method: MergedVerdict["method"];
  /** Ignored files in the worktree that `git worktree remove` deletes without asking (local
   *  plan only, read live; never stored). `shown` is bounded, `total` counts all entries. */
  ignored?: { shown: string[]; total: number };
}

/** POSIX shell quoting for one token of a PRINTED command (never executed through a shell
 *  here: execution uses argv arrays). Tokens made only of characters no shell treats
 *  specially stay bare; anything else is single-quoted with `'` escaped as `'\''`, which is
 *  also valid in Git Bash for Windows paths. */
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_\-./:@+,]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export interface PrunePlan {
  /** Executable on this machine (live record). */
  local: PruneStep[];
  /** Display-only, keyed by machine label (stored records). */
  others: Record<string, PruneStep[]>;
  /** Branches this machine holds that were considered and left alone, with the reason. */
  skipped: Array<{ branch: string; reason: string }>;
}

function pruneStepsFor(record: Workspace, opts: { skip: (branch: WorkspaceBranch, worktree: WorkspaceWorktree | undefined) => string | null }): { steps: PruneStep[]; skipped: Array<{ branch: string; reason: string }> } {
  const steps: PruneStep[] = [];
  const skipped: Array<{ branch: string; reason: string }> = [];
  for (const b of record.branches) {
    const wt = b.worktree ? record.worktrees.find((w) => w.id === b.worktree) : undefined;
    const reason = opts.skip(b, wt);
    if (reason) { if (b.merged.status === "merged" && !b.is_default) skipped.push({ branch: b.name, reason }); continue; }
    const commands: string[] = [];
    if (wt) commands.push(`git worktree remove -- ${wt.path === null ? "<its worktree>" : shellQuote(wt.path)}`);
    commands.push(`git branch -d -- ${shellQuote(b.name)}`);
    steps.push({
      branch: b.name, head: b.head, worktree: wt ? { id: wt.id, path: wt.path } : null, commands,
      why: `${b.merged.method}${b.merged.pr ? ` (PR #${b.merged.pr})` : ""}: ${b.merged.evidence[0] ?? ""}`,
      method: b.merged.method,
    });
  }
  return { steps, skipped };
}

/** Why a branch must not be pruned, or null when it may. The rules are the documented ones:
 *  proven merged, not the default branch, worktree (if any) clean, unlocked and present. */
export function pruneRefusal(b: WorkspaceBranch, wt: WorkspaceWorktree | undefined): string | null {
  if (b.is_default) return "default branch";
  if (b.merged.status !== "merged") {
    return b.merged.status === "unknown" ? "merge state unknown" : b.merged.status === "no-commits" ? "no commits of its own" : "not merged";
  }
  if (wt?.is_main) return "checked out in the main worktree (switch away first)";
  if (wt?.locked) return "worktree is locked";
  if (wt?.prunable) return "worktree path is missing (git worktree prune first)";
  if (wt && wt.dirty !== false) return wt.dirty === null ? "worktree state could not be read" : "worktree has uncommitted or untracked changes";
  return null;
}

/** The repo-relative path of a workspace record committed into the PUBLIC `.hunch/`. */
export function publicWorkspaceRecordPath(id: string): string {
  return `.hunch/workspaces/${id}.json`;
}

/** The manual recipe for removing a workspace record that lives in the repo-tracked
 *  `.hunch/`. Hunch's own publication pump is deliberately ADDITIVE — it refuses to stage
 *  a tracked deletion so a stale clone can never erase team history (the same stance
 *  `compact --apply` takes) — so deleting such a record here would strand `D .hunch/…` in
 *  the working tree and wedge every later auto-commit. The removal is a normal, reviewable
 *  git change the human makes instead. */
export function publicWorkspaceRemovalRecipe(id: string, machine: string): string {
  const path = publicWorkspaceRecordPath(id);
  return `  · git rm ${path}   (never committed? delete the file instead)\n`
    + `  · git commit -m "hunch: forget workspace ${machine}"`;
}

export function planPrune(live: Workspace, others: readonly Workspace[]): PrunePlan {
  const mine = pruneStepsFor(live, { skip: pruneRefusal });
  const plan: PrunePlan = { local: mine.steps, others: {}, skipped: mine.skipped };
  for (const record of latestPerMachine(others.filter((r) => r.machine.id !== live.machine.id))) {
    const theirs = pruneStepsFor(record, { skip: pruneRefusal });
    if (theirs.steps.length) plan.others[record.machine.label] = theirs.steps;
  }
  return plan;
}
