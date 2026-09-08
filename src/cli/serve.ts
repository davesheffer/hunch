import type { Command } from "commander";
import { resolve } from "node:path";
import { createServeApp } from "../serve/app.js";
import { initServeConfig, partitionFor, readServeConfig } from "../serve/config.js";
import { compactLedger } from "../store/changeLedger.js";
import { join } from "node:path";
import { ScopeSchema, scopePath } from "../core/stateContract.js";
import { HUNCH_VERSION } from "../core/version.js";

function parseScopeArg(value: string): { kind: "organization" | "team" | "user" | "repository"; id: string } {
  const m = /^([a-z]+):(.+)$/.exec(value.trim());
  const parsed = m ? ScopeSchema.safeParse({ kind: m[1], id: m[2] }) : null;
  if (!parsed?.success) throw new Error(`partition must be kind:id (organization|team|user|repository), got "${value}"`);
  return parsed.data;
}

export function registerServeCommands(program: Command): void {
  const DEFAULT_CONFIG = "hunch-serve.json";
  const serve = program.command("serve")
    .description("Serve nuryel.state/1 over HTTP for organization / team / user / repository partitions (binds 127.0.0.1; put it behind SSH or a reverse proxy)")
    .option("--config <file>", `serve config (nuryel.serve-config/1); default ${DEFAULT_CONFIG}`)
    .option("--port <n>", "override the configured port")
    .action((opts: { config?: string; port?: string }) => {
      const config = readServeConfig(resolve(opts.config ?? DEFAULT_CONFIG));
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

  serve.command("compact")
    .description("Compact a served partition's change ledger: keep the newest N events, move the floor up; subscribers below the floor resynchronize")
    .requiredOption("--partition <kind:id>", "the partition whose ledger to compact")
    .option("--keep <n>", "events to keep", "1000")
    .option("--json", "machine-readable output")
    .action((opts: { partition: string; keep: string; json?: boolean }) => {
      const parent = serve.opts() as { config?: string };
      const config = readServeConfig(resolve(parent.config ?? DEFAULT_CONFIG));
      const scope = parseScopeArg(opts.partition);
      const partition = partitionFor(config, scope);
      if (!partition) throw new Error(`this config does not serve ${scopePath(scope)}`);
      const keep = Number(opts.keep);
      if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer");
      const result = compactLedger(join(partition.root, ".hunch"), scope, { keep });
      if (opts.json) { console.log(JSON.stringify({ partition: scopePath(scope), ...result })); return; }
      console.log(result.dropped ? `${scopePath(scope)}: dropped ${result.dropped} event(s); floor ${result.floor_seq}, head ${result.head_seq}` : `${scopePath(scope)}: nothing to compact (${result.head_seq - result.floor_seq} events retained)`);
    });

  serve.command("init")
    .description("Declare a partition directory and mint a principal token (printed once; only its hash is stored)")
    .requiredOption("--partition <kind:id>", "the scope this directory IS, e.g. user:david or organization:ylm")
    .requiredOption("--root <dir>", "directory whose .hunch/ holds the partition (created if missing)")
    .option("--config <file>", `serve config to create or extend; default ${DEFAULT_CONFIG}`)
    .option("--principal <id>", "principal to add or rotate, granted this partition")
    .option("--kind <kind>", "principal kind: human | agent | service", "agent")
    .option("--grant <kind:id...>", "additional partitions to grant the principal (must be served by this config)")
    .option("--port <n>", "port to record in a new config")
    .option("--json", "machine-readable output")
    .action((opts: { partition: string; root: string; config?: string; principal?: string; kind: string; grant?: string[]; port?: string; json?: boolean }) => {
      if (!["human", "agent", "service"].includes(opts.kind)) throw new Error("--kind must be human, agent or service");
      // `serve` and `serve init` both take --config; Commander hands an option written after
      // `init` to whichever command claims it first, and that was the parent — so 1.26.0's
      // `serve init --config X` silently wrote the default file into the cwd. Read both.
      const parent = serve.opts() as { config?: string; port?: string };
      const configFile = resolve(parent.config ?? opts.config ?? DEFAULT_CONFIG);
      const port = parent.port ?? opts.port;
      const scope = parseScopeArg(opts.partition);
      const grants = [scope, ...(opts.grant ?? []).map(parseScopeArg)];
      const result = initServeConfig({
        file: configFile, scope, root: resolve(opts.root),
        ...(opts.principal ? { principal: { id: opts.principal, kind: opts.kind as "human" | "agent" | "service", grants } } : {}),
        ...(port ? { port: Number(port) } : {}),
      });
      if (opts.json) { console.log(JSON.stringify({ config: configFile, partition: result.partition, token: result.token })); return; }
      console.log(`partition ${scopePath(scope)} → ${result.partition.root}`);
      console.log(`config: ${configFile} (${result.config.partitions.length} partition(s), ${result.config.principals.length} principal(s))`);
      if (result.token) console.log(`token for ${opts.principal} (shown once — only its sha256 is stored): ${result.token}`);
      console.log(`start: hunch serve --config ${configFile}`);
    });
}
