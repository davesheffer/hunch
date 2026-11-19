import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_REPO_SOURCE_FILE_BYTES } from "../src/core/safeRepoFile.js";
import { repoSourceInventory } from "../src/extractors/repoSource.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("exact commit hydration batches Git blob reads without weakening repeatable entries", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-repo-source-batch-"));
  const root = join(sandbox, "repo");
  const trace = join(sandbox, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Batch Test");
    git(root, "config", "user.email", "batch@example.test");
    for (let index = 0; index < 257; index++) {
      writeFileSync(join(root, "src", `file-${String(index).padStart(3, "0")}.ts`),
        `export const value${index} = ${index};\n`);
    }
    const oversized = join(root, "src", "oversized.ts");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_REPO_SOURCE_FILE_BYTES + 1);
    git(root, "add", "src");
    git(root, "commit", "-qm", "fixture: many immutable blobs");

    process.env.GIT_TRACE2_EVENT = trace;
    const inventory = repoSourceInventory(root, { kind: "commit", ref: "HEAD" });
    const firstReads = inventory.entries.map((entry) => entry.read());
    assert.equal(firstReads.length, 258);
    assert.equal(firstReads.filter((read) => read.source !== null && read.issue === undefined).length, 257);
    assert.equal(firstReads.find((read) => read.issue?.path === "src/oversized.ts")?.issue?.code, "oversized",
      "batch check rejects an oversized blob before content hydration");

    const starts = readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
      .filter((event) => event.event === "start" && event.argv?.includes("cat-file"));
    assert.equal(starts.filter((event) => event.argv?.some((arg) => arg.startsWith("--batch-check"))).length, 1);
    assert.equal(starts.filter((event) => event.argv?.includes("--batch")).length, 3);
    assert.equal(starts.length, 4, "257 exact-tree files require one check plus three bounded hydration batches");

    assert.equal(inventory.entries[0]!.read().source, firstReads[0]!.source,
      "an entry remains repeatable after its batch payload has been released");
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    cleanupDir(sandbox);
  }
});

test("staged hydration batches index blob reads and returns stage-0 bytes (#666)", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-repo-source-staged-"));
  const root = join(sandbox, "repo");
  const trace = join(sandbox, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Batch Test");
    git(root, "config", "user.email", "batch@example.test");
    for (let index = 0; index < 257; index++) {
      writeFileSync(join(root, "src", `file-${String(index).padStart(3, "0")}.ts`),
        `export const value${index} = ${index};\n`);
    }
    const oversized = join(root, "src", "oversized.ts");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_REPO_SOURCE_FILE_BYTES + 1);
    git(root, "add", "src");
    git(root, "commit", "-qm", "fixture: many indexed blobs");
    writeFileSync(join(root, "src", "file-000.ts"), "export const staged = 1;\n");
    git(root, "add", "src/file-000.ts");
    writeFileSync(join(root, "src", "file-000.ts"), "export const unstaged = 2;\n");
    writeFileSync(join(root, "src", "untracked.ts"), "export const untracked = 3;\n");

    process.env.GIT_TRACE2_EVENT = trace;
    const inventory = repoSourceInventory(root, { kind: "staged" });
    assert.deepEqual(inventory.entries.map((entry) => entry.path),
      [...inventory.entries.map((entry) => entry.path)].sort(), "entries stay path-sorted");
    assert.ok(!inventory.entries.some((entry) => entry.path === "src/untracked.ts"), "untracked files are not staged source");
    const firstReads = inventory.entries.map((entry) => entry.read());
    assert.equal(firstReads.length, 258);
    assert.equal(firstReads.filter((read) => read.source !== null && read.issue === undefined).length, 257);
    assert.equal(firstReads.find((read) => read.issue?.path === "src/oversized.ts")?.issue?.code, "oversized");
    const staged = inventory.entries.findIndex((entry) => entry.path === "src/file-000.ts");
    assert.equal(firstReads[staged]!.source, "export const staged = 1;\n", "reads the stage-0 blob, not the working file");

    const starts = readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
      .filter((event) => event.event === "start" && event.argv?.includes("cat-file"));
    assert.equal(starts.length, 4, "257 staged files require one check plus three bounded hydration batches, not 3 spawns per file");

    assert.equal(inventory.entries[staged]!.read().source, firstReads[staged]!.source,
      "an entry remains repeatable after its batch payload has been released");
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    cleanupDir(sandbox);
  }
});

test("a missing staged blob keeps the read_failed 'could not be read' detail", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-repo-source-missing-"));
  const root = join(sandbox, "repo");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    for (let index = 0; index < 3; index++) writeFileSync(join(root, "src", `ok-${index}.ts`), `export const ok${index} = ${index};\n`);
    writeFileSync(join(root, "src", "gone.ts"), "export const gone = 1;\n");
    git(root, "add", "src");
    const oid = git(root, "rev-parse", ":src/gone.ts");
    rmSync(join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });
    const reads = repoSourceInventory(root, { kind: "staged" }).entries.map((entry) => entry.read());
    const gone = reads.find((read) => read.issue?.path === "src/gone.ts");
    assert.equal(gone?.issue?.code, "read_failed");
    assert.equal(gone?.issue?.detail, "src/gone.ts blob could not be read");
    assert.equal(reads.filter((read) => read.source !== null && read.issue === undefined).length, 3);
  } finally {
    cleanupDir(sandbox);
  }
});

test("a truncated blob that fails its cat-file --batch call does not fail its healthy batch-mates", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-repo-source-truncated-"));
  const root = join(sandbox, "repo");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    for (let index = 0; index < 3; index++) writeFileSync(join(root, "src", `ok-${index}.ts`), `export const ok${index} = ${index};\n`);
    writeFileSync(join(root, "src", "bad.ts"), Array.from({ length: 2000 }, (_, i) => `export const b${i} = ${i * 7919};`).join("\n"));
    git(root, "add", "src");
    const oid = git(root, "rev-parse", ":src/bad.ts");
    const object = join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    // Header still inflates (batch-check reports a blob), but the body is cut short, so `--batch` fails.
    const bytes = readFileSync(object);
    rmSync(object, { force: true });
    writeFileSync(object, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const reads = repoSourceInventory(root, { kind: "staged" }).entries.map((entry) => entry.read());
    assert.equal(reads.find((read) => read.issue?.path === "src/bad.ts")?.issue?.code, "read_failed");
    assert.equal(reads.filter((read) => read.source !== null && read.issue === undefined).length, 3,
      "each batch-mate is re-read on its own after the batch fails");
  } finally {
    cleanupDir(sandbox);
  }
});
