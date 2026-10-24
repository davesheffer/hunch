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
import { pathMatchesGlob } from "./glob.js";

@@CLEANROOM_HOLE_1@@

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
@@CLEANROOM_HOLE_2@@
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

@@CLEANROOM_HOLE_3@@
  const reviewHash = commitRepairReviewHash(queued, withheld);
@@CLEANROOM_HOLE_4@@
          resolution: `not directly actionable by id right now: \`hunch repair-provenance --apply --only ${r.id} --expect ${reviewHash}\`/\`hunch repair-provenance --drop ${r.id} --expect ${reviewHash}\` both act on an entry queued ahead of it, never this one${alsoWithheld}. Dropping that entry brings this one back into consideration on the next run; applying it instead retires this one as stale, since the decision moves past the \`from\` both entries share.`,
@@CLEANROOM_HOLE_5@@
          resolution: `hunch repair-provenance --apply --only ${r.id} --expect ${reviewHash} to accept just this one — but \`--drop ${r.id}\` won't reject THIS entry: an earlier queued sibling for the same id (whose own replacement doesn't resolve here) sits ahead of it and would be tombstoned instead.`,
@@CLEANROOM_HOLE_6@@
          resolution: `this entry can never be applied as-is — \`hunch repair-provenance --apply\` will leave it queued every run; \`hunch repair-provenance --drop ${r.id} --expect ${reviewHash}\` to reject it, or wait for a fresh match to supersede it`,
@@CLEANROOM_HOLE_7@@
        resolution: `hunch repair-provenance --apply --only ${r.id} --expect ${reviewHash} to accept just this one, hunch repair-provenance --drop ${r.id} --expect ${reviewHash} to reject it (tombstoned durably — this same match won't resurface, though a genuinely different candidate still can), or leave it queued to decide later`,
@@CLEANROOM_HOLE_8@@
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

/** What one prompt is about, for task-scoped escalation delivery (dec_12ba37db1c). */
export interface EscalationScope {
  /** the prompt text as the human wrote it. */
  prompt: string;
  /** repo-relative paths the prompt names (taskSelection.promptPaths). */
  paths: readonly string[];
  /** record ids the prompt's task selection put on top, when there is one. */
  selectedIds?: ReadonlySet<string>;
}

const trimSlash = (x: string): string => x.replace(/\/+$/, "");
const samePathOrNested = (x: string, y: string): boolean => {
  const a = trimSlash(x), b = trimSlash(y);
  return !!a && !!b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
};
/** A recorded related path or scope glob vs a path the prompt names. A plain
 *  entry relates both ways by directory nesting; a glob entry matches a path it
 *  covers, or a directory that holds its literal prefix (`src/` ~ `src/store/**`). */
const relatedPathHit = (entry: string, promptPath: string): boolean => {
  if (!/[*?]/.test(entry)) return samePathOrNested(entry, promptPath);
  if (pathMatchesGlob(promptPath, entry)) return true;
  const literal = trimSlash(entry.split("/").filter((_, i, segs) => !segs.slice(0, i + 1).some((s) => /[*?]/.test(s))).join("/"));
  const dir = trimSlash(promptPath);
  return !!literal && !!dir && (literal === dir || literal.startsWith(`${dir}/`));
};
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The prompt's prose without path-like tokens (a `/` or a file extension), so a
 *  file named `escalations.test.ts` is not a question about escalations. */
const proseOnly = (prompt: string): string =>
  prompt.split(/\s+/).filter((t) => { const w = t.replace(/[)\],.;:!?'"`]+$/, ""); return !w.includes("/") && !/\.[a-z0-9]{1,8}$/i.test(w); }).join(" ");

/** The escalations one prompt's task touches. A prompt hook asks the human only
 *  about these; every other entry stays exactly as pending — still listed by
 *  `hunch escalations`, hunch_escalations and hunch_now, never dropped and
 *  never answered for the human. Deterministic explicit anchors only: a
 *  prompt that asks about escalations themselves (path tokens aside), an entry
 *  id or topic the prompt names, an id the task selection chose, or a recorded
 *  anchor path the prompt names (a directory covers the files under it; a glob
 *  covers the paths it matches). `relatedFiles` maps an entry id to its anchor
 *  paths: a decision's related_files, a policy's scope paths/globs. An entry
 *  with no anchor the prompt names stays CLI/MCP-only. */
export function relevantEscalations(
  items: readonly Escalation[],
  scope: EscalationScope,
  relatedFiles: (id: string) => readonly string[],
): Escalation[] {
  const prompt = scope.prompt ?? "";
  if (/(?:^|[^a-z0-9-])escalations?(?:$|[^a-z0-9])/i.test(proseOnly(prompt))) return [...items];
  const lower = prompt.toLowerCase();
  const named = (term: string): boolean => {
    const t = term.trim().toLowerCase();
    if (t.length < 3) return false;
    return new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(t)}(?:$|[^a-z0-9_-])`).test(lower);
  };
  return items.filter((e) =>
    named(e.topic)
    || e.decisionIds.some((id) => named(id) || scope.selectedIds?.has(id))
    || e.decisionIds.some((id) => relatedFiles(id).some((file) => scope.paths.some((p) => relatedPathHit(file, p)))));
}
