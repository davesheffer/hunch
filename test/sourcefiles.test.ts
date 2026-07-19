import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceFiles } from "../src/extractors/sourceFiles.js";

const TS_EXTS = [".ts", ".tsx"];
const SKIP = new Set(["node_modules", "dist"]);

test("discoverSourceFiles recursively finds source files in stable order", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-"));
  try {
    mkdirSync(join(root, "src/deep"), { recursive: true });
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(root, ".cache"), { recursive: true });
    writeFileSync(join(root, "z.ts"), "export const z = 1;\n");
    writeFileSync(join(root, "src/a.tsx"), "export const A = () => null;\n");
    writeFileSync(join(root, "src/deep/b.ts"), "export const b = 1;\n");
    writeFileSync(join(root, "src/readme.md"), "not code\n");
    writeFileSync(join(root, "node_modules/pkg/vendor.ts"), "export const vendor = 1;\n");
    writeFileSync(join(root, ".cache/hidden.ts"), "export const hidden = 1;\n");

    const result = discoverSourceFiles(root, {
      extensions: TS_EXTS,
      skipDirs: SKIP,
      skipHiddenDirs: true,
    });
    assert.equal(result.complete, true);
    assert.equal(result.strategy, "filesystem");
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.files, ["src/a.tsx", "src/deep/b.ts", "z.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverSourceFiles applies directory exclusions to Git-tracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-git-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src/real.ts"), "export const real = 1;\n");
    writeFileSync(join(root, "dist/generated.ts"), "export const generated = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-f", "-A");

    const result = discoverSourceFiles(root, {
      extensions: TS_EXTS,
      skipDirs: SKIP,
    });
    assert.equal(result.complete, true);
    assert.equal(result.strategy, "git");
    assert.deepEqual(result.files, ["src/real.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverSourceFiles bounds only the recursive fallback depth", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-depth-"));
  try {
    mkdirSync(join(root, "one/two"), { recursive: true });
    writeFileSync(join(root, "root.ts"), "export const root = 1;\n");
    writeFileSync(join(root, "one/child.ts"), "export const child = 1;\n");
    writeFileSync(join(root, "one/two/deep.ts"), "export const deep = 1;\n");

    assert.deepEqual(discoverSourceFiles(root, {
      extensions: TS_EXTS,
      walkMaxDepth: 1,
    }).files, ["one/child.ts", "root.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing roots are incomplete scans, never valid empty repositories", () => {
  const root = join(tmpdir(), `hunch-files-missing-${process.pid}-${Date.now()}`);
  const result = discoverSourceFiles(root, { extensions: TS_EXTS });

  assert.equal(result.complete, false);
  assert.equal(result.strategy, "filesystem");
  assert.deepEqual(result.files, []);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(
    { path: result.diagnostics[0]!.path, operation: result.diagnostics[0]!.operation, code: result.diagnostics[0]!.code },
    { path: ".", operation: "read-directory", code: "ENOENT" },
  );
});

test("a valid repository with no matching source files is complete", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-empty-"));
  try {
    writeFileSync(join(root, "README.md"), "nothing to index\n");
    const result = discoverSourceFiles(root, { extensions: TS_EXTS });
    assert.equal(result.complete, true);
    assert.equal(result.strategy, "filesystem");
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested read failure returns partial files plus a visible incomplete diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-partial-"));
  try {
    mkdirSync(join(root, "blocked"));
    mkdirSync(join(root, "readable"));
    writeFileSync(join(root, "blocked/lost.ts"), "export const lost = 1;\n");
    writeFileSync(join(root, "readable/kept.ts"), "export const kept = 1;\n");

    const result = discoverSourceFiles(root, { extensions: TS_EXTS }, {
      readDirectory: (dir) => {
        if (dir === join(root, "blocked")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return readdirSync(dir, { withFileTypes: true });
      },
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.files, ["readable/kept.ts"]);
    assert.deepEqual(
      result.diagnostics.map(({ path, operation, code }) => ({ path, operation, code })),
      [{ path: "blocked", operation: "read-directory", code: "EACCES" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Git-list failure can fall back for diagnostics but remains incomplete", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-git-failure-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    const result = discoverSourceFiles(root, { extensions: TS_EXTS }, {
      isGitRepository: () => true,
      listTrackedFiles: () => { throw Object.assign(new Error("git unavailable"), { code: "GIT_FAILED" }); },
    });

    assert.equal(result.strategy, "filesystem");
    assert.equal(result.complete, false);
    assert.deepEqual(result.files, ["src/a.ts"]);
    assert.deepEqual(
      result.diagnostics.map(({ path, operation, code }) => ({ path, operation, code })),
      [{ path: ".", operation: "git-list", code: "GIT_FAILED" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fallback after all tracked code is excluded still applies the same directory policy", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-git-authority-"));
  try {
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "dist/generated.ts"), "export const generated = 1;\n");
    writeFileSync(join(root, "src/untracked.ts"), "export const untracked = 1;\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-f", "dist/generated.ts");

    const result = discoverSourceFiles(root, { extensions: TS_EXTS, skipDirs: SKIP });
    assert.equal(result.complete, true);
    assert.equal(result.strategy, "filesystem");
    assert.deepEqual(result.files, ["src/untracked.ts"]);

    const filesystem = discoverSourceFiles(root, { extensions: TS_EXTS, skipDirs: SKIP, preferGit: false });
    assert.equal(filesystem.strategy, "filesystem");
    assert.deepEqual(filesystem.files, ["src/untracked.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid depth limits are rejected instead of silently producing partial scans", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-depth-invalid-"));
  try {
    assert.throws(() => discoverSourceFiles(root, { extensions: TS_EXTS, walkMaxDepth: -1 }), /non-negative integer/i);
    assert.throws(() => discoverSourceFiles(root, { extensions: TS_EXTS, walkMaxDepth: 1.5 }), /non-negative integer/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem discovery ignores symlinks and cannot recurse through a cycle", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-files-symlink-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "outside.ts"), "export const outside = 1;\n");
    symlinkSync(join(root, "outside.ts"), join(root, "src/linked.ts"));
    symlinkSync(root, join(root, "src/cycle"));

    const result = discoverSourceFiles(join(root, "src"), { extensions: TS_EXTS });
    assert.equal(result.complete, true);
    assert.deepEqual(result.files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
