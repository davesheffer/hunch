/**
 * Inline escalations — the "ask the human IN THE PROMPT, not in a background queue"
 * half of the auto-trust model.
 *
 * Captured memory auto-trusts the moment it lands (status accepted, advisory), so
 * there is no draft queue to drain. The only things that still need a human are the
 * rare cases the graph genuinely CANNOT resolve on its own — and those are surfaced
 * as a short, question-framed list the assistant raises in conversation at the
 * moment, then normally EMPTY.
 *
 * Deterministic only. Memory questions include a topic conflict (>1 live decision for
 * one topic — a git merge can create these; see topics.topicCollisions) and one
 * exact imported ADR awaiting a hash-bound approve/decline answer. We do NOT
 * guess semantically which un-anchored decisions "contradict" each other — that
 * stays the assistant's judgment, asked in chat, never a machine verdict (same
 * explicit-anchors-only ethos as the drift detector).
 *
 * Pure over a Decision[] — no store, no IO — so the CLI, the MCP read tool, and the
 * session-start orientation all share one source of truth.
 */
import type { Decision } from "./types.js";
import { topicCollisions } from "./topics.js";
import { liveRewrites, deadRewrites, commitRepairReviewHash, firstFor, type CommitRewrite } from "./commitrepair.js";
import { importedAdrReviewHash, importedAdrSourceHash, pendingImportedAdrReviews } from "./importReview.js";

export type EscalationKind = "topic-conflict" | "imported-adr-review" | "policy-candidate" | "policy-proposal" | "policy-repaired" | "premise-stale" | "commit-repair-pending";

export interface Escalation {
  kind: EscalationKind;
  /** the topic (or other key) the conflict is about. */
  topic: string;
  /** the decisions the human must choose between. */
  decisionIds: string[];
  /** a one-line, human-facing question the assistant should raise in the prompt. */
  question: string;
  /** the supporting detail (ids + titles) for the question. */
  detail: string;
  /** the concrete resolution the human's answer maps to. */
  resolution: string;
  /** false ONLY for an entry whose own resolution requires acting on a
   *  DIFFERENT entry first (a duplicate-id queue's non-drop, non-apply
   *  follower) — it still surfaces, for transparency, but gating surfaces
   *  (CI exit code, "needs your call" tallies) must not count it: resolving
   *  the actionable entry ahead of it is what clears it, not anything a
   *  human can do to this row directly (#61). Omitted (undefined) means
   *  true — every other escalation kind is always directly actionable. */
  actionable?: boolean;
}

/** Escalations gating surfaces (CI exit codes, "needs your call" counts/lists)
 *  should act on: everything except an entry explicitly marked
 *  actionable:false (#61). The full list — including non-actionable
 *  entries — still belongs in any transparency-facing output (e.g. --json). */
export function actionableEscalations(items: readonly Escalation[]): Escalation[] {
  return items.filter((e) => e.actionable !== false);
}

export interface EscalationSummary {
  /** the subset a gating surface should count/exit/ask on. */
  actionable: Escalation[];
  /** how many entries were filtered out — informational-only, shown for
   *  transparency but not itself a decision to raise. */
  context: number;
}

/** One computation for every "N need your call (+M shown for context)"
 *  consumer (CLI `escalations`, SessionStart, the `hunch_now`/`hunch_escalations`
 *  MCP tools) — introduced alongside `actionable` (#61) specifically so a
 *  future consumer of Escalation[] can't repeat the mistake of hand-rolling
 *  the filter and forgetting it (the VS Code panel did, before this existed). */
export function summarizeEscalations(items: readonly Escalation[]): EscalationSummary {
  const actionable = actionableEscalations(items);
  return { actionable, context: items.length - actionable.length };
}

/** "you" (the CLI, talking directly to the operator) vs "mcp" (an assistant
 *  relaying a question to the human, third person). */
export type EscalationAudience = "cli" | "mcp";

/** The ONE "N need your call (+M shown for context)" headline, shared by the
 *  CLI `escalations` command and the `hunch_escalations` MCP tool (#61) —
 *  including its own "nothing actionable, but N item(s) queued for context"
 *  fallback, so that unreachable-today prose exists in exactly one place
 *  instead of being hand-copied per consumer (the copy-paste is how the VS
 *  Code panel missed the filter entirely before `actionable` existed).
 *  Callers are expected to have already special-cased `items.length === 0`
 *  (a plainer "nothing needs your decision" message, no tally at all). */
export function escalationHeadline(items: readonly Escalation[], audience: EscalationAudience): string {
  const { actionable, context } = summarizeEscalations(items);
  if (actionable.length) {
    const call = audience === "cli" ? "your call — asked here, never decided for you" : "the human's call — ask each inline, don't decide it for them";
    const note = audience === "cli" ? "not gating" : "not a decision";
    return `${actionable.length} decision(s) need ${call}${context ? ` (+${context} shown below for context only, ${note})` : ""}:`;
  }
  const whose = audience === "cli" ? "your decision" : "the human's call";
  return `Nothing needs ${whose} right now — ${items.length} entr${items.length === 1 ? "y" : "ies"} shown below for context only (resolving another entry will clear them):`;
}

/** The decisions a human must make NOW, to be asked INLINE. Empty in a healthy graph. */
export function pendingEscalations(decisions: readonly Decision[]): Escalation[] {
  const out: Escalation[] = [];
  for (const [topic, decs] of topicCollisions(decisions)) {
    out.push({
      kind: "topic-conflict",
      topic,
      decisionIds: decs.map((d) => d.id),
      question: `Topic "${topic}" has ${decs.length} live decisions — which one is current?`,
      detail: decs.map((d) => `${d.id} — "${d.title}"`).join("  ·  "),
      resolution: `supersede the others: re-record the chosen one with supersedes:<other-id>, or split the topic.`,
    });
  }
  // Imported ADRs are immediately useful as advisory memory, but reading a file
  // cannot mint human authority. Ask about exactly one at a time in ordinary
  // session orientation; once answered, the next one naturally surfaces.
  const imported = pendingImportedAdrReviews(decisions);
  const next = imported[0];
  if (next) {
    const sourceHash = importedAdrSourceHash(next)!;
    const reviewHash = importedAdrReviewHash(next);
    const sourcePath = next.related_files[0] ?? "its ADR source";
    const remaining = imported.length - 1;
    const clip = (value: string, max: number): string => value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value;
    out.push({
      kind: "imported-adr-review",
      topic: next.topic ?? next.id,
      decisionIds: [next.id],
      question: `I imported ADR “${clip(next.title, 90)}” (${next.id}) as advisory memory. Approve it as human-confirmed project authority, or decline and keep it advisory?`,
      detail: `${sourcePath} · source ${sourceHash} · review ${reviewHash} · ${clip(next.decision, 180)}${remaining ? ` · ${remaining} more imported ADR(s) will follow one at a time` : ""}`,
      resolution: `after the human answers, call hunch_review_imported_adr with decision_id=${next.id}, expected_source_hash=${sourceHash}, expected_review_hash=${reviewHash}, and disposition=approve|decline; CLI: hunch review --approve-import|--decline-import ${next.id} --expected-source-hash ${sourceHash} --expected-review-hash ${reviewHash} --reviewed-by <you>`,
    });
  }
  return out;
}

/** A commit-provenance repair the post-merge hook detected and queued
 *  (src/core/repairqueue.ts) but never applied — the match signal (related_files
 *  overlap) isn't strong enough to write unattended, so it's a question for the
 *  human, exactly like every other entry here, never a silent write.
 *
 *  `decisions` is the caller's VISIBLE scope (supplies the title only) —
 *  MCP/SessionStart pass store.advisoryRecs(), which is public-only in
 *  private mode. `live` is the scope liveRewrites checks the repair against;
 *  it defaults to `decisions` but callers on an advisory scope must pass the
 *  FULL store (store.recs()) here, since repair-provenance itself reads the
 *  full store — an overlay decision's repair is fully answerable even where
 *  its title isn't visible, and must not go silent just because the title is
 *  private.
 *
 *  `withheld` (from repairqueue.ts's withheldRewrites — a git-facing check
 *  this module deliberately stays free of, so the caller runs it and passes
 *  the result in) names entries whose proposed `to` doesn't resolve to a
 *  real commit here. `--apply --only <id>` can never resolve one of these —
 *  advertising it as the answer would be advice guaranteed to no-op
 *  forever, which is worse than not asking at all. Such an entry still
 *  needs a human (only `--drop` can retire it), so it still escalates, just
 *  with wording that doesn't promise `--apply` will help.
 *
 *  Keyed by OBJECT, not by id, matching withheldForUnresolvableTo's own
 *  contract: a corrupted queue file can carry two entries sharing an id
 *  (one resolvable, one not) — an id-keyed set couldn't tell them apart and
 *  would wrongly tag the resolvable sibling as unresolvable too. Every
 *  caller of this function already passes the SAME `queued` array to both
 *  this function and withheldRewrites, so identity holds. */
export function commitRepairEscalations(queued: readonly CommitRewrite[], decisions: readonly Decision[], live: readonly Decision[] = decisions, withheld: ReadonlySet<CommitRewrite> = new Set()): Escalation[] {
  const reviewHash = commitRepairReviewHash(queued, withheld);
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  // Mirrors two of the three queue transformations --apply/--drop actually see
  // (src/cli/index.ts): dead entries (deadRewrites) are pruned via `save()`
  // before either command ever reads `queue`, so a duplicate-id check against
  // the RAW `queued` array can name an entry that's already gone by the time a
  // human acts (#59). Deliberately does NOT model the fresh-detection merge
  // (mergeRewrites) that also runs before either command: a fresh match can
  // silently evict firstFor(queue, id) with no tombstone. That gap predates
  // this fix (see #56) and isn't new here — it just means a queue whose first
  // entry is about to be evicted by a fresh match still reads as the ordinary,
  // ask-normally case rather than something rarer.
  // deadRewrites (below) and liveRewrites (in the return) are BOTH called with
  // this same `live` array, so for any one id they agree on the same single
  // decision (or the same absence) governing it. That decision's `commit`/
  // `status` are fixed for the whole id-group — only each entry's OWN `from`
  // varies — so liveRewrites' and deadRewrites' predicates are exact
  // complements entry-by-entry (never uniform across the group: two entries
  // sharing an id can freely land on opposite sides, see the "dead first
  // sibling" test, #59). `survivors` (queued minus dead) restricted to one id
  // is therefore exactly that id's live entries, in the same queue order.
  // Consequence relied on below (#61): the FIRST live entry per id is always
  // `dropTarget(id)`, so it always stays actionable — no id-group's
  // escalations can ever be entirely actionable:false.
  const deadSet = new Set(deadRewrites(queued, live));
  const survivors = queued.filter((q) => !deadSet.has(q));
  // What `--drop <id>` targets (src/cli/index.ts: `firstFor(queue, opts.drop)`
  // on the post-prune queue) — --drop doesn't care whether an entry's `to`
  // resolves, so a withheld entry can still be the drop target.
  const dropTarget = (id: string): CommitRewrite | undefined => firstFor(survivors, id);
  // What `--apply --only <id>` targets: its plan is built from
  // withheldForUnresolvableTo's `applicable` half (src/cli/index.ts:
  // `plan.rewrites = applicable`), which excludes withheld entries entirely —
  // so the apply-target can differ from the drop-target when an earlier
  // survivor for the same id is withheld. Routed through the shared `firstFor`
  // rather than hand-rolled, so this can't independently drift from
  // commitrepair.ts's own first-match rule (already drifted three times
  // across call sites there — #51/#53/#56 — before firstFor consolidated it).
  const applyTarget = (id: string): CommitRewrite | undefined => firstFor(survivors.filter((q) => !withheld.has(q)), id);
  return liveRewrites(queued, live)
    .map((r) => {
      const title = byId.get(r.id)?.title;
      const named = `${r.id}${title ? ` ("${title}")` : ""}`;
      const base = { kind: "commit-repair-pending" as const, topic: r.id, decisionIds: [r.id], detail: `${r.from} → ${r.to}` };
      const applyQuestion = `${named}'s commit is no longer reachable from HEAD (likely squash-merged away), and one newly-merged commit touches all its related files — apply the proposed replacement?`;
      const isDropTarget = dropTarget(r.id) === r;
      const isApplyTarget = applyTarget(r.id) === r;
      if (!isDropTarget && !isApplyTarget) {
        // A duplicate-id queue (corrupted file, hand edit, or a bug upstream —
        // #53/#55/#56/#58): an earlier survivor for this id is what BOTH
        // commands would act on, never this entry (#59). If this entry is
        // itself withheld, say so too — that fact doesn't disappear just
        // because it's also unreachable by id right now, and it stays
        // drop-only even once it's next in line (never permanently: a fresh
        // detection run can still supersede it with a resolvable match, same
        // as the ordinary withheld branch below).
        const alsoWithheld = withheld.has(r)
          ? " — and its own proposed replacement doesn't resolve here either, so even once it's next in line it stays drop-only unless a fresh detection run supersedes it with a resolvable match"
          : "";
        return {
          ...base,
          actionable: false,
          question: `${named} has a further queued replacement candidate (${r.from} → ${r.to}) sitting behind another entry for the same decision — leave it queued for now?`,
          // Dropping the entry ahead brings this one back into play on the next
          // run (deadRewrites can no longer see a reason to prune it). Applying
          // it does the OPPOSITE for this entry: repairDecisionCommit moves the
          // decision's `commit` past the `from` both entries share, so the next
          // run's deadRewrites prunes THIS entry as stale — it is never
          // reconsidered, not "resolved the normal way".
          resolution: `not directly actionable by id right now: \`hunch repair-provenance --apply --only ${r.id} --expect ${reviewHash}\`/\`hunch repair-provenance --drop ${r.id} --expect ${reviewHash}\` both act on an entry queued ahead of it, never this one${alsoWithheld}. Dropping that entry brings this one back into consideration on the next run; applying it instead retires this one as stale, since the decision moves past the \`from\` both entries share.`,
        };
      }
      if (!isDropTarget) {
        // isApplyTarget is true here: this entry IS what --apply --only would
        // apply, but an earlier, WITHHELD sibling for the same id sits ahead
        // of it, so --drop <id> would tombstone that sibling instead (#59).
        return {
          ...base,
          question: applyQuestion,
          resolution: `hunch repair-provenance --apply --only ${r.id} --expect ${reviewHash} to accept just this one — but \`--drop ${r.id}\` won't reject THIS entry: an earlier queued sibling for the same id (whose own replacement doesn't resolve here) sits ahead of it and would be tombstoned instead.`,
        };
      }
      if (!isApplyTarget) {
        // isDropTarget is true here, so this can only mean withheld.has(r):
        // a non-withheld first survivor is always its own apply-target too
        // (nothing withheld can precede it if it isn't withheld itself), so
        // isDropTarget && !isApplyTarget and "withheld" are the same fact.
        return {
          ...base,
          question: `${named}'s commit is no longer reachable from HEAD (likely squash-merged away), and the queued replacement commit doesn't resolve in this repository (corrupted queue entry, or the commit has since been garbage-collected) — reject it?`,
          resolution: `this entry can never be applied as-is — \`hunch repair-provenance --apply\` will leave it queued every run; \`hunch repair-provenance --drop ${r.id} --expect ${reviewHash}\` to reject it, or wait for a fresh match to supersede it`,
        };
      }
      return {
        ...base,
        question: applyQuestion,
        resolution: `hunch repair-provenance --apply --only ${r.id} --expect ${reviewHash} to accept just this one, hunch repair-provenance --drop ${r.id} --expect ${reviewHash} to reject it (tombstoned durably — this same match won't resurface, though a genuinely different candidate still can), or leave it queued to decide later`,
      };
    });
}

/** The minimal policy shape the escalation scan needs — a structural subset of
 *  constitution PolicySpec, so this module stays dependency-free of the
 *  Constitution schemas (core must not import constitution). */
export interface PolicyLite {
  id: string;
  state: string;
  statement: string;
  proof: string | null;
  authority: unknown;
  activation_gate?: { kind: string; status: string; reason: string } | null;
  /** the policy's most recent audit action, when the caller has it — lets the
   *  scan surface auto-repaired policies that need a fresh proof. */
  last_action?: string | null;
}

/** The Constitution's genuine human moments (§59.5.3), framed as inline questions:
 *  a candidate awaiting review, and a proposed policy whose next step (prove, or
 *  accept/reject) is a human call. Machine conclusions never appear here as
 *  approvals — every entry is a QUESTION with its explicit resolution verb. */
export function policyEscalations(policies: readonly PolicyLite[]): Escalation[] {
  const out: Escalation[] = [];
  const clip = (s: string): string => (s.length > 90 ? s.slice(0, 89).trimEnd() + "…" : s);
  for (const p of policies) {
    // An auto-repaired policy asks FIRST (and only once): its bindings moved, so
    // its proof is stale by construction — the human moment is "re-prove it".
    if (p.last_action === "repaired" && (p.state === "proposed" || p.state === "active_advisory" || p.state === "active_blocking")) {
      out.push({
        kind: "policy-repaired",
        topic: p.id,
        decisionIds: [p.id],
        question: `Rule "${clip(p.statement)}" (${p.id}) was auto-repaired after a rename — its proof is stale; re-prove it?`,
        detail: `state ${p.state} · last action repaired · ${p.proof ? `proof ${p.proof} (stale)` : "no proof"}`,
        resolution: `hunch policy prove ${p.id} — blocking stays fail-safe until the fresh proof lands`,
      });
      continue;
    }
    if (p.state === "compiled" || p.state === "validating") {
      out.push({
        kind: "policy-candidate",
        topic: p.id,
        decisionIds: [p.id],
        question: `Candidate rule "${clip(p.statement)}" (${p.id}) awaits your review — keep it moving or reject it?`,
        detail: `state ${p.state} · authority none · not yet proved`,
        resolution: `hunch policy prove ${p.id} — then accept/reject; or hunch policy reject ${p.id} --reason "..."`,
      });
    } else if (p.state === "proposed") {
      if (p.activation_gate?.status === "blocked") {
        out.push({
          kind: "policy-proposal",
          topic: p.id,
          decisionIds: [p.id],
          question: `Proposed rule "${clip(p.statement)}" (${p.id}) is ready for review but mechanically blocked from activation — keep it as evidence?`,
          detail: `state proposed · ${p.proof ? `proof ${p.proof}` : "no proof"} · authority none · activation gate ${p.activation_gate.kind}`,
          resolution: `inspect: hunch policy card ${p.id} — activation remains unavailable until the source-currentness gate is implemented and cleared`,
        });
        continue;
      }
      out.push({
        kind: "policy-proposal",
        topic: p.id,
        decisionIds: [p.id],
        question: p.proof
          ? `Proposed rule "${clip(p.statement)}" (${p.id}) carries its proof — activate it (advisory/blocking) or reject it?`
          : `Proposed rule "${clip(p.statement)}" (${p.id}) has no current proof — prove it, then decide.`,
        detail: `state proposed · ${p.proof ? `proof ${p.proof}` : "no proof"} · authority none`,
        resolution: p.proof
          ? `inspect: hunch policy card ${p.id} — then hunch policy accept ${p.id} --advisory|--blocking --actor human:<you>, or reject`
          : `hunch policy prove ${p.id}`,
      });
    }
  }
  return out;
}
