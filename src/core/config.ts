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

/** Workspace-ledger knobs (docs/workspace-ledger.md). `publish` decides what a snapshot
 *  carries: `branches` (default — label, branches, verdicts, dirty/locked flags, no paths),
 *  `full` (worktree paths too), `off` (no record). `publish_public` lets a repo WITHOUT an
 *  overlay commit the record into its tracked .hunch/ — off by default: per-machine facts
 *  churning the code repo is rarely wanted. */
export type WorkspacePublish = "full" | "branches" | "off";
export const WORKSPACE_PUBLISH_MODES: readonly WorkspacePublish[] = ["full", "branches", "off"];
export const DEFAULT_WORKSPACE_PUBLISH: WorkspacePublish = "branches";
export interface WorkspacesConfig {
  publish: WorkspacePublish;
  stale_after_days: number;
  publish_public: boolean;
}

export interface HunchConfig {
  firmness: Firmness;
  /** MCP tool groups beyond the everyday set: `all`, `core`, or `core,nuryel`
   *  (see src/mcp/toolset.ts). Undefined = decide from the root's contents. */
  mcp_tools?: string;
  workspaces?: Partial<WorkspacesConfig>;
}

/** The effective workspace config: every field present, unknown values ignored. */
export function workspacesConfig(config: HunchConfig): WorkspacesConfig {
  const raw = config.workspaces ?? {};
  const days = Number(raw.stale_after_days);
  return {
    publish: (WORKSPACE_PUBLISH_MODES as readonly unknown[]).includes(raw.publish) ? raw.publish as WorkspacePublish : DEFAULT_WORKSPACE_PUBLISH,
    stale_after_days: Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 7,
    publish_public: raw.publish_public === true,
  };
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
    return {
      firmness: isFirmness(raw.firmness) ? raw.firmness : DEFAULT_FIRMNESS,
      ...(typeof raw.mcp_tools === "string" && raw.mcp_tools.trim() ? { mcp_tools: raw.mcp_tools.trim() } : {}),
      ...(raw.workspaces && typeof raw.workspaces === "object" && !Array.isArray(raw.workspaces) ? { workspaces: raw.workspaces } : {}),
    };
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
