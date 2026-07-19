import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInlineIntent, scanInlineIntent } from "../src/extractors/comments.js";

test("extractInlineIntent lifts tagged comments (comment-gated; ignores string literals)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cmt-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/a.ts"),
      "// hunch-why: sessions live in redis for revocation\n" +
        "export const x = 1;\n" +
        "/* hunch-rule: never call the pay-per-token API here */\n" +
        'const s = "hunch-why: this is a string, not intent";\n',
    );
    writeFileSync(join(root, "b.py"), "# hunch-rule: validate all input\nprint(1)\n");
    writeFileSync(join(root, "src/none.ts"), "export const y = 2; // ordinary comment\n");

    const got = extractInlineIntent(root);
    const keyed = got.map((i) => `${i.kind}|${i.file}|${i.line}|${i.text}`).sort();
    assert.deepEqual(keyed, [
      "rule|b.py|1|validate all input",
      "rule|src/a.ts|3|never call the pay-per-token API here",
      "why|src/a.ts|1|sessions live in redis for revocation",
    ]);
    // a string literal containing the tag (no comment marker before it) is NOT captured
    assert.ok(!got.some((i) => i.text.includes("not intent")), "string literal must not be mistaken for intent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanInlineIntent exposes incomplete discovery while the compatibility wrapper stays fail-soft", () => {
  const root = join(tmpdir(), `hunch-comments-missing-${process.pid}-${Date.now()}`);
  const scan = scanInlineIntent(root);
  assert.equal(scan.discovery.complete, false);
  assert.deepEqual(scan.intents, []);
  assert.equal(scan.discovery.diagnostics[0]?.code, "ENOENT");
  assert.deepEqual(extractInlineIntent(root), []);
});

test("Git-tracked generated directories are excluded from inline intent capture", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-comments-git-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "src/real.ts"), "// hunch-why: real source intent\n");
    writeFileSync(join(root, "dist/generated.ts"), "// hunch-rule: generated noise\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-f", "src/real.ts", "dist/generated.ts");

    const scan = scanInlineIntent(root);
    assert.equal(scan.discovery.complete, true);
    assert.equal(scan.discovery.strategy, "git");
    assert.deepEqual(scan.intents.map((intent) => intent.text), ["real source intent"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
