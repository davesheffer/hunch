/**
 * The JSON source of truth under .brain/. One file per entity (human-reviewable
 * in PRs, diffable, mergeable). This layer never touches SQLite — it is the
 * authoritative read/write surface; SQLite is rebuilt from it.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrainPaths } from "../core/paths.js";
import { ENTITY_KINDS, SCHEMAS, type EntityKind, type EntityFor } from "../core/types.js";

/** High-cardinality collections (symbols, edges) are stored as a single
 *  index.json array — there can be thousands, and one file per edge would create
 *  enormous git noise. Curated, low-volume entities (components, decisions, bugs,
 *  constraints) are one file per record so they're cleanly reviewable in PRs. */
const SINGLE_FILE: Partial<Record<EntityKind, string>> = { symbols: "index.json", edges: "index.json" };

export class JsonStore {
  constructor(private readonly paths: BrainPaths) {}

  /** Create .brain/<kind>/ directories. */
  ensureDirs(): void {
    mkdirSync(this.paths.brain, { recursive: true });
    for (const kind of ENTITY_KINDS) mkdirSync(this.paths.dir(kind), { recursive: true });
  }

  private fileFor(kind: EntityKind, id: string): string {
    const single = SINGLE_FILE[kind];
    if (single) return join(this.paths.dir(kind), single);
    return join(this.paths.dir(kind), `${id}.json`);
  }

  /** Load every record of a kind, validated against its schema. Invalid records
   *  are skipped with a warning rather than crashing the whole load. */
  loadAll<K extends EntityKind>(kind: K): EntityFor[K][] {
    const dir = this.paths.dir(kind);
    if (!existsSync(dir)) return [];
    const schema = SCHEMAS[kind];
    const out: EntityFor[K][] = [];
    const single = SINGLE_FILE[kind];
    if (single) {
      const f = join(dir, single);
      if (!existsSync(f)) return [];
      let arr: unknown;
      try {
        arr = JSON.parse(readFileSync(f, "utf8"));
      } catch (e) {
        console.warn(`[brain] skipping corrupt ${kind}/${single}: ${(e as Error).message}`);
        return out;
      }
      for (const raw of Array.isArray(arr) ? arr : []) {
        const r = schema.safeParse(raw);
        if (r.success) out.push(r.data as EntityFor[K]);
        else console.warn(`[brain] skipping invalid ${kind} record: ${r.error.issues[0]?.message}`);
      }
      return out;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch (e) {
        console.warn(`[brain] skipping corrupt ${kind}/${name}: ${(e as Error).message}`);
        continue;
      }
      const r = schema.safeParse(raw);
      if (r.success) out.push(r.data as EntityFor[K]);
      else console.warn(`[brain] skipping invalid ${kind}/${name}: ${r.error.issues[0]?.message}`);
    }
    return out;
  }

  /** Write a single record (validated) to its JSON file / into the index array. */
  put<K extends EntityKind>(kind: K, record: EntityFor[K]): EntityFor[K] {
    const schema = SCHEMAS[kind];
    const validated = schema.parse(record) as EntityFor[K] & { id: string };
    mkdirSync(this.paths.dir(kind), { recursive: true });
    const single = SINGLE_FILE[kind];
    if (single) {
      const all = this.loadAll(kind).filter((r) => (r as { id: string }).id !== validated.id);
      all.push(validated);
      writeFileSync(this.fileFor(kind, validated.id), JSON.stringify(all, null, 2) + "\n");
    } else {
      writeFileSync(this.fileFor(kind, validated.id), JSON.stringify(validated, null, 2) + "\n");
    }
    return validated;
  }

  /** Bulk replace all records of a kind (used by the extractor for symbols/edges). */
  replaceAll<K extends EntityKind>(kind: K, records: EntityFor[K][]): void {
    const schema = SCHEMAS[kind];
    const validated = records.map((r) => schema.parse(r));
    mkdirSync(this.paths.dir(kind), { recursive: true });
    const single = SINGLE_FILE[kind];
    if (single) {
      writeFileSync(this.fileFor(kind, "index"), JSON.stringify(validated, null, 2) + "\n");
      return;
    }
    // one file per record: clear stale files, then write
    for (const name of existsSync(this.paths.dir(kind)) ? readdirSync(this.paths.dir(kind)) : []) {
      if (name.endsWith(".json")) rmSync(join(this.paths.dir(kind), name));
    }
    for (const r of validated) {
      writeFileSync(this.fileFor(kind, (r as { id: string }).id), JSON.stringify(r, null, 2) + "\n");
    }
  }

  get<K extends EntityKind>(kind: K, id: string): EntityFor[K] | undefined {
    return this.loadAll(kind).find((r) => (r as { id: string }).id === id);
  }
}
