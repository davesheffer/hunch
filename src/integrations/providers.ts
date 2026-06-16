/**
 * Multi-assistant compatibility (DESIGN §7, extended). The Hunch MCP server is
 * client-agnostic — any MCP-capable assistant can call the `hunch_*` tools. The
 * only per-tool difference is HOW each one is told to launch the server and where
 * its ambient grounding lives. This module scaffolds those surfaces for the major
 * assistants so the same `.hunch/` graph powers all of them:
 *
 *   Assistant   | MCP config              | root key       | grounding file
 *   ------------|-------------------------|----------------|---------------------------------
 *   Claude Code | .mcp.json               | mcpServers     | CLAUDE.md            (scaffold.ts)
 *   Cursor      | .cursor/mcp.json        | mcpServers     | .cursor/rules/hunch.mdc
 *   VS Code     | .vscode/mcp.json        | servers (+type)| .github/copilot-instructions.md
 *   Codex CLI   | .codex/config.toml      | [mcp_servers.*]| AGENTS.md
 *   (any other) | —                       | —              | AGENTS.md (cross-tool standard)
 *
 * Every writer MERGES into existing files (preserving other servers / user prose)
 * and is idempotent, so re-running `hunch init` is safe.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import type { Invocation } from "./scaffold.js";
import { renderHunchSection, upsertSection } from "./claudemd.js";

/** Strip // line and block comments + trailing commas (JSONC → JSON). String-aware
 *  (double-quoted, with escapes) so a // inside a value isn't mangled. VS Code's
 *  .vscode/mcp.json is JSONC, so we must tolerate comments. */
function stripJsonc(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const n = s[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Read a JSON/JSONC object. Returns {} only for an ABSENT or empty file. A
 *  non-empty file we cannot parse THROWS — overwriting it would silently wipe the
 *  user's other MCP servers. */
function readJsonObj(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(stripJsonc(raw));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    throw new Error("not a JSON object");
  } catch (e) {
    throw new Error(`refusing to overwrite ${file}: could not parse it (${(e as Error).message}). Fix or remove it, then re-run.`);
  }
}

/** Render a string as a TOML value: a literal '…' when safe (no escaping needed —
 *  ideal for Windows backslash paths), else a basic "…" with escapes. */
function tomlStr(s: string): string {
  return !s.includes("'") && !s.includes("\n")
    ? `'${s}'`
    : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function writeJson(file: string, obj: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return file;
}

/** Cursor: .cursor/mcp.json — same `mcpServers` shape as Claude Desktop/Code. */
export function writeCursorMcp(root: string, inv: Invocation): string {
  const file = join(root, ".cursor", "mcp.json");
  const json = readJsonObj(file) as { mcpServers?: Record<string, unknown> };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

/** VS Code (Copilot agent mode): .vscode/mcp.json — root key is `servers`, and
 *  each stdio entry carries an explicit `type: "stdio"` (VS Code's schema). */
export function writeVscodeMcp(root: string, inv: Invocation): string {
  const file = join(root, ".vscode", "mcp.json");
  const json = readJsonObj(file) as { servers?: Record<string, unknown> };
  json.servers = json.servers ?? {};
  json.servers.hunch = { type: "stdio", command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

const TOML_START = "# >>> hunch mcp (managed) >>>";
const TOML_END = "# <<< hunch mcp <<<";

/** Codex CLI: .codex/config.toml — `[mcp_servers.hunch]` stdio entry. We own only
 *  a marker-delimited block; any other TOML the user has is preserved. Paths use
 *  TOML single-quote LITERAL strings so Windows backslashes need no escaping. */
export function writeCodexConfig(root: string, inv: Invocation): string {
  const file = join(root, ".codex", "config.toml");
  const argsToml = [...inv.args, "mcp"].map(tomlStr).join(", ");
  const block = [
    TOML_START,
    "[mcp_servers.hunch]",
    `command = ${tomlStr(inv.command)}`,
    `args = [${argsToml}]`,
    TOML_END,
  ].join("\n");

  // Strip any prior managed block first, so `base` is the user's own TOML.
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const i = content.indexOf(TOML_START);
  const j = content.indexOf(TOML_END);
  let base: string;
  if (i >= 0 && j > i) base = content.slice(0, i) + content.slice(j + TOML_END.length);
  else if (i >= 0 || j >= 0) base = content.split("\n").filter((l) => !l.includes(TOML_START) && !l.includes(TOML_END)).join("\n");
  else base = content;

  // A user-authored [mcp_servers.hunch] outside our block would make TWO tables of
  // the same name → TOML duplicate-table error. Refuse rather than corrupt it.
  if (/^\s*\[mcp_servers\.hunch\]/m.test(base)) {
    throw new Error(`refusing to edit ${file}: it already defines [mcp_servers.hunch] outside Hunch's managed block. Remove it, then re-run.`);
  }

  base = base.trimEnd();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, base ? `${base}\n\n${block}\n` : `${block}\n`);
  return file;
}

/** AGENTS.md — the cross-tool ambient-instruction standard (Codex and a growing
 *  set of assistants read it). Marker-delimited so user prose is preserved. */
export function writeAgentsMd(root: string, store: HunchStore): string {
  return upsertSection(join(root, "AGENTS.md"), renderHunchSection(store), "# AGENTS.md");
}

/** GitHub Copilot custom instructions (VS Code / github.com). Same grounding. */
export function writeCopilotInstructions(root: string, store: HunchStore): string {
  return upsertSection(join(root, ".github", "copilot-instructions.md"), renderHunchSection(store), "# Copilot instructions");
}

/** Cursor project rule (.mdc = frontmatter + body). `alwaysApply` keeps the Hunch
 *  grounding in context for every request. Fully managed by Hunch (overwritten). */
export function writeCursorRule(root: string, store: HunchStore): string {
  const file = join(root, ".cursor", "rules", "hunch.mdc");
  const body = `---\ndescription: Hunch engineering memory — consult the hunch_* MCP tools before editing\nalwaysApply: true\n---\n\n${renderHunchSection(store)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

export interface ProviderScaffold {
  assistant: string;
  files: string[];
  /** Set when this assistant was skipped (e.g. an unparseable existing config we
   *  refused to clobber) — surfaced as a warning, not a fatal init failure. */
  error?: string;
}

/** Scaffold MCP config + grounding for all supported assistants. Returns a
 *  per-assistant summary for `hunch init` to print. Each assistant is isolated:
 *  a writer that refuses to clobber a malformed file degrades to a warning rather
 *  than aborting the rest. Claude Code is handled separately by scaffold.ts. */
export function scaffoldProviders(root: string, inv: Invocation, store: HunchStore): ProviderScaffold[] {
  const tasks: Array<[string, () => string[]]> = [
    ["Cursor", () => [writeCursorMcp(root, inv), writeCursorRule(root, store)]],
    ["VS Code (Copilot)", () => [writeVscodeMcp(root, inv), writeCopilotInstructions(root, store)]],
    ["Codex CLI", () => [writeCodexConfig(root, inv)]],
    ["Any (AGENTS.md)", () => [writeAgentsMd(root, store)]],
  ];
  return tasks.map(([assistant, run]) => {
    try {
      return { assistant, files: run() };
    } catch (e) {
      return { assistant, files: [], error: (e as Error).message };
    }
  });
}
