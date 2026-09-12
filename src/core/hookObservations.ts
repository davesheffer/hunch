/** Runtime evidence that a host actually delivered a lifecycle event to Hunch's
 * hook. Configuration proves wiring; only an observed event proves delivery.
 * One row per (provider, normalized event), machine-local, outside the
 * rebuildable index. Recording is best-effort: a hook must never fail on it. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withServedDatabase } from "./served.js";
import { HUNCH_VERSION } from "./version.js";

export interface HookObservation { provider: string; event: string; at: string; version: string }

type Database = Parameters<Parameters<typeof withServedDatabase>[1]>[0];
function ensureTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hook_observations (
    provider TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, version TEXT NOT NULL,
    PRIMARY KEY (provider, event)
  )`);
}

/** Never throws (con_03a0b94b2e): a missing ledger costs evidence, not the edit. */
export function recordHookObservation(root: string, provider: string, event: string): void {
  try {
    withServedDatabase(root, db => {
      ensureTable(db);
      db.prepare("INSERT OR REPLACE INTO hook_observations VALUES (?, ?, ?, ?)").run(provider, event, new Date().toISOString(), HUNCH_VERSION);
    });
  } catch { /* evidence is optional; the hook response is not */ }
}

export function readHookObservations(root: string): HookObservation[] {
  if (!existsSync(join(root, ".hunch-cache", "served.db"))) return [];
  return withServedDatabase(root, db => {
    ensureTable(db);
    return db.prepare("SELECT provider, event, at, version FROM hook_observations ORDER BY at DESC").all() as unknown as HookObservation[];
  });
}
