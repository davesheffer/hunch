import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { appendRuleLog, ruleLogLimits } from "../src/core/lifecycle.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";

const cli = resolve("src/cli/index.ts");

function setup(t: { after: (f: () => void) => void }, firmness: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-")));
  t.after(() => cleanupDir(root));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "other", "b.ts"), "export const b = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const base = { rationale: "r", source_decision: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } };
  store.json.put("constraints", { id: "con_block", statement: "no touching src", severity: "blocking", scope: ["src/**"], status: "active", ...base } as never);
  store.json.put("constraints", { id: "con_warn", statement: "mind src", severity: "warning", scope: ["src/**"], status: "active", ...base } as never);
  store.json.put("constraints", { id: "con_out", statement: "other only", severity: "blocking", scope: ["other/**"], status: "active", ...base } as never);
  store.reindex();
  store.close();
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness }));
  const hook = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HUNCH_RUN_ID: "run-7" };
    delete env.HUNCH_PIPELINE;
    return execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
      cwd: root, env, encoding: "utf8",
      input: JSON.stringify({ cwd: root, session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts"), old_string: "1", new_string: "2" } }),
    }).trim();
  };
  const log = () => {
    const f = join(root, ".hunch", "local", "rule-checks.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { hook, log };
}

test("strict: a denied edit logs blocked and warned for in-scope rules only", (t) => {
  const r = setup(t, "strict");
  const out = r.hook();
  assert.match(out, /deny/);
  const lines = r.log();
  const by = Object.fromEntries(lines.map((l) => [l.rule_id as string, l]));
  assert.equal(by.con_block?.verdict, "blocked");
  assert.equal(by.con_warn?.verdict, "warned");
  assert.equal(by.con_out, undefined);
  assert.equal(by.con_block?.file, "src/a.ts");
  assert.equal(by.con_block?.tool, "Edit");
  assert.equal(by.con_block?.session_id, "sess-1");
  assert.equal(by.con_block?.run_id, "run-7");
});

test("advisory: nothing blocks, in-scope rules are logged without changing the edit", (t) => {
  const r = setup(t, "advisory");
  const out = r.hook();
  assert.doesNotMatch(out, /deny/);
  const lines = r.log();
  assert.ok(lines.length >= 2 && lines.every((l) => l.verdict !== "blocked"));
  assert.ok(lines.find((l) => l.rule_id === "con_block")?.verdict === "allowed");
});

test("appendRuleLog: a dangling symlink at the log path writes nothing outside the repo", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-sym-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-out-")));
  t.after(() => { cleanupDir(root); cleanupDir(outside); });
  mkdirSync(join(root, ".hunch", "local"), { recursive: true });
  const target = join(outside, "stolen.jsonl");
  try { symlinkSync(target, join(root, ".hunch", "local", "rule-checks.jsonl")); }
  catch { t.skip("symlink creation is not permitted on this platform"); return; }
  appendRuleLog(root, { kind: "check" });
  assert.equal(existsSync(target), false);
});

test("appendRuleLog: a symlinked .hunch/local is refused", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-dir-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-out-")));
  t.after(() => { cleanupDir(root); cleanupDir(outside); });
  mkdirSync(join(root, ".hunch"), { recursive: true });
  try { symlinkSync(outside, join(root, ".hunch", "local"), "junction"); }
  catch { t.skip("symlink creation is not permitted on this platform"); return; }
  appendRuleLog(root, { kind: "check" });
  assert.equal(existsSync(join(outside, "rule-checks.jsonl")), false);
});

test("appendRuleLog: rotates to .1 once the log reaches the cap", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-rot-")));
  t.after(() => { cleanupDir(root); ruleLogLimits.maxBytes = 4 * 1024 * 1024; });
  ruleLogLimits.maxBytes = 50;
  appendRuleLog(root, { kind: "check", n: 1, pad: "x".repeat(60) });
  appendRuleLog(root, { kind: "check", n: 2 });
  const dir = join(root, ".hunch", "local");
  assert.match(readFileSync(join(dir, "rule-checks.jsonl.1"), "utf8"), /"n":1/);
  const cur = readFileSync(join(dir, "rule-checks.jsonl"), "utf8");
  assert.match(cur, /"n":2/);
  assert.doesNotMatch(cur, /"n":1/);
  appendRuleLog(root, { kind: "check", n: 3, pad: "y".repeat(60) });
  appendRuleLog(root, { kind: "check", n: 4 });
  assert.match(readFileSync(join(dir, "rule-checks.jsonl.1"), "utf8"), /"n":2/);
  assert.doesNotMatch(readFileSync(join(dir, "rule-checks.jsonl.1"), "utf8"), /"n":1/);
});

test("strict: a denied edit is not logged allowed for any enforced rule in scope", (t) => {
  const r = setup(t, "strict");
  r.hook();
  assert.ok(r.log().every((l) => l.verdict !== "allowed"));
});

test("appendRuleLog: a directory at .1 skips rotation but keeps logging", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-rulelog-dir-")));
  t.after(() => { cleanupDir(root); ruleLogLimits.maxBytes = 4 * 1024 * 1024; });
  ruleLogLimits.maxBytes = 50;
  appendRuleLog(root, { kind: "check", n: 1, pad: "x".repeat(60) });
  const dir = join(root, ".hunch", "local");
  mkdirSync(join(dir, "rule-checks.jsonl.1"));
  appendRuleLog(root, { kind: "check", n: 2 });
  appendRuleLog(root, { kind: "check", n: 3 });
  const cur = readFileSync(join(dir, "rule-checks.jsonl"), "utf8");
  assert.match(cur, /"n":2/);
  assert.match(cur, /"n":3/);
});
