#!/usr/bin/env node
/**
 * agent farm CLI — `node tooling/agent-farm/farm.mjs --agents 3 --customers 5 --out <dir>`
 * Runs the scripted day (see lib.mjs), prints the table, writes <out>/farm-report.json.
 * Exit 1 when contradictions > 0 or the ledger is not contiguous. Loopback + temp dir only.
 */
import { runFarm, formatReport } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: farm.mjs [--agents N] [--customers N] [--out DIR]  (defaults 3 / 5 / os tmpdir)");
  process.exit(0);
}
const opts = { agents: Number(flag("agents", 3)), customers: Number(flag("customers", 5)), outDir: flag("out", undefined) };
if (!Number.isInteger(opts.agents) || opts.agents < 1 || !Number.isInteger(opts.customers) || opts.customers < 1) {
  console.error("--agents and --customers must be positive integers");
  process.exit(2);
}
const report = await runFarm(opts);
console.log(formatReport(report));
process.exit(report.contradictions > 0 || !report.ledger.contiguous ? 1 : 0);
