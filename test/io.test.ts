import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYMLINK_SKIP } from "./helpers.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
let importSequence = 0;

type RenameSync = typeof fs.renameSync;
type WriteFileSync = typeof fs.writeFileSync;

async function withFsOverrides(
  renameSync: RenameSync,
  writeFileSyncOverride: WriteFileSync,
  run: (writeFileAtomic: (file: string, data: string) => void) => void,
): Promise<void> {
  const originalRenameSync = fs.renameSync;
  const originalWriteFileSync = fs.writeFileSync;
  fs.renameSync = renameSync;
  fs.writeFileSync = writeFileSyncOverride;
  syncBuiltinESMExports();
  try {
    const { writeFileAtomic } = await import(`../src/core/io.js?atomic-io-test=${importSequence++}`);
    run(writeFileAtomic);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
  }
}

test("writeFileAtomic retries transient rename contention without writing the target in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-atomic-"));
  const target = join(root, "index.json");
  writeFileSync(target, "old\n");
  const originalRenameSync = fs.renameSync;
  const originalWriteFileSync = fs.writeFileSync;
  let renameAttempts = 0;
  let directTargetWrites = 0;

  try {
    await withFsOverrides(
      ((from, to) => {
        if (to === target && renameAttempts++ < 2) {
          const error = new Error("simulated Windows reader contention") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        return originalRenameSync(from, to);
      }) as RenameSync,
      ((file, data, options) => {
        if (file === target) directTargetWrites++;
        return originalWriteFileSync(file, data, options as never);
      }) as WriteFileSync,
      (writeFileAtomic) => writeFileAtomic(target, "new\n"),
    );

    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(renameAttempts, 3, "two transient failures are retried before atomic replacement");
    assert.equal(directTargetWrites, 0, "the destination is published only by rename");
    assert.deepEqual(readdirSync(root), ["index.json"], "the temporary file is removed");
  } finally {
    cleanupDir(root);
  }
});

test("writeFileAtomic preserves the old target when rename contention persists", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-atomic-"));
  const target = join(root, "index.json");
  writeFileSync(target, "old-complete-json\n");
  const originalRenameSync = fs.renameSync;
  const originalWriteFileSync = fs.writeFileSync;
  let directTargetWrites = 0;

  try {
    await withFsOverrides(
      ((from, to) => {
        if (to === target) {
          const error = new Error("simulated persistent Windows reader contention") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalRenameSync(from, to);
      }) as RenameSync,
      ((file, data, options) => {
        if (file === target) {
          directTargetWrites++;
          originalWriteFileSync(file, String(data).slice(0, 1));
          throw new Error("simulated interruption during an in-place fallback");
        }
        return originalWriteFileSync(file, data, options as never);
      }) as WriteFileSync,
      (writeFileAtomic) => {
        assert.throws(
          () => writeFileAtomic(target, "new-complete-json\n"),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
        );
      },
    );

    assert.equal(directTargetWrites, 0, "persistent contention never falls back to an in-place write");
    assert.equal(readFileSync(target, "utf8"), "old-complete-json\n", "the previous complete file survives");
    assert.deepEqual(readdirSync(root), ["index.json"], "the temporary file is removed");
  } finally {
    cleanupDir(root);
  }
});

for (const writer of ["writeFileAtomic", "writeFileAtomicIfAbsent"] as const) {
  for (const collision of ["file", "symlink", "hardlink"] as const) {
    test(`${writer} refuses an occupied temporary path without changing or removing someone else's file (${collision})`, {
      skip: collision === "symlink" ? SYMLINK_SKIP : false,
    }, async () => {
      const root = mkdtempSync(join(tmpdir(), "hunch-atomic-collision-"));
      const target = join(root, "index.json");
      const outside = join(root, "keep.json");
      writeFileSync(outside, "unrelated bytes\n");
      if (writer === "writeFileAtomic") writeFileSync(target, "old complete bytes\n");
      const originalOpen = fs.openSync;
      let occupied: string | undefined;
      // Put a competing file at the actual publication temp path, immediately
      // before open. This exercises the filesystem race without guessing a PID
      // or relying on the implementation's temporary naming scheme.
      fs.openSync = ((file, flags, mode) => {
        if (!occupied && String(file).startsWith(`${target}.tmp`)) {
          occupied = String(file);
          if (collision === "symlink") symlinkSync(outside, occupied, "file");
          else if (collision === "hardlink") linkSync(outside, occupied);
          else writeFileSync(occupied, "another writer's bytes\n");
        }
        return originalOpen(file, flags, mode);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      try {
        const io = await import(`../src/core/io.js?atomic-io-test=${importSequence++}`);
        assert.throws(() => io[writer](target, "replacement bytes\n"), { code: "EEXIST" });
        assert.ok(occupied);
        assert.equal(readFileSync(outside, "utf8"), "unrelated bytes\n");
        assert.equal(readFileSync(occupied, "utf8"), collision === "file" ? "another writer's bytes\n" : "unrelated bytes\n");
        assert.equal(lstatSync(occupied).isSymbolicLink(), collision === "symlink");
        if (writer === "writeFileAtomic") assert.equal(readFileSync(target, "utf8"), "old complete bytes\n");
        else assert.ok(!fs.existsSync(target), "a refused create must not publish a target");
      } finally {
        fs.openSync = originalOpen;
        syncBuiltinESMExports();
        cleanupDir(root);
      }
    });
  }
}

test("atomic replacement preserves a private config's access permissions", { skip: process.platform === "win32" ? "POSIX permission bits" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-atomic-mode-"));
  const target = join(root, "config.json");
  try {
    const { writeFileAtomic } = await import("../src/core/io.js");
    writeFileSync(target, '{"token":"private"}\n');
    chmodSync(target, 0o600);
    writeFileAtomic(target, '{"token":"private","enabled":true}\n');
    assert.equal(lstatSync(target).mode & 0o777, 0o600, "rewriting a user config must not make its credentials readable to other users");
    assert.equal(readFileSync(target, "utf8"), '{"token":"private","enabled":true}\n');
  } finally { cleanupDir(root); }
});

for (const writer of ["writeFileAtomic", "writeFileAtomicIfAbsent"] as const) {
  test(`${writer} publishes the complete UTF-8 payload after short filesystem writes`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hunch-atomic-short-write-"));
    const target = join(root, "index.json");
    const data = JSON.stringify({ text: "שלום 🌍".repeat(20) });
    const originalWrite = fs.writeSync;
    fs.writeSync = ((fd: number, value: string | Buffer, ...args: unknown[]) => {
      if (typeof value === "string") {
        const bytes = Buffer.from(value);
        return originalWrite(fd, bytes, 0, Math.min(7, bytes.length), typeof args[0] === "number" ? args[0] : null);
      }
      const offset = typeof args[0] === "number" ? args[0] : 0;
      const length = typeof args[1] === "number" ? args[1] : value.length - offset;
      return originalWrite(fd, value, offset, Math.min(7, length), typeof args[2] === "number" ? args[2] : null);
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    try {
      const io = await import(`../src/core/io.js?atomic-io-test=${importSequence++}`);
      io[writer](target, data);
      assert.equal(readFileSync(target, "utf8"), data);
      assert.deepEqual(readdirSync(root), ["index.json"]);
    } finally {
      fs.writeSync = originalWrite;
      syncBuiltinESMExports();
      cleanupDir(root);
    }
  });
}
