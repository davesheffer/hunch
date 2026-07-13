import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hunchPaths, findRoot } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { syncCommit } from "../src/synthesis/synthesize.js";
import { decisionId } from "../src/core/ids.js";
import { headSha, revParse } from "../src/extractors/git.js";

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
  rmSync(root, { recursive: true, force: true });
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
  rmSync(root, { recursive: true, force: true });
});

test("MCP short-sha resolves to the same decision id as auto-sync's full sha (regression R3 #2/#3)", () => {
  const root = gitRepo();
  const full = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  assert.notEqual(full, short, "short and full sha differ");
  // auto-sync keys on the full sha; the MCP path resolves the short sha a human
  // passes back (revParse) to the full sha → SAME id → upgrade, not duplicate.
  assert.equal(decisionId(revParse(short, root)), decisionId(full), "short sha → same id as full");
  rmSync(root, { recursive: true, force: true });
});

test("revParse trims whitespace and never fakes a full sha for an unresolvable ref (regression R4 #2/#3)", () => {
  const root = gitRepo();
  const full = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  assert.equal(revParse(`  ${short}  `, root), full, "trims surrounding whitespace and resolves");
  const bogus = revParse("not-a-real-ref", root);
  assert.ok(!/^[0-9a-f]{40}$/.test(bogus), "unresolvable ref does not masquerade as a full sha");
  rmSync(root, { recursive: true, force: true });
});

test("findRoot ignores a .hunch regular FILE and keeps walking (regression #18)", () => {
  const parent = mkdtempSync(join(tmpdir(), "hunch-root-"));
  mkdirSync(join(parent, ".hunch")); // a real hunch dir at the parent
  const child = join(parent, "child");
  mkdirSync(child);
  writeFileSync(join(child, ".hunch"), "i am a file, not a dir"); // decoy file
  // from child, the file .hunch must NOT count — root resolves to the parent dir
  assert.equal(findRoot(child), parent);
  rmSync(parent, { recursive: true, force: true });
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
  rmSync(parent, { recursive: true, force: true });
});

test("post-commit code change captures a decision linked to the changed file", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add b"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "written");
  assert.ok(r.decision!.related_files.includes("src/a.ts"));
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("syncCommit does not skip a SKIP_SUBJECT commit whose body is substantive (regression #4)", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();

  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "commit",
      "-m",
      "Merge branch 'feature' into main",
      "-m",
      "Adds OAuth2 login support with JWT tokens, replacing the old session-cookie flow.",
    ],
    { cwd: root, stdio: "ignore" },
  );

  const r = await syncCommit(store, root);
  assert.equal(r.status, "written", `expected written, got skipped: ${r.reason}`);
  assert.ok(r.decision, "decision was recorded despite the merge-prefixed subject");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("syncCommit still skips a SKIP_SUBJECT commit with an empty body (no regression #4)", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();

  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Merge branch 'main' into feature"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "skipped");
  assert.match(r.reason!, /trivial subject/);
  assert.equal(store.json.loadAll("decisions").length, 0, "no decision recorded for a trivial merge commit");

  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("syncCommit skips a chore(deps) commit with an empty body (regex fix, regression #4)", async () => {
  const root = gitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();

  appendFileSync(join(root, "src/a.ts"), "export function b(){ return 2; }\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["commit", "-m", "chore(deps): bump lodash from 4.1.0 to 4.2.0"],
    { cwd: root, stdio: "ignore" },
  );

  const r = await syncCommit(store, root);
  assert.equal(r.status, "skipped", `expected skipped, got written: ${JSON.stringify(r.decision?.title)}`);
  assert.match(r.reason!, /trivial subject/);
  assert.equal(store.json.loadAll("decisions").length, 0, "no decision recorded for a trivial chore(deps) commit");

  store.close();
  rmSync(root, { recursive: true, force: true });
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

test("syncCommit synthesizes a decision from a Python commit (regression: was 'no code files changed')", async () => {
  const root = pythonGitRepo();
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();

  // second commit with enough structural delta to be significant: a new function
  // definition is itself a structural-delta signal per Task 6's DECL_PATTERNS fix.
  writeFileSync(
    join(root, "src/a.py"),
    "def a():\n    return 1\n\ndef b(x):\n    return a() + x\n",
  );
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add b"], { cwd: root, stdio: "ignore" });

  const r = await syncCommit(store, root);
  assert.equal(r.status, "written", `expected written, got skipped: ${r.reason}`);
  assert.ok(r.decision, "decision was recorded");

  store.close();
  rmSync(root, { recursive: true, force: true });
});
