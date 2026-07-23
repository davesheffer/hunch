import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
  }
});
