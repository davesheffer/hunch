/**
 * Enforces "only a person approves, clears, replaces, retires, edits or re-links a rule"
 * inside the CLI. A person proves themselves either at an interactive terminal (typing
 * the rule id) or with a person token (HUNCH_PERSON_TOKEN) whose sha256 was stored by
 * `hunch person-token init`. This is a guard against agents acting by mistake with their normal
 * tools; it is not a defence against a determined program running as the same OS user.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

export interface PersonIO {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  /** Prompt the person and return the line they typed. */
  readLine?: (prompt: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export type PersonResult = { ok: true; via: "tty" | "token" } | { ok: false; message: string };

/** Directory holding `.hunch/person-token.json`: the account's home from the OS user database. HOME, USERPROFILE
 *  and HUNCH_HOME are deliberately ignored, so an agent cannot point the check at a store it wrote itself. */
export function personTokenHome(): string {
  return userInfo().homedir;
}

let heldToken: string | undefined;
/** Read HUNCH_PERSON_TOKEN from the process environment and remove it, so child processes (git, hooks) never
 *  inherit it. The value is kept in memory for later gates in this process. */
export function takePersonToken(): string | undefined {
  const fromEnv = process.env.HUNCH_PERSON_TOKEN;
  if (fromEnv !== undefined) heldToken = fromEnv || undefined;
  // Windows env names ignore case, so every spelling of the name is the token; no other key is touched.
  for (const key of Object.keys(process.env)) if (/^HUNCH_PERSON_TOKEN$/i.test(key)) delete process.env[key];
  return heldToken;
}
/** Test helper: forget a held token. */
export function resetHeldPersonToken(): void { heldToken = undefined; }

export function personTokenFile(home: string): string {
  return join(home, ".hunch", "person-token.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function checkToken(token: string, home: string): string | null {
  const file = personTokenFile(home);
  const refuse = (why: string) => `HUNCH_PERSON_TOKEN is set but ${why}. Refusing; no terminal fallback is used when a token is supplied.`;
  let st;
  try { st = lstatSync(file); } catch { return refuse("no person token is registered on this machine (run `hunch person-token init` in your own terminal)"); }
  if (st.isSymbolicLink()) return refuse("the person token file is a symlink");
  if (!st.isFile()) return refuse("the person token file is not a regular file");
  let stored: unknown;
  try { stored = JSON.parse(readFileSync(file, "utf8")); } catch { return refuse("the person token file is unreadable"); }
  const hex = (stored as { sha256?: unknown } | null)?.sha256;
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) return refuse("the person token file is malformed");
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hex, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse("the token does not match");
  return null;
}

/** Non-prompting check for flows that must never ask (`hunch test`, review-memory): true only when a valid
 *  person token is supplied. A terminal alone does not count here. */
export function personTokenVerified(io: { env?: NodeJS.ProcessEnv; home?: string } = {}): boolean {
  const token = io.env ? io.env.HUNCH_PERSON_TOKEN : takePersonToken();
  return !!token && checkToken(token, io.home ?? personTokenHome()) === null;
}

export async function requirePerson(action: string, ruleId: string, io: PersonIO = {}): Promise<PersonResult> {
  const token = io.env ? io.env.HUNCH_PERSON_TOKEN : takePersonToken();
  if (token) {
    const err = checkToken(token, io.home ?? personTokenHome());
    return err ? { ok: false, message: err } : { ok: true, via: "token" };
  }
  const tty = (io.stdinIsTTY ?? process.stdin.isTTY) === true && (io.stdoutIsTTY ?? process.stdout.isTTY) === true;
  if (tty) {
    const prompt = `Type ${ruleId} to confirm: ${action}: `;
    let answer: string;
    if (io.readLine) answer = await io.readLine(prompt);
    else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { answer = await rl.question(prompt); } finally { rl.close(); }
    }
    if (answer.trim() === ruleId) return { ok: true, via: "tty" };
    return { ok: false, message: `Not confirmed: typed text did not match ${ruleId}; nothing was changed.` };
  }
  return { ok: false, message: `Only a person can ${action}. Run this in your own terminal, or from the Nuryel control plane (it sends a person token). Agents: ask the user to run it.` };
}

/** Create (or rotate) the stored person-token hash. Returns the token, shown once; only its hash is written. */
export function initPersonToken(home: string, rotate: boolean, now = new Date()): { ok: true; token: string; file: string } | { ok: false; message: string } {
  const dir = join(home, ".hunch");
  const file = personTokenFile(home);
  const lst = (p: string) => { try { return lstatSync(p); } catch { return null; } };
  const dst = lst(dir);
  if (dst?.isSymbolicLink()) return { ok: false, message: `${dir} is a symlink; refusing to write a person token through it.` };
  if (dst && !dst.isDirectory()) return { ok: false, message: `${dir} is not a directory.` };
  const fst = lst(file);
  if (fst?.isSymbolicLink()) return { ok: false, message: `${file} is a symlink; refusing to replace it.` };
  if (fst && !rotate) return { ok: false, message: `A person token already exists at ${file}. Use --rotate to replace it (the old token stops working).` };
  if (fst && !fst.isFile()) return { ok: false, message: `${file} is not a regular file.` };
  if (!dst) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ v: 1, sha256: hashToken(token), created: now.toISOString() })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, message: `could not write ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, token, file };
}
