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
    rmSync(sandbox, { recursive: true, force: true });
  }
});
