/**
 * `hunch spec-sync` end to end in a temp git repo: on/off/add config handling (SS-8.5,
 * SS-2.4, SS-2.6) and `check` exit codes and findings against the diff from base
 * (SS-6.7, SS-5.1, SS-5.4, SS-4.7, SS-4.9, SS-7.3). Synthetic fixture: spec id PAY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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

function makeFixture(label: string, opts: { config?: boolean; commit?: boolean; sha256?: boolean } = {}): Fixture {
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
  git(f, "init", "-q", "-b", "main", ...(opts.sha256 ? ["--object-format=sha256"] : []));
  git(f, "config", "user.email", "t@example.com");
  git(f, "config", "user.name", "T");
  git(f, "config", "core.autocrlf", "false");
  write(f, "docs/specs/pay.md", SPEC);
  write(f, "src/pay/charge.ts", "export const charge = 1;\n");
  write(f, "src/util.ts", "export const util = 1;\n");
  write(f, "test/pay.test.ts", TESTS);
  if (opts.config !== false) write(f, ".hunch/spec-sync.json", `${JSON.stringify(CONFIG, null, 2)}\n`);
  if (opts.commit === false) return f;
  git(f, "add", "-A");
  git(f, "commit", "-qm", "base");
  git(f, "checkout", "-q", "-b", "feat");
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

/** A git call whose commit is dated `epochSec` (author and committer). */
function gitAt(f: Fixture, epochSec: number, ...args: string[]): string {
  const date = `@${epochSec} +0000`;
  return execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: { ...f.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    git(f, "commit", "-qm", "lib");
    const now = Math.floor(Date.now() / 1000);
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
    const now = Math.floor(Date.now() / 1000);
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
    const now = Math.floor(Date.now() / 1000);
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
    const now = Math.floor(Date.now() / 1000);
    // A deletion committed an hour ago elsewhere, fast-forwarded in after the report.
    git(f, "checkout", "-q", "-b", "up");
    write(f, "src/pay/helper.ts", "export const helper = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 3700, "commit", "-qm", "add helper");
    git(f, "rm", "-q", "src/pay/helper.ts");
    gitAt(f, now - 3600, "commit", "-qm", "drop helper");
    git(f, "checkout", "-q", "feat");
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
    // A future-dated deletion commit, but HEAD moved now and the report came after: fresh.
    git(f, "checkout", "-q", "up");
    write(f, "src/pay/later.ts", "export const later = 1;\n");
    git(f, "add", "-A");
    gitAt(f, now - 30, "commit", "-qm", "add later");
    git(f, "rm", "-q", "src/pay/later.ts");
    gitAt(f, now + 300, "commit", "-qm", "drop later (clock ahead)");
    git(f, "checkout", "-q", "feat");
    gitAt(f, now, "merge", "-q", "--ff-only", "up");
    setTime(f, now - 600, "src/pay/charge.ts", "test/pay.test.ts");
    setTime(f, now + 60, "reports/junit.xml");
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
