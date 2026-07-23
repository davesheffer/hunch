import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const PRIVATE_SOURCE = [
  'import hidden from "@private/PRIVATE_PACKAGE_SENTINEL";',
  "export function PRIVATE_FUNCTION_SENTINEL(){ return hidden; }",
  "",
].join("\n");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureGit(root: string): void {
  git(root, "config", "user.email", "index-source@test.invalid");
  git(root, "config", "user.name", "Index Source Test");
  git(root, "config", "commit.gpgsign", "false");
}

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      NO_COLOR: "1",
    },
  });
}

function filesBelow(root: string, dir: string): Array<[string, Buffer]> {
  const absolute = join(root, dir);
  const files: Array<[string, Buffer]> = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push([relative(root, path), readFileSync(path)]);
    }
  };
  walk(absolute);
  return files;
}

function memoryText(root: string): string {
  return publicMemoryFiles(root).map(([path, bytes]) => `${path}\n${bytes.toString("utf8")}`).join("\n");
}

function publicMemoryFiles(root: string): Array<[string, Buffer]> {
  return filesBelow(root, ".hunch").filter(([path]) => path.endsWith(".json"));
}

function initArgs(): string[] {
  return ["init", "--no-enforce", "--no-providers", "--no-agent-hooks"];
}

test("init and durable index never publish dirty private source absent from committed HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-index-source-established-"));
  try {
    git(root, "init", "-q", "-b", "main");
    configureGit(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export function publicApp(){ return true; }\n");
    git(root, "add", "src/app.ts");
    git(root, "commit", "-qm", "fixture: committed public source");
    writeFileSync(join(root, "src/private.ts"), PRIVATE_SOURCE);

    const initialized = cli(root, ...initArgs());
    assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
    assert.match(initialized.stdout, /indexed committed HEAD/i);
    assert.doesNotMatch(memoryText(root), /PRIVATE_(?:FUNCTION|PACKAGE)_SENTINEL/);

    const before = {
      head: git(root, "rev-parse", "HEAD"),
      status: git(root, "status", "--porcelain=v1", "-z"),
      index: readFileSync(join(root, ".git/index")),
      memory: publicMemoryFiles(root),
    };
    const indexed = cli(root, "index");
    assert.notEqual(indexed.status, 0, `${indexed.stdout}${indexed.stderr}`);
    assert.match(`${indexed.stdout}${indexed.stderr}`, /dirty indexed code.*commit or stash/i);
    assert.equal(git(root, "rev-parse", "HEAD"), before.head);
    assert.equal(git(root, "status", "--porcelain=v1", "-z"), before.status);
    assert.deepEqual(readFileSync(join(root, ".git/index")), before.index);
    assert.deepEqual(publicMemoryFiles(root), before.memory, "dirty rejection occurs before any graph JSON write");

    const recorded = cli(root, "record-constraint", "public code stays reviewable", "--scope", "src/**");
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    assert.notEqual(git(root, "rev-parse", "HEAD"), before.head, "the later mutator exercises the public memory pump");
    assert.doesNotMatch(memoryText(root), /PRIVATE_(?:FUNCTION|PACKAGE)_SENTINEL/);
    assert.doesNotMatch(git(root, "log", "-p", "--all", "--", ".hunch"), /PRIVATE_(?:FUNCTION|PACKAGE)_SENTINEL/,
      "private checkout bytes never enter public Git history through a later pump");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const start of ["unborn-git", "non-git-then-git"] as const) {
  test(`init with ${start} skips checkout-derived graph before a later public mutator`, () => {
    const root = mkdtempSync(join(tmpdir(), `hunch-index-source-${start}-`));
    try {
      // Anchor findRoot at this fixture even when an unrelated ancestor temp
      // directory contains its own .hunch store.
      mkdirSync(join(root, ".hunch"));
      if (start === "unborn-git") {
        git(root, "init", "-q", "-b", "main");
        configureGit(root);
      }
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/private.ts"), PRIVATE_SOURCE);

      const initialized = cli(root, ...initArgs());
      assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
      assert.match(initialized.stdout, /skipped code graph: no committed HEAD/i);
      assert.doesNotMatch(memoryText(root), /PRIVATE_(?:FUNCTION|PACKAGE)_SENTINEL/);

      if (start === "non-git-then-git") {
        git(root, "init", "-q", "-b", "main");
        configureGit(root);
      }
      const recorded = cli(root, "record-constraint", "memory remains public-safe", "--scope", "src/**");
      assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
      assert.match(git(root, "rev-parse", "HEAD"), /^[0-9a-f]{40,64}$/);
      assert.doesNotMatch(memoryText(root), /PRIVATE_(?:FUNCTION|PACKAGE)_SENTINEL/);
      assert.doesNotMatch(git(root, "log", "-p", "--all", "--", ".hunch"), /PRIVATE_(?:FUNCTION|PACKAGE)_SENTINEL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
