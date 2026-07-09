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
import { tmpdir } from "node:os";

const MAX_KEYS = 300;
const SWEEP_AGE_MS = 48 * 3600 * 1000;

/** Decide whether this injection should be the FULL grounding block or a delta
 *  one-liner. Records the content hash as a side effect (so the next identical
 *  call dedups). Never throws. */
export function injectionMode(sessionId: string | undefined, key: string, content: string): "full" | "delta" {
  try {
    if (!sessionId || process.env.HUNCH_HOOK_DEDUP === "0") return "full";
    const dir = join(tmpdir(), "hunch-hookcache");
    mkdirSync(dir, { recursive: true });
    sweep(dir);
    const file = join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
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
