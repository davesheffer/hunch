/**
 * Hook-overhead switches: lean grounding, quiet-empty hooks and the hook daemon.
 * Each resolves, highest first:
 *   1. the env var (HUNCH_LEAN_GROUNDING / HUNCH_QUIET_EMPTY / HUNCH_HOOK_DAEMON):
 *      1/true/on or 0/false/off; lean grounding also takes "preserve";
 *   2. `.hunch/config.json` → `hooks.<name>` (committed, so a whole team shares it):
 *      true/false; `lean_grounding` also takes "preserve";
 *   3. the default: on.
 * An unrecognized value at any level is ignored and the next level decides.
 * "preserve" keeps a committed grounding block in the variant it was written in.
 *
 * Read on every call (a hook may run in a long-lived daemon), with the parsed file
 * cached by mtime and size. Never throws. Deliberately imports nothing beyond node
 * built-ins: the hook-daemon client bundle loads it.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type HookSwitchName = "lean_grounding" | "quiet_empty" | "daemon";
export type HookSwitchValue = boolean | "preserve";
export interface HookSwitchSetting {
  value: HookSwitchValue;
  source: "env" | "config" | "default";
}

export const HOOK_SWITCH_NAMES: readonly HookSwitchName[] = ["lean_grounding", "quiet_empty", "daemon"];
export const HOOK_SWITCH_ENV: Readonly<Record<HookSwitchName, string>> = {
  lean_grounding: "HUNCH_LEAN_GROUNDING",
  quiet_empty: "HUNCH_QUIET_EMPTY",
  daemon: "HUNCH_HOOK_DAEMON",
};

interface ConfigHooksRead { hooks: Record<string, unknown> | null; problems: string[] }
const cache = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; read: ConfigHooksRead }>();

/** Parse `hooks` out of `.hunch/config.json`, noting why a present file yields no
 *  usable switch (unparseable, `hooks` not an object, a misspelled key) so `hunch
 *  switches` can say so instead of silently reporting the defaults. */
function readConfigHooks(root: string): ConfigHooksRead {
  try {
    const file = join(root, ".hunch", "config.json");
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) return { hooks: null, problems: [] };
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size) return hit.read;
    const read = parseConfigHooks(readFileSync(file, "utf8"));
    cache.set(file, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, read });
    return read;
  } catch (error) {
    return { hooks: null, problems: [`.hunch/config.json could not be read (${error instanceof Error ? error.message : String(error)})`] };
  }
}

function parseConfigHooks(text: string): ConfigHooksRead {
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { hooks: null, problems: [`.hunch/config.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); its hooks.* switches are ignored`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { hooks: null, problems: [".hunch/config.json is not a JSON object; its hooks.* switches are ignored"] };
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(obj)) {
    if (k !== "hooks" && k.toLowerCase().replace(/[^a-z]/g, "") === "hook") problems.push(`.hunch/config.json has "${k}"; did you mean "hooks"?`);
  }
  if (obj.hooks === undefined) return { hooks: null, problems };
  if (!obj.hooks || typeof obj.hooks !== "object" || Array.isArray(obj.hooks)) {
    problems.push(`.hunch/config.json "hooks" is not an object; its switches are ignored`);
    return { hooks: null, problems };
  }
  const hooks = obj.hooks as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  for (const k of Object.keys(hooks)) {
    if ((HOOK_SWITCH_NAMES as readonly string[]).includes(k)) continue;
    const near = HOOK_SWITCH_NAMES.find((n) => norm(n) === norm(k));
    problems.push(`.hunch/config.json hooks.${k} is not a switch${near ? `; did you mean hooks.${near}?` : ` (known: ${HOOK_SWITCH_NAMES.join(", ")})`}`);
  }
  return { hooks, problems };
}

function configHooks(root: string): Record<string, unknown> | null {
  return readConfigHooks(root).hooks;
}

/** Why `.hunch/config.json` contributes no (or fewer) switches than it seems to. */
export function hookConfigProblems(root: string): string[] {
  return readConfigHooks(root).problems;
}

/** A recognized switch value, or undefined (the next level decides). */
export function parseHookSwitch(name: HookSwitchName, raw: unknown): HookSwitchValue | undefined {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (v === true || v === "1" || v === "true" || v === "on") return true;
  if (v === false || v === "0" || v === "false" || v === "off") return false;
  if (name === "lean_grounding" && v === "preserve") return "preserve";
  return undefined;
}

export function hookSwitch(name: HookSwitchName, root?: string, env: NodeJS.ProcessEnv = process.env): HookSwitchSetting {
  // Literal names, so the env-surface gate can see each read.
  const raw = name === "lean_grounding" ? env.HUNCH_LEAN_GROUNDING
    : name === "quiet_empty" ? env.HUNCH_QUIET_EMPTY
    : env.HUNCH_HOOK_DAEMON;
  const fromEnv = parseHookSwitch(name, raw);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  if (root) {
    const hooks = configHooks(root);
    const fromConfig = hooks ? parseHookSwitch(name, hooks[name]) : undefined;
    if (fromConfig !== undefined) return { value: fromConfig, source: "config" };
  }
  return { value: true, source: "default" };
}

/** Values set for a switch that no level recognized (so the next level decided), as
 *  "where=value" strings, for `hunch switches` to flag a mistyped opt-out. */
export function ignoredHookSwitchValues(name: HookSwitchName, root?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const raw = name === "lean_grounding" ? env.HUNCH_LEAN_GROUNDING
    : name === "quiet_empty" ? env.HUNCH_QUIET_EMPTY
    : env.HUNCH_HOOK_DAEMON;
  if (raw !== undefined && raw.trim() !== "" && parseHookSwitch(name, raw) === undefined) out.push(`${HOOK_SWITCH_ENV[name]}=${JSON.stringify(raw)}`);
  const hooks = root ? configHooks(root) : null;
  if (hooks && hooks[name] !== undefined && parseHookSwitch(name, hooks[name]) === undefined) out.push(`.hunch/config.json hooks.${name}=${JSON.stringify(hooks[name])}`);
  return out;
}
