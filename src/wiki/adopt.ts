/**
 * Doc adoption — the wiki TAKES OVER a stale doc. When the specs ledger grades
 * a doc "stale" (do-not-trust), `hunch wiki` copies it into `<wiki>/docs/` as a
 * WIKI-MANAGED page and heals the COPY against the graph:
 *
 *   - every pin to a superseded decision is RE-PINNED to the current one,
 *   - a "graph correction" callout is injected right after each healed pin,
 *     quoting the current decision (and what it rejected) so the stale prose
 *     below it can be read safely,
 *   - non-pin issues (proposed-but-shipped, dead code refs) surface in a
 *     banner at the top.
 *
 * The ORIGINAL file is never touched — "Hunch never rewrites prose" applies to
 * the user's files; the adopted copy is a generated artifact (hunch:wiki
 * header), so healing it is regeneration, not prose-rewriting. From adoption
 * on, the ledger and component pages route readers to the wiki copy; the copy
 * is freshness-hashed over its INPUTS (source content + the current decision
 * per pinned topic + issues), so a source edit or a graph move re-heals it,
 * and a source doc that becomes grounded again (human healed the original) or
 * disappears retires the copy automatically.
 *
 * Deterministic by construction: same source + same graph → byte-identical
 * copy. No LLM anywhere in this path.
 */
import { createHash } from "node:crypto";
import type { Decision } from "../core/types.js";
import type { RepoDoc } from "../core/docscan.js";
import { parseDocAnchors } from "../core/docanchors.js";
import { currentForTopic, rejectedForTopic } from "../core/topics.js";

/** Page slug for an adopted doc: full rel path, kebab-cased ("docs/api-v2.md" →
 *  "docs-api-v2"). Kebab-casing can collide across DIFFERENT rels ("docs/api-v2.md"
 *  vs "docs-api/v2.md"), so a `taken` set disambiguates with a short content hash
 *  of the rel — deterministic, and wikiStatus is the single caller that assigns
 *  slugs (renderers receive the resulting paths; they never re-derive). */
export function adoptedSlug(rel: string, taken: Set<string>): string {
  let slug = rel.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "doc";
  if (taken.has(slug)) slug = `${slug}-${createHash("sha256").update(rel).digest("hex").slice(0, 6)}`;
  taken.add(slug);
  return slug;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** The freshness hash of an adopted copy: source content + what the graph
 *  currently says for each pinned topic (everything the renderer quotes,
 *  including rejected alternatives) + the grade's issues. Any of these moving
 *  re-heals the copy; the copy's own bytes are never an input. */
export function adoptionHash(content: string, decisions: readonly Decision[], doc: RepoDoc): string {
  const topical = doc.topics.map((t) => {
    const cur = currentForTopic(decisions, t);
    return {
      topic: t,
      current: cur ? { id: cur.id, decision: cur.decision, title: cur.title } : null,
      rejected: rejectedForTopic(decisions, t),
    };
  });
  return createHash("sha256")
    .update(JSON.stringify({ content, topical, issues: doc.issues }))
    .digest("hex").slice(0, 16);
}

/** Prompt for the optional PROSE-HEAL tier (dec roadmap.adoption-prose-heal):
 *  a subscription-CLI rewrite of what the stale doc SHOULD say now. The output
 *  is garnish on the deterministic skeleton — never hashed, never a substitute
 *  for the graph corrections rendered below it. */
export function adoptProsePrompt(doc: RepoDoc, content: string, decisions: readonly Decision[]): string {
  const topical = doc.topics
    .map((t) => {
      const cur = currentForTopic(decisions, t);
      return cur ? `topic "${t}" → CURRENT decision ${cur.id} — ${cur.title}: ${clip(cur.decision, 400)}` : null;
    })
    .filter((x): x is string => !!x);
  return `You are the documentation engine of an Engineering Memory OS. A repo doc went STALE
against the decision graph. Write the short RECONCILED version: what this doc should say NOW,
grounded ONLY in the current decisions below — never invent behavior, cite decision ids inline
like (dec_xxx). Plain markdown paragraphs, no headings or lists, 100-180 words.

## The stale doc (${doc.rel})
${content.slice(0, 4000)}

## Current decisions for its topics
${topical.join("\n") || "(none — the doc is stale for non-pin reasons: " + doc.issues.join("; ") + ")"}

Write the reconciled version now.`;
}

/** Render the wiki-managed copy of a stale doc, healed against the graph.
 *  `reconciled` (optional, LLM prose-heal) slots in under the banner; the
 *  deterministic corrections below remain the authoritative layer. */
export function renderAdoptedDoc(doc: RepoDoc, content: string, decisions: readonly Decision[], reconciled: string | null = null): string {
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  const lines = content.split("\n");
  const out: string[] = [];

  out.push(`<!-- hunch:wiki doc:${doc.rel} — ADOPTED wiki-managed copy of \`${doc.rel}\`, healed against the graph by \`hunch wiki\`. The original graded stale and is preserved untouched; treat THIS page as the readable version. Do not edit by hand — edit the graph (or heal the original), then \`hunch wiki --heal\`. -->`);
  out.push(`> ⚠ **Wiki-managed copy.** The original \`${doc.rel}\` no longer matches the decision graph and was adopted here. Pins below are healed to CURRENT decisions; corrections are inline. Heal the original to release it back (the copy retires automatically).`);
  // Every grading issue is listed — a dangling pin with NO current successor gets
  // no inline correction below, so the banner is its only visible explanation.
  for (const i of doc.issues) out.push(`> - ${i}`);
  out.push("");
  if (reconciled) {
    out.push("## 🩹 Reconciled overview", "", reconciled.trim(), "", "_LLM-drafted from the current decisions (subscription); the graph corrections below are the deterministic, authoritative layer._", "");
  }

  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const raw of lines) {
    // Heal EVERY stale pin on the line, and only inside its own marker — a bare
    // decision id in the surrounding prose must never be rewritten.
    let line = raw;
    const corrections: string[] = [];
    for (const a of parseDocAnchors(raw)) {
      if (!a.pin) continue;
      const pinned = byId.get(a.pin);
      const current = currentForTopic(decisions, a.topic);
      const pinIsStale = (!pinned || pinned.status === "superseded" || !!pinned.superseded_by) && current && current.id !== a.pin;
      if (!pinIsStale || !current) continue;
      line = line.replace(
        new RegExp(`(hunch:topic\\s+${escapeRe(a.topic)}\\s+)${escapeRe(a.pin)}(?![A-Za-z0-9])`),
        `$1${current.id}`,
      );
      corrections.push(`> **🧭 Graph correction** — this section was written against ${pinned ? `superseded \`${a.pin}\`` : `\`${a.pin}\`, which no longer exists`}. Current decision for \`${a.topic}\` is \`${current.id}\` — **${current.title}**: ${clip(current.decision, 400)}`);
      const rejected = rejectedForTopic(decisions, a.topic);
      if (rejected.length) corrections.push(`> Rejected along the way: ${rejected.slice(0, 3).map((r) => clip(r, 120)).join("; ")}`);
    }
    out.push(line);
    if (corrections.length) out.push(...corrections, "");
  }

  out.push("", "---", "", `_Adopted from \`${doc.rel}\` — a derived, wiki-managed copy. Regenerate: \`hunch wiki --heal\`._`, "");
  return out.join("\n");
}
