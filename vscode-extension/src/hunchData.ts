/**
 * Self-contained read layer over the committed .hunch/ JSON source of truth.
 * No native deps, no dependency on the hunch CLI — the extension is a pure
 * viewer over the JSON, so it works anywhere the repo is checked out.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";

export interface Provenance {
  source?: string;
  confidence?: number;
  evidence?: string[];
  last_verified?: string;
}
export interface Component { id: string; name: string; responsibility?: string; paths?: string[]; fragility?: number; provenance?: Provenance; }
export interface Edge { id: string; from: string; to: string; type: string; }
export interface Sym { id: string; file: string; name: string; kind: string; metrics?: { churn_90d?: number; bug_count?: number; fan_in?: number }; }
export interface Decision { id: string; title: string; status?: string; decision?: string; topic?: string | null; alternatives_rejected?: string[]; related_files?: string[]; related_components?: string[]; provenance?: Provenance; }
export interface BugLineage { introduced_commit?: string | null; detected?: string | null; fixed_commit?: string | null; recurrence_of?: string | null; spawned_decision?: string | null; spawned_constraint?: string | null; }
export interface Bug { id: string; title: string; symptom?: string; root_cause?: string; severity?: string; status?: string; affected_files?: string[]; affected_symbols?: string[]; lineage?: BugLineage; provenance?: Provenance; }
export interface Constraint { id: string; statement: string; scope?: string[]; severity?: string; rationale?: string; provenance?: Provenance; }

export interface Hunch {
  root: string;
  /** The extension's local read state. Private/shared records are merged only in
   * this local process; this status makes an unavailable overlay visible rather
   * than silently degrading editor grounding to public-only. */
  overlay?: { mode: "private" | "shared"; state: "active" | "missing"; dir: string };
  components: Component[];
  edges: Edge[];
  symbols: Sym[];
  decisions: Decision[];
  bugs: Bug[];
  constraints: Constraint[];
}

// ---- minimal, segment-aware glob (mirrors the core matcher) ----------------
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
function globToRegExp(glob: string): RegExp {
  const segs = glob.split("/").filter((s, i, a) => !(s === "**" && a[i - 1] === "**"));
  if (segs.length === 1 && segs[0] === "**") return /^.*$/;
  const seg = (s: string) => s.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  let re = "";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const last = i === segs.length - 1;
    if (s === "**") {
      if (last) re += "(?:/.*)?";
    } else {
      const prevGs = i > 0 && segs[i - 1] === "**";
      if (prevGs) re += i - 1 === 0 ? "(?:.*/)?" : "/(?:.*/)?";
      else if (i > 0) re += "/";
      re += seg(s);
    }
  }
  return new RegExp("^" + re + "$");
}
export function pathMatchesGlob(p: string, glob: string): boolean {
  const a = norm(p);
  const g = norm(glob);
  if (a === g) return true;
  if (globToRegExp(g).test(a)) return true;
  if (!/[*?]/.test(g) && a.startsWith(g.endsWith("/") ? g : g + "/")) return true;
  return false;
}

// ---- loading ---------------------------------------------------------------
function readJson<T>(file: string, fallbackArray = true): T[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw) ? raw : fallbackArray ? [] : [raw];
  } catch {
    return [];
  }
}
function readDir<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  const out: T[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

type LocalConfig = { privateDir?: string; mode?: "private" | "shared" };
function readLocalConfig(file: string): LocalConfig {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { privateDir?: unknown; mode?: unknown };
    return {
      privateDir: typeof value.privateDir === "string" && value.privateDir.trim() ? value.privateDir.trim() : undefined,
      mode: value.mode === "shared" ? "shared" : value.mode === "private" ? "private" : undefined,
    };
  } catch { return {}; }
}
function commonOverlayConfig(root: string): LocalConfig {
  try {
    const common = cp.execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return readLocalConfig(path.join(path.resolve(root, common), "hunch", "local.json"));
  } catch { return {}; }
}
function resolveOverlay(root: string, publicDir: string): { dir: string; mode: "private" | "shared"; state: "active" | "missing" } | undefined {
  const local = readLocalConfig(path.join(publicDir, "local.json"));
  const shared = local.privateDir ? undefined : commonOverlayConfig(root);
  const config = local.privateDir ? local : shared;
  const raw = process.env.HUNCH_PRIVATE_DIR?.trim() || config?.privateDir;
  if (!raw) return undefined;
  const dir = path.resolve(root, raw);
  return { dir, mode: config?.mode ?? "private", state: fs.existsSync(dir) ? "active" : "missing" };
}
function mergeById<T extends { id: string }>(publicRecords: T[], overlayRecords: T[]): T[] {
  const records = new Map<string, T>();
  for (const record of publicRecords) records.set(record.id, record);
  for (const record of overlayRecords) records.set(record.id, record);
  return [...records.values()];
}

export function loadHunch(root: string): Hunch | null {
  const dir = path.join(root, ".hunch");
  if (!fs.existsSync(dir)) return null;
  const overlay = resolveOverlay(root, dir);
  const overlayDir = overlay?.state === "active" ? overlay.dir : undefined;
  const fromOverlay = <T>(relative: string, indexed = false): T[] => {
    if (!overlayDir) return [];
    const file = path.join(overlayDir, relative);
    return indexed ? readJson<T>(file) : readDir<T>(file);
  };
  return {
    root,
    overlay: overlay ? { mode: overlay.mode, state: overlay.state, dir: overlay.dir } : undefined,
    components: mergeById(readDir<Component>(path.join(dir, "components")), fromOverlay<Component>("components")),
    edges: mergeById(readJson<Edge>(path.join(dir, "edges", "index.json")), fromOverlay<Edge>("edges/index.json", true)),
    symbols: mergeById(readJson<Sym>(path.join(dir, "symbols", "index.json")), fromOverlay<Sym>("symbols/index.json", true)),
    decisions: mergeById(readDir<Decision>(path.join(dir, "decisions")), fromOverlay<Decision>("decisions")),
    bugs: mergeById(readDir<Bug>(path.join(dir, "bugs")), fromOverlay<Bug>("bugs")),
    constraints: mergeById(readDir<Constraint>(path.join(dir, "constraints")), fromOverlay<Constraint>("constraints")),
  };
}

// ---- queries (lightweight versions of the core store) ----------------------
function relMatch(target: string, files: string[]): boolean {
  return files.some((f) => f === target || target.endsWith(f) || f.endsWith(target));
}

export function constraintsInScope(hunch: Hunch, file: string): Constraint[] {
  return hunch.constraints
    .filter((c) => (c.scope ?? []).some((g) => pathMatchesGlob(file, g)))
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
}

export interface WhyResult {
  decisions: Decision[];
  bugs: Bug[];
  constraints: Constraint[];
  dependents: Array<{ name: string; file: string }>;
}

export function why(hunch: Hunch, file: string): WhyResult {
  const symsInFile = hunch.symbols.filter((s) => s.file === file || s.file.endsWith(file));
  const symIds = new Set(symsInFile.map((s) => s.id));
  const dependents: Array<{ name: string; file: string }> = [];
  for (const e of hunch.edges) {
    if (e.type === "calls" && symIds.has(e.to)) {
      const from = hunch.symbols.find((s) => s.id === e.from);
      if (from) dependents.push({ name: from.name, file: from.file });
    }
  }
  return {
    decisions: hunch.decisions.filter((d) => relMatch(file, d.related_files ?? [])),
    bugs: hunch.bugs.filter((b) => relMatch(file, b.affected_files ?? []) || (b.affected_symbols ?? []).some((s) => symIds.has(s))),
    constraints: constraintsInScope(hunch, file),
    dependents: dependents.slice(0, 20),
  };
}

// ---- blast radius + near-violations (mirrors core HunchStore) --------------
const RADIUS_EDGES = new Set(["calls", "depends_on", "imports", "contains"]);

/** Files whose symbols (in)directly depend on a symbol defined in `file` — the
 *  blast radius of editing it, collapsed to files (nearest depth wins). Mirrors
 *  HunchStore.blastRadiusFiles via a backward BFS over the edge graph. */
export function blastRadiusFiles(hunch: Hunch, file: string, maxDepth = 4): Array<{ file: string; via: string; depth: number }> {
  const byId = new Map(hunch.symbols.map((s) => [s.id, s]));
  const incoming = new Map<string, string[]>(); // to -> [from]
  for (const e of hunch.edges) {
    if (!RADIUS_EDGES.has(e.type)) continue;
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seed = hunch.symbols.filter((s) => s.file === file || s.file.endsWith(file)).map((s) => s.id);
  const seen = new Set(seed);
  const out = new Map<string, { file: string; via: string; depth: number }>();
  let frontier = seed;
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const from of incoming.get(id) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        next.push(from);
        const s = byId.get(from);
        if (!s || s.file === file || s.file.endsWith(file)) continue;
        const prev = out.get(s.file);
        if (!prev || depth < prev.depth) out.set(s.file, { file: s.file, via: s.name, depth });
      }
    }
    frontier = next;
  }
  return [...out.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
}

/** Constraints reached only THROUGH the blast radius (a guarded dependency
 *  changed), excluding those already in `file`'s direct scope — near-violations. */
export function nearConstraints(hunch: Hunch, file: string): Array<{ c: Constraint; via: string }> {
  const direct = new Set(constraintsInScope(hunch, file).map((c) => c.id));
  const out = new Map<string, { c: Constraint; via: string }>();
  for (const b of blastRadiusFiles(hunch, file)) {
    for (const c of constraintsInScope(hunch, b.file)) {
      if (direct.has(c.id) || out.has(c.id)) continue;
      out.set(c.id, { c, via: `${file} → ${b.file} (${b.via}, depth ${b.depth})` });
    }
  }
  return [...out.values()];
}

export function fragileSymbols(hunch: Hunch, limit = 20): Array<{ name: string; file: string; score: number; evidence: string }> {
  const maxChurn = Math.max(1, ...hunch.symbols.map((s) => s.metrics?.churn_90d ?? 0));
  const maxFanIn = Math.max(1, ...hunch.symbols.map((s) => s.metrics?.fan_in ?? 0));
  return hunch.symbols
    .map((s) => {
      const bug = s.metrics?.bug_count ?? 0;
      const churn = s.metrics?.churn_90d ?? 0;
      const fanIn = s.metrics?.fan_in ?? 0;
      const score = 0.5 * Math.min(1, bug / 3) + 0.3 * (churn / maxChurn) + 0.2 * (fanIn / maxFanIn);
      const ev = [bug && `${bug} bug(s)`, churn && `churn ${churn}`, fanIn && `fan-in ${fanIn}`].filter(Boolean).join(" · ");
      return { name: s.name, file: s.file, score: Math.round(score * 100) / 100, evidence: ev };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function isStale(rec: { provenance?: Provenance; related_files?: string[]; scope?: string[] }, lastChange: (f: string) => number): boolean {
  const verified = rec.provenance?.last_verified;
  if (!verified) return false;
  const vt = Date.parse(verified);
  if (Number.isNaN(vt)) return false;
  for (const f of rec.related_files ?? rec.scope ?? []) {
    if (lastChange(f) > vt) return true;
  }
  return false;
}

export function sevRank(s?: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1, critical: 4, high: 3, medium: 2, low: 1 } as Record<string, number>)[s ?? ""] ?? 0;
}

// ---- search ----------------------------------------------------------------
export type RecordKind = "constraint" | "decision" | "bug" | "component";
export interface SearchHit {
  kind: RecordKind;
  id: string;
  label: string;
  detail: string;
  file?: string;
  score: number;
}

/** Fuzzy-ish ranked search across every record type. Pure string scoring — no
 *  index, fast enough for graphs of thousands of records. Mirrors hunch_query
 *  but local + offline. */
export function searchAll(hunch: Hunch, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const score = (hay: string): number => {
    const h = hay.toLowerCase();
    let s = 0;
    for (const t of terms) {
      const i = h.indexOf(t);
      if (i < 0) return 0; // every term must appear
      s += i === 0 ? 3 : 1; // prefix-ish boost
    }
    return s + (h.includes(q) ? 2 : 0);
  };
  const hits: SearchHit[] = [];
  for (const c of hunch.constraints) {
    const s = score(`${c.statement} ${c.rationale ?? ""} ${(c.scope ?? []).join(" ")} ${c.id}`);
    if (s) hits.push({ kind: "constraint", id: c.id, label: `[${c.severity}] ${c.statement}`, detail: (c.scope ?? []).join(", "), score: s });
  }
  for (const d of hunch.decisions) {
    const s = score(`${d.title} ${d.decision ?? ""} ${(d.related_files ?? []).join(" ")} ${d.id}`);
    if (s) hits.push({ kind: "decision", id: d.id, label: `[${d.status ?? "?"}] ${d.title}`, detail: d.decision ?? "", file: (d.related_files ?? [])[0], score: s });
  }
  for (const b of hunch.bugs) {
    const s = score(`${b.title} ${b.symptom ?? ""} ${b.root_cause ?? ""} ${(b.affected_files ?? []).join(" ")} ${b.id}`);
    if (s) hits.push({ kind: "bug", id: b.id, label: `[${b.severity}/${b.status}] ${b.title}`, detail: b.root_cause ?? b.symptom ?? "", file: (b.affected_files ?? [])[0], score: s });
  }
  for (const c of hunch.components) {
    const s = score(`${c.name} ${c.responsibility ?? ""} ${(c.paths ?? []).join(" ")} ${c.id}`);
    if (s) hits.push({ kind: "component", id: c.id, label: c.name, detail: c.responsibility ?? "", file: (c.paths ?? [])[0], score: s });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 50);
}

// ---- stale records ---------------------------------------------------------
export type StaleEntry = { kind: RecordKind; id: string; label: string; file?: string };

/** Every constraint/decision/bug whose guarded files changed after its last
 *  verification — the records most likely to be lying to you. */
export function staleRecords(hunch: Hunch, lastChange: (f: string) => number): StaleEntry[] {
  const out: StaleEntry[] = [];
  for (const c of hunch.constraints) if (isStale(c, lastChange)) out.push({ kind: "constraint", id: c.id, label: `[${c.severity}] ${c.statement}`, file: (c.scope ?? [])[0] });
  for (const d of hunch.decisions) if (isStale(d, lastChange)) out.push({ kind: "decision", id: d.id, label: `[${d.status ?? "?"}] ${d.title}`, file: (d.related_files ?? [])[0] });
  for (const b of hunch.bugs) if (isStale({ provenance: b.provenance, related_files: b.affected_files }, lastChange)) out.push({ kind: "bug", id: b.id, label: b.title, file: (b.affected_files ?? [])[0] });
  return out;
}

// ---- review queue (draft triage) -------------------------------------------
// Mirrors src/core/reviewqueue.ts so the extension segments drafts exactly like
// `hunch review` does — no divergence between the CLI and the GUI. Pure over the
// committed JSON; the extension never writes .hunch/ itself (it delegates the
// accept/reject to the CLI, per the "pure reader" invariant).

/** Parsed view of the `synth:` telemetry line syncCommit parks in evidence. */
export interface SynthInfo { provider?: string; grounded?: number; samples?: number; agreement?: number; pruned?: number; verify?: string; raw?: string; }

export function parseSynth(evidence: string[] | undefined): SynthInfo {
  const line = (evidence ?? []).find((e) => e.startsWith("synth:"));
  if (!line) return {};
  const body = line.slice("synth:".length).trim();
  const num = (k: string): number | undefined => { const m = new RegExp(`\\b${k}=(-?[0-9]*\\.?[0-9]+)`).exec(body); return m ? Number(m[1]) : undefined; };
  const str = (k: string): string | undefined => { const m = new RegExp(`\\b${k}=([A-Za-z0-9_.\\-]+)`).exec(body); return m ? m[1] : undefined; };
  return { raw: body, provider: str("provider"), grounded: num("grounded"), samples: num("samples"), agreement: num("agreement"), pruned: num("pruned"), verify: str("verify") };
}

/** Grounded-ness at/above which a Critic-verified draft is a "quick yes". */
export const READY_MIN_GROUNDED = 0.7;

export interface ReviewItem {
  d: Decision;
  synth: SynthInfo;
  verified: boolean;
  /** already human-vouched (roadmap intent / confirmed) rather than an unvetted auto-draft. */
  vouched: boolean;
  confidence: number;
}
export interface ReviewQueue { ready: ReviewItem[]; scrutiny: ReviewItem[]; }

function srcIncludes(d: Decision, needle: string): boolean {
  return (d.provenance?.source ?? "").includes(needle);
}

/** A draft is "ready to confirm" only when the Critic actually audited it AND
 *  judged it well-grounded — a high confidence number alone is not enough. */
export function isReady(d: Decision, synth: SynthInfo, minGrounded: number = READY_MIN_GROUNDED): boolean {
  return srcIncludes(d, "verified") && (synth.grounded ?? 0) >= minGrounded;
}

/** The same set `hunch review` / `hunch status` triage: proposed OR low-confidence. */
export function reviewDrafts(hunch: Hunch): Decision[] {
  return hunch.decisions.filter((d) => d.status === "proposed" || (d.provenance?.confidence ?? 1) < 0.6);
}

/** Split drafts into ready-to-confirm (best-grounded first) and needs-scrutiny
 *  (lowest-confidence first) — the GUI analog of partitionReview. */
export function reviewQueue(hunch: Hunch, minGrounded: number = READY_MIN_GROUNDED): ReviewQueue {
  const items: ReviewItem[] = reviewDrafts(hunch).map((d) => ({
    d,
    synth: parseSynth(d.provenance?.evidence),
    verified: srcIncludes(d, "verified"),
    vouched: srcIncludes(d, "human_confirmed") || (d.provenance?.source === "derived"),
    confidence: d.provenance?.confidence ?? 0,
  }));
  const ready = items.filter((it) => isReady(it.d, it.synth, minGrounded)).sort((a, b) => (b.synth.grounded ?? 0) - (a.synth.grounded ?? 0));
  const scrutiny = items.filter((it) => !isReady(it.d, it.synth, minGrounded)).sort((a, b) => a.confidence - b.confidence);
  return { ready, scrutiny };
}

/** Absolute path to a decision's JSON file (for opening the draft to edit).
 * Overlay-first mirrors HunchStore: a private draft must open from its real home,
 * never as a non-existent public `.hunch` path. */
export function decisionFilePath(hunch: Hunch, id: string): string {
  const privateFile = hunch.overlay?.state === "active"
    ? path.join(hunch.overlay.dir, "decisions", `${id}.json`)
    : "";
  return privateFile && fs.existsSync(privateFile)
    ? privateFile
    : path.join(hunch.root, ".hunch", "decisions", `${id}.json`);
}

// ---- bug lineage chains ----------------------------------------------------
export interface LineageNode { bug: Bug; recurrences: LineageNode[]; }

/** Build recurrence trees: a root bug with the chain of later bugs that recorded
 *  it as `recurrence_of`. Surfaces "this keeps coming back" patterns. */
export function lineageChains(hunch: Hunch): LineageNode[] {
  const byId = new Map(hunch.bugs.map((b) => [b.id, b]));
  const childrenOf = new Map<string, Bug[]>();
  for (const b of hunch.bugs) {
    const parent = b.lineage?.recurrence_of;
    if (parent && byId.has(parent)) (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(b);
  }
  const build = (b: Bug): LineageNode => ({ bug: b, recurrences: (childrenOf.get(b.id) ?? []).map(build) });
  // roots = bugs that are not themselves a recurrence of a known bug
  return hunch.bugs
    .filter((b) => !(b.lineage?.recurrence_of && byId.has(b.lineage.recurrence_of)))
    .map(build)
    .filter((n) => n.recurrences.length > 0); // only show chains with ≥1 recurrence
}

// ---- per-symbol signal (for decorations / hover) ---------------------------
export interface SymbolSignal {
  name: string;
  bugCount: number;
  fragility: number; // 0..1
  evidence: string;
}

/** Symbols in a file that carry signal worth decorating: any with recorded bugs
 *  or a non-trivial fragility score. Keyed by symbol name (lines resolved later
 *  via the language server, since .hunch symbols have no ranges). */
export function symbolSignals(hunch: Hunch, file: string): Map<string, SymbolSignal> {
  const frag = new Map(fragileSymbols(hunch, 9999).map((s) => [s.name, s]));
  const out = new Map<string, SymbolSignal>();
  for (const s of hunch.symbols) {
    if (!(s.file === file || s.file.endsWith(file))) continue;
    const bugCount = s.metrics?.bug_count ?? 0;
    const f = frag.get(s.name);
    const fragility = f?.score ?? 0;
    if (bugCount === 0 && fragility < 0.15) continue; // below noise floor
    const evidence = [bugCount && `${bugCount} bug(s)`, f?.evidence].filter(Boolean).join(" · ") || "fragile";
    out.set(s.name, { name: s.name, bugCount, fragility, evidence });
  }
  return out;
}

/** Bugs whose affected_symbols include a symbol of the given name in `file`. */
export function bugsForSymbol(hunch: Hunch, file: string, name: string): Bug[] {
  const ids = new Set(hunch.symbols.filter((s) => (s.file === file || s.file.endsWith(file)) && s.name === name).map((s) => s.id));
  return hunch.bugs.filter((b) => (b.affected_symbols ?? []).some((s) => ids.has(s)));
}

// ---- component dependency graph --------------------------------------------
export interface GraphNode {
  id: string; name: string; fragility: number; paths: string[];
  symbols: number; constraints: number; bugs: number; decisions: number;
}
export interface GraphLink { source: string; target: string; weight: number; }
export interface ComponentGraph { nodes: GraphNode[]; links: GraphLink[]; }

/** Assign a file to its single best-matching component (longest matching path
 *  glob wins — the most specific owner). */
function ownerComponent(file: string, comps: Component[]): Component | undefined {
  let best: Component | undefined;
  let bestLen = -1;
  for (const c of comps) {
    for (const p of c.paths ?? []) {
      if (pathMatchesGlob(file, p) && p.length > bestLen) { best = c; bestLen = p.length; }
    }
  }
  return best;
}

/** Roll the symbol-level call graph up to components: nodes are components
 *  (sized by owned symbols, colored by fragility, annotated with record counts),
 *  links are cross-component call counts. Self-calls are dropped. */
export function componentGraph(hunch: Hunch): ComponentGraph {
  const comps = hunch.components;
  const symOwner = new Map<string, string>(); // symId -> componentId
  const symCount = new Map<string, number>();
  for (const s of hunch.symbols) {
    const owner = ownerComponent(s.file, comps);
    if (!owner) continue;
    symOwner.set(s.id, owner.id);
    symCount.set(owner.id, (symCount.get(owner.id) ?? 0) + 1);
  }

  const nodes: GraphNode[] = comps.map((c) => {
    const inComp = (files?: string[]) => (files ?? []).some((f) => (c.paths ?? []).some((p) => pathMatchesGlob(f, p)));
    return {
      id: c.id, name: c.name, fragility: c.fragility ?? 0, paths: c.paths ?? [],
      symbols: symCount.get(c.id) ?? 0,
      constraints: hunch.constraints.filter((x) => (x.scope ?? []).some((g) => (c.paths ?? []).some((p) => pathMatchesGlob(p, g) || pathMatchesGlob(g, p)))).length,
      bugs: hunch.bugs.filter((b) => inComp(b.affected_files)).length,
      decisions: hunch.decisions.filter((d) => inComp(d.related_files)).length,
    };
  });

  const linkW = new Map<string, number>();
  for (const e of hunch.edges) {
    if (e.type !== "calls") continue;
    const a = symOwner.get(e.from), b = symOwner.get(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a} ${b}`;
    linkW.set(k, (linkW.get(k) ?? 0) + 1);
  }
  const links: GraphLink[] = [...linkW].map(([k, weight]) => {
    const [source, target] = k.split(" ") as [string, string];
    return { source, target, weight };
  });
  return { nodes, links };
}
