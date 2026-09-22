import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { emptyLedger, ledgerFile, readLedger, writeLedger } from "../src/store/changeLedger.js";
import { appendEvent, readEvents } from "../src/core/events.js";
import { hunchPaths } from "../src/core/paths.js";
import { SYMLINK_SKIP } from "./helpers.js";

const scope = { kind: "user" as const, id: "audit" };

test("change ledger refuses a linked changes directory for reads and writes", { skip: SYMLINK_SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-ledger-containment-"));
  try {
    const home = join(root, ".hunch"), outside = join(root, "outside");
    mkdirSync(home); mkdirSync(outside);
    const target = join(outside, basename(ledgerFile(home, scope)));
    const original = JSON.stringify(emptyLedger(scope));
    writeFileSync(target, original);
    symlinkSync(outside, join(home, "changes"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => readLedger(home, scope), /unsafe|symlink/i);
    assert.throws(() => writeLedger(home, emptyLedger(scope)), /unsafe|symlink/i);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally { cleanupDir(root); }
});

for (const kind of ["symlink", "hardlink"] as const) {
  test(`change ledger refuses a ${kind} record`, { skip: kind === "symlink" ? SYMLINK_SKIP : false }, () => {
    const root = mkdtempSync(join(tmpdir(), "hunch-ledger-record-link-"));
    try {
      const home = join(root, ".hunch");
      mkdirSync(join(home, "changes"), { recursive: true });
      const outside = join(root, "private.json"), original = JSON.stringify(emptyLedger(scope));
      writeFileSync(outside, original);
      if (kind === "symlink") symlinkSync(outside, ledgerFile(home, scope), "file");
      else linkSync(outside, ledgerFile(home, scope));
      assert.throws(() => readLedger(home, scope), /unsafe|link/i);
      assert.throws(() => writeLedger(home, emptyLedger(scope)), /unsafe|link/i);
      assert.equal(readFileSync(outside, "utf8"), original);
    } finally { cleanupDir(root); }
  });

  test(`catch log skips a ${kind} without reading or appending outside the store`, { skip: kind === "symlink" ? SYMLINK_SKIP : false }, () => {
    const root = mkdtempSync(join(tmpdir(), "hunch-events-containment-"));
    try {
      const paths = hunchPaths(root);
      mkdirSync(paths.hunch);
      const outside = join(root, "private.log");
      const event = { at: "2026-09-13T00:00:00Z", kind: "constraint" as const, file: "private.ts" };
      const original = JSON.stringify(event) + "\n";
      writeFileSync(outside, original);
      if (kind === "symlink") symlinkSync(outside, join(paths.hunch, "events.log"), "file");
      else linkSync(outside, join(paths.hunch, "events.log"));
      assert.deepEqual(readEvents(paths), []);
      assert.doesNotThrow(() => appendEvent(paths, event));
      assert.equal(readFileSync(outside, "utf8"), original);
    } finally { cleanupDir(root); }
  });
}
