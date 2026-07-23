import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureTeamOverlay, writeTeamConfig } from "../src/integrations/team.js";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "HUNCH_PRIVATE_DIR",
] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.name", "Clone Safety Test");
  git(root, "config", "user.email", "clone-safety@test.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

function withIsolatedHome<T>(home: string, fn: (env: NodeJS.ProcessEnv) => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  mkdirSync(join(home, ".config"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.HUNCH_PRIVATE_DIR = "";
  const env = { ...process.env };
  try {
    return fn(env);
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeMemoryRemote(
  base: string,
  name: string,
  attributes?: string,
  extraFiles: Record<string, string> = {},
): string {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configureRepo(seed);
  writeFileSync(join(seed, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  writeFileSync(join(seed, ".hunch", "decisions", "dec_clone_safe.json"), `${JSON.stringify({
    id: "dec_clone_safe",
    title: "safe clone record",
  }, null, 2)}\n`);
  if (attributes !== undefined) writeFileSync(join(seed, ".gitattributes"), attributes);
  for (const [path, content] of Object.entries(extraFiles)) {
    mkdirSync(join(seed, path, ".."), { recursive: true });
    writeFileSync(join(seed, path), content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: shared memory");
  git(base, "clone", "-q", "--bare", seed, remote);
  return remote;
}

function makeProject(base: string, name: string, memoryRemote: string): string {
  const root = join(base, name);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  configureRepo(root);
  writeFileSync(join(root, "README.md"), "# tiny project\n");
  writeTeamConfig(root, { shared_repo: memoryRemote, shared_ref: "refs/heads/main" });
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture: advertise shared memory");
  return root;
}

function installGlobalConfig(env: NodeJS.ProcessEnv, key: string, value: string): void {
  execFileSync("git", ["config", "--global", key, value], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function assertNoCloneResidue(project: string): void {
  assert.equal(existsSync(join(project, ".hunch-private")), false, "unsafe memory is never installed");
  assert.equal(existsSync(join(project, ".hunch", "local.json")), false, "unsafe memory is never wired");
  assert.deepEqual(
    readdirSync(project).filter((name) => name.startsWith(".hunch-private.tmp-") || name.startsWith(".hunch-private.guard-")),
    [],
    "staged clone controls are removed on refusal",
  );
}

test("fresh team auto-discovery never executes an ambient post-checkout hook", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-clone-hook-"));
  try {
    const home = join(base, "home");
    withIsolatedHome(home, (env) => {
      const remote = makeMemoryRemote(base, "safe-memory");
      const project = makeProject(base, "project", remote);
      const hooks = join(home, "hooks");
      const marker = join(base, "post-checkout-ran");
      mkdirSync(hooks, { recursive: true });
      const hook = join(hooks, "post-checkout");
      writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
      chmodSync(hook, 0o755);
      installGlobalConfig(env, "core.hooksPath", hooks);

      const wired = ensureTeamOverlay(project);

      assert.ok(wired, "safe memory still auto-wires");
      assert.equal(existsSync(marker), false, "clone and materialization both suppress checkout hooks");
      assert.match(readFileSync(join(wired!, "decisions", "dec_clone_safe.json"), "utf8"), /safe clone record/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fresh team auto-discovery suppresses ambient global attributes and smudge filters", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-clone-global-filter-"));
  try {
    const home = join(base, "home");
    withIsolatedHome(home, (env) => {
      const remote = makeMemoryRemote(base, "safe-memory");
      const project = makeProject(base, "project", remote);
      const marker = join(base, "global-smudge-ran");
      const filter = join(home, "global-smudge-filter");
      const attributes = join(home, "global-attributes");
      writeFileSync(filter, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat\n`);
      chmodSync(filter, 0o755);
      writeFileSync(attributes, "*.json filter=pwn\n");
      installGlobalConfig(env, "core.attributesFile", attributes);
      installGlobalConfig(env, "filter.pwn.smudge", filter);
      installGlobalConfig(env, "filter.pwn.required", "true");

      const wired = ensureTeamOverlay(project);

      assert.ok(wired, "a safe remote stays usable despite hostile ambient checkout configuration");
      assert.equal(existsSync(marker), false, "ambient attributes cannot select a global filter during materialization");
      assert.match(readFileSync(join(wired!, "decisions", "dec_clone_safe.json"), "utf8"), /safe clone record/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fresh team auto-discovery rejects a remote smudge filter before executing it or materializing files", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-clone-smudge-"));
  try {
    const home = join(base, "home");
    withIsolatedHome(home, (env) => {
      const remote = makeMemoryRemote(base, "smudge-memory", "*.json filter=pwn\n");
      const project = makeProject(base, "project", remote);
      const marker = join(base, "smudge-ran");
      const filter = join(home, "smudge-filter");
      writeFileSync(filter, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\ncat\n`);
      chmodSync(filter, 0o755);
      installGlobalConfig(env, "filter.pwn.smudge", filter);
      installGlobalConfig(env, "filter.pwn.required", "true");

      assert.equal(ensureTeamOverlay(project), null);

      assert.equal(existsSync(marker), false, "untrusted smudge command never starts");
      assertNoCloneResidue(project);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fresh team auto-discovery rejects a remote process filter before executing it or materializing files", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-clone-process-"));
  try {
    const home = join(base, "home");
    withIsolatedHome(home, (env) => {
      const remote = makeMemoryRemote(base, "process-memory", "*.json filter=pwn\n");
      const project = makeProject(base, "project", remote);
      const marker = join(base, "process-ran");
      const filter = join(home, "process-filter");
      writeFileSync(filter, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(filter, 0o755);
      installGlobalConfig(env, "filter.pwn.process", filter);
      installGlobalConfig(env, "filter.pwn.required", "true");

      assert.equal(ensureTeamOverlay(project), null);

      assert.equal(existsSync(marker), false, "untrusted long-running filter command never starts");
      assertNoCloneResidue(project);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("fresh team auto-discovery rejects tracked clone-local and derived runtime artifacts", () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-team-clone-runtime-"));
  try {
    const home = join(base, "home");
    withIsolatedHome(home, () => {
      const cases: Array<[string, string]> = [
        [".hunch/local.json", '{"privateDir":"/SECRET/machine-overlay"}\n'],
        [".hunch/hunch.sqlite", "derived database bytes\n"],
        [".hunch/decisions/record.json.tmp123", "atomic temp bytes\n"],
        [".hunch-cache/replay/cache.json", "derived cache bytes\n"],
      ];
      for (const [index, [path, content]] of cases.entries()) {
        const remote = makeMemoryRemote(base, `runtime-memory-${index}`, undefined, { [path]: content });
        const project = makeProject(base, `project-${index}`, remote);
        assert.equal(ensureTeamOverlay(project), null, path);
        assertNoCloneResidue(project);
      }
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
