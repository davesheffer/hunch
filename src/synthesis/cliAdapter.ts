/** Extensible local CLI transport. Executables/arguments come only from explicit user config. */
import spawn from "cross-spawn";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { assertInitiatorProvider, initiatorChildEnv } from "./initiator.js";

const adapterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
  command: z.string().min(1).max(1000).refine(s => !/[\r\n\0]/.test(s)),
  args: z.array(z.string().max(2000).refine(s => !/[\r\n\0]/.test(s))).max(40),
  protocol: z.enum(["stdin", "acp"]),
  probe_args: z.array(z.string().max(200).refine(s => !/[\r\n\0]/.test(s))).max(10).default(["--version"]),
  timeout_ms: z.number().int().min(1000).max(600000).default(120000),
}).strict();
export type AgentCliAdapter = z.infer<typeof adapterSchema>;
export interface AgentCliWorker { name: string; draftProse?(prompt: string): Promise<string> }

export function readAgentCliConfig(file: string): AgentCliAdapter[] {
  if (statSync(file).size > 64 * 1024) throw new Error("CLI adapter config exceeds 64 KiB");
  const adapters = z.array(adapterSchema).max(20).parse(JSON.parse(readFileSync(file, "utf8")));
  if (new Set(adapters.map(a => a.name)).size !== adapters.length) throw new Error("duplicate CLI adapter names");
  return adapters;
}

/** ACP (Kimi and other agents) or plain stdin → JSON stdout for any user-configured CLI. */
export async function runAgentCli(adapterInput: AgentCliAdapter, prompt: string): Promise<string> {
  const adapter = adapterSchema.parse(adapterInput);
  assertInitiatorProvider(adapter.name);
  const parent = realpathSync(tmpdir());
  const cwd = mkdtempSync(join(parent, "hunch-agent-provider-"));
  const child = spawn(adapter.command, adapter.args, { cwd, env: initiatorChildEnv(), windowsHide: true, stdio: "pipe" });
  const stop = () => {
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    }
    child.kill();
  };
  try {
    return await new Promise<string>((resolve, reject) => {
      let done = false;
      let buffer = "";
      let output = "";
      let bytes = 0;
      let sequence = 0;
      let sessionId: string | undefined;
      const waiting = new Map<number, (result: Record<string, unknown>) => void>();
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(output.trim());
      };
      const timer = setTimeout(() => { finish(new Error("CLI provider timed out")); stop(); }, adapter.timeout_ms);
      const send = (message: object) => child.stdin!.write(JSON.stringify(message) + "\n");
      const request = (method: string, params: object, callback: (result: Record<string, unknown>) => void) => {
        const id = ++sequence;
        waiting.set(id, callback);
        send({ jsonrpc: "2.0", id, method, params });
      };
      const receive = (line: string) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.method && message.id !== undefined) {
          // No permission approvals, filesystem reads/writes or shell services are granted.
          if (message.method === "session/request_permission") {
            send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
          } else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unavailable in review-only client" } });
          return;
        }
        if (message.method === "session/update") {
          const params = message.params as { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
          if (params?.sessionId === sessionId && params.update?.sessionUpdate === "agent_message_chunk"
            && params.update.content?.type === "text" && typeof params.update.content.text === "string") output += params.update.content.text;
        } else if (typeof message.id === "number" && waiting.has(message.id)) {
          const callback = waiting.get(message.id)!;
          waiting.delete(message.id);
          if (message.error || !message.result || typeof message.result !== "object") throw new Error("ACP request failed");
          callback(message.result as Record<string, unknown>);
        }
      };
      child.on("error", () => finish(new Error("CLI provider could not start")));
      child.stdin!.on("error", () => finish(new Error("CLI provider input closed")));
      child.stderr!.on("data", () => {}); // drain without collecting credentials or raw prompts
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) { finish(new Error("CLI provider exceeded output budget")); stop(); return; }
        if (adapter.protocol === "stdin") { output += chunk; return; }
        buffer += chunk;
        try {
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0 && !done) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) receive(line);
          }
        } catch { finish(new Error("Invalid ACP response")); }
      });
      child.on("close", code => {
        if (adapter.protocol === "stdin" && code === 0) finish();
        else finish(new Error("CLI provider exited before completing review"));
      });
      if (adapter.protocol === "stdin") child.stdin!.end(prompt);
      else request("initialize", { protocolVersion: 1, clientInfo: { name: "hunch-review-memory", version: "1" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } }, initialized => {
        if (initialized.protocolVersion !== 1) throw new Error("Unsupported ACP protocol");
        request("session/new", { cwd, mcpServers: [] }, session => {
          if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error("Missing ACP session");
          sessionId = session.sessionId;
          request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, result => {
            if (result.stopReason !== "end_turn") throw new Error("ACP turn did not complete");
            finish();
          });
        });
      });
    });
  } finally {
    stop();
    // Only remove the directory created for this invocation, after checking its resolved boundary.
    const rel = relative(parent, realpathSync(cwd));
    if (!isAbsolute(rel) && rel.startsWith("hunch-agent-provider-") && !rel.includes("/") && !rel.includes("\\")) {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* transient Windows handles; never affect review result */ }
    }
  }
}

export function discoverAgentClis(configured: AgentCliAdapter[] = [], initiator?: string): AgentCliWorker[] {
  const kimi = adapterSchema.parse({ name: "kimi-cli", command: "kimi", args: ["acp"], protocol: "acp" });
  const adapters = [...configured, ...(configured.some(a => a.name === kimi.name) ? [] : [kimi])];
  return adapters.filter(adapter => !initiator || adapter.name === initiator).filter(adapter => {
    const result = spawn.sync(adapter.command, adapter.probe_args, {
      cwd: tmpdir(), encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
    });
    return !result.error && result.status === 0;
  }).map(adapter => ({ name: adapter.name, draftProse: prompt => runAgentCli(adapter, prompt) }));
}
