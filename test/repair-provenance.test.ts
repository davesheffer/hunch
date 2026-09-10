import { test } from "node:test";
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
import { ensureGitignore } from "../src/integrations/gitignore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    encoding: "utf8",
  });
}

/** A repo shaped like a real squash-merge: a feature-branch commit (never an
 *  ancestor of main) that a decision cites, then a same-diff commit landing on
 *  main — exactly what GitHub/GitLab's squash-merge produces locally once
 *  pulled. `oldRef`/`newRef` bracket the "merge" for an explicit --range. */
function squashFixture(): { root: string; decisionFile: string; oldRef: string; newRef: string; origCommit: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-squash-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/base.ts"), "export const base = 1;\n");
  git(root, "add", ".gitignore", "src/base.ts");
  git(root, "commit", "-qm", "feat: base");

  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "src/feature.ts"), "export const feature = 1;\n");
  git(root, "add", "src/feature.ts");
  git(root, "commit", "-qm", "feat: add feature");
  const origCommit = git(root, "rev-parse", "HEAD");

  const decision: Decision = {
    id: "dec_squash_fixture",
    title: "Add the feature",
    topic: null,
    status: "accepted",
    context: "",
    decision: "Add the feature.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/feature.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: origCommit,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${origCommit}`], last_verified: "2026-01-01T00:00:00.000Z" },
    date: "2026-01-01T00:00:00.000Z",
  };

  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "src/unrelated.ts"), "export const unrelated = 1;\n");
  git(root, "add", "src/unrelated.ts");
  git(root, "commit", "-qm", "chore: unrelated");
  const origHead = git(root, "rev-parse", "HEAD");

  writeFileSync(join(root, "src/feature.ts"), "export const feature = 1;\n");
  git(root, "add", "src/feature.ts");
  git(root, "commit", "-qm", "feat: add feature (#1)");
  const newHead = git(root, "rev-parse", "HEAD");

  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", decision);
  store.reindex();
  store.close();
  const decisionFile = join(root, ".hunch/decisions/dec_squash_fixture.json");
  git(root, "add", ".hunch/decisions/dec_squash_fixture.json");
  git(root, "commit", "-qm", "hunch: record feature decision");

  return { root, decisionFile, oldRef: origHead, newRef: newHead, origCommit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const queueFile = (root: string): string => join(root, ".hunch", "pending-commit-repairs.json");
const readQueue = (root: string): unknown[] => JSON.parse(readFileSync(queueFile(root), "utf8"));

test("repair-provenance --range --apply rewrites commit + evidence directly, and leaves the queue empty", () => {
  const fixture = squashFixture();
  try {
    const run = runCli(fixture.root, "repair-provenance", "--range", `${fixture.oldRef}..${fixture.newRef}`, "--apply");
    assert.equal(run.status, 0, run.stderr);
    // Repaired records carry the same abbreviated sha every synthesized decision uses.
    const shortNewRef = git(fixture.root, "rev-parse", "--short", fixture.newRef);
    const repaired = JSON.parse(readFileSync(fixture.decisionFile, "utf8")) as Decision;
    assert.equal(repaired.commit, shortNewRef);
    assert.deepEqual(repaired.provenance.evidence, [`commit:${shortNewRef}`]);
    assert.match(git(fixture.root, "log", "-1", "--format=%s"), /^hunch: repair 1 commit reference\(s\) after squash-merge/);
    assert.deepEqual(readQueue(fixture.root), [], "every candidate this run applied or went stale — queue clears");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance dry run (no --apply) reports the plan, queues it, and changes nothing", () => {
  const fixture = squashFixture();
  try {
    const before = readFileSync(fixture.decisionFile, "utf8");
    const run = runCli(fixture.root, "repair-provenance", "--range", `${fixture.oldRef}..${fixture.newRef}`);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Would repair 1 commit reference/);
    assert.equal(readFileSync(fixture.decisionFile, "utf8"), before);
    const queue = readQueue(fixture.root) as { id: string; from: string; to: string }[];
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.id, "dec_squash_fixture");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance's fresh-detection merge on a duplicate-id queue overrides only the entry pickRewrite would pick, leaving the untargeted sibling queued (#56)", () => {
  const fixture = squashFixture();
  try {
    // A corrupted queue file, a hand edit, or a bug elsewhere could leave two
    // entries queued for the same decision id, both otherwise valid. A fresh
    // match for that id must override only the one pickRewrite would ever
    // actually apply (first match) — not silently collapse both into the
    // fresh entry with no tombstone and no record of what was destroyed.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_squash_fixture", from: fixture.origCommit, to: "sha_stale_1" },
        { id: "dec_squash_fixture", from: fixture.origCommit, to: "sha_stale_2" },
      ], null, 2) + "\n",
    );

    const run = runCli(fixture.root, "repair-provenance", "--range", `${fixture.oldRef}..${fixture.newRef}`, "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const queue = readQueue(fixture.root) as { id: string; from: string; to: string }[];
    assert.equal(queue.length, 2, "the untargeted sibling must survive the fresh match, not be silently destroyed");
    assert.equal(queue[0]!.to, git(fixture.root, "rev-parse", "--short", fixture.newRef), "the fresh match itself is queued");
    assert.deepEqual(queue[1], { id: "dec_squash_fixture", from: fixture.origCommit, to: "sha_stale_2" }, "the never-would-apply second entry is untouched");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --from-hook (no --apply, matches installed hook exactly) detects and QUEUES, never writes the decision", () => {
  const fixture = squashFixture();
  try {
    // ORIG_HEAD is what a real merge/reset/rebase leaves behind; set it directly
    // so this exercises the hook's actual flags with no --range override.
    git(fixture.root, "update-ref", "ORIG_HEAD", fixture.oldRef);
    const before = readFileSync(fixture.decisionFile, "utf8");
    const run = runCli(fixture.root, "repair-provenance", "--from-hook", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "", "quiet mode prints nothing");
    assert.equal(readFileSync(fixture.decisionFile, "utf8"), before, "the hook never writes the decision — detect only");
    assert.equal(git(fixture.root, "status", "--porcelain"), "", "no auto-commit from a detect-only run");
    const queue = readQueue(fixture.root) as { id: string; from: string; to: string }[];
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.id, "dec_squash_fixture");
    assert.equal(queue[0]!.to, git(fixture.root, "rev-parse", "--short", fixture.newRef));
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply picks up a match from the queue even once the range that found it no longer resolves", () => {
  const fixture = squashFixture();
  try {
    git(fixture.root, "update-ref", "ORIG_HEAD", fixture.oldRef);
    const queueRun = runCli(fixture.root, "repair-provenance", "--from-hook", "--quiet");
    assert.equal(queueRun.status, 0, queueRun.stderr);
    assert.equal(readQueue(fixture.root).length, 1, "sanity: the match was queued");

    // Prove the queue — not a re-resolved range — supplies the match: remove
    // ORIG_HEAD entirely before applying.
    git(fixture.root, "update-ref", "-d", "ORIG_HEAD");

    const applyRun = runCli(fixture.root, "repair-provenance", "--quiet", "--apply");
    assert.equal(applyRun.status, 0, applyRun.stderr);
    const repaired = JSON.parse(readFileSync(fixture.decisionFile, "utf8")) as Decision;
    assert.equal(repaired.commit, git(fixture.root, "rev-parse", "--short", fixture.newRef));
    assert.deepEqual(readQueue(fixture.root), [], "applied entry is cleared from the queue");
  } finally {
    fixture.cleanup();
  }
});

test("a queued repair surfaces via `hunch escalations` — the discoverable surface for what the silent hook found", () => {
  const fixture = squashFixture();
  try {
    git(fixture.root, "update-ref", "ORIG_HEAD", fixture.oldRef);
    const queueRun = runCli(fixture.root, "repair-provenance", "--from-hook", "--quiet");
    assert.equal(queueRun.status, 0, queueRun.stderr);

    const escRun = runCli(fixture.root, "escalations", "--json");
    assert.equal(escRun.status, 1, "escalations exits non-zero when something needs a human decision");
    const items = JSON.parse(escRun.stdout) as { kind: string; decisionIds: string[] }[];
    const pending = items.find((i) => i.kind === "commit-repair-pending");
    assert.ok(pending, "the queued repair appears as an escalation");
    assert.deepEqual(pending!.decisionIds, ["dec_squash_fixture"]);
  } finally {
    fixture.cleanup();
  }
});

test("a withheld queued repair (its `to` doesn't resolve here) still surfaces via `hunch escalations`, but never advertises --apply --only as a working resolution (#48 follow-up)", () => {
  const fixture = squashFixture();
  try {
    // Corrupt the queue after detection: swap the real matched `to` for one
    // that was never a git object. Simulates a hand-edited/corrupted queue
    // file — exactly the shape --apply's own existence check defends against.
    writeFileSync(
      queueFile(fixture.root),
      JSON.stringify([{ id: "dec_squash_fixture", from: fixture.origCommit, to: "0123456789abcdef0123456789abcdef01234567" }], null, 2) + "\n",
    );

    const escRun = runCli(fixture.root, "escalations", "--json");
    assert.equal(escRun.status, 1, "escalations exits non-zero when something needs a human decision");
    const items = JSON.parse(escRun.stdout) as { kind: string; decisionIds: string[]; question: string; resolution: string }[];
    const pending = items.find((i) => i.kind === "commit-repair-pending");
    assert.ok(pending, "a withheld entry still needs a human — it still escalates");
    assert.match(pending!.question, /doesn't resolve in this repository/);
    assert.doesNotMatch(pending!.resolution, /--apply --only dec_squash_fixture to accept/, "must never advertise an action that's guaranteed to no-op forever");
    assert.match(pending!.resolution, /--drop dec_squash_fixture/, "the only working resolution — --drop — must still be named");
  } finally {
    fixture.cleanup();
  }
});

/** Two independent decisions, each with a queued repair, seeded directly (no
 *  real squash-merge needed — that matching path is covered elsewhere). Lets
 *  --only/--drop tests act on one entry and assert the other is untouched. */
function twoDecisionQueueFixture(): { root: string; decisionFile: (id: string) => string; shaANew: string; shaBNew: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-squash-two-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  writeFileSync(join(root, "a.txt"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");

  // Every queued "to" must resolve to a REAL commit by default —
  // repair-provenance's existence check (issue #48) leaves an entry queued
  // rather than applying it when `to` doesn't resolve, so a fake placeholder
  // here would silently confound tests that mean to exercise OTHER reasons
  // an entry stays queued (invisible decision, drop, sweep, prune). Tests
  // that specifically target the unresolvable-`to` path overwrite the queue
  // file themselves with a deliberately fake sha.
  writeFileSync(join(root, "a2.txt"), "y\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "a commit dec_a's queued repair can resolve to");
  const shaANew = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "b.txt"), "y\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "a commit dec_b's queued repair can resolve to");
  const shaBNew = git(root, "rev-parse", "HEAD");

  const mkDecision = (id: string, commit: string): Decision => ({
    id,
    title: `Decision ${id}`,
    topic: null,
    status: "accepted",
    context: "",
    decision: `Decision ${id}.`,
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [`src/${id}.ts`],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${commit}`], last_verified: "2026-01-01T00:00:00.000Z" },
    date: "2026-01-01T00:00:00.000Z",
  });

  const store = new HunchStore(hunchPaths(root));
  store.json.put("decisions", mkDecision("dec_a", "sha_a_old"));
  store.json.put("decisions", mkDecision("dec_b", "sha_b_old"));
  store.reindex();
  store.close();
  git(root, "add", ".hunch");
  git(root, "commit", "-qm", "hunch: record dec_a and dec_b");

  writeFileSync(
    join(root, ".hunch", "pending-commit-repairs.json"),
    JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: shaANew }, { id: "dec_b", from: "sha_b_old", to: shaBNew }], null, 2) + "\n",
  );

  return {
    root,
    decisionFile: (id: string) => join(root, ".hunch/decisions", `${id}.json`),
    shaANew,
    shaBNew,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("repair-provenance --drop removes one queued entry without applying anything", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    const headBefore = git(fixture.root, "rev-parse", "HEAD");
    const run = runCli(fixture.root, "repair-provenance", "--drop", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_b"], "only the dropped entry is removed");

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    const decB = JSON.parse(readFileSync(fixture.decisionFile("dec_b"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old", "dropping never applies a rewrite");
    assert.equal(decB.commit, "sha_b_old", "the untargeted decision is untouched");
    assert.equal(git(fixture.root, "rev-parse", "HEAD"), headBefore, "no commit was made");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --drop <id> --apply in one invocation never applies an identical {id, from, to} sibling it just tombstoned (#53 follow-up)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // A corrupted queue file, or a hand edit, can carry two IDENTICAL
    // entries for the same id. --drop's own object-identity fix (#53)
    // removes and tombstones only the first one by reference — the second,
    // duplicate-in-substance entry is still sitting in the queue this same
    // invocation goes on to --apply, which would rewrite the exact triple
    // the human just rejected in the same command.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
      ], null, 2) + "\n",
    );

    const run = runCli(fixture.root, "repair-provenance", "--drop", "dec_a", "--apply", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old", "the rejected rewrite must never be applied, even by an identical sibling in the same run");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue, [], "the tombstoned sibling must not survive in the queue either");

    const dropped = JSON.parse(readFileSync(join(fixture.root, ".hunch", "dropped-commit-repairs.json"), "utf8")) as { id: string; from: string; to: string }[];
    assert.deepEqual(dropped, [{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], "the tombstone is written exactly once, not duplicated for the swept sibling");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --drop <id> on a duplicate-id queue only removes the entry that would actually apply, leaving the untargeted sibling queued and tombstoning just the one dropped (#53)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // A corrupted queue file, a hand edit, or a bug elsewhere could leave two
    // entries sharing dec_a's id — both otherwise fully applicable (real,
    // resolvable `to`s). pickRewrite's own first-match-wins rule says only
    // the first would ever actually be applied; --drop must remove and
    // tombstone that one entry, not every entry sharing the id.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
        { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );

    const run = runCli(fixture.root, "repair-provenance", "--drop", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string; from: string; to: string }[];
    assert.deepEqual(
      queue,
      [{ id: "dec_a", from: "sha_a_old", to: fixture.shaBNew }, { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }],
      "the never-would-apply dec_a sibling and the untargeted dec_b entry both survive the drop",
    );

    const dropped = JSON.parse(readFileSync(join(fixture.root, ".hunch", "dropped-commit-repairs.json"), "utf8")) as { id: string; from: string; to: string }[];
    assert.deepEqual(dropped, [{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], "only the one entry actually dropped is tombstoned");
  } finally {
    fixture.cleanup();
  }
});

test("hunch escalations' apply-target wording for a duplicate-id queue (withheld-first, resolvable-second) matches what --apply --only actually applies (#59, mr-complexity-reviewer round 2)", () => {
  // The escalation's own wording is a MODEL of what --apply --only/--drop
  // target — src/core/escalations.ts derives it independently of the CLI's
  // real targeting logic (withheldForUnresolvableTo, deadRewrites,
  // firstFor). A unit test asserting escalations.ts against its own model
  // can't catch the two from drifting apart; only running the real CLI can.
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, // withheld: queued FIRST, never resolves
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew }, // resolvable: queued second
      ], null, 2) + "\n",
    );

    const escRun = runCli(fixture.root, "escalations", "--json");
    assert.equal(escRun.status, 1, "escalations exits non-zero when something needs a human decision");
    const items = JSON.parse(escRun.stdout) as { detail: string; resolution: string }[];
    const forResolvable = items.find((i) => i.detail === `sha_a_old → ${fixture.shaANew}`)!;
    assert.ok(forResolvable, "the resolvable (second-queued) entry surfaces its own escalation");
    assert.match(forResolvable.resolution, /--apply --only dec_a to accept/, "escalations says --apply --only works for the resolvable entry, despite it not being first-queued");

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, fixture.shaANew, "--apply --only dec_a really does apply the resolvable (second-queued, non-withheld) entry, exactly as escalations said it would");
  } finally {
    fixture.cleanup();
  }
});

test("hunch escalations' drop-target wording for the same duplicate-id queue matches what --drop actually tombstones — it's the FIRST-queued (withheld) entry, not the resolvable one --apply --only would apply (#59, mr-complexity-reviewer round 2)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, // withheld: queued FIRST — the real --drop target
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew }, // resolvable: queued second
        { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }, // untargeted — must survive the drop untouched
      ], null, 2) + "\n",
    );

    const escRun = runCli(fixture.root, "escalations", "--json");
    const items = JSON.parse(escRun.stdout) as { detail: string; resolution: string }[];
    const forResolvable = items.find((i) => i.detail === `sha_a_old → ${fixture.shaANew}`)!;
    assert.doesNotMatch(forResolvable.resolution, /--drop dec_a to reject it \(tombstoned durably/, "escalations must not claim --drop dec_a rejects the resolvable entry — it targets the withheld one instead");

    const run = runCli(fixture.root, "repair-provenance", "--drop", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const dropped = JSON.parse(readFileSync(join(fixture.root, ".hunch", "dropped-commit-repairs.json"), "utf8")) as { id: string; from: string; to: string }[];
    assert.deepEqual(dropped, [{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }], "--drop dec_a tombstones the first-queued (withheld) entry, exactly as escalations said it would");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string; to: string }[];
    assert.deepEqual(queue.map((r) => r.to), [fixture.shaANew, fixture.shaBNew], "the resolvable dec_a sibling and the untargeted dec_b entry both survive the drop");
  } finally {
    fixture.cleanup();
  }
});

test("hunch escalations --json marks a duplicate-id queue's non-actionable follower actionable:false, and leaves the genuine drop/apply target actionable (#61)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew }, // first-queued: the real --apply/--drop target
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew }, // second-queued: not directly actionable by id
      ], null, 2) + "\n",
    );

    const escRun = runCli(fixture.root, "escalations", "--json");
    assert.equal(escRun.status, 1, "still exits non-zero — the drop/apply target genuinely needs a human");
    const items = JSON.parse(escRun.stdout) as { detail: string; actionable?: boolean }[];
    const forFirst = items.find((i) => i.detail === `sha_a_old → ${fixture.shaANew}`)!;
    const forSecond = items.find((i) => i.detail === `sha_a_old → ${fixture.shaBNew}`)!;
    assert.notEqual(forFirst.actionable, false, "the real --apply/--drop target stays actionable");
    assert.equal(forSecond.actionable, false, "resolving it requires acting on the entry ahead of it, not this row");
  } finally {
    fixture.cleanup();
  }
});

test("hunch escalations' TEXT output (no --json) tallies only the actionable subset in its headline, but still lists the non-actionable follower below for transparency (#61)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew }, // first-queued: the real --apply/--drop target
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew }, // second-queued: not directly actionable by id
      ], null, 2) + "\n",
    );

    const run = runCli(fixture.root, "escalations");
    assert.equal(run.status, 1, "the drop/apply target still genuinely needs a human, so the exit code stays non-zero");
    assert.match(run.stdout, /^1 decision\(s\) need your call — asked here, never decided for you \(\+1 shown below for context only, not gating\):/m, "the headline tally counts only the actionable entry, not both");
    assert.match(run.stdout, new RegExp(`sha_a_old → ${fixture.shaANew}`), "the actionable entry is still printed in the list below the headline");
    assert.match(run.stdout, new RegExp(`sha_a_old → ${fixture.shaBNew}`), "the non-actionable follower still surfaces too — nothing about the corrupted queue is hidden");
  } finally {
    fixture.cleanup();
  }
});

test("MCP hunch_now's joined 'ASK inline' question list omits a duplicate-id follower's question — it isn't one the assistant can put to the human directly (#61)", async () => {
  const fixture = twoDecisionQueueFixture();
  let client: Client | null = null;
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, cli, "mcp"],
      cwd: fixture.root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    client = new Client({ name: "repair-provenance-mcp-hunch-now-actionable-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "hunch_now", arguments: {} });
    const text = (result.content as { type: "text"; text: string }[]).map((part) => part.text).join("\n");
    assert.match(text, /⚖ 1 decision\(s\) need the human's call/, "only the one actionable entry counts");
    assert.match(text, /no longer reachable from HEAD/, "the actionable entry's own question is still raised");
    assert.doesNotMatch(text, /further queued replacement candidate/, "the non-actionable follower's question must not be joined into the inline ask");
  } finally {
    await client?.close();
    fixture.cleanup();
  }
});

test("MCP hunch_escalations' text output tallies only the actionable subset, but still lists the non-actionable follower for transparency (#61)", async () => {
  const fixture = twoDecisionQueueFixture();
  let client: Client | null = null;
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, cli, "mcp"],
      cwd: fixture.root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    client = new Client({ name: "repair-provenance-mcp-hunch-escalations-actionable-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "hunch_escalations", arguments: {} });
    const text = (result.content as { type: "text"; text: string }[]).map((part) => part.text).join("\n");
    assert.match(text, /^1 decision\(s\) need the human's call — ask each inline, don't decide it for them \(\+1 shown below for context only, not a decision\):/m);
    assert.match(text, new RegExp(`sha_a_old → ${fixture.shaANew}`), "the actionable entry is still listed");
    assert.match(text, new RegExp(`sha_a_old → ${fixture.shaBNew}`), "the non-actionable follower still surfaces too");
  } finally {
    await client?.close();
    fixture.cleanup();
  }
});

test("repair-provenance: a dropped match doesn't resurface when the identical range is re-detected — the tombstone is durable, not just a queue clear", () => {
  const fixture = squashFixture();
  try {
    const detect = runCli(fixture.root, "repair-provenance", "--range", `${fixture.oldRef}..${fixture.newRef}`, "--quiet");
    assert.equal(detect.status, 0, detect.stderr);
    const firstQueue = readQueue(fixture.root) as { id: string; from: string; to: string }[];
    assert.deepEqual(firstQueue.map((r) => r.id), ["dec_squash_fixture"], "detection queued the match");
    const matchedTo = firstQueue[0]!.to;

    const drop = runCli(fixture.root, "repair-provenance", "--drop", "dec_squash_fixture", "--quiet");
    assert.equal(drop.status, 0, drop.stderr);
    assert.deepEqual(readQueue(fixture.root), [], "the drop cleared the queue");

    const redetect = runCli(fixture.root, "repair-provenance", "--range", `${fixture.oldRef}..${fixture.newRef}`, "--quiet");
    assert.equal(redetect.status, 0, redetect.stderr);
    assert.deepEqual(readQueue(fixture.root), [], "the identical match must not resurface once its {id, from, to} triple was dropped");

    const dropped = JSON.parse(readFileSync(join(fixture.root, ".hunch", "dropped-commit-repairs.json"), "utf8")) as { id: string; from: string; to: string }[];
    assert.deepEqual(dropped, [{ id: "dec_squash_fixture", from: fixture.origCommit, to: matchedTo }]);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance sweeps a tombstoned entry that lands in the queue by another path (e.g. a racing hook run), even without fresh detection", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Simulate the exact race the tombstone must survive: dec_a's {id, from, to}
    // was already rejected once, but a concurrently-racing writer (the
    // post-merge hook's backgrounded detection, which reads the queue/dropped
    // files independently) re-added the identical entry to the queue afterward.
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    const queue = readQueue(fixture.root) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_b"], "the tombstoned entry is swept from the queue on load, regardless of how it got there");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance announces a swept already-rejected match unless --quiet", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Swept 1 already-rejected match from the queue: dec_a/);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <id-just-swept> exits 0 with an explanatory message, not a usage error", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // dec_a is real and was queued, but its exact triple was already rejected
    // via an earlier --drop — this run's own sweep resolves it before --only
    // ever gets to look for it, same non-error shape as onlyWasPruned.
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], null, 2) + "\n",
    );
    // Not --quiet: distinguishes this from the OTHER exit-0 path (an id that
    // was never queued at all) — only this one names the --drop rejection.
    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /"dec_a" was already rejected via --drop — nothing left to do\./);
    const decB = JSON.parse(readFileSync(fixture.decisionFile("dec_b"), "utf8")) as Decision;
    assert.equal(decB.commit, "sha_b_old", "the untargeted decision is never touched by an --only run that resolves to nothing");
  } finally {
    fixture.cleanup();
  }
});

test("hunch escalations never re-asks about an entry sitting in the raw queue file if it's already tombstoned — the tombstone must hold on READ, not just on repair-provenance's own write", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Same race as the sweep test above, but this time nobody runs
    // repair-provenance at all before a human (or CI) checks escalations —
    // the surface that actually gets read must not depend on repair-provenance
    // having run first to clean up after a racing writer.
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "escalations", "--json");
    const items = run.stdout ? (JSON.parse(run.stdout) as { kind: string; decisionIds: string[] }[]) : [];
    const stillAsking = items.find((i) => i.kind === "commit-repair-pending" && i.decisionIds.includes("dec_a"));
    assert.equal(stillAsking, undefined, "dec_a's rejected match must not resurface as an escalation just because it's still sitting in the raw queue file");
    // Positive control: dec_b's untouched match must still surface — otherwise
    // this test would pass just as well if `escalations` crashed or emitted
    // nothing at all, proving nothing about the tombstone filter specifically.
    const stillAskingAboutB = items.find((i) => i.kind === "commit-repair-pending" && i.decisionIds.includes("dec_b"));
    assert.ok(stillAskingAboutB, "dec_b's untombstoned match must still surface");
  } finally {
    fixture.cleanup();
  }
});

test("MCP hunch_escalations never re-asks about a tombstoned entry sitting in the raw queue file — same readActivePendingRepairs path as the CLI", async () => {
  const fixture = twoDecisionQueueFixture();
  let client: Client | null = null;
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }], null, 2) + "\n",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, cli, "mcp"],
      cwd: fixture.root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    client = new Client({ name: "repair-provenance-mcp-tombstone-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "hunch_escalations", arguments: {} });
    const text = (result.content as { type: "text"; text: string }[]).map((part) => part.text).join("\n");
    assert.doesNotMatch(text, /dec_a/, "the tombstoned match must not resurface via the MCP tool either");
    assert.match(text, /dec_b/, "dec_b's untombstoned match must still surface — a positive control against a tool that silently emits nothing");
  } finally {
    await client?.close();
    fixture.cleanup();
  }
});

test("MCP hunch_now surfaces a withheld commit-repair with the never-resolves wording, not the ordinary --apply-works wording (#48 follow-up)", async () => {
  const fixture = squashFixture();
  let client: Client | null = null;
  try {
    // Corrupt the queue after detection: swap the real matched `to` for one
    // that was never a git object — same "corrupted queue file" scenario as
    // the CLI-level escalations test, but exercised through hunch_now, which
    // had no test coverage of this branch at all before this test.
    writeFileSync(
      queueFile(fixture.root),
      JSON.stringify([{ id: "dec_squash_fixture", from: fixture.origCommit, to: "0123456789abcdef0123456789abcdef01234567" }], null, 2) + "\n",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, cli, "mcp"],
      cwd: fixture.root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    client = new Client({ name: "repair-provenance-mcp-hunch-now-withheld-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "hunch_now", arguments: {} });
    const text = (result.content as { type: "text"; text: string }[]).map((part) => part.text).join("\n");
    assert.match(text, /doesn't resolve in this repository/, "hunch_now must surface the withheld wording");
    assert.doesNotMatch(text, /--apply --only dec_squash_fixture to accept/, "must never advertise an action that's guaranteed to no-op forever");
  } finally {
    await client?.close();
    fixture.cleanup();
  }
});

test("MCP hunch_escalations surfaces a withheld commit-repair with the never-resolves wording, not the ordinary --apply-works wording (#48 follow-up)", async () => {
  const fixture = squashFixture();
  let client: Client | null = null;
  try {
    // Guards the hunch_escalations call site's own withheldRewrites/
    // commitRepairEscalations wiring specifically (mirrors the hunch_now
    // test above) — mutating this site to re-read the queue instead of
    // reusing one local would silently fall back to the ordinary wording
    // with no other test catching it.
    writeFileSync(
      queueFile(fixture.root),
      JSON.stringify([{ id: "dec_squash_fixture", from: fixture.origCommit, to: "0123456789abcdef0123456789abcdef01234567" }], null, 2) + "\n",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, cli, "mcp"],
      cwd: fixture.root,
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    client = new Client({ name: "repair-provenance-mcp-hunch-escalations-withheld-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "hunch_escalations", arguments: {} });
    const text = (result.content as { type: "text"; text: string }[]).map((part) => part.text).join("\n");
    assert.match(text, /doesn't resolve in this repository/, "hunch_escalations must surface the withheld wording");
    assert.doesNotMatch(text, /--apply --only dec_squash_fixture to accept/, "must never advertise an action that's guaranteed to no-op forever");
  } finally {
    await client?.close();
    fixture.cleanup();
  }
});

test("repair-provenance --drop <id-not-queued> writes no tombstone — there's nothing to reject", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    const run = runCli(fixture.root, "repair-provenance", "--drop", "dec_nonexistent", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(fixture.root, ".hunch", "dropped-commit-repairs.json")), false, "nothing was actually queued for this id, so nothing is tombstoned");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <id> applies just that decision, leaving the other queued", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_b", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    const decB = JSON.parse(readFileSync(fixture.decisionFile("dec_b"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old", "the untargeted decision is never applied");
    assert.equal(decB.commit, fixture.shaBNew, "the targeted decision is applied");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_a"], "only the applied entry is cleared from the queue");
    assert.match(git(fixture.root, "log", "-1", "--format=%s"), /^hunch: repair 1 commit reference\(s\)/);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance self-prunes a permanently-dead queue entry on every run, even when --only targets a different id", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // dec_a's decision moved on since the entry was queued — the queue's
    // "sha_a_old" no longer matches, so repairDecisionCommit would refuse
    // this entry forever. Without self-pruning it would sit in the queue
    // past any number of --only runs targeting other entries.
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    decA.commit = "sha_a_moved_on";
    writeFileSync(fixture.decisionFile("dec_a"), JSON.stringify(decA, null, 2) + "\n");

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_b", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue, [], "dec_a's dead entry is pruned on read, not left behind just because --only targeted dec_b");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <id-pruned-this-run> exits 0 with an explanatory message, not a usage error", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // dec_a is real and queued, but this run's own prune resolves it before
    // --only ever gets to look for it — that's not the same situation as
    // targeting an id that never existed.
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    decA.commit = "sha_a_moved_on";
    writeFileSync(fixture.decisionFile("dec_a"), JSON.stringify(decA, null, 2) + "\n");

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /"dec_a" was pruned earlier in this run/);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance's prune message doesn't claim 'moved on' for a decision that simply has no commit on record", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // dec_a never had a commit at all (e.g. hand-edited or imported without
    // one) — deadRewrites correctly prunes it (repairDecisionCommit would
    // bail forever), but "moved on" isn't an accurate description.
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    decA.commit = null;
    writeFileSync(fixture.decisionFile("dec_a"), JSON.stringify(decA, null, 2) + "\n");

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_b");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /no commit on record/);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance announces a pruned dead entry unless --quiet, so a human isn't left guessing why --apply --only later reports nothing queued", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    decA.commit = "sha_a_moved_on";
    writeFileSync(fixture.decisionFile("dec_a"), JSON.stringify(decA, null, 2) + "\n");

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_b");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Pruned 1 dead queue entry.*dec_a/);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance's dead-entry prune on a duplicate-id queue never destroys a live sibling sharing the pruned id (#53)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Two entries share dec_a's id: one stale (its `from` no longer matches
    // dec_a's current commit — deadRewrites correctly calls this dead), and
    // one still live and otherwise fully applicable (`from` matches, `to`
    // resolves to a real commit). An id-keyed prune destroys both just
    // because they share an id; only the stale one should ever be removed.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_STALE", to: fixture.shaBNew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/, "the live sibling must still be applied, not destroyed alongside its stale namesake");

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, fixture.shaANew, "the live entry's rewrite was actually applied");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_b"], "dec_a's stale entry is pruned and its live sibling applied+swept — only the untargeted dec_b stays queued");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --range garbage fails before touching the queue file — a usage error changes nothing on disk", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // dec_a is provably dead (moved on) — if pruning ran before validation,
    // this usage error would still silently rewrite the queue file.
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    decA.commit = "sha_a_moved_on";
    writeFileSync(fixture.decisionFile("dec_a"), JSON.stringify(decA, null, 2) + "\n");
    const before = readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8");

    const run = runCli(fixture.root, "repair-provenance", "--range", "garbage");
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}${run.stderr}`, /--range must look like/);

    const after = readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8");
    assert.equal(after, before, "a pure usage error must not mutate the queue file");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance never deletes a queued entry just because its decision is momentarily invisible (branch checkout, unmounted overlay) — only a decision provably moved on is pruned", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Simulates checking out a branch/commit that predates dec_a's decision
    // record, or a private overlay not mounted for this run — NOT proof the
    // match is dead. Deleting this entry would be permanent: per
    // repairqueue.ts's own docstring, the queue is the one durable record
    // once ORIG_HEAD moves on and the matched-away commit can be gc'd.
    rmSync(fixture.decisionFile("dec_a"));

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_b", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_a"], "dec_a's entry survives even though its decision wasn't visible this run");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply (no --only) never deletes an invisible entry's queue slot just because the whole run's queue is otherwise cleared", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Same invisibility as above, but exercised via the completion write at
    // the end of --apply (no --only): dec_a is never in `decisions`, so the
    // apply loop can't mark it applied, yet the old code cleared the WHOLE
    // queue on this path regardless.
    rmSync(fixture.decisionFile("dec_a"));

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const decB = JSON.parse(readFileSync(fixture.decisionFile("dec_b"), "utf8")) as Decision;
    assert.equal(decB.commit, fixture.shaBNew, "dec_b, which WAS visible, is still applied");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_a"], "dec_a's entry survives — it was never actually applied, so it must not be cleared");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <invisible-id> never deletes that entry — it was targeted but never actually resolved", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a"));

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id).sort(), ["dec_a", "dec_b"], "targeting an invisible id with --only must not delete it, or leave dec_b's untouched entry");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <invisible-id> reports it couldn't see the decision, not that it 'already moved on'", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a"));

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /are visible this run/);
    assert.doesNotMatch(run.stdout, /already moved on/, "the decision wasn't seen at all — that's a different, more actionable answer than 'moved on'");
    assert.match(run.stdout, /--drop <dec_id>/, "names the escape hatch for a decision that's actually gone for good, not just transiently invisible");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply (whole queue invisible) names the ids in its 'nothing applied' message, not just the escape hatch", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a"));
    rmSync(fixture.decisionFile("dec_b"));

    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /are visible this run/);
    assert.match(run.stdout, /dec_a.*dec_b|dec_b.*dec_a/s, "names which ids are stuck, matching the sibling partial-success message's convention");
    assert.match(run.stdout, /--drop <dec_id>/);
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance dry run marks a listed entry whose decision isn't visible this run — --apply would leave it queued, not resolve it", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a"));

    const run = runCli(fixture.root, "repair-provenance");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Would repair 1 of 2 listed/, "one of the two is annotated not-visible, so the count must not overclaim both are repairable");
    assert.match(run.stdout, /dec_a.*not visible this run/, "dec_a's row is marked — --apply can't actually resolve it");
    assert.doesNotMatch(run.stdout, /dec_b.*not visible this run/, "dec_b IS visible — its row must not be marked");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply reports which entries stayed queued unresolved, alongside what it actually repaired", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a"));

    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/);
    assert.match(run.stdout, /not visible this run, left queued: dec_a/, "a human reading the success output should learn dec_a is still pending, not silently dropped");
    assert.match(run.stdout, /--drop <dec_id>/, "names the escape hatch for a decision that's actually gone for good");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --only <id-not-present> reports nothing to apply and changes nothing", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_missing");
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}${run.stderr}`, /no queued or matched entry for "dec_missing"/);
    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <id> never writes a decision's commit field when the queued `to` doesn't resolve to a real commit here (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Overwrite dec_a's queued "to" with a placeholder that was never a real
    // git object — a corrupted queue file, a hand edit, or an upstream bug
    // could produce exactly this shape.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a", "--quiet");
    assert.equal(run.status, 0, run.stderr);

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old", "an unresolvable `to` must never be written into the decision's commit field");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_a", "dec_b"], "the withheld entry stays queued — never deleted just because its `to` failed to resolve");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <id> reports the withheld reason distinctly from 'not visible' (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /doesn't resolve in this repository/);
    assert.doesNotMatch(run.stdout, /are visible this run/, "dec_a's decision IS visible — the withheld reason must not be confused with the invisibility reason");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply (no --only) applies the resolvable entry and leaves the unresolvable one queued, reporting both distinctly (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/);
    assert.match(run.stdout, /doesn't resolve in this repository: dec_a/);

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    const decB = JSON.parse(readFileSync(fixture.decisionFile("dec_b"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old", "withheld — never applied");
    assert.equal(decB.commit, fixture.shaBNew, "resolvable entry still applies normally");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id), ["dec_a"], "only the withheld entry survives in the queue");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance dry run marks a withheld entry distinctly from an invisible one, and the preview count matches what --apply can actually do (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Would repair 1 of 2 listed/, "one of the two would be withheld, so the preview must not overclaim both are repairable");
    assert.match(run.stdout, /dec_a.*doesn't resolve in this repository/, "dec_a's row is marked with the withheld reason");
    assert.doesNotMatch(run.stdout, /dec_a.*not visible this run/, "dec_a's decision IS visible — must not be marked invisible");
    assert.doesNotMatch(run.stdout, /dec_b.*doesn't resolve in this repository/, "dec_b's `to` DOES resolve — its row must not be marked withheld");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply reports an invisible decision AND a withheld entry together, not one masking the other (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a")); // invisible: decision gone from this run's view
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: fixture.shaANew }, { id: "dec_b", from: "sha_b_old", to: "fedcba9876543210fedcba9876543210fedcba98" }], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /are visible this run.*dec_a/s, "the invisible reason must still name dec_a");
    assert.match(run.stdout, /doesn't resolve in this repository.*dec_b/s, "the withheld reason must still name dec_b — must not be swallowed by the invisible branch");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id).sort(), ["dec_a", "dec_b"], "neither entry is deleted — nothing was actually applied");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply uses plural wording when TWO entries are withheld and nothing applied (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" },
        { id: "dec_b", from: "sha_b_old", to: "fedcba9876543210fedcba9876543210fedcba98" },
      ], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /entries whose proposed replacement commits don't resolve in this repository: dec_a, dec_b/, "plural grammar for two withheld entries, not the singular 'an entry ... doesn't'");
    assert.doesNotMatch(run.stdout, /an entry whose proposed replacement commit doesn't/, "must not use the singular phrasing for two entries");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string }[];
    assert.deepEqual(queue.map((r) => r.id).sort(), ["dec_a", "dec_b"], "both withheld entries stay queued");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply classifies a SINGLE entry that is both invisible AND withheld as invisible only, matching the dry-run's own precedence, not both at once", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    rmSync(fixture.decisionFile("dec_a")); // invisible
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }, { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew }], null, 2) + "\n",
    );
    const dry = runCli(fixture.root, "repair-provenance");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dec_a.*not visible this run/, "dry run classifies dec_a as invisible");
    assert.doesNotMatch(dry.stdout, /dec_a.*doesn't resolve in this repository/, "dry run must not ALSO classify it as withheld — one reason per entry");

    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /are visible this run.*dec_a/s, "apply agrees with the dry run: invisible, not withheld");
    assert.doesNotMatch(run.stdout, /doesn't resolve in this repository/, "must not print the withheld message for an entry already classified as invisible — no contradictory 'won't self-heal' advice for a decision that might become visible again");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply survives a corrupted queue with two entries sharing an id — the withheld sibling is never deleted or misreported as repaired (#48)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Not a shape the write path ever produces itself — this is exactly the
    // "corrupted queue file" scenario the existence check exists to defend
    // against. Same id, same `from`, two different proposed `to`s: one real,
    // one a ghost.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" },
      ], null, 2) + "\n",
    );
    // Deliberately NOT --quiet: a human reading the output must learn the
    // withheld sibling is still there, not just find it surviving on disk —
    // an id-keyed report (rather than the sweep's own object-keyed check)
    // would see `dec_a` fully resolved and print nothing about it at all.
    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/);
    assert.match(run.stdout, /doesn't resolve in this repository: dec_a/, "the withheld sibling must be reported as still queued, not silently dropped from the summary just because its sibling resolved");

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, fixture.shaANew, "the resolvable sibling is applied");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string; to: string }[];
    assert.deepEqual(queue, [{ id: "dec_a", from: "sha_a_old", to: "0123456789abcdef0123456789abcdef01234567" }], "the withheld sibling survives in the queue — an id-keyed sweep must not delete it just because its sibling resolved");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply survives a corrupted queue with two entries sharing an id that BOTH resolve — only the first is applied, and only it is reported/swept (#51)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    // Same {id, from}, but this time BOTH proposed `to`s are real, distinct
    // commits — the mirror of the #48 withheld-sibling case above.
    // repairDecisionCommit only ever applies the first match by id
    // (plan.rewrites.find), so the second entry here is never written even
    // though it's just as "resolvable" as the first.
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/, "only the first sibling was actually applied");
    assert.doesNotMatch(run.stdout, new RegExp(`→ ${fixture.shaBNew}`), "the second, never-applied sibling must not be listed under 'Repaired'");
    assert.match(run.stdout, new RegExp(`left queued — a sibling entry for the same decision was applied instead.*dec_a \\(${fixture.shaBNew}\\)`), "the never-applied sibling must be reported as still queued, not silently left in the file");

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, fixture.shaANew, "the first sibling is the one actually written");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string; to: string }[];
    assert.deepEqual(queue, [{ id: "dec_a", from: "sha_a_old", to: fixture.shaBNew }], "the never-applied second sibling stays queued, not swept just because its id resolved via the first");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance: a same-id duplicate self-heals on the next run once its winning sibling has been applied", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );
    const first = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Repaired 1 commit reference/);

    // The leftover sibling's `from` (sha_a_old) no longer matches dec_a's
    // now-current commit (shaANew) — deadRewrites correctly prunes it as
    // stale on the very next run, converging the queue to empty without a
    // human needing to intervene.
    const second = runCli(fixture.root, "repair-provenance", "--apply");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Pruned 1 dead queue entry/);

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, fixture.shaANew, "final state: the winning sibling's rewrite, unchanged since run 1");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8"));
    assert.deepEqual(queue, [], "the queue converges to empty on its own");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance dry run marks a same-id duplicate distinctly, and the preview count matches what --apply can actually do (#51)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );
    const dry = runCli(fixture.root, "repair-provenance");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would repair 1 of 2 listed/, "one of the two duplicates would stay queued, so the preview must not overclaim both are repairable");
    assert.match(dry.stdout, new RegExp(`dec_a.*${fixture.shaBNew}.*another queued entry`), "the second sibling's row is marked with the duplicate reason");
    assert.doesNotMatch(dry.stdout, new RegExp(`dec_a.*${fixture.shaANew}.*another queued entry`), "the first (winning) sibling's row must not be marked duplicate");

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, "sha_a_old", "dry run never writes anything");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --apply --only <id> targeting a same-id duplicate applies the first sibling and leaves the second queued (#51)", () => {
  const fixture = twoDecisionQueueFixture();
  try {
    writeFileSync(
      join(fixture.root, ".hunch", "pending-commit-repairs.json"),
      JSON.stringify([
        { id: "dec_a", from: "sha_a_old", to: fixture.shaANew },
        { id: "dec_a", from: "sha_a_old", to: fixture.shaBNew },
        { id: "dec_b", from: "sha_b_old", to: fixture.shaBNew },
      ], null, 2) + "\n",
    );
    const run = runCli(fixture.root, "repair-provenance", "--apply", "--only", "dec_a");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Repaired 1 commit reference/);

    const decA = JSON.parse(readFileSync(fixture.decisionFile("dec_a"), "utf8")) as Decision;
    assert.equal(decA.commit, fixture.shaANew, "the first dec_a sibling is applied");
    const decB = JSON.parse(readFileSync(fixture.decisionFile("dec_b"), "utf8")) as Decision;
    assert.equal(decB.commit, "sha_b_old", "dec_b is untouched — --only restricted the run to dec_a");

    const queue = JSON.parse(readFileSync(join(fixture.root, ".hunch", "pending-commit-repairs.json"), "utf8")) as { id: string; to: string }[];
    assert.deepEqual(queue.map((r) => `${r.id}:${r.to}`).sort(), [`dec_a:${fixture.shaBNew}`, `dec_b:${fixture.shaBNew}`].sort(), "the never-applied dec_a sibling and the untargeted dec_b entry both survive in the queue");
  } finally {
    fixture.cleanup();
  }
});

test("repair-provenance --from-hook is silent and exits 0 when there's no ORIG_HEAD to react to", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-squash-noop-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    ensureGitignore(root);
    writeFileSync(join(root, "a.txt"), "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const run = runCli(root, "repair-provenance", "--from-hook", "--quiet");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A public repo with a genuinely separate private-overlay repo, matching
 *  the shape HunchStore's overlay safety check requires. The public store
 *  has ZERO decisions; the decision this test cares about lives only in the
 *  overlay, so store.advisoryRecs("decisions") (what SessionStart's
 *  orientation reads) sees nothing while store.recs("decisions") (the full
 *  store) does. */
function privateOverlaySessionStartFixture(): { root: string; overlayRoot: string; decisionId: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-sessionstart-public-"));
  const overlayRoot = mkdtempSync(join(tmpdir(), "hunch-sessionstart-overlay-"));
  const privateRoot = join(overlayRoot, ".hunch");

  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  ensureGitignore(root);
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "init");

  git(overlayRoot, "init", "-q", "-b", "main");
  git(overlayRoot, "config", "user.email", "test@example.com");
  git(overlayRoot, "config", "user.name", "Test Human");
  git(overlayRoot, "commit", "--allow-empty", "-qm", "init overlay");

  mkdirSync(privateRoot, { recursive: true });

  const decisionId = "dec_private_sessionstart";
  const commit = "cafefeed00cafefeed00cafefeed00cafefeed0";
  const decision: Decision = {
    id: decisionId,
    title: "Private decision",
    topic: null,
    status: "accepted",
    context: "",
    decision: "A private decision.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/private.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [`commit:${commit}`], last_verified: "2026-01-01T00:00:00.000Z" },
    date: "2026-01-01T00:00:00.000Z",
  };

  const prior = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = privateRoot;
  try {
    const store = new HunchStore(hunchPaths(root));
    store.putPrivate("decisions", decision);
    store.close();
  } finally {
    if (prior === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    else process.env.HUNCH_PRIVATE_DIR = prior;
  }

  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(
    queueFile(root),
    JSON.stringify([{ id: decisionId, from: commit, to: "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0" }], null, 2) + "\n",
  );

  return {
    root,
    overlayRoot,
    decisionId,
    env: { ...process.env, HUNCH_PRIVATE_DIR: privateRoot, HUNCH_SYNTH_PROVIDER: "deterministic" },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(overlayRoot, { recursive: true, force: true });
    },
  };
}

test("SessionStart orientation surfaces a queued commit-repair escalation for a private-overlay decision even when the public store has zero decisions", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    const run = spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root,
      env: fixture.env,
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(fixture.decisionId),
      "the public decisions list is empty, but the queued repair is fully answerable via the full store — SessionStart must not bail silently before checking it",
    );
  } finally {
    fixture.cleanup();
  }
});

test("SessionStart orientation surfaces the withheld (never-resolves) wording, not the ordinary --apply-works wording, when the queued `to` doesn't resolve here (#48 follow-up)", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    // The fixture's own queued `to` ("d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0")
    // is well-formed hex but was never a git object in this repo — it's
    // withheld by construction. Guards the SessionStart call site's own
    // `withheldRewrites`/`commitRepairEscalations` wiring specifically:
    // mutating that site to re-read the queue instead of reusing one local
    // (breaking the object-identity contract both functions depend on)
    // would silently fall back to the ordinary wording with no other test
    // catching it.
    const run = spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root,
      env: fixture.env,
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /doesn't resolve in this repository/, "SessionStart must surface the withheld wording");
    assert.doesNotMatch(run.stdout, new RegExp(`--apply --only ${fixture.decisionId} to accept`), "must never advertise an action that's guaranteed to no-op forever");
  } finally {
    fixture.cleanup();
  }
});

test("SessionStart orientation does NOT re-surface a private-overlay commit-repair escalation once its exact triple is tombstoned — the same private-overlay liveness path must respect --drop too", () => {
  const fixture = privateOverlaySessionStartFixture();
  try {
    const queued = (JSON.parse(readFileSync(queueFile(fixture.root), "utf8")) as { id: string; from: string; to: string }[])[0]!;
    writeFileSync(
      join(fixture.root, ".hunch", "dropped-commit-repairs.json"),
      JSON.stringify([{ id: queued.id, from: queued.from, to: queued.to }], null, 2) + "\n",
    );
    const run = spawnSync(process.execPath, [tsx, cli, "hook", "--provider", "claude"], {
      cwd: fixture.root,
      env: fixture.env,
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(
      run.stdout,
      new RegExp(fixture.decisionId),
      "the tombstoned repair must not surface here either — SessionStart shares the same readActivePendingRepairs path as `hunch escalations`, not a raw queue read",
    );
  } finally {
    fixture.cleanup();
  }
});
