/**
 * Session-scoped injection dedup (roadmap dec_244397d920): the pre-edit hook
 * re-fires on EVERY edit, and re-injecting an identical 10-16KB grounding block
 * 20+ times per session buries the agent's working context under repeats — the
 * cost of being grounded starts competing with the work.
 *
 * Mechanism: per agent session (the hook event carries a provider-normalized session_id), keep
 * a tiny {key → content-hash} map in the OS tmpdir. First injection for a key
 * (or any time the underlying records CHANGE) → "full". Identical repeat →
 * "delta" (the caller emits a one-liner, or nothing).
 *
 * Failure posture inherits con_03a0b94b2e but inverted for safety: the hook
 * must never crash an edit AND dedup must never cost grounding — so on ANY
 * cache error (unwritable tmpdir, corrupt file, missing session id) the answer
 * is "full". Deny decisions are never routed through here: the gate re-checks
 * every edit regardless. Kill switch: HUNCH_HOOK_DEDUP=0.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isFilterableSelectionId } from "./taskSelection.js";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "./io.js";

const MAX_KEYS = 300;
const SWEEP_AGE_MS = 48 * 3600 * 1000;

/** Decide whether this injection should be the FULL grounding block or a delta
 *  one-liner. Records the content hash as a side effect (so the next identical
 *  call dedups). Never throws.
 *
 *  `hashInput` lets a caller dedup on a STABLE PROJECTION of the block instead
 *  of its presentation: some grounding is self-invalidating —
 *  serving it writes delivery receipts, and the next call's wording moves
 *  ("today" → "delivered today") with no record change, so hashing the rendered
 *  text re-sends the full block forever. Callers pass the identity of the
 *  underlying records; omitting it hashes `content`, the original contract. */
export function injectionMode(sessionId: string | undefined, key: string, content: string, hashInput: string = content): "full" | "delta" {
  try {
    if (!sessionId || process.env.HUNCH_HOOK_DEDUP === "0") return "full";
    const dir = hookCacheDir();
    mkdirSync(dir, { recursive: true });
    sweep(dir);
    const file = join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
    let map: Record<string, string>;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      map = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
    } catch {
      map = {};
    }
    if (map[key] === hash) return "delta";
    map[key] = hash;
    const keys = Object.keys(map);
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete map[k];
    writeFileSync(file, JSON.stringify(map));
    return "full";
  } catch {
    return "full"; // grounded beats deduped, always
  }
}

/** Forget everything injected into a session. Compaction summarizes injected
 *  grounding out of the agent's context while the dedup map still says
 *  "delivered" — so on PreCompact / SessionStart[source=compact] the map must
 *  reset, or post-compact edits get delta one-liners against grounding the
 *  agent no longer has. Never throws (same posture as injectionMode). */
export function resetSessionInjections(sessionId: string | undefined): void {
  try {
    if (!sessionId) return;
    const file = join(hookCacheDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
    rmSync(file, { force: true });
  } catch {
    /* unwritable tmpdir — next injectionMode call falls back to "full" anyway */
  }
}

/** The machine-local directory every hook cache lives in (OS tmpdir). */
export function hookCacheDir(): string {
  return join(tmpdir(), "hunch-hookcache");
}

/** A task's prompt-time memory selection (taskSelection.ts): record ids only —
 *  never the prompt text it was scored from. Kill switch: HUNCH_TASK_SELECTION=0
 *  (no selection is written or read, so file grounding stays unfiltered). */
export interface TaskSelectionFile {
  task_id: string;
  qualifying: string[];
  top: string[];
}

export function taskSelectionPath(taskId: string): string {
  return join(hookCacheDir(), `task-${taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
}

/** Persist a task's selection (atomic temp+rename). Throws; callers fail open. */
export function saveTaskSelection(selection: TaskSelectionFile): void {
  const dir = hookCacheDir();
  mkdirSync(dir, { recursive: true });
  sweep(dir);
  writeFileAtomic(taskSelectionPath(selection.task_id), JSON.stringify({
    task_id: selection.task_id, qualifying: [...selection.qualifying], top: [...selection.top],
  }));
}

export function taskSelectionEnabled(): boolean {
  return process.env.HUNCH_TASK_SELECTION !== "0";
}

/** Remove a task's selection file (an empty selection is no selection). Never throws. */
export function clearTaskSelection(taskId: string): void {
  try {
    rmSync(taskSelectionPath(taskId), { force: true });
  } catch {
    /* fail open: a stale file is read back as whatever it holds */
  }
}

/** The task's selection, or null when none was written (a host without a prompt
 *  hook, a legacy session), it holds no decision/bug/finding id (constraints
 *  are never filtered, so a constraint-only selection would only hide memory),
 *  it is unreadable, or selection is switched off — callers then keep today's
 *  unfiltered grounding. Never throws. */
export function loadTaskSelection(taskId: string | null | undefined): TaskSelectionFile | null {
  try {
    if (!taskId || !taskSelectionEnabled()) return null;
    const raw = JSON.parse(readFileSync(taskSelectionPath(taskId), "utf8")) as Partial<TaskSelectionFile>;
    if (!raw || raw.task_id !== taskId || !Array.isArray(raw.qualifying) || !Array.isArray(raw.top)) return null;
    const qualifying = raw.qualifying.filter((id): id is string => typeof id === "string");
    if (!qualifying.some(isFilterableSelectionId)) return null;
    return { task_id: taskId, qualifying, top: raw.top.filter((id) => typeof id === "string") };
  } catch {
    return null;
  }
}

/** Drop session caches from long-gone sessions (best effort, bounded dir). */
function sweep(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      try {
        if (Date.now() - statSync(join(dir, f)).mtimeMs > SWEEP_AGE_MS) rmSync(join(dir, f), { force: true });
      } catch {
        /* someone else's file / raced — skip */
      }
    }
  } catch {
    /* dir unreadable — skip */
  }
}
