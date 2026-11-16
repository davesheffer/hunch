/** `hunch sync --range a..b`: capture every non-merge commit in a range — the
 *  commits that landed without a local post-commit hook (server-side merges,
 *  merge queues, the GitHub UI). Sequential over `syncCommit`, so each commit
 *  keeps its own idempotency/trivial/human-confirmed gates. */

import { execFileSync } from "node:child_process";
import type { HunchStore } from "../store/hunchStore.js";
import { commitPatchIds, isCompleteRepo } from "../extractors/git.js";
import { recordedPatchId } from "../core/commitrepair.js";
import { syncCommit, type SyncResult } from "./synthesize.js";
import { decisionId } from "../core/ids.js";

/** Resolve a `a..b` range to its non-merge commits: the NEWEST `max`, oldest-first,
 *  plus the total count in the range. Throws on a malformed or unresolvable range. */
export function rangeCommits(range: string, cwd: string, max: number): { shas: string[]; total: number } {
  if (range.includes("...")) throw new Error(`invalid range "${range}": use a..b; symmetric ranges a...b are not supported`);
  if (!range.includes("..") || range.startsWith("-") || /[\s\0]/.test(range) || range.split("..").every((side) => !side)) {
    throw new Error(`invalid range "${range}": expected <a>..<b> (no leading "-", no whitespace)`);
  }
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    } catch (e) {
      const stderr = (e as { stderr?: string | Buffer }).stderr?.toString().trim();
      throw new Error(`cannot resolve range ${range}: ${stderr || (e as Error).message}`);
    }
  };
  // Each side must name a commit: `HEAD:path` (a blob) or `HEAD^{tree}` would otherwise
  // resolve and capture whole history or scaffold from a non-commit.
  for (const side of range.split("..")) {
    if (!side) continue;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${side}^{commit}`], { cwd, stdio: "ignore", timeout: 10_000 });
    } catch {
      throw new Error(`invalid range "${range}": ${side} is not a commit`);
    }
  }
  const total = Number(run(["rev-list", "--count", "--no-merges", range, "--"]).trim()) || 0;
  // git applies --max-count before --reverse, so this is the newest `max` in topo order, oldest-first.
  const shas = run(["rev-list", "--topo-order", "--reverse", "--no-merges", `--max-count=${max}`, range, "--"])
    .split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s));
  return { shas, total };
}

/** Is `a` an ancestor of `b`? Any failure (e.g. the object was gc'd after a rewrite) is "no". */
export function isAncestor(a: string, b: string, cwd: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd, stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Related by ancestry in either direction (a revert + re-apply, captured in either order). */
function related(a: string | null, b: string, cwd: string): boolean {
  return !!a && (isAncestor(a, b, cwd) || isAncestor(b, a, cwd));
}

export interface SyncRangeOptions {
  private: boolean;
  localOnly: boolean;
  force?: boolean;
  deep?: boolean;
  verify?: boolean;
  samples?: number;
  onCommit?: (sha: string, outcome: SyncResult) => void;
}

export async function syncRange(
  store: HunchStore,
  root: string,
  commits: { shas: string[]; total: number },
  opts: SyncRangeOptions,
): Promise<{ total: number; shas: string[]; results: Array<{ sha: string; result: SyncResult }> }> {
  // The caller resolves the range once (rangeCommits) so rename repair and capture see the same commits.
  const { shas, total } = commits;
  // Ownership by commit first: a decision whose `commit` (abbreviated) names this sha,
  // or the decision with id decisionId(sha), owns it — independent of patch-id tags,
  // which pre-1.57 records, shallow captures and repair-provenance re-points lack.
  // recs() unions the private overlay, so both homes count.
  type Entry = { id: string; commit: string | null };
  const owners: Entry[] = [];
  const ids = new Set<string>();
  const remember = (e: Entry): void => {
    if (ids.has(e.id)) return;
    ids.add(e.id);
    owners.push(e);
  };
  for (const d of store.recs("decisions")) remember({ id: d.id, commit: d.commit });
  const ownersOf = (sha: string): Entry[] => {
    const lower = sha.toLowerCase();
    const own = decisionId(sha);
    return owners.filter((e) => e.id === own || (!!e.commit && e.commit.length >= 7 && lower.startsWith(e.commit.toLowerCase())));
  };
  // Rebased-duplicate guard for UNOWNED commits: a patch-id already recorded on a decision
  // for an unrelated sha is a rebase/cherry-pick of captured work. Shallow clones compute
  // wrong patch-ids at the boundary, so no dedupe there.
  const patchIds = shas.length && isCompleteRepo(root) ? commitPatchIds(shas, root) : new Map<string, string>();
  const byPatch = new Map<string, Entry[]>();
  const rememberPatch = (p: string, entry: Entry): void => {
    const list = byPatch.get(p);
    if (!list) byPatch.set(p, [entry]);
    else if (!list.some((e) => e.id === entry.id)) list.push(entry);
  };
  if (patchIds.size) {
    for (const d of store.recs("decisions")) {
      const p = recordedPatchId(d);
      if (p) rememberPatch(p, { id: d.id, commit: d.commit });
    }
  }
  const syncOpts = {
    force: opts.force,
    private: opts.private,
    localOnly: opts.localOnly,
    deep: opts.deep,
    verify: opts.verify,
    samples: opts.samples,
  };
  // The home syncCommit writes to; null when routing refuses (syncCommit reports that).
  let captureHome: "public" | "private" | null = null;
  try { captureHome = store.captureHome(!!opts.private, "decisions"); } catch { captureHome = null; }
  const otherHomeOnly = (id: string): "public" | "private" | null => {
    if (!captureHome) return null;
    const inPrivate = !!store.getPrivateRec("decisions", id);
    const inPublic = !!store.json.get("decisions", id);
    if (captureHome === "public" && inPrivate && !inPublic) return "private";
    if (captureHome === "private" && inPublic && !inPrivate) return "public";
    return null;
  };
  const results: Array<{ sha: string; result: SyncResult }> = [];
  for (const sha of shas) {
    const owned = ownersOf(sha);
    let result: SyncResult;
    const patchId = owned.length ? undefined : patchIds.get(sha);
    const entries = patchId ? byPatch.get(patchId) ?? [] : [];
    const duplicate = entries.length > 0 && !entries.some((e) => related(e.commit, sha, root));
    const ownHome = owned.some((e) => e.id === decisionId(sha)) ? otherHomeOnly(decisionId(sha)) : null;
    if (ownHome) {
      // Own-id record lives only in the home syncCommit would NOT write to: its
      // home-scoped lookup would miss it and mint a same-id twin.
      result = { status: "skipped", reason: `already captured by ${decisionId(sha)} in the ${ownHome} store` };
    } else if (owned.some((e) => e.id === decisionId(sha))) {
      // Its own decision: syncCommit's idempotency/--force/human-confirmed gates decide.
      result = await syncCommit(store, root, sha, syncOpts);
    } else if (owned.length) {
      // Re-pointed to this commit (repair-provenance): never mint a second decision, even with --force.
      result = { status: "skipped", reason: `already captured by ${owned[0]!.id}` };
    } else if (duplicate) {
      // The original still reachable from HEAD is a cherry-pick, not orphaned provenance.
      const orig = entries[0]!;
      result = orig.commit && isAncestor(orig.commit, "HEAD", root)
        ? { status: "skipped", reason: `cherry-picked duplicate of ${orig.id} (same patch-id)` }
        : { status: "skipped", reason: `rebased duplicate of ${orig.id} (same patch-id; run \`hunch repair-provenance\` to re-point it)` };
    } else {
      result = await syncCommit(store, root, sha, syncOpts);
    }
    if (result.status === "written" && result.decision) {
      remember({ id: result.decision.id, commit: result.decision.commit });
      const p = recordedPatchId(result.decision);
      if (p) rememberPatch(p, { id: result.decision.id, commit: result.decision.commit });
    }
    results.push({ sha, result });
    opts.onCommit?.(sha, result);
  }
  return { total, shas, results };
}
