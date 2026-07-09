/**
 * Memory drift checks (roadmap #7, dec_2a53072620). Deterministic, model-free
 * comparisons of the curated graph against the actual code/docs — a smoke detector
 * for stale memory, NOT a robot that rewrites it. Advisory only: `hunch doctor`
 * prints findings; nothing blocks and nothing is auto-fixed. Each check maps to drift
 * observed in practice:
 *   - dead-ref:   an in-force decision points at a file that no longer exists.
 *   - supersede:  A claims to supersede B, but B was never properly closed.
 *   - doc-stale:  a doc marked "proposed / not yet implemented" references shipped code.
 *   - wiki-stale: a generated wiki page's graph inputs changed since generation
 *                 (hash-compared via .hunch/wiki-manifest.json; only when a wiki
 *                 was adopted — see src/wiki/wiki.ts). Advisory, healed by
 *                 `hunch wiki --heal`, never a gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { toPosixTarget } from "./paths.js";
import { currentForTopic, isLive } from "./topics.js";
import { parseDocAnchors } from "./docanchors.js";
import { markdownDocs, STALE_MARKER, SRC_REF } from "./docscan.js";
import { computeWikiDrift } from "../wiki/wiki.js";

export type DriftKind = "dead-ref" | "supersede" | "doc-stale" | "anchor-stale" | "doc-anchor-stale" | "doc-anchor-dangling" | "wiki-stale";

export interface DriftFinding {
  kind: DriftKind;
  id: string; // the record id or doc path the finding concerns
  detail: string;
}

export interface DriftReport {
  findings: DriftFinding[];
}

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
        if (!referenceExists(store, root, d.id, f)) {
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
          if (!referenceExists(store, root, d.id, f)) continue; // missing file is history → dead-ref's job
          findings.push({
            kind: "anchor-stale",
            id: d.id,
            detail: `"${f}" is anchored to superseded decision ${d.id} (topic "${d.topic}"); the current decision is ${current.id} — "${current.title}". Reconcile the file with the current decision.`,
          });
        }
      }
    }
  }

  // One markdown pass feeds both prose checks (3 + 5): read each doc once.
  for (const doc of markdownDocs(root)) {
    const text = safeRead(doc.path);

    // 3. DOC-STALE — a doc that still advertises "proposed / not implemented" while
    //    referencing code that exists. Heuristic + advisory; scoped to the repo's own
    //    markdown (node_modules and sub-projects skipped). GENERATED wiki pages are
    //    exempt: they quote decision prose verbatim (which may legitimately contain
    //    "proposed"), and their staleness is already hash-gated (wiki-stale).
    if (!text.startsWith("<!-- hunch:wiki ") && STALE_MARKER.test(text.slice(0, 1500))) {
      const existing = (text.match(SRC_REF) ?? []).find((r) => existsSync(join(root, r)));
      if (existing) {
        findings.push({ kind: "doc-stale", id: doc.rel, detail: `marked proposed/not-implemented but references shipped code (${existing})` });
      }
    }

    // 5. DOC-ANCHORS (prose≠graph, decision-grounding for markdown) — a section
    //    PINNED via `<!-- hunch:topic <topic> <dec_id> -->` to a decision that has
    //    been superseded (doc-anchor-stale, the CI-gateable one) or that doesn't
    //    exist (doc-anchor-dangling). Unpinned markers only ground the pre-edit
    //    hook — an explicit pin is the ONLY thing that can fire drift here.
    for (const a of parseDocAnchors(text)) {
      if (!a.pin) continue;
      const pinned = byId.get(a.pin);
      if (!pinned) {
        findings.push({ kind: "doc-anchor-dangling", id: doc.rel, detail: `line ${a.line}: pinned to ${a.pin} (topic "${a.topic}"), which does not exist` });
        continue;
      }
      const current = currentForTopic(decisions, a.topic);
      if ((pinned.status === "superseded" || pinned.superseded_by) && current && current.id !== a.pin) {
        findings.push({
          kind: "doc-anchor-stale",
          id: doc.rel,
          detail: `line ${a.line}: prose pinned to superseded ${a.pin} (topic "${a.topic}"); the current decision is ${current.id} — "${current.title}". Reconcile the prose with it, then re-pin.`,
        });
      }
    }
  }

  // 6. WIKI-STALE — generated wiki pages whose graph inputs drifted (or whose
  //    component vanished). Deterministic hash comparison against the manifest;
  //    fires only when a wiki was adopted. Advisory like every other kind here.
  findings.push(...computeWikiDrift(store, root));

  return { findings };
}

/** Resolve a decision file reference without making private-memory paths depend on
 * the current machine's overlay location. Normal references are code-repo-relative.
 * A `private:<path>` reference is valid only when the decision itself is in the
 * private overlay and resolves from that overlay repo's root. This lets a private
 * decision cite private docs while preventing a public record from silently
 * depending on unsharable local files. */
function referenceExists(store: HunchStore, root: string, decisionId: string, ref: string): boolean {
  const prefix = "private:";
  if (!ref.startsWith(prefix)) return existsSync(join(root, ref));

  const privatePath = ref.slice(prefix.length);
  if (!privatePath || isAbsolute(privatePath) || !store.privateDir || !store.getPrivateRec("decisions", decisionId)) return false;
  const privateRoot = dirname(store.privateDir);
  const candidate = resolve(privateRoot, privatePath);
  // A private-scoped reference is an overlay-repo-relative path, not an escape
  // hatch into arbitrary local files.
  const rel = relative(privateRoot, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`) || isAbsolute(rel)) return false;
  return existsSync(candidate);
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
