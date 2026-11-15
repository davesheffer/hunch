import { cleanupDir } from "./fixtures.js";
/**
 * The fast Stop flush answers the same questions with fewer git spawns: one rev-parse
 * probe instead of several, the code-head walk read in windows, one user-identity listing, one render per grounding
 * variant, and one source snapshot for the record and the card. Each is checked here
 * against what the pre-change code asked git (or computed), on the same fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkedOutBranch, codeHeadOf, commitAndPushHunch, lazyMemoryRepoProbe, onDefaultBranch, probeMemoryRepo,
} from "../src/extractors/git.js";
import { publicCommitHold } from "../src/integrations/sync.js";
import { configListingFromZ, HUNCH_COMMIT_SUBJECT, HUNCH_MANAGED_FILES, userEmailFromZ, USER_CONFIG_LISTING } from "../src/core/taskTouched.js";
import { refreshCommittableGrounding, refreshExistingGrounding, writeAgentsMd, writeCopilotInstructions } from "../src/integrations/providers.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { currentSource, reportSourceSnapshot, trackedSource } from "../src/core/taskReportEvidence.js";
import { beginReportCheck, finishReportTask, readTaskReport, recordReportCheck, recordTaskDelivery, reportHash, startReportTask, type ReportCheck } from "../src/core/taskReport.js";
import { persistTaskRecord } from "../src/core/taskRecord.js";
import { hookReportTaskId, startHookReport, stopHookReport } from "../src/core/taskReportHook.js";
import { buildDeliveryEnvelope } from "../src/core/delivery.js";
import type { AssembledContext } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import type { Decision } from "../src/core/types.js";

const run = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const tryRun = (cwd: string, ...a: string[]): string => { try { return run(cwd, ...a); } catch { return ""; } };

function repo(prefix: string, commit = true): { root: string; hunch: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  run(root, "init", "-q", "-b", "main", ".");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "T");
  run(root, "config", "commit.gpgsign", "false");
  const hunch = join(root, ".hunch");
  mkdirSync(join(hunch, "decisions"), { recursive: true });
  writeFileSync(join(hunch, ".keep"), "");
  if (commit) {
    writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "feat: seed");
  }
  return { root, hunch, cleanup: () => cleanupDir(root) };
}

// ---- the pre-change answers, asked the pre-change way ------------------------------

const baseCurrentBranch = (cwd: string): string => { const b = tryRun(cwd, "rev-parse", "--abbrev-ref", "HEAD"); return b === "HEAD" ? "" : b; };
const baseCheckedOut = (cwd: string): string => {
  const ref = tryRun(cwd, "symbolic-ref", "-q", "HEAD");
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
};
const baseOriginShort = (cwd: string): string => tryRun(cwd, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD");
function baseOnDefaultBranch(cwd: string): boolean {
  const branch = baseCurrentBranch(cwd);
  if (!branch) return false;
  const remoteHead = baseOriginShort(cwd);
  if (remoteHead) return branch === remoteHead.replace(/^origin\//, "");
  return branch === "main" || branch === "master";
}

/** Every layout answer the probe replaces, and the branch answers (which still ask git), against git asked directly. */
function assertProbeMatches(root: string, hunch: string, label: string): void {
  const probe = probeMemoryRepo(hunch);
  assert.ok(probe, `${label}: probe answers`);
  assert.equal(probe.prefix.trim(), run(hunch, "rev-parse", "--show-prefix"), `${label}: prefix`);
  assert.equal(probe.gitDir, run(hunch, "rev-parse", "--absolute-git-dir"), `${label}: git dir`);
  assert.equal(probe.shallow, run(hunch, "rev-parse", "--is-shallow-repository"), `${label}: shallow`);
  assert.equal(checkedOutBranch(root), baseCheckedOut(root), `${label}: checked-out branch`);
  assert.equal(onDefaultBranch(root), baseOnDefaultBranch(root), `${label}: default branch`);
}

test("probe layout and branch answers match git on branch, detached, unborn, ambiguous and worktree layouts", () => {
  const { root, hunch, cleanup } = repo("hunch-probe-eq-");
  try {
    assertProbeMatches(root, hunch, "default branch, no remote");
    run(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    run(root, "update-ref", "refs/remotes/origin/develop", "HEAD");
    run(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assertProbeMatches(root, hunch, "origin/HEAD names main");
    run(root, "switch", "-q", "-c", "feat/x");
    assertProbeMatches(root, hunch, "feature branch");
    run(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    run(root, "switch", "-q", "-c", "develop");
    assertProbeMatches(root, hunch, "origin/HEAD names develop, develop checked out");
    run(root, "branch", "-q", "origin/develop");
    assertProbeMatches(root, hunch, "a local branch shadows the short origin name");
    run(root, "branch", "-q", "-D", "origin/develop");
    run(root, "tag", "develop");
    assertProbeMatches(root, hunch, "a tag shares the branch name");
    run(root, "tag", "-d", "develop");
    run(root, "pack-refs", "--all");
    assertProbeMatches(root, hunch, "packed refs");
    run(root, "checkout", "-q", "--detach");
    assertProbeMatches(root, hunch, "detached HEAD");
    run(root, "checkout", "-q", "--orphan", "fresh");
    assertProbeMatches(root, hunch, "unborn branch");
    const wt = join(root, "..", `${root.split(/[\\/]/).pop()}-wt`);
    run(root, "checkout", "-q", "main");
    run(root, "worktree", "add", "-q", "-b", "wt/branch", wt);
    try {
      mkdirSync(join(wt, ".hunch"), { recursive: true });
      assertProbeMatches(wt, join(wt, ".hunch"), "linked worktree");
    } finally { run(root, "worktree", "remove", "--force", wt); }
  } finally { cleanup(); }
});

/** Whether the policy holds, asked the pre-change way: the same git commands, nothing read from files. */
function baseHolds(root: string, policy: unknown): boolean {
  if (policy === false) return false;
  if (policy === undefined || policy === true) return baseOnDefaultBranch(root);
  if (typeof policy === "object" && policy) {
    const branch = baseCheckedOut(root);
    return !(branch && (policy as { branches: string[] }).branches.includes(branch));
  }
  return true;
}

test("corrupt or odd ref states: checkedOutBranch, onDefaultBranch and publicCommitHold equal base", () => {
  const { root, hunch, cleanup } = repo("hunch-probe-corrupt-");
  const sha = run(root, "rev-parse", "HEAD");
  const states: Array<[string, string]> = [
    ["empty", ""], ["garbage", "garbage\n"], ["sha form feed", `${sha}\f`], ["sha nbsp", `${sha}\u00a0`],
    ["sha plus 24 hex", `${sha}0123456789abcdef01234567\n`], ["short sha", "0123\n"],
  ];
  const check = (label: string): void => {
    assert.equal(checkedOutBranch(root), baseCheckedOut(root), `${label}: checkedOutBranch`);
    assert.equal(onDefaultBranch(root), baseOnDefaultBranch(root), `${label}: onDefaultBranch`);
    for (const policy of [undefined, true, { branches: ["work"] }, { branches: [] }]) {
      writeFileSync(join(hunch, "config.json"), JSON.stringify(policy === undefined ? {} : { auto_commit: policy }));
      assert.equal(publicCommitHold(hunch) !== null, baseHolds(root, policy), `${label}: publicCommitHold ${JSON.stringify(policy)}`);
    }
  };
  try {
    assert.equal(sha.length, 40, "a sha1 repository");
    run(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    run(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    run(root, "switch", "-q", "-c", "work");
    const loose = (...parts: string[]): string => join(root, ".git", "refs", ...parts);
    for (const [name, bad] of states) {
      writeFileSync(loose("remotes", "origin", "main"), bad);
      check(`origin target ${name}`);
      writeFileSync(loose("remotes", "origin", "main"), `${sha}\n`);
      writeFileSync(loose("heads", "work"), bad);
      check(`HEAD target ${name}`);
      writeFileSync(loose("heads", "work"), `${sha}\n`);
    }
    // Refs only in packed-refs, then packed-refs with trailing junk, then unterminated.
    run(root, "pack-refs", "--all");
    check("packed only");
    const packed = join(root, ".git", "packed-refs");
    const text = readFileSync(packed, "utf8");
    writeFileSync(packed, `${text}zzz\n`);
    check("packed-refs with zzz appended");
    writeFileSync(packed, text.replace(/\n$/, ""));
    check("unterminated packed-refs");
    writeFileSync(packed, text.slice(0, text.length - 12));
    check("truncated packed-refs");
  } finally { cleanup(); }
});

/** The pre-change code-head walk: one CODE_HEAD_SEARCH_DEPTH listing, scanned in order. */
function baseCodeHead(hunch: string, isMemoryFile: (file: string) => boolean, shallow: boolean): string {
  const history = tryRun(hunch, "-c", "log.showSignature=false", "-c", "core.quotePath=false", "log", "--first-parent",
    "--no-color", "--name-only", "--max-count=200",
    "--format=%x1e%H%x1f%P%x1f%(trailers:key=Hunch-Code-Head,valueonly,separator=%x20)%x1f%s", "HEAD", "--");
  for (const entry of history.split("\x1e").slice(1)) {
    const [header = "", ...files] = entry.split("\n");
    const [sha = "", parents = "", linked = "", ...subject] = header.split("\x1f");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) break;
    const memoryCommit = linked !== "" || HUNCH_COMMIT_SUBJECT.test(subject.join("\x1f"));
    if (memoryCommit && !parents && shallow) break;
    if (memoryCommit && files.every(isMemoryFile)) continue;
    return sha;
  }
  return "";
}

const windowedCodeHead = (hunch: string, isMemoryFile: (file: string) => boolean, shallow: boolean): string =>
  codeHeadOf((skip, count, from) => tryRun(hunch, "-c", "log.showSignature=false", "-c", "core.quotePath=false", "log", "--first-parent",
    "--no-color", "--name-only", `--max-count=${count}`, ...(skip ? [`--skip=${skip}`] : []),
    "--format=%x1e%H%x1f%P%x1f%(trailers:key=Hunch-Code-Head,valueonly,separator=%x20)%x1f%s", from, "--"), isMemoryFile, shallow);

/** `count` memory commits on top of HEAD, in one fast-import. */
function memoryChain(root: string, count: number, startAt: number): void {
  const parent = run(root, "rev-parse", "HEAD");
  const branch = "refs/hunch-test/chain";
  let stream = "";
  for (let i = 0; i < count; i++) {
    const n = startAt + i;
    const body = `{"id":"dec_${n}"}\n`;
    const msg = `hunch: capture dec_${n}\n`;
    stream += `commit ${branch}\ncommitter T <t@example.com> ${1_700_000_000 + n} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}`;
    if (i === 0) stream += `from ${parent}\n`;
    stream += `M 100644 inline .hunch/decisions/dec_${n}.json\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }
  execFileSync("git", ["-C", root, "fast-import", "--quiet", "--force"], { input: stream, stdio: ["pipe", "ignore", "ignore"] });
  run(root, "checkout", "-q", "--detach", branch);
}

test("the windowed code-head walk names the same commit as one 200-commit listing", () => {
  const { root, hunch, cleanup } = repo("hunch-codehead-eq-");
  try {
    const isMemoryFile = (file: string): boolean => !file || file.startsWith(".hunch/") || HUNCH_MANAGED_FILES.has(file);
    const code = run(root, "rev-parse", "HEAD");
    memoryChain(root, 230, 0);
    const tip = run(root, "rev-parse", "HEAD");
    for (const above of [0, 1, 15, 16, 17, 31, 32, 33, 40, 199, 200, 201, 230]) {
      run(root, "checkout", "-q", "--detach", `${tip}~${230 - above}`);
      const base = baseCodeHead(hunch, isMemoryFile, false);
      assert.equal(windowedCodeHead(hunch, isMemoryFile, false), base, `${above} memory commits above the code head`);
      assert.equal(base, above < 200 ? code : "", `${above}: the fixture means what it says`);
    }
    // A memory commit that also touched code is the code head, wherever it sits.
    run(root, "checkout", "-q", "--detach", `${tip}~200`);
    writeFileSync(join(root, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(hunch, "decisions", "mixed.json"), "{}\n");
    run(root, "add", "-A");
    run(root, "commit", "-qm", "hunch: capture mixed");
    const mixed = run(root, "rev-parse", "HEAD");
    memoryChain(root, 20, 1000);
    assert.equal(windowedCodeHead(hunch, isMemoryFile, false), baseCodeHead(hunch, isMemoryFile, false));
    assert.equal(windowedCodeHead(hunch, isMemoryFile, false), mixed);
    // A shallow clone whose boundary is a memory commit names nothing, both ways.
    const shallowDir = mkdtempSync(join(tmpdir(), "hunch-codehead-shallow-"));
    try {
      execFileSync("git", ["clone", "-q", "--depth", "18", `file://${root.replace(/\\/g, "/")}`, shallowDir], { stdio: "ignore" });
      const sh = join(shallowDir, ".hunch");
      assert.equal(windowedCodeHead(sh, isMemoryFile, true), baseCodeHead(sh, isMemoryFile, true), "shallow, boundary past the first window");
      assert.equal(baseCodeHead(sh, isMemoryFile, true), "");
    } finally { cleanupDir(shallowDir); }
  } finally { cleanup(); }
  const unborn = repo("hunch-codehead-unborn-", false);
  try {
    assert.equal(windowedCodeHead(unborn.hunch, () => true, false), baseCodeHead(unborn.hunch, () => true, false), "unborn branch");
  } finally { unborn.cleanup(); }
});

test("one identity listing gives what config --get user.email and --get-regexp gave", () => {
  const { root, cleanup } = repo("hunch-identity-eq-");
  try {
    const listing = (): string => { try { return execFileSync("git", ["-C", root, ...USER_CONFIG_LISTING], { encoding: "utf8" }); } catch { return ""; } };
    const check = (label: string): void => {
      assert.equal(userEmailFromZ(listing()), tryRun(root, "config", "--get", "user.email"), `${label}: email`);
      let plain = "";
      try { plain = execFileSync("git", ["-C", root, "config", "--get-regexp", "^user\\.(name|email)$"], { encoding: "utf8" }); } catch { /* none */ }
      assert.equal(configListingFromZ(listing()), plain, `${label}: listing`);
    };
    check("both set");
    run(root, "config", "--add", "user.email", "second@example.com");
    check("two emails: the last wins");
    run(root, "config", "--unset-all", "user.email");
    check("name only");
    run(root, "config", "--unset-all", "user.name");
    check("neither");
  } finally { cleanup(); }
});

function decision(id: string, title: string): Decision {
  return {
    id, title, topic: null, status: "accepted", context: "fixture", decision: `Keep the ${title} behavior.`,
    consequences: [], alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null,
    retired: { symbols: [], deps: [] }, provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
}

const DOCS = ["CLAUDE.md", "AGENTS.md", join(".github", "copilot-instructions.md")];

test("the grounding refresh writes what every writer wrote, and leaves unchanged docs untouched", () => {
  const { root, cleanup } = repo("hunch-grounding-eq-");
  try {
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.json.put("decisions", decision("dec_one", "first choice"));
    updateClaudeMd(root, store); writeAgentsMd(root, store); writeCopilotInstructions(root, store);
    run(root, "add", "-A");
    run(root, "commit", "-qm", "baseline");
    const read = (dir: string): string[] => DOCS.map((d) => readFileSync(join(dir, d), "utf8"));

    // Unchanged inputs: nothing to stage, the same bytes, and no rewrite at all.
    const mtimes = DOCS.map((d) => statSync(join(root, d)).mtimeMs);
    const bytes = read(root);
    assert.deepEqual(refreshCommittableGrounding(root, store), []);
    assert.deepEqual(read(root), bytes);
    assert.deepEqual(DOCS.map((d) => statSync(join(root, d)).mtimeMs), mtimes, "a same-bytes write is skipped");

    // Changed inputs: the same docs, with the bytes each writer produces.
    store.json.put("decisions", decision("dec_two", "second choice"));
    const reference = mkdtempSync(join(tmpdir(), "hunch-grounding-ref-"));
    try {
      cpSync(root, reference, { recursive: true });
      const refStore = new HunchStore(hunchPaths(reference));
      refreshExistingGrounding(reference, refStore); // the writers, one by one
      refStore.close();
      const changed = refreshCommittableGrounding(root, store);
      assert.deepEqual(changed.map((f) => f.slice(root.length + 1)).sort(), [...DOCS].sort());
      assert.deepEqual(read(root), read(reference));
    } finally { cleanupDir(reference); }

    // Stale-dirty, generated-only: staged even though the regeneration is a byte no-op.
    run(root, "commit", "-qam", "refresh");
    const claude = join(root, "CLAUDE.md");
    writeFileSync(claude, readFileSync(claude, "utf8").replace(/\b2 decisions\b/, "1 decisions"));
    run(root, "add", "CLAUDE.md");
    run(root, "commit", "-qm", "stale block committed");
    store.json.put("decisions", decision("dec_three", "third choice"));
    writeFileSync(claude, readFileSync(claude, "utf8").replace(/\b1 decisions\b/, "3 decisions"));
    const healed = refreshCommittableGrounding(root, store);
    assert.ok(healed.includes(claude), "a generated-only dirty doc is staged");
    store.close();
  } finally { cleanup(); }
});

test("the card's reused snapshot equals a fresh one after the flush rewrote grounding docs", () => {
  const { root, cleanup } = repo("hunch-snapshot-eq-");
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# doc\n");
    writeFileSync(join(root, "sub", "AGENTS.md"), "# nested\n");
    writeFileSync(join(root, "notes.md"), "untracked\n");
    run(root, "add", "CLAUDE.md", "sub/AGENTS.md");
    run(root, "commit", "-qm", "docs");
    const never = trackedSource(root);
    never.refresh();
    assert.equal(never(), reportSourceSnapshot(root).hash, "a snapshot never taken is taken fresh");
    const source = trackedSource(root);
    const before = source();
    assert.equal(before, reportSourceSnapshot(root).hash);
    source.refresh();
    assert.equal(source(), reportSourceSnapshot(root).hash, "no rewrite");
    writeFileSync(join(root, "CLAUDE.md"), "# doc\nrefreshed counts\n");
    writeFileSync(join(root, "sub", "AGENTS.md"), "# nested\nrefreshed\n");
    writeFileSync(join(root, ".hunch", "decisions", "new.json"), "{}\n"); // excluded from the snapshot
    assert.equal(source(), before, "cached until refreshed");
    source.refresh();
    assert.equal(source(), reportSourceSnapshot(root).hash, "rewritten grounding docs are hashed again");
    assert.notEqual(source(), before);
    writeFileSync(join(root, "CLAUDE.md"), "# doc\nsecond flush\n");
    source.refresh();
    assert.equal(source(), reportSourceSnapshot(root).hash, "every refresh follows the latest flush");
  } finally { cleanup(); }
});

function deliveryEnvelope() {
  const ctx = { target: "app.ts", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], findings: [], budget_tokens: 1500 } as unknown as AssembledContext;
  ctx.constraints.push({ id: "con_preserve", type: "architecture", statement: "Preserve existing settings", scope: ["app.ts"], severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null, violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } });
  return buildDeliveryEnvelope(ctx);
}
const lesson = { record_id: "con_preserve", kind: "constraints", title: "Preserve existing settings", lesson: "Merge settings; preserve values outside the update.", content_hash: reportHash("fixture record revision"), recorded_at: "2026-09-11T00:00:00.000Z" };

test("each record of a two-task Stop, and the card, see the tree the previous flush left", () => {
  const { root, cleanup } = repo("hunch-two-records-");
  const store = new HunchStore(hunchPaths(root));
  try {
    writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
    store.json.ensureDirs();
    store.json.put("decisions", decision("dec_one", "first choice"));
    updateClaudeMd(root, store); writeAgentsMd(root, store);
    run(root, "add", "-A");
    run(root, "commit", "-qm", "baseline");
    run(root, "checkout", "-q", "-b", "work"); // off the default branch: each flush commits
    // The committed docs now count one decision too few: the first flush rewrites them.
    store.json.put("decisions", decision("dec_two", "second choice"));
    // Each task ran a check on the tree as it is now: current until a flush rewrites a doc.
    const check = (taskId: string): ReportCheck => ({ check_id: beginReportCheck(root, taskId, "typecheck"), label: "typecheck", command: ["node", "-e", "0"], exit_code: 0,
      output_hash: reportHash("output"), before_snapshot: reportSourceSnapshot(root).hash, after_snapshot: reportSourceSnapshot(root).hash,
      snapshot_limitations: [], timed_out: false, source: "local-command-runner" });
    const first = startReportTask(root, "Fix settings merge");
    recordTaskDelivery(root, first.task_id, deliveryEnvelope(), [lesson]);
    recordReportCheck(root, first.task_id, check(first.task_id));
    finishReportTask(root, first.task_id);
    const event = { hook_event_name: "Stop", cwd: root, session_id: "session-two", prompt_id: "prompt-two" } as Parameters<typeof startHookReport>[2];
    assert.ok(startHookReport(root, "claude", event), "the hook task opens");
    const second = hookReportTaskId(root, "claude", event);
    assert.ok(second, "the hook task has an id");
    recordTaskDelivery(root, second, deliveryEnvelope(), [lesson]);
    recordReportCheck(root, second, check(second));
    finishReportTask(root, second, "completed", { by: "host" });

    const docs = (): string => ["CLAUDE.md", "AGENTS.md"].map((d) => readFileSync(join(root, d), "utf8")).join("\0");
    const stale = docs();
    // The Stop loop (hookCommand): one tracked source, refreshed after every record.
    const source = trackedSource(root);
    for (const [i, id] of [first.task_id, second].entries()) {
      // What the pre-change code hashed: a fresh snapshot when this record is persisted.
      const fresh = readTaskReport(root, id, currentSource(root));
      assert.equal(fresh.checks[0]?.current, i === 0, `record ${i + 1}: its check is current only until the first flush`);
      const expected = fresh.content_hash;
      let saved;
      try { saved = persistTaskRecord(root, store, id, { source }); } finally { source.refresh(); }
      assert.ok(saved?.flushed, `record ${i + 1} is written and flushed`);
      assert.equal(saved.record.report_hash, expected, `record ${i + 1}: the report hash a fresh snapshot gives`);
      if (i === 0) assert.notEqual(docs(), stale, "the first flush rewrote the stale grounding docs");
    }
    const card = stopHookReport(root, "claude", event, source);
    assert.ok(card, "the card renders");
    assert.deepEqual(card, stopHookReport(root, "claude", event), "the card equals one read from a fresh snapshot");
  } finally { store.close(); cleanup(); }
});

test("a memory directory linked into another repository never answers for its parent", (t) => {
  const owner = repo("hunch-link-owner-");
  const { root, cleanup } = repo("hunch-link-cwd-");
  const linked = join(root, ".hunch");
  let made = false;
  try {
    run(owner.root, "checkout", "-q", "-b", "owner-branch");
    run(owner.root, "config", "user.email", "owner@example.com");
    cleanupDir(linked);
    try { symlinkSync(owner.hunch, linked, "junction"); made = true; } catch { t.skip("this platform cannot link a directory"); return; }
    const probe = probeMemoryRepo(linked);
    assert.ok(probe && probe.prefix !== "", "the probe answers for the linked repository");
    assert.equal(checkedOutBranch(root), baseCheckedOut(root), "checked-out branch");
    assert.equal(checkedOutBranch(root), "main");
    assert.equal(onDefaultBranch(root), baseOnDefaultBranch(root), "default branch");

    // The identity listing read in the parent is not the linked repository's.
    const listedZ = execFileSync("git", ["-C", root, ...USER_CONFIG_LISTING], { encoding: "utf8" });
    const author = (): string => run(owner.root, "log", "-1", "--format=%ae");
    writeFileSync(join(owner.hunch, "decisions", "a.json"), "{}\n");
    assert.equal(commitAndPushHunch(linked, "hunch: capture dec_a", { push: false }), "committed");
    const without = author();
    writeFileSync(join(owner.hunch, "decisions", "b.json"), "{}\n");
    const facts = { probe: lazyMemoryRepoProbe(linked), userConfig: { cwd: root, listedZ } };
    assert.equal(commitAndPushHunch(linked, "hunch: capture dec_b", { push: false, facts }), "committed");
    assert.equal(author(), without, "commit identity with and without the shared listing");
  } finally {
    if (made) { try { rmdirSync(linked); } catch { try { unlinkSync(linked); } catch { /* left to cleanup */ } } }
    cleanup(); owner.cleanup();
  }
});
