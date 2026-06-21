/**
 * Heal a Windows-only Claude Code misconfiguration that silently hides Hunch's
 * `hunch_*` MCP tools.
 *
 * THE BUG (Claude Code's, not Hunch's): Claude Code stores per-project config in
 * `~/.claude.json` under a `projects` map keyed by the raw cwd STRING. Windows
 * drive letters are case-insensitive (`c:\` and `C:\` are the same directory) but
 * Claude Code compares the key case-sensitively. So it can create TWO project
 * blocks for one real directory:
 *
 *   "c:/Users/me/repo" -> mcpServers: {}                 (what one session resolves to)
 *   "C:/Users/me/repo" -> mcpServers: { hunch: {…} }     (where `claude mcp add` wrote)
 *
 * A session whose cwd resolves to the OTHER casing reads the empty block → no
 * hunch tools, even though registration "succeeded".
 *
 * Only the GLOBAL `claude mcp add` route (cwd-string-keyed in ~/.claude.json) is
 * fragile. Hunch's own project-local `.mcp.json` (scaffold.ts writeMcpJson) is
 * IMMUNE — Claude resolves it by file path, not by a cwd string key.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { writeFileAtomic } from "../core/io.js";

/** Absolute path to Claude Code's per-user config (`~/.claude.json`). */
export function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

export interface HealedGroup {
  /** The normalized real path the casing variants collapse to. */
  realPath: string;
  /** The raw project keys that differ only by drive-letter case. */
  casings: string[];
  /** The union of MCP server names now mirrored across every casing. */
  servers: string[];
}

export interface HealResult {
  platform: NodeJS.Platform;
  /** False on non-Windows (the bug can't occur there) — the heal is a no-op. */
  applicable: boolean;
  file: string;
  /** Path to the timestamped backup, set only when a write happened. */
  backup?: string;
  /** Whether the file was modified. */
  changed: boolean;
  /** The case-split groups that were merged (empty when nothing to heal). */
  groups: HealedGroup[];
}

export interface HealOptions {
  /** Defaults to `claudeConfigPath()`. */
  file?: string;
  /** Defaults to `process.platform`; pass "win32" to exercise the heal in tests. */
  platform?: NodeJS.Platform;
}

type ProjectBlock = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
};

/** Group key for two project keys that point at the SAME real directory. The bug
 *  is purely drive-letter case (+ slash style), so we normalize ONLY those — never
 *  the rest of the path — so genuinely distinct projects are never merged. */
function normalizeProjectKey(key: string): string {
  return key.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Union the MCP config across all casing variants of one real project. First-wins
 *  on a server-name collision (keys iterated in sorted order for determinism) so we
 *  never clobber an existing server definition; enabled/disabled lists are deduped
 *  unions. */
function unionConfig(blocks: ProjectBlock[]): { servers: Record<string, unknown>; enabled: string[]; disabled: string[] } {
  const servers: Record<string, unknown> = {};
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  for (const b of blocks) {
    if (isPlainObject(b.mcpServers)) {
      for (const [name, cfg] of Object.entries(b.mcpServers)) if (!(name in servers)) servers[name] = cfg;
    }
    for (const s of asStringArray(b.enabledMcpjsonServers)) enabled.add(s);
    for (const s of asStringArray(b.disabledMcpjsonServers)) disabled.add(s);
  }
  return { servers, enabled: [...enabled], disabled: [...disabled] };
}

/** Mirror the union into one casing block, touching ONLY the three MCP keys and
 *  ADDING missing entries (never overwriting an existing one). Returns true if the
 *  block changed. */
function applyUnion(block: ProjectBlock, u: ReturnType<typeof unionConfig>): boolean {
  let changed = false;
  if (!isPlainObject(block.mcpServers)) { block.mcpServers = {}; if (Object.keys(u.servers).length) changed = true; }
  for (const [name, cfg] of Object.entries(u.servers)) {
    if (!(name in block.mcpServers!)) { block.mcpServers![name] = cfg; changed = true; }
  }
  const mergeList = (key: "enabledMcpjsonServers" | "disabledMcpjsonServers", extra: string[]) => {
    if (!extra.length) return;
    const cur = asStringArray(block[key]);
    const merged = [...new Set([...cur, ...extra])];
    if (merged.length !== cur.length) { block[key] = merged; changed = true; }
  };
  mergeList("enabledMcpjsonServers", u.enabled);
  mergeList("disabledMcpjsonServers", u.disabled);
  return changed;
}

/** Windows-safe timestamp for the backup filename (no `:` — invalid on NTFS). */
function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Scan `~/.claude.json` for project keys that collapse to the same real directory
 * but differ by drive-letter case, and HEAL each split by computing the UNION of
 * its casings' MCP config and MIRRORING that union back into EVERY casing.
 *
 * Why mirror (not merge-into-one-canonical-and-delete-the-rest): we cannot predict
 * which casing a given Claude Code session will resolve its cwd to. If we collapsed
 * to a single canonical key, a session that lands on a deleted casing would get a
 * fresh empty block → hunch missing again. Mirroring the union guarantees that
 * whichever casing wins, the server is there — and it deletes nothing Claude made.
 *
 * Safety: no-op on non-Windows; backs up the file (timestamped copy) BEFORE any
 * write; merges only (never clobbers other servers/keys); and THROWS rather than
 * overwrite a non-empty file it cannot parse (mirrors readJsonObj in providers.ts).
 */
export function healClaudeConfigCaseSplit(opts: HealOptions = {}): HealResult {
  const platform = opts.platform ?? process.platform;
  const file = opts.file ?? claudeConfigPath();
  const base: HealResult = { platform, applicable: platform === "win32", file, changed: false, groups: [] };

  if (platform !== "win32") return base; // the case-split bug is Windows-only
  if (!existsSync(file)) return base;
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return base;

  let root: Record<string, unknown>;
  try {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) throw new Error("not a JSON object");
    root = v;
  } catch (e) {
    throw new Error(`refusing to modify ${file}: could not parse it (${(e as Error).message}). Fix or remove it, then re-run.`);
  }

  const projects = root.projects;
  if (!isPlainObject(projects)) return base; // nothing to heal

  // Bucket the raw project keys by their normalized real path.
  const buckets = new Map<string, string[]>();
  for (const key of Object.keys(projects)) {
    const norm = normalizeProjectKey(key);
    const arr = buckets.get(norm) ?? [];
    arr.push(key);
    buckets.set(norm, arr);
  }

  const groups: HealedGroup[] = [];
  let changed = false;
  for (const [norm, keys] of buckets) {
    if (keys.length < 2) continue; // no casing split for this directory
    keys.sort(); // deterministic first-wins union
    const blocks = keys.map((k) => (isPlainObject(projects[k]) ? (projects[k] as ProjectBlock) : ({} as ProjectBlock)));
    const u = unionConfig(blocks);
    let groupChanged = false;
    for (const k of keys) {
      if (!isPlainObject(projects[k])) projects[k] = {};
      if (applyUnion(projects[k] as ProjectBlock, u)) groupChanged = true;
    }
    if (groupChanged) {
      changed = true;
      groups.push({ realPath: norm, casings: keys, servers: Object.keys(u.servers) });
    }
  }

  if (!changed) return { ...base, groups };

  // Back up the exact original bytes BEFORE writing the healed config.
  const backup = `${file}.hunch-bak-${backupStamp()}`;
  copyFileSync(file, backup);
  writeFileAtomic(file, JSON.stringify(root, null, 2) + "\n");
  return { ...base, changed: true, backup, groups };
}
