import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strippedChildEnv } from "../src/benchmark/taskRunner.js";
import { runValidator } from "../src/benchmark/validate.js";

// Stand-in for tsx: runs the validator with plain node, dropping `--test`, and exits with its status.
const TSX_STUB = `
import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, process.argv.slice(2).filter((arg) => arg !== "--test"), { stdio: "inherit", windowsHide: true });
process.exit(result.status ?? 1);
`;
const HOME_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hunch-task-benchmark-validate-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "tsx", "dist", "cli.mjs"), TSX_STUB);
  const validators = join(dir, "validators");
  mkdirSync(validators);
  const write = (name: string, body: string) => { const file = join(validators, name); writeFileSync(file, body); return file; };
  return { dir, repo, write };
}
const env = () => strippedChildEnv(process.env, { VALIDATOR_MARKER: "kept", HOME: "/must/be/overridden" });

test("runValidator copies, hashes and runs a passing validator under an isolated home", async () => {
  const { dir, repo, write } = fixture();
  try {
    const source = write("pass.test.mjs", `console.log("ENV " + JSON.stringify({ ${HOME_KEYS.map((k) => `${k}: process.env.${k}`).join(", ")}, VALIDATOR_MARKER: process.env.VALIDATOR_MARKER }));\n`);
    const runDir = join(dir, "run-pass");
    const result = await runValidator({ repo, validatorFile: source, runDir, timeoutMs: 30_000, env: env() });
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.ok(result.validation_ms > 0);
    const copied = join(repo, "test", "pass.test.mjs");
    assert.ok(existsSync(copied));
    assert.equal(result.sha256_of_copied_file, createHash("sha256").update(readFileSync(source)).digest("hex"));

    const log = readFileSync(join(runDir, "validator.txt"), "utf8");
    const line = log.split(/\r?\n/).find((entry) => entry.startsWith("ENV "));
    assert.ok(line, `no ENV line in validator.txt: ${log}`);
    const seen = JSON.parse(line.slice(4)) as Record<string, string>;
    const home = join(runDir, "validator-home");
    for (const key of HOME_KEYS) {
      assert.ok(seen[key]?.startsWith(home), `${key}=${seen[key]} is not under ${home}`);
      assert.ok(existsSync(seen[key]!), `${key} dir was not created`);
    }
    assert.equal(seen.HOME, seen.USERPROFILE);
    assert.equal(new Set(HOME_KEYS.slice(1).map((key) => seen[key])).size, 5, "distinct dirs per variable");
    assert.equal(seen.VALIDATOR_MARKER, "kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runValidator reports a failing validator and appends its stderr", async () => {
  const { dir, repo, write } = fixture();
  try {
    const source = write("fail.test.mjs", `console.error("validator says no"); process.exit(1);\n`);
    const runDir = join(dir, "run-fail");
    const result = await runValidator({ repo, validatorFile: source, runDir, timeoutMs: 30_000, env: env() });
    assert.equal(result.exit_code, 1);
    assert.equal(result.timed_out, false);
    assert.match(readFileSync(join(runDir, "validator.txt"), "utf8"), /validator says no/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runValidator kills a hanging validator's process tree on timeout and returns promptly", async () => {
  const { dir, repo, write } = fixture();
  let hung: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const source = write("hang.test.mjs", `import { writeFileSync } from "node:fs";\nwriteFileSync("hang.pid", String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    const started = Date.now();
    const result = await runValidator({ repo, validatorFile: source, runDir: join(dir, "run-hang"), timeoutMs: 1500, env: env() });
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.ok(result.validation_ms >= 1400, `validation_ms ${result.validation_ms}`);
    assert.ok(elapsed < 15_000, `took ${elapsed}ms`);
    hung = Number(readFileSync(join(repo, "hang.pid"), "utf8"));
    assert.ok(Number.isInteger(hung) && hung > 0);
    const deadline = Date.now() + 5000;
    while (alive(hung) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    assert.equal(alive(hung), false, "validator process survived the timeout");
  } finally {
    if (hung !== undefined && alive(hung)) try { process.kill(hung); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
