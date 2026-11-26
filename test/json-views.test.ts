import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint } from "../src/core/types.js";

/** `--json` on review and why, through the real CLI. */
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
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1", CI: "1" });
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
    for (const c of [con("con_ac0001"), con("con_d00001", { status: "draft" }), con("con_e00001")]) store.json.put("constraints", c);
    store.reindex();
  } finally { store.close(); }
  return f;
}

test("review --json and why --json emit rule entries with displayState", () => {
  const f = makeRepo();
  try {
    ok(hunch(f, {}, "challenge", "con_ac0001", "--reason", "looks wrong"), "challenge");
    const rv = JSON.parse(ok(hunch(f, {}, "review", "--json"), "review").stdout);
    for (const k of ["imported", "ready", "scrutiny", "rules"]) assert.ok(Array.isArray(rv[k]), k);
    assert.deepEqual(rv.rules.map((r: any) => [r.id, r.displayState]), [["con_d00001", "draft"]]);
    const w = JSON.parse(ok(hunch(f, {}, "why", "src/x.ts", "--json"), "why").stdout);
    const byId = Object.fromEntries(w.constraints.map((c: any) => [c.id, c.displayState]));
    assert.equal(byId.con_ac0001, "challenged");
    assert.equal(byId.con_d00001, "draft");
    const one = JSON.parse(ok(hunch(f, {}, "why", "con_ac0001", "--json"), "why id").stdout);
    assert.equal(one.displayState, "challenged");
    assert.match(ok(hunch(f, {}, "why", "src/x.ts"), "text").stdout, /^Why "src\/x.ts"/);
  } finally { cleanupDir(f.sandbox); }
});
