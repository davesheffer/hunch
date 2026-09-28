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
 *
 * The same per-session file carries the hook diet's grounding budget
 * (consumeInjectionBudget): a running character count per agent identity, so
 * resetSessionInjections (compaction) resets it together with the dedup map.
 * Budget counters and the diet's `seen:` markers are pinned: the MAX_KEYS trim
 * evicts only ordinary dedup keys.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_KEYS = 300;
const SWEEP_AGE_MS = 48 * 3600 * 1000;
/** Budget counters share the dedup map but are never trimmed with it: evicting
 *  one would silently hand an agent a fresh budget mid-session. */
const BUDGET_PREFIX = "budget:";
/** Keys the MAX_KEYS trim never evicts: budget counters, and the hook diet's
 *  session-wide `seen:` markers (evicting one would re-send grounding the agent
 *  already holds, and charge its budget for it again). */
const PINNED_PREFIXES = [BUDGET_PREFIX, "seen:"];

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
    const dir = join(tmpdir(), "hunch-hookcache");
    mkdirSync(dir, { recursive: true });
    sweep(dir);
    const file = cacheFile(sessionId);
    const hash = hashOf(hashInput);
    const map = readMap(file);
    if (map[key] === hash) return "delta";
    map[key] = hash;
    const keys = Object.keys(map).filter((k) => !PINNED_PREFIXES.some((p) => k.startsWith(p)));
    if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete map[k];
    writeFileSync(file, JSON.stringify(map));
    return "full";
  } catch {
    return "full"; // grounded beats deduped, always
  }
}

/** What injectionMode WOULD answer for this key, without recording anything:
 *  the hook diet asks "was this file's grounding already served?" from paths
 *  that must not count as serving it (a shell-write pointer, a budget check).
 *  Never writes, never throws; same "full" answer on any doubt. */
export function peekInjectionMode(sessionId: string | undefined, key: string, content: string, hashInput: string = content): "full" | "delta" {
  try {
    if (!sessionId || process.env.HUNCH_HOOK_DEDUP === "0") return "full";
    return readMap(cacheFile(sessionId))[key] === hashOf(hashInput) ? "delta" : "full";
  } catch {
    return "full";
  }
}

/** Session grounding budget (hook diet): charge `chars` to `key`'s running
 *  total when the total stays within `limit` and answer true; answer false and
 *  charge nothing when it would cross it — including a single charge larger
 *  than `limit` on its own. The caller keys it by agent identity, so a
 *  subagent's fresh context gets its own budget. Fails toward grounding like
 *  injectionMode: missing session id, the dedup kill switch, or any cache error
 *  → true. Never throws. */
export function consumeInjectionBudget(sessionId: string | undefined, key: string, chars: number, limit: number): boolean {
  try {
    if (!sessionId || process.env.HUNCH_HOOK_DEDUP === "0") return true;
    mkdirSync(join(tmpdir(), "hunch-hookcache"), { recursive: true });
    const file = cacheFile(sessionId);
    // Unlike the dedup map, an unreadable or corrupt file is not "nothing used
    // yet": answering from it could withhold grounding on a broken cache.
    const map = tryReadMap(file);
    if (!map) return true;
    const stored = Number(map[BUDGET_PREFIX + key] ?? 0);
    const used = Number.isFinite(stored) && stored > 0 ? stored : 0;
    if (used + chars > limit) return false;
    map[BUDGET_PREFIX + key] = String(used + chars);
    writeFileSync(file, JSON.stringify(map));
    return true;
  } catch {
    return true; // grounded beats budgeted, always
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
    rmSync(cacheFile(sessionId), { force: true });
  } catch {
    /* unwritable tmpdir — next injectionMode call falls back to "full" anyway */
  }
}

function cacheFile(sessionId: string): string {
  return join(tmpdir(), "hunch-hookcache", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
}

function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** The session's map; unreadable or corrupt reads as empty (never a fake delta). */
function readMap(file: string): Record<string, string> {
  return tryReadMap(file) ?? {};
}

/** The session's map, empty when the file does not exist yet, null when it
 *  exists but cannot be read or parsed. */
function tryReadMap(file: string): Record<string, string> | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
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
