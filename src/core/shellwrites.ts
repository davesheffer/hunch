/** Files a shell command wrote.
 *
 * Pre-edit grounding keys on the host's edit tools (Edit/Write/apply_patch).
 * An agent that edits through the shell — a `python` heredoc, `sed -i`, `perl
 * -pi`, a PowerShell `Set-Content` — never passes through them, so the file it
 * changed arrives with no grounding at all. The shell tool's post-execution
 * hook sees every command, but not what the command touched; parsing arbitrary
 * shell for write targets is guesswork.
 *
 * Instead: fingerprint the working tree's dirty files (`git status`, then
 * mtime+size) per session, repository and agent. A prompt and every tool call refresh
 * the fingerprint; after a shell command, a dirty file whose fingerprint moved
 * was written by that command. Deterministic, shell-agnostic, and bounded by the
 * dirty set (never a tree walk). Any failure yields no files — never an error. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { memoized } from "./hookMemo.js";

/** Dirty paths fingerprinted; beyond it the rest are ignored (a vendored
 *  untracked tree must not make every command slow). */
const MAX_PATHS = 2000;
/** Hunch's own state: written by the hook itself and by capture tools. */
const OWN_STATE = /^\.hunch(?:-cache)?\//;

type Fingerprints = Record<string, string>;

/** Concurrent subagents share the session but not their commands: each keeps
 *  its own baseline, keyed by its agent id (hashed with the rest, never kept
 *  raw) like the pre-edit dedupe. No agent id keeps the session's baseline. */
function snapshotFile(root: string, sessionId: string, agentId?: string): string {
  const key = observerKey(root, sessionId, agentId);
  // Same directory as the session injection cache: its sweep drops stale files.
  return join(tmpdir(), "hunch-hookcache", `shell-${key}.json`);
}

/** Repo-relative dirty paths (tracked changes and untracked files), NUL-safe. */
function dirtyPaths(root: string): string[] | null {
  let raw: string;
  try {
    raw = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 8_000_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return null;
  }
  // Porcelain paths are relative to the git toplevel, which can sit above the
  // Hunch root (a package inside a monorepo): re-relativize, drop the outside.
  let prefix = "";
  // A `.git` entry at the root makes it the toplevel (no prefix to ask git for),
  // unless the environment redirects git elsewhere.
  const redirected = !!(process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_PREFIX);
  if (!redirected && isGitToplevel(root)) { /* toplevel: prefix stays empty */ } else try {
    prefix = execFileSync("git", ["-C", root, "rev-parse", "--show-prefix"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  const out: string[] = [];
  const fields = raw.split("\u0000");
  for (let i = 0; i < fields.length && out.length < MAX_PATHS; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.startsWith(prefix)) out.push(path.slice(prefix.length));
    // A rename/copy entry is followed by its source path.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return out;
}

/** One working-tree fingerprint per hook invocation and root: the prompt hook
 *  refreshes a session baseline and then an agent's, from the same tree. */
function fingerprint(root: string): Fingerprints | null {
  const fp = memoized("shell-fingerprint", root, "", () => takeFingerprint(root));
  return fp ? { ...fp } : null;
}

function takeFingerprint(root: string): Fingerprints | null {
  const paths = dirtyPaths(root);
  if (!paths) return null;
  const fp: Fingerprints = {};
  for (const p of paths) {
    if (OWN_STATE.test(p)) continue;
    try {
      const st = statSync(join(root, p));
      if (st.isFile()) fp[p] = `${st.mtimeMs}:${st.size}`;
    } catch { /* deleted: nothing to ground */ }
  }
  return fp;
}

function load(file: string): Fingerprints | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Fingerprints) : null;
  } catch {
    return null;
  }
}

function save(file: string, fp: Fingerprints): void {
  try {
    mkdirSync(join(tmpdir(), "hunch-hookcache"), { recursive: true });
    writeFileSync(file, JSON.stringify(fp));
  } catch { /* the next refresh retries */ }
}

/** Record the working tree as it stands, so later shell writes are measured
 *  from here (a prompt, or any tool call that is not a shell command). */
/** A `.git` entry git itself would accept at `root`: a directory holding HEAD, or
 *  a `gitdir:` file. A stray or empty `.git` dir is skipped by git's discovery,
 *  which then walks up, so it must not be taken as the toplevel. */
function isGitToplevel(root: string): boolean {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return existsSync(join(dotGit, "HEAD"));
    return readFileSync(dotGit, "utf8").startsWith("gitdir:");
  } catch {
    return false;
  }
}

/** Who wrote what, across sessions. Baselines are per session and agent, so a
 *  file another session (or a concurrent subagent) edits while this session's
 *  shell command runs looks like that command's write. Each observer records the
 *  fingerprint of the files its edit tools wrote; a written file whose current
 *  fingerprint is another observer's claim is left out of the "this command
 *  wrote" grounding (claimedByOthers). It is never left out of enforcement: the
 *  command may have written the file before the other edit landed. Only edit
 *  tools claim, since their author is certain; a shell result never does.
 *  Best effort: a lost or missing claim grounds the file as before. */
const CLAIM_TTL_MS = 60 * 60_000;
const MAX_CLAIMS = 500;

type Claim = { fp: string; by: string; at: number };
type Claims = Record<string, Claim>;

function observerKey(root: string, sessionId: string, agentId?: string): string {
  return createHash("sha256").update(`${sessionId}\u0000${root}${agentId ? `\u0000${agentId}` : ""}`).digest("hex").slice(0, 24);
}

/** Sessions that spell the same root differently (a lower-case Windows drive;
 *  lowered everywhere, so no platform branch: a case-only clash is harmless)
 *  must meet in one claims file, and one observer must stay one owner. */
function normRoot(root: string): string {
  return resolve(root).toLowerCase();
}

function claimOwner(root: string, sessionId: string, agentId?: string): string {
  return observerKey(normRoot(root), sessionId, agentId);
}

/** One claims file per repository, shared by every session. */
function claimsFile(root: string): string {
  const key = createHash("sha256").update(normRoot(root)).digest("hex").slice(0, 24);
  return join(tmpdir(), "hunch-hookcache", `claims-${key}.json`);
}

function loadClaims(root: string): Claims {
  try {
    const raw = JSON.parse(readFileSync(claimsFile(root), "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Claims) : {};
  } catch {
    return {};
  }
}

function addClaims(root: string, by: string, entries: Fingerprints): void {
  const paths = Object.keys(entries);
  if (!paths.length) return;
  const now = Date.now();
  const claims = loadClaims(root);
  for (const p of paths) claims[p] = { fp: entries[p]!, by, at: now };
  const kept = Object.entries(claims)
    .filter(([, c]) => c && typeof c.at === "number" && now - c.at < CLAIM_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_CLAIMS);
  const file = claimsFile(root);
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  try {
    mkdirSync(join(tmpdir(), "hunch-hookcache"), { recursive: true });
    // Temp file + rename: a concurrent reader never sees a half-written file.
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

function fileFingerprint(root: string, p: string): string | null {
  try {
    const st = statSync(join(root, p));
    return st.isFile() ? `${st.mtimeMs}:${st.size}` : null;
  } catch {
    return null;
  }
}

export function refreshShellBaseline(root: string, sessionId: string | undefined, agentId?: string): void {
  if (!sessionId) return;
  const fp = fingerprint(root);
  if (fp) save(snapshotFile(root, sessionId, agentId), fp);
}

/** Repo-relative files the shell command that just ran wrote (created or
 *  modified), and the baseline moves forward. Empty without a baseline: a
 *  session's first observation cannot tell its own writes from earlier ones. */
export function shellWrittenFiles(root: string, sessionId: string | undefined, agentId?: string): string[] {
  if (!sessionId) return [];
  const file = snapshotFile(root, sessionId, agentId);
  const before = load(file);
  const now = fingerprint(root);
  if (!now) return [];
  save(file, now);
  if (!before) return [];
  return Object.keys(now).filter((p) => before[p] !== now[p]).sort();
}

/** Of `files` (a command's writes), those whose current fingerprint is another
 *  observer's edit-tool claim: most likely that observer's edit, so the hook
 *  does not tell this agent "this shell command wrote" them. Attribution only:
 *  the shell Veto, the invariant check and the Stop gate still judge every
 *  written file, since a claim cannot prove the command did not also write the
 *  file before the other edit landed. */
export function claimedByOthers(root: string, sessionId: string | undefined, agentId: string | undefined, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!sessionId || !files.length) return out;
  const me = claimOwner(root, sessionId, agentId);
  const claims = loadClaims(root);
  for (const p of files) {
    const c = claims[p];
    if (c && c.by !== me && Date.now() - c.at < CLAIM_TTL_MS && c.fp === fileFingerprint(root, p)) out.add(p);
  }
  return out;
}

/** After an edit tool wrote `files` (repo-relative), move just those entries of
 *  the baseline instead of re-reading the whole tree. With no baseline yet the
 *  full refresh runs, so the first observation is the same as before. */
export function noteEditedFiles(root: string, sessionId: string | undefined, agentId: string | undefined, files: readonly string[], claim = true): void {
  if (!sessionId) return;
  const file = snapshotFile(root, sessionId, agentId);
  const edited: Fingerprints = {};
  for (const p of files) {
    if (OWN_STATE.test(p)) continue;
    const fp = fileFingerprint(root, p);
    if (fp) edited[p] = fp;
  }
  // A failed edit wrote nothing: what is on disk is someone else's.
  // Own try: a claim failure must never stop the baseline move below.
  if (claim) try { addClaims(root, claimOwner(root, sessionId, agentId), edited); } catch { /* ground as before */ }
  const baseline = load(file);
  if (!baseline || !files.length) { refreshShellBaseline(root, sessionId, agentId); return; }
  for (const p of files) {
    if (OWN_STATE.test(p)) continue;
    if (edited[p]) baseline[p] = edited[p]!; else delete baseline[p];
  }
  save(file, baseline);
}
