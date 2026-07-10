import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { hunchPathsForDir } from "../core/paths.js";
import { indexRepo } from "../extractors/indexer.js";
import { HunchStore } from "../store/hunchStore.js";
import { graphSnapshot, type GraphSnapshot } from "./evaluator.js";

interface ReplayWorkerInput {
  checkout: string;
  graph: string;
  root: string;
  commit: string;
}

interface ReplayWorkerMessage {
  commit: string;
  snapshot?: GraphSnapshot;
  error_code?: string;
}

const taskFile = process.argv[2];
const resultFile = process.argv[3];
if (!taskFile || !resultFile) throw new Error("replay worker requires task and result files");
const input = JSON.parse(readFileSync(taskFile, "utf8")) as ReplayWorkerInput;
let store: HunchStore | undefined;
let message: ReplayWorkerMessage;

try {
  store = new HunchStore(hunchPathsForDir(input.graph));
  store.json.ensureDirs();
  indexRepo(store, input.checkout, { churn: false });
  message = {
    commit: input.commit,
    snapshot: graphSnapshot(store, input.root, { publicOnly: true, head: input.commit }),
  };
} catch {
  message = { commit: input.commit, error_code: "snapshot-index-failed" };
} finally {
  try { store?.close(); } catch { /* the parent still removes the derived graph */ }
}

const temporary = `${resultFile}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(message));
renameSync(temporary, resultFile);
