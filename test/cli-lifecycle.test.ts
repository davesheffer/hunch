import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, personTokenEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint } from "../src/core/types.js";

/** Black-box coverage for the rule lifecycle commands: rules, rule show, challenge, replace, review --confirm, remove. */

interface Run { status: number | null; out: string; stdout: string; stderr: string }
interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hunch(f: Fixture, extra: NodeJS.ProcessEnv, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extra }, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function ok(r: Run, what: string): Run { assert.equal(r.status, 0, `${what} must succeed:\n${r.out}`); return r; }

function con(id: string, extra: Record<string, unknown> = {}): Constraint {
  return {
    id, type: "architecture", statement: `rule ${id}`, scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
    match: null, forbids: null, rationale: "because", source_decision: null, violations: [], status: "active",
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
    provenance: { source: "agent_recorded", confidence: 0.8, evidence: [] }, ...extra,
  } as Constraint;
}

function makeRepo(): Fixture {
  const sandbox = tempDir("hunch-cli-lifecycle-");
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", ...personTokenEnv(join(sandbox, "person-home")), HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1", CI: "1" });
  const f: Fixture = { sandbox, root, env };
  git(root, env, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "l@example.com"], ["user.name", "L"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(root, env, "config", k!, v!);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "cli-lifecycle", private: true, type: "module" })}\n`);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  ok(hunch(f, {}, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit"), "init");
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "chore: hunch init");
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    for (const c of [con("con_act"), con("con_dra", { status: "draft" }), con("con_new")]) store.json.put("constraints", c);
    store.reindex();
  } finally { store.close(); }
  return f;
}

function rules(f: Fixture, ...extra: string[]): Array<Record<string, any>> {
  return JSON.parse(ok(hunch(f, {}, "rules", "--json", ...extra), "rules").stdout);
}

test("rules, rule show, challenge, clear, replace, confirm and remove drive the lifecycle", () => {
  const f = makeRepo();
  const none = {};
  try {
    assert.deepEqual(rules(f, "--status", "draft").map((r) => r.id), ["con_dra"]);
    assert.equal(rules(f).length, 3);
    assert.match(ok(hunch(f, none, "rules"), "table").stdout, /con_act/);

    ok(hunch(f, { HUNCH_RUN_ID: "run_42" }, "challenge", "con_act", "--reason", "looks wrong"), "challenge");
    const ch = rules(f, "--status", "challenged");
    assert.deepEqual(ch.map((r) => r.id), ["con_act"]);
    assert.equal(ch[0]!.challenge.by_run, "run_42");
    const detail = JSON.parse(ok(hunch(f, none, "rule", "show", "con_act", "--json"), "show").stdout);
    assert.equal(detail.challenge.reason, "looks wrong");

    ok(hunch(f, {}, "challenge", "clear", "con_act", "--reason", "fine"), "clear");
    assert.equal(rules(f, "--status", "challenged").length, 0);

    ok(hunch(f, {}, "review", "--confirm", "con_dra"), "confirm draft");
    assert.equal(rules(f).find((r) => r.id === "con_dra")!.status, "active");

    ok(hunch(f, {}, "replace", "con_act", "--with", "con_new", "--reason", "newer"), "replace");
    assert.equal(rules(f, "--status", "retired").map((r) => r.id).join(), "con_act");

    // remove retires a draft rule
    const store = new HunchStore(hunchPaths(f.root));
    try { store.json.put("constraints", con("con_d2", { status: "draft" })); store.reindex(); } finally { store.close(); }
    ok(hunch(f, {}, "remove", "con_d2", "--reason", "nope"), "remove draft");
    assert.ok(rules(f, "--status", "retired").some((r) => r.id === "con_d2"));

    const bad = hunch(f, {}, "challenge", "con_missing", "--reason", "x");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /error:/);
  } finally { cleanupDir(f.sandbox); }
});

function statusOf(f: Fixture, id: string): string {
  return rules(f).find((r) => r.id === id)!.status;
}

test("remove then restore never promotes a draft; a human active rule returns active", () => {
  const f = makeRepo();
  try {
    const store = new HunchStore(hunchPaths(f.root));
    try {
      store.json.put("constraints", con("con_rd", { status: "draft" }));
      store.json.put("constraints", con("con_rh", { provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }));
      store.reindex();
    } finally { store.close(); }
    ok(hunch(f, {}, "remove", "con_rd", "--reason", "x"), "remove draft");
    assert.equal(statusOf(f, "con_rd"), "retired");
    ok(hunch(f, {}, "restore", "con_rd"), "restore draft");
    assert.equal(statusOf(f, "con_rd"), "draft");

    ok(hunch(f, {}, "remove", "con_rh", "--reason", "x"), "remove human");
    ok(hunch(f, {}, "restore", "con_rh"), "restore human");
    assert.equal(statusOf(f, "con_rh"), "active");
  } finally { cleanupDir(f.sandbox); }
});

test("a blocking draft does not fail check --strict; the same rule active does", () => {
  const f = makeRepo();
  try {
    const blocking = { severity: "blocking", scope: ["src/**"], provenance: { source: "human_confirmed", confidence: 1, evidence: [] } };
    const store = new HunchStore(hunchPaths(f.root));
    try {
      store.json.put("constraints", con("con_bd", { ...blocking, status: "draft" }));
      store.reindex();
    } finally { store.close(); }
    mkdirSync(join(f.root, "src"), { recursive: true });
    writeFileSync(join(f.root, "src", "a.ts"), "export const a = 1;\n");
    git(f.root, f.env, "add", "-A");
    const draft = hunch(f, {}, "check", "--strict");
    assert.equal(draft.status, 0, draft.out);

    ok(hunch(f, {}, "review", "--confirm", "con_bd"), "confirm");
    const active = hunch(f, {}, "check", "--strict");
    assert.notEqual(active.status, 0, active.out);
  } finally { cleanupDir(f.sandbox); }
});

test("CLI challenge and challenge clear append log lines", () => {
  const f = makeRepo();
  try {
    ok(hunch(f, {}, "challenge", "con_act", "--reason", "odd"), "challenge");
    ok(hunch(f, {}, "challenge", "clear", "con_act", "--reason", "fine"), "clear");
    const lines = readFileSync(join(f.root, ".hunch", "local", "rule-checks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.kind), ["challenge", "challenge_clear"]);
    assert.equal(lines[0].rule_id, "con_act");
  } finally { cleanupDir(f.sandbox); }
});
