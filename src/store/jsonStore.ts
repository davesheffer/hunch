/**
 * The JSON source of truth under .hunch/. One file per entity (human-reviewable
 * in PRs, diffable, mergeable). This layer never touches SQLite — it is the
 * authoritative read/write surface; SQLite is rebuilt from it.
 */
import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HunchPaths } from "../core/paths.js";
import { ENTITY_KINDS, SCHEMAS, type EntityKind, type EntityFor } from "../core/types.js";
import { migrateRaw, readManifest, writeManifest, SCHEMA_VERSION } from "../core/migrate.js";
import { writeFileAtomic } from "../core/io.js";

/** High-cardinality collections (symbols, edges) are stored as a single
 *  index.json array — there can be thousands, and one file per edge would create
 *  enormous git noise. Curated, low-volume entities (components, decisions, bugs,
 *  constraints) are one file per record so they're cleanly reviewable in PRs. */
const SINGLE_FILE: Partial<Record<EntityKind, string>> = { symbols: "index.json", edges: "index.json" };

const encode = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

export class JsonStore {
  private _warnedForward = false;
  /** Memoized validated records per kind. loadAll() is on every read-path method
   *  (why/checkConstraints/fragility/assembleContext…), each of which previously
   *  re-read the directory and re-ran Zod over every record. Cache keyed by the
   *  kind dir's mtime: every write goes through writeFileAtomic (temp + rename) or
   *  rmSync, both of which bump the dir mtime — so an OUT-OF-BAND write by another
   *  process self-invalidates on the next read. In-process writes also invalidate
   *  explicitly (exact, independent of mtime granularity). */
  private cache = new Map<EntityKind, { mtimeMs: number; data: readonly unknown[] }>();

  constructor(private readonly paths: HunchPaths) {}

  /** Drop memoized loadAll results. Writes through this store invalidate the
   *  affected kind automatically; call this for OUT-OF-BAND changes to .hunch/
   *  JSON (e.g. the long-lived MCP server reacting to a file-watch, or after an
   *  external `hunch migrate`). */
  clearCache(): void {
    this.cache.clear();
  }

  private invalidate(kind: EntityKind): void {
    this.cache.delete(kind);
  }

  /** Create .hunch/<kind>/ directories. Stamp the manifest at the CURRENT version
   *  only when scaffolding a FRESH .hunch/ (so `hunch index`/`sync` on a brand-new
   *  repo records the version too, not just `init`). A pre-existing .hunch/ without
   *  a manifest is LEGACY — left unstamped so it defaults to the baseline and
   *  `hunch migrate` upgrades it. */
  ensureDirs(): void {
    const fresh = !existsSync(this.paths.hunch);
    mkdirSync(this.paths.hunch, { recursive: true });
    for (const kind of ENTITY_KINDS) mkdirSync(this.paths.dir(kind), { recursive: true });
    if (fresh && !existsSync(this.paths.manifest)) writeManifest(this.paths, SCHEMA_VERSION);
  }

  /** The on-disk schema version (from the manifest), read FRESH each call so a
   *  long-lived process (the MCP server) reflects an out-of-band `hunch migrate`. */
  schemaVersion(): number {
    const v = readManifest(this.paths).schema_version;
    if (v > SCHEMA_VERSION && !this._warnedForward) {
      this._warnedForward = true;
      console.warn(
        `[hunch] .hunch/ was written by a newer schema (v${v} > v${SCHEMA_VERSION}); ` +
          `records may not load correctly — upgrade hunch.`,
      );
    }
    return v;
  }

  /** Migrate one raw record UP to the current schema before validation, so a
   *  schema bump never makes the loader silently skip (drop) old records. The
   *  on-disk `version` is read ONCE per load (not per record) by the caller. */
  private migrate(kind: EntityKind, raw: unknown, version: number): unknown {
    return migrateRaw(kind, raw, version);
  }

  private fileFor(kind: EntityKind, id: string): string {
    const single = SINGLE_FILE[kind];
    if (single) return join(this.paths.dir(kind), single);
    return join(this.paths.dir(kind), `${id}.json`);
  }

  /** Load every record of a kind, validated against its schema. Memoized — the
   *  returned array is shared and MUST be treated read-only (every caller already
   *  derives via filter/map/sort, which copy). Invalidated on write. */
  loadAll<K extends EntityKind>(kind: K): EntityFor[K][] {
    const dir = this.paths.dir(kind);
    const mtimeMs = existsSync(dir) ? statSync(dir).mtimeMs : 0;
    const hit = this.cache.get(kind);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data as EntityFor[K][];
    const data = this.readAllFromDisk(kind);
    this.cache.set(kind, { mtimeMs, data });
    return data;
  }

  /** Uncached disk read + validate. Invalid records are skipped with a warning
   *  rather than crashing the whole load. */
  private readAllFromDisk<K extends EntityKind>(kind: K): EntityFor[K][] {
    const dir = this.paths.dir(kind);
    if (!existsSync(dir)) return [];
    const schema = SCHEMAS[kind];
    const out: EntityFor[K][] = [];
    const version = this.schemaVersion(); // read the manifest ONCE per load, not per record
    const single = SINGLE_FILE[kind];
    if (single) {
      const f = join(dir, single);
      if (!existsSync(f)) return [];
      let arr: unknown;
      try {
        arr = JSON.parse(readFileSync(f, "utf8"));
      } catch (e) {
        console.warn(`[hunch] skipping corrupt ${kind}/${single}: ${(e as Error).message}`);
        return out;
      }
      for (const raw of Array.isArray(arr) ? arr : []) {
        const r = schema.safeParse(this.migrate(kind, raw, version));
        if (r.success) out.push(r.data as EntityFor[K]);
        else console.warn(`[hunch] skipping invalid ${kind} record: ${r.error.issues[0]?.message}`);
      }
      return out;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch (e) {
        console.warn(`[hunch] skipping corrupt ${kind}/${name}: ${(e as Error).message}`);
        continue;
      }
      const r = schema.safeParse(this.migrate(kind, raw, version));
      if (r.success) out.push(r.data as EntityFor[K]);
      else console.warn(`[hunch] skipping invalid ${kind}/${name}: ${r.error.issues[0]?.message}`);
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
      // Operate on the RAW array (NOT the validating loadAll) so updating one
      // record can't silently drop schema-invalid / future-schema siblings — the
      // same reason delete() reads raw. Keep the index sorted by id (stable diff,
      // and agrees with the merge driver so a re-index after a merge is a no-op).
      const f = this.fileFor(kind, validated.id);
      const arr = this.readRawArray(f).filter((r) => (r as { id?: string })?.id !== validated.id);
      arr.push(validated);
      arr.sort((a, b) => String((a as { id?: string })?.id).localeCompare(String((b as { id?: string })?.id)));
      writeFileAtomic(f, encode(arr));
    } else {
      writeFileAtomic(this.fileFor(kind, validated.id), encode(validated));
    }
    this.invalidate(kind);
    return validated;
  }

  /** Bulk replace all records of a kind (used by the extractor for symbols/edges). */
  replaceAll<K extends EntityKind>(kind: K, records: EntityFor[K][]): void {
    const schema = SCHEMAS[kind];
    const validated = records.map((r) => schema.parse(r));
    this.invalidate(kind);
    mkdirSync(this.paths.dir(kind), { recursive: true });
    const single = SINGLE_FILE[kind];
    if (single) {
      // Sorted by id so the index has ONE canonical order — re-indexing after a
      // git merge (which the driver also id-sorts) doesn't churn the whole file.
      validated.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
      writeFileAtomic(this.fileFor(kind, "index"), encode(validated));
      return;
    }
    // one file per record: clear stale files, then write
    for (const name of existsSync(this.paths.dir(kind)) ? readdirSync(this.paths.dir(kind)) : []) {
      if (name.endsWith(".json")) rmSync(join(this.paths.dir(kind), name));
    }
    for (const r of validated) {
      writeFileAtomic(this.fileFor(kind, (r as { id: string }).id), encode(r));
    }
  }

  /** Read a single-file index as a raw array (no validation). Missing/empty → [].
   *  A non-empty file that fails to parse THROWS — we must never silently treat a
   *  corrupt index as empty and then rewrite it, which would flatten every existing
   *  record. (`hunch index` rebuilds from scratch via replaceAll to recover.) */
  private readRawArray(f: string): unknown[] {
    if (!existsSync(f)) return [];
    const text = readFileSync(f, "utf8");
    if (!text.trim()) return [];
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (e) {
      throw new Error(`refusing to rewrite ${f}: the existing index is not valid JSON (${(e as Error).message}). Fix or remove it, then re-run \`hunch index\`.`);
    }
    return Array.isArray(v) ? v : [];
  }

  get<K extends EntityKind>(kind: K, id: string): EntityFor[K] | undefined {
    return this.loadAll(kind).find((r) => (r as { id: string }).id === id);
  }

  /** Remove a record (used by the curate/reject flow). Returns true if removed.
   *  For single-file kinds we operate on the RAW JSON array (not the validating
   *  loader) so deleting one record can't silently drop schema-invalid siblings. */
  delete<K extends EntityKind>(kind: K, id: string): boolean {
    const single = SINGLE_FILE[kind];
    if (single) {
      const f = this.fileFor(kind, "index");
      if (!existsSync(f)) return false;
      const arr = this.readRawArray(f);
      const next = arr.filter((r) => (r as { id?: string })?.id !== id);
      if (next.length === arr.length) return false;
      writeFileAtomic(f, encode(next));
      this.invalidate(kind);
      return true;
    }
    const f = this.fileFor(kind, id);
    if (!existsSync(f)) return false;
    rmSync(f);
    this.invalidate(kind);
    return true;
  }

  /** Persist a schema migration: rewrite every LOADABLE record in its current shape.
   *  A record that still fails validation after migration is kept untouched (never
   *  deleted) and counted as `skipped`, so migration can't lose data. The caller
   *  bumps the manifest afterward. */
  persistMigration(): { migrated: number; skipped: number } {
    let migrated = 0;
    let skipped = 0;
    this.cache.clear(); // every record is rewritten; drop all memoized loads
    const version = this.schemaVersion(); // read once; we're migrating FROM this
    for (const kind of ENTITY_KINDS) {
      const dir = this.paths.dir(kind);
      if (!existsSync(dir)) continue;
      const schema = SCHEMAS[kind];
      const single = SINGLE_FILE[kind];
      if (single) {
        const f = join(dir, single);
        if (!existsSync(f)) continue;
        let arr: unknown;
        try {
          arr = JSON.parse(readFileSync(f, "utf8"));
        } catch {
          skipped++;
          continue;
        }
        if (!Array.isArray(arr)) {
          skipped++;
          continue;
        }
        const kept: unknown[] = [];
        for (const raw of arr) {
          const r = schema.safeParse(this.migrate(kind, raw, version));
          if (r.success) {
            kept.push(r.data);
            migrated++;
          } else {
            kept.push(raw); // preserve unmigratable records rather than drop them
            skipped++;
          }
        }
        writeFileAtomic(f, encode(kept));
      } else {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".json")) continue;
          const p = join(dir, name);
          let raw: unknown;
          try {
            raw = JSON.parse(readFileSync(p, "utf8"));
          } catch {
            skipped++;
            continue;
          }
          const r = schema.safeParse(this.migrate(kind, raw, version));
          if (r.success) {
            writeFileAtomic(p, encode(r.data));
            migrated++;
          } else {
            skipped++; // leave the file as-is
          }
        }
      }
    }
    return { migrated, skipped };
  }
}
