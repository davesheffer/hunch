/** Hunch user config (`.hunch/config.json`) — runtime knobs that are NOT schema
 *  state (the on-disk schema version lives in manifest.json). Committed alongside
 *  the graph, so a whole team shares the same settings — e.g. how firmly the
 *  agent lifecycle hooks enforce engineering memory before an edit. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HunchPaths } from "./paths.js";

/** How firmly the agent lifecycle hook (`hunch hook`) enforces Hunch on edits:
 *   off      — emit nothing (hook is a no-op).
 *   advisory — inject the relevant Hunch slice (decisions/constraints/bugs) as
 *              context before the edit. The default: always informs, never blocks.
 *   firm     — advisory + explicitly flag invariants in the edited file's scope.
 *   strict   — firm + DENY an edit that hits a BLOCKING invariant (direct or via
 *              blast radius), feeding the invariant back as the refusal reason. */
export type Firmness = "off" | "advisory" | "firm" | "strict";

export const FIRMNESS_LEVELS: readonly Firmness[] = ["off", "advisory", "firm", "strict"];
export const DEFAULT_FIRMNESS: Firmness = "advisory";

export interface HunchConfig {
  firmness: Firmness;
}

function defaults(): HunchConfig {
  return { firmness: DEFAULT_FIRMNESS };
}

export function isFirmness(v: unknown): v is Firmness {
  return typeof v === "string" && (FIRMNESS_LEVELS as readonly string[]).includes(v);
}

/** Read `.hunch/config.json`. A missing/unparseable file, or an unknown firmness
 *  value, falls back to defaults — the hook must NEVER crash an edit over config. */
export function readConfig(paths: HunchPaths): HunchConfig {
  if (!existsSync(paths.config)) return defaults();
  try {
    const raw = JSON.parse(readFileSync(paths.config, "utf8")) as Partial<HunchConfig>;
    return { firmness: isFirmness(raw.firmness) ? raw.firmness : DEFAULT_FIRMNESS };
  } catch {
    return defaults();
  }
}

/** Write `.hunch/config.json`, merging `patch` over the current on-disk config. */
export function writeConfig(paths: HunchPaths, patch: Partial<HunchConfig>): HunchConfig {
  const next: HunchConfig = { ...readConfig(paths), ...patch };
  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(paths.config, JSON.stringify(next, null, 2) + "\n");
  return next;
}
