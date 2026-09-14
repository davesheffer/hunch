/** Best-effort update notices for interactive CLI commands.
 *
 * The foreground process only reads a small cache and starts an unreferenced,
 * detached worker when that cache is stale. Network I/O happens in the worker,
 * so an unavailable registry cannot hold the user's command open. The first
 * cold invocation populates the cache; later invocations can display it.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HUNCH_PACKAGE_NAME, HUNCH_VERSION } from "./version.js";

const REGISTRY_URL = `https://registry.npmjs.org/${HUNCH_PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const WORKER_FLAG = "--hunch-refresh-update-cache";
const MAX_CACHE_BYTES = 4096;

export interface UpdateCheckResult {
  current: string;
  latest: string;
}

interface UpdateCheckCache {
  /** Time of the last scheduled attempt, successful or not. */
  lastCheckedAt: number;
  /** Last valid registry version, retained while a refresh is in flight/fails. */
  latestSeen?: string;
}

export interface UpdateCachePathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

function configuredCacheRoot(value: string | undefined, platform: NodeJS.Platform): string | null {
  if (!value) return null;
  const absolute = platform === "win32" ? win32.isAbsolute(value) : isAbsolute(value);
  const containsMarker = value.replace(/\\/g, "/").split("/").some(part => {
    // Win32 aliases path components with trailing spaces or periods to the
    // unadorned name, so `.hunch.` and `.hunch ` can address `.hunch` too.
    const normalized = platform === "win32" ? part.replace(/[ .]+$/g, "") : part;
    return normalized.toLowerCase() === ".hunch";
  });
  if (!absolute || containsMarker) return null;
  return value;
}

/** Use each platform's normal per-user cache root. This deliberately never
 * creates a `.hunch` path segment: `.hunch` is the repository marker used by
 * findRoot(), so placing a cache there could redirect commands to the wrong
 * project. */
export function defaultCacheFile(opts: UpdateCachePathOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const cacheHome = configuredCacheRoot(env.XDG_CACHE_HOME, platform)
    || (platform === "win32" && configuredCacheRoot(env.LOCALAPPDATA, platform))
    || (platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache"));
  return join(cacheHome, "hunch", "update-check.json");
}

function readCache(file: string): UpdateCheckCache | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdateCheckCache>;
    if (!Number.isFinite(parsed.lastCheckedAt) || (parsed.lastCheckedAt ?? -1) < 0) return null;
    if (parsed.latestSeen !== undefined && parseVersion(parsed.latestSeen) === null) return null;
    return { lastCheckedAt: parsed.lastCheckedAt!, ...(parsed.latestSeen ? { latestSeen: parsed.latestSeen } : {}) };
  } catch {
    return null;
  }
}

/** Cache writes are atomic even though this cache is derived and disposable:
 * concurrent CLI processes must not leave malformed JSON that causes every
 * subsequent command to schedule another network request. */
function writeCache(file: string, cache: UpdateCheckCache): boolean {
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    return false;
  }
}

interface ParsedVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
}

/** Strict SemVer parsing keeps untrusted registry text out of terminal output. */
function parseVersion(version: string): ParsedVersion | null {
  if (version.length > 256) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease,
  };
}

/** Full SemVer precedence for the release and prerelease fields. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.core.length; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]!;
  }
  if (a.prerelease === null || b.prerelease === null) return a.prerelease === null && b.prerelease !== null;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined || right === undefined) return right === undefined;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return left > right;
  }
  return false;
}

async function fetchLatestVersion(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

export interface RefreshUpdateCacheOptions {
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Worker entry point, exported so network/cache behavior is testable without
 * spawning a process or contacting the real registry. */
export async function refreshUpdateCache(opts: RefreshUpdateCacheOptions = {}): Promise<boolean> {
  const cacheFile = opts.cacheFile ?? defaultCacheFile();
  const latest = await fetchLatestVersion(opts.fetchImpl ?? fetch);
  if (latest === null) return false;
  return writeCache(cacheFile, { lastCheckedAt: (opts.now ?? Date.now)(), latestSeen: latest });
}

export interface ScheduleUpdateCheckOptions {
  cacheFile?: string;
  currentVersion?: string;
  now?: () => number;
  workerFile?: string;
  spawnImpl?: typeof spawn;
}

function cacheIsFresh(cache: UpdateCheckCache | null, now: number): boolean {
  return cache !== null && cache.lastCheckedAt <= now && now - cache.lastCheckedAt < CHECK_INTERVAL_MS;
}

/** Serialize the short cache claim across simultaneous CLI processes. This
 * advisory fails closed when a prior process left the lock behind: reclaiming
 * a pathname without an OS lock cannot distinguish that stale file from a new
 * owner's lock on both POSIX and Windows. */
function acquireRefreshLock(cacheFile: string, now: number): string | null {
  const lockFile = `${cacheFile}.lock`;
  try { mkdirSync(dirname(cacheFile), { recursive: true }); }
  catch { return null; }
  try {
    writeFileSync(lockFile, `${now}\n`, { flag: "wx", mode: 0o600 });
    return lockFile;
  } catch { return null; }
}

/** Read any known update immediately and schedule at most one refresh per day.
 * Claiming the interval before spawning also bounds offline requests: failed
 * checks are not retried on every CLI command. */
export function scheduleUpdateCheck(opts: ScheduleUpdateCheckOptions = {}): UpdateCheckResult | null {
  try {
    const cacheFile = opts.cacheFile ?? defaultCacheFile();
    const currentVersion = opts.currentVersion ?? HUNCH_VERSION;
    const now = (opts.now ?? Date.now)();
    const cache = readCache(cacheFile);
    const notice = cache?.latestSeen && isNewerVersion(cache.latestSeen, currentVersion)
      ? { current: currentVersion, latest: cache.latestSeen }
      : null;
    if (cacheIsFresh(cache, now)) return notice;

    const lockFile = acquireRefreshLock(cacheFile, now);
    if (!lockFile) return notice;
    let claimed = false;
    try {
      // Another process may have refreshed while this one was acquiring the
      // claim. Re-read under the lock before deciding to schedule a worker.
      const current = readCache(cacheFile);
      if (cacheIsFresh(current, now)) return notice;
      // If the cache cannot record the claim, skip the request. Otherwise a
      // read-only/misconfigured cache directory would trigger a request forever.
      claimed = writeCache(cacheFile, { lastCheckedAt: now, ...(current?.latestSeen ? { latestSeen: current.latestSeen } : {}) });
    } finally {
      try { unlinkSync(lockFile); } catch { /* derived lock cleanup is best effort */ }
    }
    if (!claimed) return notice;

    const workerFile = opts.workerFile ?? fileURLToPath(import.meta.url);
    try {
      const child = (opts.spawnImpl ?? spawn)(process.execPath, [workerFile, WORKER_FLAG, cacheFile], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      } satisfies SpawnOptions);
      child.once?.("error", () => {});
      child.unref();
    } catch { /* the cached notice remains useful even when refresh cannot start */ }
    return notice;
  } catch {
    return null;
  }
}

export interface UpdateCheckGateOptions {
  commandName: string;
  isTTY: boolean;
  installed: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Commands used by hooks, servers, CI, or the updater itself must never start
 * an advisory worker, even when they inherit a terminal. */
const PLUMBING_COMMANDS = new Set([
  "mcp",
  "check",
  "merge-driver",
  "merge-driver-grounding",
  "sync",
  "repair-provenance",
  "hook",
  "ci",
  "serve",
  "update",
]);

export function shouldCheckForUpdate({ commandName, isTTY, installed, env = process.env }: UpdateCheckGateOptions): boolean {
  if (PLUMBING_COMMANDS.has(commandName) || /^(?:task|integrations|serve)\s/.test(commandName) || !isTTY || !installed) return false;
  return !env.CI && !env.HUNCH_NO_UPDATE_CHECK && !env.NO_UPDATE_NOTIFIER;
}

export function formatUpdateNotice(result: UpdateCheckResult): string {
  return (
    `A newer Hunch version is available: ${result.current} -> ${result.latest}\n` +
    "Run `hunch update` in the repository (`hunch update --global` if this CLI is global). " +
    "Set HUNCH_NO_UPDATE_CHECK=1 to stop checking."
  );
}

function isWorkerInvocation(): boolean {
  if (process.argv[2] !== WORKER_FLAG || !process.argv[1]) return false;
  try { return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isWorkerInvocation()) {
  // This process is detached from the user's command. All errors are local to
  // the derived cache and intentionally produce neither output nor a nonzero
  // exit that could be mistaken for the command's result.
  void refreshUpdateCache({ cacheFile: process.argv[3] }).catch(() => {});
}
