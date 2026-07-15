/** Side-effect-free shared CLI logic — safe for any module (including tests)
 *  to import, unlike src/cli/index.ts, which runs the whole program at
 *  import time. Holds: how to re-invoke this CLI from a git hook / .mcp.json
 *  (working both when running the built dist and in dev via tsx), plus small
 *  formatting helpers (dim(), doctor's synthesisStatusLines()) that need the
 *  same import-safety to be unit-testable. */
import { fileURLToPath } from "node:url";
import type { Invocation } from "../integrations/scaffold.js";
import { probeOllamaNumCtx, type ProviderResolution } from "../synthesis/provider.js";

export interface ResolvedInvocation {
  /** Shell command prefix for the git hook (e.g. `node /abs/dist/cli/index.js`). */
  shell: string;
  /** Structured command/args for .mcp.json (subcommand appended by the writer). */
  mcp: Invocation;
}

/** Published package name — used for OS-agnostic invocations (see below). */
const PKG = "@davesheffer/hunch";

export function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

/** The doctor command's synthesis-status line(s) for a resolved provider.
 *  Exported for testing — the previous version (a bare provider-name switch,
 *  before the resolveSynthesisProvider preference system existed) had zero
 *  test coverage, which is how issue #8 (openai-compat misreported as "no
 *  assistant CLI found") shipped unnoticed through three review passes. That
 *  bug resurfaces here for the same reason: resolution.statuses carries a
 *  `subscription` field for the CLI providers but openai-compat's is null (it
 *  isn't a subscription), so it must be special-cased explicitly rather than
 *  falling through to the "no assistant CLI" branch. */
export function synthesisStatusLines(resolution: ProviderResolution, env: NodeJS.ProcessEnv): string[] {
  const provider = resolution.provider;
  const selected = resolution.statuses.find((s) => s.name === provider.name);
  if (selected?.subscription) {
    return [`            ↳ LLM synthesis uses your ${selected.subscription}; provider API credentials are not used.`];
  }
  if (provider.name === "openai-compat") {
    const base = env.HUNCH_SYNTH_BASE_URL ?? "(unset)";
    const model = env.HUNCH_SYNTH_MODEL ?? "(unset)";
    const keyNote = env.HUNCH_SYNTH_API_KEY ? " (HUNCH_SYNTH_API_KEY set)" : " (no API key)";
    return [`            ↳ LLM synthesis via local/self-hosted endpoint ${base} (model: ${model})${keyNote}`];
  }
  if (resolution.source === "ambiguous") {
    const names = resolution.statuses.filter((s) => s.name !== "deterministic" && s.available).map((s) => s.name);
    return [
      dim(`            ↳ ${names.join(", ")} are available; Hunch will not guess which provider to use.`),
      dim(`              choose one locally: ${names.map((name) => `hunch provider ${name}`).join("  or  ")}`),
    ];
  }
  if (resolution.source === "unavailable-preference") {
    return [dim(`            ↳ ${resolution.preference} was selected but is unavailable; using the offline heuristic.`)];
  }
  return [
    dim(`            ↳ no assistant CLI found — synthesis uses the offline heuristic (advisory, low-confidence).`),
    dim(`              install or log into Claude Code, Codex, or Cursor; then select one with \`hunch provider <name>\`.`),
  ];
}

/** Gate + fetch the Ollama context-window advisory (issue #11): only relevant
 *  for the openai-compat provider, so every other provider is a no-op. Kept
 *  separate from synthesisStatusLines (sync, already fully covered) because
 *  this one makes a best-effort network call. */
export async function maybeWarnOllamaContext(providerName: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (providerName !== "openai-compat") return null;
  return probeOllamaNumCtx(env.HUNCH_SYNTH_BASE_URL ?? "", env.HUNCH_SYNTH_MODEL ?? "");
}

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
