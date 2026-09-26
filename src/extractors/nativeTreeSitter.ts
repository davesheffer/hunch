import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type TreeSitterParser from "tree-sitter";

const runtimeRequire = createRequire(import.meta.url);
/** Legacy per-process copy dirs (`hunch-tree-sitter-<pid>-*`), pruned when dead. */
const COPY_PREFIX = "hunch-tree-sitter-";
/** Per-user cache of content-addressed copies (`hunch-tree-sitter-cache-<user>`). */
const CACHE_PREFIX = "hunch-tree-sitter-cache-";
/** A hash dir no process has used for this long is pruned. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

/** The per-user copy cache. A binary copied to a fresh path costs a first-load
 *  assessment (macOS checks every never-seen dylib: ~2s per addon, six addons)
 *  on every process; the same bytes at a path already loaded once cost ~0ms. So
 *  copies are content-addressed and reused across processes instead of made per
 *  process. The directory is private to the user: an addon dlopen'd from a
 *  location another account can write would be code execution as this user. */
function cacheRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let user = String(uid ?? "");
  if (!user) {
    try { user = userInfo().username; } catch { user = "user"; }
  }
  const root = join(tmpdir(), `${CACHE_PREFIX}${user.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`tree-sitter copy cache is not a directory: ${root}`);
  // POSIX: refuse a cache another account owns or can write into. (Windows has
  // no uid and a per-user TEMP; its ACLs are not mode bits.)
  if (uid !== null && (st.uid !== uid || (st.mode & 0o022) !== 0)) {
    throw new Error(`tree-sitter copy cache is not private to this user: ${root}`);
  }
  return root;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyNativeBinding(packageName: string, root: string, nodeGypBuild: NodeGypBuild): string {
  const packageRoot = dirname(runtimeRequire.resolve(`${packageName}/package.json`));
  const source = nodeGypBuild.path(packageRoot);
  const bytes = readFileSync(source);
  const digest = sha256(bytes);
  const hashDir = join(root, digest.slice(0, 32));
  const packageCopy = join(hashDir, packageName);
  const normalized = source.replaceAll("\\", "/");
  const prebuild = /\/prebuilds\/([^/]+)\/[^/]+$/.exec(normalized);
  const destination = prebuild
    ? join(packageCopy, "prebuilds", prebuild[1]!, basename(source))
    : join(packageCopy, "build", "Release", basename(source));
  // Reuse only bytes that still hash to the installed binary: a truncated or
  // replaced copy is rewritten, never loaded.
  const intact = () => {
    try { return sha256(readFileSync(destination)) === digest; } catch { return false; }
  };
  // Mark the hash dir in use BEFORE verifying it, so a concurrent prune
  // cannot remove it between the check and the dlopen.
  try { const now = new Date(); utimesSync(hashDir, now, now); } catch { /* not created yet */ }
  if (!intact()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    // Atomic: a concurrent process sees the old file or the complete new one.
    const partial = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      copyFileSync(source, partial);
      renameSync(partial, destination);
    } catch (error) {
      try { rmSync(partial, { force: true }); } catch { /* best effort */ }
      // Windows refuses to replace a copy another process has loaded; that copy
      // is then the same bytes, which is all this needs.
      if (!intact()) throw error;
    }
    if (!intact()) throw new Error(`tree-sitter copy does not match its source: ${destination}`);
  }
  return packageCopy;
}

/** Hash dirs unused for CACHE_TTL_MS belong to replaced installs. Deleting one
 *  that is still loaded fails on Windows (retried by a later process) and is
 *  harmless on POSIX (the mapping outlives the directory entry). */
function pruneCache(root: string, keep: ReadonlySet<string>): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const dir = join(root, entry.name);
    try {
      if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch { /* in use or already gone */ }
  }
}

/** Load all native tree-sitter addons (the parser runtime + every grammar) from
 * content-addressed copies in a per-user temp cache — never from the installed
 * package. Windows keeps loaded `.node` files locked for the
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
    && !new RegExp(`(?:^|[\\\\/])(?:${COPY_PREFIX}\\d+-|${CACHE_PREFIX})`).test(path));
  if (preloaded.length) {
    throw new Error(`tree-sitter native addon was loaded before Hunch could isolate it: ${preloaded.join(", ")}`);
  }

  removeStaleCopies();
  // A refused cache (another account's or a group-writable dir squatting the
  // predictable name) must not kill parsing: fall back to a private
  // per-process copy dir, which removeStaleCopies prunes once the pid is gone.
  let root: string;
  let shared = true;
  try { root = cacheRoot(); } catch {
    root = mkdtempSync(join(tmpdir(), `${COPY_PREFIX}${process.pid}-`));
    shared = false;
  }
  const previous = new Map<string, string | undefined>();
  const used = new Set<string>();
  try {
    const nodeGypBuild = runtimeRequire("node-gyp-build") as NodeGypBuild;
    for (const packageName of NATIVE_PACKAGES) {
      const key = environmentKey(packageName);
      previous.set(key, process.env[key]);
      const packageCopy = copyNativeBinding(packageName, root, nodeGypBuild);
      used.add(relative(root, packageCopy).split(sep)[0]!);
      process.env[key] = packageCopy;
    }
    const Parser = runtimeRequire("tree-sitter") as typeof TreeSitterParser;
    const languages = runtimeRequire("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    const python = runtimeRequire("tree-sitter-python") as unknown;
    const go = runtimeRequire("tree-sitter-go") as unknown;
    const php = runtimeRequire("tree-sitter-php") as { php: unknown };
    const yaml = runtimeRequire("@tree-sitter-grammars/tree-sitter-yaml") as unknown;
    runtime = { Parser, typescript: languages.typescript, tsx: languages.tsx, python, go, php: php.php, yaml };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (shared) pruneCache(root, used);
  return runtime;
}
