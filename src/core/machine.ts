/**
 * Machine identity for the workspace ledger (docs/workspace-ledger.md): a random id
 * generated ONCE per machine and stored at the user level, so every clone on the
 * machine reports as the same machine. Deliberately NOT derived from the hostname,
 * a MAC address or a hardware serial — it identifies nothing outside Hunch. The
 * label is user-chosen; the default embeds nothing personal.
 *
 * Lives under the platform's per-user config root (XDG_CONFIG_HOME / %APPDATA% /
 * ~/.config) and, like updatecheck.ts, never creates a `.hunch` path segment: that
 * is findRoot()'s repository marker.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { MACHINE_ID, MACHINE_LABEL } from "./workspace.js";

export interface MachineIdentity {
  id: string;
  label: string;
  created_at: string;
}

export interface MachinePathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

const MAX_MACHINE_FILE_BYTES = 4096;

function configuredRoot(value: string | undefined, platform: NodeJS.Platform): string | null {
  if (!value) return null;
  const absolute = platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) : value.startsWith("/");
  const marker = value.replace(/\\/g, "/").split("/").some((part) => part.toLowerCase().replace(/[ .]+$/g, "") === ".hunch");
  return absolute && !marker ? value : null;
}

export function machineFile(opts: MachinePathOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const configHome = configuredRoot(env.XDG_CONFIG_HOME, platform)
    || (platform === "win32" && configuredRoot(env.APPDATA, platform))
    || join(home, ".config");
  return join(configHome, "hunch", "machine.json");
}

export function defaultMachineLabel(id: string): string {
  return `machine-${id.replace(/^mac_/, "").slice(0, 4)}`;
}

function readMachine(file: string): MachineIdentity | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MACHINE_FILE_BYTES) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<MachineIdentity>;
    if (typeof raw.id !== "string" || !MACHINE_ID.test(raw.id)) return null;
    const label = typeof raw.label === "string" && MACHINE_LABEL.test(raw.label) ? raw.label : defaultMachineLabel(raw.id);
    const created = typeof raw.created_at === "string" && Number.isFinite(Date.parse(raw.created_at)) ? raw.created_at : new Date(0).toISOString();
    return { id: raw.id, label, created_at: created };
  } catch {
    return null;
  }
}

/** Atomic, owner-only write: a half-written id file would mint a second machine. */
function writeMachine(file: string, identity: MachineIdentity): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}

/** The machine's identity, minted on first use. An unreadable or invalid file is
 *  replaced (a machine that lost its id simply becomes a new machine; the old record
 *  ages out as unverified and `hunch workspaces forget` removes it). */
export function loadOrCreateMachine(opts: MachinePathOptions = {}): MachineIdentity {
  const file = machineFile(opts);
  const existing = readMachine(file);
  if (existing) return existing;
  const id = `mac_${randomBytes(16).toString("hex")}`;
  const fresh: MachineIdentity = { id, label: defaultMachineLabel(id), created_at: new Date().toISOString() };
  writeMachine(file, fresh);
  return fresh;
}

export function setMachineLabel(label: string, opts: MachinePathOptions = {}): MachineIdentity {
  if (!MACHINE_LABEL.test(label)) {
    throw new Error("machine label must be 1-64 characters of letters, digits, '.', '_' or '-' and start with a letter or digit");
  }
  const next = { ...loadOrCreateMachine(opts), label };
  writeMachine(machineFile(opts), next);
  return next;
}

/** A label that equals the hostname or the OS username publishes personal data into a
 *  shared store; `doctor` and `label` warn, they do not refuse — the user chose it. */
export function labelLeaksIdentity(label: string): string | null {
  const lower = label.toLowerCase();
  let host = "";
  let user = "";
  try { host = hostname().toLowerCase(); } catch { /* unavailable */ }
  try { user = userInfo().username.toLowerCase(); } catch { /* unavailable */ }
  if (host && (lower === host || lower === host.split(".")[0])) return "hostname";
  if (user && lower === user) return "OS username";
  return null;
}
