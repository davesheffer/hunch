/** Repository integration checks. Configuration is evidence of wiring, never
 * evidence that a host delivered context or enforced a decision. */
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseJsonc } from "../core/jsonc.js";
import { writeFileAtomic } from "../core/io.js";
import { HUNCH_VERSION } from "../core/version.js";
import { readConfig } from "../core/config.js";
import { hunchPaths } from "../core/paths.js";
import { readHookObservations, type HookObservation } from "../core/hookObservations.js";

/** Normalized hook events that prove each capability was delivered by the host. */
const CAPABILITY_EVIDENCE: Record<Exclude<Capability, "mcp">, readonly string[]> = {
  context: ["SessionStart", "UserPromptSubmit"],
  "edit-blocking": ["PreToolUse"],
  // A successful PostToolUse only proves that the post hook ran. A provider
  // may instead include an explicit failure status in that same event.
  "failure-capture": ["PostToolUseFailure", "PostToolUse"],
  compaction: ["PreCompact"],
};
const OBSERVATION_FRESH_MS = 30 * 86_400_000;

export const CAPABILITIES = ["mcp", "context", "edit-blocking", "failure-capture", "compaction"] as const;
export type Capability = typeof CAPABILITIES[number];
export type HealthStatus = "verified" | "advisory-only" | "unsupported" | "untested";
export const HARNESSES = {
  claude: { mcp: ".mcp.json", hooks: ".claude/settings.json", key: "mcpServers", events: ["SessionStart", "PreToolUse", "PostToolUseFailure", "PreCompact"] },
  codex: { mcp: ".codex/config.toml", hooks: ".codex/hooks.json", key: "hooks", events: ["SessionStart", "PreToolUse", "PostToolUse", "PreCompact"] },
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
  /** Every exact Hunch pin found in repository launch config, once per file+version. */
  pins: Array<{ file: string; version: string }>;
}
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const pinPattern = /@davesheffer\/hunch@([^\s"'\],;]+)/g;
const object = (v: unknown): Obj => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a configuration object");
  return v as Obj;
};
function evidenceFor(capability: Exclude<Capability, "mcp">, harness: Harness, observed: HookObservation[], expectedVersion: string): HookObservation | undefined {
  const matches = observed.filter(o => o.provider === harness && (
    capability !== "failure-capture"
      ? CAPABILITY_EVIDENCE[capability].includes(o.event)
      : o.event === "PostToolUseFailure" || (o.event === "PostToolUse" && o.outcome === "failure")
  ));
  // A stale row must not hide a fresh result recorded by a newer hook. Keep a
  // matching stale row as the fallback so the caller can explain why it is not
  // verified rather than treating the evidence as absent.
  return matches.find(o => o.version === expectedVersion && Date.now() - Date.parse(o.at) <= OBSERVATION_FRESH_MS) ?? matches[0];
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function hookCommands(value: unknown, includeDisabled = false): string[] {
  if (Array.isArray(value)) return value.flatMap(v => hookCommands(v, includeDisabled));
  if (!value || typeof value !== "object") return [];
  const obj = value as Obj;
  if ((!includeDisabled && obj.enabled === false) || (obj.type !== undefined && obj.type !== "command")) return [];
  const command = typeof obj.command === "string" ? obj.command : "";
  const own = publishedHookCommand(command) !== undefined || /(?:dist|src)[\\/]+cli[\\/]+index\.(?:js|ts)/.test(command)
    && /\s"?hook"?(?:\s+"?--provider"?\s+"?[a-z]+"?)?\s*$/.test(command);
  return [...(own ? [command] : []), ...(obj.hooks ? hookCommands(obj.hooks, includeDisabled) : [])];
}

/** Recognize only generated npm commands, including their legacy quoted form.
 * Never normalize a wrapper, shell expression, or another program's arguments. */
function publishedHookCommand(command: string): string | undefined {
  const parts = command.trim().match(/"[^"\\]*"|'[^']*'|[^\s"'\\]+/g);
  if (!parts || parts.join(" ") !== command.trim().replace(/\s+/g, " ")) return undefined;
  const tokens = parts.map(p => /^["']/.test(p) ? p.slice(1, -1) : p);
  if (tokens.some(token => /\s/.test(token))) return undefined;
  const bare = tokens.join(" ");
  return /^npx(?:\.cmd)? (?:-y|--yes) --package=(?:hunch-exact@npm:)?@davesheffer\/hunch@[0-9A-Za-z.+-]+ (?:-- )?hunch (?:mcp )?hook(?: --provider [a-z]+)?$/.test(bare) ? bare : undefined;
}
function misroutedHook(command: string): boolean {
  return publishedHookCommand(command)?.includes(" hunch mcp hook") ?? false;
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
  const report: IntegrationHealth = { schema: "hunch.integration-health/1", expectedVersion: HUNCH_VERSION, scope: "repository-config", issues: [], harnesses: [], pins: [] };
  try { report.expectedVersion = expectedVersion(root); }
  catch (e) { report.issues.push({ file: "package.json", code: "dependency-version", detail: (e as Error).message }); }
  const firmness = readConfig(hunchPaths(root)).firmness;
  const recordPins = (file: string, values: string[]) => {
    for (const value of values) {
      const pins = [...value.matchAll(pinPattern)];
      if (value.includes("@davesheffer/hunch") && !pins.length) report.issues.push({ file, code: "unpinned-package", detail: "Hunch npm launcher has no exact version; run hunch init with the intended version" });
      for (const [, version = ""] of pins) {
        if (!report.pins.some(p => p.file === file && p.version === version)) report.pins.push({ file, version });
        if (version !== report.expectedVersion) report.issues.push({ file, code: "version-drift", detail: `Hunch ${version} differs from expected ${report.expectedVersion}; run hunch integrations repair-pins` });
      }
    }
  };
  // Machine-local runtime evidence; an unreadable ledger simply leaves hooks untested.
  let observed: HookObservation[] = [];
  try { observed = readHookObservations(root); } catch { observed = []; }
  for (const harness of selected ? [selected] : Object.keys(HARNESSES) as Harness[]) {
    const spec = HARNESSES[harness];
    if (!selected && !existsSync(join(root, spec.mcp)) && (!spec.hooks || !existsSync(join(root, spec.hooks)))) continue;
    const capabilities = Object.fromEntries(CAPABILITIES.map(c => [c, { status: "untested", detail: "No runtime evidence" }])) as HarnessHealth["capabilities"];
    report.harnesses.push({ harness, capabilities });
    const mcpPath = join(root, spec.mcp);
    const hooksFileExists = Boolean(spec.hooks && existsSync(join(root, spec.hooks)));
    let mcpEntryAbsent = false;
    try { lstatSync(mcpPath); }
    catch (e) { mcpEntryAbsent = (e as NodeJS.ErrnoException).code === "ENOENT"; }
    try {
      const launcher = readLauncher(root, harness);
      recordPins(spec.mcp, [launcher.command, ...launcher.args]);
      capabilities.mcp.detail = "Configured locally; use --probe to verify a fresh server, then reconnect the host";
    } catch (e) {
      // A harness can be detected here via its hooks file alone —
      // some hooks files are deliberately committed while their MCP config is
      // a per-clone, gitignored scaffold (e.g. this repo's own
      // .windsurf/hooks.json). On a fresh checkout that config simply doesn't
      // exist yet, which is a "not configured on this machine" state, not a
      // repository-level misconfiguration — it must stay `untested`
      // (informational, matching every other not-yet-evidenced capability
      // here), not a hard `issues` entry that fails `hunch doctor` on every
      // clone forever. A file that EXISTS but is malformed/disabled/
      // unreadable in some other way is still a genuine issue.
      // lstat distinguishes a truly absent per-machine file from a dangling
      // symlink. The latter is a broken configuration and must remain loud.
      const notConfiguredHere = !selected && hooksFileExists && mcpEntryAbsent && (e as NodeJS.ErrnoException).code === "ENOENT";
      if (!notConfiguredHere) report.issues.push({ file: spec.mcp, code: "mcp-config", detail: (e as Error).message });
      capabilities.mcp.detail = notConfiguredHere
        ? "Not configured on this machine — a hooks file exists, but no local MCP config exists yet; run `hunch init` or set up this host"
        : "MCP configuration disabled, invalid, or outside supported inspection format";
    }
    let events: Obj = {};
    let disabled = false;
    // A hooks file that was never written is a coverage gap (the adapter is
    // not installed), not configuration drift: report it, never fail on it.
    // `--require` still refuses, because nothing unverified counts.
    const hooksAbsent = !!spec.hooks && !existsSync(join(root, spec.hooks));
    if (spec.hooks && !hooksAbsent) {
      try {
        const config = object(parseJsonc(readFileSync(join(root, spec.hooks), "utf8")));
        disabled = config.disableAllHooks === true;
        events = object(harness === "antigravity" ? config.hunch : config.hooks);
        const commands = Object.values(events).flatMap(v => hookCommands(v));
        recordPins(spec.hooks, commands);
        if (commands.some(misroutedHook)) report.issues.push({
          file: spec.hooks, code: "hook-command",
          detail: "Hunch hooks invoke the MCP subcommand instead of the hook handler; run hunch integrations repair-pins",
        });
      } catch (e) { report.issues.push({ file: spec.hooks, code: "hook-config", detail: (e as Error).message }); }
    }
    for (const [i, capability] of (["context", "edit-blocking", "failure-capture", "compaction"] as const).entries()) {
      const event = spec.events[i];
      const status = capabilities[capability];
      const matchesProvider = (command: string) => {
        if (misroutedHook(command)) return false;
        const dialect = (publishedHookCommand(command) ?? command).match(/"?--provider"?\s+"?([a-z]+)"?/i)?.[1]?.toLowerCase() ?? "claude";
        return dialect === harness;
      };
      if (!event) {
        status.status = capability === "context" ? "advisory-only" : "unsupported";
        status.detail = capability === "context" ? "Hunch relies on instructions and voluntary MCP calls on this adapter" : "No Hunch lifecycle adapter for this capability";
      } else if (hooksAbsent) {
        status.detail = `No ${spec.hooks}; run hunch init to install this host's lifecycle hooks`;
      } else if (disabled || firmness === "off" || ((capability === "failure-capture") && process.env.HUNCH_PIPELINE === "0")) {
        status.status = "unsupported";
        status.detail = "Disabled by local hook settings, firmness, or HUNCH_PIPELINE";
      } else if (!hookCommands(events[event]).some(matchesProvider)) {
        if (hookCommands(events[event], true).some(matchesProvider)) {
          status.status = "unsupported";
          status.detail = `Hunch ${event} handler disabled by local hook settings`;
        } else {
          status.detail = `Missing Hunch ${event} handler`;
          report.issues.push({ file: spec.hooks, code: "missing-hook", detail: status.detail });
        }
      } else if (capability === "edit-blocking" && firmness !== "strict") {
        status.status = "advisory-only";
        status.detail = `firmness=${firmness}; edits are not blocked`;
      } else {
        // Verified only by an event the host actually delivered, on the expected
        // version, recently. Matchers and tool coverage beyond that event stay unproven.
        const hit = evidenceFor(capability, harness, observed, report.expectedVersion);
        const fresh = hit !== undefined && Date.now() - Date.parse(hit.at) <= OBSERVATION_FRESH_MS;
        if (hit && fresh && hit.version === report.expectedVersion) {
          status.status = "verified";
          status.detail = `${hit.event} observed from the ${harness} host at ${hit.at} on Hunch ${hit.version}; matchers and tool coverage beyond that event are not verified`;
        } else if (hit) {
          status.detail = `${event} configured; last observed ${hit.at} on Hunch ${hit.version}${hit.version === report.expectedVersion ? " (stale)" : `, not the expected ${report.expectedVersion}`}`;
        } else if (capability === "failure-capture" && observed.some(o => o.provider === harness && o.event === "PostToolUse")) {
          status.detail = `${event} configured; PostToolUse was observed, but no explicit failed-tool event was delivered, so failure capture remains untested`;
        } else {
          status.detail = `${event} configured; host delivery, matchers, and tool coverage are not verified`;
        }
      }
    }
  }
  if (!report.harnesses.length) report.issues.push({ file: ".", code: "no-integrations", detail: "No repository integrations found; global and managed host settings are not inspected" });
  return report;
}

/** Harness launch files git ignores: this machine's config, never the tag's. A
 * release cut may keep these at the last published version (see
 * tooling/sync-version-pins.mjs) so hooks and MCP never point at a version npm
 * cannot serve. Unknown git state yields [] — callers then treat nothing as local. */
export function machineLocalIntegrationFiles(root: string): string[] {
  const files = Object.values(HARNESSES).flatMap(s => [s.mcp, s.hooks]).filter(f => f && existsSync(join(root, f)));
  if (!files.length) return [];
  const r = spawnSync("git", ["check-ignore", "--", ...files], { cwd: root, encoding: "utf8", windowsHide: true });
  if (r.error || (r.status !== 0 && r.status !== 1)) return [];
  return (r.stdout ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

/** Repair exact published pins and the known misplaced MCP hook subcommand.
 * Preserve formatting and all other values, including disabled hook settings.
 * Preflight every affected file before writing any; reject malformed JSON/TOML.
 * `skip` leaves a file untouched (used to keep machine-local pins on a version
 * npm can actually serve while a release is still publishing). */
export function repairIntegrationPins(root: string, opts: { skip?: (file: string) => boolean } = {}): string[] {
  const version = expectedVersion(root);
  const pending: Array<{ file: string; before: string; after: string }> = [];
  for (const [name, spec] of Object.entries(HARNESSES)) {
    for (const file of [spec.mcp, spec.hooks].filter(Boolean)) {
      const path = join(root, file);
      if (!existsSync(path) || opts.skip?.(file)) continue;
      // Never follow a config symlink or symlinked parent into another project.
      let current = resolve(root);
      for (const part of file.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error(`refusing to rewrite symlink: ${file}`); }
      const before = readFileSync(path, "utf8");
      const replace = (text: string) => text.replace(pinPattern, (match, old: string) => {
        if (!exactVersion.test(old)) throw new Error(`refusing non-exact Hunch pin in ${file}`);
        return `@davesheffer/hunch@${version}`;
      }).replace(/--package=@davesheffer\/hunch@/g, "--package=hunch-exact@npm:@davesheffer/hunch@");
      let after: string;
      if (name === "codex" && file === spec.mcp) {
        readLauncher(root, "codex");
        const block = codexBlock(before);
        const table = object(object(parseToml(block).mcp_servers).hunch);
        if (Object.keys(table).some(key => !["command", "args", "startup_timeout_sec"].includes(key))) throw new Error(`custom managed settings require manual pin repair: ${file}`);
        // Replace only the canonical args line, never comments or another table.
        const lines = block.split("\n");
        if (lines.some(line => line.trim() && !line.trim().startsWith("#") && !/^\s*(?:\[mcp_servers\.hunch\]|command\s*=|args\s*=|startup_timeout_sec\s*=)/.test(line))) throw new Error(`custom managed TOML requires manual pin repair: ${file}`);
        const next = lines.map(line => /^\s*args\s*=/.test(line) ? replace(line.split("#")[0]!) + (line.includes("#") ? `#${line.split("#").slice(1).join("#")}` : "") : line).join("\n");
        after = before.replace(block, next);
        parseToml(after);
      } else {
        const config = object(parseJsonc(before));
        const values = file === spec.mcp
          ? strings(object(object(config[spec.key]).hunch).args)
          : Object.values(object(name === "antigravity" ? config.hunch : config.hooks)).flatMap(v => hookCommands(v, true));
        const replacements = new Map(values.map(v => {
          // Every recognized npm token is shell-safe. Bare tokens also repair
          // the legacy quoted executable, which PowerShell treats as a string.
          const published = file === spec.hooks ? publishedHookCommand(v) : undefined;
          const repaired = published?.replace(" hunch mcp hook", " hunch hook") ?? v;
          return [v, replace(repaired)];
        }).filter(([a, b]) => a !== b) as Array<[string, string]>);
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
    "Hooks become verified only from lifecycle events observed inside the host on the expected version within 30 days. Global settings, active sessions, and model compliance are not verified.",
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
