import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

type Fixture = {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.name", "Shared Setup Safety Test");
  git(root, "config", "user.email", "shared-setup-safety@test.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

function makeMemoryRemote(base: string, name: string, attributes?: string): string {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configureRepo(seed);
  writeFileSync(join(seed, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  writeFileSync(join(seed, ".hunch", "decisions", "dec_setup_safe.json"), `${JSON.stringify({
    id: "dec_setup_safe",
    title: "validated explicit setup",
  }, null, 2)}\n`);
  if (attributes !== undefined) writeFileSync(join(seed, ".gitattributes"), attributes);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: shared memory");
  git(base, "clone", "-q", "--bare", seed, remote);
  return remote;
}

function makeCodeFixture(base: string, name: string): Fixture {
  const root = join(base, name);
  const home = join(base, `${name}-home`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  configureRepo(root);
  writeFileSync(join(root, "README.md"), "# tiny code repository\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "fixture: code repository");
  return {
    root,
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Shared Setup Safety Test",
      GIT_AUTHOR_EMAIL: "shared-setup-safety@test.invalid",
      GIT_COMMITTER_NAME: "Shared Setup Safety Test",
      GIT_COMMITTER_EMAIL: "shared-setup-safety@test.invalid",
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      HUNCH_EMBEDDINGS: "off",
      NO_COLOR: "1",
      CI: "1",
      // Match the selectors Git exports to hooks. Setup must address the explicit
      // overlay repository instead of inheriting the caller's repository context.
      GIT_DIR: join(root, ".git"),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(root, ".git", "index"),
    },
  };
}

function installGlobalConfig(fixture: Fixture, key: string, value: string): void {
  execFileSync("git", ["config", "--global", key, value], {
    env: fixture.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function installCheckoutAttack(fixture: Fixture, base: string, globalAttributes: boolean): {
  hookMarker: string;
  filterMarker: string;
} {
  const hooks = join(fixture.home, "hooks");
  const hookMarker = join(base, "post-checkout-ran");
  const filterMarker = join(base, "smudge-filter-ran");
  const filter = join(fixture.home, "smudge-filter");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
  chmodSync(hook, 0o755);
  writeFileSync(filter, `#!/bin/sh\nprintf ran > ${JSON.stringify(filterMarker)}\ncat\n`);
  chmodSync(filter, 0o755);
  installGlobalConfig(fixture, "core.hooksPath", hooks);
  installGlobalConfig(fixture, "filter.pwn.smudge", filter);
  installGlobalConfig(fixture, "filter.pwn.required", "true");
  if (globalAttributes) {
    const attributes = join(fixture.home, "global-attributes");
    writeFileSync(attributes, "*.json filter=pwn\n");
    installGlobalConfig(fixture, "core.attributesFile", attributes);
  }
  return { hookMarker, filterMarker };
}

function runSharedSetup(
  fixture: Fixture,
  remote: string,
  opts: { migrate?: boolean; failAfterPublicDrop?: boolean } = {},
) {
  return spawnSync(process.execPath, [
    TSX,
    CLI,
    "shared",
    "--repo",
    remote,
    "--no-hook",
    ...(opts.migrate ? ["--migrate"] : []),
  ], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      ...(opts.failAfterPublicDrop
        ? { HUNCH_TEST_FAIL_OVERLAY_MIGRATION_AFTER_PUBLIC_DROP: "1" }
        : {}),
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(result: ReturnType<typeof runSharedSetup>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function setupResidue(root: string): string[] {
  return readdirSync(root).filter((name) =>
    name.startsWith(".hunch-private.tmp-") || name.startsWith(".hunch-private.guard-"));
}

test("explicit shared setup suppresses ambient checkout hooks and global attributes", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-setup-global-checkout-"));
  try {
    const remote = makeMemoryRemote(base, "safe-memory");
    const fixture = makeCodeFixture(base, "code");
    const markers = installCheckoutAttack(fixture, base, true);

    const result = runSharedSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 0, output(result));
    assert.equal(existsSync(markers.hookMarker), false, "the ambient post-checkout hook never starts");
    assert.equal(existsSync(markers.filterMarker), false, "ambient attributes cannot select a smudge command");
    assert.match(
      readFileSync(join(fixture.root, ".hunch-private", ".hunch", "decisions", "dec_setup_safe.json"), "utf8"),
      /validated explicit setup/,
    );
    assert.deepEqual(setupResidue(fixture.root), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared setup rejects remote checkout attributes without execution or routing residue", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-setup-remote-filter-"));
  try {
    const remote = makeMemoryRemote(base, "unsafe-memory", "*.json filter=pwn\n");
    const fixture = makeCodeFixture(base, "code");
    const markers = installCheckoutAttack(fixture, base, false);

    const result = runSharedSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(existsSync(markers.hookMarker), false, "the ambient post-checkout hook never starts");
    assert.equal(existsSync(markers.filterMarker), false, "the remote cannot select a checkout command");
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /unsafe|refus|validat/i);
    assert.equal(existsSync(join(fixture.root, ".hunch-private")), false, "the unsafe overlay is never installed");
    assert.equal(existsSync(join(fixture.root, ".hunch", "local.json")), false, "no local team pointer is written");
    assert.equal(existsSync(join(fixture.root, ".hunch", "team.json")), false, "no committed team route is published");
    assert.equal(existsSync(join(fixture.root, ".git", "hunch", "local.json")), false, "no worktree-shared pointer is written");
    assert.deepEqual(setupResidue(fixture.root), [], "all staged clone controls are removed on refusal");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit shared setup refuses malformed local routing before creating an overlay", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-setup-malformed-local-"));
  try {
    const remote = makeMemoryRemote(base, "safe-memory");
    const fixture = makeCodeFixture(base, "code");
    const hunchDir = join(fixture.root, ".hunch");
    const localFile = join(hunchDir, "local.json");
    const malformed = "{ this is not valid json\n";
    mkdirSync(hunchDir, { recursive: true });
    writeFileSync(localFile, malformed);

    const result = runSharedSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /malformed local configuration/i);
    assert.equal(readFileSync(localFile, "utf8"), malformed, "the malformed user file remains byte-identical");
    assert.equal(existsSync(join(fixture.root, ".hunch-private")), false, "preflight refusal creates no overlay");
    assert.equal(existsSync(join(hunchDir, "team.json")), false, "preflight refusal publishes no team route");
    assert.equal(existsSync(join(fixture.root, ".git", "hunch", "local.json")), false, "no shared pointer is written");
    assert.deepEqual(setupResidue(fixture.root), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a late shared route publication failure restores pre-command routing state", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-setup-late-route-"));
  try {
    const remote = makeMemoryRemote(base, "safe-memory");
    const fixture = makeCodeFixture(base, "code");
    const hunchDir = join(fixture.root, ".hunch");
    const localFile = join(hunchDir, "local.json");
    const teamPath = join(hunchDir, "team.json");
    const gitignore = join(fixture.root, ".gitignore");
    const sharedPointer = join(fixture.root, ".git", "hunch", "local.json");
    const localBefore = `${JSON.stringify({ sentinel: "KEEP_LOCAL_ROUTE" }, null, 2)}\n`;
    const ignoreBefore = "# keep this exact ignore file\ncustom-cache/\n";
    const pointerBefore = `${JSON.stringify({ sentinel: "KEEP_SHARED_ROUTE" }, null, 2)}\n`;
    mkdirSync(teamPath, { recursive: true });
    mkdirSync(join(fixture.root, ".git", "hunch"), { recursive: true });
    writeFileSync(join(teamPath, "keep.txt"), "KEEP_TEAM_DIRECTORY\n");
    writeFileSync(localFile, localBefore);
    writeFileSync(gitignore, ignoreBefore);
    writeFileSync(sharedPointer, pointerBefore);

    const result = runSharedSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 1, output(result));
    assert.equal(existsSync(join(fixture.root, ".hunch-private")), false, "the clone owned by this invocation is removed");
    assert.equal(readFileSync(localFile, "utf8"), localBefore, "the prior local route is restored byte-for-byte");
    assert.equal(readFileSync(gitignore, "utf8"), ignoreBefore, "the prior ignore file is restored byte-for-byte");
    assert.equal(readFileSync(sharedPointer, "utf8"), pointerBefore, "the prior shared pointer remains byte-for-byte");
    assert.equal(readFileSync(join(teamPath, "keep.txt"), "utf8"), "KEEP_TEAM_DIRECTORY\n",
      "a pre-existing non-file team path is never removed by rollback");
    assert.deepEqual(setupResidue(fixture.root), []);
    assert.deepEqual(
      readdirSync(hunchDir).filter((name) => name.startsWith("team.json.tmp")),
      [],
      "failed atomic publication leaves no temporary route file",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a late fresh shared migration failure retains the only migrated memory copy", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-shared-setup-late-migrate-"));
  try {
    const remote = makeMemoryRemote(base, "safe-memory");
    const fixture = makeCodeFixture(base, "code");
    const publicDecision = join(fixture.root, ".hunch", "decisions", "dec_public_survivor.json");
    const migratedDecision = join(fixture.root, ".hunch-private", ".hunch", "decisions", "dec_public_survivor.json");
    const verifiedAt = "2026-07-19T09:00:00.000Z";
    mkdirSync(join(fixture.root, ".hunch", "decisions"), { recursive: true });
    writeFileSync(join(fixture.root, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
    writeFileSync(publicDecision, `${JSON.stringify({
      id: "dec_public_survivor",
      title: "public memory survives late shared setup failure",
      status: "accepted",
      context: "Regression fixture for the migration ownership handoff.",
      decision: "Keep every migrated record in at least one durable home.",
      provenance: {
        source: "human_confirmed",
        confidence: 1,
        evidence: ["team-shared-setup-clone-safety"],
        last_verified: verifiedAt,
      },
      date: verifiedAt,
    }, null, 2)}\n`);
    git(fixture.root, "add", ".hunch/manifest.json", ".hunch/decisions/dec_public_survivor.json");
    git(fixture.root, "commit", "-qm", "fixture: public engineering memory");

    const result = runSharedSetup(fixture, remote, { migrate: true, failAfterPublicDrop: true });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /injected late overlay migration failure after public memory drop/i);
    assert.equal(existsSync(publicDecision), false, "the injected failure is after the public-drop seam");
    assert.equal(existsSync(migratedDecision), true,
      "rollback must retain the fresh overlay once it owns the only migrated record copy");
    assert.match(readFileSync(migratedDecision, "utf8"), /public memory survives late shared setup failure/);
    assert.equal(existsSync(join(fixture.root, ".hunch", "local.json")), false,
      "failed setup restores the pre-command local route");
    assert.equal(existsSync(join(fixture.root, ".hunch", "team.json")), false,
      "failed setup restores the pre-command committed route");
    assert.equal(existsSync(join(fixture.root, ".git", "hunch", "local.json")), false,
      "failed setup restores the pre-command worktree-shared route");
    assert.deepEqual(setupResidue(fixture.root), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
