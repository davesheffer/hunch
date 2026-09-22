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
import { parseSource, attributeCalls, attributeRelations, MAX_BODY_TEXT_CHARS, type ParsedRelation } from "./parse.js";
import { isParserLoadError } from "./nativeTreeSitter.js";
import { extractHelmDirectives } from "./helm.js";
import { extractK8sManifest, namespacesCompatible, type K8sManifestDocument, type ManifestNameRef } from "./k8sManifest.js";
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
  const fileSymbolIndexId = new Map<string, Map<number, string>>(); // file -> (symbol index in parsed.symbols -> id)
  const perFileCalls: Array<{ file: string; bySym: Map<number, Map<string, boolean>> }> = [];
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
  const chartRootFor = nearestChartRoot(rels);
  const chartFiles = new Map<string, string[]>();
  for (const path of rels) {
    if (languageFor(path)?.id !== "yaml") continue;
    const chartRoot = chartRootFor(path);
    if (chartRoot === null) continue;
    pushInto(chartFiles, chartRoot, path);
  }
  const gitMeta = useGit ? fileGitMetrics(root, rels, opts.churn === false ? 0 : 90) : null;
  let skipped = 0;

  for (const file of files) {
    const rel = file.path;
    const read = file.read();
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

    const chartRoot = languageFor(rel)?.id === "yaml" ? chartRootFor(rel) : null;
    // Explicit null check, not truthiness: a chart rooted at the repo root
    // itself resolves to "" (empty string), which is a valid chart scope but
    // JS-falsy — `if (chartRoot)` would silently skip every repo-root chart.
    if (chartRoot !== null) {
      const helm = extractHelmDirectives(src);
      // helm.ts's own offsets are named *Char (they're JS char indices, not
      // UTF-8 bytes -- see its module doc comment); mapped here into
      // parsed.symbols/calls's startByte/endByte/atByte fields, which carry
      // the same char-index values under the shared ParsedSymbol/ParsedCall
      // naming this merge target already uses.
      const helmSymbols = helm.symbols.map((s) => ({
        name: s.name, kind: s.kind, startByte: s.startChar, endByte: s.endChar, loc: s.loc, bodyText: s.bodyText,
      }));
      const helmCalls = helm.calls.map((c) => ({
        callee: c.callee, atByte: c.atChar, endByte: c.endChar, member: c.member,
      }));
      parsed.symbols = [...parsed.symbols, ...helmSymbols].sort((a, b) => a.startByte - b.startByte);
      parsed.calls = [...parsed.calls, ...helmCalls];
    }
    // Runs for EVERY yaml file, chart or not (unlike the Helm merge above) --
    // raw manifests with no Chart.yaml are still in scope; what varies below is
    // resolution SCOPE (chartRoot ?? this file), not whether extraction runs.
    let k8sDocs: K8sManifestDocument[] = [];
    // THIS file's K8s resource symbol OBJECTS (identity, not their byte
    // offsets) -- scopes the id lookup below to exactly the symbols this pass
    // creates. Identity, not a Set<number> of startBytes, because a byte
    // value is not a reliable per-symbol key: a Helm `define` symbol that
    // happens to share a startByte with a K8s doc symbol in the same .yaml
    // file (both legitimately synthetic, both can start at byte 0) would
    // otherwise be indistinguishable by offset alone, and the wrong (Helm)
    // symbol id could get recorded instead of the K8s one.
    const k8sSymbolObjects = new Set<object>();
    if (languageFor(rel)?.id === "yaml") {
      k8sDocs = extractK8sManifest(src);
      const k8sSymbols = k8sDocs
        .filter((d): d is K8sManifestDocument & { resource: NonNullable<K8sManifestDocument["resource"]> } => d.resource !== null)
        // k8sManifest.ts's own offsets are named *Char; mapped here into the
        // shared startByte/endByte fields, same as the Helm merge above.
        .map((d) => ({
          name: `${d.resource.kind}/${displayNameText(d.resource.name)}`,
          kind: "variable" as const,
          startByte: d.resource.startChar,
          endByte: d.resource.endChar,
          loc: src.slice(d.resource.startChar, d.resource.endChar).split("\n").length,
          bodyText: src.slice(d.resource.startChar, d.resource.endChar).slice(0, MAX_BODY_TEXT_CHARS),
        }));
      for (const s of k8sSymbols) k8sSymbolObjects.add(s);
      parsed.symbols = [...parsed.symbols, ...k8sSymbols].sort((a, b) => a.startByte - b.startByte);
    }

    const m = gitMeta?.get(rel);
    const churn = opts.churn === false ? (preservedChurn.get(rel) ?? 0) : (m?.churn ?? 0);
    const last = m?.lastCommit ?? "";

    const idsInFile: string[] = [];
    const symbolIndexId = new Map<number, string>();
    const idCounts = new Map<string, number>(); // disambiguate same (file,name,kind)
    const k8sSymbolIdByStartByte = new Map<number, string>();
    for (const [index, ps] of parsed.symbols.entries()) {
      const base = symbolId(rel, ps.name, ps.kind);
      const n = idCounts.get(base) ?? 0;
      idCounts.set(base, n + 1);
      // parse() returns symbols sorted by start byte, so the ordinal is stable
      const id = n === 0 ? base : `${base}_${n}`;
      idsInFile.push(id);
      symbolIndexId.set(index, id);
      pushInto(nameIndex, ps.name, id);
      symbols.push({
        id, file: rel, name: ps.name, kind: ps.kind,
        signature_hash: sha1(ps.bodyText).slice(0, 16),
        calls: [], called_by: [],
        metrics: { loc: ps.loc, churn_90d: churn, bug_count: 0, fan_in: 0, fan_out: 0 },
        last_changed: last,
      });
      if (k8sSymbolObjects.has(ps)) k8sSymbolIdByStartByte.set(ps.startByte, id);
    }
    for (const doc of k8sDocs) {
      if (!doc.resource) continue;
      const fromId = k8sSymbolIdByStartByte.get(doc.resource.startChar);
      if (!fromId) continue;
      const scope = chartRoot ?? rel;
      const namespace = doc.resource.namespace;
      k8sResourceIndex.push({ symbolId: fromId, scope, kind: doc.resource.kind, nameKey: nameKeyText(doc.resource.name), namespace });
      for (const ref of doc.references) {
        k8sReferenceCandidates.push({
          fromSymbolId: fromId, scope, refKind: ref.refKind, nameKey: nameKeyText(ref.name), namespace: ref.namespace,
          reason: `${doc.resource.kind}/${displayNameText(doc.resource.name)} references ${ref.refKind}/${displayNameText(ref.name)}`,
        });
      }
      if (doc.selector) k8sSelectors.push({ symbolId: fromId, scope, namespace, selector: doc.selector });
      if (doc.labels) k8sWorkloadLabels.push({ symbolId: fromId, scope, namespace, labels: doc.labels });
    }
    fileSymbols.set(rel, idsInFile);
    fileSymbolIndexId.set(rel, symbolIndexId);
    perFileCalls.push({ file: rel, bySym: attributeCalls(parsed) });
    perFileImports.push({ file: rel, imports: parsed.imports });
    perFileRelations.push({ file: rel, bySym: attributeRelations(parsed) });
    if (languageFor(rel)?.id === "php") {
      phpNamespaces.set(rel, parsed.namespace);
      phpUseDeclarations.set(rel, parsed.imports.filter((capture) => /^\s*use\b/i.test(capture)));
    }
  }

  const byId = new Map(symbols.map((s) => [s.id, s]));
  // Language-aware import resolution (resolveImportTarget), used by both the
  // call-resolution gate below (via importedFiles) and the depends_on edge
  // derivation in pass 3 directly: a Python cross-file call/import must
  // resolve through the same relative/absolute Python rules as everything
  // else, not silently fail the JS/TS resolver and look unimported.
  const hasSrcLayout = [...fileSymbols.keys()].some((f) => f.startsWith("src/"));
  const pyRoots = hasSrcLayout ? ["", "src"] : [""];
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
    return [resolveImport(file, spec, fileSymbols)].filter((target): target is string => !!target);
  };
  const importedFiles = new Map(perFileImports.map(({ file, imports }) => {
    const targets = new Set(imports.flatMap((specifier) => resolveImportTargets(file, specifier)));
    const chartRoot = languageFor(file)?.id === "yaml" ? chartRootFor(file) : null;
    // Explicit null check, not truthiness — see the matching comment above on
    // the per-file Helm merge step: a repo-root chart's scope is "", not null.
    if (chartRoot !== null) for (const sibling of chartFiles.get(chartRoot) ?? []) if (sibling !== file) targets.add(sibling);
    return [file, targets] as const;
  }));

  // ---- pass 2: resolve calls -> symbol-level edges -------------------------
  const edges: Edge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (e: Edge) => {
    if (edgeSeen.has(e.id)) return;
    edgeSeen.add(e.id);
    edges.push(e);
  };

  for (const { file, bySym } of perFileCalls) {
    // Most languages leave this unset and get "calls" — YAML's alias->anchor
    // references aren't function calls, so its LanguageSpec declares "references".
    const edgeType = languageFor(file)?.referenceEdgeType ?? "calls";
    const indexToId = fileSymbolIndexId.get(file) ?? new Map<number, string>();
    for (const [callerIndex, callees] of bySym) {
      // resolve caller by its stable position in parsed.symbols (not startByte —
      // startByte is not unique across symbols; see attributeCalls's doc comment)
      const callerId = indexToId.get(callerIndex);
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
          id: edgeId(callerId, calleeId, edgeType),
          from: callerId, to: calleeId, type: edgeType,
          reason: `${callerName} ${edgeType} ${calleeName}`, strength: 0.8,
          provenance: extracted(0.8, [file]),
          environment: null,
          metadata: {},
        });
      }
    }
  }

  // ---- K8s manifest cross-resource references (Phase 1: name-keyed) --------
  // Own resolver, not resolveName(): resolveName() indexes by bare symbol name
  // only, with no concept of Kubernetes kind -- a ConfigMap and a Secret that
  // happen to share a name would incorrectly conflate. Same ambiguity contract
  // as resolveName() though: 0 matches or 2+ matches -> no edge, never guess.
  //
  // Namespace is a FILTER applied to the candidate list, not part of the key
  // (issue #297): an unknown namespace on either side must still match, which
  // a key can't express. Filtering before the uniqueness check -- rather than
  // after picking a single candidate -- is what makes "ref in a, candidates in
  // a and b" resolve to a instead of declining as ambiguous, while "ref in a,
  // candidates in a and unknown" correctly stays ambiguous.
  const kindNameIndex = new Map<string, typeof k8sResourceIndex>();
  for (const r of k8sResourceIndex) {
    const key = `${r.scope}:${r.kind}:${r.nameKey}`;
    pushInto(kindNameIndex, key, r);
  }
  for (const ref of k8sReferenceCandidates) {
    const byName = kindNameIndex.get(`${ref.scope}:${ref.refKind}:${ref.nameKey}`) ?? [];
    const candidates = byName.filter((c) => namespacesCompatible(ref.namespace, c.namespace));
    if (candidates.length !== 1) continue; // 0 or 2+ -> ambiguous or absent, don't guess
    const toId = candidates[0]!.symbolId;
    if (toId === ref.fromSymbolId) continue;
    addEdge({
      schema: "hunch.edge/1",
      id: edgeId(ref.fromSymbolId, toId, "references"),
      from: ref.fromSymbolId, to: toId, type: "references",
      reason: ref.reason, strength: 0.7,
      provenance: extracted(0.7, [ref.scope]),
      environment: null,
      metadata: {},
    });
  }

  // ---- K8s manifest cross-resource references (Phase 2: label-selector) ----
  // Structurally different from Phase 1: no name to look up, a SUBSET match
  // between a Service's selector and a workload's pod-template labels, within
  // the same scope. Only ever fires on LITERAL selector/labels (k8sSelectors/
  // k8sWorkloadLabels are already filtered to literal-only by k8sManifest.ts --
  // a block-form templated value is never guessed at).
  //
  // Deliberately NO ambiguity guard here, unlike Phase 1's "0 or 2+ candidates
  // -> no edge": a Service legitimately fronting multiple workloads (blue/green,
  // canary, a shared-label pair of Deployments) is normal, intentional
  // Kubernetes usage, not an ambiguous match to decline -- Phase 1's guard
  // exists because a ConfigMap named X is exactly one resource by definition,
  // which has no analogue here. Fan-out is the correct behavior, not a gap.
  const selectorsByScope = new Map<string, typeof k8sSelectors>();
  for (const s of k8sSelectors) pushInto(selectorsByScope, s.scope, s);
  const labelsByScope = new Map<string, typeof k8sWorkloadLabels>();
  for (const l of k8sWorkloadLabels) pushInto(labelsByScope, l.scope, l);

  for (const [scope, selectors] of selectorsByScope) {
    const workloads = labelsByScope.get(scope) ?? [];
    for (const svc of selectors) {
      for (const wl of workloads) {
        // Defensive, not currently reachable: k8sSelectors only ever holds
        // Service symbols and k8sWorkloadLabels only ever holds symbols for
        // kinds in LABELS_PATH_BY_KIND, which excludes Service -- so the two
        // ids can never collide today.
        if (svc.symbolId === wl.symbolId) continue;
        // A Service only ever selects pods in its OWN namespace -- a
        // label-identical workload next door is a different workload (issue
        // #297). Unknown on either side still matches, same rule as Phase 1.
        if (!namespacesCompatible(svc.namespace, wl.namespace)) continue;
        const isSubset = Object.entries(svc.selector).every(([k, v]) => wl.labels[k] === v);
        if (!isSubset) continue;
        addEdge({
          schema: "hunch.edge/1",
          id: edgeId(svc.symbolId, wl.symbolId, "references"),
          from: svc.symbolId, to: wl.symbolId, type: "references",
          reason: "Service selector matches workload pod-template labels", strength: 0.6,
          provenance: extracted(0.6, [scope]),
          environment: null,
          metadata: {},
        });
      }
    }
  }

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

  // fan-in / fan-out from resolved call/reference edges
  const CALL_LIKE_EDGE_TYPES = new Set<Edge["type"]>(["calls", "references"]);
  for (const e of edges) {
    if (!CALL_LIKE_EDGE_TYPES.has(e.type)) continue;
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

/** Append `value` to the array at `key`, creating the array on first use.
 *  Function declaration (not `const`) so it's usable from pass-1 code above
 *  this section via hoisting, without reordering. */
function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/** Nearest-ancestor Chart.yaml lookup, memoized per directory: walks a file's
 *  own directory upward through the tracked-file set until it finds
 *  `<dir>/Chart.yaml`, or returns null if the file isn't under any chart.
 *  Nested subcharts (their own Chart.yaml under charts/<name>/) resolve to
 *  their OWN chart root, not the parent's. This is a conservative
 *  approximation, not full Helm semantics: Helm's template namespace is
 *  actually release-global, so a parent chart can legitimately include a
 *  subchart's define — nearest-ancestor scoping will miss that edge rather
 *  than fabricate a wrong one (test coverage: indexer.test.ts's nested-subchart
 *  and subchart-miss cases). Modeling the release-global namespace itself
 *  remains open — issue #42. */
function nearestChartRoot(rels: string[]): (file: string) => string | null {
  const tracked = new Set(rels);
  const cache = new Map<string, string | null>();
  const resolveDir = (dir: string): string | null => {
    if (cache.has(dir)) return cache.get(dir)!;
    const chartYaml = dir ? `${dir}/Chart.yaml` : "Chart.yaml";
    const result: string | null = tracked.has(chartYaml)
      ? dir
      : dir === "" ? null : resolveDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
    cache.set(dir, result);
    return result;
  };
  return (file: string): string | null => resolveDir(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
}

/** Human-readable text for a name/kind field -- a literal value as-is, or a
 *  template's exact raw `{{ }}` source text (never evaluated). Used for
 *  display (symbol names, edge reasons); NOT for resolution-key equality --
 *  see nameKeyText below for that. */
function displayNameText(ref: ManifestNameRef): string {
  return ref.form === "literal" ? ref.value : ref.sourceText;
}

/** Normalized resolution-key text for a name/kind field: a literal value or a
 *  template's exact raw source text, EACH PREFIXED so a literal "foo" can
 *  never collide with a template whose source text happens to read "foo". */
function nameKeyText(ref: ManifestNameRef): string {
  return ref.form === "literal" ? `L:${ref.value}` : `T:${ref.sourceText}`;
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
    // root-level files (dir === ".") have no directory to glob under — list them
    // exactly rather than emitting "./**", which normalizes to a match-everything
    // glob (issue #34). A single "*" glob was rejected too: it matches root files
    // correctly under pathMatchesGlob, but globPrefix("*") is "" and owns() skips
    // empty prefixes, so the wiki would again own nothing for this component —
    // the exact failure mode this fix closes. Don't "simplify" this back to a
    // glob without re-checking both matchers agree. As a consequence, this
    // component only covers root files present (and symbol-bearing) at the last
    // index — unlike directory components, a new root file isn't owned until reindex.
    const paths = dir === "." ? [...fileSet].sort() : [dir.endsWith("/") ? dir + "**" : dir + "/**"];
    out.push({
      id: componentId(dir),
      kind: "module",
      name: capitalize(name),
      responsibility: "",
      paths,
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
