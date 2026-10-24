@@CLEANROOM_HOLE_1@@
import { fileURLToPath } from "node:url";
import type { Invocation } from "../integrations/scaffold.js";
@@CLEANROOM_HOLE_2@@
import { HUNCH_NPX_PACKAGE_SPEC } from "../core/version.js";

export interface ResolvedInvocation {
  /** Shell command prefix for the git hook (e.g. `node /abs/dist/cli/index.js`). */
  shell: string;
  /** Portable shell command prefix for tracked assistant hook configuration. */
  agentHookShell: string;
  /** Structured command/args for .mcp.json (subcommand appended by the writer). */
  mcp: Invocation;
  /** True only when running from an installed/published copy (global, local,
   * or npx cache), never from a source checkout. */
  installed: boolean;
}

@@CLEANROOM_HOLE_3@@
/** Portable invocation written into committed MCP/provider configuration.
 * Keep it independently testable so the distribution pin cannot silently
 * regress to npm's moving latest tag. */
export function publishedMcpInvocation(): Invocation {
  return { command: "npx", args: ["-y", `--package=${HUNCH_NPX_PACKAGE_SPEC}`, "hunch"] };
}

/** Render a structured invocation for the host shell. Safe tokens stay bare so
 *  PowerShell can execute the first token; paths and other unsafe tokens use
 *  JSON string quoting, which is accepted by PowerShell, cmd, and POSIX sh. */
export function shellInvocation(inv: Invocation): string {
  const token = (part: string) => /^[A-Za-z0-9_@:=+.,/-]+$/.test(part) ? part : JSON.stringify(part);
  return [inv.command, ...inv.args].map(token).join(" ");
}

@@CLEANROOM_HOLE_4@@
  if (resolution.source === "unavailable-initiator") {
    return [dim(`            ↳ initiating provider ${resolution.initiator} is unavailable; using local analysis, never another account.`)];
  }
  if (resolution.source === "unknown-initiator") {
    return [dim("            ↳ initiating agent is unknown; local analysis only. The caller can pass --initiator <name>.")];
  }
  if (resolution.source === "initiator") {
    return [`            ↳ agent calls remain with ${resolution.initiator}, using that CLI's configured authentication.`];
  }
@@CLEANROOM_HOLE_5@@
      dim(`            ↳ ${names.join(", ")} are available; Hunch will not guess which provider to use.`),
@@CLEANROOM_HOLE_6@@
/** Classify the entry path without faking import.meta.url in tests. */
export function classifyEntry(entry: string): { isDev: boolean; installed: boolean } {
  const isDev = entry.endsWith(".ts");
  const installed = !isDev && entry.replace(/\\/g, "/").includes("/node_modules/");
  return { isDev, installed };
}

export function resolveInvocation(): ResolvedInvocation {
  const entry = fileURLToPath(import.meta.url).replace(/invocation\.(js|ts)$/, "index.$1");
  const { isDev, installed } = classifyEntry(entry);
  // JSON.stringify yields a double-quoted, backslash-escaped token /bin/sh
  // accepts — so install paths with spaces don't break the hook command.
  const q = (s: string) => JSON.stringify(s);

  // The MCP/provider config files we write are committed and shared across a
  // team via git, so they must NOT embed this machine's absolute path or
  // OS-specific separators. Reference the exact published Hunch package
  // instead, which `npx` resolves the same on any OS and any clone without
  // floating to a newer release. The git hook lives in per-machine
  // .git/hooks (never committed), so it keeps the PATH-robust absolute-node
  // invocation below.
  if (installed) {
    const mcp = publishedMcpInvocation();
    return {
      shell: `${q(process.execPath)} ${q(entry)}`,
      agentHookShell: shellInvocation(mcp),
      mcp,
      installed,
    };
  }

  if (isDev) {
    const mcp = { command: "npx", args: ["tsx", entry] };
    return {
      shell: `npx tsx ${q(entry)}`,
      agentHookShell: shellInvocation(mcp),
      mcp,
      installed,
    };
  }
  // Source-checkout dist run (e.g. `node dist/cli/index.js`, npm link): inherently
  // per-machine. Use the absolute node binary (process.execPath) rather than a bare
  // `node`, so the hook works even when nvm's `node` isn't on the hook's PATH.
  const mcp = { command: process.execPath, args: [entry] };
  return {
    shell: `${q(process.execPath)} ${q(entry)}`,
    agentHookShell: shellInvocation(mcp),
    mcp,
    installed,
  };
}

/** The command prefix for the git merge drivers. git runs a driver with the
 *  repository being merged as its cwd, so the dev-mode `npx tsx <entry>` would
 *  resolve tsx from THAT repo (or fetch it from the registry), not from Hunch's
 *  own checkout (#492). In dev mode, launch the absolute node binary against
 *  this checkout's tsx cli.mjs, the same shape selfBuildInvocation gives the
 *  git hooks (src/integrations/hooks.ts); every other invocation (published,
 *  dist, or a caller-supplied one) passes through unchanged. */
export function mergeDriverShell(invShell: string): string {
  const inv = resolveInvocation();
  if (inv.installed || !inv.shell.startsWith("npx tsx ") || invShell !== inv.shell) return invShell;
  const entry = fileURLToPath(import.meta.url).replace(/invocation\.ts$/, "index.ts");
  return devMergeDriverShell(process.execPath, fileURLToPath(import.meta.resolve("tsx/cli")), entry);
}

/** Filesystem paths, never a file URL: git expands `%`-escapes in the driver
 *  command, so a percent-encoded URL (any non-ASCII checkout path) would be
 *  corrupted. POSIX single quotes keep `$`, backticks and `"` literal under the
 *  /bin/sh git runs drivers with on every platform, and a literal `%` in a path
 *  is doubled so git expands it back to one. */
export function devMergeDriverShell(execPath: string, tsxCli: string, entry: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`.replace(/%/g, "%%");
  return [execPath, tsxCli, entry].map(quote).join(" ");
}
