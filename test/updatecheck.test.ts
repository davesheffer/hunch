import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultCacheFile,
  formatUpdateNotice,
  isNewerVersion,
  refreshUpdateCache,
  scheduleUpdateCheck,
  shouldCheckForUpdate,
} from "../src/core/updatecheck.js";
import { hunchCliArgs } from "./cli-invocation.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempCache(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "hunch-updatecheck-"));
  return { dir, file: join(dir, "cache.json") };
}

function okFetch(version: string): typeof fetch {
  return (async () => ({ ok: true, json: async () => ({ version }) })) as unknown as typeof fetch;
}

test("version comparison follows SemVer and rejects unsafe registry text", () => {
  const cases: Array<[string, string, boolean]> = [
    ["1.2.0", "1.1.9", true],
    ["1.0.0", "1.0.0-beta.2", true],
    ["1.0.0-beta.10", "1.0.0-beta.9", true],
    ["1.0.0-beta", "1.0.0-10", true],
    ["1.0.0-beta.2", "1.0.0", false],
    ["1.0.0+new", "1.0.0+old", false],
    ["1.0.0", "1.0.0", false],
    ["01.0.0", "0.9.0", false],
    ["9.0.0\u001b[2J", "1.0.0", false],
    [`${"9".repeat(300)}.0.0`, "1.0.0", false],
  ];
  for (const [candidate, current, expected] of cases) {
    assert.equal(isNewerVersion(candidate, current), expected, `${candidate} > ${current}`);
  }
});

test("cache path follows the host convention without creating a .hunch segment", () => {
  assert.equal(
    defaultCacheFile({ platform: "linux", home: "/home/a", env: {} }),
    join("/home/a", ".cache", "hunch", "update-check.json"),
  );
  assert.equal(
    defaultCacheFile({ platform: "darwin", home: "/Users/a", env: {} }),
    join("/Users/a", "Library", "Caches", "hunch", "update-check.json"),
  );
  assert.equal(
    defaultCacheFile({ platform: "win32", home: "C:\\Users\\a", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } }),
    join("C:\\Users\\a\\AppData\\Local", "hunch", "update-check.json"),
  );
  const xdg = defaultCacheFile({ platform: "linux", home: "/home/a", env: { XDG_CACHE_HOME: "/cache" } });
  assert.equal(xdg, join("/cache", "hunch", "update-check.json"));
  assert.ok(!xdg.split(/[\\/]/).includes(".hunch"));
  assert.equal(
    defaultCacheFile({ platform: "linux", home: "/home/a", env: { XDG_CACHE_HOME: ".hunch" } }),
    join("/home/a", ".cache", "hunch", "update-check.json"),
  );
  assert.equal(
    defaultCacheFile({ platform: "linux", home: "/home/a", env: { XDG_CACHE_HOME: "/tmp/.hunch" } }),
    join("/home/a", ".cache", "hunch", "update-check.json"),
  );
  assert.equal(
    defaultCacheFile({ platform: "win32", home: "C:\\Users\\a", env: { LOCALAPPDATA: ".hunch" } }),
    join("C:\\Users\\a", ".cache", "hunch", "update-check.json"),
  );
  for (const alias of ["C:\\work\\.hunch.", "C:\\work\\.hunch "]) {
    assert.equal(
      defaultCacheFile({ platform: "win32", home: "C:\\Users\\a", env: { LOCALAPPDATA: alias } }),
      join("C:\\Users\\a", ".cache", "hunch", "update-check.json"),
      alias,
    );
  }
});

test("worker refresh stores only a valid registry version and never throws", async () => {
  const { dir, file } = tempCache();
  try {
    assert.equal(await refreshUpdateCache({ cacheFile: file, fetchImpl: okFetch("9.9.9"), now: () => 123 }), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { lastCheckedAt: 123, latestSeen: "9.9.9" });

    const unsafe = (async () => ({ ok: true, json: async () => ({ version: "10.0.0\u001b[2J" }) })) as unknown as typeof fetch;
    assert.equal(await refreshUpdateCache({ cacheFile: file, fetchImpl: unsafe, now: () => 456 }), false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { lastCheckedAt: 123, latestSeen: "9.9.9" });

    const offline = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    assert.equal(await refreshUpdateCache({ cacheFile: file, fetchImpl: offline, now: () => 789 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale cache returns its known notice while one detached refresh is scheduled", () => {
  const { dir, file } = tempCache();
  let calls = 0;
  let unrefed = false;
  let observed: { command: string; args: readonly string[]; options: unknown } | null = null;
  const fakeSpawn = ((command: string, args: readonly string[], options: unknown) => {
    calls++;
    observed = { command, args, options };
    return { unref: () => { unrefed = true; } };
  }) as unknown as typeof spawn;
  try {
    writeFileSync(file, JSON.stringify({ lastCheckedAt: 10, latestSeen: "2.0.0" }));
    const result = scheduleUpdateCheck({
      cacheFile: file,
      currentVersion: "1.0.0",
      now: () => 10 + DAY_MS,
      workerFile: "/worker.mjs",
      spawnImpl: fakeSpawn,
    });
    assert.deepEqual(result, { current: "1.0.0", latest: "2.0.0" });
    assert.equal(calls, 1);
    assert.equal(unrefed, true);
    assert.equal(observed!.command, process.execPath);
    assert.deepEqual(observed!.args, ["/worker.mjs", "--hunch-refresh-update-cache", file]);
    assert.deepEqual(observed!.options, { detached: true, stdio: "ignore", windowsHide: true });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { lastCheckedAt: 10 + DAY_MS, latestSeen: "2.0.0" });

    scheduleUpdateCheck({ cacheFile: file, currentVersion: "1.0.0", now: () => 10 + DAY_MS + 1, spawnImpl: fakeSpawn });
    assert.equal(calls, 1, "a failed or still-running refresh is throttled for the interval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt cache is replaced before refresh, while an unwritable cache disables requests", () => {
  const { dir, file } = tempCache();
  let calls = 0;
  const fakeSpawn = (() => {
    calls++;
    return { unref() {} };
  }) as unknown as typeof spawn;
  try {
    writeFileSync(file, "{broken");
    assert.equal(scheduleUpdateCheck({ cacheFile: file, currentVersion: "1.0.0", now: () => 50, spawnImpl: fakeSpawn }), null);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { lastCheckedAt: 50 });

    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    scheduleUpdateCheck({ cacheFile: join(blocker, "cache.json"), now: () => 60, spawnImpl: fakeSpawn });
    assert.equal(calls, 1, "no cache claim means no unbounded repeated network attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing refresh claim is left untouched and an abandoned claim fails closed", () => {
  const { dir, file } = tempCache();
  let calls = 0;
  const fakeSpawn = (() => {
    calls++;
    return { unref() {} };
  }) as unknown as typeof spawn;
  try {
    // Deterministically model another process between its exclusive create and
    // release; this process must neither replace nor reclaim that pathname.
    const lockFile = `${file}.lock`;
    writeFileSync(lockFile, "100\n");
    assert.equal(scheduleUpdateCheck({ cacheFile: file, now: () => 101, spawnImpl: fakeSpawn }), null);
    assert.equal(calls, 0, "an active claim prevents a duplicate worker");
    assert.equal(readFileSync(lockFile, "utf8"), "100\n", "a competing process never replaces or removes the owner's lock");

    assert.equal(scheduleUpdateCheck({ cacheFile: file, now: () => 60_001, spawnImpl: fakeSpawn }), null);
    assert.equal(calls, 0, "an abandoned lock fails closed instead of risking a duplicate worker");
    rmSync(lockFile);
    assert.equal(scheduleUpdateCheck({ cacheFile: file, now: () => 60_001, spawnImpl: fakeSpawn }), null);
    assert.equal(calls, 1, "removing an abandoned derived lock restores checks");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { lastCheckedAt: 60_001 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an asynchronous spawn error cannot crash the foreground command", () => {
  const { dir, file } = tempCache();
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  child.unref = () => child;
  const fakeSpawn = (() => child) as unknown as typeof spawn;
  try {
    scheduleUpdateCheck({ cacheFile: file, now: () => 1, spawnImpl: fakeSpawn });
    assert.doesNotThrow(() => child.emit("error", new Error("EAGAIN")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update checks are limited to ordinary installed interactive commands", () => {
  const allowed = { commandName: "doctor", isTTY: true, installed: true, env: {} };
  assert.equal(shouldCheckForUpdate(allowed), true);
  for (const commandName of ["mcp", "check", "merge-driver", "merge-driver-grounding", "sync", "repair-provenance", "hook", "ci", "serve", "serve init", "update", "task verify", "task finish", "integrations check", "integrations repair-pins"]) {
    assert.equal(shouldCheckForUpdate({ ...allowed, commandName }), false, commandName);
  }
  assert.equal(shouldCheckForUpdate({ ...allowed, isTTY: false }), false);
  assert.equal(shouldCheckForUpdate({ ...allowed, installed: false }), false);
  assert.equal(shouldCheckForUpdate({ ...allowed, env: { CI: "true" } }), false);
  assert.equal(shouldCheckForUpdate({ ...allowed, env: { HUNCH_NO_UPDATE_CHECK: "1" } }), false);
  assert.equal(shouldCheckForUpdate({ ...allowed, env: { NO_UPDATE_NOTIFIER: "1" } }), false);
});

test("notice points at the repository-aware updater and exposes the opt-out", () => {
  const message = formatUpdateNotice({ current: "1.0.0", latest: "1.2.0" });
  assert.match(message, /1\.0\.0.*1\.2\.0/);
  assert.match(message, /hunch update/);
  assert.match(message, /HUNCH_NO_UPDATE_CHECK/);
  assert.doesNotMatch(message, /npm install -g/);
});

test("the detached refresh worker cannot hold the foreground process open", { skip: process.platform === "win32" }, () => {
  const { dir, file } = tempCache();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const runner = join(dir, "runner.ts");
  const sleeper = join(dir, "sleeper.mjs");
  try {
    writeFileSync(sleeper, "setTimeout(() => {}, 1500);\n");
    writeFileSync(runner, [
      `import { scheduleUpdateCheck } from ${JSON.stringify(pathToFileURL(join(root, "src/core/updatecheck.ts")).href)};`,
      `scheduleUpdateCheck({ cacheFile: ${JSON.stringify(file)}, currentVersion: "1.0.0", now: () => 1, workerFile: ${JSON.stringify(sleeper)} });`,
    ].join("\n"));
    const started = performance.now();
    const result = spawnSync(process.execPath, ["--import", "tsx", runner], { cwd: root, encoding: "utf8" });
    const elapsed = performance.now() - started;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(elapsed < 1000, `foreground waited ${elapsed.toFixed(0)}ms for a 1500ms worker`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spawned source-checkout CLI neither checks nor writes a user cache", () => {
  const home = mkdtempSync(join(tmpdir(), "hunch-updatecheck-home-"));
  try {
    const result = spawnSync(process.execPath, hunchCliArgs("doctor"), {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, ".cache") },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(join(home, ".cache", "hunch", "update-check.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
