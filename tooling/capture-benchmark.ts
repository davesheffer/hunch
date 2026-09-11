/** Reproducible local store benchmark. No network, model, credentials or production data. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { captureBatchState } from "../src/store/stateCapture.js";
import { partitionOf, readState } from "../src/store/stateBinding.js";
import { STATE_CAPTURE_BATCH_VERSION } from "../src/core/stateContract.js";

const root = mkdtempSync(join(tmpdir(), "hunch-capture-bench-"));
const store = new HunchStore(hunchPaths(root)); store.json.ensureDirs();
const scope = partitionOf(store), principal = { id: "benchmark", kind: "agent" as const, grants: [scope] };
const request = (start: number, count = 32) => {
  const sentences = Array.from({ length: count }, (_, i) => `Device ${start + i} uses port ${8000 + i}.`);
  return { schema: STATE_CAPTURE_BATCH_VERSION, scope, principal,
    sources: [{ ref: { system: "fixture", object_type: "document", object_key: `batch-${start}`, observed_at: "2026-09-10T00:00:00Z" }, source_text: sentences.join(" ") }],
    observations: sentences.map(statement => ({ subject: `device:batch-${start}`, statement, relevance: { use: "operational_fact" as const, reason: "Select the configured port when connecting." }, evidence: [{ source: 0, excerpt: statement }] })),
  };
};
const measure = (run: () => unknown) => { const t = performance.now(); run(); return +(performance.now() - t).toFixed(3); };
const rows: unknown[] = [];
try {
  for (const size of [0, 256, 1024]) {
    let present = store.recs("derived").length;
    while (present < size) { captureBatchState(store, request(present, Math.min(32, size - present))); present = store.recs("derived").length; }
    const batch = request(size + 10000);
    const create_ms = measure(() => captureBatchState(store, batch));
    const duplicates_ms = Array.from({ length: 7 }, () => measure(() => captureBatchState(store, batch))).sort((a, b) => a - b);
    const read_ms = Array.from({ length: 7 }, () => measure(() => readState(store, { schema: "nuryel.state.read/1", principal, scope, subject: batch.observations[0]!.subject }))).sort((a, b) => a - b);
    rows.push({ existing_records: present, batch_size: 32, create_ms, replay_median_ms: duplicates_ms[3], replay_max_ms: duplicates_ms.at(-1), subject_read_median_ms: read_ms[3], subject_read_max_ms: read_ms.at(-1) });
  }
  const report = { schema: "hunch.capture-benchmark/1", at: new Date().toISOString(), node: process.version, platform: process.platform,
    method: "Real temporary JSON drawer + SQLite index + change ledger. Local durability. 32 assertions per batch. Seven warm replay/read samples; creation one sample per size. Git/network, MCP startup and model selection excluded. Timings are measurements, not service guarantees.", rows };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (process.argv[2]) writeFileSync(process.argv[2], json);
  process.stdout.write(json);
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
