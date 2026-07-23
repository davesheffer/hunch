import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInlineIntent } from "../src/extractors/comments.js";
import { decisionId } from "../src/core/ids.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");

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

test("extractInlineIntent never follows a tracked source symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cmt-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hunch-cmt-symlink-outside-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const outsideFile = join(outside, "secret.ts");
    writeFileSync(outsideFile, "// hunch-rule: external secret must never be captured\n");
    symlinkSync(outsideFile, join(root, "src/linked.ts"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "src/linked.ts"], { cwd: root });

    assert.deepEqual(extractInlineIntent(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("capture-comments never copies a same-id private decision into the public home", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cmt-home-root-"));
  const overlayRoot = mkdtempSync(join(tmpdir(), "hunch-cmt-home-overlay-"));
  const privateRoot = join(overlayRoot, ".hunch");
  const text = "sessions live in redis for revocation";
  const id = decisionId(`inline:src/a.ts:${text}`);
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "comments@test.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Comments Test"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), `// hunch-why: ${text}\nexport const x = 1;\n`);
    writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch/local.json\n");
    execFileSync("git", ["add", "src/a.ts", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture: inline intent"], { cwd: root });

    mkdirSync(privateRoot, { recursive: true });
    const bootstrap = new HunchStore(hunchPaths(root));
    bootstrap.json.ensureDirs();
    bootstrap.close();
    writeFileSync(join(root, ".hunch/local.json"), `${JSON.stringify({
      privateDir: privateRoot,
      autoCommit: false,
      mode: "private",
    })}\n`);
    const privateDecision: Decision = {
      id,
      title: text,
      topic: "PRIVATE_TOPIC_SENTINEL",
      status: "accepted",
      context: "PRIVATE_CONTEXT_SENTINEL",
      decision: text,
      consequences: [],
      alternatives_rejected: [],
      rejected_tripwires: [],
      related_components: [],
      related_files: ["src/a.ts"],
      supersedes: null,
      superseded_by: null,
      caused_by_bug: null,
      commit: null,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: null,
      retired: { symbols: [], deps: [] },
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["private"] },
      date: "2026-01-01T00:00:00.000Z",
    };
    const configured = new HunchStore(hunchPaths(root));
    configured.putPrivate("decisions", privateDecision);
    configured.close();
    const privateBefore = readFileSync(join(privateRoot, "decisions", `${id}.json`), "utf8");

    const run = spawnSync(process.execPath, [TSX, CLI, "capture-comments"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.notEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(`${run.stdout}\n${run.stderr}`, /refusing to create a public\/private id collision/i);
    assert.equal(existsSync(join(root, ".hunch/decisions", `${id}.json`)), false,
      "a public twin is never created for an existing private id");
    assert.equal(readFileSync(join(privateRoot, "decisions", `${id}.json`), "utf8"), privateBefore,
      "the exact private record remains byte-identical");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(overlayRoot, { recursive: true, force: true });
  }
});
