import { test } from "node:test";
import assert from "node:assert/strict";
import { pathMatchesGlob } from "../src/core/glob.js";

test("** matches across directories", () => {
  assert.ok(pathMatchesGlob("src/auth/session.ts", "src/auth/**"));
  assert.ok(pathMatchesGlob("src/auth/sub/deep.ts", "src/auth/**"));
  assert.ok(!pathMatchesGlob("src/billing/charge.ts", "src/auth/**"));
});

test("bare prefix matches a directory", () => {
  assert.ok(pathMatchesGlob("src/auth/session.ts", "src/auth"));
  assert.ok(!pathMatchesGlob("src/authz/x.ts", "src/auth"));
});

test("single * stays within a path segment", () => {
  assert.ok(pathMatchesGlob("src/a.ts", "src/*.ts"));
  assert.ok(!pathMatchesGlob("src/sub/a.ts", "src/*.ts"));
});

test("exact match and ./ normalization", () => {
  assert.ok(pathMatchesGlob("./src/x.ts", "src/x.ts"));
  assert.ok(pathMatchesGlob("src/x.ts", "./src/x.ts"));
});

test("trailing /** matches the directory itself (regression #14)", () => {
  assert.ok(pathMatchesGlob("src/auth", "src/auth/**"));
  assert.ok(pathMatchesGlob("src/auth/session.ts", "src/auth/**"));
});

test("** does not match across non-separator text (regression #7)", () => {
  assert.ok(!pathMatchesGlob("src/authz/x.ts", "src/auth/**"));
});

test("middle **/ collapses to zero dirs but keeps the separator", () => {
  assert.ok(pathMatchesGlob("a/b", "a/**/b"));
  assert.ok(pathMatchesGlob("a/x/y/b", "a/**/b"));
  assert.ok(!pathMatchesGlob("ab", "a/**/b"));
});

test("backslash paths are normalized (regression #15)", () => {
  assert.ok(pathMatchesGlob("src\\auth\\session.ts", "src/auth/**"));
});

test("consecutive globstars collapse correctly (regression #3/#6)", () => {
  assert.ok(pathMatchesGlob("a/b", "a/**/**/b"));
  assert.ok(pathMatchesGlob("a/x/y/b", "a/**/**/b"));
  assert.ok(pathMatchesGlob("anything", "**/**"));
  assert.ok(pathMatchesGlob("x/y/z", "**/**"));
});
