import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type TreeSitterParser from "tree-sitter";

const runtimeRequire = createRequire(import.meta.url);
const COPY_PREFIX = "hunch-tree-sitter-";
const NATIVE_PACKAGES = ["tree-sitter", "tree-sitter-typescript"] as const;

type NodeGypBuild = ((root: string) => unknown) & { path(root: string): string };

export interface NativeTreeSitterRuntime {
  Parser: typeof TreeSitterParser;
  typescript: unknown;
  tsx: unknown;
}

let runtime: NativeTreeSitterRuntime | null = null;

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

/** Load both native tree-sitter addons from process-owned temp copies. Windows
 * keeps loaded `.node` files locked for the process lifetime; redirecting the
 * upstream loaders means npm can replace the installed package during an active
 * MCP session without killing that session or falling back to a stale binary. */
export function loadNativeTreeSitter(): NativeTreeSitterRuntime {
  if (runtime) return runtime;
  const preloaded = Object.keys(runtimeRequire.cache).filter((path) =>
    /tree-sitter(?:-typescript)?\.node$/.test(path)
    && !new RegExp(`(?:^|[\\\\/])${COPY_PREFIX}\\d+-`).test(path));
  if (preloaded.length) {
    throw new Error(`tree-sitter native addon was loaded before Hunch could isolate it: ${preloaded.join(", ")}`);
  }

  removeStaleCopies();
  const copyRoot = mkdtempSync(join(tmpdir(), `${COPY_PREFIX}${process.pid}-`));
  const nodeGypBuild = runtimeRequire("node-gyp-build") as NodeGypBuild;
  const previous = new Map<string, string | undefined>();
  try {
    for (const packageName of NATIVE_PACKAGES) {
      const key = environmentKey(packageName);
      previous.set(key, process.env[key]);
      process.env[key] = copyNativeBinding(packageName, copyRoot, nodeGypBuild);
    }
    const Parser = runtimeRequire("tree-sitter") as typeof TreeSitterParser;
    const languages = runtimeRequire("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    runtime = { Parser, typescript: languages.typescript, tsx: languages.tsx };
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
