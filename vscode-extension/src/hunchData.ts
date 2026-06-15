/**
 * Self-contained read layer over the committed .hunch/ JSON source of truth.
 * No native deps, no dependency on the hunch CLI — the extension is a pure
 * viewer over the JSON, so it works anywhere the repo is checked out.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Provenance {
  source?: string;
  confidence?: number;
  evidence?: string[];
  last_verified?: string;
}
export interface Component { id: string; name: string; responsibility?: string; paths?: string[]; fragility?: number; provenance?: Provenance; }
export interface Edge { id: string; from: string; to: string; type: string; }
export interface Sym { id: string; file: string; name: string; kind: string; metrics?: { churn_90d?: number; bug_count?: number; fan_in?: number }; }
export interface Decision { id: string; title: string; status?: string; decision?: string; related_files?: string[]; related_components?: string[]; provenance?: Provenance; }
export interface Bug { id: string; title: string; symptom?: string; root_cause?: string; severity?: string; status?: string; affected_files?: string[]; affected_symbols?: string[]; provenance?: Provenance; }
export interface Constraint { id: string; statement: string; scope?: string[]; severity?: string; rationale?: string; provenance?: Provenance; }

export interface Hunch {
  root: string;
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

export function loadHunch(root: string): Hunch | null {
  const dir = path.join(root, ".hunch");
  if (!fs.existsSync(dir)) return null;
  return {
    root,
    components: readDir<Component>(path.join(dir, "components")),
    edges: readJson<Edge>(path.join(dir, "edges", "index.json")),
    symbols: readJson<Sym>(path.join(dir, "symbols", "index.json")),
    decisions: readDir<Decision>(path.join(dir, "decisions")),
    bugs: readDir<Bug>(path.join(dir, "bugs")),
    constraints: readDir<Constraint>(path.join(dir, "constraints")),
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
