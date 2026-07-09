/**
 * A minimal MCP client over stdio to the repo's own `hunch mcp` server — the
 * client-agnostic WRITE path (hunch_capture_decision / hunch_record_decision).
 * The extension stays a pure reader of .hunch/ JSON: every mutation still goes
 * through the CLI process; this just speaks the same protocol Claude Code does.
 *
 * Deliberately tiny: newline-delimited JSON-RPC 2.0, initialize handshake,
 * tools/call. No SDK dependency.
 */
import * as cp from "node:child_process";
import { cliCommand, winQuote } from "./cli.js";

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

export class HunchMcp {
  private child: cp.ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(private root: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.child = process.platform === "win32"
      ? cp.spawn(`${winQuote(cliCommand())} mcp`, { cwd: this.root, shell: true })
      : cp.spawn(cliCommand(), ["mcp"], { cwd: this.root });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
            else p.resolve(msg.result);
          }
        } catch { /* non-JSON noise on stdout — ignore */ }
      }
    });
    const die = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      this.child = null;
      this.ready = null;
    };
    this.child.on("error", () => die("could not start `hunch mcp` — is the CLI installed? (hunch.cliPath)"));
    this.child.on("close", () => die("hunch mcp exited"));

    this.ready = this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hunch-vscode", version: "0.6.0" },
    }).then(() => this.notify("notifications/initialized", {}));
    return this.ready;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP ${method} timed out`));
      }, 30_000);
    });
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Call a hunch_* tool; returns the concatenated text content. */
  async call(tool: string, args: unknown): Promise<string> {
    await this.start();
    const res = await this.request("tools/call", { name: tool, arguments: args }) as
      { content?: Array<{ type: string; text?: string }> } | undefined;
    return (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  }

  dispose(): void {
    try { this.child?.kill(); } catch { /* gone */ }
    this.child = null;
    this.ready = null;
  }
}
