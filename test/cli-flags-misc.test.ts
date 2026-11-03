import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";

/** Black-box coverage for miscellaneous CLI flags (auto-review thresholds, the global
 *  --cli-config / --initiator binding, semantic/embedding switches, eval scoping,
 *  log paging, now --recent, context --as-of/--task and --private refusals). Each runs
 *  on a temp repo after `hunch init --no-providers`; no model or network is reached —
 *  the only "harness" is a local node script registered through --cli-config. */

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; out: string }

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, extraEnv: NodeJS.ProcessEnv, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extraEnv }, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function ok(r: Run, what: string): string {
  assert.equal(r.status, 0, `${what} must succeed:\n${r.out}`);
  return r.out;
}

function refused(r: Run, pattern: RegExp, what: string): void {
  assert.notEqual(r.status, 0, `${what} must exit non-zero:\n${r.out}`);
  assert.match(r.out, pattern, `${what} must explain the refusal`);
}

function makeRepo(label: string): Fixture {
  const sandbox = tempDir(`hunch-cli-misc-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1", CI: "1" });
  const f: Fixture = { sandbox, root, env };
  git(root, env, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "misc@example.com"], ["user.name", "Misc"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(root, env, "config", k!, v!);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: `cli-misc-${label}`, private: true, type: "module" })}\n`);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  ok(hunch(f, {}, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit"), "init");
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "chore: hunch init");
  return f;
}

function decision(id: string, title: string, over: Partial<Decision> = {}): Decision {
  return {
    id, title, topic: null, status: "accepted", context: "fixture", decision: `${title}.`,
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function seed(f: Fixture, ...records: Decision[]): void {
  const store = new HunchStore(hunchPaths(f.root));
  try {
    store.json.ensureDirs();
    for (const d of records) store.putCapture("decisions", d, false);
  } finally {
    store.close();
  }
}

/** A local stdin adapter that answers every relevance prompt with one fixed verdict. */
function judgeConfig(f: Fixture): string {
  const judge = (verdict: object) => `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(${JSON.stringify(JSON.stringify(verdict))}))`;
  const adapter = (name: string, verdict: object) => ({
    name, command: process.execPath, args: ["-e", judge(verdict)], protocol: "stdin", probe_args: ["-e", "process.exit(0)"],
  });
  const path = join(f.sandbox, "agents.json");
  writeFileSync(path, JSON.stringify([
    adapter("acme-relevant", { relevant: true, confidence: 0.9, reason: "fixture relevant" }),
    adapter("acme-lowconf", { relevant: false, confidence: 0.5, reason: "fixture irrelevant" }),
  ]));
  return path;
}

test("--cli-config and --initiator bind auto-review to a local adapter; --min-grounded and --min-reject-confidence move drafts between plan buckets", () => {
  const f = makeRepo("autoreview");
  try {
    seed(f, decision("dec_fixture_draft01", "Cache warm reads in the gateway", {
      status: "proposed",
      provenance: { source: "llm_verified", confidence: 0.6, evidence: ["synth: provider=fixture grounded=0.6"] },
    }));
    const config = judgeConfig(f);
    const live = { HUNCH_SYNTH_PROVIDER: "auto" };

    // Without the adapter file the named initiator is unavailable → no judge.
    const noConfig = ok(hunch(f, live, "--initiator", "acme-relevant", "auto-review"), "auto-review without --cli-config");
    assert.match(noConfig, /No LLM synthesis provider available/);
    // Without an initiator the adapter file alone never selects an account.
    const noInitiator = ok(hunch(f, live, "--cli-config", config, "auto-review"), "auto-review without --initiator");
    assert.match(noInitiator, /No LLM synthesis provider available/);

    // Bound: grounded 0.6 is below the default 0.7 gate → kept for a human.
    const bound = ok(hunch(f, live, "--cli-config", config, "--initiator", "acme-relevant", "auto-review"), "bound auto-review");
    assert.match(bound, /via acme-relevant/);
    assert.match(bound, /relevant but not Critic-verified\/grounded/);
    const lowered = ok(hunch(f, live, "--cli-config", config, "--initiator", "acme-relevant", "auto-review", "--min-grounded", "0.5"), "--min-grounded 0.5");
    assert.match(lowered, /verified \+ grounded 0\.6 ≥ 0\.5/);

    // A 0.5-confidence "irrelevant" verdict is kept by default, deleted under a lower bar.
    const keep = ok(hunch(f, live, "--cli-config", config, "--initiator", "acme-lowconf", "auto-review"), "low-confidence judge");
    assert.match(keep, /irrelevant but low confidence \(0\.5\)/);
    const reject = ok(hunch(f, live, "--cli-config", config, "--initiator", "acme-lowconf", "auto-review", "--min-reject-confidence", "0.4"), "--min-reject-confidence 0.4");
    assert.match(reject, /harness: not relevant \(conf 0\.5\)/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("--private on auto-review and capture-comments is refused without a private store", () => {
  const f = makeRepo("private");
  try {
    const noEnv = {};
    const before = git(f.root, f.env, "status", "--porcelain", "--untracked-files=all");
    refused(hunch(f, noEnv, "auto-review", "--private"), /--private needs HUNCH_PRIVATE_DIR/, "auto-review --private");
    refused(hunch(f, noEnv, "capture-comments", "--private"), /--private needs HUNCH_PRIVATE_DIR/, "capture-comments --private");
    assert.equal(git(f.root, f.env, "status", "--porcelain", "--untracked-files=all"), before, "refusals write nothing");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("embed --batch embeds with the stub model; query --semantic and eval --semantic switch streams; eval --kind scopes scoring", () => {
  const f = makeRepo("semantic");
  try {
    seed(f, decision("dec_fixture_pg0001", "Use PostgreSQL for durable orders"));
    const fallback = ok(hunch(f, {}, "query", "--semantic", "PostgreSQL"), "query --semantic without a model");
    assert.match(fallback, /semantic search isn't enabled yet/);
    assert.doesNotMatch(ok(hunch(f, {}, "query", "PostgreSQL"), "plain query"), /semantic/);

    const stub = { HUNCH_EMBEDDER: "stub" };
    assert.match(ok(hunch(f, stub, "embed", "--batch", "2"), "embed --batch 2"), /✓ embedded \d+ doc/);
    assert.match(ok(hunch(f, stub, "query", "--semantic", "PostgreSQL"), "query --semantic"), /\(semantic \+ keyword\)/);

    const golden = join(f.sandbox, "golden.json");
    writeFileSync(golden, JSON.stringify([{ query: "PostgreSQL durable orders", expected: ["dec_fixture_pg0001"] }]));
    const plain = ok(hunch(f, stub, "eval", "--file", golden), "eval");
    assert.match(plain, /\(FTS \+ graph\)/);
    assert.match(plain, /graph OFF\s+100\.0%/);
    assert.match(ok(hunch(f, stub, "eval", "--file", golden, "--semantic"), "eval --semantic"), /\(semantic \+ graph \+ FTS\)/);
    const scoped = ok(hunch(f, stub, "eval", "--file", golden, "--kind", "runbooks"), "eval --kind runbooks");
    assert.match(scoped, /graph OFF\s+0\.0%/, "a decision is never scored inside the runbooks kind");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("eval --grounding scores the prompt hook's delivery over the live store and names each miss", () => {
  const f = makeRepo("grounding");
  try {
    seed(f, decision("dec_fixture_pg0001", "Use PostgreSQL for durable orders"));
    const golden = join(f.sandbox, "grounding.json");
    writeFileSync(golden, JSON.stringify([
      { name: "orders store", prompt: "store the durable orders in PostgreSQL", eligible: ["dec_fixture_pg0001"], allowed: [] },
      { name: "needs a missing record", prompt: "rotate the signing keys", eligible: ["dec_fixture_absent"], allowed: "any" },
    ]));
    const out = ok(hunch(f, {}, "eval", "--grounding", "--file", golden), "eval --grounding");
    assert.match(out, /Grounding eval over 2 case\(s\)/);
    assert.match(out, /PRECISION\s+100\.0%\s+over 1 judged case/);
    assert.match(out, /RECALL\s+50\.0%\s+over 2 case/);
    assert.match(out, /needs a missing record — missed dec_fixture_absent/);
    assert.doesNotMatch(out, /orders store —/, "a case that delivered exactly its eligible record is not listed");

    writeFileSync(golden, JSON.stringify([{ name: "x", prompt: "y", eligible: [], extra: 1 }]));
    refused(hunch(f, {}, "eval", "--grounding", "--file", golden), /grounding eval: invalid grounding case/, "an unknown case field");
    refused(hunch(f, {}, "eval", "--grounding"), /needs --file/, "eval --grounding without a golden set");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("log --limit pages memory moves and log --diff prints one move's .hunch diff; now --recent caps the recent list", () => {
  const f = makeRepo("log");
  try {
    seed(f, decision("dec_fixture_log001", "First recorded choice", { date: "2026-01-01T00:00:00.000Z" }));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "hunch: capture first");
    seed(f, decision("dec_fixture_log002", "Second recorded choice", { date: "2026-01-02T00:00:00.000Z" }),
      decision("dec_fixture_log003", "Third recorded choice", { date: "2026-01-03T00:00:00.000Z" }));
    git(f.root, f.env, "add", "-A");
    git(f.root, f.env, "commit", "-qm", "hunch: capture more");

    const all = JSON.parse(ok(hunch(f, {}, "log", "--json"), "log --json")) as unknown[];
    assert.ok(all.length >= 2, `expected several memory moves, got ${all.length}`);
    const one = JSON.parse(ok(hunch(f, {}, "log", "--json", "--limit", "1"), "log --limit 1")) as unknown[];
    assert.equal(one.length, 1);

    const head = git(f.root, f.env, "rev-parse", "HEAD");
    const diff = ok(hunch(f, {}, "log", "--diff", head), "log --diff");
    assert.match(diff, /dec_fixture_log003/);
    assert.doesNotMatch(diff, /dec_fixture_log001\.json/);

    assert.match(ok(hunch(f, {}, "now"), "now"), /Recent \(3\)/);
    const capped = ok(hunch(f, {}, "now", "--recent", "1"), "now --recent 1");
    assert.match(capped, /Recent \(1\)/);
    assert.match(capped, /Third recorded choice/);
    assert.doesNotMatch(capped, /First recorded choice/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("context --as-of refuses an unresolvable ref; context --task records the delivery as task evidence", () => {
  const f = makeRepo("context");
  try {
    seed(f, decision("dec_fixture_ctx001", "Keep package.json private", { related_files: ["package.json"] }));
    refused(hunch(f, {}, "context", "package.json", "--as-of", "no-such-ref-xyz"), /could not resolve --as-of "no-such-ref-xyz"/, "context --as-of bogus");
    assert.match(ok(hunch(f, {}, "context", "package.json", "--as-of", "HEAD"), "context --as-of HEAD"), /.+/);
    const plain = ok(hunch(f, {}, "context", "package.json"), "context");
    assert.doesNotMatch(plain, /Task evidence/);
    const tracked = ok(hunch(f, {}, "context", "package.json", "--task", "tsk_fixture01"), "context --task");
    assert.match(tracked, /Task evidence: tsk_fixture01 · occurrence \d+|Task evidence could not be recorded for tsk_fixture01/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("landscape adopt --candidate is refused together with --all, and --all/--candidate absence is refused", () => {
  const f = makeRepo("landscape");
  try {
    refused(hunch(f, {}, "landscape", "adopt", "--expected", "abc", "--reviewed-by", "tester", "--all", "--candidate", "deadbeef"),
      /choose either --all or --candidate, not both/, "landscape adopt --all --candidate");
    refused(hunch(f, {}, "landscape", "adopt", "--expected", "abc", "--reviewed-by", "tester"),
      /choose --all or name reviewed hashes with --candidate/, "landscape adopt without a selection");
  } finally {
    cleanupDir(f.sandbox);
  }
});
