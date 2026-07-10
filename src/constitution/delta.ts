import { shortHash } from "../core/ids.js";
import { commitChanges, fileAtRef, firstParent, revParse } from "../extractors/git.js";
import { attributeCalls, parseSource, type ParsedFile, type ParsedSymbol } from "../extractors/parse.js";
import { canonicalHash } from "./canonical.js";
import {
  StructuralDeltaSchema,
  type StructuralCallRef,
  type StructuralDelta,
  type StructuralImportRef,
  type StructuralSymbolRef,
} from "./schema.js";

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_SEGMENTS = new Set(["node_modules", ".git", ".hunch", "dist", "build", "coverage", ".next", "out", "vendor"]);
const MAX_CODE_FILES = 64;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_FACTS = 128;

function eligibleCode(file: string | null): file is string {
  return !!file
    && CODE_EXT.test(file)
    && !file.includes(".generated.")
    && !file.split(/[\\/]/).some((segment) => SKIP_SEGMENTS.has(segment));
}

interface FileView {
  symbols: Map<string, ParsedSymbol>;
  calls: Map<string, { caller: string; callee: string; member: boolean }>;
  imports: Set<string>;
}

const symbolKey = (s: Pick<ParsedSymbol, "name" | "kind">): string => `${s.kind}\0${s.name}`;
const callKey = (c: { caller: string; callee: string; member: boolean }): string => `${c.caller}\0${c.callee}\0${c.member ? "1" : "0"}`;

function view(file: string, source: string | null): FileView | null {
  if (source == null || !eligibleCode(file)) return null;
  const parsed = parseSource(file, source);
  if (!parsed) return null;
  return viewOfParsed(parsed);
}

function viewOfParsed(parsed: ParsedFile): FileView {
  const symbols = new Map(parsed.symbols.map((s) => [symbolKey(s), s]));
  const byStart = new Map(parsed.symbols.map((s) => [s.startByte, s]));
  const calls = new Map<string, { caller: string; callee: string; member: boolean }>();
  for (const [start, callees] of attributeCalls(parsed)) {
    const caller = byStart.get(start);
    if (!caller) continue;
    for (const [callee, member] of callees) {
      const call = { caller: caller.name, callee, member };
      calls.set(callKey(call), call);
    }
  }
  return { symbols, calls, imports: new Set(parsed.imports) };
}

function symbolRef(file: string, symbol: ParsedSymbol): StructuralSymbolRef {
  return { file, name: symbol.name, kind: symbol.kind };
}

function callRef(file: string, call: { caller: string; callee: string; member: boolean }): StructuralCallRef {
  return { file, ...call };
}

function importRef(file: string, specifier: string): StructuralImportRef {
  return { file, specifier };
}

function sortByKey<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => key(a).localeCompare(key(b)));
}

/** Compare exact git blobs at a commit and its first parent. No checkout,
 * worktree, hook, or model/provider is involved. */
export function extractStructuralDelta(root: string, commit: string): StructuralDelta {
  const after = revParse(commit, root);
  const before = firstParent(after, root);
  if (!before) throw new Error(`commit ${commit} has no first parent; an initial snapshot cannot prove a fixing structural delta`);

  const addedSymbols: StructuralSymbolRef[] = [];
  const removedSymbols: StructuralSymbolRef[] = [];
  const movedSymbols: StructuralDelta["symbols"]["moved"] = [];
  const addedCalls: StructuralCallRef[] = [];
  const removedCalls: StructuralCallRef[] = [];
  const addedImports: StructuralImportRef[] = [];
  const removedImports: StructuralImportRef[] = [];
  const files = new Set<string>();
  let codeFiles = 0;
  let sourceBytes = 0;

  for (const change of commitChanges(after, root)) {
    const beforeFile = change.before;
    const afterFile = change.after;
    if (beforeFile) files.add(beforeFile);
    if (afterFile) files.add(afterFile);
    if (!eligibleCode(beforeFile) && !eligibleCode(afterFile)) continue;
    if (++codeFiles > MAX_CODE_FILES) throw new Error(`structural delta exceeds ${MAX_CODE_FILES} changed code files; narrow or split the evidence commit`);
    const beforeSource = change.status === "copied" || !eligibleCode(beforeFile) ? null : fileAtRef(before, beforeFile, root);
    const afterSource = !eligibleCode(afterFile) ? null : fileAtRef(after, afterFile, root);
    sourceBytes += Buffer.byteLength(beforeSource ?? "") + Buffer.byteLength(afterSource ?? "");
    if (sourceBytes > MAX_SOURCE_BYTES) throw new Error(`structural delta exceeds ${MAX_SOURCE_BYTES} source bytes; narrow or split the evidence commit`);
    const beforeView = beforeFile ? view(beforeFile, beforeSource) : null;
    const afterView = afterFile ? view(afterFile, afterSource) : null;
    if (!beforeView && !afterView) continue;

    const beforeSymbols = beforeView?.symbols ?? new Map<string, ParsedSymbol>();
    const afterSymbols = afterView?.symbols ?? new Map<string, ParsedSymbol>();
    for (const [key, symbol] of afterSymbols) {
      if (!beforeSymbols.has(key)) addedSymbols.push(symbolRef(afterFile!, symbol));
      else if (change.status === "renamed" && beforeFile !== afterFile) {
        movedSymbols.push({ from: beforeFile!, to: afterFile!, name: symbol.name, kind: symbol.kind });
      }
    }
    for (const [key, symbol] of beforeSymbols) {
      if (!afterSymbols.has(key)) removedSymbols.push(symbolRef(beforeFile!, symbol));
    }

    const beforeCalls = beforeView?.calls ?? new Map<string, { caller: string; callee: string; member: boolean }>();
    const afterCalls = afterView?.calls ?? new Map<string, { caller: string; callee: string; member: boolean }>();
    for (const [key, call] of afterCalls) {
      if (!beforeCalls.has(key)) addedCalls.push(callRef(afterFile!, call));
    }
    for (const [key, call] of beforeCalls) {
      if (!afterCalls.has(key)) removedCalls.push(callRef(afterFile ?? beforeFile!, call));
    }

    const beforeImports = beforeView?.imports ?? new Set<string>();
    const afterImports = afterView?.imports ?? new Set<string>();
    for (const specifier of afterImports) {
      if (!beforeImports.has(specifier)) addedImports.push(importRef(afterFile!, specifier));
    }
    for (const specifier of beforeImports) {
      if (!afterImports.has(specifier)) removedImports.push(importRef(afterFile ?? beforeFile!, specifier));
    }
  }

  const factCount = addedSymbols.length + removedSymbols.length + movedSymbols.length
    + addedCalls.length + removedCalls.length + addedImports.length + removedImports.length;
  if (factCount > MAX_FACTS) throw new Error(`structural delta exceeds ${MAX_FACTS} extracted facts; narrow or split the evidence commit`);

  const body = {
    before_commit: before,
    after_commit: after,
    files: [...files].sort(),
    symbols: {
      added: sortByKey(addedSymbols, (s) => `${s.file}\0${s.kind}\0${s.name}`),
      removed: sortByKey(removedSymbols, (s) => `${s.file}\0${s.kind}\0${s.name}`),
      moved: sortByKey(movedSymbols, (s) => `${s.from}\0${s.to}\0${s.kind}\0${s.name}`),
    },
    calls: {
      added: sortByKey(addedCalls, (c) => `${c.file}\0${callKey(c)}`),
      removed: sortByKey(removedCalls, (c) => `${c.file}\0${callKey(c)}`),
    },
    imports: {
      added: sortByKey(addedImports, (i) => `${i.file}\0${i.specifier}`),
      removed: sortByKey(removedImports, (i) => `${i.file}\0${i.specifier}`),
    },
  };
  const contentHash = canonicalHash(body);
  return StructuralDeltaSchema.parse({
    id: `delta_${shortHash(contentHash)}`,
    ...body,
    content_hash: contentHash,
  });
}
