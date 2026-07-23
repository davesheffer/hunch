/**
 * Repo-doc scanner — the "specs" half of the doc≠graph spoke. Walks the repo's
 * own markdown (same bounded walk `hunch drift` uses) and grades every doc with
 * a DETERMINISTIC freshness status from signals that already exist:
 *
 *   - grounded   — carries `<!-- hunch:topic … -->` anchors and every pin points
 *                  at the CURRENT decision for its topic: safe to trust.
 *   - stale      — a pin points at a superseded/missing decision, the doc still
 *                  says "proposed / not yet implemented" while referencing shipped
 *                  code, or it references src files that no longer exist.
 *   - unverified — no anchors and no stale signal: Hunch can't vouch either way
 *                  (the honest tier; ground it by adding a topic marker).
 *
 * No semantic guessing and no LLM — same philosophy as drift.ts. The wiki uses
 * these statuses to become the trusted READING surface over the repo's docs
 * (route to grounded prose, warn on stale) without ever rewriting prose.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import type { Decision } from "./types.js";
import { parseDocAnchors } from "./docanchors.js";
import { currentForTopic } from "./topics.js";
import { compareCodeUnits } from "./canonicalOrder.js";

export const STALE_MARKER = /\b(proposed|not yet implemented|no code yet)\b/i;
export const SRC_REF = /\bsrc\/[A-Za-z0-9_\-/]+\.ts\b/g;

const SKIP_DIRS = new Set(["node_modules", ".git", ".hunch", ".hunch-private", "dist", "vscode-extension", "site"]);

/** Bounded walk for repo markdown (root + docs/, depth-limited; heavy/irrelevant trees skipped). */
export function markdownDocs(root: string): Array<{ path: string; rel: string }> {
  const out: Array<{ path: string; rel: string }> = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else if (extname(e.name) === ".md") {
        out.push({ path: join(dir, e.name), rel: rel ? `${rel}/${e.name}` : e.name });
      }
    }
  };
  walk(root, "", 0);
  // Agent-facing prose lives under dot-dirs the general walk skips: skills and
  // commands are exactly the docs that rot against the graph (a skill preaching
  // a superseded decision misleads every future session) — scan them explicitly.
  for (const sub of [".claude/skills", ".claude/commands"]) {
    walk(join(root, sub), sub, 1);
  }
  return out;
}

export type DocStatus = "grounded" | "stale" | "unverified";

export interface RepoDoc {
  /** repo-relative POSIX path. */
  rel: string;
  /** First `# ` heading, or the path when the doc has none. */
  title: string;
  /** Topics the doc declares via hunch:topic markers. */
  topics: string[];
  /** src/*.ts files the doc mentions (the component-association signal). */
  srcRefs: string[];
  status: DocStatus;
  /** Human-readable reasons behind a "stale" grade (empty otherwise). */
  issues: string[];
}

/** Grade every repo doc. GENERATED wiki pages (hunch:wiki header) are views of
 *  the graph, not specs — they are excluded here and freshness-gated by their
 *  own manifest hash instead. */
export function scanRepoDocs(decisions: readonly Decision[], root: string): RepoDoc[] {
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  const out: RepoDoc[] = [];

  for (const doc of markdownDocs(root)) {
    let text: string;
    try {
      text = readFileSync(doc.path, "utf8");
    } catch {
      continue;
    }
    if (text.startsWith("<!-- hunch:wiki ")) continue; // generated view, not a spec

    const anchors = parseDocAnchors(text);
    const topics = [...new Set(anchors.map((a) => a.topic))];
    const srcRefs = [...new Set(text.match(SRC_REF) ?? [])];
    const issues: string[] = [];
    let groundedPins = 0;

    for (const a of anchors) {
      if (!a.pin) continue;
      const pinned = byId.get(a.pin);
      const current = currentForTopic(decisions, a.topic);
      const superseded = !!pinned && (pinned.status === "superseded" || !!pinned.superseded_by);
      if (!pinned) {
        issues.push(`line ${a.line}: pinned to ${a.pin} (topic "${a.topic}"), which does not exist`);
      } else if (superseded && current && current.id !== a.pin) {
        issues.push(`line ${a.line}: pinned to superseded ${a.pin}; current for "${a.topic}" is ${current.id}`);
      } else if (!superseded) {
        groundedPins++;
      }
      // superseded with NO visible successor: this store cannot vouch either way
      // (the successor may live in a private overlay) → neither grounds nor stales,
      // mirroring drift's explicit-pin-plus-live-successor rule.
    }

    if (STALE_MARKER.test(text.slice(0, 1500)) && srcRefs.some((r) => existsSync(join(root, r)))) {
      issues.push("marked proposed/not-implemented but references shipped code");
    }
    const missing = srcRefs.filter((r) => !existsSync(join(root, r)));
    if (missing.length && missing.length === srcRefs.length) {
      // every code reference is gone — the doc describes code that no longer exists
      issues.push(`references only missing files (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`);
    }

    const status: DocStatus = issues.length
      ? "stale"
      : anchors.length && (groundedPins > 0 || anchors.some((a) => !a.pin && currentForTopic(decisions, a.topic)))
        ? "grounded"
        : "unverified";

    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? doc.rel;
    out.push({ rel: doc.rel, title, topics, srcRefs, status, issues });
  }
  return out.sort((a, b) => compareCodeUnits(a.rel, b.rel));
}
