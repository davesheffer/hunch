import { test } from "node:test";
import assert from "node:assert/strict";
import { toPosixTarget } from "../src/core/paths.js";

test("toPosixTarget canonicalizes Windows separators to POSIX", () => {
  assert.equal(toPosixTarget("src\\auth\\session.ts"), "src/auth/session.ts");
  assert.equal(toPosixTarget("src/auth/session.ts"), "src/auth/session.ts");
});

test("toPosixTarget strips a leading ./", () => {
  assert.equal(toPosixTarget("./src/x.ts"), "src/x.ts");
  assert.equal(toPosixTarget(".\\src\\x.ts"), "src/x.ts");
});

test("toPosixTarget leaves symbol names (no separators) untouched", () => {
  assert.equal(toPosixTarget("resolveInvocation"), "resolveInvocation");
  assert.equal(toPosixTarget("sym_abc123"), "sym_abc123");
});

test("toPosixTarget is idempotent (re-normalizing stored POSIX paths is a no-op)", () => {
  const once = toPosixTarget("src\\auth\\x.ts");
  assert.equal(toPosixTarget(once), once);
  assert.equal(once, "src/auth/x.ts");
});

test("normalizing a scope/related_files array yields uniform POSIX globs", () => {
  // mirrors the write-path fix in record-constraint (--scope) and hunch_record_decision
  const scope = "src\\auth\\**,lib\\util\\*.ts".split(",").map((s) => toPosixTarget(s.trim()));
  assert.deepEqual(scope, ["src/auth/**", "lib/util/*.ts"]);
});
