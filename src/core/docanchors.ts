/**
 * Markdown topic anchors — decision-grounding for PROSE (the doc≠graph spoke,
 * extended to the files the ecosystem already funnels team knowledge into:
 * AGENTS.md, CLAUDE.md, docs/*.md).
 *
 * A tracked markdown file declares which decision topic a section describes:
 *
 *   <!-- hunch:topic auth.session -->               grounding only
 *   <!-- hunch:topic auth.session dec_a1b2c3d4e5 --> PINNED: prose written against that decision
 *
 * Deterministic by construction: drift fires ONLY on an explicit pin whose
 * decision has been superseded — never on a semantic guess (the same philosophy
 * as `anchor-stale` in drift.ts). Unpinned markers still ground the pre-edit
 * hook but can never fire drift.
 */
import type { Decision } from "./types.js";
import { currentForTopic, rejectedForTopic } from "./topics.js";

export interface DocAnchor {
  topic: string;
  /** The decision id the prose was written against, or null for an unpinned marker. */
  pin: string | null;
  /** 1-based line of the marker in the document. */
  line: number;
}

const MARKER = /<!--\s*hunch:topic\s+([A-Za-z0-9._/-]+)(?:\s+(dec_[A-Za-z0-9]+))?\s*-->/g;

/** Parse every hunch:topic marker out of a markdown document. */
export function parseDocAnchors(text: string): DocAnchor[] {
  const out: DocAnchor[] = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    out.push({ topic: m[1]!, pin: m[2] ?? null, line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

const clip = (s: string, n = 220): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Pre-edit grounding for a markdown document that carries topic anchors: the
 *  CURRENT decision per declared topic (graph over prose), what it rejected,
 *  and a stale-pin warning the editor can heal inline. Empty when no anchor
 *  resolves to a decision. */
export function renderDocGrounding(anchors: readonly DocAnchor[], decisions: readonly Decision[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (seen.has(a.topic)) continue;
    seen.add(a.topic);
    const current = currentForTopic(decisions, a.topic);
    if (!current) continue;
    let line = `• topic "${a.topic}" → current decision ${current.id} — "${current.title}": ${clip(current.decision)}`;
    const rejected = rejectedForTopic(decisions, a.topic);
    if (rejected.length) line += `\n    rejected: ${rejected.slice(0, 3).map((r) => clip(r, 90)).join("; ")}`;
    // Scan ALL markers for this topic, not just the first: the topic dedupe must not
    // let an earlier unpinned marker swallow a later marker's stale-pin warning.
    const stalePin = anchors.find((x) => x.topic === a.topic && x.pin && x.pin !== current.id)?.pin;
    if (stalePin) {
      line += `\n    ⚠ this section is PINNED to ${stalePin}, which is no longer current — reconcile the prose with ${current.id}, then re-pin.`;
    }
    parts.push(line);
  }
  if (!parts.length) return "";
  return `🧭 Doc-grounding — this document declares topic anchors; the GRAPH is the source of truth. Follow the current decision, update prose to match it:\n${parts.join("\n")}`;
}
