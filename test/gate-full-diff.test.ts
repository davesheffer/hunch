/**
 * Constraint gates evaluate the COMPLETE diff and fail closed when they cannot.
 *
 *  - A staged/commit/range diff is no longer cut at the synthesis byte budget before
 *    `hunch check` reads it, so a forbidden import in a file after the old 60 KB cutoff
 *    is still seen.
 *  - When the gate's diff is truncated, git could not produce it, or a file's content
 *    could not be read, a content-matched BLOCKING constraint over an affected file is
 *    reported as unevaluable and counts toward the strict gate (dec_20db57c576).
 *  - Paths git C-quotes (non-ASCII under the default quotePath; `"`, `\`, tab, newline
 *    always) map back to the real file, so their added lines are content-checked.
 *  - Synthesis prompts keep the bounded diff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { reportFailsStrict, renderMarkdown, renderText, verdict } from "../src/core/checkreport.js";
import { analyzeDiff, diffBlockFiles, unquoteGitPath } from "../src/extractors/diff.js";
import {
  commitDiff, commitGateDiff, rangeGateDiff, stagedDiff, stagedFiles, stagedGateDiff,
  SYNTHESIS_DIFF_BUDGET, workingFiles, workingGateDiff,
} from "../src/extractors/git.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const IMPORT = 'import _ from "lodash";';
// Git on Windows filesystems cannot hold `"` or a tab in a file name.
const QUOTED_NAME_SKIP = process.platform === "win32" ? "file names with '\"' or tab are not representable on win32" : false;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function seedConstraints(store: HunchStore): void {
  store.json.put("constraints", {
    id: "con_no_lodash", statement: "never import lodash — use src/utils", scope: ["src/**"],
    severity: "blocking", rationale: "bundle size",
    forbids: { deps: ["lodash"], symbols: [], patterns: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: "2020-01-01T00:00:00.000Z" },
  } as never);
  store.reindex();
}

/** A fresh git repo with a Hunch store holding one content-matched blocking constraint. */
function repo(): { root: string; store: HunchStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-gate-diff-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "gate@test.invalid");
  git(root, "config", "user.name", "Gate Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".hunch/\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/seed.ts"), "export const seed = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  seedConstraints(store);
  return { root, store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } };
}

/** ~90 KB of clean code in a file that sorts BEFORE the violating one in git's diff order. */
function writeLargeClean(root: string): void {
  const lines = Array.from({ length: 3000 }, (_, i) => `export const value${i} = ${i}; // padding line for a large change`);
  writeFileSync(join(root, "src/a-large.ts"), lines.join("\n") + "\n");
}

const strictOpts = (diffStatus?: Parameters<HunchStore["buildCheckReport"]>[2]["diffStatus"]) =>
  ({ strict: true, lastChange: () => "2030-01-01T00:00:00.000Z", diffStatus });

test("a staged change over 60 KB is checked in full: a forbidden import after the old cutoff blocks", () => {
  const { root, store, cleanup } = repo();
  try {
    writeLargeClean(root);
    writeFileSync(join(root, "src/z-late.ts"), `${IMPORT}\nexport const late = _.identity(1);\n`);
    git(root, "add", "-A");

    const files = stagedFiles(root);
    assert.deepEqual(files, ["src/a-large.ts", "src/z-late.ts"]);
    // The bounded synthesis diff really does cut before the violating file.
    assert.ok(!stagedDiff(root).includes(IMPORT), "precondition: the capped diff omits the late file");

    const gate = stagedGateDiff(root);
    assert.equal(gate.incomplete, undefined);
    assert.ok(gate.diff.length > SYNTHESIS_DIFF_BUDGET, "the gate diff is not capped");
    assert.ok(gate.diff.includes(IMPORT));
    const report = store.buildCheckReport(files, gate.diff, strictOpts(gate));
    assert.equal(report.strictBlockers, 1);
    assert.equal(report.direct[0]?.id, "con_no_lodash");
    assert.equal(report.direct[0]?.unevaluable, undefined, "a proven violation, not an unevaluable one");
    assert.equal(verdict(report), "block");

    // Handing the gate a TRUNCATED diff instead fails closed for the file it omits.
    const truncated = store.buildCheckReport(files, stagedDiff(root), strictOpts());
    assert.equal(truncated.strictBlockers, 1);
    // The cut lands inside the ~90 KB first block, so neither file's lines are trusted.
    assert.deepEqual(truncated.direct[0]?.unevaluable?.files, ["src/a-large.ts", "src/z-late.ts"]);
    assert.ok(reportFailsStrict(truncated));
  } finally { cleanup(); }
});

test("hunch check --strict (CLI) blocks a staged >60 KB change whose violation is past the old cutoff", () => {
  const { root, store, cleanup } = repo();
  try {
    store.close();
    writeLargeClean(root);
    writeFileSync(join(root, "src/z-late.ts"), `${IMPORT}\nexport const late = 1;\n`);
    git(root, "add", "-A");
    const run = spawnSync(process.execPath, [TSX, CLI, "check", "--strict"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /con_no_lodash/);
    assert.doesNotMatch(run.stdout, /NOT EVALUATED/);
  } finally { cleanup(); }
});

test("commit and range gate diffs are complete too", () => {
  const { root, store, cleanup } = repo();
  try {
    git(root, "checkout", "-qb", "feature");
    writeLargeClean(root);
    writeFileSync(join(root, "src/z-late.ts"), `${IMPORT}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "large");
    const files = ["src/a-large.ts", "src/z-late.ts"];
    for (const gate of [commitGateDiff("HEAD", root), rangeGateDiff("HEAD~1", root)]) {
      assert.equal(gate.incomplete, undefined);
      assert.ok(gate.diff.includes(IMPORT));
      assert.equal(store.buildCheckReport(files, gate.diff, strictOpts(gate)).strictBlockers, 1);
    }
  } finally { cleanup(); }
});

test("synthesis still receives a capped diff", () => {
  const { root, cleanup } = repo();
  try {
    writeLargeClean(root);
    writeFileSync(join(root, "src/z-late.ts"), `${IMPORT}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "large");
    const diff = commitDiff("HEAD", root);
    assert.equal(SYNTHESIS_DIFF_BUDGET, 60_000);
    assert.ok(diff.endsWith("\n…(diff truncated)…"));
    assert.ok(diff.length <= SYNTHESIS_DIFF_BUDGET + "\n…(diff truncated)…".length);
    // The synthesis layer reads the bounded helper, never the gate diff.
    const synth = readFileSync(join(PROJECT_ROOT, "src/synthesis/synthesize.ts"), "utf8");
    assert.match(synth, /commitDiff\(target, root\)/);
    assert.doesNotMatch(synth, /GateDiff/);
  } finally { cleanup(); }
});

test("a violation in a non-ASCII path (src/café.ts) is content-checked", () => {
  const { root, store, cleanup } = repo();
  try {
    writeFileSync(join(root, "src/café.ts"), `${IMPORT}\n`);
    git(root, "add", "-A");
    const files = stagedFiles(root);
    assert.deepEqual(files, ["src/café.ts"]);
    const gate = stagedGateDiff(root);
    assert.ok(gate.diff.includes("+++ b/src/café.ts"), "gate diff pins core.quotePath=false");
    assert.deepEqual(analyzeDiff(gate.diff).addedLinesByFile.get("src/café.ts"), [IMPORT]);
    const report = store.buildCheckReport(files, gate.diff, strictOpts(gate));
    assert.equal(report.strictBlockers, 1);
    assert.equal(report.direct[0]?.unevaluable, undefined);

    // A diff produced with git's DEFAULT quoting maps back to the same file.
    const quoted = git(root, "-c", "core.quotePath=true", "diff", "--cached", "--no-color", "--src-prefix=a/", "--dst-prefix=b/");
    assert.match(quoted, /\+\+\+ "b\/src\/caf\\303\\251\.ts"/);
    assert.deepEqual(analyzeDiff(quoted).addedLinesByFile.get("src/café.ts"), [IMPORT]);
    assert.equal(store.buildCheckReport(files, quoted, strictOpts()).strictBlockers, 1);
  } finally { cleanup(); }
});

test("C-quoted diff headers are unquoted: octal UTF-8, \\\", \\\\, \\t, \\n", () => {
  assert.equal(unquoteGitPath('"src/caf\\303\\251.ts"'), "src/café.ts");
  assert.equal(unquoteGitPath('"b/src/we\\"ird\\\\name\\tx\\ny.ts"'), 'b/src/we"ird\\name\tx\ny.ts');
  assert.equal(unquoteGitPath("src/plain.ts"), "src/plain.ts");
  const diff = [
    'diff --git "a/src/we\\"ird.ts" "b/src/we\\"ird.ts"',
    "new file mode 100644",
    "--- /dev/null",
    '+++ "b/src/we\\"ird.ts"',
    "@@ -0,0 +1 @@",
    `+${IMPORT}`,
    'diff --git "a/src/old\\tname.ts" "b/src/new\\tname.ts"',
    "similarity index 50%",
    'rename from "src/old\\tname.ts"',
    'rename to "src/new\\tname.ts"',
    '--- "a/src/old\\tname.ts"',
    '+++ "b/src/new\\tname.ts"',
    "@@ -1 +1 @@",
    "-export const a = 1;",
    `+${IMPORT}`,
    "",
  ].join("\n");
  const an = analyzeDiff(diff);
  assert.deepEqual(an.addedLinesByFile.get('src/we"ird.ts'), [IMPORT]);
  assert.deepEqual(an.addedLinesByFile.get("src/new\tname.ts"), [IMPORT]);
  assert.deepEqual(an.filesRenamed, [{ from: "src/old\tname.ts", to: "src/new\tname.ts" }]);
  assert.deepEqual(diffBlockFiles(diff), ['src/we"ird.ts', "src/new\tname.ts"]);
});

test("violations in paths holding a double quote or a tab are detected (staged and untracked)", { skip: QUOTED_NAME_SKIP }, () => {
  const { root, store, cleanup } = repo();
  try {
    const quote = 'src/we"ird.ts';
    const tab = "src/tab\tname.ts";
    writeFileSync(join(root, quote), `${IMPORT}\n`);
    writeFileSync(join(root, tab), `${IMPORT}\n`);
    // Untracked (working mode) first: the synthetic header must round-trip.
    const working = workingFiles(root);
    assert.deepEqual(working, [quote, tab].sort());
    const wgate = workingGateDiff(root);
    const wreport = store.buildCheckReport(working, wgate.diff, strictOpts(wgate));
    assert.equal(wreport.strictBlockers, 1);
    assert.deepEqual([...wreport.direct[0]!.files].sort(), [quote, tab].sort());
    assert.equal(wreport.direct[0]?.unevaluable, undefined);
    for (const f of [quote, tab]) assert.equal(analyzeDiff(wgate.diff).addedLinesByFile.get(f)?.[0], IMPORT, f);

    git(root, "add", "-A");
    const files = stagedFiles(root);
    assert.deepEqual(files.sort(), [quote, tab].sort(), "NUL-delimited enumeration returns literal names");
    const gate = stagedGateDiff(root);
    const an = analyzeDiff(gate.diff);
    for (const f of [quote, tab]) assert.deepEqual(an.addedLinesByFile.get(f), [IMPORT], f);
    // Each file alone is caught (not merely one of the two).
    for (const f of [quote, tab]) {
      const r = store.buildCheckReport([f], gate.diff, strictOpts(gate));
      assert.equal(r.strictBlockers, 1, f);
      assert.equal(r.direct[0]?.unevaluable, undefined, f);
    }
  } finally { cleanup(); }
});

test("git failure: a content-matched blocking constraint is reported unevaluable and strict fails", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "hunch-gate-norepo-"));
  const { store, cleanup } = repo();
  try {
    const gate = stagedGateDiff(notRepo);
    assert.equal(gate.diff, "");
    assert.match(gate.incomplete ?? "", /git could not produce the staged diff/);

    const report = store.buildCheckReport(["src/cart.ts"], gate.diff, strictOpts(gate));
    assert.equal(report.strictBlockers, 1);
    const hit = report.direct[0]!;
    assert.equal(hit.id, "con_no_lodash");
    assert.equal(hit.strictBlocks, true);
    assert.deepEqual(hit.unevaluable?.files, ["src/cart.ts"]);
    assert.ok(reportFailsStrict(report));
    assert.equal(verdict(report), "block");
    assert.match(renderText(report), /NOT EVALUATED/);
    assert.match(renderText(report), /could not be evaluated against the complete diff/);
    assert.match(renderMarkdown(report), /Not evaluated/);

    // The same empty diff WITHOUT a failure status is a genuine "nothing added" → clean.
    assert.equal(store.buildCheckReport(["src/cart.ts"], "", strictOpts()).direct.length, 0);
  } finally {
    cleanup();
    rmSync(notRepo, { recursive: true, force: true });
  }
});

test("incomplete diff: only content-matched BLOCKING rules over files missing from it fail closed", () => {
  const { store, cleanup } = repo();
  try {
    store.json.put("constraints", {
      id: "con_warn_pattern", statement: "avoid console.log", scope: ["src/**"], severity: "warning",
      forbids: { deps: [], symbols: [], patterns: ["console\\.log"] },
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    } as never);
    store.json.put("constraints", {
      id: "con_scope_only", statement: "billing rounds half-up", scope: ["src/billing/**"], severity: "blocking",
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    } as never);
    store.reindex();
    const block = (f: string, line: string) =>
      `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1,2 @@\n export const x = 1;\n+${line}\n`;
    // A truncated diff: the first block is complete, the last (cut) one is not trusted.
    const truncated = block("src/early.ts", "export const ok = 2;") + block("src/billing/late.ts", "export const cut") + "…(diff truncated)…";
    const files = ["src/early.ts", "src/billing/late.ts", "src/never-reached.ts"];
    const report = store.buildCheckReport(files, truncated, strictOpts());
    const byId = new Map(report.direct.map((d) => [d.id, d]));
    assert.deepEqual(byId.get("con_no_lodash")?.unevaluable?.files, ["src/billing/late.ts", "src/never-reached.ts"]);
    assert.equal(byId.get("con_no_lodash")?.strictBlocks, true);
    assert.equal(byId.has("con_warn_pattern"), false, "non-blocking content rules stay quiet");
    assert.ok(byId.has("con_scope_only"), "scope-only rules work from the file list");
    assert.equal(byId.get("con_scope_only")?.unevaluable, undefined);

    // Complete-diff behavior is unchanged: the early file alone is clean.
    const clean = store.buildCheckReport(["src/early.ts"], block("src/early.ts", "export const ok = 2;"), strictOpts());
    assert.equal(clean.direct.length, 0);

    // An unreadable file (e.g. an untracked file the reader refused) fails closed individually.
    const unread = store.buildCheckReport(["src/early.ts", "src/huge.ts"], block("src/early.ts", "export const ok = 2;"), strictOpts({ unreadFiles: ["src/huge.ts"] }));
    assert.deepEqual(unread.direct[0]?.unevaluable, { reason: "file content could not be read", files: ["src/huge.ts"] });
    assert.equal(unread.strictBlockers, 1);
  } finally { cleanup(); }
});
