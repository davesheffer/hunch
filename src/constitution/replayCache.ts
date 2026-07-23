import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { ComponentSchema, EdgeSchema, SymbolSchema } from "../core/types.js";
import { writeFileAtomic } from "../core/io.js";
import { canonicalHash } from "./canonical.js";
import { graphSnapshotFromRecords, type GraphSnapshot } from "./evaluator.js";
import { DataClassSchema, POLICY_EVALUATOR, type DataClass } from "./schema.js";

export const REPLAY_CACHE_ENGINE = { name: "hunch-tsjs-static-index", version: "4" } as const;

const ReplayGraphCacheSchema = z.object({
  version: z.literal(1),
  engine: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  evaluator: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  repository: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  data_class: DataClassSchema,
  graph_hash: z.string().min(1),
  symbols: z.array(SymbolSchema),
  edges: z.array(EdgeSchema),
  components: z.array(ComponentSchema),
  content_hash: z.string().min(1),
}).strict();

type ReplayGraphCache = z.infer<typeof ReplayGraphCacheSchema>;
export type ReplayCacheStatus = "hit" | "miss" | "invalid";

function cacheBody(snapshot: GraphSnapshot, dataClass: DataClass, engineVersion: string) {
  return {
    version: 1 as const,
    engine: { name: REPLAY_CACHE_ENGINE.name, version: engineVersion },
    evaluator: { ...POLICY_EVALUATOR },
    repository: basename(snapshot.root),
    commit: snapshot.head,
    data_class: dataClass,
    graph_hash: snapshot.graph_hash,
    symbols: snapshot.symbols,
    edges: snapshot.edges,
    components: snapshot.components,
  };
}

export function replayCacheKey(commit: string, dataClass: DataClass, engineVersion = REPLAY_CACHE_ENGINE.version): string {
  return canonicalHash({
    version: 1,
    engine: { ...REPLAY_CACHE_ENGINE, version: engineVersion },
    evaluator: POLICY_EVALUATOR,
    commit,
    data_class: dataClass,
  }).replace(/^sha1:/, "");
}

export function replayCacheFile(root: string, commit: string, dataClass: DataClass, engineVersion = REPLAY_CACHE_ENGINE.version): string {
  return join(root, ".hunch-cache", "replay", dataClass, `${replayCacheKey(commit, dataClass, engineVersion)}.json`);
}

export function loadReplaySnapshot(
  root: string,
  commit: string,
  dataClass: DataClass,
  engineVersion = REPLAY_CACHE_ENGINE.version,
): { status: ReplayCacheStatus; snapshot?: GraphSnapshot } {
  const file = replayCacheFile(root, commit, dataClass, engineVersion);
  if (!existsSync(file)) return { status: "miss" };
  try {
    const cached = ReplayGraphCacheSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    const { content_hash: _hash, ...body } = cached;
    if (cached.content_hash !== canonicalHash(body)) throw new Error("content hash mismatch");
    if (cached.commit !== commit || cached.data_class !== dataClass) throw new Error("cache identity mismatch");
    if (cached.repository !== basename(root)) throw new Error("cache repository mismatch");
    if (cached.engine.name !== REPLAY_CACHE_ENGINE.name || cached.engine.version !== engineVersion) throw new Error("cache engine mismatch");
    if (cached.evaluator.name !== POLICY_EVALUATOR.name || cached.evaluator.version !== POLICY_EVALUATOR.version) throw new Error("cache evaluator mismatch");
    const snapshot = graphSnapshotFromRecords(root, commit, cached.symbols, cached.edges, cached.components);
    if (snapshot.graph_hash !== cached.graph_hash) throw new Error("graph hash mismatch");
    return { status: "hit", snapshot };
  } catch {
    try { rmSync(file, { force: true }); } catch { /* a derived cache may be rebuilt without deletion */ }
    return { status: "invalid" };
  }
}

export function putReplaySnapshot(
  root: string,
  snapshot: GraphSnapshot,
  dataClass: DataClass,
  engineVersion = REPLAY_CACHE_ENGINE.version,
): string {
  if (!/^[a-f0-9]{40}$/.test(snapshot.head)) throw new Error("replay cache requires an immutable full commit SHA");
  const body = cacheBody(snapshot, dataClass, engineVersion);
  const record: ReplayGraphCache = ReplayGraphCacheSchema.parse({ ...body, content_hash: canonicalHash(body) });
  const file = replayCacheFile(root, snapshot.head, dataClass, engineVersion);
  mkdirSync(join(root, ".hunch-cache", "replay", dataClass), { recursive: true });
  writeFileAtomic(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}
