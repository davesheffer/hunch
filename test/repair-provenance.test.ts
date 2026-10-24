import { randomUUID } from "node:crypto";
import { cleanupDir } from "./fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Decision } from "../src/core/types.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { commitRepairReviewHash } from "../src/core/commitrepair.js";
import { readActivePendingRepairs, withheldRewrites } from "../src/core/repairqueue.js";
import { ensureGitignore } from "../src/integrations/gitignore.js";
import { commitPatchIds, commitRepairStatus, commitRepairStatusAgainst } from "../src/extractors/git.js";
const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(projectRoot, "src", "cli", "index.ts");
const FAKE = "0123456789abcdef0123456789abcdef01234567";
const FAKE2 = "fedcba9876543210fedcba9876543210fedcba98";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function runCliRaw(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    encoding: "utf8",
  });
}

/** Simulate reviewing the existing queue for the older action-path tests. */
function runCli(root: string, ...args: string[]) {
  if (args[0] === "repair-provenance" && (args.includes("--apply") || args.includes("--drop")) && !args.includes("--expect")) {
    // Explicit scan-and-apply fixtures now follow the required two-step flow.
    const rangeIndex = args.indexOf("--range");
    if (rangeIndex >= 0) {
      const preview = runCliRaw(root, "repair-provenance", "--range", args[rangeIndex + 1]!, "--quiet");
      if (preview.status !== 0) return preview;
    }
    const queued = readActivePendingRepairs(root);
    args.push("--expect", commitRepairReviewHash(queued, withheldRewrites(root, queued)));
  }
  return runCliRaw(root, ...args);
}

/** A complete, accepted decision citing `commit` and scoped to `file`. */
function fullDecision(id: string, commit: string, file: string): Decision {
  return {
    id, title: `title ${id}`, topic: null, status: "accepted", context: "", decision: "d.", consequences: [],
    alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [file],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit,
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${commit}`], last_verified: "2026-01-01T00:00:00.000Z" },
    date: "2026-01-01T00:00:00.000Z",
  } as Decision;
}

/** Store the decisions, reindex, and commit them. */
function storeDecisions(root: string, decisions: Decision[]): void {
  const store = new HunchStore(hunchPaths(root));
  for (const d of decisions) store.json.put("decisions", d);
  store.reindex();
  store.close();
  git(root, "add", "-A");
  git(root, "commit", "-qm", "hunch: record decisions");
}

/**
 * Simulates a real squash-merge: a decision cites a commit on `feature`, then
 * `main` lands the identical change as a NEW commit (same patch-id) that does
 * not have the original as an ancestor.
 */
function squashFixture(): { root: string; decisionFile: string; oldRef: string; newRef: string; origCommit: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair-squash-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/base.ts"), "export const base = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "src/feature.ts"), "export const feature = 1;\n");
  git(root, "add", "src/feature.ts");
  git(root, "commit", "-qm", "feat: feature");
  const origCommit = git(root, "rev-parse", "HEAD");
  const decision = fullDecision("dec_squash_fixture", origCommit, "src/feature.ts");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "src/unrelated.ts"), "export const unrelated = 1;\n");
  git(root, "add", "src/unrelated.ts");
  git(root, "commit", "-qm", "unrelated change");
  const origHead = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/feature.ts"), "export const feature = 1;\n");
  git(root, "add", "src/feature.ts");
  git(root, "commit", "-qm", "feat: feature (#1)");
  const newHead = git(root, "rev-parse", "HEAD");
  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", decision);
  store.reindex();
  store.close();
  const decisionFile = join(root, ".hunch", "decisions", "dec_squash_fixture.json");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "hunch: record decision");
  return { root, decisionFile, oldRef: origHead, newRef: newHead, origCommit, cleanup: () => cleanupDir(root) };
}

function queueFile(root: string): string {
  return join(root, ".hunch", "pending-commit-repairs.json");
}

function readQueue(root: string): Array<{ id: string; from: string; to: string }> {
  return JSON.parse(readFileSync(queueFile(root), "utf8"));
}

function writeQueue(root: string, entries: Array<{ id: string; from: string; to: string }>): void {
  writeFileSync(queueFile(root), JSON.stringify(entries, null, 2) + "\n");
}

function droppedFile(root: string): string {
  return join(root, ".hunch", "dropped-commit-repairs.json");
}

function readDropped(root: string): Array<{ id: string; from: string; to: string }> {
  return JSON.parse(readFileSync(droppedFile(root), "utf8"));
}

function cliEnv(): Record<string, string> {
  return { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" } as Record<string, string>;
}

const readDecision = (file: string): Decision => JSON.parse(readFileSync(file, "utf8")) as Decision;
const lastSubject = (root: string): string => git(root, "log", "-1", "--format=%s");

test("repair-provenance --range --apply repairs the commit and evidence, commits, and clears the queue", () => {
  const f = squashFixture();
  try {
    const run = runCli(f.root, "repair-provenance", "--range", `${f.oldRef}..${f.newRef}`, "--apply");
    assert.equal(run.status, 0, run.stderr);
    const short = git(f.root, "rev-parse", "--short", f.newRef);
    const d = readDecision(f.decisionFile);
    assert.equal(d.commit, short);
    assert.deepEqual(d.provenance.evidence, [`commit:${short}`]);
    assert.ok(lastSubject(f.root).startsWith("hunch: repair 1 commit reference(s) after squash-merge"), lastSubject(f.root));
    assert.deepEqual(readQueue(f.root), []);
  } finally { f.cleanup(); }
});

test("repair-provenance --range dry run reports, queues, and changes no decision", () => {
  const f = squashFixture();
  try {
    const before = readFileSync(f.decisionFile, "utf8");
    const run = runCli(f.root, "repair-provenance", "--range", `${f.oldRef}..${f.newRef}`);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Would repair 1 commit reference/);
    assert.equal(readFileSync(f.decisionFile, "utf8"), before);
    const q = readQueue(f.root);
    assert.equal(q.length, 1);
    assert.equal(q[0]!.id, "dec_squash_fixture");
  } finally { f.cleanup(); }
});

test("fresh detection replaces only the first duplicate-id queue entry", () => {
  const f = squashFixture();
  try {
    const stale1 = { id: "dec_squash_fixture", from: f.origCommit, to: "sha_stale_1" };
    const stale2 = { id: "dec_squash_fixture", from: f.origCommit, to: "sha_stale_2" };
    writeQueue(f.root, [stale1, stale2]);
    const run = runCli(f.root, "repair-provenance", "--range", `${f.oldRef}..${f.newRef}`, "--quiet");
    assert.equal(run.status, 0, run.stderr);
    const q = readQueue(f.root);
    assert.equal(q.length, 2);
    assert.equal(q[0]!.to, git(f.root, "rev-parse", "--short", f.newRef));
    assert.deepEqual(q[1], stale2);
  } finally { f.cleanup(); }
});

test("--from-hook queues the match silently and never auto-commits", () => {
  const f = squashFixture();
  try {
    const before = readFileSync(f.decisionFile, "utf8");
    git(f.root, "update-ref", "ORIG_HEAD", f.oldRef);
    const run = runCli(f.root, "repair-provenance", "--from-hook", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "");
    assert.equal(readFileSync(f.decisionFile, "utf8"), before);
    assert.equal(git(f.root, "status", "--porcelain"), "");
    const q = readQueue(f.root);
    assert.equal(q.length, 1);
    assert.equal(q[0]!.id, "dec_squash_fixture");
    assert.equal(q[0]!.to, git(f.root, "rev-parse", "--short", f.newRef));
  } finally { f.cleanup(); }
});

test("the queue outlives the range: a later --apply works without ORIG_HEAD", () => {
  const f = squashFixture();
  try {
    git(f.root, "update-ref", "ORIG_HEAD", f.oldRef);
    assert.equal(runCli(f.root, "repair-provenance", "--from-hook", "--quiet").status, 0);
    git(f.root, "update-ref", "-d", "ORIG_HEAD");
    const run = runCli(f.root, "repair-provenance", "--quiet", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readDecision(f.decisionFile).commit, git(f.root, "rev-parse", "--short", f.newRef));
    assert.deepEqual(readQueue(f.root), []);
  } finally { f.cleanup(); }
});

test("escalations --json surfaces a hook-queued match as commit-repair-pending", () => {
  const f = squashFixture();
  try {
    git(f.root, "update-ref", "ORIG_HEAD", f.oldRef);
    assert.equal(runCli(f.root, "repair-provenance", "--from-hook", "--quiet").status, 0);
    const run = runCli(f.root, "escalations", "--json");
    assert.equal(run.status, 1, run.stderr);
    const items = JSON.parse(run.stdout) as Array<{ kind: string; decisionIds: string[] }>;
    const item = items.find((e) => e.kind === "commit-repair-pending");
    assert.ok(item, run.stdout);
    assert.deepEqual(item.decisionIds, ["dec_squash_fixture"]);
  } finally { f.cleanup(); }
});

test("a withheld entry is worded as unresolvable and never advertises --apply --only", () => {
  const f = squashFixture();
  try {
    writeQueue(f.root, [{ id: "dec_squash_fixture", from: f.origCommit, to: FAKE }]);
    const run = runCli(f.root, "escalations", "--json");
    assert.equal(run.status, 1, run.stderr);
    const item = (JSON.parse(run.stdout) as Array<{ kind: string; question: string; resolution: string }>)
      .find((e) => e.kind === "commit-repair-pending");
    assert.ok(item, run.stdout);
    assert.match(item.question, /doesn't resolve in this repository/);
    assert.doesNotMatch(item.resolution, /--apply --only dec_squash_fixture to accept/);
    assert.match(item.resolution, /--drop dec_squash_fixture/);
  } finally { f.cleanup(); }
});

/** Two decisions whose queued targets are real commits, so they resolve by default. */
function twoDecisionFixture(): { root: string; decisionFile: (id: string) => string; shaANew: string; shaBNew: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair-two-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/base.ts"), "1\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  writeFileSync(join(root, "src/dec_a.ts"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "add a");
  const shaANew = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/dec_b.ts"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "add b");
  const shaBNew = git(root, "rev-parse", "HEAD");
  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", fullDecision("dec_a", "sha_a_old", "src/dec_a.ts"));
  store.json.put("decisions", fullDecision("dec_b", "sha_b_old", "src/dec_b.ts"));
  store.reindex();
  store.close();
  git(root, "add", ".hunch");
  git(root, "commit", "-qm", "hunch: record decisions");
  writeQueue(root, [
    { id: "dec_a", from: "sha_a_old", to: shaANew },
    { id: "dec_b", from: "sha_b_old", to: shaBNew },
  ]);
  return {
    root,
    decisionFile: (id: string) => join(root, ".hunch", "decisions", `${id}.json`),
    shaANew,
    shaBNew,
    cleanup: () => cleanupDir(root),
  };
}

const qids = (root: string): string[] => readQueue(root).map((q) => q.id);
const out = (run: { stdout: string; stderr: string }): string => run.stdout + run.stderr;

/** Rewrite dec_a so its commit has "moved on". */
function moveOn(f: { decisionFile: (id: string) => string }, id = "dec_a"): void {
  const d = readDecision(f.decisionFile(id));
  writeFileSync(f.decisionFile(id), JSON.stringify({ ...d, commit: "sha_a_moved_on" }, null, 2) + "\n");
}

/** Hide a decision from this run by deleting its file. */
function hide(f: { decisionFile: (id: string) => string }, id = "dec_a"): void {
  rmSync(f.decisionFile(id));
}

type EscItem = { kind: string; detail: string; question: string; resolution: string; actionable?: boolean };

test("--drop tombstones one decision's entry without touching decisions or HEAD", () => {
  const f = twoDecisionFixture();
  try {
    const head = git(f.root, "rev-parse", "HEAD");
    const run = runCli(f.root, "repair-provenance", "--drop", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(qids(f.root), ["dec_b"]);
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
    assert.equal(readDecision(f.decisionFile("dec_b")).commit, "sha_b_old");
    assert.equal(git(f.root, "rev-parse", "HEAD"), head);
  } finally { f.cleanup(); }
});

test("--drop wins over --apply for the dropped id, and duplicate triples tombstone once", () => {
  const f = twoDecisionFixture();
  try {
    const entry = { id: "dec_a", from: "sha_a_old", to: f.shaANew };
    writeQueue(f.root, [entry, { ...entry }]);
    const run = runCli(f.root, "repair-provenance", "--drop", "dec_a", "--apply", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
    assert.deepEqual(readQueue(f.root), []);
    assert.deepEqual(readDropped(f.root), [entry]);
  } finally { f.cleanup(); }
});

test("--drop tombstones only the first matching entry for a duplicate id", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
      { id: "dec_a", from: "sha_a_old", to: f.shaBNew },
      { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
    ]);
    const run = runCli(f.root, "repair-provenance", "--drop", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readQueue(f.root), [
      { id: "dec_a", from: "sha_a_old", to: f.shaBNew },
      { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
    ]);
    assert.deepEqual(readDropped(f.root), [{ id: "dec_a", from: "sha_a_old", to: f.shaANew }]);
  } finally { f.cleanup(); }
});

test("escalations point --apply --only at the resolvable entry even when a withheld one is queued first", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: FAKE },
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
    ]);
    const run = runCli(f.root, "escalations", "--json");
    assert.equal(run.status, 1, run.stderr);
    const items = JSON.parse(run.stdout) as EscItem[];
    const forResolvable = items.find((e) => e.detail === `sha_a_old → ${f.shaANew}`);
    assert.ok(forResolvable, run.stdout);
    assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "escalations says --apply --only works for the resolvable entry, despite it not being first-queued");
    const apply = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a", "--quiet");
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, f.shaANew);
  } finally { f.cleanup(); }
});

test("escalations do not claim --drop rejects the resolvable entry when it targets the withheld one", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: FAKE },
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
      { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
    ]);
    const run = runCli(f.root, "escalations", "--json");
    const items = JSON.parse(run.stdout) as EscItem[];
    const forResolvable = items.find((e) => e.detail === `sha_a_old → ${f.shaANew}`);
    assert.ok(forResolvable, run.stdout);
    assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "escalations must not claim --drop dec_a rejects the resolvable entry — it targets the withheld one instead");
    const drop = runCli(f.root, "repair-provenance", "--drop", "dec_a", "--quiet");
    assert.equal(drop.status, 0, drop.stderr);
    assert.deepEqual(readDropped(f.root), [{ id: "dec_a", from: "sha_a_old", to: FAKE }]);
    assert.deepEqual(readQueue(f.root).map((q) => q.to), [f.shaANew, f.shaBNew]);
  } finally { f.cleanup(); }
});

/** Connect an MCP client to `hunch mcp` in `root`, call a no-argument tool, and return its text. */
async function mcpText(root: string, tool: string): Promise<string> {
  const client = new Client({ name: "repair-provenance-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: root, env: cliEnv() });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: tool, arguments: {} });
    return (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

/** Queue dec_a -> shaANew then dec_a -> shaBNew: the second is a context-only follower. */
function duplicateIdQueue(f: { root: string; shaANew: string; shaBNew: string }): void {
  writeQueue(f.root, [
    { id: "dec_a", from: "sha_a_old", to: f.shaANew },
    { id: "dec_a", from: "sha_a_old", to: f.shaBNew },
  ]);
}

test("escalations --json marks the duplicate-id follower as not actionable", () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const run = runCli(f.root, "escalations", "--json");
    assert.equal(run.status, 1, run.stderr);
    const items = JSON.parse(run.stdout) as EscItem[];
    const lead = items.find((e) => e.detail.endsWith(`→ ${f.shaANew}`));
    const follower = items.find((e) => e.detail.endsWith(`→ ${f.shaBNew}`));
    assert.ok(lead && follower, run.stdout);
    assert.notEqual(lead.actionable, false);
    assert.equal(follower.actionable, false);
  } finally { f.cleanup(); }
});

test("escalations text counts the lead entry and shows the follower for context only", () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const run = runCli(f.root, "escalations");
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /^1 decision\(s\) need your call — asked here, never decided for you \(\+1 shown below for context only, not gating\):/m);
    assert.ok(run.stdout.includes(`sha_a_old → ${f.shaANew}`), run.stdout);
    assert.ok(run.stdout.includes(`sha_a_old → ${f.shaBNew}`), run.stdout);
  } finally { f.cleanup(); }
});

test("MCP hunch_now asks once for a duplicate-id queue", async () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const text = await mcpText(f.root, "hunch_now");
    assert.ok(text.includes("⚖ 1 decision(s) need the human's call"), text);
    assert.ok(text.includes("no longer reachable from HEAD"), text);
    assert.ok(!text.includes("further queued replacement candidate"), text);
  } finally { f.cleanup(); }
});

test("MCP hunch_escalations counts the lead and shows the follower for context only", async () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const text = await mcpText(f.root, "hunch_escalations");
    assert.match(text, /^1 decision\(s\) need the human's call — ask each inline, don't decide it for them \(\+1 shown below for context only, not a decision\):/m);
    assert.ok(text.includes(`sha_a_old → ${f.shaANew}`), text);
    assert.ok(text.includes(`sha_a_old → ${f.shaBNew}`), text);
  } finally { f.cleanup(); }
});

test("a drop survives re-detection", () => {
  const f = squashFixture();
  try {
    const range = `${f.oldRef}..${f.newRef}`;
    assert.equal(runCli(f.root, "repair-provenance", "--range", range, "--quiet").status, 0);
    const matchedTo = readQueue(f.root)[0]!.to;
    assert.equal(runCli(f.root, "repair-provenance", "--drop", "dec_squash_fixture", "--quiet").status, 0);
    assert.deepEqual(readQueue(f.root), []);
    assert.equal(runCli(f.root, "repair-provenance", "--range", range, "--quiet").status, 0);
    assert.deepEqual(readQueue(f.root), []);
    assert.deepEqual(readDropped(f.root), [{ id: "dec_squash_fixture", from: f.origCommit, to: matchedTo }]);
  } finally { f.cleanup(); }
});

test("a sweep without fresh detection removes tombstoned entries from the queue", () => {
  const f = twoDecisionFixture();
  try {
    writeFileSync(droppedFile(f.root), JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: f.shaANew }]));
    const run = runCli(f.root, "repair-provenance", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(qids(f.root), ["dec_b"]);
  } finally { f.cleanup(); }
});

test("the sweep is announced when not quiet", () => {
  const f = twoDecisionFixture();
  try {
    writeFileSync(droppedFile(f.root), JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: f.shaANew }]));
    const run = runCli(f.root, "repair-provenance");
    assert.ok(run.stdout.includes("Swept 1 already-rejected match from the queue: dec_a"), out(run));
  } finally { f.cleanup(); }
});

test("--apply --only on an already-rejected id says there is nothing left to do", () => {
  const f = twoDecisionFixture();
  try {
    writeFileSync(droppedFile(f.root), JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: f.shaANew }]));
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('"dec_a" was already rejected via --drop — nothing left to do.'), out(run));
    assert.equal(readDecision(f.decisionFile("dec_b")).commit, "sha_b_old");
  } finally { f.cleanup(); }
});

test("escalations --json omits a tombstoned entry but still lists the other", () => {
  const f = twoDecisionFixture();
  try {
    writeFileSync(droppedFile(f.root), JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: f.shaANew }]));
    const run = runCli(f.root, "escalations", "--json");
    const items = run.stdout.trim() ? (JSON.parse(run.stdout) as EscItem[]) : [];
    const pending = items.filter((e) => e.kind === "commit-repair-pending");
    assert.ok(!pending.some((e) => JSON.stringify(e).includes("dec_a")), run.stdout);
    assert.ok(pending.some((e) => JSON.stringify(e).includes("dec_b")), "positive control: dec_b is still pending");
  } finally { f.cleanup(); }
});

test("MCP hunch_escalations omits a tombstoned entry", async () => {
  const f = twoDecisionFixture();
  try {
    writeFileSync(droppedFile(f.root), JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: f.shaANew }]));
    const text = await mcpText(f.root, "hunch_escalations");
    assert.ok(!text.includes("dec_a"), text);
    assert.ok(text.includes("dec_b"), text);
  } finally { f.cleanup(); }
});

test("MCP hunch_now uses withheld wording for an unresolvable target", async () => {
  const f = squashFixture();
  try {
    writeQueue(f.root, [{ id: "dec_squash_fixture", from: f.origCommit, to: FAKE }]);
    const text = await mcpText(f.root, "hunch_now");
    assert.ok(text.includes("doesn't resolve in this repository"), text);
    assert.ok(!text.includes("--apply --only dec_squash_fixture to accept"), text);
  } finally { f.cleanup(); }
});

test("MCP hunch_escalations uses withheld wording for an unresolvable target", async () => {
  const f = squashFixture();
  try {
    writeQueue(f.root, [{ id: "dec_squash_fixture", from: f.origCommit, to: FAKE }]);
    const text = await mcpText(f.root, "hunch_escalations");
    assert.ok(text.includes("doesn't resolve in this repository"), text);
    assert.ok(!text.includes("--apply --only dec_squash_fixture to accept"), text);
  } finally { f.cleanup(); }
});

test("--drop of an unknown id succeeds and writes no tombstone file", () => {
  const f = twoDecisionFixture();
  try {
    const run = runCli(f.root, "repair-provenance", "--drop", "dec_nonexistent", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(droppedFile(f.root)), false);
  } finally { f.cleanup(); }
});

test("--apply --only repairs just the named decision and leaves the rest queued", () => {
  const f = twoDecisionFixture();
  try {
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_b", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
    assert.equal(readDecision(f.decisionFile("dec_b")).commit, f.shaBNew);
    assert.deepEqual(qids(f.root), ["dec_a"]);
    assert.ok(lastSubject(f.root).startsWith("hunch: repair 1 commit reference(s)"), lastSubject(f.root));
  } finally { f.cleanup(); }
});

test("a dead entry is pruned when another decision is applied", () => {
  const f = twoDecisionFixture();
  try {
    moveOn(f);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_b", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readQueue(f.root), []);
  } finally { f.cleanup(); }
});

test("--apply --only a decision pruned earlier in the run says so", () => {
  const f = twoDecisionFixture();
  try {
    moveOn(f);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('"dec_a" was pruned earlier in this run'), out(run));
  } finally { f.cleanup(); }
});

test("a decision with no commit on record is reported", () => {
  const f = twoDecisionFixture();
  try {
    const d = readDecision(f.decisionFile("dec_a"));
    writeFileSync(f.decisionFile("dec_a"), JSON.stringify({ ...d, commit: null }, null, 2) + "\n");
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_b");
    assert.ok(run.stdout.includes("no commit on record"), out(run));
  } finally { f.cleanup(); }
});

test("pruning is announced when not quiet", () => {
  const f = twoDecisionFixture();
  try {
    moveOn(f);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_b");
    assert.match(run.stdout, /Pruned 1 dead queue entry.*dec_a/);
  } finally { f.cleanup(); }
});

test("pruning a stale duplicate-id entry does not block applying the live sibling", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_STALE", to: f.shaBNew },
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
      { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
    ]);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes("Repaired 1 commit reference"), out(run));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, f.shaANew);
    assert.deepEqual(qids(f.root), ["dec_b"]);
  } finally { f.cleanup(); }
});

test("a malformed --range is rejected without touching the queue", () => {
  const f = twoDecisionFixture();
  try {
    moveOn(f);
    const before = readFileSync(queueFile(f.root), "utf8");
    const run = runCli(f.root, "repair-provenance", "--range", "garbage");
    assert.notEqual(run.status, 0);
    assert.ok(out(run).includes("--range must look like"), out(run));
    assert.equal(readFileSync(queueFile(f.root), "utf8"), before);
  } finally { f.cleanup(); }
});

test("an entry whose decision is not visible is kept when another id is applied", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    runCli(f.root, "repair-provenance", "--apply", "--only", "dec_b", "--quiet");
    assert.deepEqual(qids(f.root), ["dec_a"]);
  } finally { f.cleanup(); }
});

test("a bulk --apply keeps invisible entries queued", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    runCli(f.root, "repair-provenance", "--apply", "--quiet");
    assert.equal(readDecision(f.decisionFile("dec_b")).commit, f.shaBNew);
    assert.deepEqual(qids(f.root), ["dec_a"]);
  } finally { f.cleanup(); }
});

test("--apply --only an invisible id quietly keeps both entries queued", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a", "--quiet");
    assert.deepEqual(qids(f.root).sort(), ["dec_a", "dec_b"]);
  } finally { f.cleanup(); }
});

test("--apply --only an invisible id explains that it is not visible, not that it moved on", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.ok(run.stdout.includes("are visible this run"), out(run));
    assert.ok(!run.stdout.includes("already moved on"), out(run));
    assert.ok(run.stdout.includes("--drop <dec_id>"), out(run));
  } finally { f.cleanup(); }
});

test("a bulk --apply with every decision hidden names both", () => {
  const f = twoDecisionFixture();
  try {
    hide(f, "dec_a");
    hide(f, "dec_b");
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(run.stdout.includes("are visible this run"), out(run));
    assert.match(run.stdout, /dec_a[\s\S]*dec_b|dec_b[\s\S]*dec_a/);
    assert.ok(run.stdout.includes("--drop <dec_id>"), out(run));
  } finally { f.cleanup(); }
});

test("a dry run marks the invisible entry", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    const run = runCli(f.root, "repair-provenance");
    assert.ok(run.stdout.includes("Would repair 1 of 2 listed"), out(run));
    assert.match(run.stdout, /dec_a.*not visible this run/);
    assert.doesNotMatch(run.stdout, /dec_b.*not visible this run/);
  } finally { f.cleanup(); }
});

test("a bulk --apply reports the invisible entry it left queued", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(run.stdout.includes("Repaired 1 commit reference"), out(run));
    assert.ok(run.stdout.includes("not visible this run, left queued: dec_a"), out(run));
    assert.ok(run.stdout.includes("--drop <dec_id>"), out(run));
  } finally { f.cleanup(); }
});

test("--apply --only an id with no queued or matched entry fails", () => {
  const f = twoDecisionFixture();
  try {
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_missing");
    assert.notEqual(run.status, 0);
    assert.ok(out(run).includes('no queued or matched entry for "dec_missing"'), out(run));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
  } finally { f.cleanup(); }
});

function withheldAQueue(f: { root: string; shaBNew: string }): void {
  writeQueue(f.root, [
    { id: "dec_a", from: "sha_a_old", to: FAKE },
    { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
  ]);
}

test("--apply --only a withheld id leaves everything queued", () => {
  const f = twoDecisionFixture();
  try {
    withheldAQueue(f);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
    assert.deepEqual(qids(f.root), ["dec_a", "dec_b"]);
  } finally { f.cleanup(); }
});

test("--apply --only a withheld id explains the unresolvable target", () => {
  const f = twoDecisionFixture();
  try {
    withheldAQueue(f);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.ok(run.stdout.includes("doesn't resolve in this repository"), out(run));
    assert.ok(!run.stdout.includes("are visible this run"), out(run));
  } finally { f.cleanup(); }
});

test("a bulk --apply applies the resolvable entry and reports the withheld one", () => {
  const f = twoDecisionFixture();
  try {
    withheldAQueue(f);
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(run.stdout.includes("Repaired 1 commit reference"), out(run));
    assert.ok(run.stdout.includes("doesn't resolve in this repository: dec_a"), out(run));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
    assert.equal(readDecision(f.decisionFile("dec_b")).commit, f.shaBNew);
    assert.deepEqual(qids(f.root), ["dec_a"]);
  } finally { f.cleanup(); }
});

test("a dry run marks the withheld entry", () => {
  const f = twoDecisionFixture();
  try {
    withheldAQueue(f);
    const run = runCli(f.root, "repair-provenance");
    assert.ok(run.stdout.includes("Would repair 1 of 2 listed"), out(run));
    assert.match(run.stdout, /dec_a.*doesn't resolve in this repository/);
    assert.doesNotMatch(run.stdout, /dec_a.*not visible this run/);
    assert.doesNotMatch(run.stdout, /dec_b.*doesn't resolve/);
  } finally { f.cleanup(); }
});

test("invisible and withheld entries are reported under their own reasons", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
      { id: "dec_b", from: "sha_b_old", to: FAKE2 },
    ]);
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.match(run.stdout, /are visible this run[\s\S]*dec_a/);
    assert.match(run.stdout, /doesn't resolve in this repository[\s\S]*dec_b/);
    assert.deepEqual(qids(f.root).sort(), ["dec_a", "dec_b"]);
  } finally { f.cleanup(); }
});

test("two withheld entries are reported together in the plural", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: FAKE },
      { id: "dec_b", from: "sha_b_old", to: FAKE2 },
    ]);
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(run.stdout.includes("entries whose proposed replacement commits don't resolve in this repository: dec_a, dec_b"), out(run));
    assert.ok(!run.stdout.includes("an entry whose proposed replacement commit doesn't"), out(run));
    assert.deepEqual(qids(f.root), ["dec_a", "dec_b"]);
  } finally { f.cleanup(); }
});

test("an invisible entry is not described as unresolvable, and --only reports it as visible", () => {
  const f = twoDecisionFixture();
  try {
    hide(f);
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: FAKE },
      { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
    ]);
    const dry = runCli(f.root, "repair-provenance");
    assert.match(dry.stdout, /dec_a.*not visible this run/);
    assert.doesNotMatch(dry.stdout, /dec_a.*doesn't resolve in this repository/);
    const only = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.match(only.stdout, /are visible this run[\s\S]*dec_a/);
    assert.ok(!out(only).includes("doesn't resolve in this repository"), out(only));
  } finally { f.cleanup(); }
});

test("a withheld first entry does not stop its resolvable sibling from applying", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
      { id: "dec_a", from: "sha_a_old", to: FAKE },
    ]);
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(run.stdout.includes("Repaired 1 commit reference"), out(run));
    assert.ok(run.stdout.includes("doesn't resolve in this repository: dec_a"), out(run));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, f.shaANew);
    assert.deepEqual(readQueue(f.root), [{ id: "dec_a", from: "sha_a_old", to: FAKE }]);
  } finally { f.cleanup(); }
});

test("only one entry per decision is applied; the sibling is left queued and reported", () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const run = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(run.stdout.includes("Repaired 1 commit reference"), out(run));
    assert.ok(!run.stdout.includes(`→ ${f.shaBNew}`), out(run));
    assert.match(run.stdout, /left queued — a sibling entry for the same decision was applied instead[\s\S]*dec_a \(/);
    assert.ok(run.stdout.includes(`dec_a (${f.shaBNew}`), out(run));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, f.shaANew);
    assert.deepEqual(readQueue(f.root), [{ id: "dec_a", from: "sha_a_old", to: f.shaBNew }]);
  } finally { f.cleanup(); }
});

test("the left-over sibling is pruned as dead on the next run", () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const first = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(first.stdout.includes("Repaired 1 commit reference"), out(first));
    const second = runCli(f.root, "repair-provenance", "--apply");
    assert.ok(second.stdout.includes("Pruned 1 dead queue entry"), out(second));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, f.shaANew);
    assert.deepEqual(readQueue(f.root), []);
  } finally { f.cleanup(); }
});

test("a dry run lists the duplicate-id sibling as shadowed by another queued entry", () => {
  const f = twoDecisionFixture();
  try {
    duplicateIdQueue(f);
    const run = runCli(f.root, "repair-provenance");
    assert.ok(run.stdout.includes("Would repair 1 of 2 listed"), out(run));
    assert.match(run.stdout, new RegExp(`dec_a.*${f.shaBNew}.*another queued entry`));
    assert.doesNotMatch(run.stdout, new RegExp(`dec_a.*${f.shaANew}.*another queued entry`));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, "sha_a_old");
  } finally { f.cleanup(); }
});

test("--apply --only applies the first sibling and leaves the others queued", () => {
  const f = twoDecisionFixture();
  try {
    writeQueue(f.root, [
      { id: "dec_a", from: "sha_a_old", to: f.shaANew },
      { id: "dec_a", from: "sha_a_old", to: f.shaBNew },
      { id: "dec_b", from: "sha_b_old", to: f.shaBNew },
    ]);
    const run = runCli(f.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.ok(run.stdout.includes("Repaired 1 commit reference"), out(run));
    assert.equal(readDecision(f.decisionFile("dec_a")).commit, f.shaANew);
    assert.equal(readDecision(f.decisionFile("dec_b")).commit, "sha_b_old");
    assert.deepEqual(readQueue(f.root).map((q) => `${q.id}:${q.to}`).sort(), [`dec_a:${f.shaBNew}`, `dec_b:${f.shaBNew}`]);
  } finally { f.cleanup(); }
});

test("--from-hook with no ORIG_HEAD is a quiet no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair-noorig-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    ensureGitignore(root);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const run = runCli(root, "repair-provenance", "--from-hook", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "");
  } finally {
    cleanupDir(root);
  }
});

/**
 * A repo whose PUBLIC store holds zero decisions: the decision exists only in a
 * separate overlay repository. The advisory/public view therefore sees nothing,
 * while the full store (public + private overlay) sees the decision.
 */
function privateOverlaySessionStartFixture(): { root: string; overlayRoot: string; decisionId: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair-pub-"));
  const overlayRoot = mkdtempSync(join(tmpdir(), "hunch-repair-overlay-"));
  const privateDir = join(overlayRoot, ".hunch");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "gitignore");
  git(overlayRoot, "init", "-q", "-b", "main");
  git(overlayRoot, "config", "user.email", "test@example.com");
  git(overlayRoot, "config", "user.name", "Test Human");
  git(overlayRoot, "commit", "-q", "--allow-empty", "-m", "init overlay");
  mkdirSync(privateDir, { recursive: true });
  const decisionId = "dec_private_sessionstart";
  const commit = "cafefeed00cafefeed00cafefeed00cafefeed0";
  const decision = fullDecision(decisionId, commit, "src/private.ts");
  const previous = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = privateDir;
  try {
    const store = new HunchStore(hunchPaths(root));
    store.putPrivate("decisions", decision);
    store.close();
  } finally {
    if (previous === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = previous;
  }
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(queueFile(root), JSON.stringify([{ id: decisionId, from: commit, to: "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0" }], null, 2) + "\n");
  return {
    root,
    overlayRoot,
    decisionId,
    env: { ...process.env, HUNCH_PRIVATE_DIR: privateDir, HUNCH_SYNTH_PROVIDER: "deterministic" },
    cleanup: () => {
      cleanupDir(root);
      cleanupDir(overlayRoot);
    },
  };
}

test("a prompt naming the decision's file surfaces a queued commit-repair escalation for a private-overlay decision even when the public store has zero decisions", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    const run = spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root,
      env: fixture.env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `s-${randomUUID()}`, prompt: "fix the bug in src/private.ts" }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(fixture.decisionId),
      "the public decisions list is empty, but the queued repair is fully answerable via the full store — the prompt hook must check it",
    );
  } finally {
    fixture.cleanup();
  }
});

test("the prompt hook surfaces the withheld (never-resolves) wording, not the ordinary --apply-works wording, when the queued `to` doesn't resolve here (#48 follow-up)", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    // The fixture's queued `to` is withheld by construction. This guards the
    // SessionStart/prompt call site that feeds withheldRewrites into
    // commitRepairEscalations, using the same queue array for both.
    const run = spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root,
      env: fixture.env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `s-${randomUUID()}`, prompt: "fix the bug in src/private.ts" }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /doesn't resolve in this repository/, "the prompt hook must surface the withheld wording");
    assert.doesNotMatch(run.stdout, new RegExp(`--apply --only ${fixture.decisionId} to accept`), "never advertise an action that no-ops forever");
  } finally {
    fixture.cleanup();
  }
});

test("the prompt hook does NOT re-surface a private-overlay commit-repair escalation once its exact triple is tombstoned — the same private-overlay liveness path must respect --drop too", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    const first = readQueue(fixture.root)[0]!;
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: first.id, from: first.from, to: first.to }], null, 2) + "\n",
    );
    const run = spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root,
      env: fixture.env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `s-${randomUUID()}`, prompt: "fix the bug in src/private.ts" }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(
      run.stdout,
      new RegExp(fixture.decisionId),
      "the tombstoned repair must not surface here either — the prompt hook shares the same readActivePendingRepairs path as `hunch escalations`, not a raw queue read",
    );
  } finally {
    fixture.cleanup();
  }
});


test("escalations are task-scoped: SessionStart and an unrelated prompt ask nothing, and the entry stays listed (dec_12ba37db1c)", () => {
  const fixture = privateOverlaySessionStartFixture();
  const session = `s-${randomUUID()}`;
  try {
    const hook = (input: object) => spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root, env: fixture.env, input: JSON.stringify(input), encoding: "utf8",
    });
    const start = hook({ hook_event_name: "SessionStart", session_id: session });
    assert.equal(start.status, 0, start.stderr);
    assert.doesNotMatch(start.stdout, new RegExp(fixture.decisionId), "session start has no task yet, so it asks nothing");
    const unrelated = hook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "add a flag to src/other.ts" });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.doesNotMatch(unrelated.stdout, new RegExp(fixture.decisionId), "a prompt that touches none of its files must not be asked");
    const listed = spawnSync(process.execPath, [tsx, cli, "escalations", "--json"], { cwd: fixture.root, env: fixture.env, encoding: "utf8" });
    assert.match(listed.stdout, new RegExp(fixture.decisionId), "the unasked entry is never dropped");
    const asked = hook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "now fix src/private.ts" });
    assert.match(asked.stdout, new RegExp(fixture.decisionId), "the prompt that touches it asks");
    const again = hook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "and src/private.ts again" });
    assert.doesNotMatch(again.stdout, new RegExp(fixture.decisionId), "the same question is asked once per session");
  } finally {
    fixture.cleanup();
  }
});

test("a provider with no prompt event keeps the session-start ask, even on a fresh public graph; a prompt-capable one does not (dec_12ba37db1c)", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    const hook = (provider: string, input: object) => spawnSync(process.execPath, [tsx, cli, "hook", "--provider", provider], {
      cwd: fixture.root, env: fixture.env, input: JSON.stringify(input), encoding: "utf8",
    });
    // Antigravity's PreInvocation is its orientation event and carries no turn text.
    const ag = hook("antigravity", { conversationId: `c-${randomUUID()}`, invocationNum: 0 });
    assert.equal(ag.status, 0, ag.stderr);
    assert.match(ag.stdout, /need YOUR call/, "no prompt hook would ever ask, so orientation asks");
    assert.match(ag.stdout, new RegExp(fixture.decisionId), "the queued repair prevents the fresh-graph early return");
    const claude = hook("claude", { hook_event_name: "SessionStart", session_id: `s-${randomUUID()}` });
    assert.equal(claude.status, 0, claude.stderr);
    assert.doesNotMatch(claude.stdout, /need YOUR call/, "a prompt-capable provider asks at the prompt instead");
  } finally {
    fixture.cleanup();
  }
});

test("reviewed repair cannot switch targets after an intervening merge", () => {
  const fixture = squashFixture();
  try {
    git(fixture.root, "update-ref", "ORIG_HEAD", fixture.oldRef);
    assert.equal(runCli(fixture.root, "repair-provenance", "--from-hook", "--quiet").status, 0);
    const escalation = JSON.parse(runCli(fixture.root, "escalations", "--json").stdout)
      .find((e: { kind: string }) => e.kind === "commit-repair-pending");
    const command = /hunch (repair-provenance --apply --only \S+(?: --expect sha256:[a-f0-9]{64})?)/.exec(escalation.resolution)![1]!;
    const before = git(fixture.root, "rev-parse", "HEAD");
    writeFileSync(join(fixture.root, "src/feature.ts"), "export const feature = 2;\n");
    git(fixture.root, "add", "src/feature.ts");
    git(fixture.root, "commit", "-qm", "later unrelated change to same file");
    git(fixture.root, "update-ref", "ORIG_HEAD", before);
    const run = runCliRaw(fixture.root, ...command.split(" "));
    assert.equal(run.status, 0, run.stderr);
    const repaired = JSON.parse(readFileSync(fixture.decisionFile, "utf8")) as Decision;
    assert.equal(repaired.commit, git(fixture.root, "rev-parse", "--short", fixture.newRef), "apply only the proposal that was reviewed");
  } finally { fixture.cleanup(); }
});

for (const action of ["apply", "drop"] as const) {
  test(`repair-provenance refuses stale ${action} approval after hook replaces the proposal`, () => {
    const fixture = squashFixture();
    try {
      git(fixture.root, "update-ref", "ORIG_HEAD", fixture.oldRef);
      assert.equal(runCliRaw(fixture.root, "repair-provenance", "--from-hook", "--quiet").status, 0);
      const escalation = JSON.parse(runCliRaw(fixture.root, "escalations", "--json").stdout)
        .find((e: { kind: string }) => e.kind === "commit-repair-pending");
      const expected = /--expect (sha256:[a-f0-9]{64})/.exec(escalation.resolution)![1]!;
      const before = git(fixture.root, "rev-parse", "HEAD");
      writeFileSync(join(fixture.root, "src/feature.ts"), "export const feature = 2;\n");
      git(fixture.root, "add", "src/feature.ts");
      git(fixture.root, "commit", "-qm", "later change");
      git(fixture.root, "update-ref", "ORIG_HEAD", before);
      assert.equal(runCliRaw(fixture.root, "repair-provenance", "--from-hook", "--quiet").status, 0);
      const queueBefore = readFileSync(queueFile(fixture.root), "utf8");
      const decisionBefore = readFileSync(fixture.decisionFile, "utf8");
      const args = action === "apply" ? ["--apply", "--only", "dec_squash_fixture"] : ["--drop", "dec_squash_fixture"];
      const run = runCliRaw(fixture.root, "repair-provenance", ...args, "--expect", expected);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /review is missing or stale/);
      assert.equal(readFileSync(fixture.decisionFile, "utf8"), decisionBefore);
      assert.equal(readFileSync(queueFile(fixture.root), "utf8"), queueBefore);
      assert.equal(existsSync(join(fixture.root, ".hunch/dropped-commit-repairs.json")), false);
    } finally { fixture.cleanup(); }
  });
}

test("repair-provenance requires a review hash before any apply or drop", () => {
  const fixture = squashFixture();
  try {
    assert.equal(runCliRaw(fixture.root, "repair-provenance", "--range", `${fixture.oldRef}..${fixture.newRef}`).status, 0);
    const queueBefore = readFileSync(queueFile(fixture.root), "utf8");
    const decisionBefore = readFileSync(fixture.decisionFile, "utf8");
    for (const args of [["--apply"], ["--drop", "dec_squash_fixture"]]) {
      const run = runCliRaw(fixture.root, "repair-provenance", ...args);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /--expect/);
      assert.equal(readFileSync(fixture.decisionFile, "utf8"), decisionBefore);
      assert.equal(readFileSync(queueFile(fixture.root), "utf8"), queueBefore);
    }
  } finally { fixture.cleanup(); }
});

/** A bare repo plus a decision citing `commit` with `related_files`, committed. */
function repoWith(build: (root: string, commit: (msg: string, files: Record<string, string>) => string) => { commit: string; related: string[] }): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-repair450-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  const commit = (msg: string, files: Record<string, string>): string => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    git(root, "add", "-A");
    git(root, "commit", "-qm", msg);
    return git(root, "rev-parse", "HEAD");
  };
  const { commit: cited, related } = build(root, commit);
  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", {
    id: "dec_repair450", title: "t", topic: null, status: "accepted", context: "", decision: "d.", consequences: [],
    alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: related,
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: cited,
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${cited}`], last_verified: "2026-01-01T00:00:00.000Z" },
    date: "2026-01-01T00:00:00.000Z",
  } as Decision);
  store.reindex();
  store.close();
  git(root, "add", "-A");
  git(root, "commit", "-qm", "hunch: record decision");
  return { root, cleanup: () => cleanupDir(root) };
}

test("repair-provenance --range over a historical commit never proposes rewriting a decision whose commit HEAD still reaches (#450)", () => {
  let old = "", later = "";
  const fixture = repoWith((_root, commit) => {
    commit("base", { "src/base.ts": "1\n" });
    old = commit("release", { "src/feature.ts": "v1\n", "src/other.ts": "1\n" });
    later = commit("later change", { "src/feature.ts": "v2\n" });
    return { commit: later, related: ["src/feature.ts"] };
  });
  try {
    const run = runCliRaw(fixture.root, "repair-provenance", "--range", `${old}^..${old}`);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /Would repair/);
    assert.deepEqual(readActivePendingRepairs(fixture.root), [], "the cited commit is on main: nothing is orphaned");
    // Control: judged against the range tip alone (the old rule) the same commit IS orphaned.
    assert.equal(commitRepairStatus(later, old, fixture.root), "orphaned");
    assert.equal(commitRepairStatusAgainst(later, [old, "HEAD"], fixture.root), "current");
  } finally { fixture.cleanup(); }
});

test("repair-provenance prefers the same-patch-id commit over the unique file-superset one, and says which kind of match it is (#450)", () => {
  let base = "", picked = "", head = "", orphanSha = "";
  const fixture = repoWith((root, commit) => {
    base = commit("base", { "CHANGELOG.md": "# log\n", "src/a.ts": "1\n", "package.json": "{}\n" });
    git(root, "checkout", "-qb", "feature");
    const orphan = commit("feat: script", { "CHANGELOG.md": "# log\n- script\n", "scripts/x.sh": "echo x\n" });
    orphanSha = orphan;
    git(root, "checkout", "-q", "main");
    // Main moves first, so the cherry-pick can never be byte-identical to the orphan
    // (same tree, parent, message and second) and thus the very same commit.
    commit("unrelated", { "docs/other.md": "x\n" });
    git(root, "cherry-pick", orphan);
    picked = git(root, "rev-parse", "HEAD");
    head = commit("release", { "CHANGELOG.md": "# log\n- script\n- release\n", "src/a.ts": "2\n", "package.json": "{\"v\":1}\n" });
    return { commit: orphan, related: ["CHANGELOG.md", "src/a.ts"] };
  });
  try {
    const run = runCliRaw(fixture.root, "repair-provenance", "--range", `${base}..${head}`);
    assert.equal(run.status, 0, run.stderr);
    const queued = readActivePendingRepairs(fixture.root);
    assert.equal(queued.length, 1, run.stdout);
    assert.ok(picked.startsWith(queued[0]!.to), `the cherry-picked commit, not the release commit (got ${queued[0]!.to})`);
    assert.match(run.stdout, /same patch-id: identical change/);
    // An unresolvable sha (a withheld queue entry) must not wipe out every other patch-id.
    assert.ok(commitPatchIds([orphanSha, "deadbeefdeadbeef"], fixture.root).has(orphanSha));
  } finally { fixture.cleanup(); }
});
