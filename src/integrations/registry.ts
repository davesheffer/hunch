/** Bounded npm registry lookups that never throw. A pin npm cannot serve makes
 * every `npx --package=…` launcher (hooks and MCP) fail before Hunch runs, and
 * the hosts report nothing — so the CLI must be able to name that state. */
import { spawnSync } from "node:child_process";

export type PublishedStatus = "published" | "unpublished" | "unknown";
export interface NpmResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type NpmRunner = (args: string[]) => NpmResult;

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function defaultNpmRunner(timeoutMs: number): NpmRunner {
  return (args) => {
    const windows = process.platform === "win32";
    const r = spawnSync(windows ? `npm ${args.join(" ")}` : "npm", windows ? [] : args, {
      shell: windows, windowsHide: true, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}

/** Whether npm can serve `@davesheffer/hunch@<version>`. "unknown" covers offline,
 * timeouts, and unexpected output; callers must never read it as unpublished. */
export function publishedStatus(version: string, opts: { timeoutMs?: number; run?: NpmRunner } = {}): PublishedStatus {
  if (!exactVersion.test(version)) return "unknown";
  const run = opts.run ?? defaultNpmRunner(opts.timeoutMs ?? 8000);
  let r: NpmResult;
  try { r = run(["view", `@davesheffer/hunch@${version}`, "version", "--json"]); } catch { return "unknown"; }
  if (r.error) return "unknown";
  if (r.status === 0) {
    try {
      const v: unknown = JSON.parse(r.stdout.trim() || "null");
      return v === version || (Array.isArray(v) && v.includes(version)) ? "published" : "unknown";
    } catch { return "unknown"; }
  }
  return /\b(?:ETARGET|E404|notarget)\b/.test(r.stderr) ? "unpublished" : "unknown";
}
