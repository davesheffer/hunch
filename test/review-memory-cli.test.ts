import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const cli = join(process.cwd(), "src/cli/index.ts");
test("CLI preview is read-only; apply routes a sourced rule and refuses overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-review-cli-"));
  const run = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, "review-memory", ...args], {
    cwd: root, encoding: "utf8", timeout: 30000,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
  try {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/app.git"]);
    mkdirSync(join(root, ".hunch/constraints"), { recursive: true });
    writeFileSync(join(root, ".hunch/config.json"), JSON.stringify({ autoCommit: false }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/auth.ts"), "export const auth = true;\n");
    writeFileSync(join(root, "reviews.json"), JSON.stringify([{ id: 1, path: "src/auth.ts", body: "Handle missing tenant.",
      html_url: "https://github.com/acme/app/pull/1#discussion_r1", commit_id: "a".repeat(40),
      created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z", user: { login: "alice", type: "User" } }]));
    const prepared = run("prepare", "--from", "reviews.json", "--repository", "acme/app");
    assert.equal(prepared.status, 0, prepared.stderr);
    const packet = JSON.parse(prepared.stdout);
    writeFileSync(join(root, "packet.json"), prepared.stdout);
    writeFileSync(join(root, "rules.json"), JSON.stringify([{ candidate_id: packet.candidates[0].id,
      evidence_hash: packet.candidates[0].evidence_hash, rule: "Missing tenant must fail validation.",
      check: "Send a request without a tenant and assert validation fails." }]));
    const args = ["capture", "--from", "packet.json", "--rules", "rules.json"];
    const preview = run(...args);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).applied, false);
    assert.equal(readdirSync(join(root, ".hunch/constraints")).length, 0);
    assert.notEqual(run(...args, "--apply").status, 0, "publication choice is explicit");
    const applied = run(...args, "--apply", "--public");
    assert.equal(applied.status, 0, applied.stderr);
    const files = readdirSync(join(root, ".hunch/constraints"));
    assert.equal(files.length, 1);
    const saved = readFileSync(join(root, ".hunch/constraints", files[0]!), "utf8");
    assert.equal(JSON.parse(saved).severity, "warning");
    const replay = run(...args, "--apply", "--public");
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /already exists/);
    assert.equal(readFileSync(join(root, ".hunch/constraints", files[0]!), "utf8"), saved);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
