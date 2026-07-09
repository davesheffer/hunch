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
import { externalImportNodeId, externalPackage } from "../core/externalImports.js";
import { resolveRelativeImport } from "../core/relativeImports.js";
import { extracted, inferred, type Symbol, type Edge, type Component } from "../core/types.js";
import { isGitRepo, trackedFiles, fileGitMetrics } from "./git.js";
import { CODE_EXTENSIONS, languageFor } from "./languages.js";
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
  // Language-aware import resolution, shared by the call-resolution "was this
  // name actually imported?" gate (below) and the depends_on edge derivation
  // (pass 3): a Python cross-file call/import must resolve through the same
  // relative/absolute Python rules as everything else, not silently fail the
  // JS/TS resolver and look unimported.
  const hasSrcLayout = [...fileSymbols.keys()].some((f) => f.startsWith("src/"));
  const pyRoots = hasSrcLayout ? ["", "src"] : [""];
  const resolveImportTarget = (file: string, spec: string): string | null =>
    languageFor(file)?.id === "python"
      ? resolvePythonImport(file, spec, fileSymbols, pyRoots)
      : resolveImport(file, spec, fileSymbols);
  const importedFiles = new Map(perFileImports.map(({ file, imports }) => [
    file,
    new Set(imports.map((specifier) => resolveImportTarget(file, specifier)).filter((target): target is string => !!target)),
  ]));

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
        const calleeId = resolveName(calleeName, file, importedFiles.get(file) ?? new Set(), nameIndex, byId);
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
      const target = resolveImportTarget(file, spec);
      if (target) {
        const toCmp = fileToComponent.get(target);
        if (!toCmp || toCmp === fromCmp) continue;
        addEdge({
          id: edgeId(fromCmp, toCmp, "depends_on"),
          from: fromCmp, to: toCmp, type: "depends_on",
          reason: `${file} imports ${target}`, strength: 0.6,
          provenance: extracted(0.9, [`${file}:imports:${spec}`]),
        });
        continue;
      }
      const dependency = externalPackage(spec);
      const external = externalImportNodeId(spec);
      const anchors = [...(fileSymbols.get(file) ?? [])].sort();
      if (!dependency || !external || !anchors.length) continue;
      for (const anchor of anchors) {
        addEdge({
          id: edgeId(anchor, external, "imports"),
          from: anchor, to: external, type: "imports",
          reason: `${file} imports external package ${dependency}`, strength: 1,
          provenance: extracted(1, [`${file}:imports:${spec}`]),
        });
      }
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
    const tracked = trackedFiles(root, CODE_EXTENSIONS)
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
      else if (languageFor(name) !== null) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** Resolve a callee name to a symbol id: prefer same-file, otherwise require a
 * unique symbol in a statically imported local file. A unique repository-wide
 * name is not evidence of a binding: callback parameters and built-ins often
 * share names with unrelated exported symbols. */
function resolveName(
  name: string,
  file: string,
  importedFiles: Set<string>,
  nameIndex: Map<string, string[]>,
  byId: Map<string, Symbol>,
): string | null {
  const candidates = nameIndex.get(name);
  if (!candidates || candidates.length === 0) return null;
  const sameFile = candidates.filter((id) => byId.get(id)?.file === file);
  if (sameFile.length === 1) return sameFile[0]!;
  if (sameFile.length > 1) return null; // ambiguous within the file — don't guess
  const imported = candidates.filter((id) => importedFiles.has(byId.get(id)?.file ?? ""));
  return imported.length === 1 ? imported[0]! : null;
}

/** Resolve a relative import specifier to a concrete tracked file path. */
function resolveImport(fromFile: string, spec: string, fileSymbols: Map<string, string[]>): string | null {
  return resolveRelativeImport(fromFile, spec, fileSymbols.keys()).path;
}

/** First of `${modulePath}.py` / `${modulePath}/__init__.py` that's a tracked file,
 *  or null — the shared "module file vs. package __init__" candidate check used by
 *  both resolvePythonImport branches below. */
function firstExistingPyModule(modulePath: string, fileSymbols: Map<string, string[]>): string | null {
  const candidates = [`${modulePath}.py`, `${modulePath}/__init__.py`];
  for (const c of candidates) if (fileSymbols.has(c)) return c;
  return null;
}

/** Resolve a Python import specifier (relative or absolute) to a concrete tracked
 *  file path. Sibling to resolveImport() — Python's leading dot means "N levels up
 *  from the importing module's own directory," not "a relative file-path fragment"
 *  the way JS/TS's `./`/`../` does. Absolute imports are resolved best-effort
 *  against `pyRoots` (repo root, plus a top-level `src/` layout if one exists) —
 *  no sys.path/PYTHONPATH emulation. A module's own package directory is always
 *  its containing directory, so relative resolution needs no repo-wide
 *  package-root search — only dot-counting from `fromFile`'s own location. */
function resolvePythonImport(
  fromFile: string,
  spec: string,
  fileSymbols: Map<string, string[]>,
  pyRoots: string[],
): string | null {
  if (!spec.startsWith(".")) {
    const specPath = spec.split(".").join("/");
    for (const root of pyRoots) {
      const modulePath = root ? `${root}/${specPath}` : specPath;
      const found = firstExistingPyModule(modulePath, fileSymbols);
      if (found) return found;
    }
    return null;
  }
  const level = spec.length - spec.replace(/^\.+/, "").length;
  const tail = spec.slice(level);
  const dir = toPosix(dirname(fromFile));
  const segments = dir === "." ? [] : dir.split("/");
  const pop = level - 1;
  if (pop > segments.length) return null; // import points above the repo root — don't guess
  const baseSegments = pop > 0 ? segments.slice(0, segments.length - pop) : segments;
  const baseDir = baseSegments.join("/");
  if (!tail) {
    // bare `.`/`..`/etc — `from . import x` only ever resolves to the package's
    // own __init__.py (we track the module path, never the imported name itself,
    // matching resolveImport()'s granularity for JS/TS named imports).
    const initPy = baseDir ? `${baseDir}/__init__.py` : "__init__.py";
    return fileSymbols.has(initPy) ? initPy : null;
  }
  const tailPath = tail.split(".").join("/");
  const modulePath = baseDir ? `${baseDir}/${tailPath}` : tailPath;
  return firstExistingPyModule(modulePath, fileSymbols);
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
