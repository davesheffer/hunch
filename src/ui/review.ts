/**
 * `hunch ui` Deliberate, part 1: what in memory deserves a person's judgment, each with its
 * evidence and a recommended move. Pure and model-free: it reuses the drift and topic checks,
 * proposes only, and every move still runs a CLI verb. False duplicates burn trust, so each
 * guard below errs toward showing nothing.
 */
import type { DriftFinding } from "../core/drift.js";
import { dupTerms, jaccard } from "../core/dupdetect.js";
import { isImportedAdrDecision } from "../core/importReview.js";
import { fileLink } from "../core/memoryEdit.js";
import { isLive, topicCollisions } from "../core/topics.js";
import type { Decision, Edge } from "../core/types.js";
import { MAX_ARGV, MAX_LIST } from "./actions.js";
import { globBase, memoryDetail, memoryItems, overlaps, type ComponentRef, type MemoryDetail, type MemoryItem, type MemoryKind, type MemorySource } from "./model.js";

export const REVIEW_KINDS = ["conflict", "stale", "duplicate", "weak"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewRecord {
  id: string;
  kind: MemoryKind;
  title: string;
  text: string;
  why: string;
  files: string[];
  /** The linked paths that no longer exist. */
  missing: string[];
  source: string;
  confidence: number;
  date: string;
  signed: boolean;
  components: ComponentRef[];
}

/** Remove `duplicate` with `reason`, then link what only it had onto `survivor`. */
export interface MergePlan {
  survivor: string;
  duplicate: string;
  reason: string;
  /** Records the replacement on the record that goes, so drift stops reporting it. */
  supersededBy: string | null;
  addFiles: string[];
  addComponents: string[];
  feature: string | null;
  /** Links `link` would refuse on the survivor, so the merge can't carry them. */
  leftBehind: string[];
  /** No Undo, because `restore` would refuse: both hold one topic, or the one going is already marked replaced. */
  oneWay: boolean;
}

export type Recommendation = "merge" | "remove" | "drop-links" | "fix-wording" | null;

export interface ReviewActions {
  /** Keeping it means confirming it: at once for a decision, through its severity for a rule. */
  keep: "confirm" | "review-rule" | null;
  remove: boolean;
  fixWording: boolean;
  merge: MergePlan | null;
  /** The same move the other way round: the person may know better which one stays. */
  swap: MergePlan | null;
  /** Paths `link --remove-file` can drop. */
  dropLinks: string[];
}

export interface ReviewCard {
  key: string;
  kind: ReviewKind;
  claim: string;
  evidence: string[];
  /** Components a change here can reach, the same walk as the Brain trace. */
  reach: number;
  records: ReviewRecord[];
  recommend: Recommendation;
  actions: ReviewActions;
}

export interface ReviewGroup { kind: ReviewKind; total: number; cards: ReviewCard[] }
export interface Review {
  total: number;
  groups: ReviewGroup[];
  /** Git couldn't say which paths are alive, so Stale may be missing cards. */
  gitFailed?: boolean;
}

export interface ReviewInputs {
  drift: readonly DriftFinding[];
  /** Of these paths, the ones the repo still has somewhere; missing from this checkout alone isn't gone. */
  alive(paths: readonly string[]): ReadonlySet<string>;
  /** Whether this record lives in the private overlay; only there can it link a `private:` path. */
  inOverlay?(id: string): boolean;
  /** Cards per kind in the answer; the group's total still counts them all. */
  limit?: number;
}

const CLIP = 600;
const LOW_CONFIDENCE = 0.5;
const NONE: ReviewActions = { keep: null, remove: false, fixWording: false, merge: null, swap: null, dropLinks: [] };

const clip = (s: string): string => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);
const quote = (s: string): string => `"${s.length > 120 ? `${s.slice(0, 120)}…` : s}"`;
const percent = (n: number): string => `${Math.round(n * 100)}%`;

/** A conventional-commit prefix and a trailing PR number say nothing about the choice. */
export function normalizeTitle(title: string): string {
  return title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").replace(/\s*\(#\d+\)\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}
// dupTerms drops these, so "X must be" and "X must never be" would otherwise look identical.
const polarity = (text: string): string => [...new Set(text.toLowerCase().match(/\b(?:never|not|no|without|cannot)\b|\b\w+n't\b/g) ?? [])].sort().join();
// dupTerms drops digits too, so "release 1.40.1" and "release 1.41.0" would match.
const numbers = (text: string): string => [...new Set(text.replace(/\(#\d+\)/g, "").match(/\d+(?:\.\d+)*/g) ?? [])].sort().join();

// The shapes the deterministic fallback writes (src/synthesis/provider.ts draftDecision).
const TEMPLATE_DECISION = /^(?:Changed|Introduced|Removed|Refactored) (?:(?:code|content) in .+\(\d+ file\(s\)\)\.$|(?:the repo|[\w./-]+(?:, [\w./-]+)*): )/;
const TEMPLATE_WHY = /^(?:Touched \d+ file\(s\) across |What changed: )/;
// A commit message's sign-offs say who, not why.
const TRAILERS = /^(?:Co-Authored-By|Signed-off-by): .*$/gim;
const isCommitDerived = (source: string, text: string): boolean => source.split("+").includes("inferred") && TEMPLATE_DECISION.test(text);
const hasNoWhy = (why: string): boolean => !why.trim() || TEMPLATE_WHY.test(why.trim());

const fieldOf = (d: MemoryDetail, name: string): string => d.actions.fields.find((f) => f.name === name)?.value ?? "";
const keepOf = (d: MemoryDetail): ReviewActions["keep"] => (!d.actions.confirmable ? null : d.kind === "rule" ? "review-rule" : "confirm");
const whyOf = (d: MemoryDetail): string => fieldOf(d, "context") || fieldOf(d, "rationale") || (d.sections.find((s) => s.label === "Root cause")?.text ?? "");

/** How many components a change to any of these can reach, not counting themselves. Cycle-safe. */
function reachWalker(src: MemorySource, edges: readonly Edge[]): (ids: readonly string[]) => number {
  const live = new Set(src.components.filter((c) => c.status === "active").map((c) => c.id));
  const usedBy = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type !== "depends_on" || e.from === e.to || !live.has(e.from) || !live.has(e.to)) continue;
    if (!usedBy.has(e.to)) usedBy.set(e.to, new Set());
    usedBy.get(e.to)!.add(e.from);
  }
  return (ids) => {
    const starts = ids.filter((id) => live.has(id));
    const seen = new Set(starts), queue = [...seen];
    for (let i = 0; i < queue.length; i++) for (const u of usedBy.get(queue[i]!) ?? []) if (!seen.has(u)) { seen.add(u); queue.push(u); }
    return seen.size - new Set(starts).size;
  };
}

/** Who stays: signed, then more confident, then older, then the lower id. */
function stays(a: MemoryDetail, b: MemoryDetail): [MemoryDetail, MemoryDetail] {
  const order = Number(b.actions.signed) - Number(a.actions.signed) || b.confidence - a.confidence || a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
  return order <= 0 ? [a, b] : [b, a];
}

const shared = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => b.some((y) => overlaps(x, y)));

/** Only what `link` will take: the duplicate goes first, so a refused link would leave half a merge. */
function mergePlan(survivor: MemoryDetail, duplicate: MemoryDetail, reason: string, inOverlay: (id: string) => boolean, known: ReadonlySet<string>): MergePlan {
  const links = survivor.kind === "decision";
  const home = inOverlay(survivor.id) ? "private" : "public";
  const extraFiles = duplicate.files.filter((f) => !survivor.files.includes(f));
  const feature = links && !survivor.feature ? duplicate.feature : null;
  // One `link` call must clear the route's limits too: its id, flags and feature, then what fits.
  let room = MAX_ARGV - 1_000 - (feature?.length ?? 0);
  const fits = (flag: string) => (value: string): boolean => (room -= flag.length + value.length + 2) >= 0;
  const addFiles = extraFiles.filter((f) => fileLink(f, home).ok).slice(0, MAX_LIST).filter(fits("--add-file"));
  const extraComponents = links ? duplicate.components.filter((c) => c.source === "recorded" && !survivor.components.some((s) => s.id === c.id && s.source === "recorded")).map((c) => c.id) : [];
  const addComponents = extraComponents.filter((id) => known.has(id)).slice(0, MAX_LIST).filter(fits("--add-component"));
  return {
    survivor: survivor.id, duplicate: duplicate.id, reason, supersededBy: null, addFiles, addComponents, feature,
    leftBehind: [...extraFiles.filter((f) => !addFiles.includes(f)), ...extraComponents.filter((id) => !addComponents.includes(id))],
    // Topics can't block this restore: Undo takes the topic off the survivor first.
    oneWay: !!duplicate.replacedBy,
  };
}

/** Two answers, not one memory: one goes, and nothing of it moves onto the other. */
const keepOver = (survivor: MemoryDetail, duplicate: MemoryDetail, reason: string, supersededBy: string | null = null): MergePlan => ({
  survivor: survivor.id, duplicate: duplicate.id, reason, supersededBy, addFiles: [], addComponents: [], feature: null, leftBehind: [],
  oneWay: (!!survivor.feature && survivor.feature === duplicate.feature) || !!duplicate.replacedBy,
});

interface Candidate { a: MemoryDetail; b: MemoryDetail; score: number; evidence: string[] }

function duplicatePairs(active: readonly MemoryDetail[], decisions: ReadonlyMap<string, Decision>): Candidate[] {
  const prepared = active.filter((m) => m.kind !== "bug").map((m) => {
    const decision = decisions.get(m.id);
    const body = m.kind === "rule" ? fieldOf(m, "rationale") : m.summary;
    const template = isCommitDerived(m.source, m.summary);
    return { m, decision, norm: normalizeTitle(m.title), titleTerms: dupTerms(normalizeTitle(m.title)), bodyTerms: template ? new Set<string>() : dupTerms(body), body };
  });
  const out: Candidate[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const x = prepared[i]!;
    for (let j = i + 1; j < prepared.length; j++) {
      const y = prepared[j]!;
      if (x.m.kind !== y.m.kind) continue;
      if (x.decision && y.decision) {
        if (x.decision.supersedes === y.m.id || y.decision.supersedes === x.m.id || x.decision.superseded_by === y.m.id || y.decision.superseded_by === x.m.id) continue;
        if (x.decision.topic && y.decision.topic) continue; // Same topic is a conflict; different topics are different questions.
      }
      const equal = x.norm !== "" && x.norm === y.norm;
      const titleScore = equal ? 1 : jaccard(x.titleTerms, y.titleTerms);
      const bodyScore = jaccard(x.bodyTerms, y.bodyTerms);
      if (!equal && titleScore < 0.6 && bodyScore < 0.6) continue;
      // Even an equal title needs shared files: a record can carry another commit's message.
      const overlap = shared(x.m.files, y.m.files);
      if (!overlap.length) continue;
      const evidence: string[] = [];
      let score = 0;
      if (equal) { score = 1; evidence.push(`Same title: ${quote(x.m.title)}`); }
      else {
        if (numbers(x.m.title) !== numbers(y.m.title) || polarity(x.m.title) !== polarity(y.m.title)) continue;
        const byTitle = titleScore >= 0.6 && Math.min(x.titleTerms.size, y.titleTerms.size) >= 3;
        const byBody = bodyScore >= 0.6 && Math.min(x.bodyTerms.size, y.bodyTerms.size) >= 6 && numbers(x.body) === numbers(y.body) && polarity(x.body) === polarity(y.body);
        if (!byTitle && !byBody) continue;
        score = Math.max(byTitle ? titleScore : 0, byBody ? bodyScore : 0);
        if (byTitle) evidence.push(`Titles share ${percent(titleScore)} of their words`);
        if (byBody) evidence.push(`Text shares ${percent(bodyScore)} of its words`);
      }
      evidence.push(`Both linked to ${overlap.slice(0, 3).join(", ")}${overlap.length > 3 ? ` and ${overlap.length - 3} more` : ""}`);
      out.push({ a: x.m, b: y.m, score, evidence });
    }
  }
  return out.sort((p, q) => q.score - p.score || p.a.id.localeCompare(q.a.id) || p.b.id.localeCompare(q.b.id));
}

export function reviewCards(src: MemorySource, edges: readonly Edge[], inputs: ReviewInputs): Review {
  const items = memoryItems(src);
  const details = new Map<string, MemoryDetail>();
  for (const m of items as readonly MemoryItem[]) if (m.active) details.set(m.id, memoryDetail(src, m.id, items)!);
  const decisions = new Map(src.decisions.map((d) => [d.id, d]));
  const walk = reachWalker(src, edges);
  const used = new Set<string>();

  const missingOf = new Map<string, Set<string>>();
  const deadPremises = new Map<string, string[]>();
  const candidates: { id: string; link: string; base: string }[] = [];
  for (const f of inputs.drift) {
    if (!details.has(f.id)) continue;
    if (f.kind !== "dead-ref" && f.kind !== "premise-stale" && f.kind !== "finding-stale") continue;
    if (f.path !== undefined) candidates.push({ id: f.id, link: f.path, base: f.path });
    else { if (!deadPremises.has(f.id)) deadPremises.set(f.id, []); deadPremises.get(f.id)!.push(f.detail.replace(/\. Re-attest.*$/, "").replace(/ — (?:resolve|link) .*$/, "")); }
  }
  // Drift has no check for a rule's scope: its literal paths and glob bases.
  for (const c of src.constraints) {
    if (!details.has(c.id)) continue;
    for (const entry of c.scope) {
      const base = globBase(entry);
      if (!entry.startsWith("private:") && base !== "" && base !== ".") candidates.push({ id: c.id, link: entry, base });
    }
  }
  // Drift already checked a `private:` path against the overlay; git here knows nothing of it.
  const isOverlayPath = (p: string): boolean => p.startsWith("private:");
  const alive = inputs.alive([...new Set(candidates.map((c) => c.base).filter((b) => !isOverlayPath(b)))]);
  for (const { id, link, base } of candidates) {
    if (alive.has(base)) continue;
    if (!missingOf.has(id)) missingOf.set(id, new Set());
    missingOf.get(id)!.add(link);
  }

  const record = (d: MemoryDetail): ReviewRecord => ({
    id: d.id, kind: d.kind, title: clip(d.title), text: d.kind === "rule" ? "" : clip(fieldOf(d, "text")), why: clip(whyOf(d).replace(TRAILERS, "").trim()), files: d.files,
    missing: [...(missingOf.get(d.id) ?? [])], source: d.source, confidence: d.confidence, date: d.date, signed: d.actions.signed,
    components: d.components.map((c) => ({ id: c.id, name: c.name })),
  });
  const card = (kind: ReviewKind, list: readonly MemoryDetail[], claim: string, evidence: string[], recommend: Recommendation, actions: ReviewActions): ReviewCard => {
    for (const d of list) used.add(d.id);
    return { key: `${kind}:${list.map((d) => d.id).join("+")}`, kind, claim, evidence, reach: walk(list.flatMap((d) => d.components.map((c) => c.id))), records: list.map(record), recommend, actions };
  };
  const groups: Record<ReviewKind, ReviewCard[]> = { conflict: [], stale: [], duplicate: [], weak: [] };

  // ---- Conflict: two live decisions answer one question, or a "replaced" one is still live.
  for (const [topic, list] of topicCollisions(src.decisions)) {
    const live = list.map((d) => details.get(d.id)).filter((d): d is MemoryDetail => !!d && !used.has(d.id));
    if (live.length < 2) continue;
    const [survivor, other] = stays(live[0]!, live[1]!);
    groups.conflict.push(card("conflict", live, `${live.length} live decisions answer "${topic}".`, [`Topic: ${topic}`, "Agents should get one answer per topic."], null,
      { ...NONE, merge: keepOver(survivor, other, `Conflicts with ${survivor.id}: ${survivor.title}`), swap: keepOver(other, survivor, `Conflicts with ${other.id}: ${other.title}`) }));
  }
  for (const f of inputs.drift) {
    if (f.kind !== "supersede") continue;
    const newer = details.get(f.id), target = decisions.get(f.id)?.supersedes ?? "";
    const older = details.get(target);
    // A self-supersede has no verb to clear it, so a card would have nothing to click.
    if (!newer || !older || target === f.id || used.has(newer.id) || used.has(older.id)) continue;
    // A person's confirmation outranks a claim nobody confirmed, so that one is theirs to settle.
    const outranked = older.actions.signed && !newer.actions.signed;
    // What `remove --superseded-by` takes: a live successor in the same store. Anything else is a plain remove.
    const newerDecision = decisions.get(newer.id);
    const records = !!newerDecision && isLive(newerDecision) && (inputs.inOverlay?.(newer.id) ?? false) === (inputs.inOverlay?.(older.id) ?? false);
    groups.conflict.push(card("conflict", [newer, older], "One says it replaced the other, but both are live.", [`${newer.id} says it replaces ${older.id}, which is still ${older.status}.`, ...(outranked ? [`${older.id} is confirmed by a person; ${newer.id} is not.`] : [])], outranked ? null : "remove",
      { ...NONE, merge: keepOver(newer, older, `Replaced by ${newer.id}: ${newer.title}`, records ? newer.id : null), swap: keepOver(older, newer, `Kept ${older.id} over this: ${older.title}`) }));
  }

  // ---- Duplicate: greedy, best first. A cluster shows its next pair after this one is settled.
  const inOverlay = inputs.inOverlay ?? (() => false);
  const knownComponents = new Set(src.components.map((c) => c.id));
  for (const pair of duplicatePairs([...details.values()], decisions)) {
    if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
    const [survivor, duplicate] = stays(pair.a, pair.b);
    groups.duplicate.push(card("duplicate", [survivor, duplicate], "These look like the same memory.", pair.evidence, "merge", {
      ...NONE, merge: mergePlan(survivor, duplicate, `Duplicate of ${survivor.id}: ${survivor.title}`, inOverlay, knownComponents), swap: mergePlan(duplicate, survivor, `Duplicate of ${duplicate.id}: ${duplicate.title}`, inOverlay, knownComponents),
    }));
  }

  // ---- Stale and weak share their signals: a stale record also shows why it was weak.
  const weakSignals = (d: MemoryDetail): { commit: boolean; noWhy: boolean; low: boolean; evidence: string[] } | null => {
    if (d.actions.signed || (d.kind !== "decision" && d.kind !== "rule")) return null;
    const decision = decisions.get(d.id);
    if (decision && isImportedAdrDecision(decision)) return null;
    const commit = d.kind === "decision" && isCommitDerived(d.source, d.summary);
    const why = whyOf(d), noWhy = hasNoWhy(why), low = d.confidence < LOW_CONFIDENCE;
    if (!commit && !noWhy && !low) return null;
    return {
      commit, noWhy, low,
      evidence: [
        ...(commit ? [`Written from a commit: ${quote(d.summary)}`] : []),
        ...(noWhy ? [why.trim() ? `The why is a change list: ${quote(why.trim())}` : "The why is empty"] : []),
        ...(low ? [`Confidence ${percent(d.confidence)}, source ${d.source}`] : []),
      ],
    };
  };

  for (const d of details.values()) {
    const premises = deadPremises.get(d.id) ?? [], missing = [...(missingOf.get(d.id) ?? [])];
    if (used.has(d.id) || (!premises.length && !missing.length)) continue;
    // A glob on a decision or finding is never checked, so it counts as still there.
    const allGone = missing.length > 0 && missing.length >= d.files.length;
    const canDrop = missing.length > 0 && !(d.kind === "rule" && allGone);
    const weak = weakSignals(d);
    // A dead link proves the link is dead, not the claim. Removing needs more than that: a record
    // only a commit or a low guess backs, or an observation with no anchor left. Otherwise a person judges.
    const person = d.source.split("+").includes("human_confirmed");
    const removeWorthy = !person && !missing.some(isOverlayPath) && (d.kind === "finding" || (d.kind === "decision" && weak !== null));
    const recommend: Recommendation = premises.length ? null : allGone ? (removeWorthy ? "remove" : null) : canDrop ? "drop-links" : null;
    const claim = premises.length ? "What this memory rests on no longer holds."
      : allGone ? (missing.length === 1 ? `The one thing this links to is gone: ${missing[0]}.` : `All ${missing.length} things this links to are gone.`)
      : `${missing.length} of ${d.files.length} linked paths ${missing.length === 1 ? "is" : "are"} gone.`;
    const evidence = [...premises, ...missing.map((p) => (!isOverlayPath(p) ? `On no branch: ${p}` : inOverlay(d.id) ? `Not in the overlay: ${p}` : `A shared record can't use an overlay path: ${p}`)), ...(weak?.evidence ?? [])];
    groups.stale.push(card("stale", [d], claim, evidence, recommend, {
      ...NONE, keep: keepOf(d), remove: d.actions.removable, fixWording: !d.actions.textLocked, dropLinks: canDrop ? missing : [],
    }));
  }

  // ---- Weak: nothing says this was anyone's choice. Git still holds the commit.
  for (const d of details.values()) {
    if (used.has(d.id)) continue;
    const signals = weakSignals(d);
    if (!signals) continue;
    const claim = signals.commit && signals.noWhy ? "Written from a commit. Nobody said why."
      : signals.commit ? "Written from a commit, not by a person."
      : signals.noWhy ? "Nobody said why." : "Low confidence, and nobody has confirmed it.";
    const fixable = !d.actions.textLocked;
    const recommend: Recommendation = signals.commit && signals.noWhy && signals.low ? "remove" : fixable ? "fix-wording" : null;
    groups.weak.push(card("weak", [d], claim, signals.evidence, recommend, { ...NONE, keep: keepOf(d), remove: d.actions.removable, fixWording: fixable }));
  }

  const limit = inputs.limit ?? Number.POSITIVE_INFINITY;
  const ranked = REVIEW_KINDS.map((kind): ReviewGroup => {
    const cards = groups[kind].sort((a, b) => b.reach - a.reach || a.key.localeCompare(b.key));
    return { kind, total: cards.length, cards: cards.slice(0, limit) };
  });
  return { total: ranked.reduce((n, g) => n + g.total, 0), groups: ranked };
}
