/**
 * The indexer (DESIGN.md §4 "File changes" row, and `hunch index`).
 * Deterministic, no LLM: walk the repo, parse every TS/JS file into symbols,
 * resolve a best-effort call graph + import dependency graph, derive components
 * from the directory layout, and compute churn / fan-in / fan-out metrics.
 *
 * Writes Symbol/Edge/Component records to the JSON source of truth. The caller
 * then runs HunchStore.reindex() to refresh the SQLite index.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, dirname, posix } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { parseSource, attributeCalls } from "./parse.js";
import { symbolId, componentId, edgeId, sha1 } from "../core/ids.js";
import { extracted, inferred, type Symbol, type Edge, type Component } from "../core/types.js";
import { isGitRepo, trackedFiles, fileGitMetrics } from "./git.js";

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".hunch", "coverage", ".next", "out"]);

export interface IndexResult {
  files: number;
  symbols: number;
  edges: number;
  components: number;
  /** Files that could not be parsed (read error / oversized / extraction error). */
  skipped: number;
}

export function indexRepo(store: HunchStore, root: string, opts: { churn?: boolean } = {}): IndexResult {
  const files = listCodeFiles(root);
  const useGit = isGitRepo(root);

  // ---- pass 1: parse files -> symbols, remember per-file calls & imports ----
  const symbols: Symbol[] = [];
  const nameIndex = new Map<string, string[]>(); // symbol name -> [symbol ids]
  const fileSymbols = new Map<string, string[]>(); // file -> symbol ids (in-file resolution)
  const fileStartByteId = new Map<string, Map<number, string>>(); // file -> (symbol startByte -> id)
  const perFileCalls: Array<{ file: string; bySym: Map<number, Map<string, boolean>> }> = [];
  const perFileImports: Array<{ file: string; imports: string[] }> = [];
  // Batched per-file git metrics (churn + last commit) in TWO `git log` spawns
  // total, instead of two per file — the dominant cost of indexing a large repo.
  const rels = files.map((abs) => toPosix(relative(root, abs)));
  const gitMeta = useGit ? fileGitMetrics(root, rels, opts.churn === false ? 0 : 90) : null;
  let skipped = 0;

  for (const abs of files) {
    const rel = toPosix(relative(root, abs));
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      skipped++;
      continue;
    }
    // one bad/oversized file must never abort the whole index run
    let parsed;
    try {
      parsed = parseSource(rel, src);
    } catch {
      skipped++;
      continue;
    }
    if (!parsed) {
      skipped++;
      continue;
    }

    const m = gitMeta?.get(rel);
    const churn = m?.churn ?? 0;
    const last = m?.lastCommit ?? "";

    const idsInFile: string[] = [];
    const startByteId = new Map<number, string>();
    const idCounts = new Map<string, number>(); // disambiguate same (file,name,kind)
    for (const ps of parsed.symbols) {
      const base = symbolId(rel, ps.name, ps.kind);
      const n = idCounts.get(base) ?? 0;
      idCounts.set(base, n + 1);
      // parse() returns symbols sorted by start byte, so the ordinal is stable
      const id = n === 0 ? base : `${base}_${n}`;
      idsInFile.push(id);
      startByteId.set(ps.startByte, id);
      (nameIndex.get(ps.name) ?? nameIndex.set(ps.name, []).get(ps.name)!).push(id);
      symbols.push({
        id, file: rel, name: ps.name, kind: ps.kind,
        signature_hash: sha1(ps.bodyText).slice(0, 16),
        calls: [], called_by: [],
        metrics: { loc: ps.loc, churn_90d: churn, bug_count: 0, fan_in: 0, fan_out: 0 },
        last_changed: last,
      });
    }
    fileSymbols.set(rel, idsInFile);
    fileStartByteId.set(rel, startByteId);
    perFileCalls.push({ file: rel, bySym: attributeCalls(parsed) });
    perFileImports.push({ file: rel, imports: parsed.imports });
  }

  const byId = new Map(symbols.map((s) => [s.id, s]));

  // ---- pass 2: resolve calls -> symbol-level edges -------------------------
  const edges: Edge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (e: Edge) => {
    if (edgeSeen.has(e.id)) return;
    edgeSeen.add(e.id);
    edges.push(e);
  };

  for (const { file, bySym } of perFileCalls) {
    const sbToId = fileStartByteId.get(file) ?? new Map<number, string>();
    for (const [callerStartByte, callees] of bySym) {
      // resolve caller by its stable byte-offset identity (not name)
      const callerId = sbToId.get(callerStartByte);
      if (!callerId) continue;
      const callerName = byId.get(callerId)?.name ?? "?";
      for (const [calleeName, memberOnly] of callees) {
        const calleeId = resolveName(calleeName, file, nameIndex, byId);
        if (!calleeId || calleeId === callerId) continue;
        // A member call `x.foo()` only yields an edge when `foo` resolves to a
        // method or a same-file symbol — not a coincidentally-named top-level fn.
        if (memberOnly) {
          const sym = byId.get(calleeId);
          if (!sym || (sym.kind !== "method" && sym.file !== file)) continue;
        }
        addEdge({
          id: edgeId(callerId, calleeId, "calls"),
          from: callerId, to: calleeId, type: "calls",
          reason: `${callerName} calls ${calleeName}`, strength: 0.8,
          provenance: extracted(0.8, [file]),
        });
      }
    }
  }

  // fan-in / fan-out from resolved call edges
  for (const e of edges) {
    if (e.type !== "calls") continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from) {
      from.metrics.fan_out++;
      from.calls.push(e.to);
    }
    if (to) {
      to.metrics.fan_in++;
      to.called_by.push(e.from);
    }
  }

  // ---- pass 3: components from directory layout + import dep edges ----------
  const components = deriveComponents(symbols);
  const fileToComponent = new Map<string, string>();
  for (const c of components) for (const f of c._files) fileToComponent.set(f, c.id);

  for (const { file, imports } of perFileImports) {
    const fromCmp = fileToComponent.get(file);
    if (!fromCmp) continue;
    for (const spec of imports) {
      const target = resolveImport(file, spec, fileSymbols);
      if (!target) continue;
      const toCmp = fileToComponent.get(target);
      if (!toCmp || toCmp === fromCmp) continue;
      addEdge({
        id: edgeId(fromCmp, toCmp, "depends_on"),
        from: fromCmp, to: toCmp, type: "depends_on",
        reason: `${file} imports ${target}`, strength: 0.6,
        provenance: extracted(0.9, [`${file}:imports:${spec}`]),
      });
    }
  }

  // persist
  store.json.replaceAll("symbols", symbols);
  store.json.replaceAll("edges", edges);
  // Components are derived-but-ENRICHED records: layout facts (paths, kind, name)
  // come from this scan, while curation/synthesis (responsibility, owners, status,
  // fragility from raiseFragility, upgraded provenance) lives only on the stored
  // record and must survive a reindex. Timestamps are preserved so an unchanged
  // component is byte-identical — reindexing must not churn git.
  const prior = new Map(store.json.loadAll("components").map((c) => [c.id, c] as const));
  const stamp = (c: Component): string => JSON.stringify({ ...c, created_at: "", updated_at: "" });
  const compsOut: Component[] = components.map(({ _files, ...draft }) => {
    const prev = prior.get(draft.id);
    if (!prev) return draft;
    const merged: Component = {
      ...draft,
      responsibility: prev.responsibility || draft.responsibility,
      owners: prev.owners.length ? prev.owners : draft.owners,
      status: prev.status,
      fragility: Math.max(prev.fragility, draft.fragility),
      provenance: prev.provenance.source !== "inferred" ? prev.provenance : draft.provenance,
      created_at: prev.created_at,
      updated_at: prev.updated_at,
    };
    return stamp(merged) === stamp(prev) ? prev : { ...merged, updated_at: draft.updated_at };
  });
  store.json.replaceAll("components", compsOut);

  return { files: files.length, symbols: symbols.length, edges: edges.length, components: compsOut.length, skipped };
}

// ---- helpers --------------------------------------------------------------

function listCodeFiles(root: string): string[] {
  if (isGitRepo(root)) {
    // Apply SKIP_DIRS to the git-tracked list too: a repo that (accidentally)
    // tracks node_modules/ or dist/ must not flood the graph with vendored symbols.
    const tracked = trackedFiles(root, CODE_EXTS)
      .filter((f) => !f.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)))
      .map((f) => join(root, f));
    if (tracked.length > 0) return tracked; // else fall through (nothing committed yet)
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (CODE_EXTS.some((e) => name.endsWith(e))) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** Resolve a callee name to a symbol id: prefer same-file, else unique global. */
function resolveName(
  name: string,
  file: string,
  nameIndex: Map<string, string[]>,
  byId: Map<string, Symbol>,
): string | null {
  const candidates = nameIndex.get(name);
  if (!candidates || candidates.length === 0) return null;
  const sameFile = candidates.filter((id) => byId.get(id)?.file === file);
  if (sameFile.length === 1) return sameFile[0]!;
  if (sameFile.length > 1) return null; // ambiguous within the file — don't guess
  if (candidates.length === 1) return candidates[0]!;
  // ambiguous across files — skip to avoid wrong edges (keeps the graph clean)
  return null;
}

/** Resolve a relative import specifier to a concrete tracked file path. */
function resolveImport(fromFile: string, spec: string, fileSymbols: Map<string, string[]>): string | null {
  if (!spec.startsWith(".")) return null; // external package
  const base = toPosix(join(dirname(fromFile), spec));
  // Prefer TS source rewrites over the literal `.js` specifier: in a TS repo an
  // import of "./db.js" resolves to db.ts. Only fall back to the literal path.
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.jsx$/, ".tsx"),
    base + ".ts",
    base + ".tsx",
    base,
    base + ".js",
    toPosix(join(base, "index.ts")),
    toPosix(join(base, "index.tsx")),
    toPosix(join(base, "index.js")),
  ];
  for (const c of candidates) if (fileSymbols.has(c)) return c;
  return null;
}

interface ComponentDraft extends Component {
  _files: string[];
}

/** Derive components from the directory layout: the directory immediately under
 *  `src/` (or the top-level dir) groups files into a module component. */
function deriveComponents(symbols: Symbol[]): ComponentDraft[] {
  const groups = new Map<string, Set<string>>(); // dir key -> files
  for (const s of symbols) {
    const key = componentDir(s.file);
    (groups.get(key) ?? groups.set(key, new Set()).get(key)!).add(s.file);
  }
  const now = new Date().toISOString();
  const out: ComponentDraft[] = [];
  for (const [dir, fileSet] of groups) {
    const name = dir.split("/").filter(Boolean).pop() ?? dir;
    out.push({
      id: componentId(dir),
      kind: "module",
      name: capitalize(name),
      responsibility: "",
      paths: [dir.endsWith("/") ? dir + "**" : dir + "/**"],
      status: "active",
      owners: [],
      fragility: 0,
      provenance: inferred(0.5, [dir]),
      created_at: now,
      updated_at: now,
      _files: [...fileSet],
    });
  }
  return out;
}

function componentDir(file: string): string {
  const parts = file.split("/");
  if (parts[0] === "src" && parts.length > 2) return `src/${parts[1]}`;
  if (parts.length > 1) return parts[0]!;
  return ".";
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join(posix.sep);
}
