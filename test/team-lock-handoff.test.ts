import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();
}

function configure(root: string): void {
  git(root, "config", "user.name", "Lock Handoff Test");
  git(root, "config", "user.email", "lock-handoff@example.test");
  git(root, "config", "commit.gpgsign", "false");
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lock handoff fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a contending process drains a record written after the first owner's exact commit snapshot", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-lock-handoff-"));
  const codeRoot = join(base, "code");
  const memorySeed = join(base, "memory-seed");
  const memoryRemote = join(base, "memory.git");
  const overlayRoot = join(base, "overlay");
  const hunchDir = join(overlayRoot, ".hunch");
  const lock = join(hunchDir, ".hunch-commit.lock");
  const ready = join(base, "owner-ready");
  const writerSawLive = join(base, "writer-saw-live");
  const writerSawOwnerless = join(base, "writer-saw-ownerless");
  const writerSawOwnerlessAgain = join(base, "writer-saw-ownerless-again");
  let owner: ReturnType<typeof spawn> | null = null;
  let writer: ReturnType<typeof spawn> | null = null;
  try {
    mkdirSync(codeRoot, { recursive: true });
    git(codeRoot, "init", "-q", "-b", "main");
    configure(codeRoot);
    writeFileSync(join(codeRoot, "app.ts"), "export const protectedCode = true;\n");
    git(codeRoot, "add", "-A");
    git(codeRoot, "commit", "-qm", "protected code baseline");

    mkdirSync(join(memorySeed, ".hunch"), { recursive: true });
    git(memorySeed, "init", "-q", "-b", "main");
    configure(memorySeed);
    writeFileSync(join(memorySeed, ".hunch/manifest.json"), "{\n  \"schema_version\": 2\n}\n");
    git(memorySeed, "add", "-A");
    git(memorySeed, "commit", "-qm", "memory baseline");
    git(base, "clone", "-q", "--bare", memorySeed, memoryRemote);
    git(base, "clone", "-q", memoryRemote, overlayRoot);
    configure(overlayRoot);

    // This local commit is the first owner's already-fixed path snapshot. It is
    // intentionally not pushed yet.
    mkdirSync(join(hunchDir, "decisions"), { recursive: true });
    writeFileSync(join(hunchDir, "decisions/dec_owner.json"),
      `${JSON.stringify({ id: "dec_owner", title: "first owner snapshot" })}\n`);
    git(overlayRoot, "add", ".hunch/decisions/dec_owner.json");
    git(overlayRoot, "commit", "-qm", "hunch: first owner snapshot");
    const remoteHeadBefore = git(memoryRemote, "rev-parse", "refs/heads/main");
    assert.notEqual(git(overlayRoot, "rev-parse", "HEAD"), remoteHeadBefore);

    const ownerProgram = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `const lock = ${JSON.stringify(lock)};`,
      `const ready = ${JSON.stringify(ready)};`,
      `const writerSawLive = ${JSON.stringify(writerSawLive)};`,
      `const writerSawOwnerless = ${JSON.stringify(writerSawOwnerless)};`,
      `const writerSawOwnerlessAgain = ${JSON.stringify(writerSawOwnerlessAgain)};`,
      "fs.mkdirSync(path.join(lock, `owner-${process.pid}`), { recursive: true });",
      'fs.writeFileSync(ready, "ready\\n");',
      "const sleep = (ms) => { const wait = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(wait, 0, 0, ms); };",
      "const waitForMarker = (marker) => { const deadline = Date.now() + 30_000; while (!fs.existsSync(marker)) { if (Date.now() >= deadline) process.exit(91); sleep(10); } };",
      "waitForMarker(writerSawLive);",
      "fs.rmSync(path.join(lock, `owner-${process.pid}`), { recursive: true, force: true });",
      "waitForMarker(writerSawOwnerless);",
      "waitForMarker(writerSawOwnerlessAgain);",
      "fs.rmSync(lock, { recursive: true, force: true });",
      "process.exit(0);",
    ].join("\n");
    owner = spawn(process.execPath, ["-e", ownerProgram], { stdio: "ignore" });
    await waitFor(() => existsSync(ready), 5_000);

    const runner = join(base, "writer.ts");
    const extractorUrl = pathToFileURL(join(PROJECT_ROOT, "src/extractors/git.ts")).href;
    writeFileSync(runner, [
      'import fs, { mkdirSync, writeFileSync } from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { join } from "node:path";',
      `import { commitAndPushHunch } from ${JSON.stringify(extractorUrl)};`,
      `const hunchDir = ${JSON.stringify(hunchDir)};`,
      `const codeRoot = ${JSON.stringify(codeRoot)};`,
      `const lock = ${JSON.stringify(lock)};`,
      `const writerSawLive = ${JSON.stringify(writerSawLive)};`,
      `const writerSawOwnerless = ${JSON.stringify(writerSawOwnerless)};`,
      `const writerSawOwnerlessAgain = ${JSON.stringify(writerSawOwnerlessAgain)};`,
      'const originalReadDir = fs.readdirSync.bind(fs);',
      'let emptyReads = 0;',
      'fs.readdirSync = ((path, ...args) => {',
      '  const entries = originalReadDir(path, ...args);',
      '  if (String(path) === lock) {',
      '    const names = entries.map((entry) => typeof entry === "string" ? entry : entry.name);',
      '    if (names.some((name) => name.startsWith("owner-"))) fs.writeFileSync(writerSawLive, "live\\n");',
      '    else if (names.length === 0 && fs.existsSync(lock)) {',
      '      emptyReads += 1;',
      '      fs.writeFileSync(emptyReads === 1 ? writerSawOwnerless : writerSawOwnerlessAgain, `${emptyReads}\\n`);',
      '    }',
      '  }',
      '  return entries;',
      '});',
      'syncBuiltinESMExports();',
      'mkdirSync(join(hunchDir, "decisions"), { recursive: true });',
      'writeFileSync(join(hunchDir, "decisions/dec_waiter.json"), `${JSON.stringify({ id: "dec_waiter", title: "waiting writer" })}\\n`);',
      'const result = commitAndPushHunch(hunchDir, "hunch: drain waiting writer", { push: true, protectedRepoRoot: codeRoot });',
      'process.stdout.write(String(result));',
      "",
    ].join("\n"));
    writer = spawn(process.execPath, [TSX, runner], {
      cwd: overlayRoot,
      env: { ...GIT_ENV, HUNCH_PRIVATE_DIR: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    writer.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    writer.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    let writerTimeout!: NodeJS.Timeout;
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        writer!.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_, reject) => {
        writerTimeout = setTimeout(() => reject(new Error("waiting writer did not drain")), 30_000);
      }),
    ]).finally(() => clearTimeout(writerTimeout));
    writer = null;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 0, stderr);
    assert.equal(stdout, "pushed", stderr);

    const remoteTree = git(memoryRemote, "ls-tree", "-r", "--name-only", "refs/heads/main");
    assert.match(remoteTree, /\.hunch\/decisions\/dec_owner\.json/,
      "the stranded first-owner commit is published by the handoff writer");
    assert.match(remoteTree, /\.hunch\/decisions\/dec_waiter\.json/,
      "the record written after the first snapshot is published without a third capture");
    assert.equal(git(overlayRoot, "status", "--porcelain=v1", "--untracked-files=all"), "",
      "the overlay returns clean so request-time pulls cannot freeze");
    assert.equal(git(overlayRoot, "rev-parse", "HEAD"), git(memoryRemote, "rev-parse", "refs/heads/main"));
  } finally {
    if (writer && writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    cleanupDir(base);
  }
});
