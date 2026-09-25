import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { cleanupDir, tempDir, writeLocalPointer } from "./fixtures.js";

const require = createRequire(import.meta.url);
const cp = require("node:child_process") as typeof import("node:child_process");

test("a nested overlay checks each distinct publication probe once and rechecks on every open", () => {
  const base = tempDir("hunch-overlay-probe-once-");
  const code = join(base, "code");
  const overlay = join(code, ".hunch-private");
  const original = cp.execFileSync;
  const savedPrivate = process.env.HUNCH_PRIVATE_DIR;
  const git = (cwd: string, ...args: string[]) => original("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
  try {
    delete process.env.HUNCH_PRIVATE_DIR;
    for (const [root, content] of [[code, "public code"], [overlay, "private memory"]]) {
      mkdirSync(root, { recursive: true });
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "Test");
      git(root, "config", "user.email", "test@example.test");
      git(root, "config", "commit.gpgsign", "false");
      writeFileSync(join(root, "README.md"), content);
      git(root, "add", "README.md");
      git(root, "commit", "-qm", content);
    }
    mkdirSync(join(code, ".hunch"));
    mkdirSync(join(overlay, ".hunch"));
    writeLocalPointer(code, { privateDir: join(overlay, ".hunch") });
    const probes: string[] = [];
    cp.execFileSync = ((command: string, args: string[], options: { cwd?: string }) => {
      if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") probes.push(options.cwd ?? "");
      return original(command, args, options);
    }) as typeof cp.execFileSync;
    syncBuiltinESMExports();

    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new HunchStore(hunchPaths(code));
      assert.equal(store.privateDir, join(overlay, ".hunch"));
      store.close();
    }
    assert.equal(probes.filter(root => root === overlay).length, 2, "one history proof per open, rather than duplicate identical proofs");

    // A pointer below the nested repo's root still has two DISTINCT probes.
    const deeper = join(overlay, "subtree");
    mkdirSync(join(deeper, ".hunch"), { recursive: true });
    writeLocalPointer(code, { privateDir: join(deeper, ".hunch") });
    probes.length = 0;
    new HunchStore(hunchPaths(code)).close();
    assert.ok(probes.includes(overlay), "the nested repository boundary is checked");
    assert.ok(probes.includes(deeper), "a different publication probe is also checked");

    // The optimization must not retain authority after the physical remote changes.
    writeLocalPointer(code, { privateDir: join(overlay, ".hunch") });
    git(overlay, "remote", "add", "origin", code);
    assert.throws(() => new HunchStore(hunchPaths(code)), /Unsafe private overlay.*publication boundary/);
  } finally {
    cp.execFileSync = original;
    syncBuiltinESMExports();
    if (savedPrivate === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = savedPrivate;
    cleanupDir(base);
  }
});
