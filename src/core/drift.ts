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
 *   - madr-*:     the exported MADR corpus drifted from the graph — stale (the
 *                 decision moved), edited (a human changed a generated file the
 *                 next export would overwrite), or orphan (the decision left the
 *                 public graph). Only when a corpus was exported; healed by
 *                 `hunch export-adr`. See src/integrations/madrManifest.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { toPosixTarget } from "./paths.js";
import { currentForTopic, isLive } from "./topics.js";
import { evaluatePremises, type PremiseEnv } from "./premises.js";
import { parseDocAnchors } from "./docanchors.js";
import { markdownDocs, STALE_MARKER, SRC_REF } from "./docscan.js";
import { computeWikiDrift } from "../wiki/wiki.js";
import { computeMadrDrift } from "../integrations/madrManifest.js";
import { commitsExist, isGitRepo } from "../extractors/git.js";

export type DriftKind = "dead-ref" | "supersede" | "doc-stale" | "anchor-stale" | "doc-anchor-stale" | "doc-anchor-dangling" | "wiki-stale" | "finding-stale" | "premise-stale" | "commit-unresolvable" | "madr-stale" | "madr-edited" | "madr-orphan";

export interface DriftFinding {
  kind: DriftKind;
  id: string; // the record id or doc path the finding concerns
  detail: string;
}

export interface DriftReport {
  findings: DriftFinding[];
}

export function computeDrift(
  store: HunchStore,
  root: string,
  deps: { commitResolvable?: (sha: string) => boolean } = {},
): DriftReport {
  const findings: DriftFinding[] = [];
  const decisions = store.recs("decisions");
  const byId = new Map(decisions.map((d) => [d.id, d] as const));
  // Files any LIVE decision (any topic) still claims. A file governed by a live decision
  // is NOT orphaned to a stale one — only a file listed solely by superseded decisions is
  // anchor-stale. Keeps the doc≠graph gate's false-positive rate ~zero: a routine
  // narrowing supersession (successor lists fewer files) never flags files still governed.
  const liveFiles = new Set(decisions.filter(isLive).flatMap((d) => (d.related_files ?? []).map(toPosixTarget)));
  // A related_files entry may name a DIRECTORY ("vscode-extension/"), which governs every
  // file beneath it. Exact Set.has cannot see that, so a live directory-scoped decision
  // failed to suppress anchor-stale for files it plainly covers — a false positive that
  // only appeared on a public-only store, because an overlay decision happened to claim
  // the same file by exact path and masked it locally.
  const liveDirs = [...liveFiles].filter((f) => f.endsWith("/"));
  const governedByLiveDecision = (file: string): boolean => {
    const p = toPosixTarget(file);
    return liveFiles.has(p) || liveDirs.some((dir) => p.startsWith(dir));
  };
  const premiseEnv: PremiseEnv = { now: new Date().toISOString(), exists: (p) => existsSync(join(root, p)) };
  // A plain existence check is meaningless outside a git repo — computed once,
  // not per decision, and never a false positive for a directory that merely
  // happens to hold .hunch/ without being a git checkout. Injectable so tests
  // (and callers with a cheaper oracle) never have to shell out per decision.
  const gitRepo = isGitRepo(root);
  // One batched `git cat-file --batch-check` for every commit-bearing decision,
  // not one `rev-parse` per decision — skipped entirely when a predicate is
  // injected (tests/callers with a cheaper oracle never pay for this at all).
  const resolvableCommits = gitRepo && !deps.commitResolvable
    ? commitsExist([...new Set(decisions.filter((d) => d.commit).map((d) => d.commit as string))], root)
    : null;
  const defaultCommitResolvable = (sha: string): boolean => {
    if (!gitRepo) return true; // never flag outside a git repo
    if (resolvableCommits === null) return true; // the batch check itself failed, or was skipped — fail open
    return resolvableCommits.has(sha);
  };
  const commitResolvable = deps.commitResolvable ?? defaultCommitResolvable;

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

      // 8. COMMIT-UNRESOLVABLE — an in-force decision's commit provenance no longer
      //    resolves at all (source branch gone + gc'd past recovery). The
      //    opportunistic post-merge repair (commitrepair.ts) is the fix path; this
      //    is purely the "nothing caught it" signal — deterministic, never auto-fixed.
      //    Mirrors repair.ts:59's live-records-only rule: `inForce` alone doesn't
      //    exclude a never-adopted "rejected" decision (superseded_by is null for
      //    those too), so exclude it explicitly here.
      if (d.commit && d.status !== "rejected" && !commitResolvable(d.commit)) {
        findings.push({ kind: "commit-unresolvable", id: d.id, detail: `commit ${d.commit} no longer resolves in this repository — provenance may need manual repair` });
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
          if (!f || f.includes("*") || governedByLiveDecision(f)) continue;
          if (!referenceExists(store, root, d.id, f)) continue; // missing file is history → dead-ref's job
          findings.push({
            kind: "anchor-stale",
            id: d.id,
            detail: `"${f}" is anchored to superseded decision ${d.id} (topic "${d.topic}"); the current decision is ${current.id} — "${current.title}". Reconcile the file with the current decision.`,
          });
        }
      }
    }

    // 7. PREMISE-STALE (world≠graph) — the decision's recorded REASON no longer
    //    holds while code and docs may be perfectly in sync. Advisory like every
    //    kind here, and authority is NEVER changed by a dead premise — the
    //    escalation surface asks the human (a self-relaxing gate could be
    //    disarmed by the very actor it guards against).
    if (isLive(d) && d.premises?.length) {
      for (const v of evaluatePremises(d, premiseEnv)) {
        if (!v.holds) {
          findings.push({ kind: "premise-stale", id: d.id, detail: `premise "${v.claim}" no longer holds — ${v.reason}. Re-attest, supersede, or retire; authority unchanged until a human decides.` });
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

  // 6b. MADR-* — the exported ADR corpus drifted from the graph. PUBLIC decisions
  //     only: the corpus is a committable artifact, so its freshness must be
  //     computed from exactly the records allowed to reach it (an overlay record
  //     leaking into a public drift report is the same class of bug as one
  //     leaking into the export itself). Fires only where a corpus was exported.
  findings.push(...computeMadrDrift(store.json.loadAll("decisions"), root));

  // 7. FINDING-STALE — a LIVE finding (observation, no diff) whose anchor evaporated:
  //    an affected file that no longer exists, or a violates_constraint pointing at a
  //    retired/missing rule. Deterministic + advisory (never the exit-code class):
  //    the observation may be fixed, moved, or moot — re-verify (re-run its method)
  //    and re-record with triage resolved/stale, or refresh its paths.
  for (const f of store.recs("findings")) {
    if (f.triage === "resolved" || f.triage === "stale") continue;
    for (const file of f.affected_files) {
      if (!file || file.includes("*")) continue; // globs can't dead-ref
      if (!existsSync(join(root, file))) {
        findings.push({ kind: "finding-stale", id: f.id, detail: `live finding "${f.title}" references missing file "${file}" — re-verify${f.method ? ` (${f.method})` : ""} and re-record, or mark it stale` });
      }
    }
    if (f.violates_constraint) {
      const con = store.getRec("constraints", f.violates_constraint);
      if (!con) {
        findings.push({ kind: "finding-stale", id: f.id, detail: `live finding "${f.title}" claims to violate ${f.violates_constraint}, which does not exist — link the real rule or record it (hunch_record_correction)` });
      } else if (con.status === "retired") {
        findings.push({ kind: "finding-stale", id: f.id, detail: `live finding "${f.title}" violates ${f.violates_constraint}, but that constraint is RETIRED — resolve the finding or re-link it` });
      }
    }
  }

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
  // NOTE: sep, not an escaped literal — `"\\\\"` in a template is the TWO-char
  // string `\\`, which `relative()` never produces, silently disabling the
  // containment check on Windows (issue #31).
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return existsSync(candidate);
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
