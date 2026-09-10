import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentInitiator {
  provider: string | null;
  source: "explicit" | "environment" | "client" | "unknown" | "ambiguous";
}
const context = new AsyncLocalStorage<AgentInitiator>();
const aliases: Record<string, string> = { claude: "claude-cli", codex: "codex-cli", cursor: "cursor-agent", kimi: "kimi-cli", ollama: "openai-compat" };
export function normalizeInitiator(name: string): string {
  const normalized = aliases[name] ?? name;
  if (!/^[a-z][a-z0-9-]{0,59}$/.test(normalized) || ["auto", "available", "deterministic"].includes(normalized)) {
    throw new Error("Initiator must identify one concrete agent provider.");
  }
  return normalized;
}
export function detectInitiator(env: NodeJS.ProcessEnv = process.env): AgentInitiator {
  if (env.HUNCH_INITIATOR === "unknown") return { provider: null, source: "unknown" };
  if (env.HUNCH_INITIATOR) return { provider: normalizeInitiator(env.HUNCH_INITIATOR), source: "explicit" };
  const names = new Set<string>();
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) names.add("codex-cli");
  if (env.CLAUDECODE === "1") names.add("claude-cli");
  return { provider: names.size === 1 ? [...names][0]! : null,
    source: names.size === 1 ? "environment" : names.size > 1 ? "ambiguous" : "unknown" };
}
export function currentInitiator(env: NodeJS.ProcessEnv = process.env): AgentInitiator {
  return context.getStore() ?? detectInitiator(env);
}
export function withInitiator<T>(initiator: AgentInitiator, work: () => T): T {
  return context.run(Object.freeze({ ...initiator }), work);
}
/** Bind the MCP client, not the process that happened to start the server. Unknown clients stay unknown. */
export function initiatorFromClient(name: string | undefined): AgentInitiator {
  const lower = name?.toLowerCase() ?? "";
  const providers = [
    [/\bclaude(?:[ _-]code)?\b/, "claude-cli"], [/\bcodex\b/, "codex-cli"],
    [/\bcursor\b/, "cursor-agent"], [/\bkimi\b/, "kimi-cli"],
  ] as const;
  const matched = providers.filter(([pattern]) => pattern.test(lower));
  return { provider: matched.length === 1 ? matched[0]![1] : null,
    source: matched.length > 1 ? "ambiguous" : "client" };
}
/** Freeze the operation's origin before spawning Git hooks or other deferred children. */
export function initiatorChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const origin = currentInitiator(env);
  return { ...env, HUNCH_INITIATOR: origin.provider ?? "unknown" };
}
export function assertInitiatorProvider(provider: string): void {
  const origin = currentInitiator();
  if (origin.provider && origin.provider !== provider) throw new Error(`Initiator ${origin.provider} cannot launch ${provider}; refusing an account switch.`);
  if (origin.source === "ambiguous") throw new Error("Ambiguous initiating agent; refusing to launch another provider.");
  if (origin.source === "client" && !origin.provider) throw new Error("Unknown initiating MCP client; refusing to launch another provider.");
}
