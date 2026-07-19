/**
 * The JSON source of truth under .hunch/. One file per entity (human-reviewable
 * in PRs, diffable, mergeable). This layer never touches SQLite — it is the
 * authoritative read/write surface; SQLite is rebuilt from it.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HunchPaths } from "../core/paths.js";
import { ENTITY_KINDS, SCHEMAS, type EntityKind, type EntityFor } from "../core/types.js";
import { BASELINE_VERSION, migrateRaw, SCHEMA_VERSION } from "../core/migrate.js";
import { writeFileAtomic } from "../core/io.js";

/** High-cardinality collections (symbols, edges) are stored as a single
 *  index.json array — there can be thousands, and one file per edge would create
 *  enormous git noise. Curated, low-volume entities (components, decisions, bugs,
 *  constraints) are one file per record so they're cleanly reviewable in PRs. */
const SINGLE_FILE: Partial<Record<EntityKind, string>> = { symbols: "index.json", edges: "index.json" };

const encode = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

/** Curated entities are intentionally small, human-reviewable records. Symbols
 * and edges are dense indexes, so they get a much larger but still finite cap. */
export const MAX_JSON_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_INDEX_BYTES = 256 * 1024 * 1024;
export const MAX_JSON_MANIFEST_BYTES = 64 * 1024;
export const MAX_JSON_DIRECTORY_ENTRIES_PER_KIND = 100_000;

type FileStat = Stats;
type SafeDirectory = { lexical: string; canonical: string; stat: FileStat };

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pathIsWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function unsafePath(path: string, reason: string): Error {
  return new Error(`[hunch] refusing unsafe JSON store path ${path}: ${reason}`);
}

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

  private readonly lexicalRoot: string;
  private readonly canonicalRoot: string;
  private readonly lexicalHunch: string;

  constructor(private readonly paths: HunchPaths) {
    this.lexicalRoot = resolve(paths.root);
    this.canonicalRoot = realpathSync(this.lexicalRoot);
    this.lexicalHunch = resolve(paths.hunch);
    const hunchRelative = relative(this.lexicalRoot, this.lexicalHunch);
    if (!hunchRelative || !pathIsWithin(this.lexicalHunch, this.lexicalRoot)) {
      throw unsafePath(paths.hunch, "the Hunch directory is not a child of its declared store root");
    }
  }

  private lstatOrMissing(path: string): FileStat | null {
    try {
      return lstatSync(path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private expectedCanonical(path: string): string {
    const lexical = resolve(path);
    if (!pathIsWithin(lexical, this.lexicalRoot)) {
      throw unsafePath(path, "path escapes the declared store root");
    }
    return resolve(this.canonicalRoot, relative(this.lexicalRoot, lexical));
  }

  /** Require an ordinary, canonically-contained directory. Creation is one
   * component at a time after its parent has been validated; recursive mkdir
   * would otherwise traverse a malicious pre-existing symlink. */
  private safeDirectory(path: string, create: boolean): SafeDirectory | null {
    const lexical = resolve(path);
    const expected = this.expectedCanonical(lexical);
    let stat = this.lstatOrMissing(lexical);
    if (!stat) {
      if (!create) return null;
      mkdirSync(lexical);
      stat = lstatSync(lexical);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw unsafePath(lexical, "expected an ordinary directory (symlinks are not followed)");
    }
    const canonical = realpathSync(lexical);
    if (canonical !== expected || !pathIsWithin(canonical, this.canonicalRoot)) {
      throw unsafePath(lexical, "canonical directory escapes its declared store root");
    }
    return { lexical, canonical, stat };
  }

  private safeHunchDirectory(create: boolean): SafeDirectory | null {
    const current = this.safeDirectory(this.lexicalHunch, false);
    if (current || !create) return current;
    // The declared root was canonicalized in the constructor and the Hunch dir
    // is its direct child for both public and private-overlay path builders.
    const parent = resolve(this.lexicalHunch, "..");
    if (parent !== this.lexicalRoot) {
      throw unsafePath(this.lexicalHunch, "the Hunch directory is not directly beneath its store root");
    }
    return this.safeDirectory(this.lexicalHunch, true);
  }

  private assertKind(kind: EntityKind): void {
    if (!(ENTITY_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`[hunch] unknown JSON entity kind: ${String(kind)}`);
    }
  }

  private safeKindDirectory(kind: EntityKind, create: boolean): SafeDirectory | null {
    this.assertKind(kind);
    const hunch = this.safeHunchDirectory(create);
    if (!hunch) return null;
    const lexical = resolve(this.paths.dir(kind));
    if (resolve(lexical, "..") !== this.lexicalHunch || lexical !== resolve(this.lexicalHunch, kind)) {
      throw unsafePath(lexical, `kind directory ${kind} is not directly beneath the Hunch directory`);
    }
    return this.safeDirectory(lexical, create);
  }

  private maxBytes(kind: EntityKind): number {
    return SINGLE_FILE[kind] ? MAX_JSON_INDEX_BYTES : MAX_JSON_RECORD_BYTES;
  }

  private assertSafeRecordId(id: string): void {
    // Entity schemas intentionally accept free-form IDs for backwards
    // compatibility. The storage boundary must still reject path syntax.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === "." || id === "..") {
      throw new Error(`[hunch] refusing unsafe JSON record id: ${JSON.stringify(id)}`);
    }
  }

  private assertFileBelongsTo(directory: SafeDirectory, file: string): string {
    const lexical = resolve(file);
    const rel = relative(directory.lexical, lexical);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
      throw unsafePath(file, "record path is not a direct child of its kind directory");
    }
    return lexical;
  }

  private validateExistingFile(
    directory: SafeDirectory,
    file: string,
    maxBytes: number,
  ): FileStat | null {
    const lexical = this.assertFileBelongsTo(directory, file);
    const stat = this.lstatOrMissing(lexical);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw unsafePath(lexical, "expected an ordinary file (symlinks and special files are not followed)");
    }
    if (stat.nlink !== 1) {
      throw unsafePath(lexical, "hard-linked records are not accepted");
    }
    if (stat.size > maxBytes) {
      throw new Error(`[hunch] refusing oversized JSON file ${lexical}: ${stat.size} bytes exceeds ${maxBytes}`);
    }
    const canonical = realpathSync(lexical);
    if (canonical !== resolve(directory.canonical, relative(directory.lexical, lexical))) {
      throw unsafePath(lexical, "canonical record path escapes its kind directory");
    }
    return stat;
  }

  /** Read through the exact descriptor whose type, identity, containment, and
   * finite size were checked. Returning null means the file is absent. */
  private readContainedFile(directory: SafeDirectory, file: string, maxBytes: number): string | null {
    const lexical = this.assertFileBelongsTo(directory, file);
    const before = this.validateExistingFile(directory, lexical, maxBytes);
    if (!before) return null;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      const after = lstatSync(lexical);
      if (!opened.isFile() || !after.isFile() || after.isSymbolicLink()
        || opened.nlink !== 1 || after.nlink !== 1
        || opened.size > maxBytes
        || opened.dev !== before.dev || opened.ino !== before.ino
        || after.dev !== opened.dev || after.ino !== opened.ino
        || realpathSync(lexical) !== resolve(directory.canonical, relative(directory.lexical, lexical))) {
        throw unsafePath(lexical, "record changed identity or containment while it was opened");
      }
      // Read only the byte count that passed fstat. Reading the descriptor to
      // EOF would let an in-place grow race turn a bounded check into an
      // unbounded allocation.
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      return bytes.subarray(0, offset).toString("utf8");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private writeContainedFile(directory: SafeDirectory, file: string, data: string, maxBytes: number): void {
    const lexical = this.assertFileBelongsTo(directory, file);
    const bytes = Buffer.byteLength(data);
    if (bytes > maxBytes) {
      throw new Error(`[hunch] refusing oversized JSON write ${lexical}: ${bytes} bytes exceeds ${maxBytes}`);
    }
    // Refuse an existing symlink/hardlink/special file rather than relying on
    // rename semantics that differ across platforms.
    this.validateExistingFile(directory, lexical, maxBytes);
    writeFileAtomic(lexical, data);
    this.validateExistingFile(directory, lexical, maxBytes);
    // Detect a kind-dir replacement around the atomic rename before reporting
    // success. (Node has no portable openat/renameat API; this closes the static
    // committed-symlink attack and detects the common concurrent replacement.)
    this.safeDirectory(directory.lexical, false);
  }

  private removeContainedFile(directory: SafeDirectory, file: string, maxBytes: number): boolean {
    const lexical = this.assertFileBelongsTo(directory, file);
    if (!this.validateExistingFile(directory, lexical, maxBytes)) return false;
    rmSync(lexical);
    this.safeDirectory(directory.lexical, false);
    return true;
  }

  private jsonFileNames(kind: EntityKind): string[] {
    const directory = this.safeKindDirectory(kind, false);
    if (!directory) return [];
    const names: string[] = [];
    let entries = 0;
    const handle = opendirSync(directory.lexical);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        entries++;
        if (entries > MAX_JSON_DIRECTORY_ENTRIES_PER_KIND) {
          throw new Error(`[hunch] refusing JSON kind ${kind}: more than ${MAX_JSON_DIRECTORY_ENTRIES_PER_KIND} directory entries`);
        }
        if (!entry.name.endsWith(".json")) continue;
        names.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    this.safeDirectory(directory.lexical, false);
    return names.sort();
  }

  /** Drop memoized loadAll results. Writes through this store invalidate the
   *  affected kind automatically; call this for OUT-OF-BAND changes to .hunch/
   *  JSON (e.g. the long-lived MCP server reacting to a file-watch, or after an
   *  external `hunch migrate`). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Cheap revision marker for the JSON source tree. Hunch writes records with
   *  temp-file + rename, so every supported add/update/delete bumps the containing
   *  kind directory's metadata. Include the manifest separately because a schema
   *  migration can change how otherwise-identical record bytes are interpreted.
   *  This lets long-lived readers notice another process without hashing or
   *  reparsing the complete graph on every request. */
  changeStamp(): string {
    const hunch = this.safeHunchDirectory(false);
    const manifestStamp = (): string => {
      if (!hunch) return "missing";
      const stat = this.validateExistingFile(hunch, this.paths.manifest, MAX_JSON_MANIFEST_BYTES);
      if (!stat) return "missing";
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    };
    return [
      `manifest:${manifestStamp()}`,
      ...ENTITY_KINDS.map((kind) => {
        const directory = this.safeKindDirectory(kind, false);
        return `${kind}:${directory ? `${directory.stat.mtimeMs}:${directory.stat.ctimeMs}:${directory.stat.size}` : "missing"}`;
      }),
    ].join("|");
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
    const fresh = !this.safeHunchDirectory(false);
    const hunch = this.safeHunchDirectory(true)!;

    // Preflight every existing kind before creating anything else. An unsafe
    // committed kind symlink therefore fails init without partially scaffolding.
    for (const kind of ENTITY_KINDS) this.safeKindDirectory(kind, false);
    for (const kind of ENTITY_KINDS) this.safeKindDirectory(kind, true);

    const manifest = this.validateExistingFile(hunch, this.paths.manifest, MAX_JSON_MANIFEST_BYTES);
    if (fresh && !manifest) {
      this.writeContainedFile(
        hunch,
        this.paths.manifest,
        JSON.stringify({ schema_version: SCHEMA_VERSION }, null, 2) + "\n",
        MAX_JSON_MANIFEST_BYTES,
      );
    }
  }

  /** The on-disk schema version (from the manifest), read FRESH each call so a
   *  long-lived process (the MCP server) reflects an out-of-band `hunch migrate`. */
  schemaVersion(): number {
    const hunch = this.safeHunchDirectory(false);
    let v = BASELINE_VERSION;
    if (hunch) {
      const text = this.readContainedFile(hunch, this.paths.manifest, MAX_JSON_MANIFEST_BYTES);
      if (text !== null) {
        try {
          const manifest = JSON.parse(text) as { schema_version?: unknown };
          if (typeof manifest.schema_version === "number" && Number.isInteger(manifest.schema_version)) {
            v = manifest.schema_version;
          }
        } catch { /* corrupt manifests intentionally retain baseline semantics */ }
      }
    }
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
    this.assertSafeRecordId(id);
    return join(this.paths.dir(kind), `${id}.json`);
  }

  /** Load every record of a kind, validated against its schema. Memoized — the
   *  returned array is shared and MUST be treated read-only (every caller already
   *  derives via filter/map/sort, which copy). Invalidated on write. */
  loadAll<K extends EntityKind>(kind: K): EntityFor[K][] {
    const directory = this.safeKindDirectory(kind, false);
    const mtimeMs = directory?.stat.mtimeMs ?? 0;
    const hit = this.cache.get(kind);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data as EntityFor[K][];
    const data = this.readAllFromDisk(kind);
    this.cache.set(kind, { mtimeMs, data });
    return data;
  }

  /** Uncached disk read + validate. Invalid records are skipped with a warning
   *  rather than crashing the whole load. */
  private readAllFromDisk<K extends EntityKind>(kind: K): EntityFor[K][] {
    const directory = this.safeKindDirectory(kind, false);
    if (!directory) return [];
    const schema = SCHEMAS[kind];
    const out: EntityFor[K][] = [];
    const version = this.schemaVersion(); // read the manifest ONCE per load, not per record
    const single = SINGLE_FILE[kind];
    if (single) {
      const f = join(directory.lexical, single);
      let arr: unknown;
      try {
        const text = this.readContainedFile(directory, f, this.maxBytes(kind));
        if (text === null) return [];
        arr = JSON.parse(text);
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
    for (const name of this.jsonFileNames(kind)) {
      let raw: unknown;
      try {
        const text = this.readContainedFile(directory, join(directory.lexical, name), this.maxBytes(kind));
        if (text === null) continue;
        raw = JSON.parse(text);
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
    const single = SINGLE_FILE[kind];
    if (!single) this.assertSafeRecordId(validated.id);
    const directory = this.safeKindDirectory(kind, true)!;
    if (single) {
      // Operate on the RAW array (NOT the validating loadAll) so updating one
      // record can't silently drop schema-invalid / future-schema siblings — the
      // same reason delete() reads raw. Keep the index sorted by id (stable diff,
      // and agrees with the merge driver so a re-index after a merge is a no-op).
      const f = this.fileFor(kind, validated.id);
      const arr = this.readRawArray(kind, directory, f).filter((r) => (r as { id?: string })?.id !== validated.id);
      arr.push(validated);
      arr.sort((a, b) => String((a as { id?: string })?.id).localeCompare(String((b as { id?: string })?.id)));
      this.writeContainedFile(directory, f, encode(arr), this.maxBytes(kind));
    } else {
      this.writeContainedFile(directory, this.fileFor(kind, validated.id), encode(validated), this.maxBytes(kind));
    }
    this.invalidate(kind);
    return validated;
  }

  /** Bulk replace all records of a kind (used by the extractor for symbols/edges). */
  replaceAll<K extends EntityKind>(kind: K, records: EntityFor[K][]): void {
    const schema = SCHEMAS[kind];
    const validated = records.map((r) => schema.parse(r));
    const single = SINGLE_FILE[kind];
    if (!single) {
      for (const record of validated) this.assertSafeRecordId(String((record as { id: string }).id));
    }
    this.invalidate(kind);
    const directory = this.safeKindDirectory(kind, true)!;
    if (single) {
      // Sorted by id so the index has ONE canonical order — re-indexing after a
      // git merge (which the driver also id-sorts) doesn't churn the whole file.
      validated.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
      this.writeContainedFile(directory, this.fileFor(kind, "index"), encode(validated), this.maxBytes(kind));
      return;
    }
    // One file per record: preflight EVERY existing JSON file before deleting
    // any, so one malicious symlink cannot cause a partially-cleared store.
    const existing = this.jsonFileNames(kind);
    for (const name of existing) {
      this.validateExistingFile(directory, join(directory.lexical, name), this.maxBytes(kind));
    }
    for (const name of existing) {
      this.removeContainedFile(directory, join(directory.lexical, name), this.maxBytes(kind));
    }
    for (const r of validated) {
      const id = (r as { id: string }).id;
      this.writeContainedFile(directory, this.fileFor(kind, id), encode(r), this.maxBytes(kind));
    }
  }

  /** Read a single-file index as a raw array (no validation). Missing/empty → [].
   *  A non-empty file that fails to parse THROWS — we must never silently treat a
   *  corrupt index as empty and then rewrite it, which would flatten every existing
   *  record. (`hunch index` rebuilds from scratch via replaceAll to recover.) */
  private readRawArray(kind: EntityKind, directory: SafeDirectory, f: string): unknown[] {
    const text = this.readContainedFile(directory, f, this.maxBytes(kind));
    if (text === null) return [];
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
      const directory = this.safeKindDirectory(kind, false);
      if (!directory) return false;
      const f = this.fileFor(kind, "index");
      const arr = this.readRawArray(kind, directory, f);
      if (!this.validateExistingFile(directory, f, this.maxBytes(kind))) return false;
      const next = arr.filter((r) => (r as { id?: string })?.id !== id);
      if (next.length === arr.length) return false;
      this.writeContainedFile(directory, f, encode(next), this.maxBytes(kind));
      this.invalidate(kind);
      return true;
    }
    this.assertSafeRecordId(id);
    const directory = this.safeKindDirectory(kind, false);
    if (!directory) return false;
    const f = this.fileFor(kind, id);
    if (!this.removeContainedFile(directory, f, this.maxBytes(kind))) return false;
    this.invalidate(kind);
    return true;
  }

  /** Remove EVERY record of a kind from disk (the kind dir's JSON files), keeping
   *  the dir itself so the layout/manifest survive. Used by `hunch private --migrate`
   *  to empty the PUBLIC store after its records have been moved into the private
   *  overlay. Returns the number of files removed. Invalidates the memoized load. */
  dropAll(kind: EntityKind): number {
    const directory = this.safeKindDirectory(kind, false);
    if (!directory) return 0;
    const names = this.jsonFileNames(kind);
    // Preflight first: never partially delete a kind because a later entry is a
    // symlink, device, oversized file, or hard link.
    for (const name of names) {
      this.validateExistingFile(directory, join(directory.lexical, name), this.maxBytes(kind));
    }
    for (const name of names) {
      this.removeContainedFile(directory, join(directory.lexical, name), this.maxBytes(kind));
    }
    this.invalidate(kind);
    return names.length;
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
      const directory = this.safeKindDirectory(kind, false);
      if (!directory) continue;
      const schema = SCHEMAS[kind];
      const single = SINGLE_FILE[kind];
      if (single) {
        const f = join(directory.lexical, single);
        let arr: unknown;
        try {
          const text = this.readContainedFile(directory, f, this.maxBytes(kind));
          if (text === null) continue;
          arr = JSON.parse(text);
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
        this.writeContainedFile(directory, f, encode(kept), this.maxBytes(kind));
      } else {
        for (const name of this.jsonFileNames(kind)) {
          const p = join(directory.lexical, name);
          let raw: unknown;
          try {
            const text = this.readContainedFile(directory, p, this.maxBytes(kind));
            if (text === null) continue;
            raw = JSON.parse(text);
          } catch {
            skipped++;
            continue;
          }
          const r = schema.safeParse(this.migrate(kind, raw, version));
          if (r.success) {
            this.writeContainedFile(directory, p, encode(r.data), this.maxBytes(kind));
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
