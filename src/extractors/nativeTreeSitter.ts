import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type TreeSitterParser from "tree-sitter";

const runtimeRequire = createRequire(import.meta.url);
const COPY_PREFIX = "hunch-tree-sitter-";
const NATIVE_PACKAGES = [
  "tree-sitter",
  "tree-sitter-typescript",
  "tree-sitter-python",
  "tree-sitter-go",
  "tree-sitter-php",
  "@tree-sitter-grammars/tree-sitter-yaml",
] as const;

type NodeGypBuild = ((root: string) => unknown) & { path(root: string): string };

export interface NativeTreeSitterRuntime {
  Parser: typeof TreeSitterParser;
  typescript: unknown;
  tsx: unknown;
  python: unknown;
  go: unknown;
  php: unknown;
  yaml: unknown;
}

let runtime: NativeTreeSitterRuntime | null = null;

/** The parser runtime itself is unavailable — the addons could not be copied or
 *  dlopen'd (unwritable/full TMPDIR, a missing or wrong-arch prebuild, npm
 *  replacing the package mid-session, or the fail-closed "preloaded addon"
 *  guard). Distinct from a per-file parse error on purpose: now that the load
 *  happens on first parse rather than at import, every swallow-and-continue
 *  catch on a parse path would otherwise read this as "this one file is bad"
 *  and, in a whole-repo scan, mark EVERY file parse_failed and overwrite the
 *  graph with nothing. Callers rethrow it so the run dies before any write,
 *  the way the import-time load used to. The original error is kept as `cause`
 *  and its text is carried in the message so the EACCES/dlopen detail a user
 *  needs is never lost. */
export class NativeTreeSitterLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NativeTreeSitterLoadError";
  }
}

/** The ONE predicate every rethrow site uses — a dead parser is recognised the
 *  same way everywhere, so no catch can quietly disagree about what counts.
 *  `instanceof` alone is not enough: a duplicated module instance (two copies of
 *  this file in one process, e.g. dist/ + src/ under tsx, or a worker that
 *  re-resolves it) gives a different class identity, and an error rebuilt across
 *  a worker/IPC boundary keeps only its plain properties. The name check
 *  survives both. */
export function isParserLoadError(e: unknown): boolean {
  return e instanceof NativeTreeSitterLoadError || (e as Error | undefined)?.name === "NativeTreeSitterLoadError";
}

/** Wrap any loader failure once, preserving an already-typed one. */
function loadFailure(error: unknown): NativeTreeSitterLoadError {
  if (error instanceof NativeTreeSitterLoadError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new NativeTreeSitterLoadError(`native tree-sitter parser unavailable: ${detail}`, { cause: error });
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeStaleCopies(): void {
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = new RegExp(`^${COPY_PREFIX}(\\d+)-`).exec(entry.name);
    if (!match || processIsAlive(Number(match[1]))) continue;
    try {
      rmSync(join(tmpdir(), entry.name), { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // Another process may have won the cleanup race, or Windows may still be
      // releasing a just-exited native module. A later process can retry.
    }
  }
}

function environmentKey(packageName: string): string {
  return `${packageName.toUpperCase().replaceAll("-", "_")}_PREBUILD`;
}

function copyNativeBinding(packageName: string, copyRoot: string, nodeGypBuild: NodeGypBuild): string {
  const packageRoot = dirname(runtimeRequire.resolve(`${packageName}/package.json`));
  const source = nodeGypBuild.path(packageRoot);
  const packageCopy = join(copyRoot, packageName);
  const normalized = source.replaceAll("\\", "/");
  const prebuild = /\/prebuilds\/([^/]+)\/[^/]+$/.exec(normalized);
  const destination = prebuild
    ? join(packageCopy, "prebuilds", prebuild[1]!, basename(source))
    : join(packageCopy, "build", "Release", basename(source));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return packageCopy;
}

/** Load all native tree-sitter addons (the parser runtime + every grammar) from
 * process-owned temp copies. Windows keeps loaded `.node` files locked for the
 * process lifetime; redirecting the upstream loaders means npm can replace the
 * installed package during an active MCP session without killing that session
 * or falling back to a stale binary. */
export function loadNativeTreeSitter(): NativeTreeSitterRuntime {
  if (runtime) return runtime;
  // Only SUCCESS is memoized (in `runtime`), never the failure: the conditions
  // that break the load are transient — a full or read-only TMPDIR, an npm
  // install swapping the package out from under a live process. A long-lived
  // MCP server must be able to parse again once the condition clears, so every
  // call retries the load from scratch.
  try {
    return loadRuntime();
  } catch (error) {
    throw loadFailure(error);
  }
}

function loadRuntime(): NativeTreeSitterRuntime {
  // Three binding spellings: prebuilds ship as tree-sitter[-typescript|-python].node
  // or, for a scoped package like @tree-sitter-grammars/tree-sitter-yaml, as
  // @scope+name.node; from-source builds are named after the binding.gyp target
  // with underscores (tree_sitter_runtime_binding.node, tree_sitter_python_binding.node,
  // tree_sitter_yaml_binding.node, …). Missing the underscore names let an
  // already-loaded source-built addon slip past this guard and defeat the
  // file-lock isolation entirely (issue #52).
  const preloaded = Object.keys(runtimeRequire.cache).filter((path) =>
    /(?:tree-sitter(?:-typescript|-python|-go|-php|-yaml)?|tree_sitter(?:_[a-z]+)*_binding)\.node$/.test(path)
    && !new RegExp(`(?:^|[\\\\/])${COPY_PREFIX}\\d+-`).test(path));
  if (preloaded.length) {
    throw new Error(`tree-sitter native addon was loaded before Hunch could isolate it: ${preloaded.join(", ")}`);
  }

  removeStaleCopies();
  const copyRoot = mkdtempSync(join(tmpdir(), `${COPY_PREFIX}${process.pid}-`));
  const previous = new Map<string, string | undefined>();
  try {
    // Resolved INSIDE the try: if node-gyp-build cannot be resolved (a partial
    // install, npm mid-swap) the catch below still removes the copy dir we just
    // created. Outside it, every retry — and failure is deliberately not
    // memoized, so a long-lived MCP server retries forever — leaked one empty
    // hunch-tree-sitter-<pid>-* dir that removeStaleCopies can never prune,
    // because it only prunes dirs whose pid is dead.
    const nodeGypBuild = runtimeRequire("node-gyp-build") as NodeGypBuild;
    for (const packageName of NATIVE_PACKAGES) {
      const key = environmentKey(packageName);
      previous.set(key, process.env[key]);
      process.env[key] = copyNativeBinding(packageName, copyRoot, nodeGypBuild);
    }
    const Parser = runtimeRequire("tree-sitter") as typeof TreeSitterParser;
    const languages = runtimeRequire("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    const python = runtimeRequire("tree-sitter-python") as unknown;
    const go = runtimeRequire("tree-sitter-go") as unknown;
    const php = runtimeRequire("tree-sitter-php") as { php: unknown };
    const yaml = runtimeRequire("@tree-sitter-grammars/tree-sitter-yaml") as unknown;
    runtime = { Parser, typescript: languages.typescript, tsx: languages.tsx, python, go, php: php.php, yaml };
  } catch (error) {
    try { rmSync(copyRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  process.once("exit", () => {
    try { rmSync(copyRoot, { recursive: true, force: true }); } catch { /* next process prunes it */ }
  });
  return runtime;
}
