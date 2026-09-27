import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireLock, fastForwardMain, heldByClosedPr, memoryBranch, planShip } from "../tooling/ship-memory.mjs";

type Fixture = { root: string; work: string; other: string; git: (cwd: string, ...args: string[]) => string };

/** A bare "origin" plus two clones: `work` (this machine) and `other` (everyone else). */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hunch-ship-memory-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", work);
  for (const dir of [work]) {
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "commit.gpgsign", "false");
  }
  mkdirSync(join(work, "src"));
  mkdirSync(join(work, ".hunch", "decisions"), { recursive: true });
  writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(work, ".hunch", "decisions", "dec_1.json"), `${JSON.stringify({ id: "dec_1", title: "seed" })}\n`);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  git(work, "fetch", "-q", "origin");
  git(root, "clone", "-q", origin, other);
  git(other, "config", "user.email", "other@example.com");
  git(other, "config", "user.name", "Other");
  git(other, "config", "commit.gpgsign", "false");
  return { root, work, other, git };
}

function commitFile(f: Fixture, dir: string, path: string, content: string, message = `touch ${path}`) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  f.git(dir, "add", "--", path);
  f.git(dir, "commit", "-q", "-m", message);
}

const record = (id: string, title: string) => `${JSON.stringify({ id, title })}\n`;

test("memory commits on local main ship; nothing unpushed ships nothing", () => {
  const f = fixture();
  try {
    assert.equal(planShip({ cwd: f.work }).status, "nothing");
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"));
    commitFile(f, f.work, "CLAUDE.md", "grounding\n");
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "ship");
    assert.equal(plan.commits.length, 2);
    assert.deepEqual(plan.paths, [".hunch/tasks/htask_1.json", "CLAUDE.md"]);
  } finally { cleanupDir(f.root); }
});

test("a source path anywhere in the range refuses, even when a later commit removes it", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"));
    commitFile(f, f.work, "src/b.ts", "export const b = 2;\n");
    f.git(f.work, "rm", "-q", "src/b.ts");
    f.git(f.work, "commit", "-q", "-m", "drop b");
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-outside");
    assert.deepEqual(plan.outside, ["src/b.ts"]);
  } finally { cleanupDir(f.root); }
});

test("a record the publication scanner flags refuses: secrets, machine paths, private vocabulary", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", `${JSON.stringify({ id: "fnd_1", title: "token", evidence: `ghp_${"a".repeat(36)}` })}\n`);
    let plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { kind: string; file: string }) => h.kind === "secret-material" && h.file === ".hunch/findings/fnd_1.json"));
    assert.ok(!JSON.stringify(plan.hits).includes("a".repeat(20)), "a live credential is never echoed");

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/findings/fnd_2.json", record("fnd_2", "seen at C:\\Users\\dsmith\\work\\app"));
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.equal(plan.hits[0].kind, "machine-path");

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(f.work, ".hunch", "publication.local.json"), JSON.stringify({ vocabulary: ["zorblax"] }));
    commitFile(f, f.work, ".hunch/findings/fnd_3.json", record("fnd_3", "Zorblax pricing teardown"));
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.equal(plan.hits[0].kind, "market-vocabulary");
  } finally { cleanupDir(f.root); }
});

test("the scan reads every shipped commit, not just the tip", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", `${JSON.stringify({ id: "fnd_1", title: "token", evidence: `ghp_${"a".repeat(36)}` })}\n`);
    const leaked = f.git(f.work, "rev-parse", "--short", "HEAD");
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", record("fnd_1", "token (redacted)"));
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication", "history still carries the secret the tip redacted");
    assert.ok(plan.hits.some((h: { kind: string; file: string; commit: string }) => h.kind === "secret-material" && h.file === ".hunch/findings/fnd_1.json" && h.commit === leaked));
    assert.ok(!JSON.stringify(plan.hits).includes("a".repeat(20)), "a live credential is never echoed");
  } finally { cleanupDir(f.root); }
});

test("non-JSON files and commit messages are scanned too", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, "CLAUDE.md", "seen at C:\\Users\\dsmith\\x\n");
    let plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { kind: string; file: string }) => h.kind === "machine-path" && h.file === "CLAUDE.md"));

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/evidence/note.md", `token ghp_${"b".repeat(36)}\n`);
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { kind: string; file: string }) => h.kind === "secret-material" && h.file === ".hunch/evidence/note.md"));

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"), `hunch: task with ghp_${"c".repeat(36)}`);
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    const sha = f.git(f.work, "rev-parse", "--short", "HEAD");
    assert.ok(plan.hits.some((h: { kind: string; file: string }) => h.kind === "secret-material" && h.file === `commit ${sha} message`));
    assert.ok(!JSON.stringify(plan.hits).includes("c".repeat(20)), "a live credential is never echoed");
  } finally { cleanupDir(f.root); }
});

test("private vocabulary anywhere in a record refuses: nested values, arrays, keys, path names", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, ".hunch", "publication.local.json"), JSON.stringify({ vocabulary: ["zorblax"] }));
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", `${JSON.stringify({ id: "fnd_1", title: "clean title", evidence: ["Zorblax pricing teardown"] })}\n`);
    let plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication", "evidence[] is not a prose key, and publishes all the same");
    assert.ok(plan.hits.some((h: { kind: string; field: string }) => h.kind === "market-vocabulary" && h.field === "evidence[0]"));

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", `${JSON.stringify({ id: "htask_1", title: "t", lessons: [{ title: "zorblax" }], by: { "zorblax-ref": 1 } })}\n`);
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { field: string }) => h.field === "lessons[0].title"));
    assert.ok(plan.hits.some((h: { field: string }) => h.field === "by.zorblax-ref (key)"));

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/findings/zorblax-notes.json", record("fnd_2", "clean"));
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { field: string }) => h.field === "path"));
  } finally { cleanupDir(f.root); }
});

test("a path quoted inside a JSON payload refuses at every encoding level", () => {
  const f = fixture();
  try {
    const payload = JSON.stringify({ cwd: "C:\\Users\\dsmith\\secret-client\\app" });
    assert.ok(payload.includes("\\\\"), "the payload carries its own escaping");
    const cases: Array<[string, () => void]> = [
      [".hunch/findings/fnd_n.json", () => commitFile(f, f.work, ".hunch/findings/fnd_n.json", `${JSON.stringify({ id: "fnd_n", title: "t", evidence: payload })}\n`)],
      ["CLAUDE.md", () => commitFile(f, f.work, "CLAUDE.md", `hook payload: ${payload}\n`)],
      ["message", () => commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"), `hunch: task ${payload}`)],
      [".hunch/findings/fnd_o.json", () => commitFile(f, f.work, ".hunch/findings/fnd_o.json", `${JSON.stringify({ id: "fnd_o", title: "t", evidence: JSON.stringify({ p: ".hunch-private\\exp\\cases.json" }) })}\n`)],
    ];
    for (const [name, commit] of cases) {
      f.git(f.work, "reset", "-q", "--hard", "origin/main");
      commit();
      const plan = planShip({ cwd: f.work });
      assert.equal(plan.status, "refused-publication", name);
      assert.ok(plan.hits.some((h: { kind: string }) => h.kind === "machine-path" || h.kind === "private-overlay-path"), name);
    }
  } finally { cleanupDir(f.root); }
});

test("replacement refs cannot show the scan a history the push does not send", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_r.json", `${JSON.stringify({ id: "fnd_r", title: "t", evidence: `ghp_${"a".repeat(36)}` })}\n`);
    const real = f.git(f.work, "rev-parse", "HEAD");
    f.git(f.work, "checkout", "-q", "-b", "clean", "origin/main");
    commitFile(f, f.work, ".hunch/findings/fnd_r.json", record("fnd_r", "clean"));
    const clean = f.git(f.work, "rev-parse", "HEAD");
    f.git(f.work, "checkout", "-q", "main");
    f.git(f.work, "replace", real, clean);
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.tip, real);
    assert.equal(plan.status, "refused-publication");
  } finally { cleanupDir(f.root); }
});

test("a grafts file stops the shipper: the scan could walk a history the push does not send", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"));
    mkdirSync(join(f.work, ".git", "info"), { recursive: true });
    writeFileSync(join(f.work, ".git", "info", "grafts"), "");
    assert.throws(() => planShip({ cwd: f.work }), /grafts file is in use/);
  } finally { cleanupDir(f.root); }
});

test("a PHP-escaped path refuses too; a quoted path regex does not", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_p.json", `${JSON.stringify({ id: "fnd_p", title: "t", evidence: String.raw`{"cwd":"\/home\/dsmith\/app"}` })}\n`);
    assert.equal(planShip({ cwd: f.work }).status, "refused-publication");

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/findings/fnd_q.json", `${JSON.stringify({ id: "fnd_q", title: "t", evidence: [String.raw`rule: \/home\/([^/]+)`, JSON.stringify(String.raw`C:\Users\([^\]+)`)] })}\n`);
    assert.equal(planShip({ cwd: f.work }).status, "ship", "a pattern names no user");
  } finally { cleanupDir(f.root); }
});

test("a vocabulary file behind an unreadable link refuses instead of reading as absent", (t) => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", record("fnd_1", "clean"));
    try { symlinkSync("publication.local.json", join(f.work, ".hunch", "publication.local.json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("creating a symlink needs a privilege here"); return; }
      throw error;
    }
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.equal(plan.hits[0].kind, "unreadable-vocabulary");
  } finally { cleanupDir(f.root); }
});

test("bytes JSON.parse drops still publish: a duplicate key is scanned as raw text", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_d.json", `{"id":"fnd_d","title":"ghp_${"a".repeat(36)}","title":"clean"}\n`);
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { kind: string; field: string }) => h.kind === "secret-material" && h.field === "$raw"));
  } finally { cleanupDir(f.root); }
});

test("rewriting an already-public record does not wedge the shipper; only new flagged bytes refuse", () => {
  const f = fixture();
  try {
    const published = { id: "dec_p", title: "Compete with Zorblax on onboarding", status: "accepted" };
    commitFile(f, f.work, ".hunch/decisions/dec_p.json", `${JSON.stringify(published)}\n`);
    f.git(f.work, "push", "-q", "origin", "main");
    f.git(f.work, "fetch", "-q", "origin");
    writeFileSync(join(f.work, ".hunch", "publication.local.json"), JSON.stringify({ vocabulary: ["zorblax"] }));

    commitFile(f, f.work, ".hunch/decisions/dec_p.json", `${JSON.stringify({ ...published, status: "superseded" })}\n`);
    let plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "ship", "a status flip adds no new flagged bytes");

    commitFile(f, f.work, ".hunch/decisions/dec_p.json", `${JSON.stringify({ ...published, status: "superseded", notes: "Zorblax price list attached" })}\n`);
    plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication", "a new occurrence is new bytes");
    assert.ok(plan.hits.every((h: { kind: string; excerpt: string }) => h.kind === "market-vocabulary" && h.excerpt.includes("price list")));

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/decisions/dec_p.json", `${JSON.stringify({ ...published, title: "Compete with Zorblax on onboarding, again" })}\n`);
    assert.equal(planShip({ cwd: f.work }).status, "refused-publication", "edited text around the term is new text");
  } finally { cleanupDir(f.root); }
});

test("a long match excuses nothing past what is public: the excuse compares exact text, not the clipped excerpt", () => {
  const f = fixture();
  try {
    const head = `Zorblax ${"x".repeat(130)}`;
    commitFile(f, f.work, ".hunch/decisions/dec_l.json", `${JSON.stringify({ id: "dec_l", title: head })}\n`);
    f.git(f.work, "push", "-q", "origin", "main");
    f.git(f.work, "fetch", "-q", "origin");
    writeFileSync(join(f.work, ".hunch", "publication.local.json"), JSON.stringify({ vocabulary: ["zorblax[^\"]*"] }));
    commitFile(f, f.work, ".hunch/decisions/dec_l.json", `${JSON.stringify({ id: "dec_l", title: `${head} and the new price list` })}\n`);
    assert.equal(planShip({ cwd: f.work }).status, "refused-publication", "the logged excerpts are identical; the matched text is not");

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/decisions/dec_l.json", `${JSON.stringify({ id: "dec_l", title: `${head.replace(" ", "\t")}` })}\n`);
    assert.equal(planShip({ cwd: f.work }).status, "refused-publication", "whitespace the excerpt collapses is still a different byte");
  } finally { cleanupDir(f.root); }
});

test("an already-public secret never excuses a new one, even with the same prefix", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_s.json", `${JSON.stringify({ id: "fnd_s", title: "t", evidence: `ghp_${"a".repeat(36)}` })}\n`);
    f.git(f.work, "push", "-q", "origin", "main");
    f.git(f.work, "fetch", "-q", "origin");
    commitFile(f, f.work, ".hunch/findings/fnd_s.json", `${JSON.stringify({ id: "fnd_s", title: "t", evidence: `ghp_${"a".repeat(35)}b` })}\n`);
    assert.equal(planShip({ cwd: f.work }).status, "refused-publication");
  } finally { cleanupDir(f.root); }
});

test("a linked worktree reads the primary checkout's gitignored vocabulary", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, ".hunch", "publication.local.json"), JSON.stringify({ vocabulary: ["zorblax"] }));
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", record("fnd_1", "Zorblax pricing"));
    const linked = join(f.root, "linked");
    f.git(f.work, "worktree", "add", "-q", "--detach", linked);
    assert.ok(!existsSync(join(linked, ".hunch", "publication.local.json")), "the local list is not in the linked checkout");
    assert.equal(planShip({ cwd: linked }).status, "refused-publication");
  } finally { cleanupDir(f.root); }
});

test("a vocabulary file that exists but cannot be read refuses instead of scanning with nothing", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", record("fnd_1", "clean"));
    for (const broken of ["{not json", JSON.stringify({ vocabulary: ["("] }), JSON.stringify({ terms: ["x"] })]) {
      writeFileSync(join(f.work, ".hunch", "publication.local.json"), broken);
      const plan = planShip({ cwd: f.work });
      assert.equal(plan.status, "refused-publication", broken);
      assert.equal(plan.hits[0].kind, "unreadable-vocabulary");
    }
  } finally { cleanupDir(f.root); }
});

test("the scanner's own vocabulary never ships automatically", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, ".hunch", "publication.local.json"), JSON.stringify({ vocabulary: ["zorblax"] }));
    f.git(f.work, "add", "-f", ".hunch/publication.local.json");
    f.git(f.work, "commit", "-q", "-m", "oops");
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-outside");
    assert.deepEqual(plan.outside, [".hunch/publication.local.json"]);
  } finally { cleanupDir(f.root); }
});

test("a blob that cannot be read refuses; only a deletion is skipped", () => {
  const f = fixture();
  try {
    const seed = f.git(f.work, "rev-parse", "HEAD");
    f.git(f.work, "update-index", "--add", "--cacheinfo", `160000,${seed},.hunch/vendored`);
    f.git(f.work, "commit", "-q", "-m", "gitlink");
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "refused-publication");
    assert.ok(plan.hits.some((h: { kind: string; file: string }) => h.kind === "unreadable" && h.file === ".hunch/vendored"));
  } finally { cleanupDir(f.root); }
});

test("a PR closed unmerged holds every later tip that still carries its commits", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", record("fnd_1", "rejected by a human"));
    const rejected = f.git(f.work, "rev-parse", "HEAD");
    const base = f.git(f.work, "rev-parse", "origin/main");
    const prs = [{ number: 7, headRefOid: rejected, mergedAt: null }];
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a hook commit"));
    assert.equal(heldByClosedPr(f.work, prs, f.git(f.work, "rev-parse", "HEAD"), base)?.number, 7, "a new tip on top is still held");
    assert.equal(heldByClosedPr(f.work, [{ ...prs[0], mergedAt: "2026-09-27T00:00:00Z" }], f.git(f.work, "rev-parse", "HEAD"), base), null, "a merged PR holds nothing");
    assert.equal(heldByClosedPr(f.work, [{ number: 8, headRefOid: "f".repeat(40), mergedAt: null }], f.git(f.work, "rev-parse", "HEAD"), base), null, "a head absent here is not in tip's history");
    assert.equal(heldByClosedPr(f.work, prs, f.git(f.work, "rev-parse", "HEAD"), f.git(f.work, "rev-parse", "HEAD")), null, "commits that reached origin/main another way are public already");
    assert.equal(heldByClosedPr(f.work, [{ ...prs[0], headRefOid: rejected.toUpperCase() }], f.git(f.work, "rev-parse", "HEAD"), base)?.number, 7, "an oid in upper case names the same commit");
    assert.throws(() => heldByClosedPr(f.work, [{ number: 9, headRefOid: "", mergedAt: null }], f.git(f.work, "rev-parse", "HEAD"), base), /no usable head oid/, "an unusable oid is not an answer");

    f.git(f.work, "reset", "-q", "--hard", "origin/main");
    commitFile(f, f.work, ".hunch/tasks/htask_2.json", record("htask_2", "after the human dropped it"));
    assert.equal(heldByClosedPr(f.work, prs, f.git(f.work, "rev-parse", "HEAD"), base), null, "dropped from main: shipping resumes");
  } finally { cleanupDir(f.root); }
});

test("a record deleted later is not a read failure", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/findings/fnd_1.json", record("fnd_1", "clean"));
    f.git(f.work, "rm", "-q", ".hunch/findings/fnd_1.json");
    f.git(f.work, "commit", "-q", "-m", "drop fnd_1");
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "ship");
    assert.deepEqual(plan.hits, []);
  } finally { cleanupDir(f.root); }
});

test("a local merge of origin/main does not drag origin's code into the verdict", () => {
  const f = fixture();
  try {
    commitFile(f, f.other, "src/c.ts", "export const c = 3;\n");
    f.git(f.other, "push", "-q", "origin", "main");
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"));
    // fetch + merge, not `pull origin main`: pull's message names origin's URL, a temp-dir
    // machine path here, and commit messages are scanned now.
    f.git(f.work, "fetch", "-q", "origin");
    f.git(f.work, "merge", "-q", "--no-edit", "origin/main");
    const plan = planShip({ cwd: f.work });
    assert.equal(plan.status, "ship");
    assert.deepEqual(plan.paths, [".hunch/tasks/htask_1.json"]);
  } finally { cleanupDir(f.root); }
});

test("local main fast-forwards to the merged remote only when nothing can be lost", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"));
    f.git(f.work, "push", "-q", "origin", "main:refs/heads/memory/test");
    f.git(f.other, "fetch", "-q", "origin");
    f.git(f.other, "merge", "-q", "--no-ff", "--no-edit", "origin/memory/test");
    f.git(f.other, "push", "-q", "origin", "main");
    f.git(f.work, "fetch", "-q", "origin");
    assert.equal(planShip({ cwd: f.work }).status, "nothing", "merged upstream: nothing left to ship");

    writeFileSync(join(f.work, "src", "a.ts"), "export const a = 2;\n");
    assert.equal(fastForwardMain(f.work), "dirty", "a tracked edit in the checkout blocks the fast-forward");
    f.git(f.work, "checkout", "-q", "--", "src/a.ts");
    assert.equal(fastForwardMain(f.work), "fast-forwarded");
    assert.equal(f.git(f.work, "rev-parse", "HEAD"), f.git(f.work, "rev-parse", "origin/main"));
    assert.equal(fastForwardMain(f.work), "current");

    commitFile(f, f.work, ".hunch/tasks/htask_2.json", record("htask_2", "later"));
    commitFile(f, f.other, "src/d.ts", "export const d = 4;\n");
    f.git(f.other, "push", "-q", "origin", "main");
    f.git(f.work, "fetch", "-q", "origin");
    assert.equal(fastForwardMain(f.work), "diverged", "unshipped local commits are never discarded");
  } finally { cleanupDir(f.root); }
});

test("a rebase of main in progress blocks the fast-forward", () => {
  const f = fixture();
  try {
    f.git(f.work, "branch", "side");
    commitFile(f, f.work, "x.txt", "main\n");
    f.git(f.work, "push", "-q", "origin", "main");
    f.git(f.other, "pull", "-q", "--ff-only");
    commitFile(f, f.other, ".hunch/tasks/htask_9.json", record("htask_9", "upstream"));
    f.git(f.other, "push", "-q", "origin", "main");
    f.git(f.work, "fetch", "-q", "origin");
    f.git(f.work, "checkout", "-q", "side");
    commitFile(f, f.work, "x.txt", "side\n");
    f.git(f.work, "checkout", "-q", "main");
    const before = f.git(f.work, "rev-parse", "refs/heads/main");
    assert.throws(() => f.git(f.work, "rebase", "side"), "the rebase stops on its conflict");
    try {
      assert.equal(fastForwardMain(f.work), "blocked");
      assert.equal(f.git(f.work, "rev-parse", "refs/heads/main"), before, "main is untouched mid-rebase");
    } finally { f.git(f.work, "rebase", "--abort"); }
    assert.equal(fastForwardMain(f.work), "fast-forwarded", "the same fast-forward proceeds once the rebase is gone");
  } finally { cleanupDir(f.root); }
});

test("one shipper at a time; a stale lock is reclaimed only from a dead owner", () => {
  const f = fixture();
  try {
    const release = acquireLock(f.work);
    assert.ok(release);
    assert.equal(acquireLock(f.work), null);
    const lock = join(f.work, ".git", "hunch-ship-memory.lock");
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(lock, old, old);
    assert.equal(acquireLock(f.work), null, "a live owner past the stale bound is slow, not dead");

    const dead = 999999999;
    assert.throws(() => process.kill(dead, 0), "the fixture pid is not a live process");
    writeFileSync(lock, `${dead} ${old.toISOString()}\n`);
    utimesSync(lock, old, old);
    const again = acquireLock(f.work);
    assert.ok(again, "a stale lock whose owner is gone is taken over");

    writeFileSync(lock, `${dead} ${new Date().toISOString()}\n`);
    again!();
    release!();
    assert.ok(existsSync(lock), "a release never removes a lock another pid rewrote");
  } finally { cleanupDir(f.root); }
});

test("the holder renews its lock; a lock past the hard bound is a recycled pid and is reclaimed", () => {
  const f = fixture();
  try {
    const release = acquireLock(f.work) as (() => void) & { renew: (at?: Date) => void };
    const lock = join(f.work, ".git", "hunch-ship-memory.lock");
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(lock, old, old);
    release.renew();
    assert.ok(Date.now() - statSync(lock).mtimeMs < 60_000, "renew refreshes the lease");

    const ancient = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(lock, ancient, ancient);
    const taken = acquireLock(f.work);
    assert.ok(taken, "our own pid looks alive, but no live holder leaves its lock unrenewed for hours");
    taken!();
  } finally { cleanupDir(f.root); }
});

test("the branch name is stable per host and does not publish the host's name", () => {
  assert.match(memoryBranch("DAVID-PC"), /^memory\/host-[0-9a-f]{10}$/);
  assert.ok(!memoryBranch("DAVID-PC").includes("david"));
  assert.equal(memoryBranch("DAVID-PC"), memoryBranch("david-pc"));
  assert.notEqual(memoryBranch("david-pc"), memoryBranch("other-pc"));
});

test("the CLI dry run fetches, plans, and pushes nothing", () => {
  const f = fixture();
  try {
    commitFile(f, f.work, ".hunch/tasks/htask_1.json", record("htask_1", "a task"));
    const run = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "tooling", "ship-memory.mjs"), "--cwd", f.work, "--dry-run"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /would push 1 commit\(s\) \(1 path\(s\)\) to memory\//);
    assert.equal(f.git(f.work, "ls-remote", "origin", "refs/heads/memory/*"), "", "a dry run pushes nothing");

    commitFile(f, f.work, "src/e.ts", "export const e = 5;\n");
    const refused = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "tooling", "ship-memory.mjs"), "--cwd", f.work, "--dry-run"], { encoding: "utf8" });
    assert.equal(refused.status, 3);
    assert.match(refused.stdout, /refused: 1 path\(s\) outside the memory-only class .*src\/e\.ts/);
  } finally { cleanupDir(f.root); }
});
