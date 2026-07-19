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
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(root: string): void {
  git(root, "config", "user.name", "Private Setup Safety Test");
  git(root, "config", "user.email", "private-setup-safety@test.invalid");
  git(root, "config", "commit.gpgsign", "false");
}

function makeMemoryRemote(base: string, name: string, attributes?: string): string {
  const seed = join(base, `${name}-seed`);
  const remote = join(base, `${name}.git`);
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  configureRepo(seed);
  writeFileSync(join(seed, ".hunch", "manifest.json"), "{\n  \"schema_version\": 2\n}\n");
  writeFileSync(join(seed, ".hunch", "decisions", "dec_private_setup_safe.json"), `${JSON.stringify({
    id: "dec_private_setup_safe",
    title: "validated explicit private setup",
  }, null, 2)}\n`);
  if (attributes !== undefined) writeFileSync(join(seed, ".gitattributes"), attributes);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "fixture: private memory");
  git(base, "clone", "-q", "--bare", seed, remote);
  return remote;
}

function advanceMemoryRemote(base: string, remote: string): void {
  const publisher = join(base, "publisher");
  git(base, "clone", "-q", remote, publisher);
  configureRepo(publisher);
  writeFileSync(join(publisher, ".hunch", "decisions", "dec_private_setup_new.json"), `${JSON.stringify({
    id: "dec_private_setup_new",
    title: "remote update must remain unmaterialized on refusal",
  }, null, 2)}\n`);
  git(publisher, "add", "-A");
  git(publisher, "commit", "-qm", "fixture: advance private memory");
  git(publisher, "push", "-q", "origin", "HEAD");
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
      GIT_AUTHOR_NAME: "Private Setup Safety Test",
      GIT_AUTHOR_EMAIL: "private-setup-safety@test.invalid",
      GIT_COMMITTER_NAME: "Private Setup Safety Test",
      GIT_COMMITTER_EMAIL: "private-setup-safety@test.invalid",
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      HUNCH_EMBEDDINGS: "off",
      NO_COLOR: "1",
      CI: "1",
      // Emulate Git invoking Hunch from a hook. Overlay setup must not inherit
      // these selectors and accidentally operate on the code repository.
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
  filter: string;
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
  installGlobalConfig(fixture, "filter.pwn.clean", "cat");
  installGlobalConfig(fixture, "filter.pwn.smudge", filter);
  installGlobalConfig(fixture, "filter.pwn.required", "true");
  if (globalAttributes) {
    const attributes = join(fixture.home, "global-attributes");
    writeFileSync(attributes, "*.json filter=pwn\n");
    installGlobalConfig(fixture, "core.attributesFile", attributes);
  }
  return { hookMarker, filterMarker, filter };
}

function runPrivateSetup(fixture: Fixture, remote: string) {
  return spawnSync(process.execPath, [TSX, CLI, "private", "--repo", remote, "--no-hook"], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function output(result: ReturnType<typeof runPrivateSetup>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function setupResidue(root: string): string[] {
  return readdirSync(root).filter((name) =>
    name.startsWith(".hunch-private.tmp-") || name.startsWith(".hunch-private.guard-"));
}

function assertNoRoutingResidue(root: string): void {
  assert.equal(existsSync(join(root, ".hunch", "local.json")), false, "no local private route is written");
  assert.equal(existsSync(join(root, ".hunch", "team.json")), false, "private setup never publishes a team route");
  assert.equal(existsSync(join(root, ".git", "hunch", "local.json")), false, "no common-dir route is written");
  assert.deepEqual(setupResidue(root), [], "all staged clone controls are removed");
}

test("explicit private setup suppresses ambient checkout hooks and global attributes", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-private-setup-global-checkout-"));
  try {
    const remote = makeMemoryRemote(base, "safe-memory");
    const fixture = makeCodeFixture(base, "code");
    const markers = installCheckoutAttack(fixture, base, true);

    const result = runPrivateSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 0, output(result));
    assert.equal(existsSync(markers.hookMarker), false, "the ambient post-checkout hook never starts");
    assert.equal(existsSync(markers.filterMarker), false, "ambient attributes cannot select a smudge command");
    assert.match(
      readFileSync(join(fixture.root, ".hunch-private", ".hunch", "decisions", "dec_private_setup_safe.json"), "utf8"),
      /validated explicit private setup/,
    );
    const local = JSON.parse(readFileSync(join(fixture.root, ".hunch", "local.json"), "utf8")) as Record<string, unknown>;
    assert.equal(local.mode, "private");
    assert.equal(existsSync(join(fixture.root, ".hunch", "team.json")), false, "the private URL is never published");
    assert.equal(existsSync(join(fixture.root, ".git", "hunch", "local.json")), true, "all worktrees receive the local route");
    assert.deepEqual(setupResidue(fixture.root), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit private setup rejects remote checkout attributes without execution or routing residue", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-private-setup-remote-filter-"));
  try {
    const remote = makeMemoryRemote(base, "unsafe-memory", "*.json filter=pwn\n");
    const fixture = makeCodeFixture(base, "code");
    const markers = installCheckoutAttack(fixture, base, false);

    const result = runPrivateSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /unsafe|refus|validat/i);
    assert.equal(existsSync(markers.hookMarker), false, "the ambient post-checkout hook never starts");
    assert.equal(existsSync(markers.filterMarker), false, "the remote cannot select a checkout command");
    assert.equal(existsSync(join(fixture.root, ".hunch-private")), false, "the unsafe overlay is never installed");
    assertNoRoutingResidue(fixture.root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("existing private attach rejects info attributes before fetch, checkout, or routing mutation", { timeout: 60_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), "hunch-private-setup-info-filter-"));
  try {
    const remote = makeMemoryRemote(base, "safe-memory");
    const fixture = makeCodeFixture(base, "code");
    const overlay = join(fixture.root, ".hunch-private");
    git(fixture.root, "clone", "-q", remote, overlay);
    configureRepo(overlay);
    const markers = installCheckoutAttack(fixture, base, false);
    mkdirSync(join(overlay, ".git", "info"), { recursive: true });
    writeFileSync(join(overlay, ".git", "info", "attributes"), "*.json filter=pwn\n");
    git(overlay, "config", "filter.pwn.smudge", markers.filter);
    git(overlay, "config", "filter.pwn.clean", "cat");
    git(overlay, "config", "filter.pwn.required", "true");
    advanceMemoryRemote(base, remote);

    const overlayHeadBefore = git(overlay, "rev-parse", "HEAD");
    const overlayStatusBefore = git(overlay, "status", "--porcelain=v1", "--untracked-files=all");
    const overlayRefsBefore = git(overlay, "for-each-ref", "--format=%(refname):%(objectname)");
    const overlayConfigBefore = git(overlay, "config", "--local", "--list", "--show-origin");
    const codeHeadBefore = git(fixture.root, "rev-parse", "HEAD");
    const codeStatusBefore = git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all");

    const result = runPrivateSetup(fixture, remote);

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, output(result));
    assert.equal(result.status, 1, output(result));
    assert.match(output(result), /unsafe|refus|prove|converge|attribute/i);
    assert.equal(existsSync(markers.hookMarker), false, "no inherited hook executes");
    assert.equal(existsSync(markers.filterMarker), false, "info attributes are rejected before smudge execution");
    assert.equal(git(overlay, "rev-parse", "HEAD"), overlayHeadBefore, "the overlay HEAD does not move");
    assert.equal(git(overlay, "status", "--porcelain=v1", "--untracked-files=all"), overlayStatusBefore,
      "the overlay worktree remains byte-for-byte clean");
    assert.equal(git(overlay, "for-each-ref", "--format=%(refname):%(objectname)"), overlayRefsBefore,
      "refusal does not leave a fetched ref");
    assert.equal(git(overlay, "config", "--local", "--list", "--show-origin"), overlayConfigBefore,
      "refusal does not rewrite repository routing or filter config");
    assert.equal(existsSync(join(overlay, ".hunch", "decisions", "dec_private_setup_new.json")), false,
      "the remote update is never materialized");
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), codeHeadBefore, "the code HEAD does not move");
    assert.equal(git(fixture.root, "status", "--porcelain=v1", "--untracked-files=all"), codeStatusBefore,
      "the code repository is untouched");
    assertNoRoutingResidue(fixture.root);

    // Control: the exact Git metadata is live and would execute the command if
    // Hunch allowed a normal checkout path. This keeps a false-negative marker
    // from making the safety assertion vacuous.
    const controlledPath = ".hunch/decisions/dec_private_setup_safe.json";
    assert.match(git(overlay, "check-attr", "filter", "--", controlledPath), /: filter: pwn$/);
    rmSync(join(overlay, controlledPath));
    git(overlay, "checkout", "--", controlledPath);
    assert.equal(existsSync(markers.filterMarker), true, "the adversarial info attribute is executable under raw Git");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
