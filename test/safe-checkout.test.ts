import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasUnsafeCheckoutAttributes } from "../src/constitution/safeCheckout.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function committedRepo(attributes: string): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-safe-checkout-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "safe-checkout@test.invalid");
  git(root, "config", "user.name", "Safe Checkout Test");
  writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
  writeFileSync(join(root, ".gitattributes"), attributes);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture: checkout attributes");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

test("merge-only attributes do not make immutable checkout replay unsafe", () => {
  const { root, head } = committedRepo([
    ".hunch/**/*.json merge=hunch",
    ".hunch/manifest.json merge=text",
    "",
  ].join("\n"));
  try {
    assert.equal(hasUnsafeCheckoutAttributes(root, head, process.env), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkout transforms still fail closed", () => {
  for (const attributes of ["*.ts ident\n", "*.ts text eol=lf\n", "*.ts filter=custom\n"]) {
    const { root, head } = committedRepo(attributes);
    try {
      assert.equal(hasUnsafeCheckoutAttributes(root, head, process.env), true, attributes.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
