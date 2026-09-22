import { cleanupDir } from "./fixtures.js";
/**
 * A corrupt DERIVED index must be rebuilt, not fatal (round-3 audit #10).
 *
 * The SQLite file is 100% derived from the git-native JSON in .hunch/ — openDb's own
 * comment says so: "The entire database is derived from Git-native JSON, so openDb()
 * safely rebuilds that cache instead of leaving Hunch unusable." But that rebuild was
 * wired to exactly ONE trigger — RebuildDerivedIndex, thrown only when an fts5 index
 * meets a runtime without the FTS5 module. Anything else propagated as a raw SQLite
 * string out of `hunch index`, `query`, `check` and `doctor` at once.
 *
 * Worse for the hook: con_03a0b94b2e requires the pre-edit hook to emit nothing and exit
 * 0 on any failure, so a corrupt file made it go SILENTLY blind — permanently, with no
 * command left that could repair it, because every repair command opened the same file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.js";

function tmp(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hunch-corrupt-"));
  return { dir, path: join(dir, "hunch.sqlite"), cleanup: () => cleanupDir(dir) };
}

/** Bytes that are definitively not a SQLite database. */
const GARBAGE = "this is not a database, it is a text file that got written here\n".repeat(40);

test("a corrupt index file is rebuilt instead of taking down every command (#10)", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, GARBAGE);
    const db = openDb(path); // must not throw
    // The rebuilt cache is a real, usable database with the expected schema.
    const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number };
    assert.ok(row.n > 0, "rebuilt index has tables");
    db.prepare("SELECT count(*) AS n FROM search").get(); // the search table exists and is queryable
    db.close();
    assert.ok(statSync(path).size > 0, "a real database file replaced the garbage");
    assert.notEqual(readFileSync(path, "utf8").slice(0, 20), GARBAGE.slice(0, 20), "the garbage is gone");
  } finally { cleanup(); }
});

test("the sidecar -wal/-shm files are discarded with the corrupt database (#10)", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, GARBAGE);
    writeFileSync(`${path}-wal`, "stale wal");
    writeFileSync(`${path}-shm`, "stale shm");
    const db = openDb(path);
    db.close();
    // Leaving a stale -wal beside a fresh database is its own corruption source.
    const wal = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`, "utf8") : "";
    assert.notEqual(wal, "stale wal", "the stale wal was not carried over");
  } finally { cleanup(); }
});

test("a healthy index is untouched — no gratuitous rebuild (#10)", () => {
  const { path, cleanup } = tmp();
  try {
    const first = openDb(path);
    first.prepare("CREATE TABLE IF NOT EXISTS canary (v TEXT)").run();
    first.prepare("INSERT INTO canary (v) VALUES ('keep me')").run();
    first.close();

    const second = openDb(path);
    const row = second.prepare("SELECT v FROM canary").get() as { v?: string } | undefined;
    second.close();
    assert.equal(row?.v, "keep me", "reopening a healthy index must NOT wipe it");
  } finally { cleanup(); }
});

test("a genuine environment error still propagates — corruption is matched narrowly (#10)", () => {
  // Deleting the file cannot fix a bad PATH, so that must not be swallowed. Pointing at
  // a path whose parent is a FILE gives a non-corruption failure from SQLite/fs.
  const { dir, cleanup } = tmp();
  try {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file, not a directory\n");
    assert.throws(
      () => openDb(join(blocker, "nested", "hunch.sqlite")),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(!/rebuild/i.test(message), "not reported as a rebuild");
        return true;
      },
      "an environment failure must surface, not be silently treated as corruption",
    );
  } finally { cleanup(); }
});
