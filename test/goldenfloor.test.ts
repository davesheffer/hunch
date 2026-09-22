import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { ENTITY_KINDS } from "../src/core/types.js";
import { indexRepo } from "../src/extractors/indexer.js";

/**
 * Retrieval-quality floor — the golden benchmark as a release gate, not a trophy.
 *
 * The memory-record prior landed citing Recall@10 70% -> 90%. Setting this floor
 * (2026-08-19) re-measured and got 81.8%: the graph had grown under the bench in
 * one day and two wiki queries' expected records were diluted out of the top-10 —
 * exactly the silent erosion a floor exists to catch, demonstrated before the
 * floor existed. The prior's RELATIVE effect reproduced (off: 7/11, MRR 0.386;
 * on: 9/11, MRR 0.485), so the floors below are TODAY'S measured truth, not the
 * comment's high-water mark.
 *
 * If this test fails you have two honest moves: recover the ranking, or — when a
 * bench record was legitimately superseded — update bench/golden-retrieval.json
 * in the same commit that explains why. Lowering the floor is not one of them.
 */
const REPO = resolve(import.meta.dirname ?? __dirname, "..");
const BENCH = join(REPO, "bench", "golden-retrieval.json");
const RECALL_FLOOR = 9; // of 11 — measured 2026-08-19 with the memory prior on
const MRR_FLOOR = 0.45; // measured 0.485

test("golden retrieval floor: Recall@10 and MRR never silently erode", { skip: !existsSync(BENCH) || !existsSync(join(REPO, ".hunch")) }, async (t) => {
  const cases = JSON.parse(readFileSync(BENCH, "utf8")) as Array<{ query: string; expected: string[] }>;
  // The SQLite index is derived + gitignored. Reading the checkout's incidental
  // hunch.sqlite made this gate skip on clean CI clones and grade stale developer
  // state locally — including a graph too old to contain evaluateGraphLift. Build a
  // disposable store from committed memory plus a fresh source scan instead. The
  // gate now measures the candidate checkout deterministically and never mutates its
  // tracked graph or depends on whether somebody happened to run `hunch index`.
  const fixture = mkdtempSync(join(tmpdir(), "hunch-golden-floor-"));
  const fixtureHunch = hunchPaths(fixture).hunch;
  mkdirSync(fixtureHunch, { recursive: true });
  for (const kind of ENTITY_KINDS) {
    const source = join(REPO, ".hunch", kind);
    if (existsSync(source)) cpSync(source, join(fixtureHunch, kind), { recursive: true });
  }
  const previousOverlay = process.env.HUNCH_PRIVATE_DIR;
  delete process.env.HUNCH_PRIVATE_DIR;
  let store: HunchStore | null = null;
  t.after(() => {
    store?.close();
    if (previousOverlay === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = previousOverlay;
    cleanupDir(fixture);
  });
  store = new HunchStore(hunchPaths(fixture));
  indexRepo(store, REPO, { churn: false });
  store.reindex();

  let hits = 0;
  let mrr = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const refs = (await store.hybridSearch(c.query, 10)).map((h) => h.ref);
    const idx = refs.findIndex((r) => c.expected.includes(r));
    if (idx >= 0) {
      hits++;
      mrr += 1 / (idx + 1);
    } else {
      misses.push(c.query);
    }
  }
  mrr /= cases.length;

  assert.ok(
    hits >= RECALL_FLOOR,
    `Recall@10 fell below the floor: ${hits}/${cases.length} (floor ${RECALL_FLOOR}). Missing: ${misses.join(" | ")}`,
  );
  assert.ok(mrr >= MRR_FLOOR, `MRR fell below the floor: ${mrr.toFixed(3)} (floor ${MRR_FLOOR})`);
});
