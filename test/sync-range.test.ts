import { cleanupDir, isolatedCliEnv } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore } from "../src/integrations/gitignore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Pinned deterministic provider and no initiator vars: no test can launch a real assistant CLI. */
function runCli(root: string, ...args: string[]) {
  return runCliEnv(root, {}, ...args);
}

function runCliEnv(root: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    env: isolatedCliEnv({ HUNCH_PRIVATE_DIR: "", ...env }),
    encoding: "utf8",
  });
}

/** A recording fake adapter bound as the initiator: if range mode used the provider,
 *  this would be called. Each invocation appends a line to the returned log. */
function fakeProvider(root: string): { env: NodeJS.ProcessEnv; log: string } {
  const dir = join(root, ".fake");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.log");
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, `import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }
let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => input += d);
process.stdin.on("end", () => { appendFileSync(${JSON.stringify(log)}, "call\\n"); console.log("not json"); });\n`);
  const config = join(dir, "adapters.json");
  writeFileSync(config, JSON.stringify([{ name: "fake-synth", command: process.execPath, args: [worker], protocol: "stdin", probe_args: ["--version"], timeout_ms: 20000 }]));
  return { env: { HUNCH_SYNTH_PROVIDER: "auto", HUNCH_INITIATOR: "fake-synth", HUNCH_CLI_CONFIG: config }, log };
}

function calls(log: string): number {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
}

function decisionFiles(root: string): string[] {
  const dir = join(root, ".hunch/decisions");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

let n = 0;
function commitFile(root: string, subject: string): string {
  n++;
  const lines = Array.from({ length: 15 }, (_, i) => `export const v${n}_${i} = ${i};`).join("\n");
  writeFileSync(join(root, `src/f${n}.ts`), `export function feature${n}() { return ${n}; }\n${lines}\n`);
  git(root, "add", `src/f${n}.ts`);
  git(root, "commit", "-qm", subject);
  return git(root, "rev-parse", "HEAD");
}

function fixture(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-sync-range-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test Human");
  mkdirSync(join(root, "src"), { recursive: true });
  ensureGitignore(root);
  writeFileSync(join(root, "src/base.ts"), "export const base = 1;\n");
  git(root, "add", ".gitignore", "src/base.ts");
  git(root, "commit", "-qm", "feat: base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

test("sync --range captures substantive commits deterministically and is idempotent", () => {
  const { root, base } = fixture();
  try {
    commitFile(root, "feat: add first feature");
    commitFile(root, "wip");
    commitFile(root, "feat: add second feature");
    const fake = fakeProvider(root);
    const first = runCliEnv(root, fake.env, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Range .*: 2 captured, 1 skipped\./);
    assert.match(first.stdout, /skipped: trivial subject: wip/);
    const files = decisionFiles(root);
    assert.equal(files.length, 2);
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(root, ".hunch/decisions", f), "utf8"));
      assert.ok(d.provenance.evidence.some((e: string) => e.includes("synth:provider=deterministic")), JSON.stringify(d.provenance.evidence));
    }
    assert.equal(calls(fake.log), 0, "range mode without --synthesize must never invoke the provider");
    const second = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /0 captured, 3 skipped\./);
    assert.match(second.stdout, /skipped: decision already captured for this commit/);
    assert.doesNotMatch(second.stdout, /rebased duplicate/);
    assert.equal(decisionFiles(root).length, 2);
    const forced = runCli(root, "sync", "--range", `${base}..HEAD`, "--force", "--no-commit");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /Range .*: [1-9]\d* captured/);
    assert.equal(decisionFiles(root).length, 2);
    const synthesized = runCliEnv(root, fake.env, "sync", "--range", `${base}..HEAD`, "--synthesize", "--force", "--no-commit");
    assert.equal(synthesized.status, 0, synthesized.stderr);
    assert.ok(calls(fake.log) > 0, `--synthesize must use the bound provider: ${synthesized.stdout}`);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range --max keeps only the newest commits", () => {
  const { root, base } = fixture();
  try {
    commitFile(root, "feat: one");
    commitFile(root, "feat: two");
    const newest = commitFile(root, "feat: three");
    const r = runCli(root, "sync", "--range", `${base}..HEAD`, "--max", "1", "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 older commit\(s\) not captured \(raise --max\)/);
    assert.match(r.stdout, new RegExp(`✓ ${newest.slice(0, 8)} `));
    assert.equal(decisionFiles(root).length, 1);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range skips a rebased duplicate of an already captured commit", () => {
  const { root } = fixture();
  try {
    git(root, "checkout", "-q", "-b", "side");
    const x = commitFile(root, "feat: side feature");
    const single = runCli(root, "sync", x, "--no-commit");
    assert.equal(single.status, 0, single.stderr);
    const [decFile] = decisionFiles(root);
    assert.ok(decFile);
    const decId = JSON.parse(readFileSync(join(root, ".hunch/decisions", decFile!), "utf8")).id as string;
    git(root, "checkout", "-q", "main");
    const before = git(root, "rev-parse", "HEAD");
    git(root, "cherry-pick", x);
    const r = runCli(root, "sync", "--range", `${before}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`skipped: rebased duplicate of ${decId}`));
    assert.equal(decisionFiles(root).length, 1);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range rejects bad argument combinations without writing", () => {
  const { root, base } = fixture();
  try {
    const head = commitFile(root, "feat: something");
    const cases: string[][] = [
      ["sync", head, "--range", `${base}..HEAD`],
      ["sync", "--range", "nope..HEAD"],
      ["sync", "--range", "-x..HEAD"],
      ["sync", "--range", `${base}..HEAD`, "--max", "0"],
      ["sync", "--range", `${base}..HEAD`, "--deep"],
      ["sync", "--max", "5"],
      ["sync", "--synthesize"],
      ["sync", "--range", `${base}...HEAD`],
    ];
    for (const args of cases) {
      const r = runCli(root, ...args, "--no-commit");
      assert.notEqual(r.status, 0, `${args.join(" ")} should fail: ${r.stdout}`);
      assert.equal(decisionFiles(root).length, 0, args.join(" "));
    }
  } finally {
    cleanupDir(root);
  }
});

test("sync --range captures a re-apply whose patch-id matches a reverted ancestor", () => {
  const { root, base } = fixture();
  try {
    writeFileSync(join(root, "src/base.ts"), "export const base = 1;\nexport function reapplied() { return 2; }\n");
    git(root, "commit", "-qam", "feat: add reapplied helper");
    const a = git(root, "rev-parse", "HEAD");
    git(root, "revert", "--no-edit", a);
    git(root, "commit", "-q", "--amend", "-m", `Revert "feat: add reapplied helper"\n\nThe helper broke the release build on Windows; backing it out until the path fix lands.`);
    git(root, "cherry-pick", a);
    const reapply = git(root, "rev-parse", "HEAD");
    const r = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /rebased duplicate/, r.stdout);
    assert.match(r.stdout, new RegExp(`✓ ${reapply.slice(0, 8)} `), r.stdout);
    assert.match(r.stdout, /3 captured/, r.stdout);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range re-runs a revert + re-apply as already captured and --force re-drafts all", () => {
  const { root, base } = fixture();
  try {
    writeFileSync(join(root, "src/base.ts"), "export const base = 1;\nexport function again() { return 2; }\n");
    git(root, "commit", "-qam", "feat: add again helper");
    const x = git(root, "rev-parse", "HEAD");
    git(root, "revert", "--no-edit", x);
    git(root, "commit", "-q", "--amend", "-m", `Revert "feat: add again helper"\n\nThe helper broke the release build on Windows; backing it out until the path fix lands.`);
    git(root, "cherry-pick", x);
    const first = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /3 captured/, first.stdout);
    const second = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /rebased duplicate/, second.stdout);
    assert.match(second.stdout, /0 captured, 3 skipped\./, second.stdout);
    assert.equal((second.stdout.match(/already captured/g) ?? []).length, 3, second.stdout);
    const forced = runCli(root, "sync", "--range", `${base}..HEAD`, "--force", "--no-commit");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /3 captured, 0 skipped\./, forced.stdout);
    assert.equal(decisionFiles(root).length, 3);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range does not call a cherry-pick with its own decision a rebased duplicate", () => {
  const { root } = fixture();
  try {
    git(root, "checkout", "-q", "-b", "side");
    const x = commitFile(root, "feat: picked feature");
    assert.equal(runCli(root, "sync", x, "--no-commit").status, 0);
    git(root, "checkout", "-q", "main");
    const before = git(root, "rev-parse", "HEAD");
    git(root, "cherry-pick", x);
    const xp = git(root, "rev-parse", "HEAD");
    const single = runCli(root, "sync", xp, "--no-commit");
    assert.equal(single.status, 0, single.stderr);
    assert.equal(decisionFiles(root).length, 2);
    const r = runCli(root, "sync", "--range", `${before}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /rebased duplicate/, r.stdout);
    assert.match(r.stdout, /already captured/, r.stdout);
    const forced = runCli(root, "sync", "--range", `${before}..HEAD`, "--force", "--no-commit");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, new RegExp(`✓ ${xp.slice(0, 8)} `), forced.stdout);
    assert.equal(decisionFiles(root).length, 2);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range captures oldest-first", () => {
  const { root, base } = fixture();
  try {
    const shas = [commitFile(root, "feat: alpha"), commitFile(root, "feat: beta"), commitFile(root, "feat: gamma")];
    const r = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    const at = shas.map((s) => r.stdout.indexOf(`✓ ${s.slice(0, 8)} `));
    assert.ok(at.every((i) => i >= 0), r.stdout);
    assert.deepEqual([...at].sort((a, b) => a - b), at, r.stdout);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range rejects a bad range in an uninitialised repo without creating .hunch/", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-sync-range-bare-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test Human");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git(root, "add", "a.ts");
    git(root, "commit", "-qm", "feat: a");
    for (const range of ["HEAD...HEAD", "..", "nope..HEAD"]) {
      for (const quiet of [[], ["--quiet"]]) {
        const r = runCli(root, "sync", "--range", range, ...quiet, "--no-commit");
        assert.notEqual(r.status, 0, `${range} should fail: ${r.stdout}`);
        assert.equal(existsSync(join(root, ".hunch")), false, `${range} created .hunch/`);
      }
    }
  } finally {
    cleanupDir(root);
  }
});

test("sync --range skips a commit already owned by a re-pointed decision", () => {
  const { root, base } = fixture();
  try {
    const x = commitFile(root, "feat: repointed feature");
    assert.equal(runCli(root, "sync", x, "--no-commit").status, 0);
    const [f] = decisionFiles(root);
    const dir = join(root, ".hunch/decisions");
    const d = JSON.parse(readFileSync(join(dir, f!), "utf8"));
    const newId = "dec_0000repoint";
    rmSync(join(dir, f!));
    writeFileSync(join(dir, `${newId}.json`), JSON.stringify({ ...d, id: newId }, null, 2));
    for (const extra of [[], ["--force"]]) {
      const r = runCli(root, "sync", "--range", `${base}..HEAD`, ...extra, "--no-commit");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`skipped: already captured by ${newId}`), r.stdout);
      assert.equal(decisionFiles(root).length, 1, r.stdout);
    }
  } finally {
    cleanupDir(root);
  }
});

/** Strip patch-id evidence from decisions (as on <=1.56 / shallow / re-pointed records). */
function stripPatchIds(root: string, only?: (d: { commit: string | null }) => boolean): void {
  const dir = join(root, ".hunch/decisions");
  for (const f of decisionFiles(root)) {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (only && !only(d)) continue;
    d.provenance.evidence = d.provenance.evidence.filter((e: string) => !e.startsWith("patch-id:"));
    writeFileSync(join(dir, f), JSON.stringify(d, null, 2));
  }
}

function readDecisions(root: string): Array<{ id: string; commit: string | null; related_files: string[] }> {
  const dir = join(root, ".hunch/decisions");
  return decisionFiles(root).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

test("sync --range skips an untagged re-pointed decision's commit, with and without --force", () => {
  const { root, base } = fixture();
  try {
    const x = commitFile(root, "feat: untagged repoint");
    assert.equal(runCli(root, "sync", x, "--no-commit").status, 0);
    const [f] = decisionFiles(root);
    const dir = join(root, ".hunch/decisions");
    const d = JSON.parse(readFileSync(join(dir, f!), "utf8"));
    const newId = "dec_0000untagged";
    rmSync(join(dir, f!));
    d.provenance.evidence = d.provenance.evidence.filter((e: string) => !e.startsWith("patch-id:"));
    writeFileSync(join(dir, `${newId}.json`), JSON.stringify({ ...d, id: newId }, null, 2));
    for (const extra of [[], ["--force"]]) {
      const r = runCli(root, "sync", "--range", `${base}..HEAD`, ...extra, "--no-commit");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`skipped: already captured by ${newId}`), r.stdout);
      assert.equal(decisionFiles(root).length, 1, r.stdout);
    }
  } finally {
    cleanupDir(root);
  }
});

test("sync --range: an untagged own decision beats a tagged non-ancestor twin", () => {
  const { root } = fixture();
  try {
    git(root, "checkout", "-q", "-b", "side");
    const x = commitFile(root, "feat: twin feature");
    assert.equal(runCli(root, "sync", x, "--no-commit").status, 0);
    git(root, "checkout", "-q", "main");
    const before = git(root, "rev-parse", "HEAD");
    git(root, "cherry-pick", x);
    const xp = git(root, "rev-parse", "HEAD");
    assert.equal(runCli(root, "sync", xp, "--no-commit").status, 0);
    stripPatchIds(root, (d) => !!d.commit && xp.startsWith(d.commit));
    const r = runCli(root, "sync", "--range", `${before}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /rebased duplicate/, r.stdout);
    const forced = runCli(root, "sync", "--range", `${before}..HEAD`, "--force", "--no-commit");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, new RegExp(`✓ ${xp.slice(0, 8)} `), forced.stdout);
    assert.equal(decisionFiles(root).length, 2);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range --force re-drafts the own decision when a re-pointed one also names the sha", () => {
  const { root, base } = fixture();
  try {
    const x = commitFile(root, "feat: doubly owned");
    assert.equal(runCli(root, "sync", x, "--no-commit").status, 0);
    const [f] = decisionFiles(root);
    const dir = join(root, ".hunch/decisions");
    const d = JSON.parse(readFileSync(join(dir, f!), "utf8"));
    writeFileSync(join(dir, "dec_0000second.json"), JSON.stringify({ ...d, id: "dec_0000second" }, null, 2));
    const forced = runCli(root, "sync", "--range", `${base}..HEAD`, "--force", "--no-commit");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, new RegExp(`✓ ${x.slice(0, 8)} `), forced.stdout);
    assert.equal(decisionFiles(root).length, 2);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range re-run over captured renames is capture-only (no repair)", () => {
  const { root, base } = fixture();
  try {
    const body = Array.from({ length: 15 }, (_, i) => `export const w${i} = ${i};`).join("\n");
    writeFileSync(join(root, "src/a.ts"), `export function widget() { return 1; }\n${body}\n`);
    git(root, "add", "src/a.ts");
    git(root, "commit", "-qm", "feat: add widget module");
    git(root, "mv", "src/a.ts", "src/b.ts");
    git(root, "commit", "-qm", "refactor: rename widget module to b");
    writeFileSync(join(root, "src/a.ts"), `export function fresh() { return 2; }\n${body.replace(/w(\d)/g, "z$1")}\n`);
    git(root, "add", "src/a.ts");
    git(root, "commit", "-qm", "feat: brand new a module with different purpose");
    const c3 = git(root, "rev-parse", "HEAD");
    const r1 = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /3 captured/, r1.stdout);
    const head = git(root, "rev-parse", "HEAD");
    const r2 = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /0 captured/, r2.stdout);
    assert.doesNotMatch(r2.stdout, /repaired/, r2.stdout);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    const own = readDecisions(root).find((d) => d.commit && c3.startsWith(d.commit));
    assert.ok(own, "C3 decision");
    assert.ok(own!.related_files.includes("src/a.ts"), JSON.stringify(own!.related_files));
  } finally {
    cleanupDir(root);
  }
});

test("sync --range: a reverted ancestor captured after its re-apply is not a rebased duplicate", () => {
  const { root } = fixture();
  try {
    const x = commitFile(root, "feat: toggled feature");
    git(root, "revert", "--no-edit", x);
    git(root, "cherry-pick", x);
    const x2 = git(root, "rev-parse", "HEAD");
    const r1 = runCli(root, "sync", "--range", `${x}~1..HEAD`, "--max", "1", "--no-commit");
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, new RegExp(`✓ ${x2.slice(0, 8)} `), r1.stdout);
    const r2 = runCli(root, "sync", "--range", `${x}~1..HEAD`, "--max", "5", "--no-commit");
    assert.equal(r2.status, 0, r2.stderr);
    assert.doesNotMatch(r2.stdout, /rebased duplicate/, r2.stdout);
    assert.match(r2.stdout, new RegExp(`✓ ${x.slice(0, 8)} `), r2.stdout);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range in a shallow clone does not mint a second decision for an owned HEAD", () => {
  const { root } = fixture();
  const clone = mkdtempSync(join(tmpdir(), "hunch-sync-range-shallow-"));
  try {
    commitFile(root, "feat: shallow one");
    commitFile(root, "feat: shallow two");
    cleanupDir(clone);
    execFileSync("git", ["clone", "-q", "--depth", "2", `file://${root.replace(/\\/g, "/")}`, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test Human");
    assert.equal(runCli(clone, "sync", "HEAD", "--no-commit").status, 0);
    stripPatchIds(clone);
    // Re-point it (repair-provenance style) so only commit ownership can find it.
    const dir = join(clone, ".hunch/decisions");
    const [f] = decisionFiles(clone);
    const d = JSON.parse(readFileSync(join(dir, f!), "utf8"));
    rmSync(join(dir, f!));
    writeFileSync(join(dir, "dec_0000shallow.json"), JSON.stringify({ ...d, id: "dec_0000shallow" }, null, 2));
    const r = runCli(clone, "sync", "--range", "HEAD~1..HEAD", "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(decisionFiles(clone).length, 1, r.stdout);
  } finally {
    cleanupDir(root);
    cleanupDir(clone);
  }
});

function renameFixture(renameSubject: string): { root: string; base: string; c3: string } {
  const { root, base } = fixture();
  const body = Array.from({ length: 15 }, (_, i) => `export const w${i} = ${i};`).join("\n");
  writeFileSync(join(root, "src/a.ts"), `export function widget() { return 1; }\n${body}\n`);
  git(root, "add", "src/a.ts");
  git(root, "commit", "-qm", "feat: add widget module");
  git(root, "mv", "src/a.ts", "src/b.ts");
  git(root, "commit", "-qm", renameSubject);
  writeFileSync(join(root, "src/a.ts"), `export function fresh() { return 2; }\n${body.replace(/w(\d)/g, "z$1")}\n`);
  git(root, "add", "src/a.ts");
  git(root, "commit", "-qm", "feat: brand new a module");
  return { root, base, c3: git(root, "rev-parse", "HEAD") };
}

test("sync --range re-run over a skipped-subject rename commit is capture-only (no repair)", () => {
  const { root, base, c3 } = renameFixture("format: move widget module");
  try {
    const r1 = runCli(root, "sync", "--range", `${base}..${c3}`);
    assert.equal(r1.status, 0, r1.stderr);
    // Tip guard: src/a.ts exists again at the tip (C3), so the rename is not replayed.
    assert.ok(!readDecisions(root).some((d) => d.related_files.includes("src/b.ts")), r1.stdout);
    const head = git(root, "rev-parse", "HEAD");
    const r2 = runCli(root, "sync", "--range", `${base}..${c3}`);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /0 captured/, r2.stdout);
    assert.doesNotMatch(r2.stdout, /repaired/, r2.stdout);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    const own = readDecisions(root).find((d) => d.commit && c3.startsWith(d.commit));
    assert.ok(own, "C3 decision");
    assert.ok(own!.related_files.includes("src/a.ts"), JSON.stringify(own!.related_files));
  } finally {
    cleanupDir(root);
  }
});

test("sync --range after per-commit hook captures is capture-only (no repair)", () => {
  const { root, base, c3 } = renameFixture("refactor: rename widget module to b");
  try {
    for (const ref of [`${c3}~2`, `${c3}~1`, c3]) assert.equal(runCli(root, "sync", ref, "--no-commit").status, 0);
    const r = runCli(root, "sync", "--range", `${base}..${c3}`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /repaired/, r.stdout);
    const own = readDecisions(root).find((d) => d.commit && c3.startsWith(d.commit));
    assert.ok(own, "C3 decision");
    assert.ok(own!.related_files.includes("src/a.ts"), JSON.stringify(own!.related_files));
  } finally {
    cleanupDir(root);
  }
});

test("sync --range skips a commit whose own decision lives only in the private overlay", () => {
  const { root, base } = fixture();
  const priv = mkdtempSync(join(tmpdir(), "hunch-sync-range-priv-"));
  try {
    const x = commitFile(root, "feat: overlay captured feature");
    const env = { HUNCH_PRIVATE_DIR: priv };
    const p = runCliEnv(root, env, "sync", x, "--private", "--no-commit");
    assert.equal(p.status, 0, p.stderr);
    const r = runCliEnv(root, env, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already captured by dec_\w+ in the private store/, r.stdout);
    assert.equal(decisionFiles(root).length, 0, r.stdout);
  } finally {
    cleanupDir(root);
    cleanupDir(priv);
  }
});

test("sync --range rejects non-commit operands and an empty range scaffolds nothing", () => {
  const { root } = fixture();
  try {
    for (const range of ["HEAD:src/base.ts..HEAD", "HEAD..HEAD^{tree}"]) {
      const r = runCli(root, "sync", "--range", range);
      assert.equal(r.status, 1, `${range}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /is not a commit/, r.stderr);
      assert.equal(existsSync(join(root, ".hunch")), false, range);
    }
    const e = runCli(root, "sync", "--range", "HEAD..HEAD");
    assert.equal(e.status, 0, e.stderr);
    assert.match(e.stdout, /no commits\./, e.stdout);
    assert.equal(existsSync(join(root, ".hunch")), false);
  } finally {
    cleanupDir(root);
  }
});

function addWidget(root: string, subject = "feat: add widget module"): string {
  const body = Array.from({ length: 15 }, (_, i) => `export const w${i} = ${i};`).join("\n");
  writeFileSync(join(root, "src/a.ts"), `export function widget() { return 1; }\n${body}\n`);
  git(root, "add", "src/a.ts");
  git(root, "commit", "-qm", subject);
  return git(root, "rev-parse", "HEAD");
}

test("sync --range: a skipped wip rename later reverted never rebinds to the absent path", () => {
  const { root, base } = fixture();
  try {
    const c1 = addWidget(root);
    git(root, "mv", "src/a.ts", "src/b.ts");
    git(root, "commit", "-qm", "wip: move widget module");
    git(root, "revert", "--no-edit", "HEAD");
    for (const run of [1, 2]) {
      const head = git(root, "rev-parse", "HEAD");
      const r = runCli(root, "sync", "--range", `${base}..HEAD`);
      assert.equal(r.status, 0, r.stderr);
      const own = readDecisions(root).find((d) => d.commit && c1.startsWith(d.commit));
      assert.ok(own, `C1 decision (run ${run}): ${r.stdout}`);
      assert.deepEqual(own!.related_files.filter((f) => f.startsWith("src/")), ["src/a.ts"], `run ${run}`);
      if (run === 2) {
        assert.doesNotMatch(r.stdout, /repaired/, r.stdout);
        assert.equal(git(root, "rev-parse", "HEAD"), head);
      }
    }
  } finally {
    cleanupDir(root);
  }
});

test("sync --range re-run over two trivial renames back and forth is capture-only (no repair)", () => {
  const { root, base } = fixture();
  try {
    addWidget(root);
    git(root, "mv", "src/a.ts", "src/b.ts");
    git(root, "commit", "-qm", "wip: move widget module");
    git(root, "mv", "src/b.ts", "src/a.ts");
    git(root, "commit", "-qm", "wip: move widget module back");
    assert.equal(runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit").status, 0);
    const r = runCli(root, "sync", "--range", `${base}..HEAD`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /repaired/, r.stdout);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range is capture-only: a rename commit never rebinds an ancestor capture", () => {
  const { root, base } = fixture();
  try {
    const a = addWidget(root);
    git(root, "mv", "src/a.ts", "src/b.ts");
    git(root, "commit", "-qm", "refactor: rename widget module to b");
    const rename = git(root, "rev-parse", "HEAD");
    assert.equal(runCli(root, "sync", rename, "--no-commit").status, 0);
    const r = runCli(root, "sync", "--range", `${base}..${rename}`, "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    const own = readDecisions(root).find((d) => d.commit && a.startsWith(d.commit));
    assert.ok(own, `A decision: ${r.stdout}`);
    assert.ok(own!.related_files.includes("src/a.ts"), JSON.stringify(own!.related_files));
    assert.ok(!own!.related_files.includes("src/b.ts"), JSON.stringify(own!.related_files));
    assert.doesNotMatch(r.stdout, /repaired/, r.stdout);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range rejects --samples without --synthesize", () => {
  const { root, base } = fixture();
  try {
    commitFile(root, "feat: sampled");
    const r = runCli(root, "sync", "--range", `${base}..HEAD`, "--samples", "2");
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /--samples needs --synthesize/, r.stderr);
  } finally {
    cleanupDir(root);
  }
});

test("sync --range prints the heuristic-draft warning when synthesis falls back", () => {
  const { root, base } = fixture();
  try {
    commitFile(root, "feat: fallback feature");
    const fake = fakeProvider(root);
    const r = runCliEnv(root, fake.env, "sync", "--range", `${base}..HEAD`, "--synthesize", "--no-commit");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\n    ⚠ heuristic draft instead: /, r.stdout);
    const quiet = runCliEnv(root, fake.env, "sync", "--range", `${base}..HEAD`, "--synthesize", "--force", "--quiet", "--no-commit");
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /heuristic draft instead/, quiet.stdout);
  } finally {
    cleanupDir(root);
  }
});
