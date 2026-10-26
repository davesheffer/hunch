/**
 * Per-machine repo profiles (dec_66636a2b1b): which overlay a checkout of a given origin
 * uses on THIS machine. `.hunch/local.json` and the git-common-dir pointer die with a
 * clone; the profile lives beside machine.json, keyed by the normalized origin URL, so a
 * fresh clone of the same repository finds its overlay again instead of opening public.
 *
 * Like team-trust.json it lives outside every repository, so no repository content can
 * point a checkout at a store this user never set up.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./io.js";
import { machineFile } from "./machine.js";
import { checkoutCommonDir } from "../extractors/git.js";
import { readConfig, writeConfig } from "./config.js";
import { hunchPaths } from "./paths.js";

export interface RepoProfileEntry {
  privateDir: string;
  mode: "private" | "shared";
  autoCommit: boolean;
  updated_at: string;
}

type RepoProfileFile = { version: 1; repos: Record<string, RepoProfileEntry> };

const REPO_PROFILE_MAX_BYTES = 256 * 1024;
const GIT_CONFIG_MAX_BYTES = 1024 * 1024;

export function repoProfileFile(): string {
  return join(dirname(machineFile()), "repo-profiles.json");
}

/** `host/owner/repo` for any spelling of the same remote: scp-style, ssh://, https://,
 *  with or without credentials, a trailing `.git` or `/`. Hosts compare case-insensitively;
 *  paths keep their case. "" for something that is not a network remote. */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim();
  if (!value) return "";
  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === "file") return "";
    value = scheme[2]!;
    const slash = value.indexOf("/");
    const authority = slash < 0 ? value : value.slice(0, slash);
    path = slash < 0 ? "" : value.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  } else {
    // `C:/repo` is a Windows drive path, not scp-style `host:path`.
    if (/^[A-Za-z]:[\\/]/.test(value)) return "";
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
    if (!scp) return "";
    host = scp[1]!;
    path = scp[2]!;
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path) return "";
  return `${host.toLowerCase()}/${path}`;
}

/** `remote "origin"`'s url from a git config file's text — the first one, as git reads it. */
function originUrlFromConfig(text: string): string {
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1]!.toLowerCase() === "remote" && section[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const entry = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line);
    if (entry) return entry[1]!.replace(/^"(.*)"$/, "$1");
  }
  return "";
}

/** The profile key for `root`: its origin, read from the git config FILE of the checkout's
 *  own common dir (no `git config` spawn on the store-open path). Callers that already
 *  resolved the common dir pass it. "" when there is no origin. */
export function repoProfileKey(root: string, commonDir?: string): string {
  try {
    const common = commonDir ?? checkoutCommonDir(root);
    if (!common) return "";
    const file = join(common, "config");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > GIT_CONFIG_MAX_BYTES) return "";
    return normalizeRemoteUrl(originUrlFromConfig(readFileSync(file, "utf8")));
  } catch {
    return "";
  }
}

/** The parsed profile file. Absent → empty; unreadable or malformed → null, which readers
 *  treat as "no profile" and writers refuse to clobber. */
function readProfiles(file: string): RepoProfileFile | null {
  let raw: string;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > REPO_PROFILE_MAX_BYTES) return null;
    raw = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { version: 1, repos: {} } : null;
  }
  try {
    const value = JSON.parse(raw) as Partial<RepoProfileFile>;
    if (value.version !== 1 || !value.repos || typeof value.repos !== "object" || Array.isArray(value.repos)) return null;
    return { version: 1, repos: value.repos };
  } catch {
    return null;
  }
}

function validEntry(value: unknown): value is RepoProfileEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<RepoProfileEntry>;
  return typeof v.privateDir === "string" && isAbsolute(v.privateDir)
    && (v.mode === "private" || v.mode === "shared")
    && typeof v.autoCommit === "boolean";
}

const REPO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_KEY_PREFIX = "repo-id:";

/** The repository id committed in `root`'s `.hunch/config.json` (`repo_id`), or "". It names
 *  the repository where the origin cannot: no origin, a local-path or file:// origin, or a
 *  clone made from another checkout on disk. A malformed value names nothing. */
export function repoIdOf(root: string): string {
  const id: unknown = readConfig(hunchPaths(root)).repo_id;
  return typeof id === "string" && REPO_ID.test(id) ? id : "";
}

/** Record a repository id in `.hunch/config.json` unless one is there. Every other key is
 *  kept; an unparseable file or a malformed id is refused, never replaced. */
export function ensureRepoId(root: string): { id: string; minted: boolean } {
  const paths = hunchPaths(root);
  const current: unknown = readConfig(paths).repo_id;
  if (current !== undefined) {
    if (typeof current !== "string" || !REPO_ID.test(current)) throw new Error(`refusing to replace the repo_id in ${paths.config} (${JSON.stringify(current)} is not a repository id); fix or remove it`);
    return { id: current, minted: false };
  }
  const id = randomUUID();
  writeConfig(paths, { repo_id: id }); // refuses to overwrite an unparseable or non-object file
  return { id, minted: true };
}

/** Hosts that treat `Acme/Widgets` and `acme/widgets` as one repository. A self-hosted
 *  server may not, so elsewhere path case names a different repository. */
const CASE_INSENSITIVE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "dev.azure.com", "ssh.dev.azure.com"]);

/** Same remote: hosts already compare lowercased; path case aside only on the hosts above. */
const sameOrigin = (a: string, b: string): boolean =>
  a === b || (a.toLowerCase() === b.toLowerCase() && CASE_INSENSITIVE_HOSTS.has(a.slice(0, a.indexOf("/")).toLowerCase()));

/** The network origin an id entry was recorded for ("" = recorded where there was none). */
const recordedOrigin = (raw: unknown): string =>
  raw && typeof raw === "object" && typeof (raw as { origin?: unknown }).origin === "string" ? (raw as { origin: string }).origin : "";

/** Whether a checkout with `origin` may rewrite an id entry to name `privateDir`. One
 *  recorded for another network origin belongs to that repository (a fork carries the
 *  id it cloned). Across the origin gap (recorded with no network origin and claimed
 *  from one, or the reverse) the two checkouts cannot be told apart from a copy, so
 *  only a rebind to the live overlay already recorded. From a checkout with no network
 *  origin that rebind keeps the recorded origin and settings; from one with a network
 *  origin it binds the id to that origin (the owner added a remote), and ownership moves
 *  with it: later setup or forget there is same-side (see writeRepoProfile). Naming the
 *  live recorded overlay is the only gate, since a copy pushed elsewhere cannot be told
 *  from the owner. An entry holds the id even while its overlay
 *  is unavailable: an unmounted drive is not a released id, and a claimant's rewrite
 *  would steer the owner to the claimant's overlay. Two no-origin checkouts cannot be
 *  told apart at all; the owner's own checkout is kept by its local pointer. */
const mayClaimId = (raw: unknown, origin: string, privateDir?: string): boolean => {
  if (!validEntry(raw)) return true; // a non-entry holds nothing
  const recordedFor = recordedOrigin(raw);
  if (recordedFor && origin) return sameOrigin(recordedFor, origin);
  if (!recordedFor && !origin) return true;
  return !!privateDir && samePath(raw.privateDir, privateDir) && !!liveEntry(raw);
};

/** Whether `forget` from a checkout with `origin` may drop an id entry: only one bound
 *  to this same origin, or recorded and forgotten with no origin; never across the
 *  origin gap. Looser than setup would let a clone or a de-remoted fork forget the
 *  entry and then claim the id. */
const mayForgetId = (raw: unknown, origin: string): boolean => {
  if (!validEntry(raw)) return true;
  const recordedFor = recordedOrigin(raw);
  return recordedFor ? !!origin && sameOrigin(recordedFor, origin) : !origin;
};

function liveEntry(value: unknown): RepoProfileEntry | null {
  if (!validEntry(value)) return null;
  try {
    if (!statSync(value.privateDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { privateDir: value.privateDir, mode: value.mode, autoCommit: value.autoCommit, updated_at: typeof value.updated_at === "string" ? value.updated_at : "" };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export interface ResolvedRepoProfile {
  entry: RepoProfileEntry | null;
  /** Why matching entries were set aside, when one or more matched yet none could be used. */
  conflict?: string;
}

/** This machine's overlay for `root`'s repository identity: the committed repo id (refused
 *  when it was recorded for another network origin, so a fork never inherits the upstream
 *  overlay) and the origin, path case aside (an exact-case entry wins over variants).
 *  Entries that name different overlays leave the home unresolved: never a guess. A dead
 *  overlay dir reads as no profile: opening a store must never invent a directory. */
export function resolveRepoProfile(root: string, opts: { commonDir?: string } = {}): ResolvedRepoProfile {
  const origin = repoProfileKey(root, opts.commonDir);
  const id = repoIdOf(root);
  if (!origin && !id) return { entry: null };
  const repos = readProfiles(repoProfileFile())?.repos as Record<string, unknown> | undefined;
  if (!repos) return { entry: null };
  const candidates: Array<{ key: string; entry: RepoProfileEntry }> = [];
  const conflicts: string[] = [];
  if (id) {
    const raw = repos[ID_KEY_PREFIX + id];
    const entry = liveEntry(raw);
    const recordedFor = recordedOrigin(raw);
    // An id recorded with no network origin binds to one only through setup: a checkout
    // that has an origin may be a fork, and a fork never inherits.
    if (entry && origin && !(recordedFor && sameOrigin(recordedFor, origin))) {
      conflicts.push(recordedFor
        ? `repo id ${id} was recorded for ${recordedFor}, but this checkout's origin is ${origin}`
        : `repo id ${id} was recorded for a checkout without a network origin, but this checkout's origin is ${origin}; re-run hunch private/shared here with the recorded overlay to bind it`);
    } else if (entry) candidates.push({ key: ID_KEY_PREFIX + id, entry });
  }
  if (origin) {
    const exact = liveEntry(repos[origin]);
    candidates.push(...(exact ? [{ key: origin, entry: exact }] : Object.keys(repos)
      .filter((key) => !key.startsWith(ID_KEY_PREFIX) && sameOrigin(key, origin))
      .flatMap((key) => { const entry = liveEntry(repos[key]); return entry ? [{ key, entry }] : []; })));
  }
  const first = candidates[0];
  const split = first ? candidates.find((c) => !samePath(c.entry.privateDir, first.entry.privateDir)) : undefined;
  if (first && split) conflicts.push(`profile entries ${first.key} → ${first.entry.privateDir} and ${split.key} → ${split.entry.privateDir} name different overlays; re-run hunch private/shared to choose one`);
  if (!first || split) return conflicts.length ? { entry: null, conflict: conflicts.join("; ") } : { entry: null };
  return { entry: first.entry };
}

/** This machine's profile for `root`'s repository, or null (see resolveRepoProfile). */
export function readRepoProfile(root: string, opts: { commonDir?: string } = {}): RepoProfileEntry | null {
  return resolveRepoProfile(root, opts).entry;
}

/** The profile keys that name `root`'s repository: its repo id key (unless another
 *  origin owns it) and every variant of its origin. */
function ownedKeys(repos: Record<string, unknown>, origin: string, id: string, privateDir?: string): string[] {
  return Object.keys(repos).filter((key) => key.startsWith(ID_KEY_PREFIX)
    ? !!id && key === ID_KEY_PREFIX + id && (privateDir === undefined ? mayForgetId(repos[key], origin) : mayClaimId(repos[key], origin, privateDir))
    : !!origin && sameOrigin(key, origin));
}

/** Why setup with `privateDir` could not record `root`'s repo id (see mayClaimId). "" when it can. */
export function repoIdClaimConflict(root: string, privateDir?: string): string {
  const id = repoIdOf(root);
  if (!id) return "";
  const origin = repoProfileKey(root);
  const raw = (readProfiles(repoProfileFile())?.repos as Record<string, unknown> | undefined)?.[ID_KEY_PREFIX + id];
  if (mayClaimId(raw, origin, privateDir)) return "";
  const recordedFor = recordedOrigin(raw);
  const recordedDir = (raw as { privateDir: string }).privateDir;
  // Refused with no origin only when the id is bound to one (see mayClaimId).
  if (!origin) {
    // Setup still wrote this checkout's local pointer, and the pointer wins over the profile.
    return `repo_id ${id} is bound to ${recordedFor} with overlay ${recordedDir}, so nothing was recorded in the machine profile; ` +
      `this checkout (no network origin) uses ${privateDir ?? "the new overlay"} through its local pointer, but a fresh clone without a network origin resolves ${recordedDir} through the id. ` +
      `Change the overlay from a checkout of ${recordedFor}, or remove repo_id from .hunch/config.json and re-run hunch private/shared to give this checkout its own id`;
  }
  const owner = recordedFor ? `for ${recordedFor}` : "for a checkout without a network origin";
  return `repo_id ${id} is already recorded ${owner} with overlay ${recordedDir}, and this checkout (${origin}) may be a fork or a copy, so the entry was left alone and it is found by its origin only. ` +
    "Re-run setup with the recorded overlay, or remove repo_id from .hunch/config.json and re-run hunch private/shared to give this checkout its own id";
}

/** Why `forget` could not drop `root`'s repo id entry (see mayForgetId). "" when it can. */
export function repoIdForgetConflict(root: string): string {
  const id = repoIdOf(root);
  if (!id) return "";
  const raw = (readProfiles(repoProfileFile())?.repos as Record<string, unknown> | undefined)?.[ID_KEY_PREFIX + id];
  if (mayForgetId(raw, repoProfileKey(root))) return "";
  const recordedFor = recordedOrigin(raw);
  return recordedFor
    ? `the entry for repo_id ${id} is bound to ${recordedFor}; forget it from a checkout of ${recordedFor}`
    : `the entry for repo_id ${id} was recorded for a checkout without a network origin; forget it from such a checkout, or remove repo_id from .hunch/config.json here`;
}

/** Record `root`'s overlay setup under its origin and its committed repo id. The origin
 *  entry keeps today's key (older Hunch builds read it); its other case variants are
 *  dropped so one repository has one entry. Neither identity → no-op (false). */
export function writeRepoProfile(root: string, entry: Omit<RepoProfileEntry, "updated_at"> & { updated_at?: string }): boolean {
  const origin = repoProfileKey(root);
  const id = repoIdOf(root);
  if (!origin && !id) return false;
  if (!isAbsolute(entry.privateDir)) throw new Error(`refusing to record a non-absolute overlay path in the repo profile: ${entry.privateDir}`);
  const file = repoProfileFile();
  const current = readProfiles(file);
  if (!current) throw new Error(`refusing to overwrite unreadable repo profile file: ${file}`);
  const repos = current.repos as Record<string, unknown>;
  const idKey = ID_KEY_PREFIX + id;
  const prior = repos[idKey];
  // An invalid entry holds nothing (mayClaimId), its origin included.
  const boundOrigin = validEntry(prior) ? recordedOrigin(prior) : "";
  const claimId = !!id && mayClaimId(repos[idKey], origin, entry.privateDir);
  // No origin and the id is not ours to rewrite: there is nothing this checkout can record.
  if (!origin && !claimId) return false;
  for (const key of ownedKeys(repos, origin, id, entry.privateDir)) delete repos[key];
  const record: RepoProfileEntry = {
    privateDir: entry.privateDir,
    mode: entry.mode,
    autoCommit: entry.autoCommit,
    updated_at: entry.updated_at ?? new Date().toISOString(),
  };
  if (origin) repos[origin] = record;
  // A clone with no network origin keeps the origin the id was bound to.
  // Across the origin gap a claim is only a rebind to the recorded overlay (mayClaimId).
  // From no origin it keeps the recorded mode and autoCommit, so a local copy cannot change
  // the owner's. From an origin it binds the id, which then records what its origin entry does.
  if (claimId) repos[idKey] = !origin && validEntry(prior) && boundOrigin
    ? { ...record, privateDir: prior.privateDir, mode: prior.mode, autoCommit: prior.autoCommit, origin: boundOrigin }
    : { ...record, origin: origin || boundOrigin };
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(current, null, 2) + "\n");
  return true;
}

/** Drop `root`'s repository from this machine's profile (`hunch memory-policy forget`): its
 *  repo id entry and every case variant of its origin. A fresh clone then opens without the
 *  overlay until one is set up again. False when there was no entry to drop. */
export function removeRepoProfile(root: string): boolean {
  const origin = repoProfileKey(root);
  const id = repoIdOf(root);
  if (!origin && !id) return false;
  const file = repoProfileFile();
  const current = readProfiles(file);
  if (!current) throw new Error(`refusing to overwrite unreadable repo profile file: ${file}`);
  const repos = current.repos as Record<string, unknown>;
  const keys = ownedKeys(repos, origin, id);
  if (!keys.length) return false;
  for (const key of keys) delete repos[key];
  writeFileAtomic(file, JSON.stringify(current, null, 2) + "\n");
  return true;
}

/** Setup-path wrapper: a profile that cannot be written (a malformed profile file, an
 *  unwritable config dir) is a stderr warning, never a setup failure. */
export function writeRepoProfileOrWarn(root: string, entry: Omit<RepoProfileEntry, "updated_at">): void {
  try {
    writeRepoProfile(root, entry);
    const unclaimed = repoIdClaimConflict(root, entry.privateDir);
    if (unclaimed) console.error(`⚠ ${unclaimed}`);
  } catch (error) {
    console.error(`⚠ could not record this overlay in the machine profile (${repoProfileFile()}): ${(error as Error).message}. A fresh clone will not restore it; this setup is unaffected.`);
  }
}
