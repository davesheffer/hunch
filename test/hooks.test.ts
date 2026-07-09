import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { installPostCommitHook } from "../src/integrations/hooks.js";

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "hunch-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: r });
  return r;
}
const hookText = (r: string): string => readFileSync(join(r, ".git", "hooks", "post-commit"), "utf8");

test("post-commit hook: default sync line carries no --private / --commit", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch");
    const h = hookText(r);
    assert.match(h, /hunch sync --from-hook --quiet >/);
    assert.doesNotMatch(h, /--private/);
    assert.doesNotMatch(h, /--commit/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: --private and --commit are emitted only when opted in", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch", { private: true, commit: true });
    assert.match(hookText(r), /sync --from-hook --quiet --private --commit >/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: local-only private sync forces deterministic synthesis", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch", { private: true, commit: true, localOnly: true });
    assert.match(hookText(r), /HUNCH_SYNTH_PROVIDER=deterministic/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: --commit without --private (regular auto-commit)", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch", { commit: true });
    const h = hookText(r);
    assert.match(h, /sync --from-hook --quiet --commit >/);
    assert.doesNotMatch(h, /--private/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("post-commit hook: re-install is idempotent (managed block replaced, not duplicated)", () => {
  const r = repo();
  try {
    installPostCommitHook(r, "hunch");
    installPostCommitHook(r, "hunch", { private: true, commit: true });
    const h = hookText(r);
    assert.equal(h.match(/>>> hunch post-commit >>>/g)?.length, 1); // single managed block
    assert.match(h, /--private --commit/);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
