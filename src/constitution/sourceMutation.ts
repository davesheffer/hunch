import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { hunchPathsForDir } from "../core/paths.js";
import { symbolId } from "../core/ids.js";
import { externalPackage } from "../core/externalImports.js";
import { pathMatchesGlob } from "../core/glob.js";
import { resolveRelativeImport } from "../core/relativeImports.js";
import type { Component, Symbol } from "../core/types.js";
import { indexRepo } from "../extractors/indexer.js";
import { parseSource, type ParsedFile, type ParsedSymbol } from "../extractors/parse.js";
import { HunchStore } from "../store/hunchStore.js";
import { canonicalHash } from "./canonical.js";
import { evaluatePolicyOnSnapshot, graphSnapshot, type GraphSnapshot } from "./evaluator.js";
import { hasUnsafeCheckoutAttributes } from "./safeCheckout.js";
import type { PolicyEvaluation, PolicySelector, PolicySpec } from "./schema.js";

export interface SourceMutationOutcome {
  snapshot?: GraphSnapshot;
  evaluation?: PolicyEvaluation;
  source_patch?: { files: string[]; diff: string; diff_hash: string };
  error_code?: string;
}

function safeEnvironment(home: string, gitConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNTH_PROVIDER: "deterministic",
  };
}

function gitArgs(root: string, hooks: string, args: string[]): string[] {
  return [
    "-C", root,
    "-c", `core.hooksPath=${hooks}`,
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "filter.lfs.required=false",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    ...args,
  ];
}

function unsafeLocalFilter(root: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const raw = execFileSync("git", ["-C", root, "config", "--local", "--name-only", "--get-regexp", "^filter\\."], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.trim().split("\n").some((key) => key && !key.startsWith("filter.lfs."));
  } catch {
    return false;
  }
}

function symbolForSelector(snapshot: GraphSnapshot, selector: PolicySelector): Symbol | null {
  const raw = selector.selector;
  if (raw.startsWith("symbol-id:")) return snapshot.symbols.find((symbol) => symbol.id === raw.slice("symbol-id:".length)) ?? null;
  if (!raw.startsWith("symbol:")) return null;
  const target = raw.slice("symbol:".length);
  const split = target.lastIndexOf(":");
  const matches = split > 0
    ? snapshot.symbols.filter((symbol) => symbol.name === target.slice(split + 1) && (symbol.file === target.slice(0, split) || symbol.file.endsWith(`/${target.slice(0, split)}`)))
    : snapshot.symbols.filter((symbol) => symbol.name === target);
  return matches.length === 1 ? matches[0]! : null;
}

function componentForSelector(snapshot: GraphSnapshot, selector: PolicySelector): Component | null {
  const raw = selector.selector;
  if (raw.startsWith("component-id:")) return snapshot.components.find((component) => component.id === raw.slice("component-id:".length)) ?? null;
  if (!raw.startsWith("component:")) return null;
  const name = raw.slice("component:".length);
  const matches = snapshot.components.filter((component) => component.name === name);
  return matches.length === 1 ? matches[0]! : null;
}

function componentFiles(snapshot: GraphSnapshot, component: Component): string[] {
  return [...new Set(snapshot.symbols
    .map((symbol) => symbol.file)
    .filter((file) => component.paths.some((glob) => pathMatchesGlob(file, glob))))].sort();
}

function relativeSpecifier(fromFile: string, toFile: string): string {
  let specifier = relative(dirname(fromFile), toFile).split(/[\\/]/).join(posix.sep);
  specifier = specifier.replace(/\.(?:tsx?|jsx?)$/, ".js");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function parsedSymbolFor(graphSymbol: Symbol, parsed: ParsedFile): ParsedSymbol | null {
  const matches = parsed.symbols.filter((symbol) => symbol.name === graphSymbol.name && symbol.kind === graphSymbol.kind);
  const base = symbolId(graphSymbol.file, graphSymbol.name, graphSymbol.kind);
  return matches.find((_symbol, index) => (index === 0 ? base : `${base}_${index}`) === graphSymbol.id) ?? null;
}

function spliceBytes(source: string, replacements: Array<{ start: number; end: number; text: string }>): string {
  let bytes = Buffer.from(source, "utf8");
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    bytes = Buffer.concat([
      bytes.subarray(0, replacement.start),
      Buffer.from(replacement.text, "utf8"),
      bytes.subarray(replacement.end),
    ]);
  }
  return bytes.toString("utf8");
}

function mutateSource(policy: PolicySpec, base: GraphSnapshot, sourceFile: string, source: string): { file: string; source: string } | { error: string } {
  const assertion = policy.assertion;
  if (assertion.kind === "executable-behavior") return { error: "mutation-executable-behavior-unsupported" };
  if (assertion.kind !== "exists"
    && assertion.relation.edges.length === 1
    && assertion.relation.edges[0] === "depends_on") {
    const subjectComponent = componentForSelector(base, assertion.subject);
    const objectComponent = componentForSelector(base, assertion.object);
    if (!subjectComponent) return { error: "mutation-subject-component-unresolved" };
    if (!objectComponent) return { error: "mutation-object-component-unresolved" };
    const targetFile = componentFiles(base, objectComponent)[0];
    if (!targetFile) return { error: "mutation-object-component-empty" };
    const parsed = parseSource(sourceFile, source);
    if (!parsed?.parseable) return { error: "mutation-source-unparseable" };
    if (assertion.kind === "reaches") {
      const available = base.symbols.map((symbol) => symbol.file);
      const targets = new Set(componentFiles(base, objectComponent));
      const matching = new Set(parsed.imports.filter((specifier) => {
        const resolved = resolveRelativeImport(sourceFile, specifier, available).path;
        return !!resolved && targets.has(resolved);
      }));
      if (!matching.size) return { error: "mutation-required-component-import-unresolved" };
      const lines = source.split(/(?<=\n)/);
      const next = lines.filter((line) => {
        if (!/^\s*(?:import|export)\b/.test(line)) return true;
        return ![...matching].some((specifier) => line.includes(JSON.stringify(specifier)) || line.includes(`'${specifier}'`));
      }).join("");
      if (next === source) return { error: "mutation-required-component-import-unresolved" };
      return { file: sourceFile, source: next };
    }
    const specifier = relativeSpecifier(sourceFile, targetFile);
    if (parsed.imports.some((candidate) => candidate === specifier)) return { error: "mutation-component-import-already-present" };
    const insertion = source.startsWith("#!") ? Math.max(0, source.indexOf("\n") + 1) : 0;
    return {
      file: sourceFile,
      source: spliceBytes(source, [{ start: insertion, end: insertion, text: `import ${JSON.stringify(specifier)}; // hunch deterministic component mutation\n` }]),
    };
  }
  const subject = symbolForSelector(base, assertion.subject);
  if (!subject) return { error: "mutation-subject-unresolved" };
  const parsed = parseSource(subject.file, source);
  if (!parsed?.parseable) return { error: "mutation-source-unparseable" };
  const definition = parsedSymbolFor(subject, parsed);
  if (!definition) return { error: "mutation-subject-definition-unresolved" };

  if (assertion.kind === "exists") {
    return { file: subject.file, source: spliceBytes(source, [{ start: definition.startByte, end: definition.endByte, text: "" }]) };
  }

  if (assertion.kind === "not-reaches"
    && assertion.relation.edges.length === 1
    && assertion.relation.edges[0] === "imports"
    && assertion.object.selector.startsWith("external:")) {
    const dependency = externalPackage(assertion.object.selector.slice("external:".length));
    if (!dependency) return { error: "mutation-external-import-unsupported" };
    if (parsed.imports.some((specifier) => externalPackage(specifier) === dependency)) {
      return { error: "mutation-forbidden-import-already-present" };
    }
    const insertion = source.startsWith("#!") ? Math.max(0, source.indexOf("\n") + 1) : 0;
    return {
      file: subject.file,
      source: spliceBytes(source, [{ start: insertion, end: insertion, text: `import ${JSON.stringify(dependency)}; // hunch deterministic source mutation\n` }]),
    };
  }

  const object = symbolForSelector(base, assertion.object);
  if (!object) return { error: "mutation-object-unresolved" };
  if (assertion.kind === "reaches") {
    const allowed = new Set(assertion.relation.edges);
    const targetNames = new Set(base.edges
      .filter((edge) => edge.from === subject.id && allowed.has(edge.type as "calls" | "imports" | "depends_on" | "contains"))
      .map((edge) => base.symbols.find((symbol) => symbol.id === edge.to)?.name)
      .filter((name): name is string => !!name));
    const replacements = parsed.calls
      .filter((call) => call.atByte >= definition.startByte && call.atByte < definition.endByte && targetNames.has(call.callee))
      .map((call) => ({ start: call.atByte, end: call.endByte, text: "hunchMutationRemovedCall" }));
    if (!replacements.length) return { error: "mutation-required-call-unresolved" };
    return { file: subject.file, source: spliceBytes(source, replacements) };
  }

  if (!assertion.relation.edges.includes("calls")) return { error: "mutation-call-edge-not-supported" };
  const bytes = Buffer.from(source, "utf8");
  const open = bytes.indexOf("{".charCodeAt(0), definition.startByte);
  if (open < 0 || open >= definition.endByte) return { error: "mutation-subject-body-unsupported" };
  const replacements = [{ start: open + 1, end: open + 1, text: `\n  ${object.name}(); // hunch deterministic source mutation\n` }];
  if (object.file !== subject.file) {
    const specifier = relativeSpecifier(subject.file, object.file);
    if (!parsed.imports.includes(specifier)) {
      const insertion = source.startsWith("#!") ? Math.max(0, source.indexOf("\n") + 1) : 0;
      replacements.push({
        start: insertion,
        end: insertion,
        text: `import { ${object.name} } from ${JSON.stringify(specifier)}; // hunch deterministic source mutation\n`,
      });
    }
  }
  return {
    file: subject.file,
    source: spliceBytes(source, replacements),
  };
}

function removeWorktree(root: string, hooks: string, env: NodeJS.ProcessEnv, checkout: string): boolean {
  try {
    execFileSync("git", gitArgs(root, hooks, ["worktree", "remove", "--force", checkout]), { env, timeout: 10_000, stdio: "ignore" });
    return true;
  } catch {
    rmSync(checkout, { recursive: true, force: true });
    try {
      execFileSync("git", gitArgs(root, hooks, ["worktree", "remove", "--force", checkout]), { env, timeout: 10_000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function openRegularSourceNoFollow(checkout: string, sourceFile: string): number {
  const file = join(checkout, sourceFile);
  const before = lstatSync(file);
  if (before.isSymbolicLink()) throw new Error("mutation-source-symlink-unsupported");
  if (!before.isFile()) throw new Error("mutation-source-not-regular");

  const canonicalCheckout = realpathSync(checkout);
  const canonicalFile = realpathSync(file);
  const fromCheckout = relative(canonicalCheckout, canonicalFile);
  if (!fromCheckout || fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout)
    || canonicalFile !== resolve(canonicalCheckout, sourceFile)) {
    throw new Error("mutation-source-outside-checkout");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("mutation-source-changed-before-open");
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("mutation-source-symlink-unsupported");
    throw error;
  }
}

/** Apply one primary mutation to an immutable disposable source checkout. No
 * project script, build, test, provider, model, or repository hook executes. */
export function runSourceMutation(root: string, policy: PolicySpec, base: GraphSnapshot): SourceMutationOutcome {
  if (policy.assertion.kind === "executable-behavior") return { error_code: "mutation-executable-behavior-unsupported" };
  if (!/^[a-f0-9]{40}$/.test(base.head)) return { error_code: "mutation-base-not-immutable" };
  const cacheBase = join(root, ".hunch-cache", "mutations");
  mkdirSync(cacheBase, { recursive: true });
  const session = mkdtempSync(join(cacheBase, "mutation-"));
  const hooks = join(session, "hooks-disabled");
  const gitConfig = join(session, "global.gitconfig");
  const checkout = join(session, "checkout");
  const graph = join(session, "graph");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(gitConfig, "");
  const env = safeEnvironment(session, gitConfig);
  let added = false;
  let store: HunchStore | undefined;
  let outcome: SourceMutationOutcome = { error_code: "source-mutation-failed" };
  try {
    if (unsafeLocalFilter(root, env)) throw new Error("unsafe-local-filter-config");
    if (hasUnsafeCheckoutAttributes(root, base.head, env, { allowDisabledLfs: true })) {
      throw new Error("unsafe-checkout-attributes");
    }
    execFileSync("git", gitArgs(root, hooks, ["worktree", "add", "--detach", "--force", checkout, base.head]), {
      env,
      timeout: 30_000,
      stdio: "ignore",
    });
    added = true;
    const subject = symbolForSelector(base, policy.assertion.subject);
    const subjectComponent = componentForSelector(base, policy.assertion.subject);
    const sourceFile = subject?.file ?? (subjectComponent ? componentFiles(base, subjectComponent)[0] : undefined);
    if (!sourceFile) throw new Error("mutation-subject-unresolved");
    const descriptor = openRegularSourceNoFollow(checkout, sourceFile);
    let mutation: { file: string; source: string };
    try {
      const attempted = mutateSource(policy, base, sourceFile, readFileSync(descriptor, "utf8"));
      if ("error" in attempted) throw new Error(attempted.error);
      mutation = attempted;
      if (mutation.file !== sourceFile) throw new Error("mutation-source-target-changed");
      const parsed = parseSource(mutation.file, mutation.source);
      if (!parsed?.parseable) throw new Error("mutation-source-unparseable");
      ftruncateSync(descriptor, 0);
      const bytes = Buffer.from(mutation.source, "utf8");
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(descriptor, bytes, written, bytes.length - written, written);
        if (!count) throw new Error("mutation-source-write-incomplete");
        written += count;
      }
    } finally {
      closeSync(descriptor);
    }
    const diff = execFileSync("git", gitArgs(checkout, hooks, ["diff", "--no-ext-diff", "--no-textconv", "--", mutation.file]), {
      env,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!diff.trim()) throw new Error("mutation-source-diff-empty");
    if (Buffer.byteLength(diff, "utf8") > 65_536) throw new Error("mutation-source-diff-too-large");
    store = new HunchStore(hunchPathsForDir(graph));
    store.json.ensureDirs();
    indexRepo(store, checkout, { churn: false, requireComplete: true });
    const snapshot = graphSnapshot(store, root, { publicOnly: true, head: base.head });
    outcome = {
      snapshot,
      evaluation: evaluatePolicyOnSnapshot(policy, snapshot),
      source_patch: { files: [mutation.file], diff, diff_hash: canonicalHash(diff) },
    };
  } catch (error) {
    const message = (error as Error).message;
    outcome = {
      error_code: /^[a-z0-9-]+$/.test(message)
        ? message
        : added ? "source-mutation-index-failed" : "source-mutation-worktree-failed",
    };
  } finally {
    try { store?.close(); } catch { /* cleanup continues */ }
    if (added && !removeWorktree(root, hooks, env, checkout)) outcome = { error_code: "worktree-cleanup-failed" };
    rmSync(session, { recursive: true, force: true });
  }
  return outcome;
}
