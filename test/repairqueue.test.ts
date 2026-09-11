import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingRepairs, writePendingRepairs, readDroppedRepairs, writeDroppedRepairs, readActivePendingRepairs, withheldRewrites } from "../src/core/repairqueue.js";

function tmpRoot(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repairqueue-"));
  mkdirSync(join(root, ".hunch"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** withheldRewriteIds needs a real git repository — commitsExist shells out. */
function gitRoot(): { root: string; headSha: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repairqueue-git-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test Human");
  writeFileSync(join(root, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  return { root, headSha: git("rev-parse", "HEAD"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("readPendingRepairs: returns an empty array when the queue file doesn't exist", () => {
  const { root, cleanup } = tmpRoot();
  try {
    assert.deepEqual(readPendingRepairs(root), []);
  } finally { cleanup(); }
});

test("writePendingRepairs then readPendingRepairs round-trips exactly", () => {
  const { root, cleanup } = tmpRoot();
  try {
    const rewrites = [{ id: "dec_1", from: "sha_old", to: "sha_new" }];
    writePendingRepairs(root, rewrites);
    assert.deepEqual(readPendingRepairs(root), rewrites);
  } finally { cleanup(); }
});

test("readPendingRepairs: tolerant of corrupt JSON — returns an empty array, never throws", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(join(root, ".hunch", "pending-commit-repairs.json"), "{not valid json");
    assert.deepEqual(readPendingRepairs(root), []);
  } finally { cleanup(); }
});

test("readPendingRepairs: tolerant of a non-array JSON value — returns an empty array", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(join(root, ".hunch", "pending-commit-repairs.json"), JSON.stringify({ not: "an array" }));
    assert.deepEqual(readPendingRepairs(root), []);
  } finally { cleanup(); }
});

test("readPendingRepairs: filters out malformed entries but keeps valid ones", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(
      join(root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_1", from: "a", to: "b" }, { id: "dec_2" }, "garbage", null]),
    );
    assert.deepEqual(readPendingRepairs(root), [{ id: "dec_1", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("readPendingRepairs: filters out an entry with an empty to/from — never a useful rewrite target", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(
      join(root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_1", from: "a", to: "b" }, { id: "dec_empty_to", from: "a", to: "" }, { id: "dec_empty_from", from: "", to: "b" }]),
    );
    assert.deepEqual(readPendingRepairs(root), [{ id: "dec_1", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("readPendingRepairs: filters out an entry with an empty id", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(
      join(root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "", from: "a", to: "b" }, { id: "dec_ok", from: "a", to: "b" }]),
    );
    assert.deepEqual(readPendingRepairs(root), [{ id: "dec_ok", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("readPendingRepairs: filters out a no-op entry (to === from) — applying it would accomplish nothing", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(
      join(root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_1", from: "a", to: "b" }, { id: "dec_noop", from: "a", to: "a" }]),
    );
    assert.deepEqual(readPendingRepairs(root), [{ id: "dec_1", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("writePendingRepairs([]) clears the queue", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writePendingRepairs(root, [{ id: "dec_1", from: "a", to: "b" }]);
    writePendingRepairs(root, []);
    assert.deepEqual(readPendingRepairs(root), []);
  } finally { cleanup(); }
});

test("writePendingRepairs: writes valid, human-readable JSON to the expected path", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writePendingRepairs(root, [{ id: "dec_1", from: "a", to: "b" }]);
    const raw = readFileSync(join(root, ".hunch", "pending-commit-repairs.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), [{ id: "dec_1", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("readDroppedRepairs: returns an empty array when the tombstone file doesn't exist", () => {
  const { root, cleanup } = tmpRoot();
  try {
    assert.deepEqual(readDroppedRepairs(root), []);
  } finally { cleanup(); }
});

test("writeDroppedRepairs then readDroppedRepairs round-trips exactly, in a file separate from the pending queue", () => {
  const { root, cleanup } = tmpRoot();
  try {
    const dropped = [{ id: "dec_1", from: "sha_old", to: "sha_rejected" }];
    writeDroppedRepairs(root, dropped);
    assert.deepEqual(readDroppedRepairs(root), dropped);
    assert.deepEqual(readPendingRepairs(root), [], "the tombstone file is independent of the pending queue file");
  } finally { cleanup(); }
});

test("readDroppedRepairs: tolerant of corrupt JSON — returns an empty array, never throws", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(join(root, ".hunch", "dropped-commit-repairs.json"), "{not valid json");
    assert.deepEqual(readDroppedRepairs(root), []);
  } finally { cleanup(); }
});

test("readDroppedRepairs: tolerant of a non-array JSON value — returns an empty array", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(join(root, ".hunch", "dropped-commit-repairs.json"), JSON.stringify({ not: "an array" }));
    assert.deepEqual(readDroppedRepairs(root), []);
  } finally { cleanup(); }
});

test("readDroppedRepairs: filters out entries missing an id, from, or to, keeps valid ones", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeFileSync(
      join(root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_1", from: "a", to: "b" },
        { id: "dec_no_from", to: "b" },
        { from: "b", to: "c" },
        { id: "dec_no_to", from: "a" },
        { id: "", from: "c", to: "d" },
        { id: "dec_empty_from", from: "", to: "d" },
        { id: "dec_empty_to", from: "a", to: "" },
        "garbage",
        null,
      ]),
    );
    assert.deepEqual(readDroppedRepairs(root), [{ id: "dec_1", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("writeDroppedRepairs([]) clears the tombstone file", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writeDroppedRepairs(root, [{ id: "dec_1", from: "a", to: "b" }]);
    writeDroppedRepairs(root, []);
    assert.deepEqual(readDroppedRepairs(root), []);
  } finally { cleanup(); }
});

test("readActivePendingRepairs: an entry with no tombstone passes through unchanged", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writePendingRepairs(root, [{ id: "dec_1", from: "a", to: "b" }]);
    assert.deepEqual(readActivePendingRepairs(root), [{ id: "dec_1", from: "a", to: "b" }]);
  } finally { cleanup(); }
});

test("readActivePendingRepairs: hides an entry whose exact {id, from, to} was rejected via --drop, even though it's still sitting in the raw queue file", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writePendingRepairs(root, [{ id: "dec_a", from: "sha_old", to: "sha_new" }, { id: "dec_b", from: "x", to: "y" }]);
    writeDroppedRepairs(root, [{ id: "dec_a", from: "sha_old", to: "sha_new" }]);
    assert.deepEqual(readActivePendingRepairs(root), [{ id: "dec_b", from: "x", to: "y" }]);
    assert.deepEqual(readPendingRepairs(root), [{ id: "dec_a", from: "sha_old", to: "sha_new" }, { id: "dec_b", from: "x", to: "y" }], "the raw queue file itself is untouched — this is a read-time filter, not a mutation");
  } finally { cleanup(); }
});

test("readActivePendingRepairs: a genuinely different `to` for a tombstoned {id, from} still passes through", () => {
  const { root, cleanup } = tmpRoot();
  try {
    writePendingRepairs(root, [{ id: "dec_a", from: "sha_old", to: "sha_different_candidate" }]);
    writeDroppedRepairs(root, [{ id: "dec_a", from: "sha_old", to: "sha_rejected_candidate" }]);
    assert.deepEqual(readActivePendingRepairs(root), [{ id: "dec_a", from: "sha_old", to: "sha_different_candidate" }]);
  } finally { cleanup(); }
});

test("withheldRewrites: an empty queue withholds nothing", () => {
  const { root, cleanup } = gitRoot();
  try {
    assert.deepEqual(withheldRewrites(root, []), new Set());
  } finally { cleanup(); }
});

test("withheldRewrites: an entry whose `to` resolves to a real commit here is not withheld", () => {
  const { root, headSha, cleanup } = gitRoot();
  try {
    const result = withheldRewrites(root, [{ id: "dec_1", from: "sha_old", to: headSha }]);
    assert.deepEqual(result, new Set());
  } finally { cleanup(); }
});

test("withheldRewrites: an entry whose `to` doesn't resolve here is withheld", () => {
  const { root, cleanup } = gitRoot();
  try {
    const entry = { id: "dec_1", from: "sha_old", to: "0123456789abcdef0123456789abcdef01234567" };
    const result = withheldRewrites(root, [entry]);
    assert.deepEqual(result, new Set([entry]));
  } finally { cleanup(); }
});

test("withheldRewrites: a mix withholds only the unresolvable entry", () => {
  const { root, headSha, cleanup } = gitRoot();
  try {
    const ghost = { id: "dec_ghost", from: "b", to: "0123456789abcdef0123456789abcdef01234567" };
    const result = withheldRewrites(root, [{ id: "dec_real", from: "a", to: headSha }, ghost]);
    assert.deepEqual(result, new Set([ghost]));
  } finally { cleanup(); }
});

test("withheldRewrites: preserves object identity — the withheld set contains the caller's own queue entries, not rebuilt copies (a downstream consumer keys off this by reference)", () => {
  const { root, cleanup } = gitRoot();
  try {
    const entry = { id: "dec_1", from: "sha_old", to: "0123456789abcdef0123456789abcdef01234567" };
    const result = withheldRewrites(root, [entry]);
    assert.equal([...result][0], entry, "must be the SAME object reference, not an equal-but-rebuilt copy");
  } finally { cleanup(); }
});

test("withheldRewrites: a corrupted queue with two entries sharing an id — one resolvable, one not — withholds only the specific unresolvable object, not every entry with that id", () => {
  const { root, headSha, cleanup } = gitRoot();
  try {
    const resolvable = { id: "dec_a", from: "sha_a_old", to: headSha };
    const ghost = { id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" };
    const result = withheldRewrites(root, [resolvable, ghost]);
    assert.deepEqual(result, new Set([ghost]), "the resolvable sibling sharing the same id must NOT be swept up by an id-keyed check");
  } finally { cleanup(); }
});
