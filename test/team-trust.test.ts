import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureTeamOverlay,
  isTeamStoreTrusted,
  readTeamConfig,
  teamTrustFile,
  trustTeamStore,
  writeTeamConfig,
} from "../src/integrations/team.js";

// A committed .hunch/team.json is chosen by whoever wrote the repository. Hunch
// wires the advertised store only after THIS user consents, and that consent
// lives outside every repository.

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HUNCH_PRIVATE_DIR"] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.name", "Trust Test");
  git(root, "config", "user.email", "trust@test.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

function homeEnv(home: string): NodeJS.ProcessEnv {
  mkdirSync(join(home, ".config"), { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HUNCH_PRIVATE_DIR: "",
  };
}

function withIsolatedHome<T>(home: string, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  delete process.env.GIT_CONFIG_GLOBAL;
  Object.assign(process.env, homeEnv(home));
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeMemoryRemote(base: string, name: string): string {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configureRepo(seed);
  writeFileSync(join(seed, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  writeFileSync(join(seed, ".hunch", "decisions", "dec_trust_fixture.json"), `${JSON.stringify({ id: "dec_trust_fixture", title: "fixture" }, null, 2)}\n`);
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

function assertUnwired(project: string): void {
  assert.equal(existsSync(join(project, ".hunch-private")), false, "the advertised store is never cloned");
  assert.equal(existsSync(join(project, ".hunch", "local.json")), false, "the advertised store is never wired");
}

test("an untrusted team.json never clones or wires the advertised store", () => {
  const base = tempDir("hunch-team-trust-untrusted-");
  try {
    withIsolatedHome(join(base, "home"), () => {
      const project = makeProject(base, "project", makeMemoryRemote(base, "memory"));
      const team = readTeamConfig(project);
      assert.ok(team);
      assert.equal(isTeamStoreTrusted(project, team), false);

      assert.equal(ensureTeamOverlay(project), null);
      assertUnwired(project);
      assert.equal(teamTrustFile().startsWith(join(base, "home")), true, "consent lives in the user's config, not the repo");
      assert.equal(existsSync(teamTrustFile()), false, "checking consent never grants it");
    });
  } finally {
    cleanupDir(base);
  }
});

test("a pre-existing .hunch-private directory is not adopted without trust", () => {
  const base = tempDir("hunch-team-trust-adopt-");
  try {
    withIsolatedHome(join(base, "home"), () => {
      const remote = makeMemoryRemote(base, "memory");
      const project = makeProject(base, "project", remote);
      // e.g. a submodule checked out by `git clone --recursive`, already tracking the remote.
      git(project, "clone", "-q", remote, ".hunch-private");

      assert.equal(ensureTeamOverlay(project), null);
      assert.equal(existsSync(join(project, ".hunch", "local.json")), false, "nothing is wired");
    });
  } finally {
    cleanupDir(base);
  }
});

test("trust is bound to the exact advertised URL, and a changed URL needs fresh consent", () => {
  const base = tempDir("hunch-team-trust-url-");
  try {
    withIsolatedHome(join(base, "home"), () => {
      const trusted = makeMemoryRemote(base, "trusted");
      const other = makeMemoryRemote(base, "other");
      const project = makeProject(base, "project", trusted);
      trustTeamStore(project, readTeamConfig(project)!);

      writeTeamConfig(project, { shared_repo: other, shared_ref: "refs/heads/main" });
      assert.equal(isTeamStoreTrusted(project, readTeamConfig(project)!), false);
      assert.equal(ensureTeamOverlay(project), null);
      assertUnwired(project);

      writeTeamConfig(project, { shared_repo: trusted, shared_ref: "refs/heads/main" });
      const wired = ensureTeamOverlay(project);
      assert.ok(wired, "the consented store wires");
      assert.ok(existsSync(join(wired, "decisions", "dec_trust_fixture.json")));
    });
  } finally {
    cleanupDir(base);
  }
});

test("one consent covers every worktree of the same checkout", () => {
  const base = tempDir("hunch-team-trust-worktree-");
  try {
    withIsolatedHome(join(base, "home"), () => {
      const project = makeProject(base, "project", makeMemoryRemote(base, "memory"));
      const linked = join(base, "linked");
      git(project, "worktree", "add", "-q", "-b", "side", linked);
      trustTeamStore(linked, readTeamConfig(linked)!);
      assert.equal(isTeamStoreTrusted(project, readTeamConfig(project)!), true);
    });
  } finally {
    cleanupDir(base);
  }
});

test("a malformed consent file trusts nothing and is never clobbered", () => {
  const base = tempDir("hunch-team-trust-malformed-");
  try {
    withIsolatedHome(join(base, "home"), () => {
      const project = makeProject(base, "project", makeMemoryRemote(base, "memory"));
      const file = teamTrustFile();
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{ not json");
      const team = readTeamConfig(project)!;

      assert.equal(isTeamStoreTrusted(project, team), false);
      assert.throws(() => trustTeamStore(project, team), /refusing to overwrite unreadable team trust file/);
      assert.equal(readFileSync(file, "utf8"), "{ not json");
      assert.equal(ensureTeamOverlay(project), null);
      assertUnwired(project);
    });
  } finally {
    cleanupDir(base);
  }
});

test("CLI: an untrusted team.json fails closed with the trust step; `hunch shared --trust` connects", () => {
  const base = tempDir("hunch-team-trust-cli-");
  try {
    const home = join(base, "home");
    const env = isolatedCliEnv({ ...homeEnv(home), HUNCH_EMBEDDINGS: "off", NO_COLOR: "1", CI: "1" });
    const project = withIsolatedHome(home, () => makeProject(base, "project", makeMemoryRemote(base, "memory")));
    const run = (...args: string[]) => spawnSync(process.execPath, hunchCliArgs(...args), {
      cwd: project, env, encoding: "utf8", timeout: 60_000,
    });

    const refused = run("init");
    assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
    assert.match(refused.stdout + refused.stderr, /have not trusted on this machine[\s\S]*hunch shared --trust/);
    assertUnwired(project);

    const trusted = run("shared", "--trust");
    assert.equal(trusted.status, 0, trusted.stdout + trusted.stderr);
    assert.match(trusted.stdout, /trusted the team memory store/);
    assert.ok(existsSync(join(project, ".hunch-private", ".hunch", "decisions", "dec_trust_fixture.json")));

    const init = run("init");
    assert.equal(init.status, 0, init.stdout + init.stderr);
  } finally {
    cleanupDir(base);
  }
});

test("a committed .hunch/local.json cannot borrow another checkout's trusted store", () => {
  const base = tempDir("hunch-team-trust-borrow-");
  try {
    const home = join(base, "home");
    const env = isolatedCliEnv({ ...homeEnv(home), HUNCH_EMBEDDINGS: "off", NO_COLOR: "1", CI: "1" });
    withIsolatedHome(home, () => {
      const remote = makeMemoryRemote(base, "memory");
      // The victim's legitimate checkout: trusted and wired to the team store.
      const trusted = makeProject(base, "trusted", remote);
      trustTeamStore(trusted, readTeamConfig(trusted)!);
      const wired = ensureTeamOverlay(trusted);
      assert.ok(wired);

      // A hostile repository advertising the same store and shipping a pointer
      // at the victim's clone, as it arrives from `git clone`.
      const hostileSeed = join(base, "hostile-seed");
      mkdirSync(join(hostileSeed, ".hunch"), { recursive: true });
      git(hostileSeed, "init", "-q", "-b", "main");
      configureRepo(hostileSeed);
      writeTeamConfig(hostileSeed, { shared_repo: remote, shared_ref: "refs/heads/main" });
      writeFileSync(join(hostileSeed, ".hunch", "local.json"), `${JSON.stringify({ privateDir: wired, autoCommit: true, mode: "shared" }, null, 2)}\n`);
      git(hostileSeed, "add", "-A");
      git(hostileSeed, "commit", "-qm", "fixture: hostile pointer");
      const hostile = join(base, "hostile");
      git(base, "clone", "-q", hostileSeed, hostile);

      assert.equal(isTeamStoreTrusted(hostile, readTeamConfig(hostile)!), false);
      assert.equal(ensureTeamOverlay(hostile), null);

      const refused = spawnSync(process.execPath, hunchCliArgs("init"), { cwd: hostile, env, encoding: "utf8", timeout: 60_000 });
      assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /have not trusted on this machine/);
    });
  } finally {
    cleanupDir(base);
  }
});

test("a checkout this machine already wired keeps working without a trust entry", () => {
  const base = tempDir("hunch-team-trust-legacy-");
  try {
    const home = join(base, "home");
    const env = isolatedCliEnv({ ...homeEnv(home), HUNCH_EMBEDDINGS: "off", NO_COLOR: "1", CI: "1" });
    const project = withIsolatedHome(home, () => {
      const root = makeProject(base, "project", makeMemoryRemote(base, "memory"));
      trustTeamStore(root, readTeamConfig(root)!);
      assert.ok(ensureTeamOverlay(root));
      return root;
    });
    // Pre-upgrade wiring had no consent file; the git-common-dir pointer it wrote remains.
    rmSync(teamTrustFileFor(home), { force: true });
    const init = spawnSync(process.execPath, hunchCliArgs("init"), { cwd: project, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(init.status, 0, init.stdout + init.stderr);
  } finally {
    cleanupDir(base);
  }
});

function teamTrustFileFor(home: string): string {
  return withIsolatedHome(home, () => teamTrustFile());
}
