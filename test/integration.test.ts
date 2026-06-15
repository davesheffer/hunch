import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { brainPaths, findRoot } from "../src/core/paths.js";
import { BrainStore } from "../src/store/brainStore.js";
import { syncCommit } from "../src/synthesis/synthesize.js";
import { decisionId } from "../src/core/ids.js";
import { headSha, revParse } from "../src/extractors/git.js";

process.env.BRAIN_SYNTH_PROVIDER = "deterministic";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-int-"));
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
  const store = new BrainStore(brainPaths(root));
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
  const store = new BrainStore(brainPaths(root));
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

test("findRoot ignores a .brain regular FILE and keeps walking (regression #18)", () => {
  const parent = mkdtempSync(join(tmpdir(), "brain-root-"));
  mkdirSync(join(parent, ".brain")); // a real brain dir at the parent
  const child = join(parent, "child");
  mkdirSync(child);
  writeFileSync(join(child, ".brain"), "i am a file, not a dir"); // decoy file
  // from child, the file .brain must NOT count — root resolves to the parent dir
  assert.equal(findRoot(child), parent);
  rmSync(parent, { recursive: true, force: true });
});

test("post-commit code change captures a decision linked to the changed file", async () => {
  const root = gitRepo();
  const store = new BrainStore(brainPaths(root));
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
