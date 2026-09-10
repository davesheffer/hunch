import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerAutomaticReviewMemory, readReviewCode } from "../src/cli/automaticReviewMemory.js";
import { DeterministicProvider } from "../src/synthesis/provider.js";
import { ConstraintSchema, type Constraint } from "../src/core/types.js";

test("auto CLI saves without rules.json, replays, previews and detects context changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-auto-review-"));
  let existing: Constraint[] = [];
  let calls = 0;
  let change: "none" | "code" | "memory" = "none";
  const code = "export function auth(tenant) { if (!tenant) throw new Error('missing tenant'); }";
  const out = join(root, "report.json");
  const input = join(root, "comments.json");
  const provider = Object.assign(new DeterministicProvider(), { draftProse: async () => {
    calls++;
    if (calls % 2) return JSON.stringify({ action: "accept", reason: "The current implementation requires a tenant.",
      rule: "Missing tenant must fail validation.", check: "Pass no tenant and assert the function throws.",
      comment_id: 1, review_quote: "Missing tenant must fail validation.", code_quote: "if (!tenant) throw new Error('missing tenant');" });
    if (change === "code") writeFileSync(join(root, "src/auth.ts"), "export const auth = null;");
    if (change === "memory") existing = [{ ...saved[0]!, id: "con_other", statement: "New constraint during analysis." }];
    return JSON.stringify({ supported: true, reusable: true, current: true, checkable: true, no_conflict: true,
      reason: "The review and current implementation support this check." });
  } });
  let saved: Constraint[] = [];
  const run = async (...args: string[]) => {
    const command = new Command();
    registerAutomaticReviewMemory(command,
      () => ({ root, existing: [...existing] }),
      (records, repository, privateOnly) => {
        assert.equal(repository, "acme/app");
        assert.equal(privateOnly, false);
        records.forEach(r => ConstraintSchema.parse(r));
        existing.push(...records);
        saved = records;
      }, async () => provider);
    await command.parseAsync(["auto", "--repository", "acme/app", "--from", input, "--output", out, ...args], { from: "user" });
    return JSON.parse(readFileSync(out, "utf8"));
  };
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/auth.ts"), code);
    execFileSync("git", ["-C", root, "add", "src/auth.ts"]);
    writeFileSync(input, JSON.stringify([{ id: 1, path: "src/auth.ts", body: "Missing tenant must fail validation.",
      html_url: "https://github.com/acme/app/pull/1#discussion_r1", commit_id: "a".repeat(40),
      created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z", user: { login: "alice", type: "User" } }]));
    await assert.rejects(run(), /exactly one/);
    const preview = await run("--dry-run");
    assert.equal(preview.entries[0].status, "ready");
    assert.equal(saved.length, 0);
    const report = await run("--public");
    assert.equal(report.entries[0].status, "saved");
    assert.equal(saved.length, 1);
    const before = calls;
    assert.equal((await run("--public")).entries[0].status, "skipped");
    assert.equal(calls, before);
    for (const modification of ["code", "memory"] as const) {
      existing = [];
      writeFileSync(join(root, "src/auth.ts"), code);
      change = modification;
      const report = await run("--public");
      assert.equal(report.rules.length, 0);
      assert.equal(report.entries[0].status, "review");
      assert.match(report.entries[0].reason, /changed during analysis/);
    }
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    rmSync(root, { recursive: true, force: true });
  }
});

test("file reader refuses untracked files and escaping directory links", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-auto-path-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-auto-outside-"));
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    writeFileSync(join(root, "untracked.ts"), "untracked code");
    assert.throws(() => readReviewCode(root, "untracked.ts"));
    writeFileSync(join(outside, "outside.ts"), "outside code");
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => readReviewCode(root, "escape/outside.ts"), /escapes checkout/);
  } finally {
    for (const dir of [root, outside]) {
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
