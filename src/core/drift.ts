/**
 * Memory drift checks (roadmap #7, dec_2a53072620). Deterministic, model-free
 * comparisons of the curated graph against the actual code/docs — a smoke detector
 * for stale memory, NOT a robot that rewrites it. Advisory only: `hunch doctor`
 * prints findings; nothing blocks and nothing is auto-fixed. Each check maps to drift
 * observed in practice:
 *   - dead-ref:   an in-force decision points at a file that no longer exists.
 *   - supersede:  A claims to supersede B, but B was never properly closed.
 *   - doc-stale:  a doc marked "proposed / not yet implemented" references shipped code.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { toPosixTarget } from "./paths.js";
import { currentForTopic, isLive } from "./topics.js";

export type DriftKind = "dead-ref" | "supersede" | "doc-stale" | "anchor-stale";

export interface DriftFinding {
  kind: DriftKind;
  id: string; // the record id or doc path the finding concerns
  detail: string;
}

export interface DriftReport {
  findings: DriftFinding[];
}

const STALE_MARKER = /\b(proposed|not yet implemented|no code yet)\b/i;
const SRC_REF = /\bsrc\/[A-Za-z0-9_\-/]+\.ts\b/g;

export function computeDrift(store: HunchStore, root: string): DriftReport {
  const findings: DriftFinding[] = [];
  const decisions = store.recs("decisions");
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  // Files any LIVE decision (any topic) still claims. A file governed by a live decision
  // is NOT orphaned to a stale one — only a file listed solely by superseded decisions is
  // anchor-stale. Keeps the doc≠graph gate's false-positive rate ~zero: a routine
  // narrowing supersession (successor lists fewer files) never flags files still governed.
  const liveFiles = new Set(decisions.filter(isLive).flatMap((d) => (d.related_files ?? []).map(toPosixTarget)));

  for (const d of decisions) {
    // 1. DEAD-REFERENCE — only for in-force decisions; a superseded one referencing
    //    a since-deleted file is legitimate history, not drift.
    const inForce = d.status !== "superseded" && !d.superseded_by;
    if (inForce) {
      for (const f of d.related_files ?? []) {
        if (!f || f.includes("*")) continue; // skip globs / empties
        if (!existsSync(join(root, f))) {
          findings.push({ kind: "dead-ref", id: d.id, detail: `references missing file "${f}"` });
        }
      }
    }

    // 2. SUPERSEDE-INTEGRITY — a contradiction class: A.supersedes = B, but B is
    //    either gone or still in force (the private-supersede bug shape).
    if (d.supersedes) {
      const target = byId.get(d.supersedes);
      if (!target) {
        findings.push({ kind: "supersede", id: d.id, detail: `supersedes "${d.supersedes}", which does not exist` });
      } else if (target.status !== "superseded" || target.superseded_by !== d.id) {
        findings.push({
          kind: "supersede",
          id: d.id,
          detail: `supersedes "${d.supersedes}", but it is still in force (status=${target.status}, superseded_by=${target.superseded_by ?? "null"})`,
        });
      }
    }

    // 4. ANCHOR-STALE (doc≠graph, decision-grounding) — a derived view still anchored
    //    to a SUPERSEDED decision while a current one exists for the same topic. Fully
    //    deterministic: fires only on the explicit topic anchor + a live successor
    //    (never a semantic guess), and only for a file NO live decision claims. Advisory.
    if (d.topic && (d.status === "superseded" || d.superseded_by)) {
      const current = currentForTopic(decisions, d.topic);
      if (current && current.id !== d.id) {
        for (const f of d.related_files ?? []) {
          if (!f || f.includes("*") || liveFiles.has(toPosixTarget(f))) continue;
          if (!existsSync(join(root, f))) continue; // missing file is history → dead-ref's job
          findings.push({
            kind: "anchor-stale",
            id: d.id,
            detail: `"${f}" is anchored to superseded decision ${d.id} (topic "${d.topic}"); the current decision is ${current.id} — "${current.title}". Reconcile the file with the current decision.`,
          });
        }
      }
    }
  }

  // 3. DOC-STALE — a doc that still advertises "proposed / not implemented" while
  //    referencing code that exists. Heuristic + advisory; scoped to the repo's own
  //    markdown (node_modules and sub-projects skipped).
  for (const doc of markdownDocs(root)) {
    const text = safeRead(doc.path);
    if (!STALE_MARKER.test(text.slice(0, 1500))) continue;
    const existing = (text.match(SRC_REF) ?? []).find((r) => existsSync(join(root, r)));
    if (existing) {
      findings.push({ kind: "doc-stale", id: doc.rel, detail: `marked proposed/not-implemented but references shipped code (${existing})` });
    }
  }

  return { findings };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hunch", ".hunch-private", "dist", "vscode-extension", "site"]);

/** Bounded walk for repo markdown (root + docs/, depth-limited; heavy/irrelevant trees skipped). */
function markdownDocs(root: string): Array<{ path: string; rel: string }> {
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
  return out;
}
