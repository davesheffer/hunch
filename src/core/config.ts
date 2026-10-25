/** Hunch user config (`.hunch/config.json`) — runtime knobs that are NOT schema
 *  state (the on-disk schema version lives in manifest.json). Committed alongside
 *  the graph, so a whole team shares the same settings — e.g. how firmly the
 *  agent lifecycle hooks enforce engineering memory before an edit. */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./io.js";
import type { HunchPaths } from "./paths.js";
import { ENTITY_KINDS } from "./types.js";

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
  /** `hunch verify` knobs: `tests` discovery glob, `command` runner template
   *  (`{files}` is replaced by the selected test paths). */
  verify?: { tests?: string; command?: string };
  /** Where memory lives (dec_66636a2b1b). `home: "overlay"` makes the overlay the home of
   *  every kind outside `public_kinds`, and a capture with no reachable overlay is refused
   *  rather than written public. Absent = today's routing. */
  memory?: { home?: "repo" | "overlay"; public_kinds?: string[]; min_version?: string };
}

export interface MemoryPolicy {
  home: "repo" | "overlay";
  publicKinds: ReadonlySet<string>;
  /** `public_kinds` entries that name no kind (a typo, or `policies`, which is always
   *  public and outside kind routing). Ignored for routing; status and doctor warn. */
  unknownKinds: string[];
}

const DEFAULT_PUBLIC_KINDS = ["constraints", "components"];
// Index output is regenerable from the code and CI indexes with no overlay, so it is
// public under every policy (the indexer writes components as well as symbols and edges).
const STRUCTURAL_KINDS = ["components", "symbols", "edges", "resources"];

/** The effective memory policy: home "repo" unless the config explicitly says "overlay". */
export function memoryPolicy(config: Pick<HunchConfig, "memory">): MemoryPolicy {
  const raw = config.memory;
  if (!raw || raw.home !== "overlay") return { home: "repo", publicKinds: new Set(), unknownKinds: [] };
  const names = Array.isArray(raw.public_kinds) ? raw.public_kinds.filter((k): k is string => typeof k === "string") : DEFAULT_PUBLIC_KINDS;
  const isKind = (k: string): boolean => (ENTITY_KINDS as readonly string[]).includes(k);
  return { home: "overlay", publicKinds: new Set([...names.filter(isKind), ...STRUCTURAL_KINDS]), unknownKinds: names.filter((k) => !isKind(k)) };
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

/** Parse config.json text, tolerating a leading BOM (Windows editors write one). Throws
 *  on invalid JSON; callers choose between falling back and refusing. */
export function parseConfigText(text: string): unknown {
  return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
}

/** Read `.hunch/config.json`. A missing/unparseable file, or an unknown firmness
 *  value, falls back to defaults — the hook must NEVER crash an edit over config. */
export function readConfig(paths: HunchPaths): HunchConfig {
  if (!existsSync(paths.config)) return defaults();
  try {
    const raw = parseConfigText(readFileSync(paths.config, "utf8")) as Partial<HunchConfig>;
    return {
      firmness: isFirmness(raw.firmness) ? raw.firmness : DEFAULT_FIRMNESS,
      ...(typeof raw.mcp_tools === "string" && raw.mcp_tools.trim() ? { mcp_tools: raw.mcp_tools.trim() } : {}),
      ...(raw.workspaces && typeof raw.workspaces === "object" && !Array.isArray(raw.workspaces) ? { workspaces: raw.workspaces } : {}),
      ...(raw.verify && typeof raw.verify === "object" && !Array.isArray(raw.verify) ? { verify: raw.verify } : {}),
      ...(raw.memory && typeof raw.memory === "object" && !Array.isArray(raw.memory) ? { memory: raw.memory } : {}),
    };
  } catch {
    return defaults();
  }
}

/** Write `.hunch/config.json`, merging `patch` over the current on-disk config. Keys
 *  this build does not know survive (a newer build's settings must not vanish on an older
 *  write), and an unparseable file is refused rather than clobbered. */
export function writeConfig(paths: HunchPaths, patch: Partial<HunchConfig>): HunchConfig {
  let onDisk: Record<string, unknown> = {};
  if (existsSync(paths.config)) {
    let parsed: unknown;
    try {
      parsed = parseConfigText(readFileSync(paths.config, "utf8"));
    } catch (error) {
      throw new Error(`refusing to overwrite unparseable ${paths.config}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`refusing to overwrite ${paths.config}: it is not a JSON object`);
    }
    onDisk = parsed as Record<string, unknown>;
  }
  const next = { ...onDisk, ...readConfig(paths), ...patch } as HunchConfig;
  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileAtomic(paths.config, JSON.stringify(next, null, 2) + "\n");
  return next;
}
