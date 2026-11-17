/** Locked design artifacts: a human-approved HLD, diagram or ADR is immutable for agents.
 *
 * Approving a document is a human act; an agent quietly rewriting it afterwards
 * would launder its own change into "approved design". So once a person locks a
 * file, its exact bytes are bound to that approval (sha256) in the committed
 * registry `.hunch/locks.json`, and every route an agent can write through is
 * checked deterministically against it:
 *   - Edit/Write/MultiEdit/apply_patch on a locked file (or on the registry) is denied
 *     before it lands (hook PreToolUse);
 *   - a shell command that changed a locked file, or removed/changed a lock, is caught
 *     right after it ran (PostToolUse), and again at the end of the turn (Stop);
 *   - `hunch locks --check` fails CI / pre-commit on any locked file whose bytes no
 *     longer match their approval.
 * No model judgment is involved anywhere: a byte comparison decides.
 *
 * Changing a locked file is a human decision made in a terminal (`hunch lock` to
 * approve new bytes, `hunch unlock` to release it); those commands refuse to run
 * without an interactive TTY, so an agent's shell cannot approve its own change. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./io.js";
import { HUNCH_DIR, safeRepoScope } from "./paths.js";

export const LOCKS_FILE = `${HUNCH_DIR}/locks.json`;
export const LOCK_KINDS = ["hld", "diagram", "adr", "doc"] as const;
export type LockKind = (typeof LOCK_KINDS)[number];

const SHA = /^sha256:[a-f0-9]{64}$/;
const LockSchema = z.object({
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(SHA),
  kind: z.enum(LOCK_KINDS),
  approved_by: z.string().min(1).max(128),
  approved_at: z.string().min(1).max(64),
  note: z.string().max(500).optional(),
}).strict();
const RegistrySchema = z.object({ version: z.literal(1), locks: z.array(LockSchema) }).strict();

export type Lock = z.infer<typeof LockSchema>;
export interface Registry { locks: Lock[]; corrupt: boolean }

const KIND_LABEL: Record<LockKind, string> = { hld: "HLD", diagram: "diagram", adr: "ADR", doc: "document" };
const MAX_LOCKED_BYTES = 8_000_000;

function parseRegistry(text: string): Lock[] | null {
  try {
    const parsed = RegistrySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.locks : null;
  } catch {
    return null;
  }
}

/** The committed registry. Missing → no locks. Unparseable → `corrupt` (callers treat
 *  that as tampering, never as "nothing is locked"). */
export function readLocks(root: string): Registry {
  const file = join(root, LOCKS_FILE);
  if (!existsSync(file)) return { locks: [], corrupt: false };
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return { locks: [], corrupt: true }; }
  const locks = parseRegistry(text);
  return locks ? { locks, corrupt: false } : { locks: [], corrupt: true };
}

export function writeLocks(root: string, locks: Lock[]): void {
  const sorted = [...locks].sort((a, b) => a.path.localeCompare(b.path));
  mkdirSync(dirname(join(root, LOCKS_FILE)), { recursive: true });
  writeFileAtomic(join(root, LOCKS_FILE), JSON.stringify({ version: 1, locks: sorted }, null, 2) + "\n");
}

/** sha256 of a repo file's exact bytes, or null when it is missing / not a file / too large. */
export function fileSha(root: string, rel: string): string | null {
  try {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_LOCKED_BYTES) return null;
    return `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
  } catch {
    return null;
  }
}

/** A repo-relative file path safe to lock, or null (absolute, escaping, globs, Hunch's own
 *  state). The one exception under .hunch/ is an approved HLD draft (`.hunch/hld/*.json`):
 *  its answers are part of what the human approved. */
export function lockablePath(rel: string): string | null {
  const p = safeRepoScope(rel);
  if (!p || /[*?[\]{}]/.test(p)) return null;
  if (p.startsWith(`${HUNCH_DIR}/`) && !/^\.hunch\/hld\/[^/]+\.json$/.test(p)) return null;
  return p;
}

export function lockFor(locks: readonly Lock[], target: string): Lock | undefined {
  const p = safeRepoScope(target);
  return p ? locks.find((l) => l.path === p) : undefined;
}

export function isRegistryPath(target: string): boolean {
  return safeRepoScope(target) === LOCKS_FILE;
}

export interface LockProblem {
  kind: "modified" | "missing" | "removed" | "registry";
  path: string;
  lock?: Lock;
}

/** Locks as committed at HEAD, or null when there is no HEAD / no committed registry. */
function headLocks(root: string): Lock[] | null {
  try {
    const text = execFileSync("git", ["-C", root, "show", `HEAD:${LOCKS_FILE}`], {
      encoding: "utf8", timeout: 3_000, maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return parseRegistry(text);
  } catch {
    return null;
  }
}

/** Every way the working tree disagrees with the approved locks. `sinceHead` also reports
 *  committed locks that were removed or re-pointed in the working tree (registry tampering);
 *  a human who unlocks in a terminal commits that change before handing work back. */
export function verifyLocks(root: string, opts: { sinceHead?: boolean } = {}): LockProblem[] {
  const reg = readLocks(root);
  const problems: LockProblem[] = [];
  if (reg.corrupt) problems.push({ kind: "registry", path: LOCKS_FILE });
  for (const lock of reg.locks) {
    const sha = fileSha(root, lock.path);
    if (sha === null) problems.push({ kind: "missing", path: lock.path, lock });
    else if (sha !== lock.sha256) problems.push({ kind: "modified", path: lock.path, lock });
  }
  if (opts.sinceHead) {
    for (const was of headLocks(root) ?? []) {
      const now = reg.locks.find((l) => l.path === was.path);
      if (!now || now.sha256 !== was.sha256) {
        if (!problems.some((p) => p.path === was.path)) problems.push({ kind: "removed", path: was.path, lock: was });
      }
    }
  }
  return problems;
}

function describe(lock: Lock): string {
  return `${lock.path} is a locked ${KIND_LABEL[lock.kind]}, approved by ${lock.approved_by} on ${lock.approved_at.slice(0, 10)}`;
}

/** The reason an agent sees. It says what is locked and what to do; it never coaches a way around. */
export function lockDenyReason(target: string, lock: Lock | undefined): string {
  if (!lock) {
    return `Hunch: ${LOCKS_FILE} is the registry of human-approved locked files; agents never edit it. If a lock needs to change, ask a human.`;
  }
  return `Hunch: ${describe(lock)}. Approved design files are immutable for agents: do not edit, move or delete it. If the design needs to change, describe the change and ask a human to update and re-approve it.`;
}

export function lockProblemReason(problems: readonly LockProblem[], when: "write" | "stop"): string {
  const lines = problems.map((p) => {
    if (p.kind === "registry") return `- ${LOCKS_FILE} is no longer a valid lock registry.`;
    if (p.kind === "removed") return `- the lock on ${p.path} was removed or changed in ${LOCKS_FILE}.`;
    if (p.kind === "missing") return `- ${describe(p.lock!)}, and it was deleted or moved.`;
    return `- ${describe(p.lock!)}, and its contents changed.`;
  });
  const lead = when === "write" ? "Hunch: that command changed human-approved locked files." : "Hunch: the working tree changes human-approved locked files.";
  return `${lead}\n${lines.join("\n")}\nRestore them exactly as approved (for a committed file: \`git checkout -- <path>\`) before continuing. Only a human may change or unlock an approved design file.`;
}

/** Add or re-approve a lock for a file's current bytes. Returns the previous lock when one existed. */
export function setLock(root: string, rel: string, input: { kind: LockKind; approvedBy: string; note?: string; at?: string; expectSha?: string }): { lock: Lock; previous: Lock | null } {
  const path = lockablePath(rel);
  if (!path) throw new Error(`cannot lock ${rel}: give a repo-relative file path outside ${HUNCH_DIR}/`);
  const sha = fileSha(root, path);
  if (!sha) throw new Error(`cannot lock ${path}: not a readable file (or larger than ${MAX_LOCKED_BYTES} bytes)`);
  // the caller showed the human specific bytes; lock exactly those or nothing
  if (input.expectSha && sha !== input.expectSha) throw new Error(`cannot lock ${path}: it changed after it was reviewed; review it again`);
  const approvedBy = input.approvedBy.trim();
  if (!approvedBy || approvedBy.length > 128 || /[\r\n]/.test(approvedBy)) throw new Error("--reviewed-by must be a 1-128 character name");
  const reg = readLocks(root);
  if (reg.corrupt) throw new Error(`${LOCKS_FILE} is not a valid lock registry; restore it from git first`);
  const previous = reg.locks.find((l) => l.path === path) ?? null;
  const lock: Lock = { path, sha256: sha, kind: input.kind, approved_by: approvedBy, approved_at: input.at ?? new Date().toISOString(), ...(input.note ? { note: input.note } : {}) };
  writeLocks(root, [...reg.locks.filter((l) => l.path !== path), lock]);
  return { lock, previous };
}

export function removeLock(root: string, rel: string): Lock | null {
  const path = safeRepoScope(rel);
  const reg = readLocks(root);
  if (reg.corrupt) throw new Error(`${LOCKS_FILE} is not a valid lock registry; restore it from git first`);
  const lock = path ? reg.locks.find((l) => l.path === path) ?? null : null;
  if (lock) writeLocks(root, reg.locks.filter((l) => l.path !== lock.path));
  return lock;
}
