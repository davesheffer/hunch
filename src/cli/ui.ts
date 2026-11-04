import type { Command } from "commander";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { findRoot } from "../core/paths.js";
import { HUNCH_VERSION } from "../core/version.js";
import { createUiServer } from "../ui/server.js";

/** Best effort: a missing opener never fails the command, the URL is printed either way. */
function openBrowser(url: string): void {
  const [file, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* printed URL is the fallback */ }
}

export function registerUiCommands(program: Command): void {
  program.command("ui")
    .description("Open the local web UI for this repository's memory (binds 127.0.0.1; a new access key every launch)")
    .option("--port <n>", "port to listen on (default: any free port)")
    .option("--no-open", "print the link without opening a browser")
    .action((opts: { port?: string; open: boolean }) => {
      const port = opts.port === undefined ? 0 : Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port ${opts.port}`);
      const token = randomBytes(24).toString("base64url");
      // execArgv carries the tsx loader in dev, so a write runs this same CLI the same way.
      // Debugger, watch and profiler flags would hang each write or drop files in the repo.
      const entry = process.argv[1];
      const execArgv = process.execArgv.filter((a) => !/^--(?:inspect|watch|[a-z]+-prof)/.test(a));
      const cli = entry ? { file: process.execPath, args: [...execArgv, entry] } : undefined;
      const server = createUiServer({ root: findRoot(), token, version: HUNCH_VERSION, cli });
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const bound = typeof address === "object" && address ? address.port : port;
        // The key rides in the #fragment: browsers never send it to a server or put it in a Referer.
        const url = `http://127.0.0.1:${bound}/#t=${token}`;
        console.log(`hunch ${HUNCH_VERSION} ui: ${url}`);
        console.log("Press Ctrl+C to stop.");
        if (opts.open) openBrowser(url);
      });
      const stop = (): void => { server.close(() => { server.closeStore(); process.exit(0); }); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
}
