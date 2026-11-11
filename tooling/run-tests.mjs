import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** All Git children of the test runner inherit these runtime settings, including
 * commands in temporary repos that do not use the shared fixture helpers. Git
 * must not detach maintenance while teardown removes a fixture's object store. */
export function fixtureGitEnv(inherited = process.env) {
  const env = { ...inherited };
  const count = env.GIT_CONFIG_COUNT === undefined || env.GIT_CONFIG_COUNT === "" ? 0 : Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid GIT_CONFIG_COUNT in test environment");
  let next = count;
  for (const [key, value] of [["gc.auto", "0"], ["maintenance.auto", "false"]]) {
    let index = -1;
    for (let i = 0; i < next; i++) if (env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === key) index = i;
    if (index < 0) {
      index = next++;
      env[`GIT_CONFIG_KEY_${index}`] = key;
    }
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  env.GIT_CONFIG_COUNT = String(next);
  return env;
}

/** A test-only system config remains effective when product Git calls strip
 * runtime pairs. Unlike a shared global config, test files can independently
 * write their own HOME/.gitconfig without contaminating one another. */
export function fixtureGitSystemConfig(inherited = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "hunch-test-git-config-"));
  const file = join(dir, "config");
  const originals = inherited.GIT_CONFIG_SYSTEM ? [inherited.GIT_CONFIG_SYSTEM] : [];
  const configure = (...args) => {
    const run = spawnSync("git", ["config", "--file", file, ...args], { encoding: "utf8", windowsHide: true });
    if (run.error || run.status !== 0) throw run.error ?? new Error(run.stderr || "could not set test Git config");
  };
  try {
    for (const original of new Set(originals.map((path) => resolve(path)))) if (existsSync(original)) configure("--add", "include.path", original);
    configure("gc.auto", "0");
    configure("maintenance.auto", "false");
    return { dir, file };
  } catch (error) {
    rmSync(file, { force: true });
    rmdirSync(dir);
    throw error;
  }
}

/** CI sharding is never inherited: a nested run-tests invocation inside a test
 * would otherwise silently run only its own slice of files. */
const SHARD_ENV_KEYS = ["HUNCH_TEST_SHARD", "HUNCH_TEST_SHARD_MANIFEST", "HUNCH_TEST_SHARD_PROFILE"];

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const shardSpec = process.env.HUNCH_TEST_SHARD || "";
  const manifestPath = process.env.HUNCH_TEST_SHARD_MANIFEST || "";
  const profileName = process.env.HUNCH_TEST_SHARD_PROFILE || "";
  for (const [key, value] of [["HUNCH_TEST_SHARD_MANIFEST", manifestPath], ["HUNCH_TEST_SHARD_PROFILE", profileName]]) {
    if (value && !shardSpec) {
      process.stderr.write(`run-tests: ${key} is set without HUNCH_TEST_SHARD\n`);
      process.exit(2);
    }
  }
  let profile = null;
  let testArgs = process.argv.slice(2);
  let shard = null;
  let shardFiles = [];
  let selected = [];
  let release = null;
  if (shardSpec) {
    // Only a sharded run loads these; an unsharded run imports nothing new.
    const { parseShardProfile, parseShardSpec, selectShard } = await import("./test-shard.mjs");
    release = await import("./release-gate.mjs");
    try {
      shard = parseShardSpec(shardSpec);
      profile = parseShardProfile(profileName);
    } catch (error) {
      process.stderr.write(`run-tests: ${error.message}\n`);
      process.exit(2);
    }
    // An unexpanded glob would be one "file" landing on shard 1 while every other
    // shard runs nothing and passes: the shell must hand over the real file list.
    const globs = testArgs.filter((arg) => !arg.startsWith("-") && /[*?[{]/.test(arg));
    if (globs.length) {
      process.stderr.write(`run-tests: a sharded run needs expanded file paths, got unexpanded glob ${globs.map((arg) => JSON.stringify(arg)).join(", ")}\n`);
      process.exit(2);
    }
    const isTestFile = (arg) => !arg.startsWith("-") && /\.test\.m?ts$/.test(arg);
    shardFiles = testArgs.filter(isTestFile);
    selected = selectShard(shardFiles, shard, profile);
    testArgs = [...testArgs.filter((arg) => !isTestFile(arg)), ...selected];
  }
  // A shard proves it tested the checked-out source: HEAD and the non-memory
  // working tree are the same after its tests as before them.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceState = () => ({
    commit: release.git(["rev-parse", "HEAD"], repoRoot),
    status: release.statusWithoutMemoryChurn(release.git(release.RELEASE_CLEAN_STATUS_ARGS, repoRoot)),
  });
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  const config = fixtureGitSystemConfig();
  // The user config dir holds machine.json and repo-profiles.json; a real repo profile
  // must never route a fixture's captures into the developer's actual overlay.
  const configHome = mkdtempSync(join(tmpdir(), "hunch-test-config-"));
  let status = 1;
  try {
    const before = shard ? sourceState() : null;
    if (shard && selected.length === 0) {
      // `node --test` given no files would run every default-pattern test instead.
      process.stdout.write(`run-tests: shard ${shard.index}/${shard.total} selects no test files\n`);
      status = 0;
    } else {
      const env = fixtureGitEnv({ HUNCH_SIBLING_WARM: "0", ...process.env, GIT_CONFIG_SYSTEM: config.file, XDG_CONFIG_HOME: configHome });
      for (const key of SHARD_ENV_KEYS) delete env[key];
      const run = spawnSync(process.execPath, [tsx, "--test", ...testArgs], {
        // No detached sibling-warm workers: they would outlive the test and its fixture.
        env, stdio: "inherit", windowsHide: true,
      });
      if (run.error) throw run.error;
      status = run.status ?? 1;
    }
    if (shard) {
      const exitCode = status;
      const after = sourceState();
      const sourceUnchanged = after.commit === before.commit && after.status === before.status;
      if (!sourceUnchanged) {
        const lines = [`run-tests: shard ${shard.index}/${shard.total} changed the source tree while its tests ran`];
        if (after.commit !== before.commit) lines.push(`  HEAD moved from ${before.commit} to ${after.commit}`);
        const { added, removed } = release.statusDiffLines(before.status, after.status);
        for (const line of added) lines.push(`  newly dirty: ${line}`);
        for (const line of removed) lines.push(`  no longer dirty: ${line}`);
        process.stderr.write(`${lines.join("\n")}\n`);
        if (status === 0) status = 1;
      }
      if (manifestPath) {
        const target = resolve(manifestPath);
        mkdirSync(dirname(target), { recursive: true });
        const manifest = {
          schema: "hunch.test-shard.v1",
          shard: `${shard.index}/${shard.total}`,
          index: shard.index,
          total: shard.total,
          profile,
          commit: before.commit,
          input: [...new Set(shardFiles)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
          selected,
          exit_code: exitCode,
          source_unchanged: sourceUnchanged,
          node: process.version,
          platform: process.platform,
        };
        const temporary = `${target}.tmp-${process.pid}`;
        writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n");
        renameSync(temporary, target);
      }
    }
  } finally {
    rmSync(config.file, { force: true });
    rmdirSync(config.dir);
    rmSync(configHome, { recursive: true, force: true });
  }
  process.exit(status);
}
