@@CLEANROOM_HOLE_1@@
 * with the same patch-id, or failing that the ONE whose changed files are a
 * superset of the decision's related_files. Zero or multiple qualifying
 * candidates means "don't guess" — same discipline as repair.ts's
 * rename-repair.
@@CLEANROOM_HOLE_2@@
import { createHash } from "node:crypto";
@@CLEANROOM_HOLE_3@@
/** Bind review to the ordered queue and which targets are currently resolvable.
 * Queue order matters: duplicate decision ids use first-match selection. */
export function commitRepairReviewHash(queued: readonly CommitRewrite[], withheld: ReadonlySet<CommitRewrite> = new Set()): string {
  const snapshot = queued.map((r) => ({ id: r.id, from: r.from, to: r.to, withheld: withheld.has(r) }));
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

@@CLEANROOM_HOLE_4@@
/** Match each orphaned decision to exactly one candidate. A candidate with the
 *  same `git patch-id --stable` as the orphaned commit (a rebase- or
 *  single-commit squash-merge of it) is the strong match and wins. Only when
 *  no candidate shares the patch-id does it fall back to the one candidate
 *  whose changed files are a superset of the decision's related_files
 *  (non-empty, no globs) -- needed for a squash of several commits, whose
 *  patch-id never equals any one of them, but weak: shared files like
 *  CHANGELOG.md often have one wrong superset (#450). */
@@CLEANROOM_HOLE_5@@
  patchIdOf: (sha: string) => string | null = () => null,
@@CLEANROOM_HOLE_6@@
    const patchId = patchIdOf(d.commit!);
    if (patchId) {
      const same = candidates.filter((c) => patchIdOf(c.sha) === patchId);
      if (same.length === 1) {
        rewrites.push({ id: d.id, from: d.commit!, to: same[0]!.sha });
        continue;
      }
      if (same.length > 1) continue; // ambiguous: never guess
    }
@@CLEANROOM_HOLE_7@@
