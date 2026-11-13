/**
 * `hunch spec-sync` end to end in a temp git repo: on/off/add config handling (SS-8.5,
 * SS-2.4, SS-2.6) and `check` exit codes and findings against the diff from base
 * (SS-6.7, SS-5.1, SS-5.4, SS-4.7, SS-4.9, SS-7.3). Synthetic fixture: spec id PAY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; out: string }

const SPEC = "# Payments\n\n- [PAY-1.1] A charge is captured once.\n- [PAY-1.2] A refund never exceeds the charge.\n\nCode lives in `src/pay/charge.ts`; tests in `test/pay.test.ts`.\n";
const TESTS = "describe('payments', () => {\n  it('[PAY-1.1] captures once', () => {});\n  it('[PAY-1.2] caps refunds', () => {});\n});\n";
const CONFIG = {
  version: 1,
  enabled: true,
  specsDir: ["docs/specs"],
  specs: [{ id: "PAY", path: "docs/specs/pay.md", code: ["src/pay/**"], tests: ["test/pay*.test.ts"] }],
  ignore: ["**/*.md", ".gitignore", "reports/**"],
  junit: ["reports/junit.xml"],
};

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: f.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(f: Fixture, file: string, body: string): void {
  mkdirSync(dirname(join(f.root, file)), { recursive: true });
  writeFileSync(join(f.root, file), body);
}

function run(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, encoding: "utf8", env: f.env, timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function makeFixture(label: string, opts: { config?: boolean; commit?: boolean; sha256?: boolean; reftable?: boolean } = {}): Fixture {
  const sandbox = tempDir(`hunch-specsync-${label}-`);
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    LOCALAPPDATA: join(home, "AppData", "Local"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1",
  });
  delete env.NODE_TEST_CONTEXT;
  const f: Fixture = { sandbox, root, env };
  git(f, "init", "-q", "-b", "main", ...(opts.sha256 ? ["--object-format=sha256"] : []), ...(opts.reftable ? ["--ref-format=reftable"] : []));
  git(f, "config", "user.email", "t@example.com");
  git(f, "config", "user.name", "T");
  git(f, "config", "core.autocrlf", "false");
  write(f, "docs/specs/pay.md", SPEC);
  write(f, "src/pay/charge.ts", "export const charge = 1;\n");
  write(f, "src/util.ts", "export const util = 1;\n");
  write(f, "test/pay.test.ts", TESTS);
  if (opts.config !== false) write(f, ".hunch/spec-sync.json", `${JSON.stringify(CONFIG, null, 2)}\n`);
  if (opts.commit === false) return f;
  // Dated a day back, so a test that dates its own HEAD moves (gitAt) keeps them in order.
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  git(f, "add", "-A");
  gitAt(f, dayAgo, "commit", "-qm", "base");
  gitAt(f, dayAgo, "checkout", "-q", "-b", "feat");
  return f;
}

test("[SS-6.7] check: clean exits 0; an untested clause exits 1; --json lists findings", () => {
  const f = makeFixture("untested");
  try {
    const clean = run(f, "spec-sync", "check");
    assert.equal(clean.status, 0, clean.out);
    assert.match(clean.out, /in step/);
    write(f, "test/pay.test.ts", TESTS.replace("[PAY-1.2] caps refunds", "caps refunds"));
    const r = run(f, "spec-sync", "check");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[untested\] PAY-1\.2/);
    const json = run(f, "spec-sync", "check", "--json");
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.out) as { findings: { code: string; subject: string }[] };
    assert.deepEqual(parsed.findings.map((x) => `${x.code}:${x.subject}`), ["untested:PAY-1.2"]);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-7.3][SS-2.5] check: a bad config exits 2 and names the field at fault", () => {
  const f = makeFixture("badconfig");
  try {
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, specs: [{ ...CONFIG.specs[0], id: "pay" }] }));
    const r = run(f, "spec-sync", "check");
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /specs\[0\]\.id/);
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, version: 9 }));
    const v = run(f, "spec-sync", "check");
    assert.equal(v.status, 2, v.out);
    assert.match(v.out, /`version`/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-5.1] check: new-code-no-spec fires on an added file only, never on an edited one", () => {
  const f = makeFixture("newcode");
  try {
    write(f, "src/util.ts", "export const util = 2;\n");
    const edited = run(f, "spec-sync", "check");
    assert.equal(edited.status, 0, edited.out);
    write(f, "src/extra.ts", "export const extra = 1;\n");
    git(f, "add", "src/extra.ts");
    git(f, "commit", "-qm", "add extra");
    const added = run(f, "spec-sync", "check");
    assert.equal(added.status, 1, added.out);
    assert.match(added.out, /\[new-code-no-spec\] src\/extra\.ts/);
    assert.doesNotMatch(added.out, /src\/util\.ts/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-5.4][SS-3.5] check: a whitespace-only spec edit does not clear code-without-spec-change; a clause edit does", () => {
  const f = makeFixture("whitespace");
  try {
    write(f, "src/pay/charge.ts", "export const charge = 2;\n");
    const r = run(f, "spec-sync", "check");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[code-without-spec-change\]/);
    write(f, "docs/specs/pay.md", SPEC.replace("A charge is captured once.", "A charge is\n  captured    once.") + "\n\n");
    const ws = run(f, "spec-sync", "check");
    assert.equal(ws.status, 1, ws.out);
    assert.match(ws.out, /\[code-without-spec-change\]/);
    write(f, "docs/specs/pay.md", SPEC.replace("captured once", "captured at most once"));
    const edited = run(f, "spec-sync", "check");
    assert.equal(edited.status, 0, edited.out);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.8][SS-4.9] check: a JUnit report older than a code edit is ignored; --require-junit flags it", () => {
  const f = makeFixture("junit");
  try {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="pay"><testcase classname="payments" name="[PAY-1.1] captures once"><failure message="x">boom</failure></testcase><testcase classname="payments" name="[PAY-1.2] caps refunds"/></testsuite></testsuites>`;
    write(f, "reports/junit.xml", xml);
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(f.root, "reports/junit.xml"), future, future);
    const fresh = run(f, "spec-sync", "check");
    assert.equal(fresh.status, 1, fresh.out);
    assert.match(fresh.out, /\[failing\] PAY-1\.1/);

    // The code fix lands after the report: the report is stale and must not say "failing".
    const later = new Date(Date.now() + 120_000);
    write(f, "src/pay/charge.ts", "export const charge = 1; // fixed\n");
    write(f, "docs/specs/pay.md", SPEC.replace("captured once", "captured exactly once"));
    utimesSync(join(f.root, "src/pay/charge.ts"), later, later);
    const stale = run(f, "spec-sync", "check");
    assert.equal(stale.status, 0, stale.out);
    assert.doesNotMatch(stale.out, /failing/);
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /\[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-8.5][SS-1.3][SS-1.4] on is idempotent and imports legacy headers; off keeps the file; unparseable is refused untouched", () => {
  const f = makeFixture("onoff", { config: false });
  try {
    write(f, "docs/specs/ref.md", "<!-- spec-sync id=REF code=src/pay/*.ts tests=test/pay*.test.ts -->\n# Ref\n- [REF-1.1] x\n");
    const on = run(f, "spec-sync", "on");
    assert.equal(on.status, 0, on.out);
    assert.match(on.out, /imported REF/);
    const file = join(f.root, ".hunch/spec-sync.json");
    const bytes = readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(bytes).specs.map((s: { id: string }) => s.id), ["REF"]);
    assert.ok(readFileSync(join(f.root, "docs/specs/ref.md"), "utf8").startsWith("<!-- spec-sync id=REF"), "the spec file is not edited");
    const again = run(f, "spec-sync", "on");
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /already on/);
    assert.equal(readFileSync(file, "utf8"), bytes, "on twice changes nothing");

    const off = run(f, "spec-sync", "off");
    assert.equal(off.status, 0, off.out);
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, false);
    const offCheck = run(f, "spec-sync", "check");
    assert.equal(offCheck.status, 0, offCheck.out);
    assert.match(offCheck.out, /off/);

    writeFileSync(file, "{ broken");
    const refused = run(f, "spec-sync", "on");
    assert.equal(refused.status, 2, refused.out);
    assert.equal(readFileSync(file, "utf8"), "{ broken");
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-2.6] on re-includes the config under a .hunch/* overlay rule; a .hunch/ rule gets the git add -f fix", () => {
  const f = makeFixture("gitignore", { config: false });
  try {
    write(f, ".gitignore", "node_modules/\n.hunch/*\n!.hunch/config.json");
    const on = run(f, "spec-sync", "on");
    assert.equal(on.status, 0, on.out);
    assert.match(on.out, /appended `!\.hunch\/spec-sync\.json`/);
    assert.equal(readFileSync(join(f.root, ".gitignore"), "utf8"), "node_modules/\n.hunch/*\n!.hunch/config.json\n!.hunch/spec-sync.json\n");
    assert.equal(spawnSync("git", ["check-ignore", "-q", ".hunch/spec-sync.json"], { cwd: f.root, env: f.env }).status, 1, "no longer ignored");
    assert.doesNotMatch(run(f, "spec-sync", "on").out, /appended/, "the second run changes nothing");
  } finally {
    cleanupDir(f.sandbox);
  }
  const g = makeFixture("gitignore-dir", { config: false });
  try {
    write(g, ".gitignore", ".hunch/\n");
    const on = run(g, "spec-sync", "on");
    assert.equal(on.status, 0, on.out);
    assert.match(on.out, /git add -f \.hunch\/spec-sync\.json/);
    assert.equal(readFileSync(join(g.root, ".gitignore"), "utf8"), ".hunch/\n");
  } finally {
    cleanupDir(g.sandbox);
  }
});

test("[SS-2.4] add derives the id from clause markers, proposes globs from named paths, never replaces a registered id", () => {
  const f = makeFixture("add", { config: false });
  try {
    const r = run(f, "spec-sync", "add", "docs/specs/pay.md");
    assert.equal(r.status, 0, r.out);
    const cfg = JSON.parse(readFileSync(join(f.root, ".hunch/spec-sync.json"), "utf8"));
    assert.deepEqual(cfg.specs, [{ id: "PAY", path: "docs/specs/pay.md", code: ["src/pay/charge.ts"], tests: ["test/pay.test.ts"] }]);
    const again = run(f, "spec-sync", "add", "docs/specs/pay.md");
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /already registered/);
    const none = run(f, "spec-sync", "add", "src/util.ts");
    assert.equal(none.status, 2, none.out);
    assert.match(none.out, /no clause markers/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- fix-round regressions -----------------------------------------------------

test("[SS-6.7] check --base: an explicit ref works; an option-like value or no default branch exits 2", () => {
  const f = makeFixture("base");
  try {
    write(f, "src/pay/charge.ts", "export const charge = 2;\n");
    const explicit = run(f, "spec-sync", "check", "--base", "main");
    assert.equal(explicit.status, 1, explicit.out);
    assert.match(explicit.out, /code-without-spec-change/);
    const injected = run(f, "spec-sync", "check", "--base=--octopus");
    assert.equal(injected.status, 2, injected.out);
    git(f, "branch", "-D", "main");
    const noDefault = run(f, "spec-sync", "check");
    assert.equal(noDefault.status, 2, noDefault.out);
    assert.match(noDefault.out, /pass --base/);
    assert.equal(run(f, "spec-sync", "check", "--base", "HEAD").status, 1);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-5.4][SS-7.3] check: a spec path case mismatch exits 2; a renamed spec is compared with its old text", () => {
  const f = makeFixture("specpath");
  try {
    git(f, "mv", "docs/specs/pay.md", "docs/specs/payments.md");
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, specs: [{ ...CONFIG.specs[0], path: "docs/specs/payments.md" }] }));
    write(f, "src/pay/charge.ts", "export const charge = 2;\n");
    git(f, "add", "-A");
    const renamed = run(f, "spec-sync", "check");
    assert.equal(renamed.status, 1, renamed.out);
    assert.match(renamed.out, /code-without-spec-change/, "a rename alone does not clear it");
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, specs: [{ ...CONFIG.specs[0], path: "docs/specs/Payments.md" }] }));
    const cased = run(f, "spec-sync", "check");
    assert.equal(cased.status, 2, cased.out);
    assert.match(cased.out, /specs\[0\]\.path/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

const FAILING_XML = `<testsuites><testsuite name="p"><testcase classname="p" name="[PAY-1.1] captures once"><failure>x</failure></testcase></testsuite></testsuites>`;
const PASSING_XML = `<testsuites><testsuite name="p"><testcase classname="p" name="[PAY-1.1] captures once"/><testcase classname="p" name="[PAY-1.2] caps refunds"/></testsuite></testsuites>`;

/** A git call whose commit and HEAD move are dated `epochSec` (author, committer, reflog),
 *  with HEAD's reflog file mtime set to match, as git appending the entry then would. */
function gitAt(f: Fixture, epochSec: number, ...args: string[]): string {
  const date = `@${epochSec} +0000`;
  const out = execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: { ...f.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const log = join(f.root, ".git", "logs", "HEAD");
  if (existsSync(log)) utimesSync(log, epochSec, epochSec);
  return out;
}

/** The tests' clock (unix seconds), two hours ahead of the real one: every simulated report
 *  then comes after the real moment HEAD's reflog file was born, as it does outside tests
 *  once a repository has its first commit (a reflog file born after the report reads as
 *  rewritten, and every report is stale). */
function simNow(): number {
  return Math.floor(Date.now() / 1000) + 7200;
}

/** Whether the filesystem dates the birth of HEAD's reflog file. Without a birth time a
 *  reflog file replaced after the report cannot be seen (SS-4.7, known limit). */
function reflogHasBirthTime(f: Fixture): boolean {
  return statSync(join(f.root, ".git", "logs", "HEAD")).birthtimeMs > 0;
}

/** Blocks until the real clock reaches `epochSec`. */
function sleepUntil(epochSec: number): void {
  const ms = epochSec * 1000 - Date.now();
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function setTime(f: Fixture, epochSec: number, ...files: string[]): void {
  for (const file of files) utimesSync(join(f.root, file), epochSec, epochSec);
}

test("[SS-4.6][SS-4.7] check: a root-level report written after a committed directory deletion is fresh, whatever touched the root since", () => {
  const f = makeFixture("junitroot");
  try {
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, specs: [{ ...CONFIG.specs[0], code: ["src/pay/**", "lib/**"] }], junit: ["junit.xml"] }));
    write(f, ".gitignore", "junit.xml\n");
    write(f, "lib/a.ts", "export const a = 1;\n");
    git(f, "add", "-A");
    const now = simNow();
    gitAt(f, now - 180, "commit", "-qm", "lib");
    git(f, "rm", "-q", "-r", "lib");
    gitAt(f, now - 120, "commit", "-qm", "drop lib");
    setTime(f, now - 600, "src/pay/charge.ts", "test/pay.test.ts");
    write(f, "junit.xml", FAILING_XML);
    setTime(f, now - 60, "junit.xml");
    setTime(f, now, "."); // a later change to the repository root
    for (const args of [[], ["--require-junit"]]) {
      const r = run(f, "spec-sync", "check", ...args);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /\[failing\] PAY-1\.1/);
      assert.doesNotMatch(r.out, /junit-skipped/);
    }
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a file added on the branch and deleted in a commit after the report makes it stale", () => {
  const f = makeFixture("junitlate");
  try {
    const now = simNow();
    write(f, "src/pay/helper.ts", "export const helper = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 300, "commit", "-qm", "add helper");
    setTime(f, now - 600, "src/pay/charge.ts", "src/pay/helper.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 60, "reports/junit.xml");
    const fresh = run(f, "spec-sync", "check");
    assert.equal(fresh.status, 1, fresh.out);
    assert.match(fresh.out, /\[failing\] PAY-1\.1/);
    git(f, "rm", "-q", "src/pay/helper.ts");
    gitAt(f, now - 30, "commit", "-qm", "drop helper");
    const stale = run(f, "spec-sync", "check");
    assert.equal(stale.status, 0, stale.out);
    assert.match(stale.out, /\[junit-skipped\].*stale/);
    assert.doesNotMatch(stale.out, /\[failing\]/);
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.6][SS-4.7] check: a gitignored report found by glob is read; an uncommitted deletion makes it stale until committed", () => {
  const f = makeFixture("junitfs");
  try {
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, junit: ["reports/*.xml"] }));
    write(f, ".gitignore", "reports/\n");
    write(f, "test/pay2.test.ts", "it('[PAY-1.1] again', () => {});\nit('[PAY-1.2] again', () => {});\n");
    git(f, "add", "-A");
    git(f, "commit", "-qm", "ignore reports");
    write(f, "reports/junit.xml", FAILING_XML);
    const future = Math.floor(Date.now() / 1000) + 60;
    setTime(f, future, "reports/junit.xml");
    const fresh = run(f, "spec-sync", "check");
    assert.equal(fresh.status, 1, fresh.out);
    assert.match(fresh.out, /\[failing\] PAY-1\.1/);
    git(f, "rm", "-q", "test/pay2.test.ts");
    // Even a report dated after the deletion: an uncommitted deletion cannot be dated.
    const stale = run(f, "spec-sync", "check");
    assert.equal(stale.status, 0, stale.out);
    assert.match(stale.out, /\[junit-skipped\].*stale/);
    assert.doesNotMatch(stale.out, /\[failing\]/);
    git(f, "commit", "-qm", "drop pay2");
    setTime(f, future, "reports/junit.xml");
    const committed = run(f, "spec-sync", "check");
    assert.equal(committed.status, 1, committed.out);
    assert.match(committed.out, /\[failing\] PAY-1\.1/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check --require-junit: a stale report is no finding for a spec another report covers fresh", () => {
  const f = makeFixture("junittwo");
  try {
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, junit: ["reports/*.xml"] }));
    write(f, "reports/a.xml", PASSING_XML);
    write(f, "reports/b.xml", FAILING_XML);
    const now = Math.floor(Date.now() / 1000); // real: the inputs were just written
    setTime(f, now + 60, "reports/a.xml");
    setTime(f, now - 3600, "reports/b.xml");
    const both = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(both.status, 0, both.out);
    assert.doesNotMatch(both.out, /junit-skipped|failing/);
    unlinkSync(join(f.root, "reports/a.xml"));
    const onlyStale = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(onlyStale.status, 1, onlyStale.out);
    assert.match(onlyStale.out, /✗ \[junit-skipped\] JUnit report reports\/b\.xml .*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-2.4] add does not propose a named path that is no valid glob; the written config still loads", () => {
  const f = makeFixture("addbrace", { config: false });
  try {
    write(f, "src/a{b/x.ts", "export const x = 1;\n");
    write(f, "docs/specs/pay.md", `${SPEC}Helpers in \`src/a{b/x.ts\`.\n`);
    const r = run(f, "spec-sync", "add", "docs/specs/pay.md");
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not proposed.*src\/a\{b\/x\.ts/);
    const cfg = JSON.parse(readFileSync(join(f.root, ".hunch/spec-sync.json"), "utf8"));
    assert.deepEqual(cfg.specs[0].code, ["src/pay/charge.ts"]);
    const check = run(f, "spec-sync", "check");
    assert.notEqual(check.status, 2, check.out);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-7.3] any unexpected error exits 2; an untracked nested repository is not an added file", () => {
  const f = makeFixture("errors");
  try {
    write(f, "vendor-clone/f.js", "x\n");
    execFileSync("git", ["init", "-q"], { cwd: join(f.root, "vendor-clone"), env: f.env });
    const nested = run(f, "spec-sync", "check");
    assert.equal(nested.status, 0, nested.out);
    // rmSync-ok: replaces the config file with a directory to provoke EISDIR
    rmSync(join(f.root, ".hunch/spec-sync.json"));
    mkdirSync(join(f.root, ".hunch/spec-sync.json"));
    const dir = run(f, "spec-sync", "check");
    assert.equal(dir.status, 2, dir.out);
    assert.equal(run(f, "spec-sync", "on").status, 2);
  } finally {
    cleanupDir(f.sandbox);
  }
});

// ---- review-round regressions ---------------------------------------------------

test("[SS-7.3] usage errors exit 2 (never 1, which means findings); help exits 0", () => {
  const f = makeFixture("usage");
  try {
    for (const args of [["check", "--bogus"], ["bogus"], [], ["check", "--base"], ["add"], ["check", "extra"]]) {
      const r = run(f, "spec-sync", ...args);
      assert.equal(r.status, 2, `spec-sync ${args.join(" ")}: ${r.out}`);
    }
    assert.equal(run(f, "spec-sync", "--help").status, 0);
    assert.equal(run(f, "spec-sync", "help").status, 0);
    assert.equal(run(f, "spec-sync", "check", "--help").status, 0);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-1.3] on validates a legacy header before import: an invalid glob is reported, never written", () => {
  const f = makeFixture("legacybad", { config: false });
  try {
    write(f, "docs/specs/bad.md", "<!-- spec-sync id=BAD code=src/{a,b tests=test/** -->\n# Bad\n- [BAD-1.1] x\n");
    const on = run(f, "spec-sync", "on");
    assert.equal(on.status, 0, on.out);
    assert.match(on.out, /legacy header not imported: docs\/specs\/bad\.md: .*code/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".hunch/spec-sync.json"), "utf8")).specs, []);
    assert.notEqual(run(f, "spec-sync", "check").status, 2);
    assert.equal(run(f, "spec-sync", "off").status, 0);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-2.4] add stores the repository's exact path, whatever case was typed; an unknown path exits 2", () => {
  const f = makeFixture("addcase", { config: false });
  try {
    const r = run(f, "spec-sync", "add", "Docs/Specs/PAY.md");
    assert.equal(r.status, 0, r.out);
    assert.equal(JSON.parse(readFileSync(join(f.root, ".hunch/spec-sync.json"), "utf8")).specs[0].path, "docs/specs/pay.md");
    const check = run(f, "spec-sync", "check");
    assert.notEqual(check.status, 2, check.out);
    const missing = run(f, "spec-sync", "add", "docs/specs/absent.md");
    assert.equal(missing.status, 2, missing.out);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-7.3] a failed git diff is an error (exit 2), never \"no changes\"", () => {
  const f = makeFixture("gitfail");
  try {
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, specs: [] }));
    write(f, "src/pay/new.ts", "export const n = 1;\n");
    git(f, "add", "-A");
    git(f, "commit", "-qm", "feat");
    // Remove the base commit's root tree object: the diff from base can no longer be read.
    const tree = git(f, "rev-parse", "main^{tree}");
    const obj = join(f.root, ".git", "objects", tree.slice(0, 2), tree.slice(2));
    chmodSync(obj, 0o666);
    unlinkSync(obj);
    const r = run(f, "spec-sync", "check");
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /git diff/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-6.7] a repository with no commits diffs against its own empty tree (SHA-256 too)", () => {
  const f = makeFixture("sha256", { commit: false, sha256: true });
  try {
    const r = run(f, "spec-sync", "check");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[new-code-no-spec\] src\/util\.ts/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a committed deletion dates by when HEAD moved, not by the commit's own date", () => {
  const f = makeFixture("junitmoved");
  try {
    const now = simNow();
    // A deletion committed an hour ago elsewhere, fast-forwarded in after the report.
    // Every HEAD move is dated, so the reflog reads in time order like a real one. The
    // helper exists on feat, so the fast-forward really removes it from the work tree.
    write(f, "src/pay/helper.ts", "export const helper = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add helper");
    gitAt(f, now - 3650, "checkout", "-q", "-b", "up");
    git(f, "rm", "-q", "src/pay/helper.ts");
    gitAt(f, now - 3600, "commit", "-qm", "drop helper");
    gitAt(f, now - 3500, "checkout", "-q", "feat");
    gitAt(f, now, "merge", "-q", "--ff-only", "up");
    setTime(f, now - 600, "src/pay/charge.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 60, "reports/junit.xml");
    const stale = run(f, "spec-sync", "check");
    assert.equal(stale.status, 0, stale.out);
    assert.match(stale.out, /\[junit-skipped\].*stale/);
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
    // A deletion committed with the clock ahead: no later move is dated before it, so the
    // fast-forward after it counts at that time too, and a report written in between is
    // stale (over-stale, never wrongly fresh) until it is regenerated after that time.
    gitAt(f, now - 20, "checkout", "-q", "up");
    write(f, "src/pay/later.ts", "export const later = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 30, "commit", "-qm", "add later");
    git(f, "rm", "-q", "src/pay/later.ts");
    gitAt(f, now + 300, "commit", "-qm", "drop later (clock ahead)");
    gitAt(f, now - 10, "checkout", "-q", "feat");
    gitAt(f, now, "merge", "-q", "--ff-only", "up");
    setTime(f, now - 600, "src/pay/charge.ts", "test/pay.test.ts");
    setTime(f, now + 60, "reports/junit.xml");
    assertStale(f);
    setTime(f, now + 360, "reports/junit.xml");
    const fresh = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(fresh.status, 1, fresh.out);
    assert.match(fresh.out, /\[failing\] PAY-1\.1/);
    assert.doesNotMatch(fresh.out, /junit-skipped/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7] check: a file staged as new and then removed from the working tree makes a report stale, commits or not", () => {
  for (const commit of [true, false]) {
    const f = makeFixture(`junitad${commit ? "" : "0"}`, { commit });
    try {
      if (!commit) git(f, "add", "-A");
      write(f, "src/pay/staged.ts", "export const staged = 1;\n");
      git(f, "add", "src/pay/staged.ts");
      write(f, "reports/junit.xml", FAILING_XML);
      const future = Math.floor(Date.now() / 1000) + 60;
      setTime(f, future, "reports/junit.xml");
      const fresh = run(f, "spec-sync", "check");
      assert.match(fresh.out, /\[failing\] PAY-1\.1/, fresh.out);
      unlinkSync(join(f.root, "src/pay/staged.ts"));
      const stale = run(f, "spec-sync", "check");
      assert.notEqual(stale.status, 2, stale.out); // other findings (new code) may exit 1
      assert.match(stale.out, /\[junit-skipped\].*stale/);
      assert.doesNotMatch(stale.out, /\[failing\]/);
    } finally {
      cleanupDir(f.sandbox);
    }
  }
});

/** Main adds src/pay/helper.ts, then drops it; `feat` takes the add in (all HEAD moves dated). */
function mainDropsHelper(f: Fixture, now: number): void {
  gitAt(f, now - 3800, "checkout", "-q", "main");
  write(f, "src/pay/helper.ts", "export const helper = 1;\n");
  git(f, "add", "-A");
  gitAt(f, now - 3700, "commit", "-qm", "add helper");
  gitAt(f, now - 3650, "checkout", "-q", "feat");
  gitAt(f, now - 3600, "merge", "-q", "--ff-only", "main");
  gitAt(f, now - 3500, "checkout", "-q", "main");
  git(f, "rm", "-q", "src/pay/helper.ts");
  gitAt(f, now - 3400, "commit", "-qm", "drop helper");
  gitAt(f, now - 3300, "checkout", "-q", "feat");
}

test("[SS-4.7][SS-4.9] check: a deletion merged in from the base side makes an older report stale", () => {
  const f = makeFixture("junitbasemerge");
  try {
    const now = simNow();
    mainDropsHelper(f, now);
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    gitAt(f, now - 30, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a deletion fast-forwarded in on the base itself (base == HEAD) makes an older report stale", () => {
  const f = makeFixture("junitonmain");
  try {
    const now = simNow();
    gitAt(f, now - 3800, "checkout", "-q", "main");
    write(f, "src/pay/helper.ts", "export const helper = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add helper");
    gitAt(f, now - 3690, "checkout", "-q", "-b", "up");
    git(f, "rm", "-q", "src/pay/helper.ts");
    gitAt(f, now - 3600, "commit", "-qm", "drop helper");
    gitAt(f, now - 3500, "checkout", "-q", "main");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    gitAt(f, now - 30, "merge", "-q", "--ff-only", "up");
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a base-side deletion stays stale however many HEAD moves follow it", () => {
  const f = makeFixture("junitbasemoves");
  try {
    const now = simNow();
    mainDropsHelper(f, now);
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    gitAt(f, now - 500, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    for (let i = 0; i < 5; i++) gitAt(f, now - 400 + i * 10, "commit", "-q", "--allow-empty", "-m", `later ${i}`);
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a soft reset that recommits the same tree after the report deletes nothing", () => {
  const f = makeFixture("junitsoftreset");
  try {
    const now = simNow();
    gitAt(f, now - 3800, "checkout", "-q", "feat");
    write(f, "src/pay/z.ts", "export const z = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add z");
    setTime(f, now - 1200, "src/pay/charge.ts", "src/pay/z.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    gitAt(f, now - 300, "reset", "-q", "--soft", "HEAD~1");
    gitAt(f, now - 200, "commit", "-qm", "add z, reworded");
    const fresh = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(fresh.status, 1, fresh.out);
    assert.match(fresh.out, /\[failing\] PAY-1\.1/);
    assert.doesNotMatch(fresh.out, /junit-skipped/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a test file on disk at report time, committed after it and then checked out away, makes the report stale", () => {
  const f = makeFixture("junitaddlater");
  try {
    const now = simNow();
    gitAt(f, now - 3800, "checkout", "-q", "feat");
    write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", "test/pay2.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    git(f, "add", "test/pay2.test.ts");
    gitAt(f, now - 300, "commit", "-qm", "add pay2 test");
    gitAt(f, now - 200, "checkout", "-q", "main"); // pay2.test.ts leaves the work tree
    assert.ok(!existsSync(join(f.root, "test/pay2.test.ts")));
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a deletion dates by its own HEAD move, so a report written after it stays fresh through later moves", () => {
  const f = makeFixture("junitmulti");
  try {
    const now = simNow();
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, junit: ["reports/*.xml"] }));
    write(f, "src/pay/helper.ts", "export const helper = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 3800, "commit", "-qm", "add helper");
    setTime(f, now - 3000, "src/pay/charge.ts", "test/pay.test.ts", ".hunch/spec-sync.json");
    write(f, "reports/old.xml", PASSING_XML);
    setTime(f, now - 2000, "reports/old.xml");
    git(f, "rm", "-q", "src/pay/helper.ts");
    gitAt(f, now - 1500, "commit", "-qm", "drop helper");
    write(f, "reports/new.xml", FAILING_XML);
    setTime(f, now - 1000, "reports/new.xml");
    write(f, "notes.txt", "unrelated\n");
    git(f, "add", "notes.txt");
    gitAt(f, now - 500, "commit", "-qm", "unrelated");
    const r = run(f, "spec-sync", "check", "--require-junit");
    // old.xml is stale (the deletion came after it) but new.xml covers PAY, fresh.
    assert.match(r.out, /\[failing\] PAY-1\.1/, r.out);
    assert.doesNotMatch(r.out, /✗ \[junit-skipped\]/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: with the reflog expired, a HEAD move after the report makes it stale (fails closed)", () => {
  const f = makeFixture("junitexpire");
  try {
    const now = simNow();
    mainDropsHelper(f, now);
    git(f, "reflog", "expire", "--expire=now", "--all");
    setTime(f, now - 1200, "src/pay/charge.ts", "src/pay/helper.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    const fresh = run(f, "spec-sync", "check", "--require-junit");
    assert.match(fresh.out, /\[failing\] PAY-1\.1/, fresh.out);
    assert.doesNotMatch(fresh.out, /junit-skipped/);
    gitAt(f, now - 30, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    const required = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(required.status, 1, required.out);
    assert.match(required.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

/** On feat: commits test/pay2.test.ts, writes a failing report after it, then resets --hard
 *  back past that commit (pay2 leaves the work tree). Returns the dropped commit. */
function reportThenDropPay2(f: Fixture, now: number): string {
  write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
  git(f, "add", "-A");
  gitAt(f, now - 3700, "commit", "-qm", "add pay2 test");
  const dropped = git(f, "rev-parse", "HEAD");
  setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", "test/pay2.test.ts");
  write(f, "reports/junit.xml", FAILING_XML);
  setTime(f, now - 600, "reports/junit.xml");
  gitAt(f, now - 300, "reset", "-q", "--hard", "HEAD~1");
  setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
  return dropped;
}

function assertStale(f: Fixture): void {
  const r = run(f, "spec-sync", "check", "--require-junit");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ \[junit-skipped\].*stale/);
  assert.doesNotMatch(r.out, /\[failing\]/);
}

test("[SS-4.7][SS-4.9] check: a reflog rewritten after the report (expire of unreachable entries, gc) keeps it stale", (t) => {
  for (const emptied of [false, true]) {
    const f = makeFixture(`junitgcgap${emptied ? "0" : ""}`);
    try {
      // Real time here: the report comes after the reflog file was born and before the
      // rewrite, so only the rewrite itself can tell that moves were dropped.
      const now = Math.floor(Date.now() / 1000) + 602; // report at real +2 s
      reportThenDropPay2(f, now);
      assertStale(f);
      if (!reflogHasBirthTime(f)) {
        t.diagnostic("no file birth time on this filesystem: a rewritten reflog is not seen, rest not run");
        continue;
      }
      sleepUntil(now - 597);
      if (emptied) {
        git(f, "reflog", "expire", "--expire=now", "--all"); // leaves an empty file
        assert.equal(readFileSync(join(f.root, ".git", "logs", "HEAD"), "utf8"), "");
      } else {
        // Drops both the commit and the reset entries: the remaining reflog is consistent.
        git(f, "reflog", "expire", "--expire-unreachable=now", "--all");
        git(f, "gc", "-q", "--prune=now");
      }
      assertStale(f);
      // A later ordinary move does not hide the rewrite.
      gitAt(f, now, "commit", "-q", "--allow-empty", "-m", "next");
      assertStale(f);
    } finally {
      cleanupDir(f.sandbox);
    }
  }
});

test("[SS-4.7][SS-4.9] check: an orphan commit after the report that drops a test file makes it stale", () => {
  const f = makeFixture("junitorphan");
  try {
    const now = simNow();
    write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add pay2 test");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", "test/pay2.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    gitAt(f, now - 300, "checkout", "-q", "--orphan", "fresh");
    git(f, "rm", "-q", "-f", "test/pay2.test.ts");
    gitAt(f, now - 200, "commit", "-qm", "squashed history");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    const r = run(f, "spec-sync", "check", "--base", "HEAD", "--require-junit");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✗ \[junit-skipped\].*stale/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a back-dated commit that deletes a test file stays stale after a later commit", () => {
  const f = makeFixture("junitbackdel");
  try {
    const now = simNow();
    write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add pay2 test");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", "test/pay2.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    git(f, "rm", "-q", "test/pay2.test.ts");
    gitAt(f, now - 3800, "commit", "-qm", "drop pay2, committer date before the last commit's");
    utimesSync(join(f.root, ".git", "logs", "HEAD"), now - 300, now - 300); // written now, really
    assertStale(f);
    gitAt(f, now - 200, "commit", "-q", "--allow-empty", "-m", "next");
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a HEAD move whose commit object is gone makes the report stale", () => {
  const f = makeFixture("junitmissobj");
  try {
    const now = simNow();
    const dropped = reportThenDropPay2(f, now);
    unlinkSync(join(f.root, ".git", "objects", dropped.slice(0, 2), dropped.slice(2)));
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: an entry gone from the middle of the reflog is itself a step, so its deletion still counts", () => {
  const f = makeFixture("junitmidgap");
  try {
    const now = simNow();
    reportThenDropPay2(f, now);
    write(f, "notes.txt", "unrelated\n");
    git(f, "add", "notes.txt");
    gitAt(f, now - 200, "commit", "-qm", "unrelated");
    // Drop the reset's entry by hand: the commit entry's new end no longer meets the next old end.
    const log = join(f.root, ".git", "logs", "HEAD");
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l && !/\treset: /.test(l));
    writeFileSync(log, `${lines.join("\n")}\n`);
    utimesSync(log, now - 200, now - 200);
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a later HEAD move dated back cannot hide an earlier deletion after the report", () => {
  const f = makeFixture("junitbackhide");
  try {
    const now = simNow();
    mainDropsHelper(f, now);
    setTime(f, now - 1200, "src/pay/charge.ts", "src/pay/helper.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    gitAt(f, now - 300, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    write(f, "notes.txt", "unrelated\n");
    git(f, "add", "notes.txt");
    gitAt(f, now - 7200, "commit", "-qm", "unrelated, committer date two hours back");
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a first commit's own step deletes nothing: fresh, unless the reflog file's birth says otherwise", () => {
  const f = makeFixture("junitinitial", { commit: false });
  try {
    // Simulated clock: the report is dated after the reflog file's real birth (see the next
    // test for a new repository on the real clock).
    const now = simNow();
    write(f, ".gitignore", "reports/\n");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", "src/util.ts", "docs/specs/pay.md", ".hunch/spec-sync.json", ".gitignore");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    git(f, "add", "-A");
    gitAt(f, now - 300, "commit", "-qm", "base");
    const r = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[failing\] PAY-1\.1/);
    assert.doesNotMatch(r.out, /junit-skipped/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: in a new repository the first commit after the report makes it stale (the reflog file is born with it)", () => {
  const f = makeFixture("junitnewrepo", { commit: false });
  try {
    // Real time: HEAD's reflog file does not exist before this commit, so it is born after
    // the report, which reads the same as a reflog rewritten after it. Fails closed.
    const now = Math.floor(Date.now() / 1000);
    write(f, ".gitignore", "reports/\n");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", "src/util.ts", "docs/specs/pay.md", ".hunch/spec-sync.json", ".gitignore");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 2, "reports/junit.xml");
    git(f, "add", "-A");
    git(f, "commit", "-qm", "base");
    if (reflogHasBirthTime(f)) {
      assertStale(f);
    } else {
      const r = run(f, "spec-sync", "check", "--require-junit");
      assert.match(r.out, /\[failing\] PAY-1\.1/, r.out);
      assert.doesNotMatch(r.out, /junit-skipped/);
    }
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a HEAD move stamped before the report but written after it makes the report stale", () => {
  const f = makeFixture("junitlatewrite");
  try {
    // Git stamps a reflog entry with the second its process first asked for the time, so a
    // rebase that fast-forwards picks after an exec step, or a slow merge, stamps a move made
    // after a report with a time before it. The reflog file's mtime says when the newest
    // entry was written.
    const now = simNow();
    write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add pay2 test");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 600, "reports/junit.xml");
    // Two moves with one stamp; the older of the two drops pay2.
    gitAt(f, now - 700, "reset", "-q", "--hard", "HEAD~1");
    gitAt(f, now - 700, "commit", "-q", "--allow-empty", "-m", "next");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    // Stamped and written before the report: fresh.
    const fresh = run(f, "spec-sync", "check", "--require-junit");
    assert.match(fresh.out, /\[failing\] PAY-1\.1/, fresh.out);
    assert.doesNotMatch(fresh.out, /junit-skipped/);
    // The same stamps, the file written after the report, pay2's directory last changed
    // before it (a rebase's last entry, written after the exec step that ran the tests): the
    // removal still dates before the report.
    const log = join(f.root, ".git", "logs", "HEAD");
    utimesSync(log, now - 300, now - 300);
    setTime(f, now - 700, "test");
    const late = run(f, "spec-sync", "check", "--require-junit");
    assert.match(late.out, /\[failing\] PAY-1\.1/, late.out);
    assert.doesNotMatch(late.out, /junit-skipped/);
    // The directory changed after the report too: the removal may have come after it.
    setTime(f, now - 300, "test");
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a report written by a rebase's last exec step stays fresh, though git writes a reflog entry after it", (t) => {
  const f = makeFixture("junitrebasex");
  try {
    // Real time. The last commit on feat drops pay2; `git rebase -x` replays the commits and
    // runs the exec step after each, which writes the report; git then writes its "rebase
    // (finish)" entry, after the report, with the stamp the rebase started with.
    write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
    git(f, "add", "-A");
    git(f, "commit", "-qm", "add pay2 test");
    write(f, "notes.txt", "unrelated\n");
    git(f, "add", "-A");
    git(f, "commit", "-qm", "unrelated");
    git(f, "rm", "-q", "test/pay2.test.ts");
    git(f, "commit", "-qm", "drop pay2 test");
    const script = join(f.sandbox, "report.cjs");
    writeFileSync(script, [
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);",
      "const fs = require('node:fs');",
      "fs.mkdirSync('reports', { recursive: true });",
      `fs.writeFileSync('reports/junit.xml', ${JSON.stringify(FAILING_XML)});`,
    ].join("\n"));
    const slash = (p: string) => p.replace(/\\/g, "/");
    git(f, "rebase", "-q", "-x", `"${slash(process.execPath)}" "${slash(script)}"`, "main");
    const log = join(f.root, ".git", "logs", "HEAD");
    const report = statSync(join(f.root, "reports/junit.xml")).mtimeMs;
    const stamp = Number(/> (\d+) [+-]\d{4,}\t[^\n]*\n?$/.exec(readFileSync(log, "utf8"))?.[1]);
    if (!(statSync(log).mtimeMs >= report && stamp * 1000 + 999 < report)) {
      t.diagnostic("this git did not stamp its last rebase entry before the report: the late-written case is not exercised");
    }
    assert.equal(existsSync(join(f.root, "test/pay2.test.ts")), false);
    const r = run(f, "spec-sync", "check", "--require-junit");
    assert.match(r.out, /\[failing\] PAY-1\.1/, r.out);
    assert.doesNotMatch(r.out, /junit-skipped/);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a reflog file emptied after the report keeps it stale, whatever its birth time says", () => {
  const f = makeFixture("junitemptied");
  try {
    const now = simNow();
    reportThenDropPay2(f, now);
    assertStale(f);
    // What `git reflog expire --expire=now --all` leaves, here with the old file's birth
    // time, as NTFS gives a file recreated within seconds of the one it replaces.
    const log = join(f.root, ".git", "logs", "HEAD");
    writeFileSync(log, "");
    utimesSync(log, now - 250, now - 250);
    assert.ok(statSync(log).birthtimeMs < (now - 600) * 1000, "the file's birth time is before the report");
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

test("[SS-4.7][SS-4.9] check: a reflog file emptied between two reports still dates a later deletion by its commit", () => {
  const f = makeFixture("junitemptied2");
  try {
    const now = simNow();
    write(f, ".hunch/spec-sync.json", JSON.stringify({ ...CONFIG, junit: ["reports/*.xml"] }));
    write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add pay2 test");
    git(f, "rm", "-q", "test/pay2.test.ts");
    gitAt(f, now - 300, "commit", "-qm", "drop pay2 test");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts", ".hunch/spec-sync.json");
    write(f, "reports/old.xml", FAILING_XML);
    setTime(f, now - 600, "reports/old.xml");
    write(f, "reports/new.xml", FAILING_XML);
    setTime(f, now - 400, "reports/new.xml");
    // The file emptied after the old report and before the new one, with no entry for the
    // drop (as after a HEAD change that writes none): the old report is stale by the file's
    // mtime, the new one by the drop's commit time.
    const log = join(f.root, ".git", "logs", "HEAD");
    writeFileSync(log, "");
    utimesSync(log, now - 500, now - 500);
    assertStale(f);
  } finally {
    cleanupDir(f.sandbox);
  }
});

/** Whether this git can create a repository on the reftable ref backend (2.45 on). */
function gitHasReftable(): boolean {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 45));
}

test("[SS-4.7][SS-4.9] check: HEAD away from its newest reflog entry is a step on either ref backend", (t) => {
  for (const reftable of [false, true]) {
    if (reftable && !gitHasReftable()) {
      t.diagnostic("this git has no reftable backend: reftable case not run");
      continue;
    }
    const f = makeFixture(`junitaway${reftable ? "rt" : ""}`, { reftable });
    try {
      const now = simNow();
      write(f, "test/pay2.test.ts", "it('[PAY-1.2] caps refunds again', () => {});\n");
      git(f, "add", "-A");
      gitAt(f, now - 3700, "commit", "-qm", "add pay2 test");
      gitAt(f, now - 3600, "checkout", "-q", "main");
      const w: Fixture = { ...f, root: join(f.sandbox, "wt") };
      git(f, "worktree", "add", "-q", w.root, "feat");
      write(w, "reports/junit.xml", FAILING_XML);
      setTime(w, now - 600, "reports/junit.xml");
      const fresh = run(w, "spec-sync", "check", "--require-junit");
      assert.match(fresh.out, /\[failing\] PAY-1\.1/, fresh.out);
      assert.doesNotMatch(fresh.out, /junit-skipped/);
      // The branch moves from the other worktree and this one follows it: pay2 leaves the
      // work tree with no entry in this worktree's HEAD reflog.
      git(f, "update-ref", "refs/heads/feat", "main");
      git(w, "restore", "-s", "HEAD", "-SW", ".");
      assert.equal(existsSync(join(w.root, "test/pay2.test.ts")), false);
      assert.equal(git(w, "status", "--porcelain", "--untracked-files=no"), "");
      assertStale(w);
    } finally {
      cleanupDir(f.sandbox);
    }
  }
});

test("[SS-4.7][SS-4.9] check: a base-side deletion merged in before the report leaves it fresh", () => {
  const f = makeFixture("junitbasefresh");
  try {
    const now = simNow();
    mainDropsHelper(f, now);
    gitAt(f, now - 3000, "merge", "-q", "--no-ff", "-m", "merge main", "main");
    setTime(f, now - 1200, "src/pay/charge.ts", "test/pay.test.ts");
    write(f, "reports/junit.xml", FAILING_XML);
    setTime(f, now - 60, "reports/junit.xml");
    const fresh = run(f, "spec-sync", "check", "--require-junit");
    assert.equal(fresh.status, 1, fresh.out);
    assert.match(fresh.out, /\[failing\] PAY-1\.1/);
    assert.doesNotMatch(fresh.out, /junit-skipped/);
  } finally {
    cleanupDir(f.sandbox);
  }
});
