import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hunchPaths, findRoot } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { syncCommit } from "../src/synthesis/synthesize.js";
import { withInitiator } from "../src/synthesis/initiator.js";
import { decisionId } from "../src/core/ids.js";
import { headSha, revParse } from "../src/extractors/git.js";
import { __resetAvailabilityCacheForTests } from "../src/synthesis/provider.js";

process.env.HUNCH_SYNTH_PROVIDER = "deterministic";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-int-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  g("init");
  g("config", "user.email", "t@t.co");
  g("config", "user.name", "t");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export function a(){ return 1; }\n");
  g("add", "-A");
  g("commit", "-m", "feat: add a");
  return root;
}

test("syncCommit early-exits on re-sync (token-thrift) and --force re-drafts in place (regression #5)", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();

  const first = await syncCommit(store, root);
  assert.equal(first.status, "written");
  const id = first.decision!.id;

  // re-run on the same HEAD: early-exit (no wasted synthesis), existing record
  // surfaced, still exactly one decision
  const second = await syncCommit(store, root);
  assert.equal(second.status, "skipped");
  assert.match(second.reason!, /already captured/);
  assert.equal(second.decision!.id, id, "surfaces the existing commit-keyed decision");
  assert.equal(store.json.loadAll("decisions").length, 1, "no duplicate decision");

  // --force re-synthesizes the same commit in place: same id, still one record
  const forced = await syncCommit(store, root, undefined, { force: true });
  assert.equal(forced.status, "written");
  assert.equal(forced.decision!.id, id);
  assert.equal(store.json.loadAll("decisions").length, 1, "force updates in place, never duplicates");

  store.close();
  cleanupDir(root);
});

test("auto-sync uses commit-keyed id and never clobbers a human-confirmed decision (regression #5)", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const sha = headSha(root);

  // 1) auto-sync drafts a low-confidence decision keyed by the commit sha
  const auto = await syncCommit(store, root);
  assert.equal(auto.decision!.id, decisionId(sha));

  // 2) a human records a decision for the SAME commit (MCP path uses the same
  //    commit-keyed id) -> it UPGRADES the same record, not a duplicate
  store.json.put("decisions", { ...auto.decision!, status: "accepted", decision: "Human-authored rationale", provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] } } as never);
  assert.equal(store.json.loadAll("decisions").length, 1);

  // 3) a later auto-sync of the same commit must NOT overwrite the human content
  const again = await syncCommit(store, root);
  assert.equal(again.status, "skipped");
  const kept = store.json.get("decisions", decisionId(sha))!;
  assert.equal(kept.provenance.source, "human_confirmed");
  assert.equal(kept.decision, "Human-authored rationale");

  store.close();
  cleanupDir(root);
});

test("MCP short-sha resolves to the same decision id as auto-sync's full sha (regression R3 #2/#3)", () => {
  const root = gitRepo();
  const full = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  assert.notEqual(full, short, "short and full sha differ");
  // auto-sync keys on the full sha; the MCP path resolves the short sha a human
  // passes back (revParse) to the full sha → SAME id → upgrade, not duplicate.
  assert.equal(decisionId(revParse(short, root)), decisionId(full), "short sha → same id as full");
  cleanupDir(root);
});

test("revParse trims whitespace and never fakes a full sha for an unresolvable ref (regression R4 #2/#3)", () => {
  const root = gitRepo();
  const full = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  assert.equal(revParse(`  ${short}  `, root), full, "trims surrounding whitespace and resolves");
  const bogus = revParse("not-a-real-ref", root);
  assert.ok(!/^[0-9a-f]{40}$/.test(bogus), "unresolvable ref does not masquerade as a full sha");
  cleanupDir(root);
});

test("findRoot ignores a .hunch regular FILE and keeps walking (regression #18)", () => {
  const parent = mkdtempSync(join(tmpdir(), "hunch-root-"));
  mkdirSync(join(parent, ".hunch")); // a real hunch dir at the parent
  const child = join(parent, "child");
  mkdirSync(child);
  writeFileSync(join(child, ".hunch"), "i am a file, not a dir"); // decoy file
  // from child, the file .hunch must NOT count — root resolves to the parent dir
  assert.equal(findRoot(child), parent);
  cleanupDir(parent);
});

test("findRoot stops at the .git boundary — an ancestor .hunch never hijacks a fresh repo", () => {
  const parent = mkdtempSync(join(tmpdir(), "hunch-root-"));
  mkdirSync(join(parent, ".hunch")); // stray .hunch above the repo (the ~/.hunch shape)
  const repo = join(parent, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true }); // fresh repo, no .hunch yet
  assert.equal(findRoot(repo), repo); // the repo boundary wins over the ancestor .hunch
  const sub = join(repo, "src");
  mkdirSync(sub);
  assert.equal(findRoot(sub), repo); // and from a subdir of the repo
  cleanupDir(parent);
});

test("post-commit code change captures a decision linked to the changed file", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  // Stage only src/a.ts: `-A` would sweep in the .hunch/ manifest ensureDirs() wrote and trip the .hunch/** guard.
  execFileSync("git", ["add", "src/a.ts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add b"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "written");
  assert.ok(r.decision!.related_files.includes("src/a.ts"));
  store.close();
  cleanupDir(root);
});

test("syncCommit does not skip a SKIP_SUBJECT commit whose body is substantive", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function login(){ return 'jwt'; }\n");
  execFileSync("git", ["add", "src/a.ts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Merge branch 'feature' into main", "-m", "Adds OAuth2/JWT login, replacing the session cookies so that API clients can authenticate statelessly."], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "written", r.reason);
  assert.ok(r.decision, "a decision exists");
  store.close();
  cleanupDir(root);
});

test("syncCommit still skips a SKIP_SUBJECT commit with an empty body", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function merged(){ return 3; }\n");
  execFileSync("git", ["add", "-A", "src"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Merge branch 'main' into feature"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "skipped");
  assert.match(r.reason!, /trivial subject/);
  assert.equal(store.json.loadAll("decisions").length, 0);
  store.close();
  cleanupDir(root);
});

test("syncCommit skips a dependency-bump commit with an empty body", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function bumped(){ return 4; }\n");
  execFileSync("git", ["add", "-A", "src"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore(deps): bump lodash from 4.1.0 to 4.2.0"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "skipped", r.decision?.title);
  assert.match(r.reason!, /trivial subject/);
  assert.equal(store.json.loadAll("decisions").length, 0);
  store.close();
  cleanupDir(root);
});

function pythonGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-int-py-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  g("init");
  g("config", "user.email", "t@t.co");
  g("config", "user.name", "t");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.py"), "def a():\n    return 1\n");
  g("add", "-A");
  g("commit", "-m", "feat: add a");
  return root;
}

test("a Python commit synthesizes a decision", async () => {
  const root = pythonGitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  writeFileSync(join(root, "src/a.py"), "def a():\n    return 1\n\n\ndef b(x):\n    return a() + x\n");
  execFileSync("git", ["add", "src/a.py"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add b"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "written", r.reason);
  assert.ok(r.decision, "a decision exists");
  store.close();
  cleanupDir(root);
});

function markdownGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-int-md-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  g("init");
  g("config", "user.email", "t@t.co");
  g("config", "user.name", "t");
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-use-postgres.md"), [
    "# 1. Use Postgres",
    "",
    "## Decision",
    "We will use Postgres as the primary datastore.",
    "",
    "## Why",
    "Transactional guarantees, mature tooling and JSONB support.",
    "",
    "## Rejected",
    "MySQL: weaker JSON support and fewer extensions for our needs.",
    "",
  ].join("\n"));
  g("add", "-A");
  g("commit", "-m", "docs: add ADR 0001 use postgres");
  return root;
}

test("a markdown-only commit synthesizes a decision", async () => {
  const root = markdownGitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const r = await syncCommit(store, root);
  assert.equal(r.status, "written", r.reason);
  assert.ok(r.decision, "a decision exists");
  assert.deepEqual(r.decision!.related_files, ["docs/adr/0001-use-postgres.md"]);
  store.close();
  cleanupDir(root);
});

test("the deterministic fallback describes a markdown-only edit as content, not code", async () => {
  const root = markdownGitRepo();
  appendFileSync(join(root, "docs/adr/0001-use-postgres.md"), "\n## Revisited\nWe revisited this and still prefer Postgres for its extension ecosystem.\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "docs: revisit ADR 0001"], { cwd: root, stdio: "ignore" });
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const r = await syncCommit(store, root);
  assert.equal(r.status, "written", r.reason);
  assert.doesNotMatch(r.decision!.decision, /\bcode\b/i);
  store.close();
  cleanupDir(root);
});

test("a commit touching .hunch/** is skipped even though it also touches markdown", async () => {
  const root = gitRepo();
  mkdirSync(join(root, ".hunch/decisions"), { recursive: true });
  writeFileSync(join(root, ".hunch/decisions/dec_abc123.json"), JSON.stringify({ id: "dec_abc123" }) + "\n");
  writeFileSync(join(root, "AGENTS.md"), "# Agents\nregenerated\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Claude\nregenerated\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  // A non-"hunch:" subject proves the guard is structural, not subject-based.
  execFileSync("git", ["commit", "-m", "chore: sync memory"], { cwd: root, stdio: "ignore" });
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const r = await syncCommit(store, root);
  assert.equal(r.status, "skipped");
  assert.match(r.reason!, /\.hunch\/\*\*/);
  store.close();
  cleanupDir(root);
});

test("an SVG-only commit is skipped", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-int-svg-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  g("init");
  g("config", "user.email", "t@t.co");
  g("config", "user.name", "t");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  g("add", "-A");
  g("commit", "-m", "feat: add logo");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const r = await syncCommit(store, root);
  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "no code or markdown files changed");
  store.close();
  cleanupDir(root);
});

test("syncCommit drafts via an openai-compat endpoint end to end", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  // Stage only src/a.ts: `-A` would sweep in the .hunch/ manifest and trip the .hunch/** guard.
  execFileSync("git", ["add", "src/a.ts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add b"], { cwd: root, stdio: "ignore" });
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Add b()",
              context: "a.ts needed a second helper",
              decision: "Added function b to a.ts",
              consequences: [],
              alternatives_rejected: [],
              nontrivial: true,
            }),
          },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const savedProvider = process.env.HUNCH_SYNTH_PROVIDER;
  process.env.HUNCH_SYNTH_PROVIDER = "openai-compat";
  process.env.HUNCH_SYNTH_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.HUNCH_SYNTH_MODEL = "test-model";
  __resetAvailabilityCacheForTests();
  try {
    const r = await withInitiator(
      { provider: "openai-compat", source: "explicit" },
      () => syncCommit(store, root),
    );
    assert.equal(r.status, "written");
    assert.equal(r.provider, "openai-compat", "backfill's via-LLM count keys off this");
    assert.equal(r.decision!.decision, "Added function b to a.ts");
  } finally {
    process.env.HUNCH_SYNTH_PROVIDER = savedProvider ?? "deterministic";
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    __resetAvailabilityCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    cleanupDir(root);
  }
});

test("syncCommit reports the deterministic fallback when the endpoint fails", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  // Stage only src/a.ts: `-A` would sweep in the .hunch/ manifest and trip the .hunch/** guard.
  execFileSync("git", ["add", "src/a.ts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add b"], { cwd: root, stdio: "ignore" });
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const savedProvider = process.env.HUNCH_SYNTH_PROVIDER;
  process.env.HUNCH_SYNTH_PROVIDER = "openai-compat";
  process.env.HUNCH_SYNTH_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.HUNCH_SYNTH_MODEL = "test-model";
  __resetAvailabilityCacheForTests();
  try {
    const r = await withInitiator(
      { provider: "openai-compat", source: "explicit" },
      () => syncCommit(store, root),
    );
    assert.equal(r.status, "written");
    assert.equal(r.provider, "deterministic", "the ACTUAL fallback provider, not the selected one");
    assert.equal(r.decision!.provenance.source, "inferred");
  } finally {
    process.env.HUNCH_SYNTH_PROVIDER = savedProvider ?? "deterministic";
    delete process.env.HUNCH_SYNTH_BASE_URL;
    delete process.env.HUNCH_SYNTH_MODEL;
    __resetAvailabilityCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    cleanupDir(root);
  }
});
