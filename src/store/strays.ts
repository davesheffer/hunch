/**
 * Strays: records of overlay-homed kinds stranded in a checkout's local `.hunch/`.
 * A memory policy can home a kind in the private overlay, yet a worktree (or an
 * older Hunch) may still have written records of that kind into its own `.hunch/`;
 * removing the worktree then destroys them. `findStrays` lists every such record
 * (and every file of such a kind the validating loader could not read), and
 * `importStrays` rescues them into the overlay without ever overwriting an overlay
 * record or touching the source (never silently drop, con_947c578b2c).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compareCodeUnits } from "../core/canonicalOrder.js";
import { writeFileAtomic } from "../core/io.js";
import { migrateRaw } from "../core/migrate.js";
import { hunchPaths } from "../core/paths.js";
import { sameCanonical } from "../core/stateCanonical.js";
import { captureConflicts, isLive } from "../core/topics.js";
import { ENTITY_KINDS, SCHEMAS, type Decision, type EntityKind } from "../core/types.js";
import { gitTrackedPaths, worktreePaths } from "../extractors/git.js";
import type { HunchStore } from "./hunchStore.js";
import { JsonStore, MAX_JSON_INDEX_BYTES, MAX_JSON_RECORD_BYTES } from "./jsonStore.js";

export type StrayStatus = "missing" | "differs" | "invalid";
export interface Stray {
  checkout: string;
  kind: EntityKind;
  id: string | null;
  status: StrayStatus;
  /** Absolute path of the file holding the stray. */
  source: string;
  /** The loaded record ("missing" only): what import writes to the overlay. */
  record?: unknown;
  note?: string;
}
export interface StrayScan {
  home: string | null;
  refused?: string;
  strays: Stray[];
  /** Files of overlay-homed kinds git tracks in the root checkout. Not strays: git keeps
   *  them (and refuses to remove a worktree that edited one, short of --force); `hunch
   *  memory-policy migrate` moves them into the overlay. */
  tracked?: number;
}
export interface StrayImport {
  imported: Stray[];
  quarantined: Array<{ stray: Stray; file: string }>;
  failed: Array<{ stray: Stray; error: string }>;
}

/** A path's physical identity: symlinks resolved, case folded on Windows. Null when absent. */
function physical(path: string): string | null {
  try {
    const real = realpathSync.native(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

function idOf(value: unknown): string | null {
  const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
  return typeof id === "string" ? id : null;
}

/** List the records of overlay-homed kinds held in `root` or any of its worktrees
 *  that the overlay lacks ("missing") or holds differently ("differs"), and the files
 *  of those kinds the checkout's loader could not read ("invalid"). Read-only: never
 *  creates a directory. */
export function findStrays(store: HunchStore, root: string): StrayScan {
  if (store.memoryPolicyProblem) return { home: null, refused: store.memoryPolicyProblem, strays: [] };
  if (!store.privateDir) return { home: null, strays: [] };
  const home = store.privateDir;
  const overlay = physical(home);

  const kinds = ENTITY_KINDS.filter((kind) => {
    try {
      return store.captureHome(false, kind) === "private";
    } catch {
      return false;
    }
  });
  if (!kinds.length) return { home, strays: [] };

  const checkouts: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [root, ...worktreePaths(root)]) {
    const checkout = resolve(candidate);
    // A worktree git still lists but whose directory is gone holds nothing to rescue.
    const key = physical(checkout);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // The overlay itself is the home, not a stray.
    if (overlay && physical(join(checkout, ".hunch")) === overlay) continue;
    checkouts.push(checkout);
  }

  const strays: Stray[] = [];
  let tracked = 0;
  for (const checkout of checkouts) {
    if (!existsSync(join(checkout, ".hunch"))) continue;
    // Best-effort: when git cannot answer, every file is scanned (fail toward reporting).
    const trackedFiles = new Set(gitTrackedPaths(checkout, [".hunch"]).map((rel) => pathKey(join(checkout, rel))));
    let json: JsonStore;
    try {
      json = new JsonStore(hunchPaths(checkout));
    } catch (error) {
      strays.push({ checkout, kind: kinds[0]!, id: null, status: "invalid", source: join(checkout, ".hunch"), note: `could not open: ${(error as Error).message}` });
      continue;
    }
    for (const kind of kinds) {
      try {
        const isRoot = checkout === resolve(root);
        const count = scanKind(store, json, checkout, kind, strays, trackedFiles, isRoot);
        // Every worktree checks out the same committed records; count the root's once.
        if (isRoot) tracked += count;
      } catch (error) {
        // An unreadable kind is reported, never skipped silently; import cannot copy a
        // directory, so it lands in `failed` for a human.
        strays.push({ checkout, kind, id: null, status: "invalid", source: join(checkout, ".hunch", kind), note: `could not read: ${(error as Error).message}` });
      }
    }
  }

  const kindOrder = (kind: EntityKind) => ENTITY_KINDS.indexOf(kind);
  strays.sort((a, b) =>
    compareCodeUnits(a.checkout, b.checkout)
    || kindOrder(a.kind) - kindOrder(b.kind)
    || compareCodeUnits(a.id ?? "", b.id ?? "")
    || compareCodeUnits(a.source, b.source));
  return { home, strays, tracked };
}

const pathKey = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Scan one kind of one checkout into `strays`; returns how many of its files git tracks. */
function scanKind(store: HunchStore, json: JsonStore, checkout: string, kind: EntityKind, strays: Stray[], trackedFiles: Set<string>, isRoot: boolean): number {
  const isTracked = (file: string): boolean => trackedFiles.has(pathKey(file));
  const loaded = json.loadAll(kind);
  const firstById = new Map<string, unknown>();
  for (const record of loaded) {
    const id = (record as { id: string }).id;
    if (!firstById.has(id)) firstById.set(id, record);
  }

  const single = json.isSingleFileKind(kind);
  const all = json.rawRecordFiles(kind);
  // A file the containment check refused is reported on its own; its siblings still scan.
  for (const { file, error } of all) {
    if (error !== undefined && !isTracked(file)) strays.push({ checkout, kind, id: null, status: "invalid", source: file, note: `could not read: ${error}` });
  }
  const files = all.filter((f) => f.error === undefined);
  const indexFile = files[0]?.file ?? join(checkout, ".hunch", kind, "index.json");
  // The file that holds each id: the canonical name when present, else the misnamed
  // copy the loader kept, so a stray always names a file that exists.
  const fileById = new Map<string, string>();
  if (!single) {
    for (const { file, text } of files) {
      let id: string | null;
      try {
        id = idOf(JSON.parse(text));
      } catch {
        id = null;
      }
      if (id === null) continue;
      if (basename(file) === `${id}.json` || !fileById.has(id)) fileById.set(id, file);
    }
  }
  const sourceOf = (id: string): string => single ? indexFile : fileById.get(id) ?? join(checkout, ".hunch", kind, `${id}.json`);
  // A committed file the containment check refused still counts: git holds its bytes.
  const trackedCount = all.filter((f) => isTracked(f.file)).length;
  // A committed index holds the kind for git; entries added to it since make the
  // worktree dirty, and git refuses to remove a dirty worktree.
  if (single && isTracked(indexFile)) return trackedCount;

  for (const [id, record] of firstById) {
    if (isTracked(sourceOf(id))) continue;
    // The repo's public copy of the id: an identical one is safe in git; a different one
    // must not be shadowed by an overlay copy written over it.
    const publicCopy = store.json.get(kind, id);
    if (publicCopy && !isRoot) {
      if (!sameCanonical(publicCopy, record)) strays.push({ checkout, kind, id, status: "differs", source: sourceOf(id), note: "differs from the repo's public copy" });
      continue;
    }
    const existing = store.getPrivateRec(kind, id);
    if (existing) {
      if (!sameCanonical(existing, record)) strays.push({ checkout, kind, id, status: "differs", source: sourceOf(id) });
      continue;
    }
    // A file the overlay loader skipped (invalid, corrupt, 0-byte tombstone) is not an
    // absence: importing over it would destroy it.
    let unreadable: boolean;
    try {
      unreadable = store.hasPrivateRecordFile(kind, id);
    } catch {
      unreadable = true;
    }
    strays.push(unreadable
      ? { checkout, kind, id, status: "differs", source: sourceOf(id), note: "overlay file unreadable" }
      : { checkout, kind, id, status: "missing", source: sourceOf(id), record });
  }

  if (single) {
    // An index the containment check refused is already reported above.
    if (all.some((f) => f.error !== undefined)) return trackedCount;
    let skipped: boolean;
    try {
      skipped = json.rawRecordCount(kind) > loaded.length;
    } catch {
      skipped = true;
    }
    if (skipped) strays.push({ checkout, kind, id: null, status: "invalid", source: indexFile, note: "the index holds entries the loader skipped" });
    return trackedCount;
  }

  // Per-record kinds: a non-empty file whose stem is no loaded id was not loaded,
  // unless it is a misnamed copy identical to the record that was.
  const version = json.schemaVersion();
  for (const { file, text } of files) {
    if (isTracked(file)) continue;
    if (firstById.has(basename(file).slice(0, -".json".length))) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const id = idOf(raw);
    if (id !== null && firstById.has(id)) {
      const parsed = SCHEMAS[kind].safeParse(migrateRaw(kind, raw, version));
      if (parsed.success && sameCanonical(parsed.data, firstById.get(id))) continue;
    }
    strays.push({ checkout, kind, id, status: "invalid", source: file, note: "the loader could not read this file" });
  }
  return trackedCount;
}

/** Rescue a scan's strays into the overlay. A "missing" record is written with
 *  putPrivate; any other stray is copied byte-for-byte into
 *  `<overlay>/strays/<status>/<kind>/` for a human to reconcile, as is a missing
 *  decision whose topic already has another live decision (`strays/collision/`). Never overwrites an
 *  overlay record, never modifies or deletes a source file; a per-stray failure is
 *  reported in `failed` and the run continues. Idempotent. */
export function importStrays(store: HunchStore, scan: StrayScan): StrayImport {
  const result: StrayImport = { imported: [], quarantined: [], failed: [] };
  for (const stray of scan.strays) {
    try {
      if (stray.status === "missing" && stray.id !== null) {
        // Re-check absence: the overlay may have changed since the scan.
        const existing = store.getPrivateRec(stray.kind, stray.id);
        let present = !!existing;
        if (!present) {
          try {
            present = store.hasPrivateRecordFile(stray.kind, stray.id);
          } catch {
            present = true;
          }
        }
        if (!present && liveTopicConflict(store, stray)) {
          result.quarantined.push({ stray, file: quarantine(store, stray, "collision") });
          continue;
        }
        if (!present) {
          store.putPrivate(stray.kind, stray.record as never);
          result.imported.push(stray);
          continue;
        }
        // An identical copy already landed (another checkout's): the record is safe.
        if (existing && sameCanonical(existing, stray.record)) {
          result.imported.push(stray);
          continue;
        }
      }
      result.quarantined.push({ stray, file: quarantine(store, stray) });
    } catch (error) {
      result.failed.push({ stray, error: (error as Error).message });
    }
  }
  return result;
}

/** Whether writing a missing decision would make a SECOND live decision on its topic:
 *  import is a raw write, so it applies the same guard a capture does, never silently two. */
function liveTopicConflict(store: HunchStore, stray: Stray): boolean {
  if (stray.kind !== "decisions") return false;
  const d = stray.record as Decision;
  if (!d.topic || !isLive(d)) return false;
  return captureConflicts(store.recs("decisions"), d.topic, d.id, null).length > 0;
}

/** Copy a stray's source bytes into the overlay's `strays/` area; the destination
 *  name carries the content hash, so a second import finds the same file. */
function quarantine(store: HunchStore, stray: Stray, as?: "collision"): string {
  if (!store.privateDir) throw new Error("no overlay is configured to quarantine into");
  // Copy only what the store itself would read: a plain, singly linked file within the
  // size cap. A link's or device's bytes are not the checkout's to move.
  const stat = lstatSync(stray.source);
  const maxBytes = store.json.isSingleFileKind(stray.kind) ? MAX_JSON_INDEX_BYTES : MAX_JSON_RECORD_BYTES;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    throw new Error(`${stray.source} is not a plain file the store would read; inspect it by hand`);
  }
  const bytes = readFileSync(stray.source);
  const slug = basename(stray.checkout).replace(/[^A-Za-z0-9._-]/g, "_") || "checkout";
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  // A "missing" whose overlay copy appeared (and differs) since the scan is a differing copy.
  const status = as ?? (stray.status === "missing" ? "differs" : stray.status);
  const dir = join(store.privateDir, "strays", status, stray.kind);
  const file = join(dir, `${slug}-${hash}-${basename(stray.source)}`);
  if (existsSync(file)) {
    if (readFileSync(file).equals(bytes)) return file;
    throw new Error(`refusing to overwrite ${file}: it holds different bytes`);
  }
  mkdirSync(dir, { recursive: true });
  // The source bytes verbatim: never re-encode them (they may not be valid UTF-8).
  writeFileAtomic(file, bytes);
  return file;
}
