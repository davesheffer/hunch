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
import { dirname, isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./io.js";
import { machineFile } from "./machine.js";
import { checkoutCommonDir } from "../extractors/git.js";

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

/** This machine's profile for `root`'s origin, or null. A dead overlay dir reads as no
 *  profile: opening a store must never invent a directory. */
export function readRepoProfile(root: string, opts: { commonDir?: string } = {}): RepoProfileEntry | null {
  const key = repoProfileKey(root, opts.commonDir);
  if (!key) return null;
  const entry = readProfiles(repoProfileFile())?.repos[key];
  if (!validEntry(entry)) return null;
  try {
    if (!statSync(entry.privateDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { privateDir: entry.privateDir, mode: entry.mode, autoCommit: entry.autoCommit, updated_at: typeof entry.updated_at === "string" ? entry.updated_at : "" };
}

/** Record `root`'s overlay setup for its origin. No origin → no-op (false). */
export function writeRepoProfile(root: string, entry: Omit<RepoProfileEntry, "updated_at"> & { updated_at?: string }): boolean {
  const key = repoProfileKey(root);
  if (!key) return false;
  if (!isAbsolute(entry.privateDir)) throw new Error(`refusing to record a non-absolute overlay path in the repo profile: ${entry.privateDir}`);
  const file = repoProfileFile();
  const current = readProfiles(file);
  if (!current) throw new Error(`refusing to overwrite unreadable repo profile file: ${file}`);
  current.repos[key] = {
    privateDir: entry.privateDir,
    mode: entry.mode,
    autoCommit: entry.autoCommit,
    updated_at: entry.updated_at ?? new Date().toISOString(),
  };
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(current, null, 2) + "\n");
  return true;
}

/** Drop `root`'s origin from this machine's profile (`hunch memory-policy forget`): a fresh
 *  clone then opens without the overlay until one is set up again. False when there was
 *  no entry to drop. */
export function removeRepoProfile(root: string): boolean {
  const key = repoProfileKey(root);
  if (!key) return false;
  const file = repoProfileFile();
  const current = readProfiles(file);
  if (!current) throw new Error(`refusing to overwrite unreadable repo profile file: ${file}`);
  if (!(key in current.repos)) return false;
  delete current.repos[key];
  writeFileAtomic(file, JSON.stringify(current, null, 2) + "\n");
  return true;
}

/** Setup-path wrapper: a profile that cannot be written (a malformed profile file, an
 *  unwritable config dir) is a stderr warning, never a setup failure. */
export function writeRepoProfileOrWarn(root: string, entry: Omit<RepoProfileEntry, "updated_at">): void {
  try {
    writeRepoProfile(root, entry);
  } catch (error) {
    console.error(`⚠ could not record this overlay in the machine profile (${repoProfileFile()}): ${(error as Error).message}. A fresh clone will not restore it; this setup is unaffected.`);
  }
}
