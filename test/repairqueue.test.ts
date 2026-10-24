import { cleanupDir } from "./fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPendingRepairs, writePendingRepairs, readDroppedRepairs, writeDroppedRepairs,
  readActivePendingRepairs, withheldRewrites,
} from "../src/core/repairqueue.js";

function tmpRoot(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repairqueue-"));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  return { root, cleanup: () => cleanupDir(root) };
}

function gitRepo(): { root: string; headSha: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repairqueue-git-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test Human");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  return { root, headSha: git("rev-parse", "HEAD"), cleanup: () => cleanupDir(root) };
}

const FAKE = "0123456789abcdef0123456789abcdef01234567";
const e = (id: string, from = "sha_old", to = "sha_new") => ({ id, from, to });

test("pending: a missing file reads as []", () => {
  const t = tmpRoot();
  try { assert.deepEqual(readPendingRepairs(t.root), []); } finally { t.cleanup(); }
});

test("pending: write then read round-trips", () => {
  const t = tmpRoot();
  try {
    const q = [e("a"), e("b", "x", "y")];
    writePendingRepairs(t.root, q);
    assert.deepEqual(readPendingRepairs(t.root), q);
  } finally { t.cleanup(); }
});

test("pending: corrupt JSON and non-arrays read as []", () => {
  const t = tmpRoot();
  try {
    const file = join(t.root, ".hunch", "pending-commit-repairs.json");
    writeFileSync(file, "{not json");
    assert.deepEqual(readPendingRepairs(t.root), []);
    writeFileSync(file, JSON.stringify({ id: "a", from: "x", to: "y" }));
    assert.deepEqual(readPendingRepairs(t.root), []);
  } finally { t.cleanup(); }
});

test("pending: malformed elements are filtered, valid ones kept", () => {
  const t = tmpRoot();
  try {
    writeFileSync(join(t.root, ".hunch", "pending-commit-repairs.json"), JSON.stringify([e("ok"), { id: "only" }, "str", null]));
    assert.deepEqual(readPendingRepairs(t.root), [e("ok")]);
  } finally { t.cleanup(); }
});

test("pending: empty id/from/to and no-op entries are filtered", () => {
  const t = tmpRoot();
  try {
    writeFileSync(join(t.root, ".hunch", "pending-commit-repairs.json"), JSON.stringify([
      e("a", "x", ""), e("a", "", "y"), e("", "x", "y"), e("a", "same", "same"), e("keep"),
    ]));
    assert.deepEqual(readPendingRepairs(t.root), [e("keep")]);
  } finally { t.cleanup(); }
});

test("pending: writing [] clears the queue; the raw file parses back", () => {
  const t = tmpRoot();
  try {
    const q = [e("a")];
    writePendingRepairs(t.root, q);
    assert.deepEqual(JSON.parse(readFileSync(join(t.root, ".hunch", "pending-commit-repairs.json"), "utf8")), q);
    writePendingRepairs(t.root, []);
    assert.deepEqual(readPendingRepairs(t.root), []);
  } finally { t.cleanup(); }
});

test("dropped: a missing file reads as []", () => {
  const t = tmpRoot();
  try { assert.deepEqual(readDroppedRepairs(t.root), []); } finally { t.cleanup(); }
});

test("dropped: round-trips and is independent of the pending queue", () => {
  const t = tmpRoot();
  try {
    writeDroppedRepairs(t.root, [e("a")]);
    assert.deepEqual(readDroppedRepairs(t.root), [e("a")]);
    assert.deepEqual(readPendingRepairs(t.root), []);
  } finally { t.cleanup(); }
});

test("dropped: corrupt JSON and non-arrays read as []", () => {
  const t = tmpRoot();
  try {
    const file = join(t.root, ".hunch", "dropped-commit-repairs.json");
    writeFileSync(file, "garbage");
    assert.deepEqual(readDroppedRepairs(t.root), []);
    writeFileSync(file, "{}");
    assert.deepEqual(readDroppedRepairs(t.root), []);
  } finally { t.cleanup(); }
});

test("dropped: malformed elements are filtered", () => {
  const t = tmpRoot();
  try {
    writeFileSync(join(t.root, ".hunch", "dropped-commit-repairs.json"), JSON.stringify([
      { id: "a", to: "y" }, { from: "x", to: "y" }, { id: "a", from: "x" },
      e("", "x", "y"), e("a", "", "y"), e("a", "x", ""), "str", null, e("good"),
    ]));
    assert.deepEqual(readDroppedRepairs(t.root), [e("good")]);
  } finally { t.cleanup(); }
});

test("dropped: writing [] clears the file", () => {
  const t = tmpRoot();
  try {
    writeDroppedRepairs(t.root, [e("a")]);
    writeDroppedRepairs(t.root, []);
    assert.deepEqual(readDroppedRepairs(t.root), []);
  } finally { t.cleanup(); }
});

test("active: an entry with no tombstone passes through", () => {
  const t = tmpRoot();
  try {
    writePendingRepairs(t.root, [e("a")]);
    assert.deepEqual(readActivePendingRepairs(t.root), [e("a")]);
  } finally { t.cleanup(); }
});

test("active: an exact tombstoned triple is hidden without touching the raw queue", () => {
  const t = tmpRoot();
  try {
    writePendingRepairs(t.root, [e("a"), e("b")]);
    writeDroppedRepairs(t.root, [e("a")]);
    assert.deepEqual(readActivePendingRepairs(t.root), [e("b")]);
    assert.deepEqual(readPendingRepairs(t.root), [e("a"), e("b")]);
  } finally { t.cleanup(); }
});

test("active: a different `to` for a tombstoned {id, from} still passes", () => {
  const t = tmpRoot();
  try {
    writePendingRepairs(t.root, [e("a", "sha_old", "other")]);
    writeDroppedRepairs(t.root, [e("a")]);
    assert.deepEqual(readActivePendingRepairs(t.root), [e("a", "sha_old", "other")]);
  } finally { t.cleanup(); }
});

test("withheldRewrites: an empty queue gives an empty set", () => {
  const r = gitRepo();
  try { assert.deepEqual(withheldRewrites(r.root, []), new Set()); } finally { r.cleanup(); }
});

test("withheldRewrites: a real `to` is not withheld", () => {
  const r = gitRepo();
  try { assert.deepEqual(withheldRewrites(r.root, [e("a", "old", r.headSha)]), new Set()); } finally { r.cleanup(); }
});

test("withheldRewrites: a never-real 40-hex `to` is withheld", () => {
  const r = gitRepo();
  try {
    const entry = e("a", "old", FAKE);
    assert.deepEqual(withheldRewrites(r.root, [entry]), new Set([entry]));
  } finally { r.cleanup(); }
});

test("withheldRewrites: a mix holds only the fake entry, by identity", () => {
  const r = gitRepo();
  try {
    const real = e("a", "old", r.headSha);
    const fake = e("b", "old", FAKE);
    const out = withheldRewrites(r.root, [real, fake]);
    assert.equal(out.size, 1);
    assert.equal([...out][0], fake);
  } finally { r.cleanup(); }
});

test("withheldRewrites: same-id entries are judged individually", () => {
  const r = gitRepo();
  try {
    const real = e("a", "old", r.headSha);
    const fake = e("a", "old", FAKE);
    const out = withheldRewrites(r.root, [real, fake]);
    assert.equal(out.size, 1);
    assert.ok(out.has(fake));
    assert.ok(!out.has(real));
  } finally { r.cleanup(); }
});
