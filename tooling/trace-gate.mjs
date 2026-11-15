// Execution-evidence coverage gate (#512). Merges the trace files a full traced test run
// wrote (tooling/test-trace-register.mjs, HUNCH_TEST_TRACE) and fails when a CLI option or
// environment variable that test/cli-options-surface.json or test/env-surface.json lists as
// covered by a test was never actually exercised: never parsed from argv by the CLI, or
// never read with a non-empty value. The source-text gates stay as the fast local check;
// this is the execution proof they could only approximate.
//
// Entries the traced run does not reach yet are frozen in tooling/trace-gate-baseline.json.
// The baseline may only shrink: a new gap fails, a baseline entry that is now exercised is
// reported so it can be deleted.
//
// Phase 1: CI runs this with --report-only (coverage gaps are printed, the job passes; bad
// or partial evidence still fails). It becomes blocking once tooling/trace-gate-baseline.json
// is seeded (--seed) from several green traced runs.
//
// Known limits: `--version`/`--help` and anything Commander rejects before preAction never
// record CLI keys; a detached daemon writes its env record only when it exits.
//
//   node tooling/trace-gate.mjs --dir <trace dir> [--baseline <file>] [--root <repo>]
//     [--expect-shards <n>] [--seed] [--report-only]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
/** Where the registries live; tests point it at a fixture. */
const root = resolve(arg("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const dir = arg("--dir");
const baselineFile = resolve(arg("--baseline") ?? join(root, "tooling/trace-gate-baseline.json"));
const usage = (why) => { console.error(`trace-gate: ${why}\nusage: node tooling/trace-gate.mjs --dir <trace dir> [--baseline <file>] [--expect-shards <n>] [--seed] [--report-only]`); process.exit(2); };
if (!dir) usage("--dir is required");
const shardArg = arg("--expect-shards");
if (argv.includes("--expect-shards") && !/^[1-9]\d*$/.test(shardArg ?? "")) usage(`--expect-shards needs an integer >= 1, got ${JSON.stringify(shardArg ?? null)}`);
const expectShards = shardArg ? Number(shardArg) : 0;
if (argv.includes("--seed") && !expectShards) usage("--seed needs --expect-shards: a seed from partial evidence would freeze real gaps");
const reportOnly = argv.includes("--report-only");
const isStrings = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));

/** Every trace-*.jsonl under dir (CI downloads one artifact folder per shard). */
function traceFiles(at) {
  const out = [];
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) out.push(...traceFiles(path));
    else if (/^trace-.*\.jsonl$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = existsSync(dir) ? traceFiles(dir) : [];
if (!files.length) { console.error(`trace-gate: no trace files under ${dir}; was the suite run with HUNCH_TEST_TRACE?`); process.exit(1); }
const seen = { cli: new Set(), env: new Set() };
let cliProcesses = 0;
const records = new Map();
const cliRecords = new Map();
for (const file of files) {
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (error) { console.error(`trace-gate: ${file}:${i + 1}: unreadable trace record: ${error.message}`); process.exit(1); }
    if (!rec || typeof rec !== "object" || Array.isArray(rec) || !isStrings(rec.cli) || !isStrings(rec.env)) {
      console.error(`trace-gate: ${file}:${i + 1}: invalid trace record (want an object whose cli/env are arrays of strings)`); process.exit(1);
    }
    records.set(file, (records.get(file) ?? 0) + 1);
    if (rec.cli?.length) { cliProcesses++; cliRecords.set(file, (cliRecords.get(file) ?? 0) + 1); }
    for (const key of rec.cli ?? []) seen.cli.add(key);
    for (const name of rec.env ?? []) seen.env.add(name);
  }
}

// Evidence must be whole: every expected shard file present with records, and the run
// must have reached the CLI and read the environment at all. A seed from partial
// evidence would freeze everything the missing part covers.
for (let k = 1; k <= expectShards; k++) {
  const shard = files.filter((f) => f.endsWith(`trace-shard-${k}.jsonl`));
  if (shard.length !== 1 || !records.get(shard[0])) { console.error(`trace-gate: expected exactly one non-empty trace-shard-${k}.jsonl, found ${shard.length}${shard.length === 1 ? " (empty)" : ""}`); process.exit(1); }
  if (!cliRecords.get(shard[0])) { console.error(`trace-gate: trace-shard-${k}.jsonl has no CLI record; that shard never reached the CLI`); process.exit(1); }
}
if (!cliProcesses || !seen.env.size) { console.error(`trace-gate: no ${cliProcesses ? "env" : "CLI"} evidence in ${files.length} trace file(s); refusing to judge coverage`); process.exit(1); }

const claimed = (file) => Object.entries(JSON.parse(readFileSync(join(root, file), "utf8")))
  .filter(([, entry]) => Array.isArray(entry?.tests) && entry.tests.length).map(([key]) => key).sort();
const registries = { cli: claimed("test/cli-options-surface.json"), env: claimed("test/env-surface.json") };
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : { cli: {}, env: {} };

if (argv.includes("--seed")) {
  const next = { cli: {}, env: {} };
  for (const kind of ["cli", "env"]) {
    for (const key of registries[kind]) {
      if (!seen[kind].has(key)) next[kind][key] = baseline[kind]?.[key] ?? "listed as covered, but no traced test run exercised it yet";
    }
  }
  writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`trace-gate: seeded ${Object.keys(next.cli).length} CLI and ${Object.keys(next.env).length} env gap(s) into ${baselineFile}`);
  process.exit(0);
}

const errors = [];
const notes = [];
for (const kind of ["cli", "env"]) {
  const frozen = baseline[kind] ?? {};
  const listed = new Set(registries[kind]);
  for (const key of registries[kind]) {
    if (seen[kind].has(key)) { if (Object.hasOwn(frozen, key)) notes.push(`${kind} ${key}: now exercised; delete it from the baseline`); continue; }
    if (!Object.hasOwn(frozen, key)) errors.push(`${kind} ${key}: listed as covered, but no test exercised it (${kind === "cli" ? "never parsed from argv by the CLI" : "never read with a value"})`);
  }
  for (const key of Object.keys(frozen)) if (!listed.has(key)) errors.push(`${kind} ${key}: in the baseline but not listed as covered in its registry; delete it from the baseline`);
}
console.log(`trace-gate: ${files.length} trace file(s), ${cliProcesses} traced CLI run(s); exercised ${seen.cli.size} CLI option key(s) and ${seen.env.size} env name(s)`);
for (const n of notes) console.log(`note: ${n}`);
for (const e of errors) console.error(`ERROR ${e}`);
if (reportOnly && errors.length) console.log(`trace-gate: --report-only: ${errors.length} coverage gap(s) reported, not failing`);
process.exit(errors.length && !reportOnly ? 1 : 0);
