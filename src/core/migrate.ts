/**
 * Schema versioning + migration for the JSON source of truth.
 *
 * Records under `.hunch/` carry no per-record version; instead `.hunch/manifest.json`
 * records the schema generation the on-disk data was written at. On load we migrate
 * raw JSON UP to SCHEMA_VERSION *before* Zod validation — so a future schema change
 * never silently drops old records (Zod would reject an old shape and the loader
 * skips invalid records, which would be silent data loss).
 *
 * Adding a new schema version:
 *   1. bump SCHEMA_VERSION,
 *   2. append a Migration whose `version` equals the new number, transforming a raw
 *      record of the PREVIOUS shape into the new one (idempotent, defensive — the
 *      input is untrusted JSON, not a validated entity).
 * Migrations run in ascending `version` order for every version in (from, to].
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./io.js";
import type { EntityKind } from "./types.js";
import type { HunchPaths } from "./paths.js";

/** The schema generation this build writes and reads. Bump on any breaking change. */
export const SCHEMA_VERSION = 2;

/** A repo whose `.hunch/` predates manifests is treated as v1. Migrations are
 *  numbered from 2 (each `version` is the number it PRODUCES), so a baseline repo
 *  runs every migration with version >= 2 — never author a no-op version:1 one. */
export const BASELINE_VERSION = 1;

export interface Migration {
  /** The version this migration PRODUCES (i.e. it upgrades version-1 → `version`). */
  version: number;
  description: string;
  /** Transform one raw record (untrusted JSON) of `kind` to the next shape. */
  up(kind: EntityKind, raw: Record<string, unknown>): Record<string, unknown>;
}

/** Ordered, ascending by `version`. Empty at v1 (baseline); future versions append. */
export const MIGRATIONS: Migration[] = [
  {
    // v2: bi-temporal valid-time on decisions + constraints (Time-Travel Memory).
    // Backfill new fields from each record's existing date so a v1 graph migrates
    // losslessly — no record is dropped, and `valid_from` is populated BEFORE the
    // Zod pass. Defensive: input is untrusted JSON.
    version: 2,
    description: "Add valid_from/valid_to/superseded_by/retired (decisions) and status/valid_from/valid_to (constraints)",
    up(kind, raw) {
      if (kind === "decisions") {
        const date = typeof raw.date === "string" ? raw.date : "";
        if (raw.valid_from === undefined) raw.valid_from = date;
        // Legacy superseded decisions have no recorded successor instant. Leave
        // valid_to = null (historically in force) rather than = date: a zero-length
        // [date,date) window matches NO as-of query and would hide the record from
        // all time-travel. A later `supersede` sets a real valid_to when known.
        if (raw.valid_to === undefined) raw.valid_to = null;
        if (raw.superseded_by === undefined) raw.superseded_by = null;
        if (raw.retired === undefined) raw.retired = { symbols: [], deps: [] };
      } else if (kind === "constraints") {
        if (raw.status === undefined) raw.status = "active";
        if (raw.valid_to === undefined) raw.valid_to = null;
        // valid_from is optional on constraints; leave unset for legacy records.
      }
      return raw;
    },
  },
];

export interface Manifest {
  schema_version: number;
}

/** Read `.hunch/manifest.json`. A missing/corrupt manifest is treated as the
 *  BASELINE version (a pre-manifest `.hunch/`), so future builds still migrate it. */
export function readManifest(paths: HunchPaths): Manifest {
  if (!existsSync(paths.manifest)) return { schema_version: BASELINE_VERSION };
  try {
    const m = JSON.parse(readFileSync(paths.manifest, "utf8")) as Partial<Manifest>;
    const v = typeof m.schema_version === "number" && Number.isInteger(m.schema_version) ? m.schema_version : BASELINE_VERSION;
    return { schema_version: v };
  } catch {
    return { schema_version: BASELINE_VERSION };
  }
}

/** Write `.hunch/manifest.json` at `version` (default: the current SCHEMA_VERSION). */
export function writeManifest(paths: HunchPaths, version: number = SCHEMA_VERSION): void {
  mkdirSync(dirname(paths.manifest), { recursive: true });
  writeFileAtomic(paths.manifest, JSON.stringify({ schema_version: version }, null, 2) + "\n");
}

/** Apply every migration in (fromVersion, toVersion] to a single raw record. Skips
 *  non-object input untouched (the loader's Zod pass will reject it). */
export function migrateRaw(
  kind: EntityKind,
  raw: unknown,
  fromVersion: number,
  migrations: Migration[] = MIGRATIONS,
  toVersion: number = SCHEMA_VERSION,
): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  let rec = raw as Record<string, unknown>;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version > fromVersion && m.version <= toVersion) rec = m.up(kind, rec);
  }
  return rec;
}
