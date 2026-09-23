import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** A test-only global config remains effective when product Git calls strip the
 * runtime GIT_CONFIG_COUNT variables to avoid crossing repository boundaries. */
export function fixtureGitGlobalConfig(inherited = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "hunch-test-git-config-"));
  const file = join(dir, "config");
  const home = homedir();
  const originals = inherited.GIT_CONFIG_GLOBAL
    ? [inherited.GIT_CONFIG_GLOBAL]
    : [join(inherited.XDG_CONFIG_HOME || join(home, ".config"), "git", "config"), join(home, ".gitconfig")];
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  const config = fixtureGitGlobalConfig();
  let status = 1;
  try {
    const run = spawnSync(process.execPath, [tsx, "--test", ...process.argv.slice(2)], {
      env: fixtureGitEnv({ ...process.env, GIT_CONFIG_GLOBAL: config.file }), stdio: "inherit", windowsHide: true,
    });
    if (run.error) throw run.error;
    status = run.status ?? 1;
  } finally {
    rmSync(config.file, { force: true });
    rmdirSync(config.dir);
  }
  process.exit(status);
}
