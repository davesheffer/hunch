/** Figures out how to re-invoke this CLI from a git hook / .mcp.json, working
 *  both when running the built dist (plain node) and in dev via tsx. */
import { fileURLToPath } from "node:url";
import type { Invocation } from "../integrations/scaffold.js";

export interface ResolvedInvocation {
  /** Shell command prefix for the git hook (e.g. `node /abs/dist/cli/index.js`). */
  shell: string;
  /** Structured command/args for .mcp.json (subcommand appended by the writer). */
  mcp: Invocation;
}

export function resolveInvocation(): ResolvedInvocation {
  const entry = fileURLToPath(import.meta.url).replace(/invocation\.(js|ts)$/, "index.$1");
  const isDev = entry.endsWith(".ts");
  // JSON.stringify yields a double-quoted, backslash-escaped token /bin/sh
  // accepts — so install paths with spaces don't break the hook command.
  const q = (s: string) => JSON.stringify(s);
  if (isDev) {
    return {
      shell: `npx tsx ${q(entry)}`,
      mcp: { command: "npx", args: ["tsx", entry] },
    };
  }
  // Use the absolute node binary (process.execPath) rather than a bare `node`,
  // so the hook works even when nvm's `node` isn't on the hook's PATH.
  return {
    shell: `${q(process.execPath)} ${q(entry)}`,
    mcp: { command: process.execPath, args: [entry] },
  };
}
