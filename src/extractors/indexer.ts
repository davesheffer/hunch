/**
 * The indexer (DESIGN.md §4 "File changes" row, and `hunch index`).
 * Deterministic, no LLM: walk the repo, parse every registered source file into symbols,
 * resolve a best-effort call graph + import dependency graph, derive components
 * from the directory layout, and compute churn / fan-in / fan-out metrics.
 *
 * `scanRepo` derives Symbol/Edge/Component records without mutating the store.
 * `indexRepo` persists that exact scan into the JSON source of truth; its caller
 * then runs HunchStore.reindex() to refresh the SQLite index.
 */
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { parseSource, attributeCalls, attributeQualifiedCalls, attributeRelations, MAX_BODY_TEXT_CHARS, type ParsedRelation, type QualifiedCall } from "./parse.js";
import { isParserLoadError } from "./nativeTreeSitter.js";
@@CLEANROOM_HOLE_1@@
import { extractK8sManifest, extractKustomization, isKustomizationFile, kustomizeNamespaces, namespacesCompatible, type K8sManifestDocument, type KustomizationInfo, type ManifestNameRef } from "./k8sManifest.js";
import { symbolId, componentId, edgeId, sha1 } from "../core/ids.js";
import { externalImportNodeId, externalPackage } from "../core/externalImports.js";
import { resolveRelativeImport } from "../core/relativeImports.js";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import { extracted, inferred, type Symbol, type Edge, type Component } from "../core/types.js";
import { isGitRepo, fileGitMetrics, revExists } from "./git.js";
import { languageFor } from "./languages.js";
import {
  composerPsr4Mappings,
  phpExternalSpecifier,
  resolvePhpImportTargets,
  resolvePhpReference,
  type PhpPsr4Mapping,
} from "./php.js";
import {
  assertCleanAuxiliarySources,
  assertCleanIndexedCode,
  repoAuxiliarySource,
  repoSourceInventory,
  type RepoScanSource,
  type RepoScanSourceIdentity,
  type RepoSourceIssue,
} from "./repoSource.js";

export interface IndexResult {
  files: number;
  symbols: number;
  edges: number;
  components: number;
  /** Files that could not be parsed (read error / oversized / extraction error). */
  skipped: number;
  coverage: Array<{
    language: string;
    eligible: number;
    parsed: number;
    skipped: number;
    reasons: Record<string, number>;
  }>;
}

export interface RepoScan {
  result: IndexResult;
  symbols: Symbol[];
  edges: Edge[];
  components: Component[];
  source: RepoScanSourceIdentity & { content_hash: string };
  issues: RepoSourceIssue[];
}

export interface ScanRepoOptions {
  churn?: boolean;
  source?: RepoScanSource;
}

export interface IndexRepoOptions {
  churn?: boolean;
  /** Explicit immutable source for setup paths that must never persist checkout
   * bytes. Normal durable refreshes should use requireClean instead. */
  source?: RepoScanSource;
  /** Production publication paths set this to prove graph bytes came only from
   * committed code. Library fixtures and disposable replay checkouts opt in. */
  requireClean?: boolean;
  /** Authoritative replay/proof paths cannot represent a partial graph. Reject
   * every read, path, mode, or parse issue before writing derived JSON. */
  requireComplete?: boolean;
}

/** Read-only policy evaluators must never turn an omitted source file into a
 * false satisfied receipt. Call this after scanRepo when the consumer cannot
 * represent partial-graph uncertainty directly. */
export function assertCompleteRepoScan(scan: RepoScan): void {
  if (!scan.issues.length) return;
  const sample = scan.issues.slice(0, 5)
    .map((issue) => `${issue.path} [${issue.code}]`)
    .join(", ");
  const more = scan.issues.length > 5 ? ` (+${scan.issues.length - 5} more)` : "";
  throw new Error(`incomplete semantic source scan rejected ${scan.issues.length} file(s): ${sample}${more}`);
}

/** A whole-language failure can be a broken grammar, not a set of bad files.
 * Refuse the entire publication so cross-language edges and curated components
 * remain consistent with the previous symbols. Read-only scans retain coverage
 * and issues for diagnostics; a valid empty scan is still publishable. */
export function assertNoTotalParseFailure(scan: RepoScan): void {
  const failed = scan.result.coverage.filter((item) =>
    item.eligible > 0 && item.reasons.parse_failed === item.eligible);
  if (!failed.length) return;
  const details = failed.map((item) => {
    const first = scan.issues.find((issue) =>
      issue.code === "parse_failed" && languageFor(issue.path)?.id === item.language);
    return `${item.language}: all ${item.eligible} eligible file(s) failed to parse; ${first?.detail ?? "unknown parse failure"}`;
  });
  throw new Error(`index refused — ${details.join("; ")}. Previous graph preserved.`);
}

/** Derive the current repository graph without writing JSON or rebuilding SQLite.
 * Read-only gates use this so checking changed code can never rewrite or publish
 * the durable graph merely by inspecting it. Existing public graph records remain
 * inputs for the same churn/component enrichment semantics as a persisted index. */
export function scanRepo(store: HunchStore, root: string, opts: ScanRepoOptions = {}): RepoScan {
  const inventory = repoSourceInventory(root, opts.source);
  const files = inventory.entries;
  const useGit = isGitRepo(root);
  const issues: RepoSourceIssue[] = [];
  const sourceFingerprint: Array<{ path: string; mode: string; content: string }> = [];
  const coverage = new Map<string, { language: string; eligible: number; parsed: number; skipped: number; reasons: Record<string, number> }>();
  const noteCoverage = (path: string, field: "eligible" | "parsed", amount = 1) => {
    const language = languageFor(path)?.id;
    if (!language) return;
    const current = coverage.get(language) ?? { language, eligible: 0, parsed: 0, skipped: 0, reasons: {} };
    current[field] += amount;
    coverage.set(language, current);
  };
  const noteSkip = (path: string, code: RepoSourceIssue["code"]) => {
    const language = languageFor(path)?.id;
    if (!language) return;
    const current = coverage.get(language) ?? { language, eligible: 0, parsed: 0, skipped: 0, reasons: {} };
    current.skipped++;
    current.reasons[code] = (current.reasons[code] ?? 0) + 1;
    coverage.set(language, current);
  };

  let phpPsr4: PhpPsr4Mapping[] = [];
  if (files.some((file) => languageFor(file.path)?.id === "php")) {
    const composer = repoAuxiliarySource(root, opts.source, "composer.json");
    if (!composer.absent) {
      if (composer.source === null) {
        issues.push(composer.issue ?? { path: "composer.json", code: "read_failed", detail: "composer.json could not be read" });
        sourceFingerprint.push({ path: "composer.json", mode: composer.mode, content: composer.contentHash ?? `skipped:${composer.issue?.code ?? "read_failed"}` });
      } else {
        sourceFingerprint.push({ path: "composer.json", mode: composer.mode, content: composer.contentHash! });
        try {
          phpPsr4 = composerPsr4Mappings(JSON.parse(composer.source));
        } catch {
          issues.push({ path: "composer.json", code: "parse_failed", detail: "composer.json is not valid JSON; PHP PSR-4 resolution is incomplete" });
        }
      }
    }
  }

  // Fast scans intentionally skip the expensive 90-day history walk. Zero is
  // not a fresh measurement, though: overwriting a previously measured value
  // makes full and fast scans ping-pong symbols/index.json and can create an
  // endless stream of memory-only commits. Churn is file-level, so retain the
  // latest durable value for every still-indexed file; genuinely new files use
  // the conservative zero default until the next full scan.
  const preservedChurn = new Map<string, number>();
  if (opts.churn === false) {
    for (const symbol of store.json.loadAll("symbols")) {
      preservedChurn.set(symbol.file, Math.max(preservedChurn.get(symbol.file) ?? 0, symbol.metrics.churn_90d));
    }
  }

  // ---- pass 1: parse files -> symbols, remember per-file calls & imports ----
  const symbols: Symbol[] = [];
  const nameIndex = new Map<string, string[]>(); // symbol name -> [symbol ids]
  const fileSymbols = new Map<string, string[]>(); // file -> symbol ids (in-file resolution)
@@CLEANROOM_HOLE_2@@
  const perFileCalls: Array<{ file: string; bySym: Map<number, Map<string, boolean>>; qualified: Map<number, QualifiedCall[]> }> = [];
  const perFileImports: Array<{ file: string; imports: string[] }> = [];
  const perFileRelations: Array<{ file: string; bySym: Map<number, ParsedRelation[]> }> = [];
  // `namespace` on all four: a Kubernetes reference only resolves WITHIN a
  // namespace, so a same-named resource in a different one is a different
  // resource (issue #297). null means UNKNOWN (absent/templated/empty), which
  // matches anything -- see namespacesCompatible. All four are in-memory
  // resolution scratch, never persisted: the edges they produce keep their
  // existing shape.
  const k8sResourceIndex: Array<{ symbolId: string; scope: string; kind: string; nameKey: string; namespace: string | null }> = [];
  const k8sReferenceCandidates: Array<{ fromSymbolId: string; scope: string; refKind: string; nameKey: string; namespace: string | null; reason: string }> = [];
  const k8sSelectors: Array<{ symbolId: string; scope: string; namespace: string | null; selector: Record<string, string> }> = [];
  const k8sWorkloadLabels: Array<{ symbolId: string; scope: string; namespace: string | null; labels: Record<string, string> }> = [];
  const phpNamespaces = new Map<string, string | null>();
  const phpUseDeclarations = new Map<string, string[]>();
  // Batched per-file git metrics (churn + last commit) in TWO `git log` spawns
  // total, instead of two per file — the dominant cost of indexing a large repo.
  const rels = files.map((file) => file.path);
@@CLEANROOM_HOLE_3@@
  const gitMeta = useGit ? fileGitMetrics(root, rels, opts.churn === false ? 0 : 90) : null;
  let skipped = 0;
  // Kustomize namespace transformers must be known before any manifest is
  // extracted, so kustomization files are read up front (their reads are
  // reused by the main loop below, not repeated).
  const preRead = new Map<string, ReturnType<(typeof files)[number]["read"]>>();
  const kustomizations = new Map<string, KustomizationInfo>();
  for (const file of files) {
    if (!isKustomizationFile(file.path)) continue;
    const read = file.read();
    preRead.set(file.path, read);
    if (!read.absent && read.source !== null) {
      const dir = posix.dirname(file.path);
      kustomizations.set(dir === "." ? "" : dir, extractKustomization(read.source));
    }
  }
  const kustomizeNamespaceFor = kustomizeNamespaces(kustomizations, new Set(rels));

  for (const file of files) {
    const rel = file.path;
    const read = preRead.get(rel) ?? file.read();
    if (read.absent) {
      sourceFingerprint.push({ path: rel, mode: read.mode, content: "absent" });
      continue;
    }
    noteCoverage(rel, "eligible");
    if (read.source === null) {
      skipped++;
      const issue = read.issue ?? { path: rel, code: "read_failed" as const, detail: `${rel} could not be read` };
      issues.push(issue);
      noteSkip(rel, issue.code);
      sourceFingerprint.push({ path: rel, mode: read.mode, content: read.contentHash ?? `skipped:${issue.code}` });
      continue;
    }
    const src = read.source;
    sourceFingerprint.push({ path: rel, mode: read.mode, content: read.contentHash! });
    // one bad/oversized file must never abort the whole index run
    let parsed;
    try {
      parsed = parseSource(rel, src, { throwOnParseError: true });
    } catch (error) {
      // …but a dead PARSER is not a bad file. The native addons load on first
      // parse, so a broken load (unwritable TMPDIR, missing prebuild, an addon
      // preloaded past the isolation guard) surfaces here and would mark every
      // file parse_failed, after which indexRepo replaces symbols/edges/
      // components with empty arrays and exits 0 — the whole graph silently
      // wiped. Rethrow so the scan dies before its first store write, the way
      // the import-time load did.
      if (isParserLoadError(error)) throw error;
      skipped++;
      issues.push({ path: rel, code: "parse_failed", detail: `${rel} could not be parsed: ${error instanceof Error ? error.message : String(error)}` });
      noteSkip(rel, "parse_failed");
      continue;
    }
    if (!parsed) {
      skipped++;
      issues.push({ path: rel, code: "parse_failed", detail: `${rel} has no supported parser` });
      noteSkip(rel, "parse_failed");
      continue;
    }
    if (!parsed.parseable) {
      skipped++;
      issues.push({ path: rel, code: "parse_failed", detail: `${rel} contains syntax errors and cannot prove a complete semantic graph` });
      noteSkip(rel, "parse_failed");
      continue;
    }
    noteCoverage(rel, "parsed");

@@CLEANROOM_HOLE_4@@
    // Identity name a K8s symbol's id is derived from when its kind/name is
    // NOT unique in this file (issue #382). Absent for the common unique case,
    // so that id is exactly what it always was; a same-kind/name pair in
    // different namespaces gets kind/name@namespace for EVERY member, never a
    // document-order ordinal, so reordering documents can't rename them. The
    // file path is already in every symbol id, so the same resource repeated
    // across overlay dirs is distinct by path without any extra disambiguator.
    const k8sIdNames = new Map<object, string>();
@@CLEANROOM_HOLE_5@@
      k8sDocs = kustomizeNamespaceFor.has(rel)
        ? extractK8sManifest(src, { namespace: kustomizeNamespaceFor.get(rel)! })
        : extractK8sManifest(src);
      const resourceDocs = k8sDocs
        .filter((d): d is K8sManifestDocument & { resource: NonNullable<K8sManifestDocument["resource"]> } => d.resource !== null);
      const nameCounts = new Map<string, number>();
      for (const d of resourceDocs) {
        const name = `${d.resource.kind}/${displayNameText(d.resource.name)}`;
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const k8sSymbols = resourceDocs
@@CLEANROOM_HOLE_6@@
        .map((d) => {
          const sym = {
@@CLEANROOM_HOLE_7@@
          };
          if ((nameCounts.get(sym.name) ?? 0) > 1) k8sIdNames.set(sym, `${sym.name}@${d.resource.namespace ?? ""}`);
          return sym;
        });
@@CLEANROOM_HOLE_8@@
    const m = gitMeta?.get(rel);
    const churn = opts.churn === false ? (preservedChurn.get(rel) ?? 0) : (m?.churn ?? 0);
    const last = m?.lastCommit ?? "";

    const idsInFile: string[] = [];
@@CLEANROOM_HOLE_9@@
    const idCounts = new Map<string, number>(); // disambiguate same (file,name,kind)
@@CLEANROOM_HOLE_10@@
      const base = symbolId(rel, k8sIdNames.get(ps) ?? ps.name, ps.kind);
      const n = idCounts.get(base) ?? 0;
      idCounts.set(base, n + 1);
      // parse() returns symbols sorted by start byte, so the ordinal is stable
      // (for K8s resources it is only reached by two documents with the SAME
      // kind, namespace and name in one file -- indistinguishable by identity)
      const id = n === 0 ? base : `${base}_${n}`;
      idsInFile.push(id);
@@CLEANROOM_HOLE_11@@
      symbols.push({
        id, file: rel, name: ps.name, kind: ps.kind,
        signature_hash: sha1(ps.bodyText).slice(0, 16),
        calls: [], called_by: [],
        metrics: { loc: ps.loc, churn_90d: churn, bug_count: 0, fan_in: 0, fan_out: 0 },
        last_changed: last,
      });
@@CLEANROOM_HOLE_12@@
      const namespace = doc.resource.namespace;
      k8sResourceIndex.push({ symbolId: fromId, scope, kind: doc.resource.kind, nameKey: nameKeyText(doc.resource.name), namespace });
@@CLEANROOM_HOLE_13@@
          fromSymbolId: fromId, scope, refKind: ref.refKind, nameKey: nameKeyText(ref.name), namespace: ref.namespace,
@@CLEANROOM_HOLE_14@@
      if (doc.selector) k8sSelectors.push({ symbolId: fromId, scope, namespace, selector: doc.selector });
      if (doc.labels) k8sWorkloadLabels.push({ symbolId: fromId, scope, namespace, labels: doc.labels });
    }
    fileSymbols.set(rel, idsInFile);
@@CLEANROOM_HOLE_15@@
    perFileCalls.push({ file: rel, bySym: attributeCalls(parsed), qualified: attributeQualifiedCalls(parsed) });
    perFileImports.push({ file: rel, imports: parsed.imports });
    perFileRelations.push({ file: rel, bySym: attributeRelations(parsed) });
    if (languageFor(rel)?.id === "php") {
      phpNamespaces.set(rel, parsed.namespace);
      phpUseDeclarations.set(rel, parsed.imports.filter((capture) => /^\s*use\b/i.test(capture)));
    }
  }

  const byId = new Map(symbols.map((s) => [s.id, s]));
@@CLEANROOM_HOLE_16@@
  const goModule = readGoModulePath(root);
  const trackedFiles = new Set(fileSymbols.keys());
  const resolveImportTargets = (file: string, spec: string): string[] => {
    const langId = languageFor(file)?.id;
    if (langId === "python") return [resolvePythonImport(file, spec, fileSymbols, pyRoots)].filter((target): target is string => !!target);
    if (langId === "go") return [resolveGoImport(spec, fileSymbols, goModule)].filter((target): target is string => !!target);
    if (langId === "php") {
      return resolvePhpImportTargets(
        file,
        spec,
        phpNamespaces.get(file) ?? null,
        phpUseDeclarations.get(file) ?? [],
        phpPsr4,
        trackedFiles,
      );
    }
    return [resolveImport(file, spec, trackedFiles)].filter((target): target is string => !!target);
  };
@@CLEANROOM_HOLE_17@@
    const targets = new Set(imports.flatMap((specifier) => resolveImportTargets(file, specifier)));
@@CLEANROOM_HOLE_18@@

  // ---- pass 2: resolve calls -> symbol-level edges -------------------------
  const edges: Edge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (e: Edge) => {
    if (edgeSeen.has(e.id)) return;
    edgeSeen.add(e.id);
    edges.push(e);
  };

  for (const { file, bySym, qualified } of perFileCalls) {
@@CLEANROOM_HOLE_19@@
      if (!callerId) continue;
      const callerName = byId.get(callerId)?.name ?? "?";
      for (const [calleeName, memberOnly] of callees) {
        let resolvedName = calleeName;
        const candidates = new Set(importedFiles.get(file) ?? []);
        if (languageFor(file)?.id === "php") {
          const reference = resolvePhpReference(
            calleeName,
            phpNamespaces.get(file) ?? null,
            phpUseDeclarations.get(file) ?? [],
            phpPsr4,
            trackedFiles,
          );
          resolvedName = reference.symbolName;
          for (const target of reference.files) candidates.add(target);
        }
        const calleeId = resolveName(resolvedName, file, candidates, nameIndex, byId);
        if (!calleeId || calleeId === callerId) continue;
        // A member call `x.foo()` only yields an edge when `foo` resolves to a
        // method or a same-file symbol — not a coincidentally-named top-level fn.
        if (memberOnly) {
          const sym = byId.get(calleeId);
          if (!sym || (sym.kind !== "method" && sym.file !== file)) continue;
        }
        addEdge({
          schema: "hunch.edge/1",
@@CLEANROOM_HOLE_20@@
          provenance: extracted(0.8, [file]),
          environment: null,
          metadata: {},
        });
      }
    }
    // Calls pinned to one imported module (`ns.fn()`, aliased `g()`): the member
    // gate above drops them, so resolve the name ONLY inside that module's files —
    // a unique match there is the binding; zero or several -> no edge.
    // A module binding exposes top-level exports, so `U.helper()` prefers a function
    // `helper` over a same-named class method `Foo.helper`; a sole method match still
    // binds, since `module.exports = { helper() {} }` parses as a method too.
    const moduleFiles = new Map<string, Set<string>>(); // resolve each module once per file
    for (const [callerIndex, targets] of qualified) {
      const callerId = indexToId.get(callerIndex);
      if (!callerId) continue;
      const callerName = byId.get(callerId)?.name ?? "?";
      for (const { callee, module } of targets) {
        let files = moduleFiles.get(module);
        if (!files) moduleFiles.set(module, files = new Set(resolveImportTargets(file, module)));
        const inModule = (nameIndex.get(callee) ?? []).filter((id) => {
          const sym = byId.get(id);
          return !!sym && files.has(sym.file);
        });
        const nonMethods = inModule.filter((id) => byId.get(id)!.kind !== "method");
        const matches = nonMethods.length > 0 ? nonMethods : inModule;
        if (matches.length !== 1 || matches[0] === callerId) continue;
        const calleeId = matches[0]!;
        addEdge({
          schema: "hunch.edge/1",
          id: edgeId(callerId, calleeId, edgeType),
          from: callerId, to: calleeId, type: edgeType,
          reason: `${callerName} ${edgeType} ${callee}`, strength: 0.8,
          provenance: extracted(0.8, [file]),
          environment: null,
          metadata: {},
        });
      }
    }
  }

@@CLEANROOM_HOLE_21@@
  //
  // Namespace is a FILTER applied to the candidate list, not part of the key
  // (issue #297): an unknown namespace on either side must still match, which
  // a key can't express. Filtering before the uniqueness check -- rather than
  // after picking a single candidate -- is what makes "ref in a, candidates in
  // a and b" resolve to a instead of declining as ambiguous, while "ref in a,
  // candidates in a and unknown" correctly stays ambiguous.
  const kindNameIndex = new Map<string, typeof k8sResourceIndex>();
@@CLEANROOM_HOLE_22@@
    pushInto(kindNameIndex, key, r);
@@CLEANROOM_HOLE_23@@
    const byName = kindNameIndex.get(`${ref.scope}:${ref.refKind}:${ref.nameKey}`) ?? [];
    const candidates = byName.filter((c) => namespacesCompatible(ref.namespace, c.namespace));
@@CLEANROOM_HOLE_24@@
    const toId = candidates[0]!.symbolId;
@@CLEANROOM_HOLE_25@@
        // A Service only ever selects pods in its OWN namespace -- a
        // label-identical workload next door is a different workload (issue
        // #297). Unknown on either side still matches, same rule as Phase 1.
        if (!namespacesCompatible(svc.namespace, wl.namespace)) continue;
@@CLEANROOM_HOLE_26@@
  // PHP's static type relationships use the same symbol graph and conservative
  // resolver as calls. Ambiguous or dynamic targets produce no edge.
  for (const { file, bySym } of perFileRelations) {
    const indexToId = fileSymbolIndexId.get(file) ?? new Map<number, string>();
    for (const [sourceIndex, relations] of bySym) {
      const sourceId = indexToId.get(sourceIndex);
      if (!sourceId) continue;
      const sourceName = byId.get(sourceId)?.name ?? "?";
      for (const relation of relations) {
        const resolved = resolvePhpReference(
          relation.target,
          phpNamespaces.get(file) ?? null,
          phpUseDeclarations.get(file) ?? [],
          phpPsr4,
          trackedFiles,
        );
        const candidates = new Set(importedFiles.get(file) ?? []);
        for (const target of resolved.files) candidates.add(target);
        const targetId = resolveName(resolved.symbolName, file, candidates, nameIndex, byId);
        if (!targetId || targetId === sourceId) continue;
        addEdge({
          schema: "hunch.edge/1",
          id: edgeId(sourceId, targetId, relation.edgeType),
          from: sourceId,
          to: targetId,
          type: relation.edgeType,
          reason: `${sourceName} ${relation.label} ${resolved.symbolName}`,
          strength: 1,
          provenance: extracted(1, [file]),
          environment: null,
          metadata: { php_relation: relation.label },
        });
      }
    }
  }

@@CLEANROOM_HOLE_27@@
  for (const e of edges) {
@@CLEANROOM_HOLE_28@@
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
      const targets = resolveImportTargets(file, spec);
      if (targets.length) {
        for (const target of targets) {
        const toCmp = fileToComponent.get(target);
        if (!toCmp || toCmp === fromCmp) continue;
        addEdge({
          schema: "hunch.edge/1",
          id: edgeId(fromCmp, toCmp, "depends_on"),
          from: fromCmp, to: toCmp, type: "depends_on",
          reason: `${file} imports ${target}`, strength: 0.6,
          provenance: extracted(0.9, [`${file}:imports:${spec}`]),
          environment: null,
          metadata: {},
        });
        }
        continue;
      }
      const externalSpecifier = languageFor(file)?.id === "php" ? phpExternalSpecifier(spec) : spec;
      const dependency = externalSpecifier ? externalPackage(externalSpecifier) : null;
      const external = externalSpecifier ? externalImportNodeId(externalSpecifier) : null;
      const anchors = [...(fileSymbols.get(file) ?? [])].sort();
      if (!dependency || !external || !anchors.length) continue;
      for (const anchor of anchors) {
        addEdge({
          schema: "hunch.edge/1",
          id: edgeId(anchor, external, "imports"),
          from: anchor, to: external, type: "imports",
          reason: `${file} imports external package ${dependency}`, strength: 1,
          provenance: extracted(1, [`${file}:imports:${spec}`]),
          environment: null,
          metadata: {},
        });
      }
    }
  }

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
  return {
    result: {
      files: files.length,
      symbols: symbols.length,
      edges: edges.length,
      components: compsOut.length,
      skipped,
      coverage: [...coverage.values()].sort((left, right) => compareCodeUnits(left.language, right.language)),
    },
    symbols,
    edges,
    components: compsOut,
    source: { ...inventory.identity, content_hash: sha1(JSON.stringify(sourceFingerprint)) },
    issues,
  };
}

/** True for an edge this indexer produced: the scan re-derives exactly these on
 *  every pass, so they — and only they — are safe to replace wholesale. */
export function isExtractorEdge(edge: Edge): boolean {
  return edge.schema === "hunch.edge/1" && edge.provenance.source === "extracted";
}

/** Merge a fresh scan into the stored edge set. A scan can only re-derive what
 *  it extracted; `supersedes` edges (written by the store) and human-reviewed
 *  Landscape relationships have no other source, so replacing the whole index
 *  with the scan deleted them on every `hunch index` (issue #288). Non-extractor
 *  edges are carried forward in their stored order and win an id collision:
 *  a reviewed or store-written fact outranks a re-derivable one. */
export function mergeScannedEdges(stored: Edge[], scanned: Edge[]): Edge[] {
  const carried = stored.filter((edge) => !isExtractorEdge(edge));
  const carriedIds = new Set(carried.map((edge) => edge.id));
  return [...carried, ...scanned.filter((edge) => !carriedIds.has(edge.id))];
}

/** Persist one pure scan into the Git-native source of truth. */
export function indexRepo(store: HunchStore, root: string, opts: IndexRepoOptions = {}): IndexResult {
  if (opts.requireClean) {
    assertCleanIndexedCode(root);
    assertCleanAuxiliarySources(root, ["composer.json"]);
  }
  // A clean preflight followed by a filesystem read still has a TOCTOU seam.
  // Durable Git-backed publication therefore derives from immutable HEAD blobs;
  // unborn and non-Git repositories retain the historical safe-filesystem path.
  const source = opts.requireClean && isGitRepo(root) && revExists("HEAD", root)
    ? { kind: "commit" as const, ref: "HEAD" }
    : opts.source;
  const scan = scanRepo(store, root, { churn: opts.churn, source });
  assertNoTotalParseFailure(scan);
  if (opts.requireComplete) assertCompleteRepoScan(scan);
  store.json.replaceAll("symbols", scan.symbols);
  store.json.replaceAll("edges", mergeScannedEdges(store.json.loadAll("edges"), scan.edges));
  store.json.replaceAll("components", scan.components);
  return scan.result;
}

// ---- helpers --------------------------------------------------------------

@@CLEANROOM_HOLE_29@@
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
function resolveImport(fromFile: string, spec: string, trackedFiles: ReadonlySet<string>): string | null {
  return resolveRelativeImport(fromFile, spec, trackedFiles).path;
}

@@CLEANROOM_HOLE_30@@
/** The `module` path declared in the repo's go.mod, or null. A resolution HINT
 *  only (it widens depends_on edge coverage); reading it best-effort from the
 *  filesystem never gates a scan. */
function readGoModulePath(root: string): string | null {
  try {
    const match = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"));
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** Lexicographically-first tracked .go file whose directory is exactly `dir`
 *  ("" = repo root) — a Go import names a PACKAGE (directory), so any file in it
 *  identifies the right component for a depends_on edge. */
function firstGoFileInDir(dir: string, fileSymbols: Map<string, string[]>): string | null {
  let best: string | null = null;
  for (const f of fileSymbols.keys()) {
    if (!f.endsWith(".go")) continue;
    const d = toPosix(dirname(f));
    const matches = dir === "" ? d === "." : d === dir;
    if (matches && (!best || f < best)) best = f;
  }
  return best;
}

/** Resolve a Go import path to a tracked file. Sibling to resolvePythonImport():
 *  an in-module import is the go.mod module path plus the package directory, so
 *  strip the declared module prefix and look the directory up exactly; with no
 *  go.mod, try the path as a repo-relative directory. Anything else (stdlib,
 *  external modules) resolves to null — no suffix guessing, a wrong depends_on
 *  edge is worse than a missing one. */
function resolveGoImport(spec: string, fileSymbols: Map<string, string[]>, goModule: string | null): string | null {
  if (goModule) {
    if (spec === goModule) return firstGoFileInDir("", fileSymbols);
    if (spec.startsWith(`${goModule}/`)) return firstGoFileInDir(spec.slice(goModule.length + 1), fileSymbols);
  }
  return firstGoFileInDir(spec, fileSymbols);
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
@@CLEANROOM_HOLE_31@@
    out.push({
      id: componentId(dir),
      kind: "module",
      name: capitalize(name),
      responsibility: "",
@@CLEANROOM_HOLE_32@@
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
