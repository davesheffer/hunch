/**
 * Wiki — a generated component wiki that is a derived VIEW of the graph, never a
 * second source of truth (same rule as the SQLite index, con_a87360128b). Pages
 * are rebuilt from graph records; freshness is DETERMINISTIC, not scheduled: each
 * page's graph inputs are content-hashed into a wiki-manifest.json, and a hash
 * mismatch is a `wiki-stale` drift finding (`hunch drift` / `hunch heal`),
 * healed by `hunch wiki --heal` which regenerates ONLY the stale pages.
 *
 * Grounding: every decision a page cites is pinned with the existing
 * `<!-- hunch:topic <topic> <dec_id> -->` marker (docanchors.ts), so a later
 * supersession fires the established doc-anchor-stale drift with zero new
 * machinery — and the pre-edit hook grounds edits to wiki pages for free.
 *
 * Two HOMES, mirroring where memory itself lives (dec_9c4289a4bb / d7bad4ccb7):
 *   - public  — pages under <repo>/wiki/, rendered from the PUBLIC store ONLY
 *               (`store.json`, never the overlay): committed pages are a
 *               publicly-posted leak surface.
 *   - private — `hunch wiki --private`: pages under the OVERLAY repo's root
 *               (sibling of its .hunch/), rendered from the FULL union
 *               (`store.recs`, overlay included). Nothing lands in the public
 *               repo; the manifest lives inside the overlay's .hunch/.
 *
 * The prose "Overview" section is optional LLM output (subscription CLI via
 * SynthProvider.draftProse — never a pay-per-token API); everything drift-bearing
 * (anchors, invariants, structure) is rendered deterministically around it, so a
 * missing/failed CLI degrades to a complete template page, and the input hash
 * covers graph inputs only — LLM nondeterminism can never fake staleness.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { writeFileAtomic } from "../core/io.js";
import { hunchPaths, toPosixTarget } from "../core/paths.js";
import { isLive } from "../core/topics.js";
import { scanRepoDocs, type RepoDoc } from "../core/docscan.js";
import { adoptedSlug, adoptionHash, renderAdoptedDoc } from "./adopt.js";
import { assembleGraphData, renderGraphPage, type WikiGraphData } from "./graph.js";
import type { Decision } from "../core/types.js";
import type { HunchStore } from "../store/hunchStore.js";
import type { Component, Constraint, EntityKind, EntityFor } from "../core/types.js";
import type { DriftFinding } from "../core/drift.js";

// ---------------------------------------------------------------------------
// Homes — where pages live and which store they may read. The pairing is the
// invariant: "all" (overlay-inclusive) reads are ONLY ever written into the
// overlay repo, so a private record can never reach a committed public page.
// ---------------------------------------------------------------------------

export type WikiSource = "public" | "all";

export interface WikiHome {
  kind: "public" | "private";
  /** Repo the pages are written into (main repo root, or the overlay repo root). */
  pagesRoot: string;
  /** Output directory name under pagesRoot (manifest remembers it once adopted). */
  dir: string;
  manifestPath: string;
  source: WikiSource;
}

/** Normalize a --dir override: POSIX separators, no trailing slash — the dir is
 *  a committed manifest key prefix, so it must hash identically on every OS. */
const normDir = (d: string | undefined): string | undefined =>
  d ? toPosixTarget(d).replace(/\/+$/, "") || undefined : undefined;

export function publicHome(root: string, dirOverride?: string): WikiHome {
  const manifestPath = join(hunchPaths(root).hunch, "wiki-manifest.json");
  return {
    kind: "public",
    pagesRoot: root,
    dir: normDir(dirOverride) ?? readWikiManifestAt(manifestPath)?.dir ?? "wiki",
    manifestPath,
    source: "public",
  };
}

/** The private overlay's wiki home, or null when no overlay is configured.
 *  `store.privateDir` is the overlay's .hunch dir; pages go to the overlay repo
 *  root beside it (never inside .hunch/, which must stay memory-JSON-only for
 *  the overlay auto-commit guard), and the manifest rides the overlay store. */
export function privateHome(store: HunchStore, dirOverride?: string): WikiHome | null {
  if (!store.privateDir) return null;
  const manifestPath = join(store.privateDir, "wiki-manifest.json");
  return {
    kind: "private",
    pagesRoot: dirname(store.privateDir),
    dir: normDir(dirOverride) ?? readWikiManifestAt(manifestPath)?.dir ?? "wiki",
    manifestPath,
    source: "all",
  };
}

// ---------------------------------------------------------------------------
// Pack: the deterministic graph inputs one page is rendered from. Everything in
// here (and ONLY what is in here) participates in the freshness hash.
// ---------------------------------------------------------------------------

export interface WikiPack {
  component: { id: string; name: string; kind: string; responsibility: string; paths: string[]; fragility: number };
  /** repo-relative POSIX files the component owns (via its path globs). */
  files: string[];
  symbols: Array<{ name: string; file: string; kind: string; fan_in: number; fan_out: number; loc: number }>;
  decisions: Array<{
    id: string; topic: string | null; title: string; decision: string; context: string;
    consequences: string[]; alternatives_rejected: string[];
  }>;
  constraints: Array<{ id: string; severity: string; statement: string; rationale: string }>;
  bugs: Array<{ id: string; title: string; root_cause: string; severity: string; status: string }>;
  /** Repo docs (specs) that reference this component's files, with their
   *  deterministic freshness grade — status changes re-hash the page. `adopted`
   *  is the wiki-dir-relative path of the doc's wiki-managed copy (stale docs
   *  only), assigned by wikiStatus — the single slug authority. */
  docs: Array<{ path: string; title: string; status: string; adopted: string | null }>;
  /** `slug` is the related page's filename stem, assigned by wikiStatus (the
   *  slug authority) and HASHED with the pack — a sibling rename re-renders
   *  every page that links to it (closes the dec_c205c26472 residual). */
  dependsOn: Array<{ id: string; name: string; slug: string | null }>;
  usedBy: Array<{ id: string; name: string; slug: string | null }>;
}

/** "src/store/**" → "src/store/"; "src/core/io.ts" → "src/core/io.ts". */
function globPrefix(glob: string): string {
  const posix = toPosixTarget(glob);
  const i = posix.search(/[*?[]/);
  return i < 0 ? posix : posix.slice(0, i);
}

function owns(prefixes: string[], file: string): boolean {
  const f = toPosixTarget(file);
  return prefixes.some((p) => p !== "" && (f === p || f === p.replace(/\/$/, "") || f.startsWith(p.endsWith("/") ? p : `${p}/`)));
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const SEV = { blocking: 3, warning: 2, advisory: 1, critical: 4, high: 3, medium: 2, low: 1 } as Record<string, number>;

/** Assemble one component's pack — pure graph queries, no LLM. `source` decides
 *  the leak boundary: "public" reads the committed store only; "all" unions the
 *  private overlay and must only ever feed a PRIVATE home's pages. `repoDocs`
 *  (pre-scanned specs) associate by the src files they mention. */
export function assemblePack(
  store: HunchStore,
  component: Component,
  source: WikiSource = "public",
  repoDocs: readonly RepoDoc[] = [],
  adoptedPageByRel: ReadonlyMap<string, string> = new Map(),
  slugById: ReadonlyMap<string, string> = new Map(),
): WikiPack {
  const read = <K extends EntityKind>(kind: K): EntityFor[K][] => (source === "all" ? store.recs(kind) : store.json.loadAll(kind));
  const prefixes = component.paths.map(globPrefix);

  const symbols = read("symbols")
    .filter((s) => owns(prefixes, s.file))
    .sort((a, b) => b.metrics.fan_in - a.metrics.fan_in || b.metrics.loc - a.metrics.loc || a.name.localeCompare(b.name));
  const files = [...new Set(symbols.map((s) => toPosixTarget(s.file)))].sort();

  const decisions = read("decisions")
    .filter(isLive)
    .filter((d) => d.related_components.includes(component.id) || (d.related_files ?? []).some((f) => owns(prefixes, f)))
    .sort((a, b) => (b.valid_from ?? b.date).localeCompare(a.valid_from ?? a.date) || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((d) => ({
      id: d.id, topic: d.topic, title: d.title, decision: clip(d.decision, 500), context: clip(d.context, 300),
      consequences: d.consequences.slice(0, 4).map((c) => clip(c, 200)),
      alternatives_rejected: d.alternatives_rejected.slice(0, 4).map((a) => clip(a, 200)),
    }));

  // Scoped constraints only: a repo-wide constraint (scope []) belongs on the index
  // page, not repeated on every component page.
  const constraints = read("constraints")
    .filter((c) => c.status !== "retired")
    .filter((c) => c.scope.some((g) => { const p = globPrefix(g); return p !== "" && prefixes.some((q) => q !== "" && (p.startsWith(q) || q.startsWith(p))); }))
    .sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((c) => ({ id: c.id, severity: c.severity, statement: clip(c.statement, 300), rationale: clip(c.rationale, 200) }));

  const symbolNames = new Set(symbols.map((s) => s.name));
  const bugs = read("bugs")
    .filter((b) => b.affected_files.some((f) => owns(prefixes, f)) || b.affected_symbols.some((s) => symbolNames.has(s)))
    .sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 6)
    .map((b) => ({ id: b.id, title: b.title, root_cause: clip(b.root_cause, 250), severity: b.severity, status: b.status }));

  const componentsById = new Map(read("components").map((c) => [c.id, c] as const));
  const dependsOn = new Map<string, string>();
  const usedBy = new Map<string, string>();
  for (const e of read("edges")) {
    if (e.type === "supersedes" || e.type === "related_to") continue;
    if (e.from === component.id && componentsById.has(e.to) && e.to !== component.id) dependsOn.set(e.to, componentsById.get(e.to)!.name);
    if (e.to === component.id && componentsById.has(e.from) && e.from !== component.id) usedBy.set(e.from, componentsById.get(e.from)!.name);
  }
  const rel = (m: Map<string, string>) =>
    [...m].map(([id, name]) => ({ id, name, slug: slugById.get(id) ?? null })).sort((a, b) => a.id.localeCompare(b.id));

  const docs = repoDocs
    .filter((doc) => doc.srcRefs.some((f) => owns(prefixes, f)))
    .map((doc) => ({ path: doc.rel, title: doc.title, status: doc.status, adopted: adoptedPageByRel.get(doc.rel) ?? null }));

  return {
    component: {
      id: component.id, name: component.name, kind: component.kind,
      responsibility: component.responsibility, paths: component.paths.map(toPosixTarget), fragility: component.fragility,
    },
    files: files.slice(0, 25),
    symbols: symbols.slice(0, 12).map((s) => ({
      name: s.name, file: toPosixTarget(s.file), kind: s.kind,
      fan_in: s.metrics.fan_in, fan_out: s.metrics.fan_out, loc: s.metrics.loc,
    })),
    decisions, constraints, bugs, docs,
    dependsOn: rel(dependsOn), usedBy: rel(usedBy),
  };
}

// ---------------------------------------------------------------------------
// Freshness hash — canonical (key-sorted) JSON of the pack. Deterministic by
// construction: same graph → same hash, on every OS and regardless of LLM prose.
// ---------------------------------------------------------------------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  }
  return v;
}

export function packHash(pack: WikiPack): string {
  return createHash("sha256").update(JSON.stringify(canonical(pack))).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Rendering — deterministic skeleton; optional prose slots in as "Overview".
// No timestamps in page bodies: identical inputs must produce byte-identical
// pages (idempotent regen, no git noise). Generation time lives in the manifest.
// ---------------------------------------------------------------------------

export function slugFor(name: string, id: string, taken: Set<string>): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || id;
  // "readme" and "specs" are reserved page names (index + specs ledger); the
  // id-suffix itself can collide with a literal name, so loop until unique.
  if (slug === "readme" || slug === "specs" || slug === "now" || taken.has(slug)) slug = `${slug}-${id.replace(/^cmp_/, "").slice(0, 6)}`;
  while (taken.has(slug)) slug = `${slug}-x`;
  taken.add(slug);
  return slug;
}

const DOC_BADGE: Record<string, string> = { grounded: "✅ grounded", stale: "⚠ stale", unverified: "◻ unverified" };

/** `docsLinkable`: pages in the MAIN repo can relative-link ../<doc>; a private
 *  home's pages live in the OVERLAY repo where those paths don't resolve, so
 *  they render doc paths as plain text instead. */
export function renderPage(pack: WikiPack, prose: string | null, docsLinkable = true): string {
  const c = pack.component;
  const L: string[] = [];
  L.push(`<!-- hunch:wiki ${c.id} — GENERATED from the Hunch graph by \`hunch wiki\`; the graph is the source of truth. Edit records (/capture, hunch_record_decision), then \`hunch wiki --heal\` — do not edit this page by hand. -->`);
  L.push(`# ${c.name}`, "");
  if (c.responsibility) L.push(`> ${c.responsibility}`, "");
  if (c.paths.length) L.push(`Owns: ${c.paths.map((p) => `\`${p}\``).join(", ")}`, "");

  if (prose) L.push("## Overview", "", prose.trim(), "");

  if (pack.decisions.length) {
    L.push("## Why it is this way", "");
    for (const d of pack.decisions) {
      if (d.topic) L.push(`<!-- hunch:topic ${d.topic} ${d.id} -->`);
      L.push(`### ${d.title} (${d.id})`, "");
      if (d.decision) L.push(d.decision, "");
      if (d.context) L.push(`- **Context:** ${d.context}`);
      for (const q of d.consequences) L.push(`- **Consequence:** ${q}`);
      if (d.alternatives_rejected.length) L.push(`- **Rejected:** ${d.alternatives_rejected.join("; ")}`);
      L.push("");
    }
  }

  if (pack.constraints.length) {
    L.push("## Invariants (do not break)", "");
    for (const k of pack.constraints) L.push(`- **[${k.severity}]** ${k.statement}${k.rationale ? ` — ${k.rationale}` : ""} _(${k.id})_`);
    L.push("");
  }

  if (pack.symbols.length) {
    L.push("## Structure", "", "| Symbol | Kind | File | Fan-in | LOC |", "| --- | --- | --- | ---: | ---: |");
    for (const s of pack.symbols) L.push(`| \`${s.name}\` | ${s.kind} | ${s.file} | ${s.fan_in} | ${s.loc} |`);
    L.push("");
    if (pack.files.length) L.push(`Files: ${pack.files.map((f) => `\`${f}\``).join(", ")}`, "");
  }

  if (pack.docs.length) {
    L.push("## Docs & specs", "");
    for (const d of pack.docs) {
      // A stale doc routes to its ADOPTED (wiki-managed, graph-healed) copy.
      const ref = d.status === "stale" && d.adopted
        ? `[${d.title}](${d.adopted}) (wiki-managed copy; original \`${d.path}\` is stale)`
        : docsLinkable ? `[${d.title}](../${d.path})` : `${d.title} (\`${d.path}\`)`;
      L.push(`- ${DOC_BADGE[d.status] ?? d.status} — ${ref}`);
    }
    L.push("");
  }

  if (pack.dependsOn.length || pack.usedBy.length) {
    L.push("## Relations", "");
    const link = (r: { name: string; slug: string | null }) => (r.slug ? `[${r.name}](${r.slug}.md)` : r.name);
    if (pack.dependsOn.length) L.push(`- Depends on: ${pack.dependsOn.map(link).join(", ")}`);
    if (pack.usedBy.length) L.push(`- Used by: ${pack.usedBy.map(link).join(", ")}`);
    L.push("");
  }

  if (pack.bugs.length) {
    L.push("## Bug history", "");
    for (const b of pack.bugs) L.push(`- **[${b.severity}]** ${b.title} — ${b.root_cause || "root cause unrecorded"} _(${b.id}, ${b.status})_`);
    L.push("");
  }

  L.push("---", "", "_This page is a derived view of the Hunch graph. Regenerate: `hunch wiki --heal`._", "");
  return L.join("\n");
}

export function renderIndex(entries: Array<{ pack: WikiPack; slug: string }>, repoWide: Constraint[], home: Pick<WikiHome, "kind">, docs: readonly RepoDoc[] = []): string {
  const L: string[] = [];
  L.push("<!-- hunch:wiki _index — GENERATED from the Hunch graph by `hunch wiki`; do not edit by hand. -->");
  L.push("# Component wiki", "");
  if (home.kind === "private") {
    L.push("> ⚠ **PRIVATE** — rendered from the full graph **including the private overlay**. This wiki lives in the overlay repo; do not copy pages into a public repo or paste them publicly.", "");
  }
  L.push("Generated from this repo's Hunch engineering-memory graph — the graph is the source of truth; staleness is drift-gated (`hunch drift`), healed with `hunch wiki --heal`.", "");
  L.push("| Component | Responsibility | Decisions | Invariants |", "| --- | --- | ---: | ---: |");
  const cell = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  for (const { pack, slug } of entries) {
    L.push(`| [${cell(pack.component.name)}](${slug}.md) | ${cell(clip(pack.component.responsibility || "—", 120))} | ${pack.decisions.length} | ${pack.constraints.length} |`);
  }
  if (docs.length) {
    const n = (s: string) => docs.filter((d) => d.status === s).length;
    L.push("", `📄 [Specs & docs ledger](specs.md) — ${docs.length} repo doc(s): ${n("grounded")} grounded, ${n("stale")} stale, ${n("unverified")} unverified.`);
  }
  L.push("", "🔥 [Now — recent activity & roadmap](now.md)");
  L.push("", "🕸 [Memory graph](graph.html) — the interactive map: components, dependencies, and a time scrubber that replays the memory compounding.");
  if (repoWide.length) {
    L.push("", "## Repo-wide invariants", "");
    for (const k of repoWide) L.push(`- **[${k.severity}]** ${clip(k.statement, 300)} _(${k.id})_`);
  }
  L.push("");
  return L.join("\n");
}

/** The specs ledger — every repo doc with its deterministic freshness grade.
 *  This page is what makes the wiki usable as the trusted READING surface over
 *  the repo's own documentation: grounded docs are safe, stale docs carry their
 *  exact drift, unverified docs show how to get grounded. Prose is never
 *  rewritten — healing a stale doc is a human edit guided by `hunch heal`. */
export function renderSpecsPage(docs: readonly RepoDoc[], home: Pick<WikiHome, "kind">, adoptedPageByRel: ReadonlyMap<string, string> = new Map()): string {
  const L: string[] = [];
  L.push("<!-- hunch:wiki _specs — GENERATED doc-freshness ledger by `hunch wiki`; do not edit by hand. -->");
  L.push("# Specs & docs ledger", "");
  L.push("Every markdown doc in this repo, graded **deterministically** against the decision graph (no LLM, no guessing). Trust ✅, distrust ⚠ (follow the graph instead), and consider anchoring ◻.", "");
  const badge = (s: string) => DOC_BADGE[s] ?? s;
  const link = (d: RepoDoc) => (home.kind === "private" ? `${d.title} (\`${d.rel}\`)` : `[${d.title}](../${d.rel})`);

  const stale = docs.filter((d) => d.status === "stale");
  if (stale.length) {
    L.push("## ⚠ Stale — ADOPTED; read the wiki-managed copy", "");
    for (const d of stale) {
      const copy = adoptedPageByRel.get(d.rel);
      L.push(`- ${link(d)}${copy ? ` → **[wiki-managed copy](${copy})**` : ""}`);
      for (const i of d.issues) L.push(`  - ${i}`);
    }
    L.push("", "Each stale doc is adopted: a copy healed against the graph lives under `docs/` here and is the version to READ. The original is preserved untouched; heal it toward the CURRENT decision and re-pin its `<!-- hunch:topic … -->` marker (`hunch heal` lists the actions) and the copy retires automatically.", "");
  }
  const grounded = docs.filter((d) => d.status === "grounded");
  if (grounded.length) {
    L.push("## ✅ Grounded — anchored to current decisions", "");
    for (const d of grounded) L.push(`- ${link(d)}${d.topics.length ? ` — topics: ${d.topics.map((t) => `\`${t}\``).join(", ")}` : ""}`);
    L.push("");
  }
  const unverified = docs.filter((d) => d.status === "unverified");
  if (unverified.length) {
    L.push("## ◻ Unverified — Hunch can't vouch either way", "");
    for (const d of unverified) L.push(`- ${link(d)}`);
    L.push("", "Ground a doc by adding `<!-- hunch:topic <topic> <dec_id> -->` above the section it describes — from then on drift detection covers it.", "");
  }
  if (!docs.length) L.push("_No markdown docs found outside generated pages._", "");
  L.push("---", "", `_${badge("grounded").slice(2)} / ${badge("stale").slice(2)} / ${badge("unverified").slice(2)} are computed from topic pins, supersession state, and code references — see \`hunch drift\`._`, "");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Manifest — the freshness ledger (public: <repo>/.hunch/wiki-manifest.json,
// committed so CI can gate; private: <overlay>/.hunch's sibling file). Written
// atomically (con_902759b3dc). Page keys are pagesRoot-relative POSIX paths.
// ---------------------------------------------------------------------------

export interface WikiManifest {
  version: 1;
  dir: string;
  /** `bytes` = hash of the page as WRITTEN — the hand-edit tripwire. Optional
   *  for forward-compat with manifests written before it existed. */
  pages: Record<string, { component: string; hash: string; generated: string; bytes?: string }>;
}

export function readWikiManifestAt(manifestPath: string): WikiManifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as WikiManifest;
    if (!raw || raw.version !== 1 || typeof raw.dir !== "string" || !raw.pages || typeof raw.pages !== "object") return null;
    // Drop malformed page entries (hand edit / bad merge) instead of crashing
    // every drift-bearing command on `p.component.startsWith(...)`.
    raw.pages = Object.fromEntries(
      Object.entries(raw.pages).filter(([, p]) => p && typeof p === "object" && typeof p.component === "string" && typeof p.hash === "string"),
    );
    return raw;
  } catch {
    return null;
  }
}

export function writeWikiManifestAt(manifestPath: string, manifest: WikiManifest): void {
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/** For the committed grounding docs (CLAUDE.md et al): is a PUBLIC wiki adopted
 *  here, and how big? Deliberately blind to the private home — committed docs
 *  must not advertise what the overlay holds. */
export function wikiSummary(root: string): { dir: string; pages: number } | null {
  const m = readWikiManifestAt(join(hunchPaths(root).hunch, "wiki-manifest.json"));
  return m ? { dir: m.dir, pages: Object.keys(m.pages).length } : null;
}

// ---------------------------------------------------------------------------
// Status — which pages are fresh / stale / new, and which manifest entries are
// orphaned. The single computation behind `--check`, `--heal`, and drift.
// ---------------------------------------------------------------------------

export interface WikiEntry {
  pack: WikiPack;
  slug: string;
  /** pagesRoot-relative POSIX page path, e.g. "wiki/store-layer.md". */
  page: string;
  hash: string;
  state: "fresh" | "stale" | "new";
  reason: string;
}

/** Reserved manifest component id for the specs ledger page. */
const SPECS_ID = "_specs";
/** Reserved manifest component id for the README index page. */
const INDEX_ID = "_index";
/** Reserved manifest component id for the NOW page (activity ledger + roadmap). */
const NOW_ID = "_now";
/** Reserved manifest component id for the interactive memory-graph page. */
const GRAPH_ID = "_graph";
/** Manifest component-id prefix for adopted (wiki-managed) doc copies. */
const ADOPTED_PREFIX = "doc:";

/** One row of the NOW page — a decision reduced to its ledger-relevant surface.
 *  Everything here participates in the page's freshness hash. */
export interface NowItem {
  id: string;
  topic: string | null;
  title: string;
  status: string;
  date: string;
  /** decision text for recent items; CONTEXT (the why-it's-planned) for roadmap items. */
  note: string;
}

/** The hot view's inputs: last `recentLimit` decisions by date (any status — a
 *  supersession IS activity), and every live PROPOSED decision (the roadmap:
 *  record intent as a proposed decision; accepting or superseding it removes it
 *  from the roadmap with zero file maintenance). Home-scoped like every read. */
export function nowData(decisions: readonly Decision[], recentLimit = 10): { recent: NowItem[]; roadmap: NowItem[]; pendingReview: number } {
  const clip1 = (s: string): string => (s.length > 220 ? s.slice(0, 219).trimEnd() + "…" : s).replace(/\s*\n\s*/g, " ");
  const byDateDesc = (a: Decision, b: Decision) => (b.valid_from ?? b.date).localeCompare(a.valid_from ?? a.date) || a.id.localeCompare(b.id);
  const recent = [...decisions].sort(byDateDesc).slice(0, recentLimit)
    .map((d) => ({ id: d.id, topic: d.topic, title: d.title, status: d.status, date: (d.valid_from ?? d.date).slice(0, 10), note: clip1(d.decision) }));
  // Roadmap = INTENT the human vouched for. Auto-synthesized drafts are also
  // status "proposed", but they describe work already done and belong to the
  // review queue (`hunch review`) — surfacing them here would bury real plans.
  const live = decisions.filter((d) => d.status === "proposed" && !d.superseded_by && !d.valid_to);
  const vouched = live.filter((d) => d.provenance.source.includes("human_confirmed"));
  const roadmap = vouched
    .sort(byDateDesc)
    .map((d) => ({ id: d.id, topic: d.topic, title: d.title, status: d.status, date: (d.valid_from ?? d.date).slice(0, 10), note: clip1(d.context || d.decision) }));
  return { recent, roadmap, pendingReview: live.length - vouched.length };
}

/** The hot file — a DERIVED view like every other page: what just happened
 *  (last N decisions) and what's next (live proposed decisions). No topic pins
 *  by design: ledger entries going stale is history, not drift — the freshness
 *  hash alone re-renders the page when the graph moves. */
export function renderNowPage(recent: readonly NowItem[], roadmap: readonly NowItem[], home: Pick<WikiHome, "kind">, pendingReview = 0): string {
  const L: string[] = [];
  L.push("<!-- hunch:wiki _now — GENERATED activity ledger + roadmap by `hunch wiki`; do not edit by hand. Roadmap items are PROPOSED decisions — record intent with /capture (status: proposed); shipping it (accept/supersede) removes it here automatically. -->");
  L.push("# Now — recent activity & roadmap", "");
  if (home.kind === "private") L.push("> ⚠ **PRIVATE** — includes overlay records; do not publish.", "");
  L.push("## 🔥 Recent", "");
  if (!recent.length) L.push("_No decisions recorded yet._", "");
  for (const r of recent) L.push(`- ${r.date} · **${r.title}** — ${r.note || "(no decision text)"} _(${r.id}${r.topic ? `, topic \`${r.topic}\`` : ""}, ${r.status})_`);
  if (recent.length) L.push("");
  L.push("## 🗺 Roadmap — live proposed decisions", "");
  if (!roadmap.length) L.push("_Empty. Record what's next as a PROPOSED decision (`/capture`, status: proposed) and it appears here._", "");
  for (const r of roadmap) L.push(`- **${r.title}** — ${r.note || "(no context)"} _(${r.id}${r.topic ? `, topic \`${r.topic}\`` : ""}, since ${r.date})_`);
  if (roadmap.length) L.push("");
  if (pendingReview > 0) L.push(`_${pendingReview} legacy un-vouched proposed decision(s) not shown — \`hunch adopt-drafts\` auto-trusts them as advisory memory._`, "");
  L.push("---", "", "_Derived from the decision graph — regen: `hunch wiki --heal`. Ship a roadmap item by accepting/superseding its decision; never edit this page._", "");
  return L.join("\n");
}

/** A stale doc the wiki takes over: a healed, wiki-managed copy under <dir>/docs/. */
export interface WikiAdoption {
  doc: RepoDoc;
  /** Source content the copy is healed from (read once during status). */
  content: string;
  /** pagesRoot-relative page path, e.g. "wiki/docs/docs-api.md". */
  page: string;
  hash: string;
  state: WikiEntry["state"];
}

export interface WikiStatus {
  home: WikiHome;
  entries: WikiEntry[];
  /** Every repo doc with its freshness grade (input to specs page + Docs sections). */
  docs: RepoDoc[];
  /** Stale docs the wiki adopts (copies in + heals + manages). */
  adoptions: WikiAdoption[];
  /** Adopted copies whose ORIGINAL healed or vanished — the copy retires. */
  adoptionOrphans: string[];
  /** The decisions the home may read (needed to heal adopted copies). */
  decisions: Decision[];
  /** The specs ledger page's own freshness (hashed over the doc-status snapshot). */
  specs: { page: string; hash: string; state: WikiEntry["state"] };
  /** The README index page's freshness (hashed over rows + repo-wide invariants). */
  index: { page: string; hash: string; state: WikiEntry["state"] };
  /** The NOW page (activity ledger + roadmap) — hashed over its item snapshot. */
  now: { page: string; hash: string; state: WikiEntry["state"]; recent: NowItem[]; roadmap: NowItem[]; pendingReview: number };
  /** The interactive memory-graph page — hashed over its embedded data. */
  graph: { page: string; hash: string; state: WikiEntry["state"]; data: WikiGraphData };
  /** Repo-wide (scope []) constraints — rendered on the index, hashed into it. */
  repoWide: Constraint[];
  /** Manifest pages no current artifact claims (deleted/renamed components, an
   *  abandoned --dir…) — removed on heal so nothing generated is ever stranded. */
  orphans: string[];
}

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The one freshness state machine every generated artifact goes through:
 *  unknown/mismatched manifest entry → new; input hash moved → stale; file
 *  gone → stale; file bytes differ from what was WRITTEN → stale (the
 *  "do not edit by hand" tripwire; skipped for pre-`bytes` manifests). */
function pageState(
  home: WikiHome,
  page: string,
  component: string,
  hash: string,
  prior: WikiManifest["pages"][string] | undefined,
): { state: WikiEntry["state"]; reason: string } {
  if (!prior || prior.component !== component) return { state: "new", reason: "no page generated yet" };
  if (prior.hash !== hash) return { state: "stale", reason: "graph inputs changed since generation" };
  const abs = join(home.pagesRoot, ...page.split("/"));
  if (!existsSync(abs)) return { state: "stale", reason: "page file is missing" };
  if (prior.bytes) {
    try {
      if (sha16(readFileSync(abs, "utf8")) !== prior.bytes) {
        return { state: "stale", reason: "page was edited by hand (or merge-mangled) — regenerating restores the derived view" };
      }
    } catch {
      return { state: "stale", reason: "page file is unreadable" };
    }
  }
  return { state: "fresh", reason: "" };
}

export function wikiStatus(store: HunchStore, home: WikiHome, srcRoot: string): WikiStatus {
  const manifest = readWikiManifestAt(home.manifestPath);
  const decisions = home.source === "all" ? store.recs("decisions") : store.json.loadAll("decisions");
  const docs = scanRepoDocs(decisions, srcRoot);
  const components = (home.source === "all" ? store.recs("components") : store.json.loadAll("components"))
    .filter((c) => c.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  // Adoption slugs are assigned FIRST (single authority): every stale doc gets a
  // wiki-managed, graph-healed copy, and the packs/renderers receive its path.
  const adoptedTaken = new Set<string>();
  const adoptions: WikiAdoption[] = [];
  for (const doc of docs) {
    if (doc.status !== "stale") continue;
    let content: string;
    try {
      content = readFileSync(join(srcRoot, ...doc.rel.split("/")), "utf8");
    } catch {
      continue; // vanished between scan and read → next run re-grades
    }
    const page = `${home.dir}/docs/${adoptedSlug(doc.rel, adoptedTaken)}.md`;
    const hash = adoptionHash(content, decisions, doc);
    const { state } = pageState(home, page, `${ADOPTED_PREFIX}${doc.rel}`, hash, manifest?.pages[page]);
    adoptions.push({ doc, content, page, hash, state });
  }
  const adoptedPageByRel = new Map(adoptions.map((a) => [a.doc.rel, a.page.slice(home.dir.length + 1)] as const));

  // Slugs FIRST (single authority): packs embed their relations' slugs, so the
  // freshness hash covers cross-page links — a sibling rename re-renders every
  // page that links to it instead of leaving a fresh page pointing at a ghost.
  const taken = new Set<string>();
  const slugById = new Map(components.map((c) => [c.id, slugFor(c.name, c.id, taken)] as const));
  const entries: WikiEntry[] = components.map((c) => {
    const pack = assemblePack(store, c, home.source, docs, adoptedPageByRel, slugById);
    const slug = slugById.get(c.id)!;
    const page = `${home.dir}/${slug}.md`;
    const hash = packHash(pack);
    const { state, reason } = pageState(home, page, c.id, hash, manifest?.pages[page]);
    return { pack, slug, page, hash, state, reason };
  });

  // Specs ledger freshness: hashed over the status snapshot (not raw prose), so
  // a doc edit that doesn't change any grade/title/topic doesn't churn the page.
  const specsPage = `${home.dir}/specs.md`;
  const specsHash = sha16(JSON.stringify(canonical(docs.map((d) => ({ rel: d.rel, title: d.title, status: d.status, issues: d.issues, topics: d.topics })))));
  const specs = { page: specsPage, hash: specsHash, state: pageState(home, specsPage, SPECS_ID, specsHash, manifest?.pages[specsPage]).state };

  // The README index is a generated artifact like any other: hashed over its
  // actual inputs (rows, repo-wide invariants, doc counts) so a repo-wide
  // constraint change or a component rename re-renders it — and deleting or
  // hand-editing it grades stale instead of staying invisible forever.
  const repoWide = (home.source === "all" ? store.recs("constraints") : store.json.loadAll("constraints"))
    .filter((c) => c.status !== "retired" && c.scope.every((g) => globPrefix(g) === ""))
    .sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 10);
  const indexPage = `${home.dir}/README.md`;
  const indexHash = sha16(JSON.stringify(canonical({
    kind: home.kind,
    rows: entries.map((e) => ({ slug: e.slug, name: e.pack.component.name, responsibility: e.pack.component.responsibility, decisions: e.pack.decisions.length, constraints: e.pack.constraints.length })),
    repoWide: repoWide.map((c) => ({ id: c.id, severity: c.severity, statement: c.statement })),
    docs: { grounded: docs.filter((d) => d.status === "grounded").length, stale: docs.filter((d) => d.status === "stale").length, unverified: docs.filter((d) => d.status === "unverified").length, total: docs.length },
    graphLink: true, // the index links graph.html — pre-graph manifests re-render once
  })));
  const index = { page: indexPage, hash: indexHash, state: pageState(home, indexPage, INDEX_ID, indexHash, manifest?.pages[indexPage]).state };

  // The NOW page: recent activity + live proposed decisions (the roadmap).
  const { recent, roadmap, pendingReview } = nowData(decisions);
  const nowPage = `${home.dir}/now.md`;
  const nowHash = sha16(JSON.stringify(canonical({ recent, roadmap, pendingReview })));
  const now = { page: nowPage, hash: nowHash, state: pageState(home, nowPage, NOW_ID, nowHash, manifest?.pages[nowPage]).state, recent, roadmap, pendingReview };

  // The memory-graph page — the visual knowledge base: components + dependencies
  // + per-component decision dates (the scrubber's timeline) + every repo doc
  // with its freshness grade (stale docs point at their adopted healed copy) +
  // the actionable review count. Hashed over the exact embedded data — the
  // client-side force layout is presentation and never participates.
  const decisionDates = new Map(decisions.map((d) => [d.id, d.valid_from ?? d.date] as const));
  const graphData = assembleGraphData(home.kind, entries, decisionDates, docs, adoptedPageByRel, pendingReview);
  const graphPage = `${home.dir}/graph.html`;
  const graphHash = sha16(JSON.stringify(canonical(graphData)));
  const graph = { page: graphPage, hash: graphHash, state: pageState(home, graphPage, GRAPH_ID, graphHash, manifest?.pages[graphPage]).state, data: graphData };

  // Orphans by PAGE KEY, not component id: anything the manifest tracks that no
  // current artifact claims (deleted component, renamed component whose slug
  // moved, a retired adoption) gets removed on heal — nothing generated is ever
  // stranded on disk while the manifest forgets it.
  const expected = new Set<string>([...entries.map((e) => e.page), ...adoptions.map((a) => a.page), specsPage, indexPage, nowPage, graphPage]);
  const orphans: string[] = [];
  const adoptionOrphans: string[] = [];
  for (const [page, p] of Object.entries(manifest?.pages ?? {})) {
    if (expected.has(page)) continue;
    (p.component.startsWith(ADOPTED_PREFIX) ? adoptionOrphans : orphans).push(page);
  }
  return { home, entries, docs, adoptions, adoptionOrphans, decisions, specs, index, now, graph, repoWide, orphans };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** ISO instant recorded per page in the manifest (caller supplies the clock). */
  now: string;
  /** "all" regenerates every page; "stale" only new/stale ones (--heal). */
  only: "all" | "stale";
  /** Optional grounded-prose hook (subscription CLI). null/throw → template-only page. */
  prose?: (pack: WikiPack, excerpts: string) => Promise<string | null>;
  /** Optional prose-heal for ADOPTED copies (--prose-heal): an LLM "reconciled
   *  overview" under the banner. null/throw → deterministic copy, exactly as
   *  without the flag; output is never hashed (same doctrine as page prose). */
  adoptionProse?: (doc: RepoDoc, content: string) => Promise<string | null>;
  log?: (line: string) => void;
}

/** Read short excerpts of the component's heaviest files as LLM grounding.
 *  Source files always live in the MAIN repo (`srcRoot`), even for the private
 *  home — only the pages move; the code doesn't. */
function excerptsFor(srcRoot: string, pack: WikiPack): string {
  const parts: string[] = [];
  for (const file of pack.files.slice(0, 3)) {
    try {
      const lines = readFileSync(join(srcRoot, ...file.split("/")), "utf8").split("\n").slice(0, 60);
      parts.push(`--- ${file} (first ${lines.length} lines) ---\n${lines.join("\n")}`);
    } catch {
      /* deleted/unreadable → skip; the pack alone still grounds the prose */
    }
  }
  return parts.join("\n\n").slice(0, 6000);
}

const WIKI_SYSTEM = `You are the documentation engine of an Engineering Memory OS. Write a short,
factual overview of ONE component of a codebase for its generated wiki. Ground every claim in the
provided graph records (decisions, constraints, bugs, symbols) and code excerpts; never invent
behavior. Cite record ids inline like (dec_xxx) or (con_xxx) where a claim comes from one. Output
plain markdown paragraphs only — no headings, no lists, no code fences. 120-220 words.`;

export function wikiPrompt(pack: WikiPack, excerpts: string): string {
  return `${WIKI_SYSTEM}\n\n## Graph records for this component\n${JSON.stringify(pack, null, 1)}\n\n## Code excerpts\n${excerpts || "(none)"}\n\nWrite the overview now.`;
}

export async function generateWiki(
  store: HunchStore,
  srcRoot: string,
  home: WikiHome,
  opts: GenerateOptions,
): Promise<{ written: string[]; removed: string[]; unchanged: number }> {
  const status = wikiStatus(store, home, srcRoot);
  const prior = readWikiManifestAt(home.manifestPath);
  const targets = status.entries.filter((e) => opts.only === "all" || e.state !== "fresh");
  const specsTarget = opts.only === "all" || status.specs.state !== "fresh";
  const indexTarget = opts.only === "all" || status.index.state !== "fresh";
  const nowTarget = opts.only === "all" || status.now.state !== "fresh";
  const graphTarget = opts.only === "all" || status.graph.state !== "fresh";
  const log = opts.log ?? (() => {});

  const written: string[] = [];
  /** Written-bytes ledger — the hand-edit tripwire recorded per page. */
  const bytesByPage = new Map<string, string>();
  const put = (page: string, content: string): void => {
    writeFileAtomic(join(home.pagesRoot, ...page.split("/")), content);
    bytesByPage.set(page, sha16(content));
    written.push(page);
  };
  mkdirSync(join(home.pagesRoot, home.dir), { recursive: true });

  for (const e of targets) {
    let prose: string | null = null;
    if (opts.prose) {
      try {
        prose = await opts.prose(e.pack, excerptsFor(srcRoot, e.pack));
      } catch {
        prose = null; // template-only page; never fail generation on a CLI hiccup
      }
    }
    put(e.page, renderPage(e.pack, prose, home.kind === "public"));
    log(`  ✎ ${e.page}${e.state === "fresh" ? "" : ` (${e.state})`}${prose ? "" : " [template]"}`);
  }

  if (specsTarget) {
    const adoptedPageByRel = new Map(status.adoptions.map((a) => [a.doc.rel, a.page.slice(home.dir.length + 1)] as const));
    put(status.specs.page, renderSpecsPage(status.docs, home, adoptedPageByRel));
    log(`  ✎ ${status.specs.page}${status.specs.state === "fresh" ? "" : ` (${status.specs.state})`} [${status.docs.length} doc(s) graded]`);
  }

  // Adoption: stale docs get (re)healed wiki-managed copies.
  const adoptionTargets = status.adoptions.filter((a) => opts.only === "all" || a.state !== "fresh");
  if (adoptionTargets.length) mkdirSync(join(home.pagesRoot, home.dir, "docs"), { recursive: true });
  for (const a of adoptionTargets) {
    let reconciled: string | null = null;
    if (opts.adoptionProse) {
      try {
        reconciled = await opts.adoptionProse(a.doc, a.content);
      } catch {
        reconciled = null; // deterministic copy; a CLI hiccup never fails adoption
      }
    }
    put(a.page, renderAdoptedDoc(a.doc, a.content, status.decisions, reconciled));
    log(`  ✚ ${a.page}${a.state === "fresh" ? "" : ` (${a.state})`} [adopted from ${a.doc.rel}]${reconciled ? " [prose-healed]" : ""}`);
  }

  if (nowTarget) {
    put(status.now.page, renderNowPage(status.now.recent, status.now.roadmap, home, status.now.pendingReview));
    log(`  ✎ ${status.now.page}${status.now.state === "fresh" ? "" : ` (${status.now.state})`} [${status.now.recent.length} recent, ${status.now.roadmap.length} roadmap]`);
  }

  if (graphTarget) {
    put(status.graph.page, renderGraphPage(status.graph.data));
    log(`  ✎ ${status.graph.page}${status.graph.state === "fresh" ? "" : ` (${status.graph.state})`} [${status.graph.data.nodes.length} node(s), ${status.graph.data.links.length} link(s)]`);
  }

  if (indexTarget) {
    put(status.index.page, renderIndex(status.entries.map((e) => ({ pack: e.pack, slug: e.slug })), status.repoWide, home, status.docs));
    log(`  ✎ ${status.index.page}${status.index.state === "fresh" ? "" : ` (${status.index.state})`}`);
  }

  // Orphaned pages (component deleted from the graph) are generated artifacts —
  // remove them so the wiki never documents a component that no longer exists.
  // Retired adoptions (original healed or deleted) leave the same way.
  const removed: string[] = [];
  for (const [pages, why] of [[status.orphans, "component gone"], [status.adoptionOrphans, "original healed or removed — copy retired"]] as const) {
    for (const page of pages) {
      try {
        rmSync(join(home.pagesRoot, ...page.split("/")), { force: true });
      } catch {
        /* best effort */
      }
      removed.push(page);
      log(`  ✗ ${page} (${why})`);
    }
  }

  if (written.length || removed.length) {
    const pages: WikiManifest["pages"] = {};
    const entry = (page: string, component: string, hash: string, state: WikiEntry["state"]): void => {
      const keep = state === "fresh" ? prior?.pages[page] : undefined;
      pages[page] = keep ?? { component, hash, generated: opts.now, bytes: bytesByPage.get(page) };
    };
    for (const e of status.entries) entry(e.page, e.pack.component.id, e.hash, e.state);
    for (const a of status.adoptions) entry(a.page, `${ADOPTED_PREFIX}${a.doc.rel}`, a.hash, a.state);
    entry(status.specs.page, SPECS_ID, status.specs.hash, status.specs.state);
    entry(status.index.page, INDEX_ID, status.index.hash, status.index.state);
    entry(status.now.page, NOW_ID, status.now.hash, status.now.state);
    entry(status.graph.page, GRAPH_ID, status.graph.hash, status.graph.state);
    writeWikiManifestAt(home.manifestPath, { version: 1, dir: home.dir, pages });
  }

  return { written, removed, unchanged: status.entries.length - targets.length };
}

// ---------------------------------------------------------------------------
// Drift — wiki-stale findings for `hunch drift` / `hunch heal`. Fires ONLY for
// homes that were adopted (their manifest exists): no manifest, no findings, so
// repos that never ran `hunch wiki` see zero noise. The private home is checked
// only where the overlay is configured — a CI runner without HUNCH_PRIVATE_DIR /
// local.json never sees (or leaks) private findings, by construction.
// ---------------------------------------------------------------------------

export function computeWikiDrift(store: HunchStore, root: string): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const homes = [publicHome(root), privateHome(store)].filter((h): h is WikiHome => h !== null);
  for (const home of homes) {
    if (!readWikiManifestAt(home.manifestPath)) continue; // not adopted → silent
    const status = wikiStatus(store, home, root);
    const where = home.kind === "private" ? " (private overlay wiki)" : "";
    const heal = `hunch wiki --heal${home.kind === "private" ? " --private" : ""}`;
    for (const e of status.entries) {
      if (e.state === "fresh") continue;
      findings.push({
        kind: "wiki-stale",
        id: e.page,
        detail: (e.state === "new"
          ? `component ${e.pack.component.id} ("${e.pack.component.name}") has no wiki page yet — generate with \`${heal}\``
          : `${e.reason} (component ${e.pack.component.id}) — regenerate with \`${heal}\``) + where,
      });
    }
    if (status.specs.state !== "fresh") {
      findings.push({
        kind: "wiki-stale",
        id: status.specs.page,
        detail: `the repo's doc freshness snapshot changed (a spec was added, removed, re-graded, or re-anchored) — regenerate with \`${heal}\`${where}`,
      });
    }
    if (status.index.state !== "fresh") {
      findings.push({
        kind: "wiki-stale",
        id: status.index.page,
        detail: `the index's inputs moved (component set/names, repo-wide invariants, or doc counts) — regenerate with \`${heal}\`${where}`,
      });
    }
    if (status.now.state !== "fresh") {
      findings.push({
        kind: "wiki-stale",
        id: status.now.page,
        detail: `the activity ledger / roadmap moved (a decision was recorded, accepted, or superseded) — regenerate with \`${heal}\`${where}`,
      });
    }
    if (status.graph.state !== "fresh") {
      findings.push({
        kind: "wiki-stale",
        id: status.graph.page,
        detail: `the memory graph's inputs moved (components, dependencies, or decision dates) — regenerate with \`${heal}\`${where}`,
      });
    }
    for (const a of status.adoptions) {
      if (a.state === "fresh") continue;
      findings.push({
        kind: "wiki-stale",
        id: a.page,
        detail: a.state === "new"
          ? `stale doc "${a.doc.rel}" awaits adoption (wiki-managed healed copy) — generate with \`${heal}\`${where}`
          : `adopted copy of "${a.doc.rel}" is out of date (source or graph moved) — re-heal with \`${heal}\`${where}`,
      });
    }
    for (const page of status.adoptionOrphans) {
      findings.push({ kind: "wiki-stale", id: page, detail: `its original healed or was removed — retire the copy with \`${heal}\`${where}` });
    }
    for (const page of status.orphans) {
      findings.push({ kind: "wiki-stale", id: page, detail: `its component no longer exists in the graph — remove with \`${heal}\`${where}` });
    }
  }
  return findings;
}
