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
 * mtime+size) per session and repository. A prompt and every tool call refresh
 * the fingerprint; after a shell command, a dirty file whose fingerprint moved
 * was written by that command. Deterministic, shell-agnostic, and bounded by the
 * dirty set (never a tree walk). Any failure yields no files — never an error. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Dirty paths fingerprinted; beyond it the rest are ignored (a vendored
 *  untracked tree must not make every command slow). */
const MAX_PATHS = 2000;
/** Hunch's own state: written by the hook itself and by capture tools. */
const OWN_STATE = /^\.hunch(?:-cache)?\//;

type Fingerprints = Record<string, string>;

function snapshotFile(root: string, sessionId: string): string {
  const key = createHash("sha256").update(`${sessionId}\u0000${root}`).digest("hex").slice(0, 24);
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
  try {
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

function fingerprint(root: string): Fingerprints | null {
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
export function refreshShellBaseline(root: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  const fp = fingerprint(root);
  if (fp) save(snapshotFile(root, sessionId), fp);
}

/** Repo-relative files the shell command that just ran wrote (created or
 *  modified), and the baseline moves forward. Empty without a baseline: a
 *  session's first observation cannot tell its own writes from earlier ones. */
export function shellWrittenFiles(root: string, sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  const file = snapshotFile(root, sessionId);
  const before = load(file);
  const now = fingerprint(root);
  if (!now) return [];
  save(file, now);
  if (!before) return [];
  return Object.keys(now).filter((p) => before[p] !== now[p]).sort();
}
