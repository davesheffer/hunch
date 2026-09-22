import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { safeTeamRef } from "../src/integrations/team.js";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

function withRefChecker(statuses: Array<number | null>, run: (calls: string[]) => void): void {
  const original = childProcess.spawnSync;
  const calls: string[] = [];
  childProcess.spawnSync = ((command: string, args: string[]) => {
    assert.equal(command, "git");
    assert.equal(args[0], "check-ref-format");
    calls.push(args[1]);
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return { status, signal: null, stdout: null, stderr: null, pid: 0, output: [] };
  }) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  try { run(calls); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
}

test("repeated team routing validates unchanged ref syntax once without caching other refs", () => {
  withRefChecker([0], calls => {
    for (let i = 0; i < 100; i++) assert.equal(safeTeamRef(" refs/heads/cache-repeat "), "refs/heads/cache-repeat");
    assert.deepEqual(calls, ["refs/heads/cache-repeat"]);
    assert.equal(safeTeamRef("refs/heads/cache-next"), "refs/heads/cache-next");
    assert.equal(safeTeamRef("refs/heads/cache-repeat"), "refs/heads/cache-repeat");
    assert.deepEqual(calls, ["refs/heads/cache-repeat", "refs/heads/cache-next", "refs/heads/cache-repeat"], "only the most recent successful syntax check is retained");
  });
});

test("a failed Git invocation is retried and never grants ref validity", () => {
  withRefChecker([null, 0], calls => {
    assert.equal(safeTeamRef("refs/heads/cache-retry"), null);
    assert.equal(safeTeamRef("refs/heads/cache-retry"), "refs/heads/cache-retry");
    assert.equal(safeTeamRef("refs/heads/cache-retry"), "refs/heads/cache-retry");
    assert.equal(calls.length, 2);
  });
  withRefChecker([1], calls => {
    assert.equal(safeTeamRef("refs/heads/invalid..ref"), null);
    assert.equal(safeTeamRef("refs/heads/invalid..ref"), null);
    assert.equal(calls.length, 2);
  });
});

test("team ref syntax agrees with real Git for valid, malformed and non-branch inputs", () => {
  const values = [
    "refs/heads/main", "refs/heads/feature/topic", "refs/heads/שלום", " refs/heads/trimmed ",
    "refs/tags/v1", "main", "refs/heads/", "refs/heads/.hidden", "refs/heads/name.lock",
    "refs/heads/double..dot", "refs/heads/a b", "refs/heads/a~b", "refs/heads/a^b",
    "refs/heads/a:b", "refs/heads/a?b", "refs/heads/a*b", "refs/heads/a[b", "refs/heads/a//b",
    "refs/heads/trailing/", "refs/heads/trailing.", "refs/heads/a@{b", "refs/heads/a\\b", "refs/heads/a\u0001b",
  ];
  for (const value of values) {
    const ref = value.trim();
    const expected = ref.startsWith("refs/heads/") && ref !== "refs/heads/" && childProcess.spawnSync("git", ["check-ref-format", ref], { stdio: "ignore" }).status === 0 ? ref : null;
    assert.equal(safeTeamRef(value), expected, JSON.stringify(value));
    assert.equal(safeTeamRef(value), expected, `repeat ${JSON.stringify(value)}`);
  }
});
