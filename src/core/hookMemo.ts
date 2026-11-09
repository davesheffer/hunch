/** Per-invocation memo for the hook.
 *
 * One hook event runs several lookups that ask git the same question (HEAD,
 * the dirty tree). Answers are kept here for the duration of ONE hook
 * invocation only: `beginHookInvocation()` clears them and switches memoizing
 * on, so a process that serves many requests (changing cwd/env between them)
 * never reads an answer from an earlier request. Outside a hook invocation
 * nothing is memoized. Keys always carry the repository root. */
import { execFileSync } from "node:child_process";

let active = false;
const store = new Map<string, unknown>();

/** Start a hook invocation: drop every memoized answer and enable memoizing. */
export function beginHookInvocation(): void {
  store.clear();
  active = true;
}

/** Memoize `compute` under `ns` + `root` (+ `key`) for the current invocation. */
export function memoized<T>(ns: string, root: string, key: string, compute: () => T): T {
  if (!active) return compute();
  const k = `${ns}\u0000${root}\u0000${key}`;
  if (store.has(k)) return store.get(k) as T;
  const value = compute();
  store.set(k, value);
  return value;
}

/** Memoized value for `ns`/`root`/`key`, or undefined. */
export function recall<T>(ns: string, root: string, key = ""): T | undefined {
  return active ? (store.get(`${ns}\u0000${root}\u0000${key}`) as T | undefined) : undefined;
}

/** Remember `value` for the current invocation (no-op outside one). */
export function remember<T>(ns: string, root: string, key: string, value: T): void {
  if (active) store.set(`${ns}\u0000${root}\u0000${key}`, value);
}

export interface HeadBlob { head: string | null; blob: string | null }

const OID = /^[0-9a-f]{40,64}$/;

/** HEAD and `HEAD:<file>` from ONE git call, shared by every lookup of this
 *  invocation. A file HEAD does not hold (new, untracked) makes git exit
 *  non-zero after printing HEAD, so the HEAD line is still taken. */
export function headAndBlob(root: string, file: string, env: NodeJS.ProcessEnv, timeoutMs: number): HeadBlob {
  return memoized("headblob", root, file, () => {
    let out = "";
    try {
      out = execFileSync("git", ["-C", root, "rev-parse", "HEAD", `HEAD:${file}`], { env, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      out = typeof stdout === "string" ? stdout : "";
    }
    const [head = "", blob = ""] = out.trim().split(/\r?\n/);
    const result: HeadBlob = { head: OID.test(head) ? head : null, blob: OID.test(blob) ? blob : null };
    if (result.head) remember("head", root, "", result.head);
    return result;
  });
}

/** The invocation's HEAD if some lookup already learned it. */
export function knownHead(root: string): string | undefined {
  return recall<string>("head", root);
}

/** True between `beginHookInvocation()` and the end of the process/request. */
export function hookActive(): boolean {
  return active;
}

/** End the invocation: drop every answer and stop memoizing. */
export function endHookInvocation(): void {
  store.clear();
  active = false;
}
