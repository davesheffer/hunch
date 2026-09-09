/**
 * Grounding-block freshness classification (fnd_c402046ac7).
 *
 * The committed grounding docs (CLAUDE.md, AGENTS.md, copilot-instructions,
 * hunch.mdc, hunch.md) carry a managed block whose first sentence states the
 * public store's RECORD COUNTS. Those counts are a pure function of .hunch/*.json,
 * so two branches that each capture one decision both regenerate the very same
 * "N+1 decisions" line. Git merges identical lines silently, the merged store holds
 * N+2, and the committed doc is one behind — with no conflict, no hook (the merge
 * happened on the forge) and no human error. Every release-gate red of that class
 * (PR #128, #135, v1.26.2's first run) was this lag.
 *
 * The lag is transient and self-healing: the next capture commit folds the
 * regenerated docs in (refreshCommittableGrounding), and the release gate's
 * repository-index stage regenerates them in the worktree and already treats the
 * dirt as memory churn. What must STILL fail is a doc that is genuinely wrong:
 *
 *   - prose in the block differs (a hand edit, a stale renderer, a template change);
 *   - an append-only count is AHEAD of the store: the doc counted a record the
 *     repository does not carry — the never-committed Video component of
 *     fnd_6391b4242f, the only defect the counts ever caught.
 *
 * So the rule is direction-aware and deterministic: decisions, bugs, constraints,
 * components and policies only accrue, so a doc may lag behind them (merge) but never
 * run ahead (missing record). Open findings move both ways (a finding resolved on one
 * branch, a finding recorded on another), so a differing findings count alone is lag.
 */

const COUNTS_RE = /\*\*(\d+) decisions?, (\d+) bugs?, (\d+) constraints?, (\d+) components?, (\d+) polic(?:y|ies)(?:, (\d+) open findings?)?\*\*/;

export interface GroundingCounts {
  decisions: number;
  bugs: number;
  constraints: number;
  components: number;
  policies: number;
  findings: number;
}

/** Record kinds whose committed count may only ever lag behind the store. */
export const APPEND_ONLY_COUNT_KINDS = ["decisions", "bugs", "constraints", "components", "policies"] as const;

export function parseGroundingCounts(block: string): { counts: GroundingCounts; match: string } | null {
  const m = COUNTS_RE.exec(block);
  if (!m) return null;
  return {
    match: m[0],
    counts: {
      decisions: Number(m[1]),
      bugs: Number(m[2]),
      constraints: Number(m[3]),
      components: Number(m[4]),
      policies: Number(m[5]),
      findings: m[6] === undefined ? 0 : Number(m[6]),
    },
  };
}

export type GroundingFreshness =
  /** Byte-identical managed block. */
  | { kind: "fresh" }
  /** Only the counts sentence differs and no append-only count is ahead of the
   *  store: records merged in behind the doc. Heals on the next capture or
   *  `hunch grounding --refresh`; never a release blocker. */
  | { kind: "lagging"; committed: GroundingCounts; generated: GroundingCounts; behind: string[] }
  /** An append-only count in the committed doc exceeds the store: the doc knows a
   *  record the repository does not carry (never committed, or pruned by hand). */
  | { kind: "ahead"; committed: GroundingCounts; generated: GroundingCounts; ahead: string[] }
  /** The block differs outside the counts sentence (or a counts sentence is missing). */
  | { kind: "diverged"; reason: string };

/** Classify a committed managed block against the one the graph generates NOW.
 *  Both inputs are block CONTENT (markers stripped, trimmed). */
export function classifyGroundingBlock(committed: string, generated: string): GroundingFreshness {
  if (committed === generated) return { kind: "fresh" };
  const c = parseGroundingCounts(committed);
  const g = parseGroundingCounts(generated);
  if (!c) return { kind: "diverged", reason: "the committed block carries no record-counts sentence" };
  if (!g) return { kind: "diverged", reason: "the generated block carries no record-counts sentence" };
  const withoutCounts = (text: string, match: string): string => text.replace(match, "<counts>");
  if (withoutCounts(committed, c.match) !== withoutCounts(generated, g.match)) {
    return { kind: "diverged", reason: "the block differs outside the record-counts sentence" };
  }
  const ahead = APPEND_ONLY_COUNT_KINDS.filter((k) => c.counts[k] > g.counts[k]);
  if (ahead.length) return { kind: "ahead", committed: c.counts, generated: g.counts, ahead };
  const behind = (Object.keys(g.counts) as Array<keyof GroundingCounts>).filter((k) => c.counts[k] !== g.counts[k]);
  return { kind: "lagging", committed: c.counts, generated: g.counts, behind };
}

/** One human line per verdict — shared by the freshness test and `hunch grounding`. */
export function describeGroundingFreshness(doc: string, verdict: GroundingFreshness): string {
  const delta = (a: GroundingCounts, b: GroundingCounts, kinds: string[]): string =>
    kinds.map((k) => `${k} ${a[k as keyof GroundingCounts]} → ${b[k as keyof GroundingCounts]}`).join(", ");
  switch (verdict.kind) {
    case "fresh":
      return `${doc}: fresh`;
    case "lagging":
      return `${doc}: counts lag the store (${delta(verdict.committed, verdict.generated, verdict.behind)}) — records merged in behind the doc; heals on the next capture or \`hunch grounding --refresh\``;
    case "ahead":
      return `${doc}: counts run AHEAD of the store (${delta(verdict.committed, verdict.generated, verdict.ahead)}) — the doc counted a record this repository does not carry; commit the missing .hunch/ record or regenerate`;
    case "diverged":
      return `${doc}: stale — ${verdict.reason}; regenerate with \`hunch grounding --refresh\` and commit`;
  }
}
