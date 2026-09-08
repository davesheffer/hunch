import type { Command } from "commander";
import { resolve } from "node:path";
import { createServeApp } from "../serve/app.js";
import { initServeConfig, readServeConfig } from "../serve/config.js";
import { ScopeSchema, scopePath } from "../core/stateContract.js";
import { HUNCH_VERSION } from "../core/version.js";

function parseScopeArg(value: string): { kind: "organization" | "team" | "user" | "repository"; id: string } {
  const m = /^([a-z]+):(.+)$/.exec(value.trim());
  const parsed = m ? ScopeSchema.safeParse({ kind: m[1], id: m[2] }) : null;
  if (!parsed?.success) throw new Error(`partition must be kind:id (organization|team|user|repository), got "${value}"`);
  return parsed.data;
}

export function registerServeCommands(program: Command): void {
  const serve = program.command("serve")
    .description("Serve nuryel.state/1 over HTTP for organization / team / user / repository partitions (binds 127.0.0.1; put it behind SSH or a reverse proxy)")
    .option("--config <file>", "serve config (nuryel.serve-config/1)", "hunch-serve.json")
    .option("--port <n>", "override the configured port")
    .action((opts: { config: string; port?: string }) => {
      const config = readServeConfig(resolve(opts.config));
      const port = opts.port ? Number(opts.port) : config.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${opts.port}`);
      const app = createServeApp(config, { version: HUNCH_VERSION });
      // Bind loopback, never expose a port: the orchestrator reaches it over an SSH hop or a
      // reverse proxy that terminates TLS and auth of its own. Folded-in decision from Hunch Memory.
      app.listen(port, "127.0.0.1", () => {
        console.log(`hunch ${HUNCH_VERSION} serving nuryel.state/1 on http://127.0.0.1:${port} — ${config.partitions.map((p) => scopePath(p.scope)).join(", ")} (${config.principals.length} principal(s))`);
      });
      const stop = (): void => { app.close(() => { app.closeStores(); process.exit(0); }); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });

  serve.command("init")
    .description("Declare a partition directory and mint a principal token (printed once; only its hash is stored)")
    .requiredOption("--partition <kind:id>", "the scope this directory IS, e.g. user:david or organization:ylm")
    .requiredOption("--root <dir>", "directory whose .hunch/ holds the partition (created if missing)")
    .option("--config <file>", "serve config to create or extend", "hunch-serve.json")
    .option("--principal <id>", "principal to add or rotate, granted this partition")
    .option("--kind <kind>", "principal kind: human | agent | service", "agent")
    .option("--grant <kind:id...>", "additional partitions to grant the principal (must be served by this config)")
    .option("--port <n>", "port to record in a new config")
    .option("--json", "machine-readable output")
    .action((opts: { partition: string; root: string; config: string; principal?: string; kind: string; grant?: string[]; port?: string; json?: boolean }) => {
      if (!["human", "agent", "service"].includes(opts.kind)) throw new Error("--kind must be human, agent or service");
      const scope = parseScopeArg(opts.partition);
      const grants = [scope, ...(opts.grant ?? []).map(parseScopeArg)];
      const result = initServeConfig({
        file: resolve(opts.config), scope, root: resolve(opts.root),
        ...(opts.principal ? { principal: { id: opts.principal, kind: opts.kind as "human" | "agent" | "service", grants } } : {}),
        ...(opts.port ? { port: Number(opts.port) } : {}),
      });
      if (opts.json) { console.log(JSON.stringify({ config: resolve(opts.config), partition: result.partition, token: result.token })); return; }
      console.log(`partition ${scopePath(scope)} → ${result.partition.root}`);
      console.log(`config: ${resolve(opts.config)} (${result.config.partitions.length} partition(s), ${result.config.principals.length} principal(s))`);
      if (result.token) console.log(`token for ${opts.principal} (shown once — only its sha256 is stored): ${result.token}`);
      console.log(`start: hunch serve --config ${opts.config}`);
    });
}
