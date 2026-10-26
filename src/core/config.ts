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
  /** This repository's identity (a UUID), committed so a checkout with no network origin
   *  (none, a local path, file://) still finds its overlay in the machine profile. Read
   *  as written (unvalidated) so a malformed value is refused, never replaced: see
   *  repoIdOf / ensureRepoId. */
  repo_id?: unknown;
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
const MEMORY_KEYS = ["home", "public_kinds", "min_version"];
export const STRUCTURAL_KINDS: readonly string[] = ["components", "symbols", "edges", "resources"];

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

/** Why `.hunch/config.json` exists yet yields no readable memory policy, or null when it
 *  is absent or fine. readConfig falls back to defaults on these (the edit hook must
 *  never fail over config), which reads as "no policy" and would route captures public,
 *  so the capture path asks this first and refuses instead. */
export function memoryPolicyProblem(paths: HunchPaths): string | null {
  if (!existsSync(paths.config)) return null;
  let text: string;
  try {
    text = readFileSync(paths.config, "utf8");
  } catch (error) {
    return `.hunch/config.json cannot be read (${error instanceof Error ? error.message : String(error)})`;
  }
  return memoryConfigTextProblem(text);
}

/** A key with case, `_` and `-` ignored, so `publicKinds` and `Public-Kinds` match `public_kinds`. */
const spelling = (key: string): string => key.toLowerCase().replace(/[_-]/g, "");
/** Whether `key` is a misspelling of `known`: the same spelling, or one stray or missing trailing s. */
const misspells = (key: string, known: string): boolean =>
  key !== known && (spelling(known) === spelling(key) || spelling(known) === `${spelling(key)}s` || `${spelling(known)}s` === spelling(key));

/** memoryPolicyProblem for config.json text already in hand (a file at a git ref). */
export function memoryConfigTextProblem(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseConfigText(text);
  } catch (error) {
    return `.hunch/config.json cannot be parsed (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ".hunch/config.json is not a JSON object";
  // No other config key starts with `memor`, so any such key (`Memory`, `memories`) meant the policy.
  const misspelledMemory = Object.keys(parsed).find((key) => key !== "memory" && (misspells(key, "memory") || spelling(key).startsWith("memor")));
  if (misspelledMemory) return `.hunch/config.json has \`${misspelledMemory}\`; the memory policy key is \`memory\``;
  if (!("memory" in parsed)) return null;
  const memory = (parsed as { memory: unknown }).memory;
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) return ".hunch/config.json has a `memory` field that is not an object";
  const { home, public_kinds } = memory as { home?: unknown; public_kinds?: unknown };
  const unknown = Object.keys(memory).filter((key) => !MEMORY_KEYS.includes(key));
  // A misspelled known key is a typo, not a newer option: ignoring it could widen what is public.
  for (const key of unknown) {
    const meant = MEMORY_KEYS.find((known) => misspells(key, known));
    if (meant) return `.hunch/config.json memory has \`${key}\`; did you mean \`${meant}\`?`;
  }
  // Without `home`, a key this build does not know may be the policy itself. Beside a
  // valid home it is a newer Hunch's option, so it is tolerated.
  if (home === undefined && unknown.length) return `.hunch/config.json memory has key(s) this Hunch does not know (${unknown.join(", ")}) and no home; expected ${MEMORY_KEYS.join(", ")}`;
  // public_kinds only means something under an overlay home; without one it reads as repo and goes public.
  if (home === undefined && public_kinds !== undefined) return ".hunch/config.json memory.public_kinds is set but home is missing; add \"home\": \"overlay\"";
  if (home !== undefined && home !== "repo" && home !== "overlay") return `.hunch/config.json memory.home must be "repo" or "overlay" (found ${JSON.stringify(home)})`;
  if (home === "overlay" && public_kinds !== undefined && !Array.isArray(public_kinds)) return ".hunch/config.json memory.public_kinds must be an array of kind names";
  return null;
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
      ...(raw.repo_id !== undefined ? { repo_id: raw.repo_id } : {}),
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
