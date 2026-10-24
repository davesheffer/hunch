import { randomUUID } from "node:crypto";
import { cleanupDir } from "./fixtures.js";
@@CLEANROOM_HOLE_1@@
import { commitRepairReviewHash } from "../src/core/commitrepair.js";
import { readActivePendingRepairs, withheldRewrites } from "../src/core/repairqueue.js";
@@CLEANROOM_HOLE_2@@
import { commitPatchIds, commitRepairStatus, commitRepairStatusAgainst } from "../src/extractors/git.js";
@@CLEANROOM_HOLE_3@@
function runCliRaw(root: string, ...args: string[]) {
@@CLEANROOM_HOLE_4@@
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

@@CLEANROOM_HOLE_5@@
  return { root, decisionFile, oldRef: origHead, newRef: newHead, origCommit, cleanup: () => cleanupDir(root) };
@@CLEANROOM_HOLE_6@@
    cleanup: () => cleanupDir(root),
@@CLEANROOM_HOLE_7@@
    assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "escalations says --apply --only works for the resolvable entry, despite it not being first-queued");
@@CLEANROOM_HOLE_8@@
    assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "escalations must not claim --drop dec_a rejects the resolvable entry — it targets the withheld one instead");
@@CLEANROOM_HOLE_9@@
    cleanupDir(root);
@@CLEANROOM_HOLE_10@@
      cleanupDir(root);
      cleanupDir(overlayRoot);
@@CLEANROOM_HOLE_11@@
test("a prompt naming the decision's file surfaces a queued commit-repair escalation for a private-overlay decision even when the public store has zero decisions", () => {
@@CLEANROOM_HOLE_12@@
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `s-${randomUUID()}`, prompt: "fix the bug in src/private.ts" }),
@@CLEANROOM_HOLE_13@@
      "the public decisions list is empty, but the queued repair is fully answerable via the full store — the prompt hook must check it",
@@CLEANROOM_HOLE_14@@
test("the prompt hook surfaces the withheld (never-resolves) wording, not the ordinary --apply-works wording, when the queued `to` doesn't resolve here (#48 follow-up)", () => {
@@CLEANROOM_HOLE_15@@
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `s-${randomUUID()}`, prompt: "fix the bug in src/private.ts" }),
@@CLEANROOM_HOLE_16@@
    assert.match(run.stdout, /doesn't resolve in this repository/, "the prompt hook must surface the withheld wording");
@@CLEANROOM_HOLE_17@@
test("the prompt hook does NOT re-surface a private-overlay commit-repair escalation once its exact triple is tombstoned — the same private-overlay liveness path must respect --drop too", () => {
@@CLEANROOM_HOLE_18@@
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `s-${randomUUID()}`, prompt: "fix the bug in src/private.ts" }),
@@CLEANROOM_HOLE_19@@
      "the tombstoned repair must not surface here either — the prompt hook shares the same readActivePendingRepairs path as `hunch escalations`, not a raw queue read",
@@CLEANROOM_HOLE_20@@


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
