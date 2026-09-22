/**
 * Workspace ledger wiring (docs/workspace-ledger.md, Phase 2): the ONE code path every
 * surface uses to read the ledger (CLI `workspaces` / `branches`, the `hunch_workspaces`
 * MCP tool, `hunch now`, `doctor`) and to record this machine's snapshot (CLI `snapshot`,
 * `hunch worktree`, the git hooks, and the MCP server's session-start refresh).
 *
 * This machine is always read LIVE from git and never from a stored record; stored
 * records (other machines) are display-only. A snapshot writes through the same capture
 * funnel as every other record: the overlay when one is configured, the public .hunch/
 * only when `workspaces.publish_public` opts in, nothing otherwise.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { foreignRepoEnv, gitHeadUnsettled, mainWorktreeRoot } from "../extractors/git.js";
import { hunchPaths } from "../core/paths.js";
import { readConfig, workspacesConfig, type WorkspacesConfig } from "../core/config.js";
import { loadOrCreateMachine, type MachineIdentity } from "../core/machine.js";
import {
  CONTROL_CHARS, ago, branchRows, isSafeBranchName, latestPerMachine, isUnverified, planPrune, sameWorkspaceContent, withPublishMode, worktreeRows,
  type BranchRow, type PrunePlan, type PruneStep, type Workspace, type WorktreeRow,
} from "../core/workspace.js";
import { ignoredPaths, snapshotWorkspace } from "../extractors/workspaces.js";
import type { HunchStore } from "../store/hunchStore.js";
import { flushCapture } from "./sync.js";

export interface LedgerView {
  machine: MachineIdentity;
  /** This machine, live (paths included; never written). */
  live: Workspace;
  /** live + every OTHER machine's stored record. */
  records: Workspace[];
  config: WorkspacesConfig;
}

export function workspaceLedgerView(store: HunchStore, root: string, opts: { fetch?: boolean } = {}): LedgerView {
  const machine = loadOrCreateMachine();
  const config = workspacesConfig(readConfig(hunchPaths(root)));
  const live = snapshotWorkspace(root, { machine, publish: "full", fetch: !!opts.fetch });
  const others = store.recs("workspaces").filter((r) => r.machine.id !== machine.id);
  return { machine, live, records: [live, ...others], config };
}

export type SnapshotOutcome =
  | { status: "off" }
  | { status: "dry-run"; record: Workspace }
  | { status: "no-home"; record: Workspace }
  | { status: "unchanged"; record: Workspace; previous: Workspace }
  /** The OTHER memory home already holds a record with this machine's id (an old public
   *  copy, or a record someone else wrote under this id): the store refuses a twin, and so
   *  do we — `hunch workspaces forget <id>` removes the stale copy. */
  | { status: "collision"; record: Workspace; reason: string }
  /** A PUBLIC-home snapshot is a commit on the checked-out code branch. While git is replaying
   *  history (rebase / merge / cherry-pick / revert / bisect) or HEAD is detached, that write
   *  would land in the middle of the operation — an untracked `ws_*.json` that makes
   *  `git rebase --continue` abort, or a commit no branch owns. Nothing is lost: the next
   *  branch checkout or ledger read records this machine. */
  | { status: "deferred"; record: Workspace; reason: "git-operation-in-progress" | "detached-head" }
  | { status: "written"; record: Workspace; home: "private" | "public"; flushed: "pushed" | "committed" | null };

/** Record this machine's snapshot. Honors `workspaces.publish`, skips a write when the
 *  content is unchanged and the stored record is under a day old (an idle machine's hooks
 *  must not commit a record per checkout), and reports exactly what happened. */
export function recordWorkspaceSnapshot(store: HunchStore, root: string, opts: { fetch?: boolean; dryRun?: boolean; live?: Workspace } = {}): SnapshotOutcome {
  const config = workspacesConfig(readConfig(hunchPaths(root)));
  if (config.publish === "off") return { status: "off" };
  const machine = loadOrCreateMachine();
  // A caller that already took a live snapshot (a ledger read) publishes THAT observation
  // rather than paying for a second pass over git.
  const record = opts.live && !opts.fetch
    ? withPublishMode(opts.live, config.publish)
    : snapshotWorkspace(root, { machine, publish: config.publish, fetch: !!opts.fetch });
  if (opts.dryRun) return { status: "dry-run", record };
  const isPrivate = store.hasPrivate;
  if (!isPrivate && !config.publish_public) return { status: "no-home", record };
  const previous = store.getRec("workspaces", record.id);
  if (previous && Date.now() - Date.parse(previous.observed_at) < 86_400_000 && sameWorkspaceContent(previous, record)) {
    return { status: "unchanged", record, previous };
  }
  // Checked as late as possible (the live snapshot above takes time, and a rebase can start or
  // finish while it runs). A private overlay is its own repository, whose commits never touch
  // the code branch, so only a PUBLIC home defers.
  if (!isPrivate) {
    const unsettled = gitHeadUnsettled(root);
    if (unsettled) return { status: "deferred", record, reason: unsettled };
  }
  try {
    store.putCapture("workspaces", record, isPrivate);
  } catch (error) {
    const reason = (error as Error).message;
    if (/already exists in the other memory home/.test(reason)) return { status: "collision", record, reason };
    throw error;
  }
  const flushed = flushCapture(store, hunchPaths(root).hunch, isPrivate, `hunch: workspace snapshot ${machine.label}`);
  return { status: "written", record, home: isPrivate ? "private" : "public", flushed };
}

/** Whether a snapshot could land anywhere on this root — used to skip work that would
 *  write nothing. */
export function snapshotHasHome(store: HunchStore, root: string): boolean {
  const config = workspacesConfig(readConfig(hunchPaths(root)));
  return config.publish !== "off" && (store.hasPrivate || config.publish_public);
}

// ---- rendering (shared by the CLI and the MCP tool) -----------------------------------------

export function padTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c ?? "" : (c ?? "").padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export function renderWorktreeTable(view: LedgerView, rows: WorktreeRow[], now = new Date()): string {
  const table = padTable(["MACHINE", "WORKTREE", "BRANCH", "DIRTY", "LAST COMMIT", "SEEN"], rows.map((r) => [
    r.machine + (r.machine === view.machine.label ? " (this)" : ""),
    r.path ?? "yes",
    r.branch ?? `(detached ${r.head.slice(0, 10)})`,
    r.dirty === null ? "?" : r.dirty ? "yes" : "-",
    r.last_commit_at ? ago(r.last_commit_at, now) : "-",
    (r.machine === view.machine.label ? "live" : ago(r.seen_at, now)) + (r.unverified ? " (unverified)" : "") + (r.prunable ? " (path missing)" : "") + (r.locked ? " (locked)" : ""),
  ]));
  return `${table}\n\n${rows.length} worktree(s) · this machine is ${view.machine.label} · ${view.records.length - 1} other machine(s) in memory`;
}

export function describeUpstream(r: BranchRow): string {
  if (r.upstream === null) return "never pushed";
  if (r.upstream_gone) return "gone";
  return [r.ahead ? `ahead ${r.ahead}` : "", r.behind ? `behind ${r.behind}` : ""].filter(Boolean).join(", ") || "synced";
}

export function renderBranchTable(view: LedgerView, rows: BranchRow[]): string {
  const table = padTable(["BRANCH", "MACHINES", "WORKTREE", "UPSTREAM", "MERGED", "ACTION"], rows.map((r) => [
    r.name,
    r.machines.join(","),
    r.worktree_on.length ? r.worktree_on.join(",") + (r.dirty_on.length ? " (dirty)" : "") : "-",
    describeUpstream(r),
    r.merged.status === "merged" ? `yes (${r.merged.method}${r.merged.pr ? `, PR #${r.merged.pr}` : ""})` : r.merged.status === "unmerged" ? "no" : r.merged.status === "no-commits" ? "no commits" : "unknown",
    r.action,
  ]));
  const deletable = rows.filter((r) => r.action.startsWith("delete local")).length;
  const warn = view.live.default_branch === null ? "\n  ⚠ no default branch resolved (origin/HEAD, origin/main|master, main|master) — merge verdicts are unknown" : "";
  return `${table}\n\n${rows.length} branch(es) · ${deletable} deletable · this machine is ${view.machine.label}${warn}`;
}

/** One line for `hunch now` / `hunch_now`, from STORED records only (no git, so the hot
 *  view stays fast); null when memory holds no workspace record. */
export function workspaceSummaryLine(records: readonly Workspace[], config: WorkspacesConfig, now = new Date()): string | null {
  const latest = latestPerMachine(records);
  if (!latest.length) return null;
  const opts = { staleAfterDays: config.stale_after_days, now };
  const worktrees = worktreeRows(latest, opts);
  const branches = branchRows(latest, opts);
  const unverified = latest.filter((r) => isUnverified(r, opts)).length;
  const deletable = branches.filter((b) => b.action.startsWith("delete local")).length;
  const dirty = worktrees.filter((w) => w.dirty === true).length;
  return `🗂 Workspaces in memory: ${latest.length} machine(s)${unverified ? ` (${unverified} unverified)` : ""} · ${worktrees.length} worktree(s)${dirty ? ` (${dirty} dirty)` : ""} · ${branches.length} branch(es), ${deletable} deletable — \`hunch branches\` for the verdicts`;
}

export { branchRows, worktreeRows };

// ---- prune (Phase 3) ------------------------------------------------------------------------
//
// `--apply` acts on THIS machine only, from a snapshot taken moments ago (never a stored
// record), with `git worktree remove` (no --force) and `git branch -d` (no -D), so git itself
// re-checks "clean" and "merged" as a second line of defense. Nothing here touches a remote
// or another machine; their commands are printed for a human to run there.

/** This machine's plan: the pure plan from the live record, then two live checks per step.
 *  A step `git branch -d` would refuse is moved to `skipped` BEFORE anything runs (removing
 *  the worktree and then failing the branch delete would half-apply the step), and a
 *  worktree's ignored files — which `git worktree remove` deletes without asking — are
 *  attached so the plan and the confirmation name them. */
export function prunePlanFor(view: LedgerView, root: string): PrunePlan {
  const plan = planPrune(view.live, view.records);
  const local: PruneStep[] = [];
  for (const step of plan.local) {
    const refusal = branchDeleteRefusal(root, step);
    if (refusal) { plan.skipped.push({ branch: step.branch, reason: refusal }); continue; }
    if (step.worktree?.path) {
      const ignored = ignoredPaths(step.worktree.path);
      if (ignored === null) { plan.skipped.push({ branch: step.branch, reason: "the worktree's ignored files could not be listed" }); continue; }
      if (ignored.total) step.ignored = ignored;
    }
    local.push(step);
  }
  plan.local = local;
  return plan;
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...foreignRepoEnv(process.env), GIT_OPTIONAL_LOCKS: "0" };
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Why `git branch -d -- <branch>` would refuse right now, or null when it would delete.
 *  Mirrors git's own rule (builtin/branch.c `branch_merged`): the branch head must be an
 *  ancestor of its upstream when one is configured AND resolves, otherwise of HEAD of the
 *  worktree the command runs in (the main worktree). Squash and rebase merges never pass it
 *  once the upstream is gone or unset, so such a step is reported, not half-applied. The
 *  branch name is matched in JS; only refs git printed and SHAs reach git as arguments. */
export function branchDeleteRefusal(root: string, step: Pick<PruneStep, "branch" | "head" | "method">): string | null {
  const main = mainWorktreeRoot(root);
  const env = gitEnv();
  const read = (args: string[]): string | null => {
    try { return execFileSync("git", args, { cwd: main, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const unchecked = "git branch -d precondition could not be checked; nothing was changed";
  const refs = read(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads/"]);
  if (refs === null) return unchecked;
  const entry = refs.split("\n").map((line) => line.split("\0")).find(([ref]) => ref === `refs/heads/${step.branch}`);
  if (!entry) return "branch no longer exists";
  const [, head = "", upstream = ""] = entry;
  if (head !== step.head) return `branch moved since the snapshot (now ${head.slice(0, 12)})`;
  let reference: string | null = null;
  let referenceName = "HEAD";
  if (upstream.startsWith("refs/")) {
    const resolved = read(["rev-parse", "--verify", "-q", "--end-of-options", `${upstream}^{commit}`]);
    if (resolved && SHA.test(resolved)) { reference = resolved; referenceName = upstream.replace(/^refs\/(?:remotes|heads)\//, ""); }
  }
  if (!reference) {
    const resolved = read(["rev-parse", "--verify", "-q", "--end-of-options", "HEAD^{commit}"]);
    if (!resolved || !SHA.test(resolved)) return "git branch -d would refuse: the main worktree's HEAD does not resolve; delete manually after checking";
    reference = resolved;
  }
  const r = spawnSync("git", ["merge-base", "--is-ancestor", step.head, reference], { cwd: main, env, timeout: 30_000, stdio: "ignore" });
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 1)) return unchecked;
  if (r.status === 0) return null;
  return step.method === "squash" || step.method === "rebase"
    ? `${step.method}-merged: git branch -d would refuse (not merged into ${referenceName}); delete manually after checking`
    : `git branch -d would refuse: not merged into ${referenceName}; update it, or delete manually after checking`;
}

export interface PruneResult {
  step: PruneStep;
  /** `skipped`: a live precondition failed before anything ran — the step is untouched. */
  outcome: "deleted" | "skipped" | "failed";
  detail: string;
}

/** Execute the local steps of a plan. Each command is a fixed argv; the branch name was
 *  validated by the record schema and is passed after `--`; the worktree path comes from
 *  `git worktree list` on this machine. `git branch -d`'s own precondition is re-checked
 *  BEFORE the worktree is removed, so a step either runs whole or not at all. A failure
 *  stops that step, never the others. */
export function applyPrune(root: string, steps: readonly PruneStep[]): PruneResult[] {
  const main = mainWorktreeRoot(root);
  const env = gitEnv();
  const git = (args: string[]): string => execFileSync("git", args, { cwd: main, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const results: PruneResult[] = [];
  for (const step of steps) {
    if (!isSafeBranchName(step.branch)) { results.push({ step, outcome: "failed", detail: "refused: unsafe branch name" }); continue; }
    const refusal = branchDeleteRefusal(root, step);
    if (refusal) { results.push({ step, outcome: "skipped", detail: `skipped (worktree and branch kept): ${refusal}` }); continue; }
    try {
      const detail: string[] = [];
      if (step.worktree?.path) { git(["worktree", "remove", "--", step.worktree.path]); detail.push(`removed worktree ${step.worktree.path}`); }
      else if (step.worktree) { results.push({ step, outcome: "failed", detail: "refused: the worktree's path is not known on this machine" }); continue; }
      git(["branch", "-d", "--", step.branch]);
      detail.push(`deleted branch ${step.branch} (was ${step.head.slice(0, 12)})`);
      results.push({ step, outcome: "deleted", detail: detail.join("; ") });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.toString().trim().split("\n")[0] ?? (error as Error).message;
      results.push({ step, outcome: "failed", detail: `git refused: ${stderr}` });
    }
  }
  return results;
}

/** A file name is repository content a terminal would interpret: control characters are
 *  shown escaped, never emitted. */
function printable(text: string): string {
  return text.replace(new RegExp(CONTROL_CHARS.source, "g"), (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function describeIgnored(ignored: NonNullable<PruneStep["ignored"]>): string {
  const more = ignored.total - ignored.shown.length;
  return `${ignored.total} ignored path(s) in the worktree: ${ignored.shown.map(printable).join(", ")}${more > 0 ? `, … and ${more} more` : ""}`;
}

/** The confirmation question for `prune --apply`: counts, and — because `git worktree
 *  remove` deletes ignored files (.env, build output) without asking — every worktree's
 *  ignored paths by name. */
export function pruneConfirmQuestion(view: LedgerView, plan: PrunePlan): string {
  const worktrees = plan.local.filter((s) => s.worktree).length;
  const details = plan.local.filter((s) => s.ignored).map((s) => `  ${s.branch}: removing its worktree also deletes ${describeIgnored(s.ignored!)}`);
  return [...details, `Delete ${plan.local.length} branch(es)${worktrees ? ` and remove ${worktrees} worktree(s)` : ""} on ${view.machine.label}?`].join("\n");
}

/** Interactive yes/no; false when stdin is not a terminal (the caller then needs --yes). */
export async function confirmPrune(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally { rl.close(); }
}

export function renderPrunePlan(view: LedgerView, plan: PrunePlan): string {
  const L: string[] = [];
  L.push(`This machine (${view.machine.label}) — ${plan.local.length} branch(es) provably merged and safe to delete:`);
  if (!plan.local.length) L.push("  (nothing)");
  for (const step of plan.local) {
    L.push(`  ${step.branch}  — ${step.why}`);
    for (const c of step.commands) L.push(`    ${c}`);
    if (step.ignored) L.push(`    ⚠ also deletes ${describeIgnored(step.ignored)}`);
  }
  if (plan.skipped.length) {
    L.push("", "Merged but left alone on this machine:");
    for (const s of plan.skipped) L.push(`  ${s.branch}  — ${s.reason}`);
  }
  for (const [label, steps] of Object.entries(plan.others)) {
    const record = view.records.find((r) => r.machine.label === label);
    const stale = record && isUnverified(record, { staleAfterDays: view.config.stale_after_days }) ? " (unverified — the record is old)" : "";
    L.push("", `On ${label}${stale} — run there, from that machine's stored record (never executed from here):`);
    for (const step of steps) for (const c of step.commands) L.push(`  ${c}`);
  }
  return L.join("\n");
}
