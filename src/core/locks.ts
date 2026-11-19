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
 * Accepted gaps (judged against HEAD like the base; none is a regression):
 *   (a) forging the registry, rewriting the file AND committing, all inside one command, is
 *       not detected by the hooks; review `.hunch/locks.json` diffs in PR / CI;
 *   (b) `git checkout -- .` / `git reset --hard` discarding a human's UNCOMMITTED lock is not
 *       detected: commit locks before handing work back;
 *   (c) the per-command snapshot and the pipeline state live in the temp dir, so an agent's
 *       shell could tamper with them.
 *
 * Changing a locked file is a human decision made in a terminal (`hunch lock` to
 * approve new bytes, `hunch unlock` to release it); those commands refuse to run
 * without an interactive TTY, so an agent's shell cannot approve its own change. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./io.js";
import { HUNCH_DIR, realpathNorm, safeRepoScope } from "./paths.js";

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

/** sha256 of bytes, EOL-stable: text (no NUL byte) hashes with CRLF folded to LF, so a
 *  Git-for-Windows autocrlf checkout of an approved file still matches; binary hashes raw. */
function contentSha(buf: Buffer): string {
  const data = buf.includes(0) ? buf : Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** EOL-normalized sha256 of a repo file, or null when it is missing / not a file / too large. */
export function fileSha(root: string, rel: string): string | null {
  try {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_LOCKED_BYTES) return null;
    return contentSha(readFileSync(abs));
  } catch {
    return null;
  }
}

/** A repo-relative file path safe to lock, or null (absolute, escaping, globs, Hunch's own state). */
export function lockablePath(rel: string): string | null {
  const p = safeRepoScope(rel);
  if (!p || /[*?[\]{}]/.test(p) || p.startsWith(`${HUNCH_DIR}/`)) return null;
  return p;
}

/** `target` (relative to root, or absolute) as a canonical repo-relative posix path, or null outside the repo. */
export function canonicalTarget(root: string, target: string): string | null {
  try {
    const abs = resolve(root, target);
    const rel = relative(realpathNorm(resolve(root)), realpathNorm(abs)).replace(/\\/g, "/");
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
    return rel;
  } catch {
    return null;
  }
}

const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";
function samePath(a: string, b: string): boolean {
  return FOLD_CASE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function lockFor(root: string, locks: readonly Lock[], target: string): Lock | undefined {
  const p = canonicalTarget(root, target);
  return p ? locks.find((l) => samePath(l.path, p)) : undefined;
}

export function isRegistryPath(root: string, target: string): boolean {
  const p = canonicalTarget(root, target);
  return !!p && samePath(p, LOCKS_FILE);
}

export interface LockProblem {
  kind: "modified" | "missing" | "removed" | "registry";
  path: string;
  lock?: Lock;
}

/** Locks as committed at HEAD, or null when there is no HEAD / no committed registry.
 *  `HEAD:./path` resolves against cwd, so a Hunch root nested in a larger repo works. */
export function headLocks(root: string): Lock[] | null {
  const r = readHeadLocks(root);
  return r.status === "ok" ? r.locks : null;
}

/** git's answer when there is simply no committed registry (no HEAD, path not in HEAD, not a repo). */
const NO_HEAD_ENTRY = /does not exist|exists on disk, but not in|invalid object name|bad revision|unknown revision|not a git repository|bad object/i;

/** The committed registry, distinguishing "none committed" from a git read that failed
 *  (timeout, spawn error, anything else): callers fail open on `failed`, never toward blame. */
export function readHeadLocks(root: string): { status: "ok" | "none" | "failed"; locks: Lock[] } {
  try {
    const text = execFileSync("git", ["show", `HEAD:./${LOCKS_FILE}`], {
      cwd: root,
      encoding: "utf8", timeout: 3_000, maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    const locks = parseRegistry(text);
    return locks ? { status: "ok", locks } : { status: "none", locks: [] };
  } catch (e) {
    const err = e as { status?: number | null; stderr?: unknown; signal?: unknown };
    const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : "";
    if (typeof err.status === "number" && !err.signal && NO_HEAD_ENTRY.test(stderr)) return { status: "none", locks: [] };
    return { status: "failed", locks: [] };
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

/** A lock baseline: the parsed registry and the content hash of every locked file, taken
 *  before a shell command (per agent) and at turn start. Content, never problem keys, so a
 *  file that was already drifted and changes again is still seen. */
export interface LockSnapshot {
  v: 2;
  /** realpathNorm(root): a snapshot only ever measures the checkout it was taken in. */
  root: string;
  registry: "absent" | "corrupt" | "ok";
  /** Parsed registry locks sorted by path; [] unless `ok`. */
  locks: Lock[];
  /** Lock path → its content sha at snapshot time (null: missing). */
  files: Record<string, string | null>;
  /** Committed locks the working registry had already removed/re-pointed at snapshot time, as
   *  `path|sha-or-none|kind`: not re-blamed, but any further change gets a new key. */
  headDiff: string[];
  /** Paths whose lock equalled HEAD's at snapshot time: such a lock stays authoritative only
   *  while HEAD still carries it (a checkout/pull that drops it is not the agent's change). */
  committed: string[];
}

const byPath = (a: Lock, b: Lock): number => a.path.localeCompare(b.path);

/** Committed locks the working registry removed or re-pointed (sha/kind), each with its key. */
function headDiffOf(head: readonly Lock[] | null, locks: readonly Lock[]): Array<{ was: Lock; key: string }> {
  const out: Array<{ was: Lock; key: string }> = [];
  for (const was of head ?? []) {
    const now = locks.find((l) => l.path === was.path);
    if (!now || now.sha256 !== was.sha256 || now.kind !== was.kind) out.push({ was, key: `${was.path}|${now ? `${now.sha256}|${now.kind}` : "none"}` });
  }
  return out;
}

function fileHashes(root: string, locks: readonly Lock[]): Record<string, string | null> {
  const files: Record<string, string | null> = {};
  for (const l of locks) files[l.path] = fileSha(root, l.path);
  return files;
}

function registryState(root: string): { state: LockSnapshot["registry"]; locks: Lock[] } {
  if (!existsSync(join(root, LOCKS_FILE))) return { state: "absent", locks: [] };
  const reg = readLocks(root);
  return reg.corrupt ? { state: "corrupt", locks: [] } : { state: "ok", locks: [...reg.locks].sort(byPath) };
}

/** Cheap: an absent registry costs one existsSync; git is consulted only when one exists. */
export function lockSnapshot(root: string): LockSnapshot {
  const { state, locks } = registryState(root);
  const hr = state === "absent" ? null : readHeadLocks(root);
  const head = hr?.status === "ok" ? hr.locks : null;
  const files = state === "ok" ? fileHashes(root, locks) : state === "corrupt" ? fileHashes(root, head ?? []) : {};
  const headDiff = state === "ok" ? headDiffOf(head, locks).map((d) => d.key) : [];
  const committed = locks.filter((l) => head?.some((h) => h.path === l.path && h.sha256 === l.sha256 && h.kind === l.kind)).map((l) => l.path);
  return { v: 2, root: realpathNorm(resolve(root)), registry: state, locks, files, headDiff, committed };
}

/** `snap` when it was taken in this checkout, else null (a linked worktree's events never
 *  measure against another checkout's baseline). */
export function snapshotForRoot(root: string, snap: LockSnapshot | null | undefined): LockSnapshot | null {
  try {
    return snap && snap.root === realpathNorm(resolve(root)) ? snap : null;
  } catch {
    return null;
  }
}

/** What changed since `before`, judged like `verifyLocks(sinceHead)` but only for what is new:
 *  - a committed lock the working registry removed or re-pointed ("removed"), unless that very
 *    state was already there at `before` (a human's uncommitted re-lock);
 *  - a registry that became corrupt since `before` ("registry");
 *  - a locked file whose content moved since `before` and is not an approved sha (the
 *    snapshot's lock, the current registry's entry when it equals HEAD's, HEAD's).
 *  A pull / merge / checkout that brings a teammate's lock and file therefore blames nobody, and
 *  untouched pre-existing drift stays the human's. Git is spawned only when a registry exists
 *  now or existed at `before`. */
export function lockChangesSince(root: string, before: LockSnapshot): LockProblem[] {
  const out: LockProblem[] = [];
  const cur = registryState(root);
  if (cur.state === "corrupt" && before.registry !== "corrupt") out.push({ kind: "registry", path: LOCKS_FILE });
  if (cur.state === "absent" && before.registry === "absent") return out;
  const hr = readHeadLocks(root);
  const failed = hr.status === "failed";
  const head = hr.status === "ok" ? hr.locks : null;
  if (cur.state !== "corrupt" && !failed) {
    const seen = new Set(before.headDiff);
    for (const d of headDiffOf(head, cur.locks)) {
      if (!seen.has(d.key)) out.push({ kind: "removed", path: d.was.path, lock: d.was });
    }
  }
  // A failed HEAD read fails open (as before locks.ts tracked HEAD): the registry counts as approved.
  const sameAsHead = (l: Lock): boolean => failed || !!head?.some((h) => h.path === l.path && h.sha256 === l.sha256);
  const committed = new Set(before.committed);
  const stillCarried = (path: string): boolean => failed ? cur.locks.some((l) => l.path === path) : !!head?.some((h) => h.path === path);
  const authority = new Map<string, Lock>();
  if (cur.state !== "ok") for (const l of head ?? []) authority.set(l.path, l);
  for (const l of cur.locks) if (sameAsHead(l)) authority.set(l.path, l);
  for (const l of before.locks) if (!committed.has(l.path) || stillCarried(l.path)) authority.set(l.path, l);
  for (const [path, lock] of authority) {
    const sha = fileSha(root, path);
    if (Object.prototype.hasOwnProperty.call(before.files, path) && before.files[path] === sha) continue;
    const approved = new Set<string>();
    for (const l of before.locks) if (l.path === path) approved.add(l.sha256);
    for (const l of cur.locks) if (l.path === path && sameAsHead(l)) approved.add(l.sha256);
    for (const l of head ?? []) if (l.path === path) approved.add(l.sha256);
    if (sha !== null && approved.has(sha)) continue;
    out.push({ kind: sha === null ? "missing" : "modified", path, lock });
  }
  return out;
}

/** Paths the hooks already blamed on the agent: those that still disagree with HEAD's approval
 *  (or with the uncommitted lock the registry holds for them) however many turns later. Git is
 *  spawned only when there is something to re-check. */
export function lockStillBad(root: string, paths: readonly string[]): LockProblem[] {
  if (!paths.length) return [];
  const out: LockProblem[] = [];
  const cur = registryState(root);
  const hr = readHeadLocks(root);
  const failed = hr.status === "failed";
  const head = hr.status === "ok" ? hr.locks : null;
  for (const path of paths) {
    if (path === LOCKS_FILE) {
      if (cur.state === "corrupt") out.push({ kind: "registry", path });
      continue;
    }
    const h = head?.find((l) => l.path === path);
    const r = cur.locks.find((l) => l.path === path);
    if (h && cur.state !== "corrupt" && !failed && (!r || r.sha256 !== h.sha256 || r.kind !== h.kind)) out.push({ kind: "removed", path, lock: h });
    const lock = r ?? h;
    if (!lock) continue;
    const approved = new Set<string>();
    if (h) approved.add(h.sha256);
    if (r && (failed || !h || r.sha256 === h.sha256)) approved.add(r.sha256);
    const sha = fileSha(root, path);
    if (sha === null || !approved.has(sha)) out.push({ kind: sha === null ? "missing" : "modified", path, lock });
  }
  return out;
}

/** A stored snapshot, or undefined when it is not a well-formed v2 snapshot. */
export function validLockSnapshot(v: unknown): LockSnapshot | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Partial<LockSnapshot>;
  if (o.v !== 2 || typeof o.root !== "string" || !["absent", "corrupt", "ok"].includes(o.registry as string)) return undefined;
  const locks = z.array(LockSchema).safeParse(o.locks);
  if (!locks.success || !o.files || typeof o.files !== "object" || Array.isArray(o.files)) return undefined;
  const files: Record<string, string | null> = {};
  for (const [k, f] of Object.entries(o.files)) {
    if (f !== null && typeof f !== "string") return undefined;
    files[k] = f;
  }
  const headDiff = Array.isArray(o.headDiff) && o.headDiff.every((k) => typeof k === "string") ? o.headDiff : [];
  const committed = Array.isArray(o.committed) && o.committed.every((k) => typeof k === "string") ? o.committed : [];
  return { v: 2, root: o.root, registry: o.registry!, locks: locks.data, files, headDiff, committed };
}

/** The per-command baseline lives in its own scratch file per (session, agent, root), next
 *  to the shell-write baseline (core/shellwrites.ts), so concurrent agents never overwrite
 *  each other's and PreToolUse never loads/saves the pipeline state. */
function lockPreFile(root: string, sessionId: string, agentId?: string): string {
  const key = createHash("sha256").update(`${sessionId}\u0000${agentId ?? "main"}\u0000${realpathNorm(resolve(root))}`).digest("hex").slice(0, 24);
  return join(tmpdir(), "hunch-hookcache", `lockpre-${key}.json`);
}

export function saveLockPre(root: string, sessionId: string, agentId: string | undefined, snap: LockSnapshot): void {
  const file = lockPreFile(root, sessionId, agentId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(snap));
}

/** Read and delete (consume once) this agent's pre-command snapshot; null when none. */
export function takeLockPre(root: string, sessionId: string, agentId: string | undefined): LockSnapshot | null {
  const file = lockPreFile(root, sessionId, agentId);
  let snap: LockSnapshot | undefined;
  try { snap = validLockSnapshot(JSON.parse(readFileSync(file, "utf8"))); } catch { snap = undefined; }
  try { rmSync(file, { force: true }); } catch { /* best effort */ }
  return snap ?? null;
}

function describe(lock: Lock): string {
  return `${lock.path} is a locked ${KIND_LABEL[lock.kind]}, approved by ${lock.approved_by} on ${lock.approved_at.slice(0, 10)}`;
}

/** The reason an agent sees. It says what is locked and what to do; it never coaches a way around. */
export function lockDenyReason(target: string, lock: Lock | undefined, corrupt = false): string {
  if (corrupt && !lock) {
    return `Hunch: ${LOCKS_FILE} is corrupt, so locked files cannot be verified and edits are refused. A human must restore it (\`git checkout -- ${LOCKS_FILE}\`).`;
  }
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
  const files = problems.some((p) => p.kind === "modified" || p.kind === "missing");
  const registry = problems.some((p) => p.kind === "removed" || p.kind === "registry");
  const advice = [
    files ? "Restore the locked files exactly as approved (for a committed file: `git checkout -- <path>`) before continuing." : "",
    registry ? "The lock registry was changed: ask the human; do not try to restore the registry yourself." : "",
  ].filter(Boolean).join(" ");
  return `${lead}\n${lines.join("\n")}\n${advice} Only a human may change or unlock an approved design file.`;
}

/** Add or re-approve a lock for a file's current bytes. Returns the previous lock when one existed. */
export function setLock(root: string, rel: string, input: { kind: LockKind; approvedBy: string; note?: string; at?: string }): { lock: Lock; previous: Lock | null } {
  const path = lockablePath(rel);
  if (!path) throw new Error(`cannot lock ${rel}: give a repo-relative file path outside ${HUNCH_DIR}/`);
  const sha = fileSha(root, path);
  if (!sha) throw new Error(`cannot lock ${path}: not a readable file (or larger than ${MAX_LOCKED_BYTES} bytes)`);
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
