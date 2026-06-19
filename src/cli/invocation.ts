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

/** Published package name — used for OS-agnostic invocations (see below). */
const PKG = "@davesheffer/hunch";

export function resolveInvocation(): ResolvedInvocation {
  const entry = fileURLToPath(import.meta.url).replace(/invocation\.(js|ts)$/, "index.$1");
  const isDev = entry.endsWith(".ts");
  // JSON.stringify yields a double-quoted, backslash-escaped token /bin/sh
  // accepts — so install paths with spaces don't break the hook command.
  const q = (s: string) => JSON.stringify(s);

  // Running from an installed copy (global, local, or npx cache — i.e. NOT a
  // source checkout we're hacking on). The MCP/provider config files we write
  // are committed and shared across a team via git, so they must NOT embed this
  // machine's absolute path or OS-specific separators. Reference Hunch by its
  // published package name instead, which `npx` resolves the same on any OS and
  // any clone. The git hook lives in per-machine .git/hooks (never committed),
  // so it keeps the PATH-robust absolute-node invocation below.
  const installed = !isDev && entry.replace(/\\/g, "/").includes("/node_modules/");
  if (installed) {
    return {
      shell: `${q(process.execPath)} ${q(entry)}`,
      mcp: { command: "npx", args: ["-y", PKG] },
    };
  }

  if (isDev) {
    return {
      shell: `npx tsx ${q(entry)}`,
      mcp: { command: "npx", args: ["tsx", entry] },
    };
  }
  // Source-checkout dist run (e.g. `node dist/cli/index.js`, npm link): inherently
  // per-machine. Use the absolute node binary (process.execPath) rather than a bare
  // `node`, so the hook works even when nvm's `node` isn't on the hook's PATH.
  return {
    shell: `${q(process.execPath)} ${q(entry)}`,
    mcp: { command: process.execPath, args: [entry] },
  };
}
