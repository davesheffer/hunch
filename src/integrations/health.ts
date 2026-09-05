/** Repository integration checks. Configuration is evidence of wiring, never
 * evidence that a host delivered context or enforced a decision. */
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseJsonc } from "../core/jsonc.js";
import { writeFileAtomic } from "../core/io.js";
import { HUNCH_VERSION } from "../core/version.js";
import { readConfig } from "../core/config.js";
import { hunchPaths } from "../core/paths.js";

export const CAPABILITIES = ["mcp", "context", "edit-blocking", "failure-capture", "compaction"] as const;
export type Capability = typeof CAPABILITIES[number];
export type HealthStatus = "verified" | "advisory-only" | "unsupported" | "untested";
export const HARNESSES = {
  claude: { mcp: ".mcp.json", hooks: ".claude/settings.json", key: "mcpServers", events: ["SessionStart", "PreToolUse", "PostToolUseFailure", "PreCompact"] },
  codex: { mcp: ".codex/config.toml", hooks: "", key: "", events: [] },
  cursor: { mcp: ".cursor/mcp.json", hooks: ".cursor/hooks.json", key: "mcpServers", events: ["sessionStart", "preToolUse", "postToolUse", ""] },
  vscode: { mcp: ".vscode/mcp.json", hooks: ".github/hooks/hunch.json", key: "servers", events: ["SessionStart", "PreToolUse", "PostToolUse", ""] },
  windsurf: { mcp: ".windsurf/mcp_config.json", hooks: ".windsurf/hooks.json", key: "mcpServers", events: ["", "pre_write_code", "post_run_command", ""] },
  antigravity: { mcp: ".agents/mcp_config.json", hooks: ".agents/hooks.json", key: "mcpServers", events: ["PreInvocation", "PreToolUse", "", ""] },
} as const;
export type Harness = keyof typeof HARNESSES;
type Obj = Record<string, unknown>;
export interface HealthIssue { file: string; code: string; detail: string }
export interface HarnessHealth {
  harness: Harness;
  capabilities: Record<Capability, { status: HealthStatus; detail: string }>;
}
export interface IntegrationHealth {
  schema: "hunch.integration-health/1";
  expectedVersion: string;
  scope: "repository-config";
  issues: HealthIssue[];
  harnesses: HarnessHealth[];
}
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const pinPattern = /@davesheffer\/hunch@([^\s"'\],;]+)/g;
const object = (v: unknown): Obj => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a configuration object");
  return v as Obj;
};
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function hookCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hookCommands);
  if (!value || typeof value !== "object") return [];
  const obj = value as Obj;
  if (obj.enabled === false || (obj.type !== undefined && obj.type !== "command")) return [];
  const command = typeof obj.command === "string" ? obj.command : "";
  const own = /(?:@davesheffer\/hunch|[\\/]index\.(?:js|ts))/.test(command)
    && /\s"?hook"?(?:\s+"?--provider"?\s+"?[a-z]+"?)?\s*$/.test(command);
  return [...(own ? [command] : []), ...(obj.hooks ? hookCommands(obj.hooks) : [])];
}
/** Pin repair is restricted to Hunch's marker-owned TOML block. */
function codexBlock(raw: string): string {
  const start = "# >>> hunch mcp (managed) >>>";
  const end = "# <<< hunch mcp <<<";
  if (raw.split(start).length !== 2 || raw.split(end).length !== 2) throw new Error("managed Hunch TOML block missing or duplicated; run hunch init after reviewing custom configuration");
  const begin = raw.indexOf(start), finish = raw.indexOf(end);
  if (finish < begin) throw new Error("malformed managed Hunch TOML block");
  const block = raw.slice(begin + start.length, finish);
  if ((raw.match(/^\s*\[mcp_servers\.hunch\]/gm) ?? []).length !== 1) throw new Error("missing or duplicate Hunch MCP table");
  if (!/^\s*\[mcp_servers\.hunch\]\s*$/m.test(block)) throw new Error("Hunch table is outside its managed block");
  return block;
}
export function readLauncher(root: string, harness: Harness): { command: string; args: string[]; customEnvironment: boolean } {
  const spec = HARNESSES[harness];
  const raw = readFileSync(join(root, spec.mcp), "utf8");
  let config: Obj;
  if (harness === "codex") {
    config = object(object(parseToml(raw).mcp_servers).hunch);
  } else {
    config = object(object(object(parseJsonc(raw))[spec.key]).hunch);
  }
  if (config.enabled === false || config.disabled === true) throw new Error("Hunch MCP server is disabled");
  if (typeof config.command !== "string" || !config.command.trim() || !Array.isArray(config.args) || !config.args.every(a => typeof a === "string")) throw new Error("expected a local stdio command and string arguments");
  return { command: config.command, args: config.args as string[], customEnvironment: ["env", "env_vars", "cwd"].some(key => config[key] !== undefined) };
}
function expectedVersion(root: string): string {
  const file = join(root, "package.json");
  if (!existsSync(file)) return HUNCH_VERSION;
  const manifest = object(JSON.parse(readFileSync(file, "utf8")));
  const declarations = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]
    .filter(Boolean).map(object).map(deps => deps["@davesheffer/hunch"]).filter(v => v !== undefined);
  if (new Set(declarations).size > 1) throw new Error("conflicting Hunch dependency versions");
  const version = declarations[0] ?? (manifest.name === "@davesheffer/hunch" ? manifest.version : HUNCH_VERSION);
  if (typeof version !== "string" || !exactVersion.test(version)) throw new Error("pin @davesheffer/hunch to an exact version in package.json before checking integrations");
  return version;
}

export function inspectIntegrations(root: string, selected?: Harness): IntegrationHealth {
  const report: IntegrationHealth = { schema: "hunch.integration-health/1", expectedVersion: HUNCH_VERSION, scope: "repository-config", issues: [], harnesses: [] };
  try { report.expectedVersion = expectedVersion(root); }
  catch (e) { report.issues.push({ file: "package.json", code: "dependency-version", detail: (e as Error).message }); }
  const firmness = readConfig(hunchPaths(root)).firmness;
  const recordPins = (file: string, values: string[]) => {
    for (const value of values) {
      const pins = [...value.matchAll(pinPattern)];
      if (value.includes("@davesheffer/hunch") && !pins.length) report.issues.push({ file, code: "unpinned-package", detail: "Hunch npm launcher has no exact version; run hunch init with the intended version" });
      for (const [, version] of pins) {
        if (version !== report.expectedVersion) report.issues.push({ file, code: "version-drift", detail: `Hunch ${version} differs from expected ${report.expectedVersion}; run hunch integrations repair-pins` });
      }
    }
  };
  for (const harness of selected ? [selected] : Object.keys(HARNESSES) as Harness[]) {
    const spec = HARNESSES[harness];
    if (!selected && !existsSync(join(root, spec.mcp)) && (!spec.hooks || !existsSync(join(root, spec.hooks)))) continue;
    const capabilities = Object.fromEntries(CAPABILITIES.map(c => [c, { status: "untested", detail: "No runtime evidence" }])) as HarnessHealth["capabilities"];
    report.harnesses.push({ harness, capabilities });
    try {
      const launcher = readLauncher(root, harness);
      recordPins(spec.mcp, [launcher.command, ...launcher.args]);
      capabilities.mcp.detail = "Configured locally; use --probe to verify a fresh server, then reconnect the host";
    } catch (e) {
      report.issues.push({ file: spec.mcp, code: "mcp-config", detail: (e as Error).message });
      capabilities.mcp.detail = "MCP configuration missing, disabled, invalid, or outside supported inspection format";
    }
    let events: Obj = {};
    let disabled = false;
    if (spec.hooks) {
      try {
        const config = object(parseJsonc(readFileSync(join(root, spec.hooks), "utf8")));
        disabled = config.disableAllHooks === true;
        events = object(harness === "antigravity" ? config.hunch : config.hooks);
        recordPins(spec.hooks, Object.values(events).flatMap(hookCommands));
      } catch (e) { report.issues.push({ file: spec.hooks, code: "hook-config", detail: (e as Error).message }); }
    }
    for (const [i, capability] of (["context", "edit-blocking", "failure-capture", "compaction"] as const).entries()) {
      const event = spec.events[i];
      const status = capabilities[capability];
      if (!event) {
        status.status = capability === "context" ? "advisory-only" : "unsupported";
        status.detail = capability === "context" ? "Hunch relies on instructions and voluntary MCP calls on this adapter" : "No Hunch lifecycle adapter for this capability";
      } else if (disabled || firmness === "off" || ((capability === "failure-capture") && process.env.HUNCH_PIPELINE === "0")) {
        status.status = "unsupported";
        status.detail = "Disabled by local hook settings, firmness, or HUNCH_PIPELINE";
      } else if (!hookCommands(events[event]).some(command => {
        const dialect = command.match(/"?--provider"?\s+"?([a-z]+)"?/i)?.[1]?.toLowerCase() ?? "claude";
        return dialect === harness;
      })) {
        status.detail = `Missing Hunch ${event} handler`;
        report.issues.push({ file: spec.hooks, code: "missing-hook", detail: status.detail });
      } else if (capability === "edit-blocking" && firmness !== "strict") {
        status.status = "advisory-only";
        status.detail = `firmness=${firmness}; edits are not blocked`;
      } else {
        status.detail = `${event} configured; host delivery, matchers, and tool coverage are not verified`;
      }
    }
  }
  if (!report.harnesses.length) report.issues.push({ file: ".", code: "no-integrations", detail: "No repository integrations found; global and managed host settings are not inspected" });
  return report;
}

/** Repair only exact published pins. Preserve formatting and all other values.
 * Preflight every affected file before writing any; reject malformed JSON/TOML. */
export function repairIntegrationPins(root: string): string[] {
  const version = expectedVersion(root);
  const pending: Array<{ file: string; before: string; after: string }> = [];
  for (const [name, spec] of Object.entries(HARNESSES)) {
    for (const file of [spec.mcp, spec.hooks].filter(Boolean)) {
      const path = join(root, file);
      if (!existsSync(path)) continue;
      // Never follow a config symlink or symlinked parent into another project.
      let current = resolve(root);
      for (const part of file.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error(`refusing to rewrite symlink: ${file}`); }
      const before = readFileSync(path, "utf8");
      const replace = (text: string) => text.replace(pinPattern, (match, old: string) => {
        if (!exactVersion.test(old)) throw new Error(`refusing non-exact Hunch pin in ${file}`);
        return `@davesheffer/hunch@${version}`;
      });
      let after: string;
      if (name === "codex") {
        readLauncher(root, "codex");
        const block = codexBlock(before);
        const table = object(object(parseToml(block).mcp_servers).hunch);
        if (Object.keys(table).some(key => !["command", "args"].includes(key))) throw new Error(`custom managed settings require manual pin repair: ${file}`);
        // Replace only the canonical args line, never comments or another table.
        const lines = block.split("\n");
        if (lines.some(line => line.trim() && !line.trim().startsWith("#") && !/^\s*(?:\[mcp_servers\.hunch\]|command\s*=|args\s*=)/.test(line))) throw new Error(`custom managed TOML requires manual pin repair: ${file}`);
        const next = lines.map(line => /^\s*args\s*=/.test(line) ? replace(line.split("#")[0]!) + (line.includes("#") ? `#${line.split("#").slice(1).join("#")}` : "") : line).join("\n");
        after = before.replace(block, next);
        parseToml(after);
      } else {
        const config = object(parseJsonc(before));
        const values = file === spec.mcp
          ? strings(object(object(config[spec.key]).hunch).args)
          : Object.values(object(name === "antigravity" ? config.hunch : config.hooks)).flatMap(hookCommands);
        const replacements = new Map(values.map(v => [v, replace(v)]).filter(([a, b]) => a !== b) as Array<[string, string]>);
        const counts = new Map<string, number>();
        // Tokenize comments too, so a quoted command in a comment is untouched.
        after = before.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"/g, token => {
          if (!token.startsWith('"')) return token;
          const value = JSON.parse(token) as string;
          const replacement = replacements.get(value);
          if (replacement !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
          return replacement !== undefined && replacement !== value ? JSON.stringify(replacement) : token;
        });
        for (const [value, count] of counts) {
          if (count !== values.filter(v => v === value).length) throw new Error(`ambiguous Hunch string also appears outside managed settings in ${file}; refusing repair`);
        }
      }
      if (before !== after) pending.push({ file, before, after });
    }
  }
  for (const { file, before } of pending) if (readFileSync(join(root, file), "utf8") !== before) throw new Error(`${file} changed during repair; retry`);
  for (const { file, after } of pending) writeFileAtomic(join(root, file), after);
  return pending.map(p => p.file);
}

export function integrationHealthFails(report: IntegrationHealth, required: readonly Capability[] = []): boolean {
  return report.issues.length > 0 || report.harnesses.some(h => required.some(c => h.capabilities[c].status !== "verified"));
}
export function formatIntegrationHealth(report: IntegrationHealth): string {
  return [
    `Hunch integrations — expected ${report.expectedVersion} (repository configuration only)`,
    ...report.harnesses.map(h => `${h.harness}:\n${CAPABILITIES.map(c => `  ${c}: ${h.capabilities[c].status} — ${h.capabilities[c].detail}`).join("\n")}`),
    ...report.issues.map(i => `ERROR ${i.file}: ${i.detail}`),
    "Configured hooks are untested until exercised inside the host. Global settings, active sessions, and model compliance are not verified.",
  ].join("\n");
}

/** Bounded session warning; diagnostics must never break hook execution. */
export function integrationSessionWarning(root: string, harness: Harness): string {
  try {
    const report = inspectIntegrations(root, harness);
    if (!report.issues.length) return "";
    const issues = [...new Set(report.issues.map(i => `${i.file}: ${i.detail}`))];
    return `Hunch integration needs attention: ${issues.slice(0, 3).join("; ").slice(0, 1200)}. Run hunch integrations check; do not assume full harness coverage.`;
  } catch { return ""; }
}
