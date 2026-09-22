import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import type { HunchStore } from "../store/hunchStore.js";
import { scanRepo, type RepoScan } from "../extractors/indexer.js";
import { foreignRepoEnv, gitNullDevice } from "../extractors/git.js";
import { deriveChangeIdentity } from "./changeIdentity.js";
import { checkConformance } from "./conformance.js";
import { compareCodeUnits } from "./canonicalOrder.js";
import { pathMatchesGlob, pathsRelated } from "./glob.js";
import { discoverProjectDna } from "./projectDna.js";
import { isInForce } from "./topics.js";
import type { Constraint, Decision } from "./types.js";
import { HUNCH_VERSION } from "./version.js";
import {
  CHANGE_PROOF_ALGORITHM,
  CHANGE_PROOF_SCHEMA_VERSION,
  canonicalChangeProofJson,
  changeProofHash,
  sealChangeProof,
  type ChangeProof,
  type ChangeProofUnsigned,
} from "./changeProofContract.js";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 2_048;
const MAX_BLAST_RADIUS = 4_096;
const MAX_INTERNAL_BLAST_RADIUS = 20_000;
const MAX_RECORDS = 1_024;
const MAX_RECORD_PATHS = 128;
const MAX_CONFORMANCE = 1_024;
const MAX_GAPS = 64;
const TRAVERSABLE = new Set(["calls", "depends_on", "imports", "contains", "implements"]);

type GapEvidence = { code: string; values: unknown[] };
type BlastGraph = "base" | "result";
type BlastEntry = ChangeProof["blast_radius"][number];

export interface DeriveChangeProofOptions {
  /** Exclude a configured private overlay from the artifact. Required before publication. */
  publicOnly?: boolean;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...foreignRepoEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullDevice(),
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
    LANG: "C",
  };
}

function gitBytes(root: string, args: string[]): Buffer {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "buffer",
      env: gitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString("utf8").trim().replace(/[\r\n]+/g, " ");
    throw new Error(`could not derive native change proof${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }
}

function gitText(root: string, args: string[]): string {
  return gitBytes(root, args).toString("utf8").trim();
}

function canonicalPath(path: string): boolean {
  if (!path || path.length > 4_096 || path.includes("\0") || path.includes("\\")
    || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function exactChangedPaths(
  root: string,
  baseRevision: string,
  resultRevision: string,
): { paths: string[]; gaps: GapEvidence[] } {
  const raw = gitBytes(root, [
    "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
    baseRevision, resultRevision, "--",
  ]);
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== 0) continue;
    parts.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (!raw.length || raw[raw.length - 1] !== 0 || start !== raw.length || parts.some((part) => part.length < 1)) {
    throw new Error("native change proof received an invalid exact Git path inventory");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  const invalid: Array<{ index: number; path_hash: string }> = [];
  for (const [index, part] of parts.entries()) {
    try {
      const path = decoder.decode(part);
      if (!canonicalPath(path)) throw new Error("unsafe path");
      paths.push(path);
    } catch {
      invalid.push({ index, path_hash: changeProofHash(part.toString("base64")) });
    }
  }
  const sorted = [...new Set(paths)].sort(compareCodeUnits);
  if (sorted.length !== paths.length) throw new Error("native change proof received duplicate Git paths");
  return {
    paths: sorted,
    gaps: invalid.length ? [{ code: "changed_path_unrepresentable", values: invalid }] : [],
  };
}

function exactDiff(
  root: string,
  baseRevision: string,
  resultRevision: string,
): { diff: string; gaps: GapEvidence[] } {
  const raw = gitBytes(root, [
    "-c", "core.quotePath=false",
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=2", "--src-prefix=a/", "--dst-prefix=b/",
    baseRevision, resultRevision, "--",
  ]);
  if (raw.byteLength <= MAX_DIFF_BYTES) return { diff: raw.toString("utf8"), gaps: [] };
  return {
    diff: raw.subarray(0, MAX_DIFF_BYTES).toString("utf8"),
    gaps: [{
      code: "guard_diff_truncated",
      values: [{ byte_count: raw.byteLength, content_hash: changeProofHash(raw) }],
    }],
  };
}

function topologyHash(scan: RepoScan): string {
  return changeProofHash({
    symbols: scan.symbols
      .map((symbol) => ({
        id: symbol.id,
        file: symbol.file,
        name: symbol.name,
        kind: symbol.kind,
        signature_hash: symbol.signature_hash,
      }))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
    edges: scan.edges
      .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, type: edge.type }))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
    components: scan.components
      .map((component) => ({ id: component.id, paths: [...component.paths].sort(compareCodeUnits) }))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
  });
}

function graphSeal(scan: RepoScan): ChangeProof["graph"]["base"] {
  if (scan.source.kind !== "commit" || !scan.source.revision) {
    throw new Error("native change proof requires an exact committed semantic graph");
  }
  return {
    source: "commit",
    revision: scan.source.revision,
    source_hash: scan.source.content_hash,
    topology_hash: topologyHash(scan),
    files: scan.result.files,
    symbols: scan.result.symbols,
    edges: scan.result.edges,
    components: scan.result.components,
    issue_count: scan.issues.length,
  };
}

function graphBlast(scan: RepoScan, changedPaths: string[], graph: BlastGraph): Array<BlastEntry & { graph: BlastGraph }> {
  const symbolById = new Map(scan.symbols.map((symbol) => [symbol.id, symbol] as const));
  const symbolsByFile = new Map<string, string[]>();
  for (const symbol of scan.symbols) {
    const ids = symbolsByFile.get(symbol.file) ?? [];
    ids.push(symbol.id);
    symbolsByFile.set(symbol.file, ids);
  }
  const incoming = new Map<string, string[]>();
  for (const edge of scan.edges) {
    if (!TRAVERSABLE.has(edge.type)) continue;
    const ids = incoming.get(edge.to) ?? [];
    ids.push(edge.from);
    incoming.set(edge.to, ids);
  }
  for (const ids of incoming.values()) ids.sort(compareCodeUnits);

  const out = new Map<string, BlastEntry & { graph: BlastGraph }>();
  for (const sourcePath of changedPaths) {
    const starts = [...(symbolsByFile.get(sourcePath) ?? [])].sort(compareCodeUnits);
    const seen = new Map<string, number>(starts.map((id) => [id, 0]));
    const queue = starts.map((id) => ({ id, depth: 0 }));
    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= 4) continue;
      for (const dependentId of incoming.get(current.id) ?? []) {
        const depth = current.depth + 1;
        const previous = seen.get(dependentId);
        if (previous === undefined || depth < previous) {
          seen.set(dependentId, depth);
          queue.push({ id: dependentId, depth });
        }
        const dependent = symbolById.get(dependentId);
        if (!dependent || dependent.file === sourcePath) continue;
        const key = `${sourcePath}\0${dependent.file}`;
        const existing = out.get(key);
        if (!existing || depth < existing.depth) {
          out.set(key, {
            source_path: sourcePath,
            dependent_path: dependent.file,
            depth,
            graphs: [graph],
            graph,
          });
        }
      }
    }
  }
  return [...out.values()];
}

function mergeBlast(base: Array<BlastEntry & { graph: BlastGraph }>, result: Array<BlastEntry & { graph: BlastGraph }>): BlastEntry[] {
  const merged = new Map<string, BlastEntry>();
  for (const entry of [...base, ...result]) {
    const key = `${entry.source_path}\0${entry.dependent_path}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, {
        source_path: entry.source_path,
        dependent_path: entry.dependent_path,
        depth: entry.depth,
        graphs: [entry.graph],
      });
      continue;
    }
    current.depth = Math.min(current.depth, entry.depth);
    current.graphs = [...new Set([...current.graphs, entry.graph])].sort(compareCodeUnits) as BlastGraph[];
  }
  return sortCanonical([...merged.values()]);
}

function scopeMatches(path: string, scope: string): boolean {
  return pathMatchesGlob(path, scope) || pathMatchesGlob(scope, path) || pathsRelated(path, scope);
}

function decisionMatchesPath(decision: Decision, path: string, scans: RepoScan[]): boolean {
  if (decision.related_files.some((related) => scopeMatches(path, related))) return true;
  for (const componentId of decision.related_components) {
    for (const scan of scans) {
      const component = scan.components.find((candidate) => candidate.id === componentId);
      if (component?.paths.some((scope) => scopeMatches(path, scope))) return true;
    }
  }
  return false;
}

function constraintMatchesPath(constraint: Constraint, path: string): boolean {
  return constraint.scope.some((scope) => scopeMatches(path, scope));
}

function lastChangeAt(root: string, revision: string, path: string): string {
  return gitText(root, ["log", "-1", "--format=%aI", revision, "--", path]);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sortCanonical<T>(values: T[]): T[] {
  return values.sort((left, right) => compareCodeUnits(
    canonicalChangeProofJson(left),
    canonicalChangeProofJson(right),
  ));
}

function addGap(target: GapEvidence[], code: string, values: unknown[]): void {
  if (!values.length) return;
  target.push({ code, values });
}

function sealedGaps(gaps: GapEvidence[]): ChangeProof["unknowns"] {
  const merged = new Map<string, unknown[]>();
  for (const gap of gaps) {
    const values = merged.get(gap.code) ?? [];
    values.push(...gap.values);
    merged.set(gap.code, values);
  }
  if (merged.size > MAX_GAPS) throw new Error("native change proof exceeded the bounded gap taxonomy");
  return sortCanonical([...merged].map(([code, values]) => {
    const evidence = sortCanonical(values);
    return { code, count: evidence.length, evidence_hash: changeProofHash(evidence) };
  }));
}

/**
 * Produce Hunch's standalone semantic proof for one exact committed tree transition.
 *
 * The proof is read-only and timestamp-free. It binds source bytes, parsed graph,
 * current memory records and every explicit gap; it never grants execution, CI,
 * deployment, merge, ranking, promotion or policy authority.
 */
export function deriveChangeProof(
  root: string,
  store: HunchStore,
  baseRef: string,
  resultRef = "HEAD",
  options: DeriveChangeProofOptions = {},
): ChangeProof {
  const change = deriveChangeIdentity(root, baseRef, resultRef);
  const changed = exactChangedPaths(root, change.base_revision, change.head_revision);
  if (changed.paths.length + changed.gaps.reduce((sum, gap) => sum + gap.values.length, 0) !== change.file_count) {
    throw new Error("native change proof path inventory does not match exact change identity");
  }
  const diff = exactDiff(root, change.base_revision, change.head_revision);
  const baseScan = scanRepo(store, root, { churn: false, source: { kind: "commit", ref: change.base_revision } });
  const resultScan = scanRepo(store, root, { churn: false, source: { kind: "commit", ref: change.head_revision } });
  const dna = discoverProjectDna(root, change.head_revision);
  const unknownEvidence: GapEvidence[] = [...changed.gaps, ...diff.gaps];
  for (const [label, scan] of [["base", baseScan], ["result", resultScan]] as const) {
    const byCode = new Map<string, unknown[]>();
    for (const issue of scan.issues) {
      const values = byCode.get(issue.code) ?? [];
      values.push({ path: issue.path, detail_hash: changeProofHash(issue.detail) });
      byCode.set(issue.code, values);
    }
    for (const [code, values] of byCode) addGap(unknownEvidence, `${label}_graph_${code}`, values);
  }

  const blastSources = changed.paths.slice(0, MAX_CHANGED_FILES);
  const rawBlast = mergeBlast(
    graphBlast(baseScan, blastSources, "base"),
    graphBlast(resultScan, blastSources, "result"),
  );
  const omissions: GapEvidence[] = [];
  if (changed.paths.length > MAX_CHANGED_FILES) {
    addGap(omissions, "changed_files_omitted", changed.paths.slice(MAX_CHANGED_FILES));
  }
  if (rawBlast.length > MAX_INTERNAL_BLAST_RADIUS) {
    addGap(unknownEvidence, "blast_radius_internal_cap", [{ observed: rawBlast.length, cap: MAX_INTERNAL_BLAST_RADIUS }]);
  }
  const boundedRawBlast = rawBlast.slice(0, MAX_INTERNAL_BLAST_RADIUS);
  if (boundedRawBlast.length > MAX_BLAST_RADIUS) {
    addGap(omissions, "blast_radius_omitted", boundedRawBlast.slice(MAX_BLAST_RADIUS));
  }
  const blast = boundedRawBlast.slice(0, MAX_BLAST_RADIUS);
  const dependentPaths = sortedUnique(boundedRawBlast.map((entry) => entry.dependent_path));

  const publicOnly = !!options.publicOnly;
  const decisions = (publicOnly ? store.json.loadAll("decisions") : store.recs("decisions"));
  const constraints = (publicOnly ? store.json.loadAll("constraints") : store.recs("constraints"));
  const guardReport = store.buildCheckReport(changed.paths, diff.diff, {
    strict: true,
    publicOnly,
    // A diff cut at MAX_DIFF_BYTES is a prefix: content-matched blocking rules over the
    // files it omits fail closed rather than read as compliant (dec_20db57c576).
    diffStatus: diff.gaps.length ? { incomplete: `the guard diff exceeded ${MAX_DIFF_BYTES} bytes and was cut`, truncated: true } : undefined,
    lastChange: (path) => lastChangeAt(root, change.head_revision, path),
  });
  const allStrictBlockerIds = sortedUnique([
    ...guardReport.direct.filter((item) => item.strictBlocks).map((item) => item.id),
    ...guardReport.regressions.filter((item) => item.blocking).map((item) => item.decision),
    ...guardReport.vetoes.filter((item) => item.blocking).map((item) => item.decision),
  ]);
  const allRegressionDecisionIds = sortedUnique(guardReport.regressions.map((item) => item.decision));
  const allVetoDecisionIds = sortedUnique(guardReport.vetoes.map((item) => item.decision));
  if (allStrictBlockerIds.length > 2_048) {
    addGap(omissions, "guard_blockers_omitted", allStrictBlockerIds.slice(2_048));
  }
  if (allRegressionDecisionIds.length > 1_024) {
    addGap(omissions, "guard_regressions_omitted", allRegressionDecisionIds.slice(1_024));
  }
  if (allVetoDecisionIds.length > 1_024) {
    addGap(omissions, "guard_vetoes_omitted", allVetoDecisionIds.slice(1_024));
  }
  const strictBlockerIds = allStrictBlockerIds.slice(0, 2_048);
  const regressionDecisionIds = allRegressionDecisionIds.slice(0, 1_024);
  const vetoDecisionIds = allVetoDecisionIds.slice(0, 1_024);
  const guardDecisionIds = new Set([
    ...allRegressionDecisionIds,
    ...allVetoDecisionIds,
    ...guardReport.direct.flatMap((item) => item.why?.decision?.id ? [item.why.decision.id] : []),
  ]);
  const stableGuardReport = {
    direct: guardReport.direct.map((item) => ({
      id: item.id,
      files: [...item.files].sort(compareCodeUnits),
      strict_blocks: item.strictBlocks,
      downgrade: item.downgrade ?? null,
      source_decision: item.why?.decision?.id ?? null,
    })),
    regressions: guardReport.regressions.map((item) => ({
      decision: item.decision,
      kind: item.kind,
      name: item.name,
      blocking: item.blocking,
    })),
    vetoes: guardReport.vetoes.map((item) => ({
      decision: item.decision,
      tier: item.tier,
      blocking: item.blocking,
      evidence_hash: changeProofHash(item.evidence),
    })),
  };
  sortCanonical(stableGuardReport.direct);
  sortCanonical(stableGuardReport.regressions);
  sortCanonical(stableGuardReport.vetoes);

  const conformanceResults = checkConformance(store, {
    publicOnly,
    graph: { symbols: resultScan.symbols, edges: resultScan.edges },
  });
  const conformancePredicates = decisions
    .filter(isInForce)
    .flatMap((decision) => (decision.conformance ?? []).map((predicate, predicateIndex) => ({
      decision,
      predicate,
      predicateIndex,
    })));
  if (conformancePredicates.length !== conformanceResults.length) {
    throw new Error("native change proof conformance inventory is inconsistent");
  }
  const allConformance = conformanceResults.map((result, index) => ({
    decision_id: result.decision,
    predicate_index: conformancePredicates[index]!.predicateIndex,
    predicate_hash: changeProofHash(conformancePredicates[index]!.predicate),
    satisfied: result.satisfied,
    detail_hash: changeProofHash(result.detail),
  }));
  sortCanonical(allConformance);
  let conformance = allConformance;
  if (allConformance.length > MAX_CONFORMANCE) {
    const failures = allConformance.filter((receipt) => !receipt.satisfied);
    const passes = allConformance.filter((receipt) => receipt.satisfied);
    conformance = sortCanonical([
      ...failures.slice(0, MAX_CONFORMANCE),
      ...passes.slice(0, Math.max(0, MAX_CONFORMANCE - failures.length)),
    ]);
    const retained = new Set(conformance.map(canonicalChangeProofJson));
    addGap(
      omissions,
      "conformance_receipts_omitted",
      allConformance.filter((receipt) => !retained.has(canonicalChangeProofJson(receipt))),
    );
  }

  const conformanceDecisionIds = new Set(conformancePredicates.map(({ decision }) => decision.id));
  const allDecisionRefs = decisions.filter(isInForce).flatMap((decision) => {
    const changedPaths = changed.paths.filter((path) => decisionMatchesPath(decision, path, [baseScan, resultScan]));
    const blastPaths = dependentPaths.filter((path) => decisionMatchesPath(decision, path, [baseScan, resultScan]));
    const relevance = sortedUnique([
      ...(blastPaths.length ? ["blast_radius"] : []),
      ...(changedPaths.length ? ["changed_path"] : []),
      ...(conformanceDecisionIds.has(decision.id) ? ["conformance"] : []),
      ...(guardDecisionIds.has(decision.id) ? ["guard"] : []),
    ]) as ChangeProof["decisions"][number]["relevance"];
    if (!relevance.length) return [];
    const paths = sortedUnique([...changedPaths, ...blastPaths]);
    if (paths.length > MAX_RECORD_PATHS) addGap(omissions, "decision_paths_omitted", paths.slice(MAX_RECORD_PATHS));
    return [{
      id: decision.id,
      record_hash: changeProofHash(decision),
      relevance,
      paths: paths.slice(0, MAX_RECORD_PATHS),
      path_count: paths.length,
      paths_hash: changeProofHash(paths),
    }];
  });
  sortCanonical(allDecisionRefs);
  if (allDecisionRefs.length > MAX_RECORDS) addGap(omissions, "decision_refs_omitted", allDecisionRefs.slice(MAX_RECORDS));
  const decisionRefs = allDecisionRefs.slice(0, MAX_RECORDS);

  const allConstraintRefs = constraints.filter((constraint) => constraint.status !== "retired").flatMap((constraint) => {
    const changedPaths = changed.paths.filter((path) => constraintMatchesPath(constraint, path));
    const blastPaths = dependentPaths.filter((path) => constraintMatchesPath(constraint, path));
    const relevance = sortedUnique([
      ...(blastPaths.length ? ["blast_radius"] : []),
      ...(changedPaths.length ? ["changed_path"] : []),
    ]) as ChangeProof["constraints"][number]["relevance"];
    if (!relevance.length) return [];
    const paths = sortedUnique([...changedPaths, ...blastPaths]);
    if (paths.length > MAX_RECORD_PATHS) addGap(omissions, "constraint_paths_omitted", paths.slice(MAX_RECORD_PATHS));
    return [{
      id: constraint.id,
      record_hash: changeProofHash(constraint),
      severity: constraint.severity,
      relevance,
      paths: paths.slice(0, MAX_RECORD_PATHS),
      path_count: paths.length,
      paths_hash: changeProofHash(paths),
    }];
  });
  sortCanonical(allConstraintRefs);
  if (allConstraintRefs.length > MAX_RECORDS) addGap(omissions, "constraint_refs_omitted", allConstraintRefs.slice(MAX_RECORDS));
  const constraintRefs = allConstraintRefs.slice(0, MAX_RECORDS);

  const omissionReceipts = sealedGaps(omissions);
  const unknownReceipts = sealedGaps(unknownEvidence);
  const guard = {
    verdict: strictBlockerIds.length ? "fail" as const : "pass" as const,
    strict_blocker_ids: strictBlockerIds,
    regression_decision_ids: regressionDecisionIds,
    veto_decision_ids: vetoDecisionIds,
    report_hash: changeProofHash(stableGuardReport),
  };
  const verdict = guard.verdict === "fail" || allConformance.some((receipt) => !receipt.satisfied)
    ? "fail" as const
    : omissionReceipts.length || unknownReceipts.length
      ? "unknown" as const
      : "pass" as const;
  const unsigned: ChangeProofUnsigned = {
    schema: CHANGE_PROOF_SCHEMA_VERSION,
    algorithm: CHANGE_PROOF_ALGORITHM,
    engine: { package: "@davesheffer/hunch", version: HUNCH_VERSION },
    repository: {
      repository_id: dna.repository_id,
      base_revision: change.base_revision,
      result_revision: change.head_revision,
    },
    change,
    project_dna: {
      schema: dna.schema,
      profile_id: dna.profile_id,
      repository_id: dna.repository_id,
      repository_revision: dna.repository_revision,
      content_hash: dna.content_hash,
      trait_ids: dna.traits.map((trait) => trait.id).sort(compareCodeUnits),
    },
    graph: { base: graphSeal(baseScan), result: graphSeal(resultScan) },
    changed_files: changed.paths.slice(0, MAX_CHANGED_FILES),
    changed_file_count: change.file_count,
    blast_radius: blast,
    blast_radius_count: rawBlast.length,
    decisions: decisionRefs,
    decision_count: allDecisionRefs.length,
    constraints: constraintRefs,
    constraint_count: allConstraintRefs.length,
    conformance,
    conformance_count: allConformance.length,
    guard,
    memory: {
      scope: publicOnly ? "public" : "union",
      records_hash: changeProofHash({ decisions: decisionRefs, constraints: constraintRefs }),
    },
    omissions: omissionReceipts,
    unknowns: unknownReceipts,
    verdict,
    authority: {
      execution: false,
      ci: false,
      deployment: false,
      merge: false,
      ranking: false,
      promotion: false,
      policy: false,
    },
  };
  return sealChangeProof(unsigned);
}
