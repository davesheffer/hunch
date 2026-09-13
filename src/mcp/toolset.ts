/** Which MCP tool groups a server exposes. Every host shares one server, so the
 * selection surface is the same for all of them: 57 tools with ~24 KB of
 * descriptions dilute tool choice for everyday grounding. The everyday set is
 * the default; the two specialist groups are enabled by evidence (a root that
 * stores nuryel state records), by `.hunch/config.json` `mcp_tools`, or by the
 * `HUNCH_MCP_TOOLS` environment variable. Hidden tools are not registered at
 * all, so a client never sees them in tools/list. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_KINDS } from "../core/stateDelivery.js";

export const MCP_TOOL_GROUPS = {
  /** nuryel.state/1 — the state-partition contract (Sofia-style agents). */
  nuryel: ["nuryel_capabilities", "nuryel_read", "nuryel_write", "nuryel_capture", "nuryel_capture_batch", "nuryel_subscribe", "nuryel_records"],
  /** Constitution G2/G3 experiment-track tools; the CLI remains the primary surface. */
  "constitution-experiments": [
    "hunch_constitution_g2_readiness", "hunch_constitution_g3_readiness", "hunch_constitution_g2_shadow_queue",
    "hunch_constitution_g2_operational_drill", "hunch_constitution_g2_candidates", "hunch_constitution_g2_behavior_candidates",
    "hunch_constitution_g2_behavior_replay", "hunch_constitution_g2_behavior_materialization", "hunch_constitution_g2_behavior_policy_materialize",
  ],
} as const;
export type McpToolGroup = keyof typeof MCP_TOOL_GROUPS;
export const MCP_TOOL_GROUP_NAMES = Object.keys(MCP_TOOL_GROUPS) as McpToolGroup[];

export interface McpToolset {
  enabled: (group: McpToolGroup) => boolean;
  groups: McpToolGroup[];
  hidden: string[];
  /** Where the selection came from, for the startup log and doctor. */
  source: "env" | "config" | "default";
}

/** Grammar shared by the env var and the config value: `all`, `core`, or a
 * comma-separated list of extra groups on top of core (`core,nuryel`). Unknown
 * words are ignored rather than failing the server. */
export function parseToolsetSpec(spec: string): McpToolGroup[] | null {
  const words = spec.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return null;
  if (words.includes("all")) return [...MCP_TOOL_GROUP_NAMES];
  return MCP_TOOL_GROUP_NAMES.filter(g => words.includes(g));
}

/** A root that already stores nuryel state records is a state partition and
 * needs the nuryel tools; every other root gets the everyday set by default. */
export function rootStoresState(root: string): boolean {
  return STATE_KINDS.some(kind => {
    const dir = join(root, ".hunch", kind);
    try { return existsSync(dir) && readdirSync(dir).some(f => f.endsWith(".json")); } catch { return false; }
  });
}

export function resolveMcpToolset(root: string, opts: { env?: NodeJS.ProcessEnv; configSpec?: string | null } = {}): McpToolset {
  const env = opts.env ?? process.env;
  let groups: McpToolGroup[] | null = null;
  let source: McpToolset["source"] = "default";
  const fromEnv = env.HUNCH_MCP_TOOLS?.trim();
  if (fromEnv) { groups = parseToolsetSpec(fromEnv); if (groups) source = "env"; }
  if (!groups && opts.configSpec?.trim()) { groups = parseToolsetSpec(opts.configSpec); if (groups) source = "config"; }
  if (!groups) { groups = rootStoresState(root) ? ["nuryel"] : []; source = "default"; }
  const set = new Set(groups);
  const hidden = MCP_TOOL_GROUP_NAMES.filter(g => !set.has(g)).flatMap(g => [...MCP_TOOL_GROUPS[g]]);
  return { enabled: g => set.has(g), groups: [...set], hidden, source };
}
