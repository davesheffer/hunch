/**
 * A memory flush must never freeze the caller: each git call inside commitAndPushHunch is bounded
 * (HUNCH_COMMIT_GIT_TIMEOUT_MS, default 60 s) and runs with automatic gc off. A hung git returns
 * null within the bound, so a served write reports durability "local" instead of stalling the
 * server for minutes (season finding fnd_4318727d35).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndPushHunch } from "../src/extractors/git.js";

const windows = process.platform === "win32";

test("a git that hangs is stopped at the bound and the flush returns null quickly", { skip: windows ? "shell shim" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-commit-timeout-"));
  const bin = join(root, "bin");
  const prevPath = process.env.PATH, prevTimeout = process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS;
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), JSON.stringify({ id: "dec_1", title: "x" }));
    // A fake git that sleeps far longer than the bound, whatever it is asked.
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${prevPath}`;
    process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS = "400";
    const started = Date.now();
    const result = commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_1", { push: false });
    const took = Date.now() - started;
    assert.equal(result, null, "a timed-out git call means nothing was committed");
    // Several bounded calls run in sequence (add, staged-set checks, author lookup at 2 s each);
    // the point is the bound, not the sum: well under one fake git call, let alone the old unbounded wait.
    assert.ok(took < 15_000, `the flush returned in ${took} ms, not after the fake git's 30 s`);
  } finally {
    process.env.PATH = prevPath;
    if (prevTimeout === undefined) delete process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS; else process.env.HUNCH_COMMIT_GIT_TIMEOUT_MS = prevTimeout;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a healthy flush still commits, with automatic gc disabled on the call", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-commit-ok-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(root, ".hunch", "decisions", "dec_1.json"), JSON.stringify({ id: "dec_1", title: "x" }));
    assert.equal(commitAndPushHunch(join(root, ".hunch"), "hunch: capture dec_1", { push: false }), "committed");
    const log = execFileSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" });
    assert.match(log, /capture dec_1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
