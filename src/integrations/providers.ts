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
 *   Windsurf    | .windsurf/mcp_config.json| mcpServers    | .windsurf/rules/hunch.md
 *   (any other) | —                       | —              | AGENTS.md (cross-tool standard)
 *
 * Every writer MERGES into existing files (preserving other servers / user prose)
 * and is idempotent, so re-running `hunch init` is safe.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import type { Invocation } from "./scaffold.js";
import type { HookProvider } from "../core/agenthook.js";
import { renderHunchSection, upsertSection, updateClaudeMd } from "./claudemd.js";

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
  return dropTrailingCommas(out);
}

/** Remove trailing commas (`,` before `}`/`]`) — string-aware, so a comma inside
 *  a string value (e.g. "a,]") is never touched. A blanket regex would corrupt it
 *  (the same trap test/migrate.test.ts guards against). Runs on comment-free text,
 *  so lookahead need only skip whitespace. */
function dropTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "}" || s[j] === "]") continue; // trailing comma → drop
    }
    out += c;
  }
  return out;
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
  // TOML literal '…' needs no escaping (ideal for Windows backslash paths) but
  // can't contain a quote or newline; otherwise a basic "…" with escapes.
  if (!/['\r\n]/.test(s)) return `'${s}'`;
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${esc}"`;
}
function writeJson(file: string, obj: unknown): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return file;
}

/** Provider hook commands live in tracked config files, so use the structured
 * invocation (the same portable npx package reference as MCP) rather than a
 * machine-local CLI path. JSON quoting is accepted by POSIX shells and keeps
 * paths with spaces intact for source/dev installs. */
function hookCommand(inv: Invocation, provider: HookProvider): string {
  return [...[inv.command], ...inv.args, "hook", "--provider", provider].map((part) => JSON.stringify(part)).join(" ");
}

function isHunchProviderHook(entry: unknown): boolean {
  const e = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
  const command = typeof e?.command === "string" ? e.command : "";
  return /(?:@davesheffer\/hunch|[\\/]index\.(?:js|ts))/.test(command) && /\bhook\b/.test(command);
}

/** Merge our command entries into a standard `{ hooks: { Event: [] } }` file.
 * We replace only old Hunch commands and leave every foreign hook in place. */
function writeHookConfig(file: string, entries: Record<string, Array<Record<string, unknown>>>): string {
  const json = readJsonObj(file);
  const hooks = json.hooks && typeof json.hooks === "object" && !Array.isArray(json.hooks)
    ? json.hooks as Record<string, unknown>
    : {};
  for (const [event, next] of Object.entries(entries)) {
    const old = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...old.filter((entry) => !isHunchProviderHook(entry)), ...next];
  }
  json.hooks = hooks;
  return writeJson(file, json);
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

/** Google Antigravity's global MCP config moved between releases. Resolve
 * adaptively: an existing config wins, else an existing parent dir, else null
 * (Antigravity not installed — we never create a global config for an absent
 * tool). The current project-local config is handled separately below. `home`
 * is injectable for tests so we never touch the real ~/.gemini. */
export function antigravityMcpFile(home = homedir()): string | null {
  const candidates = [
    join(home, ".gemini", "config", "mcp_config.json"),
    join(home, ".gemini", "antigravity", "mcp_config.json"), // legacy
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const c of candidates) if (existsSync(dirname(c))) return c;
  return null;
}

/** Antigravity: merge the hunch stdio server into the global mcp_config.json — same
 *  `mcpServers` { command, args } shape as Cursor/Claude (stdio; `serverUrl` is only for
 *  HTTP servers). Returns null when Antigravity isn't detected. Grounding needs nothing
 *  extra: Antigravity reads the project-root AGENTS.md Hunch already writes. */
export function writeAntigravityMcp(inv: Invocation, home = homedir()): string | null {
  const file = antigravityMcpFile(home);
  if (!file) return null;
  const json = readJsonObj(file) as { mcpServers?: Record<string, unknown> };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

/** Current Antigravity IDE/CLI project config. Unlike a global config this is
 * committed with the repository, so every clone gets the same private/local
 * Hunch server without touching a user's home directory. */
export function writeAntigravityWorkspaceMcp(root: string, inv: Invocation): string {
  const file = join(root, ".agents", "mcp_config.json");
  const json = readJsonObj(file) as { mcpServers?: Record<string, unknown> };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
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
  return upsertSection(join(root, "AGENTS.md"), renderHunchSection(store, root), "# AGENTS.md");
}

/** GitHub Copilot custom instructions (VS Code / github.com). Same grounding. */
export function writeCopilotInstructions(root: string, store: HunchStore): string {
  return upsertSection(join(root, ".github", "copilot-instructions.md"), renderHunchSection(store, root), "# Copilot instructions");
}

/** Cursor project rule (.mdc = frontmatter + body). `alwaysApply` keeps the Hunch
 *  grounding in context for every request. Fully managed by Hunch (overwritten). */
export function writeCursorRule(root: string, store: HunchStore): string {
  const file = join(root, ".cursor", "rules", "hunch.mdc");
  const body = `---\ndescription: Hunch engineering memory — consult the hunch_* MCP tools before editing\nalwaysApply: true\n---\n\n${renderHunchSection(store, root)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

/** Windsurf (Cascade): .windsurf/mcp_config.json — same `mcpServers` shape as
 *  Cursor. Repo-local (committed, shared via git) to match Hunch's other configs,
 *  rather than the global ~/.codeium/windsurf path. Merges; refuses to clobber. */
export function writeWindsurfMcp(root: string, inv: Invocation): string {
  const file = join(root, ".windsurf", "mcp_config.json");
  const json = readJsonObj(file) as { mcpServers?: Record<string, unknown> };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

/** Current Windsurf also discovers a user config at ~/.codeium/windsurf. Only
 * touch it when the tool is already installed/configured; Hunch never creates a
 * global configuration for an application the user does not have. */
export function windsurfMcpFile(home = homedir()): string | null {
  const file = join(home, ".codeium", "windsurf", "mcp_config.json");
  return existsSync(file) || existsSync(dirname(file)) ? file : null;
}

export function writeWindsurfGlobalMcp(inv: Invocation, home = homedir()): string | null {
  const file = windsurfMcpFile(home);
  if (!file) return null;
  const json = readJsonObj(file) as { mcpServers?: Record<string, unknown> };
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hunch = { command: inv.command, args: [...inv.args, "mcp"] };
  return writeJson(file, json);
}

/** Windsurf project rule (.windsurf/rules/hunch.md). `trigger: always_on` keeps the
 *  Hunch grounding in Cascade's context for every request. Fully managed (overwritten). */
export function writeWindsurfRule(root: string, store: HunchStore): string {
  const file = join(root, ".windsurf", "rules", "hunch.md");
  const body = `---\ntrigger: always_on\ndescription: Hunch engineering memory — consult the hunch_* MCP tools before editing\n---\n\n${renderHunchSection(store, root)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

/** Cursor's hook API is beta, but its project-level config accepts this standard
 * event map. Context delivery is opportunistic; the always-on rule and MCP
 * registration remain the durable grounding path if a Cursor build suppresses
 * a hook's agent_message. */
export function writeCursorHooks(root: string, inv: Invocation): string {
  const file = join(root, ".cursor", "hooks.json");
  const command = hookCommand(inv, "cursor");
  const written = writeHookConfig(file, {
    sessionStart: [{ command }],
    beforeSubmitPrompt: [{ command }],
    preToolUse: [{ command }],
    postToolUse: [{ command }],
    stop: [{ command }],
  });
  const json = readJsonObj(written);
  if (json.version === undefined) {
    json.version = 1;
    writeJson(written, json);
  }
  return written;
}

/** VS Code's native workspace hook location. It supports all lifecycle events
 * Hunch needs and uses the same stdout contract as Claude Code, with different
 * camelCase tool fields normalized in core/agenthook.ts. */
export function writeVscodeHooks(root: string, inv: Invocation): string {
  const file = join(root, ".github", "hooks", "hunch.json");
  const command = hookCommand(inv, "vscode");
  return writeHookConfig(file, {
    SessionStart: [{ type: "command", command }],
    UserPromptSubmit: [{ type: "command", command }],
    PreToolUse: [{ type: "command", command }],
    PostToolUse: [{ type: "command", command }],
    Stop: [{ type: "command", command }],
  });
}

/** Windsurf's documented workspace hooks. It only supports deterministic
 * pre-hook blocking via exit code 2, so Hunch uses rules + MCP for context and
 * reserves the hook for strict edit protection and pipeline observation. */
export function writeWindsurfHooks(root: string, inv: Invocation): string {
  const file = join(root, ".windsurf", "hooks.json");
  const command = hookCommand(inv, "windsurf");
  return writeHookConfig(file, {
    pre_user_prompt: [{ command, show_output: false }],
    pre_write_code: [{ command, show_output: false }],
    post_write_code: [{ command, show_output: false }],
    post_run_command: [{ command, show_output: false }],
  });
}

function antigravityHandler(command: string): Record<string, unknown> {
  return { type: "command", command, timeout: 15 };
}

/** Antigravity keeps hook groups at the top level (not under `hooks`). Hunch
 * owns only the `hunch` group and replaces its own old entries idempotently. */
export function writeAntigravityHooks(root: string, inv: Invocation): string {
  const file = join(root, ".agents", "hooks.json");
  const json = readJsonObj(file);
  const group = json.hunch && typeof json.hunch === "object" && !Array.isArray(json.hunch)
    ? json.hunch as Record<string, unknown>
    : {};
  const command = hookCommand(inv, "antigravity");
  const keep = (event: string) => Array.isArray(group[event])
    ? group[event].filter((entry) => {
      const e = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      if (isHunchProviderHook(e)) return false;
      return !Array.isArray(e?.hooks) || !e.hooks.some((hook) => isHunchProviderHook(hook));
    })
    : [];
  group.PreInvocation = [...keep("PreInvocation"), antigravityHandler(command)];
  group.PreToolUse = [
    ...keep("PreToolUse"),
    {
      matcher: "write_to_file|replace_file_content|multi_replace_file_content",
      hooks: [antigravityHandler(command)],
    },
  ];
  group.Stop = [...keep("Stop"), antigravityHandler(command)];
  json.hunch = group;
  return writeJson(file, json);
}

/** Rewrite the auto-maintained Hunch section in EVERY assistant grounding doc
 *  (CLAUDE.md, AGENTS.md, Copilot instructions, Cursor + Windsurf rules) from the
 *  current store — without touching the MCP/provider config files. `hunch private
 *  --migrate` calls this AFTER emptying the public store so the committed public
 *  docs reflect that no engineering memory is published here (renderHunchSection
 *  reads the public store only, so private records never leak into them). */
export function regenerateGrounding(root: string, store: HunchStore): string[] {
  return [
    updateClaudeMd(root, store),
    writeAgentsMd(root, store),
    writeCopilotInstructions(root, store),
    writeCursorRule(root, store),
    writeWindsurfRule(root, store),
  ];
}

/** Self-heal: refresh the Hunch section in each grounding doc that ALREADY exists,
 *  and report which ones actually changed. Unlike regenerateGrounding it NEVER creates
 *  a file (so it can't scaffold grounding into a project that opted out of an
 *  assistant). Run by `hunch index` and non-hook `hunch sync` so a project silently
 *  picks up generator fixes (e.g. corrected MCP tool param names) and fresh record
 *  counts on the next refresh — no manual `hunch init`. Not run from the commit hook,
 *  which deliberately avoids dirtying the working tree on every commit. */
export function refreshExistingGrounding(root: string, store: HunchStore): string[] {
  const targets: Array<[string, () => string]> = [
    ["CLAUDE.md", () => updateClaudeMd(root, store)],
    ["AGENTS.md", () => writeAgentsMd(root, store)],
    [join(".github", "copilot-instructions.md"), () => writeCopilotInstructions(root, store)],
    [join(".cursor", "rules", "hunch.mdc"), () => writeCursorRule(root, store)],
    [join(".windsurf", "rules", "hunch.md"), () => writeWindsurfRule(root, store)],
  ];
  const changed: string[] = [];
  for (const [rel, write] of targets) {
    const file = join(root, rel);
    if (!existsSync(file)) continue; // refresh-only: never scaffold a doc the project doesn't have
    const before = readFileSync(file, "utf8");
    write();
    if (readFileSync(file, "utf8") !== before) changed.push(rel);
  }
  return changed;
}

export interface ProviderScaffold {
  assistant: string;
  files: string[];
  /** Set when this assistant was skipped (e.g. an unparseable existing config we
   *  refused to clobber) — surfaced as a warning, not a fatal init failure. */
  error?: string;
}

/** A malformed configuration for one surface (for example an MCP file) must not
 * prevent the same assistant's rule or lifecycle hook from being installed. */
function runProvider(writers: Array<() => string | string[]>): Omit<ProviderScaffold, "assistant"> {
  const files: string[] = [];
  const errors: string[] = [];
  for (const write of writers) {
    try {
      const result = write();
      files.push(...(Array.isArray(result) ? result : [result]));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { files, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

/** Scaffold MCP config + grounding for all supported assistants. Returns a
 *  per-assistant summary for `hunch init` to print. Each assistant is isolated:
 *  a writer that refuses to clobber a malformed file degrades to a warning rather
 *  than aborting the rest. Claude Code is handled separately by scaffold.ts. */
export function scaffoldProviders(root: string, inv: Invocation, store: HunchStore, options: { agentHooks?: boolean; home?: string } = {}): ProviderScaffold[] {
  const hooks = options.agentHooks !== false;
  const home = options.home;
  const tasks: Array<[string, () => Omit<ProviderScaffold, "assistant">]> = [
    ["Cursor", () => runProvider([() => writeCursorMcp(root, inv), () => writeCursorRule(root, store), ...(hooks ? [() => writeCursorHooks(root, inv)] : [])])],
    ["VS Code (Copilot)", () => runProvider([() => writeVscodeMcp(root, inv), () => writeCopilotInstructions(root, store), ...(hooks ? [() => writeVscodeHooks(root, inv)] : [])])],
    ["Codex CLI", () => runProvider([() => writeCodexConfig(root, inv)])],
    ["Windsurf", () => {
      return runProvider([
        () => writeWindsurfMcp(root, inv),
        () => writeWindsurfRule(root, store),
        ...(hooks ? [() => writeWindsurfHooks(root, inv)] : []),
        () => { const global = writeWindsurfGlobalMcp(inv, home); return global ?? []; },
      ]);
    }],
    ["Google Antigravity", () => {
      return runProvider([
        () => writeAntigravityWorkspaceMcp(root, inv),
        ...(hooks ? [() => writeAntigravityHooks(root, inv)] : []),
        () => { const global = writeAntigravityMcp(inv, home); return global ?? []; },
      ]);
    }],
    ["Any (AGENTS.md)", () => runProvider([() => writeAgentsMd(root, store)])],
  ];
  return tasks.map(([assistant, run]) => ({ assistant, ...run() }));
}
