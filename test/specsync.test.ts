/**
 * spec-sync units (design SS-8.1, SS-8.2, SS-8.5): config validation and merge, glob
 * matching, the clause parser, test-name extractors, reference matching, the JUnit
 * reader and the findings engine. Fixtures are synthetic (spec id PAY, src/pay/*.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, tempDir } from "./fixtures.js";
import {
  SpecSyncConfigError, clausePrefixes, clauseRefs, clauseTextChanged, computeFindings, editSpecSyncConfig, compileGlob, isCodeFile, loadSpecSyncConfig,
  parseClauses, parseLegacyHeader, validateSpecSyncConfig, type CheckInput, type JunitCase, type SpecSyncConfig,
} from "../src/core/specsync.js";
import { extractTestNames } from "../src/extractors/specsyncTests.js";
import { parseDeletionLog, proposeGlobs } from "../src/cli/specsyncCommand.js";
import { JUNIT_MAX_BYTES, junitIsFresh, parseJunit, readJunitFile } from "../src/core/junit.js";

const PAY = { id: "PAY", path: "docs/specs/pay.md", code: ["src/pay/**"], tests: ["test/pay*.test.ts"] };

function configError(raw: unknown): SpecSyncConfigError {
  try {
    validateSpecSyncConfig(raw);
  } catch (e) {
    assert.ok(e instanceof SpecSyncConfigError, `expected a config error, got ${String(e)}`);
    return e;
  }
  assert.fail("expected a config error");
}

const names = (file: string, text: string) => extractTestNames(file, text).names.map((n) => n.name);

// ---- config ------------------------------------------------------------------

test("[SS-2.1][SS-2.5] invalid configs are errors that name the field, never defaults", () => {
  assert.equal(configError({ specs: [] }).field, "version");
  assert.equal(configError({ version: 2, specs: [] }).field, "version");
  assert.equal(configError({ version: 1 }).field, "specs");
  assert.equal(configError({ version: 1, specs: [{ ...PAY, id: "pay" }] }).field, "specs[0].id");
  assert.equal(configError({ version: 1, specs: [PAY, { ...PAY, path: "b.md" }] }).field, "specs[1].id");
  assert.match(configError({ version: 1, specs: [PAY, { ...PAY, path: "b.md" }] }).detail, /duplicate/);
  const { tests: _tests, ...noTests } = PAY;
  assert.equal(configError({ version: 1, specs: [noTests] }).field, "specs[0].tests");
  assert.equal(configError({ version: 1, specs: [{ ...PAY, code: "src/**" }] }).field, "specs[0].code");
  assert.equal(configError({ version: 1, enabled: "yes", specs: [] }).field, "enabled");
  assert.equal(configError({ version: 1, specs: [], testNamePatterns: [{ glob: "**/*.feature", regex: "^Scenario: .+$" }] }).field, "testNamePatterns[0].regex");
});

test("[SS-1.1][SS-2.5] absent config is off; enabled defaults to true; a parse error names the file", () => {
  const dir = tempDir("hunch-specsync-load-");
  try {
    assert.equal(loadSpecSyncConfig(dir), null);
    mkdirSync(join(dir, ".hunch"));
    writeFileSync(join(dir, ".hunch/spec-sync.json"), JSON.stringify({ version: 1, specs: [PAY] }));
    assert.equal(loadSpecSyncConfig(dir)!.enabled, true);
    writeFileSync(join(dir, ".hunch/spec-sync.json"), "{ not json");
    assert.throws(() => loadSpecSyncConfig(dir), (e: unknown) => e instanceof SpecSyncConfigError && e.field === "(parse)" && /spec-sync\.json/.test(e.message));
  } finally {
    cleanupDir(dir);
  }
});

test("[SS-8.5][SS-1.3][SS-1.4] on twice is a no-op, unparseable config is refused untouched, off keeps the file", () => {
  const dir = tempDir("hunch-specsync-edit-");
  const file = join(dir, ".hunch/spec-sync.json");
  try {
    const first = editSpecSyncConfig(dir, { enabled: true });
    assert.ok(first.created && first.written);
    const bytes = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    const second = editSpecSyncConfig(dir, { enabled: true });
    assert.equal(second.written, false);
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal(statSync(file).mtimeMs, mtime);

    // Existing entries and unknown keys survive; a registered id is kept, not replaced.
    writeFileSync(file, JSON.stringify({ version: 1, enabled: false, specs: [PAY], custom: { keep: 1 } }, null, 2));
    const merged = editSpecSyncConfig(dir, { enabled: true, addSpecs: [{ ...PAY, path: "other.md" }, { id: "REF", path: "docs/ref.md", code: [], tests: [] }] });
    assert.deepEqual(merged.kept, ["PAY"]);
    assert.deepEqual(merged.added.map((s) => s.id), ["REF"]);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.enabled, true);
    assert.deepEqual(raw.custom, { keep: 1 });
    assert.equal(raw.specs[0].path, PAY.path);

    const off = editSpecSyncConfig(dir, { enabled: false });
    assert.ok(off.written && existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, false);

    writeFileSync(file, "{ broken");
    assert.throws(() => editSpecSyncConfig(dir, { enabled: true }), SpecSyncConfigError);
    assert.equal(readFileSync(file, "utf8"), "{ broken");
  } finally {
    cleanupDir(dir);
  }
});

test("[SS-1.3] legacy pilot headers parse in single-line and multi-line form", () => {
  assert.deepEqual(parseLegacyHeader("# Pay\n<!-- spec-sync id=PAY code=src/pay/*.ts,src/{a,b}.ts tests=test/pay*.test.ts -->\n"),
    { id: "PAY", code: ["src/pay/*.ts", "src/{a,b}.ts"], tests: ["test/pay*.test.ts"] });
  assert.deepEqual(parseLegacyHeader("<!-- spec-sync\nid: PAY\ncode: src/pay/a.ts, src/pay/b.ts\ntests: test/pay.test.ts\n-->"),
    { id: "PAY", code: ["src/pay/a.ts", "src/pay/b.ts"], tests: ["test/pay.test.ts"] });
  assert.match(parseLegacyHeader("<!-- spec-sync id=pay tests=x -->")!.error!, /must match/);
  assert.equal(parseLegacyHeader("# no header"), null);
});

test("[SS-2.3] globs: *, **, ? and {a,b} over POSIX paths", () => {
  assert.ok(compileGlob("src/pay/*.ts").test("src/pay/a.ts"));
  assert.ok(!compileGlob("src/pay/*.ts").test("src/pay/x/a.ts"));
  assert.ok(compileGlob("src/**/*.ts").test("src/a.ts"));
  assert.ok(compileGlob("src/**/*.ts").test("src/x/y/a.ts"));
  assert.ok(compileGlob("src/pay/**").test("src/pay/x/y.ts"));
  assert.ok(compileGlob("test/pay?.test.ts").test("test/pay2.test.ts"));
  assert.ok(compileGlob("src/{pay,ref}/*.ts").test("src/ref/a.ts"));
  assert.ok(!compileGlob("src/{pay,ref}/*.ts").test("src/other/a.ts"));
});

// ---- clauses -----------------------------------------------------------------

const SPEC = [
  "# Payments",
  "",
  "- [PAY-1.1] A charge is captured once.",
  "- [PAY-1.2 manual] Receipts look right.",
  "  Inline examples like `[PAY-9.9]` are not clauses.",
  "```",
  "[PAY-8.8] fenced, not a clause",
  "```",
  "## Refunds",
  "- [PAY-2.1.3] A refund never exceeds the charge.",
  "- [PAY-1.1] duplicate.",
  "",
].join("\n");

test("[SS-3.1][SS-3.2][SS-3.3][SS-3.4] clause markers, manual, code exclusion and duplicates", () => {
  const p = parseClauses(SPEC, "PAY");
  assert.deepEqual(p.clauses.map((c) => [c.id, c.manual, c.line]), [["PAY-1.1", false, 3], ["PAY-1.2", true, 4], ["PAY-2.1.3", false, 10]]);
  assert.deepEqual(p.duplicates, [{ id: "PAY-1.1", lines: [3, 11] }]);
  assert.equal(parseClauses(SPEC, "REF").clauses.length, 0);
});

test("[SS-3.5] clause text runs to the next marker or heading; whitespace and wrapping are ignored", () => {
  const p = parseClauses(SPEC, "PAY");
  assert.match(p.clauses[1]!.text, /Receipts look right/);
  assert.doesNotMatch(p.clauses[1]!.text, /Refunds/);
  const rewrapped = SPEC.replace("A charge is captured once.", "A charge   is\n  captured once.");
  assert.equal(clauseTextChanged(SPEC, rewrapped, "PAY"), false);
  assert.equal(clauseTextChanged(SPEC, SPEC.replace("# Payments", "# Payments (v2)"), "PAY"), false, "edits outside clauses do not count");
  assert.equal(clauseTextChanged(SPEC, SPEC.replace("captured once", "captured twice"), "PAY"), true);
  assert.equal(clauseTextChanged(null, SPEC, "PAY"), true);
});

// ---- references and extractors ---------------------------------------------

test("[SS-4.2] literal and identifier forms match case-insensitively; PAY_1_20 is not PAY-1.2", () => {
  assert.deepEqual(clauseRefs("[PAY-1.2] refunds", ["PAY"]), ["PAY-1.2"]);
  assert.deepEqual(clauseRefs("pay-1.2 refunds", ["PAY"]), ["PAY-1.2"]);
  assert.deepEqual(clauseRefs("test_pay_1_2_refunds", ["PAY"]), ["PAY-1.2"]);
  assert.deepEqual(clauseRefs("TestPAY_1_2_Refunds", ["PAY"]), ["PAY-1.2"]);
  assert.deepEqual(clauseRefs("test_pay_1_20", ["PAY"]), ["PAY-1.20"]);
  assert.deepEqual(clauseRefs("PAY-1.20 boundary", ["PAY"]), ["PAY-1.20"]);
  assert.deepEqual(clauseRefs("REPAY-1.2 is another id", ["PAY"]), []);
  assert.deepEqual(clauseRefs("PAY_1_2x", ["PAY"]), []);
});

test("[SS-4.1][SS-4.3] JS/TS: it/test/describe incl. .only/.skip, describe nesting, template literals; comments never count", () => {
  const src = [
    "// it('[PAY-9.1] only in a comment', () => {})",
    "/* test('[PAY-9.2] block comment') */",
    "const helper = '[PAY-9.3] helper string';",
    "describe('[PAY-1.1] charges', () => {",
    "  it('captures once', () => { expect(/it\\('x'/.test(s)).toBe(true); });",
    "  test.only(`[PAY-1.2] ${kind} refund`, () => {});",
    "});",
    "it.skip(\"[PAY-2.1] outside\", () => {});",
    "describe.skip('plain', () => { it('[PAY-2.2] inner', () => {}); });",
  ].join("\n");
  assert.deepEqual(names("test/pay.test.ts", src), [
    "[PAY-1.1] charges > captures once",
    "[PAY-1.1] charges > [PAY-1.2]   refund",
    "[PAY-2.1] outside",
    "plain > [PAY-2.2] inner",
  ]);
  const all = names("test/pay.test.ts", src).flatMap((n) => clauseRefs(n, ["PAY"]));
  assert.ok(!all.some((r) => r.startsWith("PAY-9")), "ids in comments or helper strings never count");
});

test("[SS-4.3] JS/TS .each: titles on the following call; %s and $var placeholders ignored", () => {
  const src = [
    "it.each([[1], [2]])('[PAY-3.1] amount %s', (n) => {});",
    "test.each`",
    "  a | b",
    "  ${1} | ${2}",
    "`('[PAY-3.2] $a plus $b', ({ a, b }) => {});",
    "describe.each([1])('[PAY-3.3] group %d', () => { it('x', () => {}); });",
  ].join("\n");
  const got = names("test/pay.test.ts", src);
  assert.equal(got.length, 3);
  assert.deepEqual(got.flatMap((n) => clauseRefs(n, ["PAY"])), ["PAY-3.1", "PAY-3.2", "PAY-3.3"]);
  assert.doesNotMatch(got.join("|"), /%s|\$a/);
});

test("[SS-4.5][SS-8.1] a variable-named JS test is counted as unreadable", () => {
  const r = extractTestNames("test/pay.test.ts", "const name = 'x';\nit(name, () => {});\ntest(makeTitle(), () => {});\nit('[PAY-1.1] ok', () => {});\n");
  assert.equal(r.unreadable, 2);
  assert.deepEqual(r.names.map((n) => n.name), ["[PAY-1.1] ok"]);
});

test("[SS-4.1][SS-4.3] Python: def test_*, async def, @pytest.mark.spec; comments and docstrings never count", () => {
  const src = [
    "import pytest",
    "# def test_pay_9_1_comment(): pass",
    '"""',
    "def test_pay_9_2_in_docstring(): pass",
    '"""',
    "def test_pay_1_1_charges():",
    "    assert True",
    "class TestRefunds:",
    "    async def test_pay_1_2_refunds(self):",
    "        pass",
    '@pytest.mark.spec("PAY-2.1")',
    "def test_marked():",
    "    pass",
    "@pytest.mark.spec(CLAUSE)",
    "def test_unreadable_marker(): pass",
    "def helper_pay_3_1(): pass",
  ].join("\n");
  const r = extractTestNames("tests/test_pay.py", src);
  assert.deepEqual(r.names.map((n) => n.name), ["test_pay_1_1_charges", "test_pay_1_2_refunds", "PAY-2.1", "test_marked", "test_unreadable_marker"]);
  assert.equal(r.unreadable, 1);
});

test("[SS-4.4] a testNamePatterns entry replaces the built-in extractor for the files it matches", () => {
  const patterns = [{ glob: "test/**/*.feature", regex: "^\\s*Scenario:\\s*(.+)$" }, { glob: "test/custom/*.ts", regex: "^//\\s*case:\\s*(.+)$" }];
  assert.deepEqual(extractTestNames("test/pay/a.feature", "Feature: pay\n  Scenario: [PAY-1.1] charge once\n", patterns).names.map((n) => n.name), ["[PAY-1.1] charge once"]);
  // The custom glob wins over the JS extractor: only the pattern's matches count.
  assert.deepEqual(extractTestNames("test/custom/a.ts", "// case: PAY-1.2 custom\nit('[PAY-1.3] builtin', () => {});\n", patterns).names.map((n) => n.name), ["PAY-1.2 custom"]);
  assert.equal(extractTestNames("test/pay/a.rb", "it 'PAY-1.1'").supported, false);
});

// ---- JUnit -------------------------------------------------------------------

const PYTEST_XML = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4" time="0.05" timestamp="2026-11-12T10:00:00" hostname="h"><testcase classname="tests.test_pay" name="test_pay_1_1_charges" time="0.001" /><testcase classname="tests.test_pay" name="test_pay_1_2_refunds" time="0.002"><failure message="assert 1 == 2">def test_pay_1_2_refunds():&#10;&gt;       assert 1 == 2&#10;E       assert 1 == 2</failure></testcase><testcase classname="tests.test_pay" name="test_pay_1_3_later" time="0.000"><skipped type="pytest.skip" message="later">tests/test_pay.py:9: later</skipped></testcase><testcase classname="tests.test_pay" name="test_pay_1_4_db" time="0.000"><error message="failed on setup with &quot;fixture 'db' not found&quot;">file tests/test_pay.py, line 12</error></testcase></testsuite></testsuites>`;

const JEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="2" failures="1" errors="0" time="0.512">
  <testsuite name="payments" errors="0" failures="1" skipped="0" timestamp="2026-11-12T10:00:00" time="0.4" tests="2">
    <testcase classname="payments [PAY-1.1] charges once" name="payments [PAY-1.1] charges once" time="0.002">
    </testcase>
    <testcase classname="payments [PAY-1.2] refunds" name="payments [PAY-1.2] refunds" time="0.001">
      <failure><![CDATA[Error: expect(received).toBe(expected) // <testcase name="[PAY-7.7] fake"/> </testcase>]]></failure>
    </testcase>
  </testsuite>
</testsuites>`;

const VITEST_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.01">
    <testsuite name="test/pay.test.ts" timestamp="2026-11-12T10:00:00.000Z" hostname="h" tests="2" failures="0" errors="0" skipped="1" time="0.003">
        <testcase classname="test/pay.test.ts" name="payments &gt; [PAY-1.1] charges" time="0.001">
        </testcase>
        <testcase classname="test/pay.test.ts" name="payments &gt; [PAY-1.2] refunds" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

const MOCHA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" time="0.010" tests="2" failures="1">
  <testsuite name="Root Suite" timestamp="2026-11-12T10:00:00" tests="0" time="0.000" failures="0"></testsuite>
  <testsuite name="payments" timestamp="2026-11-12T10:00:00" tests="2" file="test/pay.test.js" time="0.003" failures="1">
    <testcase name="payments [PAY-1.1] charges" time="0.001" classname="[PAY-1.1] charges"></testcase>
    <testcase name="payments [PAY-1.2] refunds" time="0.000" classname="[PAY-1.2] refunds"><failure message="expected 1 to equal 2" type="AssertionError"><![CDATA[AssertionError: expected 1 to equal 2]]></failure></testcase>
  </testsuite>
</testsuites>`;

test("[SS-4.6][SS-8.2] JUnit reader: pytest, jest-junit, vitest and mocha-junit-reporter variants", () => {
  assert.deepEqual(parseJunit(PYTEST_XML).map((c) => [c.name, c.status]), [
    ["test_pay_1_1_charges", "passed"], ["test_pay_1_2_refunds", "failed"], ["test_pay_1_3_later", "skipped"], ["test_pay_1_4_db", "failed"],
  ]);
  assert.equal(parseJunit(PYTEST_XML)[0]!.classname, "tests.test_pay");
  const jest = parseJunit(JEST_XML);
  assert.deepEqual(jest.map((c) => c.status), ["passed", "failed"], "CDATA content is never parsed as markup");
  assert.deepEqual(parseJunit(VITEST_XML).map((c) => [c.name, c.status]), [["payments > [PAY-1.1] charges", "passed"], ["payments > [PAY-1.2] refunds", "skipped"]]);
  assert.deepEqual(parseJunit(MOCHA_XML).map((c) => [c.classname, c.status]), [["[PAY-1.1] charges", "passed"], ["[PAY-1.2] refunds", "failed"]]);
});

test("[SS-4.7][SS-7.4][SS-8.2] freshness against the newest test/code mtime; oversize reports are skipped", () => {
  assert.equal(junitIsFresh(2000, 1000), true);
  assert.equal(junitIsFresh(1000, 2000), false, "a report older than a code change is stale");
  const dir = tempDir("hunch-specsync-junit-");
  try {
    const file = join(dir, "junit.xml");
    writeFileSync(file, VITEST_XML);
    utimesSync(file, new Date(5_000_000_000), new Date(5_000_000_000));
    const r = readJunitFile(file);
    assert.ok(r.ok && r.cases.length === 2 && r.mtimeMs === 5_000_000_000);
    assert.equal(JUNIT_MAX_BYTES, 20 * 1024 * 1024);
    const big = readJunitFile(file, 10);
    assert.ok(!big.ok && big.reason === "too-large");
    assert.ok(!readJunitFile(join(dir, "absent.xml")).ok);
  } finally {
    cleanupDir(dir);
  }
});

// ---- findings ---------------------------------------------------------------

const CONFIG: SpecSyncConfig = {
  version: 1, enabled: true, specsDir: ["docs/specs"], specs: [PAY], ignore: ["**/*.md", "**/*.json"], junit: [], testNamePatterns: [],
};

function input(over: Partial<CheckInput> & { junit?: JunitCase[] | null; baseText?: string | null } = {}): CheckInput {
  const { junit = null, baseText = SPEC, ...rest } = over;
  return {
    config: CONFIG,
    specs: [{ spec: PAY, text: SPEC, baseText, junit }],
    tests: [{ file: "test/pay.test.ts", names: [{ name: "[PAY-1.1] charges", line: 1 }], unreadable: 0 }],
    changed: new Set(),
    added: new Set(),
    specsDirFiles: [],
    junitFindings: [],
    ...rest,
  };
}

const codes = (r: ReturnType<typeof computeFindings>) => r.findings.map((f) => `${f.code}:${f.subject}`).sort();

test("[SS-5][SS-3.3][SS-3.4] untested (manual exempt), duplicate-clause, orphan-ref, no-tests-recognised", () => {
  const r = computeFindings(input({
    tests: [
      { file: "test/pay.test.ts", names: [{ name: "[PAY-1.1] charges", line: 1 }, { name: "[PAY-4.4] gone", line: 2 }], unreadable: 1 },
      { file: "test/pay2.test.ts", names: [], unreadable: 0 },
    ],
  }));
  assert.deepEqual(codes(r), ["duplicate-clause:PAY-1.1", "no-tests-recognised:test/pay.test.ts", "no-tests-recognised:test/pay2.test.ts", "orphan-ref:PAY-4.4", "untested:PAY-2.1.3"]);
  assert.ok(r.findings.filter((f) => f.code === "no-tests-recognised").every((f) => !f.blocking));
  assert.match(r.findings.find((f) => f.subject === "test/pay.test.ts")!.message, /1 test declaration/);
});

test("[SS-5.1][SS-5.2][SS-5.3] new-code-no-spec only for added code files; unregistered-spec points at add", () => {
  const r = computeFindings(input({
    changed: new Set(["src/other/edited.ts", "src/other/new.ts", "src/pay/new.ts", "README.md", "test/pay3.test.ts"]),
    // docs/specs/ref.txt: a spec document under specsDir is never code, even when no ignore glob covers it.
    added: new Set(["src/other/new.ts", "src/pay/new.ts", "README.md", "test/pay3.test.ts", ".hunch/spec-sync.json", "docs/specs/ref.txt"]),
    specsDirFiles: ["docs/specs/pay.md", "docs/specs/ref.md"],
    tests: [{ file: "test/pay.test.ts", names: [{ name: "[PAY-1.1] [PAY-2.1.3] all", line: 1 }], unreadable: 0 }],
  }));
  assert.deepEqual(codes(r).filter((c) => !c.startsWith("duplicate")), ["code-without-spec-change:docs/specs/pay.md", "new-code-no-spec:src/other/new.ts", "unregistered-spec:docs/specs/ref.md"]);
  assert.match(r.findings.find((f) => f.code === "unregistered-spec")!.message, /hunch spec-sync add docs\/specs\/ref\.md/);
});

test("[SS-5.4] code-without-spec-change clears only on a clause text change, not whitespace", () => {
  const changed = new Set(["src/pay/charge.ts"]);
  const has = (r: ReturnType<typeof computeFindings>) => r.findings.some((f) => f.code === "code-without-spec-change");
  assert.ok(has(computeFindings(input({ changed }))));
  const rewrapped = SPEC.replace("A charge is captured once.", "A charge is\ncaptured   once.");
  assert.ok(has(computeFindings(input({ changed, specs: [{ spec: PAY, text: rewrapped, baseText: SPEC, junit: null }] }))));
  const edited = SPEC.replace("captured once", "captured at most once");
  assert.ok(!has(computeFindings(input({ changed, specs: [{ spec: PAY, text: edited, baseText: SPEC, junit: null }] }))));
});

test("[SS-4.8] with a fresh report: a failed referencing case is failing; skipped-only is untested", () => {
  const tests = [{ file: "test/pay.test.ts", names: [{ name: "[PAY-1.1] a", line: 1 }, { name: "[PAY-2.1.3] b", line: 2 }], unreadable: 0 }];
  const junit: JunitCase[] = [
    { name: "[PAY-1.1] a", classname: "pay", status: "failed" },
    { name: "[PAY-2.1.3] b", classname: "pay", status: "skipped" },
  ];
  const r = computeFindings(input({ tests, junit }));
  assert.deepEqual(codes(r).filter((c) => !c.startsWith("duplicate")), ["failing:PAY-1.1", "untested:PAY-2.1.3"]);
  assert.deepEqual(codes(computeFindings(input({ tests, junit: null }))).filter((c) => !c.startsWith("duplicate")), [], "no fresh report: static results stand");
});

// ---- fix-round regressions -----------------------------------------------------

test("[SS-2.3] globs: wildcards inside {…}, nested braces, ./ and backslashes; invalid globs are config errors", () => {
  assert.ok(compileGlob("src/{*.js,*.ts}").test("src/a.js"));
  assert.deepEqual([compileGlob("x/{a?,b}").test("x/ab"), compileGlob("x/{a?,b}").test("x/a")], [true, false]);
  assert.ok(compileGlob("a/{b,{c,d}}").test("a/d"));
  assert.ok(compileGlob("./src/pay/**").test("src/pay/a.ts"));
  assert.ok(compileGlob("src\\pay\\**").test("src/pay/a.ts"));
  assert.ok(!compileGlob("src/**/x.ts").test("srcx.ts"));
  assert.ok(compileGlob("src/**/x.ts").test("src/x.ts"));
  assert.equal(configError({ version: 1, specs: [{ ...PAY, code: ["src/{a,b"] }] }).field, "specs[0].code[0]");
  assert.equal(configError({ version: 1, specs: [], junit: ["r/}x"] }).field, "junit[0]");
  assert.equal(configError({ version: 1, specs: [], testNamePatterns: [{ glob: "**/*.x", regex: "^test\\(" }] }).field, "testNamePatterns[0].regex");
  assert.deepEqual(validateSpecSyncConfig({ version: 1, specs: [{ ...PAY, code: ["./src\\pay\\**"] }] }).specs[0]!.code, ["src/pay/**"]);
});

test("[SS-2.3] glob matching is linear: no catastrophic backtracking", () => {
  const started = Date.now();
  for (let i = 0; i < 50; i++) compileGlob("*a*a*a*a*a*a*a*a*b").test("a".repeat(60));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("[SS-3.2] fences are Markdown-only and close on the same char with at least the opener's length", () => {
  const rst = "Spec\n====\n\nSection A\n~~~~~~~~~\n\n- [PAY-1.1] first rule\n\nSection B\n~~~~~~~~~\n\n- [PAY-1.2] second rule\n";
  const p = parseClauses(rst, "PAY", "docs/pay.rst");
  assert.deepEqual(p.clauses.map((c) => c.id), ["PAY-1.1", "PAY-1.2"]);
  assert.doesNotMatch(p.clauses[0]!.text, /Section B/, "an rst underline heading ends the clause");
  assert.deepEqual(parseClauses("# S\n\n```js inline``` example\n\n- [PAY-1.1] a\n", "PAY", "a.md").clauses.map((c) => c.id), ["PAY-1.1"]);
  assert.deepEqual(parseClauses("````\n```\n- [PAY-9.1] inside\n````\n- [PAY-1.1] after\n", "PAY", "a.md").clauses.map((c) => c.id), ["PAY-1.1"]);
});

test("[SS-3.4][SS-3.5] only a marker that starts its line defines a clause; a cross-reference is neither a duplicate nor a boundary", () => {
  const xref = "# S\n- [PAY-1.1] a rule.\n- [PAY-1.2] like [PAY-1.1] but stricter.\n1. [PAY-1.3] numbered\n## [PAY-1.4] heading form\nSee [PAY-1.2].\n";
  const p = parseClauses(xref, "PAY", "a.md");
  assert.deepEqual(p.duplicates, []);
  assert.deepEqual(p.clauses.map((c) => c.id), ["PAY-1.1", "PAY-1.2", "PAY-1.3", "PAY-1.4"]);
  assert.match(p.clauses[1]!.text, /like \[PAY-1\.1\] but stricter/);
  assert.match(p.clauses[3]!.text, /See \[PAY-1\.2\]/);
});

test("[SS-1.3] a legacy header inside a fenced block is an example, not a header", () => {
  assert.equal(parseLegacyHeader("# Docs\n\n```md\n<!-- spec-sync id=DEMO code=src/** tests=test/** -->\n```\n"), null);
});

test("[SS-1.1][SS-2.5] a disabled config is off before validation; edits refuse an unknown version untouched", () => {
  const dir = tempDir("hunch-specsync-off-");
  const file = join(dir, ".hunch/spec-sync.json");
  try {
    mkdirSync(join(dir, ".hunch"));
    writeFileSync(file, JSON.stringify({ version: 1, enabled: false, specs: [{ id: "pay" }] }));
    assert.equal(loadSpecSyncConfig(dir)!.enabled, false);
    const bad = JSON.stringify({ version: 9, enabled: false, specs: { not: "array" } });
    writeFileSync(file, bad);
    assert.throws(() => editSpecSyncConfig(dir, { enabled: true }), (e: unknown) => e instanceof SpecSyncConfigError && e.field === "version");
    // Already off: `off` needs no validation and changes nothing.
    assert.equal(editSpecSyncConfig(dir, { enabled: false }).written, false);
    assert.equal(readFileSync(file, "utf8"), bad);
  } finally {
    cleanupDir(dir);
  }
});

test("[SS-4.1] Python: a def inside any triple-quoted string (assigned, call argument) is not a test", () => {
  const py = 'EXPECTED = """\nfoo\n"""\n\ndef test_pay_1_1_a():\n    pass\n\nSQL = """\ndef test_pay_9_1_fake():\n"""\ndef test_a():\n    x = foo("""\n    def test_pay_9_2_fake(): pass\n    """)\n\ndef test_pay_1_2_b():\n    """doc"""\n    pass\n';
  assert.deepEqual(names("t/test_x.py", py), ["test_pay_1_1_a", "test_a", "test_pay_1_2_b"]);
});

test("[SS-4.1] JS: division after a number/identifier/paren and JSX closing tags never start a regex", () => {
  assert.deepEqual(names("a.test.ts", "const half = 4 / 2; /* it('PAY-1.9 commented out', () => {}) */\nit('real', () => {});"), ["real"]);
  assert.deepEqual(names("a.test.tsx", "const el = <div>x</div>; {/* it('PAY-1.9 commented out') */}\nit('real', () => {});"), ["real"]);
  assert.deepEqual(names("a.test.ts", "const msg = 1 / 2 + `\nabc`;\nit('PAY-1.1 a', () => {});\nconst z = `end`;\nit('PAY-1.3 c', () => {});"), ["PAY-1.1 a", "PAY-1.3 c"]);
  const scoped = "describe('PAY-1.1 grp', () => {\n  it('a', () => { expect(f(100 / 4)).toBe(25); render(<Foo>bar</Foo>); });\n});\ndescribe('other', () => {\n  it('b', () => {});\n});";
  assert.deepEqual(names("a.test.tsx", scoped), ["PAY-1.1 grp > a", "other > b"], "the describe title does not leak");
});

test("[SS-4.3][SS-4.5] JS: generics recognised, .todo is not a test, an id cut by an interpolation is unreadable", () => {
  assert.deepEqual(names("a.test.ts", "test.each<[number]>([[1]])('PAY-1.2 %s', (n) => {});\nit<Ctx>('PAY-1.1 x', () => {});").flatMap((n) => clauseRefs(n, ["PAY"])), ["PAY-1.2", "PAY-1.1"]);
  const todo = extractTestNames("a.test.ts", "it.todo('PAY-1.2 rejects negative');\ntest.todo('PAY-1.3');");
  assert.deepEqual([todo.names, todo.unreadable], [[], 0]);
  const cut = extractTestNames("a.test.ts", "it(`PAY-1.${m} thing`, () => {});\nit(`PAY-1.4 ${m} ok`, () => {});");
  assert.equal(cut.unreadable, 1);
  assert.deepEqual(cut.names.flatMap((n) => clauseRefs(n.name, ["PAY"])), ["PAY-1.4"]);
});

test("[SS-4.6] JUnit parsing stays linear on unterminated comments and testcases", () => {
  const started = Date.now();
  parseJunit("<testsuite>" + "<!-- ".repeat(40000) + "</testsuite>");
  parseJunit("<testsuite>" + '<testcase name="x">'.repeat(20000));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

// ---- review-round regressions ---------------------------------------------------

test("[SS-2.3] `**/` matches whole directories only, never part of a segment", () => {
  assert.ok(!compileGlob("**/foo.ts").test("afoo.ts"));
  assert.ok(!compileGlob("src/**/index.ts").test("src/reindex.ts"));
  assert.ok(!compileGlob("**/test_*.py").test("src/latest_x.py"));
  assert.ok(!compileGlob("**/x/**/y").test("ax/by"));
  assert.ok(compileGlob("**/foo.ts").test("foo.ts"));
  assert.ok(compileGlob("**/foo.ts").test("a/b/foo.ts"));
  assert.ok(compileGlob("src/**").test("src/a/b"));
  assert.ok(compileGlob("a/**/b").test("a/b"));
  assert.ok(compileGlob("a/**/b").test("a/x/y/b"));
  assert.ok(compileGlob("**/test_*.py").test("src/test_x.py"));
  assert.ok(compileGlob("src/**/index.ts").test("src/a/index.ts"));
});

test("[SS-5.2] a glob-form specsDir keeps its spec documents out of code", () => {
  const cfg = validateSpecSyncConfig({ version: 1, specs: [], specsDir: ["specs/*.md"] });
  assert.equal(isCodeFile("specs/notes.md", cfg), false);
  assert.equal(isCodeFile("specs/notes.ts", cfg), true);
});

test("[SS-3.4] a marker after a code span or before `:` (link reference definition) is not a definition", () => {
  const spanned = parseClauses("- [PAY-1.1] rule\n\n`refund()` [PAY-1.1] is described above.\n", "PAY", "x.md");
  assert.deepEqual(spanned.duplicates, []);
  assert.deepEqual(spanned.clauses.map((c) => c.id), ["PAY-1.1"]);
  const linkRef = parseClauses("[PAY-1.1] rule\n\n[PAY-1.1]: #pay-11\n", "PAY", "x.md");
  assert.deepEqual(linkRef.duplicates, []);
  assert.deepEqual(clausePrefixes("- [PAY-1.1] rule\n\n[ISO-8601]: https://example.com/iso\n", "x.md").map((p) => p.prefix), ["PAY"]);
});

test("[SS-3.4] only a link destination after `[ID]:` makes a link reference definition; prose after it is a clause", () => {
  const prose = parseClauses("[PAY-1.1]: Refunds must be issued within 5 days\n", "PAY", "x.md");
  assert.deepEqual(prose.clauses.map((c) => c.id), ["PAY-1.1"]);
  assert.match(prose.clauses[0]!.text, /Refunds must be issued/);
  const refs = "[PAY-1.1]: #pay-11\n[PAY-1.2]: https://example.com/pay \"Pay\"\n[PAY-1.3]: <docs/pay.md>\n[PAY-1.4]: ./pay.md (Pay)\n[ISO-8601]: https://x\n";
  assert.deepEqual(parseClauses(refs, "PAY", "x.md").clauses, []);
  assert.deepEqual(clausePrefixes(refs, "x.md"), []);
});

test("[SS-3.4] blockquote, task-list and bold markers define clauses; a table cell does not", () => {
  const ids = (text: string) => parseClauses(text, "PAY", "x.md").clauses.map((c) => c.id);
  assert.deepEqual(ids("> [PAY-1.1] quoted\n> > [PAY-1.2] nested\n"), ["PAY-1.1", "PAY-1.2"]);
  assert.deepEqual(ids("- [ ] [PAY-1.1] open\n* [x] [PAY-1.2] done\n1. [X] [PAY-1.3] numbered\n"), ["PAY-1.1", "PAY-1.2", "PAY-1.3"]);
  assert.deepEqual(ids("**[PAY-1.1]** bold\n- __[PAY-1.2]__ underscored\n"), ["PAY-1.1", "PAY-1.2"]);
  assert.equal(parseClauses("**[PAY-1.1]** bold rule\n", "PAY", "x.md").clauses[0]!.text, " bold rule\n");
  assert.deepEqual(ids("| id | rule |\n| --- | --- |\n| [PAY-1.1] | a rule |\n"), []);
});

test("[SS-3.2] an HTML comment hides clauses (multi-line too), keeping line numbers; the legacy header still parses", () => {
  const text = "<!-- spec-sync id=PAY code=src/pay/** tests=test/** -->\n<!-- [PAY-1.1] draft\n[PAY-1.2] draft -->\n- [PAY-1.3] kept <!-- note --> here\n";
  const p = parseClauses(text, "PAY", "x.md");
  assert.deepEqual(p.clauses.map((c) => [c.id, c.line]), [["PAY-1.3", 4]]);
  assert.doesNotMatch(p.clauses[0]!.text, /note/);
  assert.deepEqual(clausePrefixes(text, "x.md"), [{ prefix: "PAY", count: 1 }]);
  assert.deepEqual(parseLegacyHeader(text), { id: "PAY", code: ["src/pay/**"], tests: ["test/**"] });
  const fenced = parseClauses("```\n<!-- x\n```\n- [PAY-1.1] after a fence -->\n", "PAY", "x.md");
  assert.deepEqual(fenced.clauses.map((c) => c.id), ["PAY-1.1"], "a comment opener inside a fence is code");
});

test("[SS-3.5] clause text ends before the next definition line, never taking its bullet", () => {
  const p = parseClauses("1. [PAY-1.1] a\n2) [PAY-1.2] b", "PAY", "x.md");
  assert.deepEqual(p.clauses.map((c) => c.text), [" a\n", " b"]);
  assert.deepEqual(parseClauses("> [PAY-1.1] a\n> [PAY-1.2] b\n", "PAY", "x.md").clauses[0]!.text, " a\n");
});

test("[SS-2.3] globs match astral characters as one code point", () => {
  assert.equal(compileGlob("docs/😀.md").test("docs/😀.md"), true);
  assert.equal(compileGlob("docs/?.md").test("docs/😀.md"), true);
  assert.equal(compileGlob("docs/??.md").test("docs/😀.md"), false);
  assert.equal(compileGlob("docs/*😀*.md").test("docs/a😀b.md"), true);
});

test("[SS-2.5] a glob naming the repository root (\".\", \"./\") is a config error naming the field", () => {
  for (const dir of [".", "./"]) {
    const e = configError({ version: 1, specs: [], specsDir: [dir] });
    assert.equal(e.field, "specsDir[0]");
    assert.match(e.detail, /repository root/);
  }
  assert.equal(configError({ version: 1, specs: [{ ...PAY, code: ["./"] }] }).field, "specs[0].code[0]");
});

test("[SS-2.4] add never proposes a named path that is no valid glob", () => {
  const files = ["src/a{b/x.ts", "src/pay/charge.ts"];
  const p = proposeGlobs("Code in `src/a{b/x.ts` and `src/pay/charge.ts`.\n", "docs/pay.md", files);
  assert.deepEqual(p.code, ["src/pay/charge.ts"]);
  assert.deepEqual(p.invalid, ["src/a{b/x.ts"]);
  validateSpecSyncConfig({ version: 1, specs: [{ id: "PAY", path: "docs/pay.md", code: p.code, tests: p.tests }] });
});

test("[SS-1.4] off switches off a parseable-but-invalid config, keeping its fields; unparseable stays refused", () => {
  const dir = tempDir("hunch-specsync-offinvalid-");
  const file = join(dir, ".hunch/spec-sync.json");
  try {
    mkdirSync(join(dir, ".hunch"));
    writeFileSync(file, JSON.stringify({ version: 9, enabled: true, specs: { not: "array" }, custom: 1 }));
    assert.equal(editSpecSyncConfig(dir, { enabled: false }).written, true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 9, enabled: false, specs: { not: "array" }, custom: 1 });
    writeFileSync(file, "{ broken");
    assert.throws(() => editSpecSyncConfig(dir, { enabled: false }), SpecSyncConfigError);
    assert.equal(readFileSync(file, "utf8"), "{ broken");
    writeFileSync(file, "[1]");
    assert.throws(() => editSpecSyncConfig(dir, { enabled: false }), SpecSyncConfigError);
    assert.equal(readFileSync(file, "utf8"), "[1]");
  } finally {
    cleanupDir(dir);
  }
});

test("[SS-3.2] code spans and HTML comments are found in linear time", () => {
  const timed = (text: string) => {
    const t = performance.now();
    parseClauses(text, "PAY", "x.md");
    return performance.now() - t;
  };
  const n = 12000;
  assert.ok(timed(`- [PAY-1.3] ${"`".repeat(n)}${"a".repeat(n)}\n`) < 1000, "a long run of unmatched backticks");
  assert.ok(timed(`<!-- c -->\n${"`".repeat(n)}${"a".repeat(n)}\n`) < 1000, "unmatched backticks with a comment elsewhere");
  assert.ok(timed("<!-- ".repeat(20000)) < 1000, "many unclosed comment openers");
  assert.ok(timed("<!-- x -->".repeat(20000)) < 1000, "many closed comments on one line");
  // A code span closes on a run of exactly its length.
  assert.deepEqual(parseClauses("`` ` [PAY-1.1] `` x\n- [PAY-1.2] ``a`b``\n", "PAY", "x.md").clauses.map((c) => c.id), ["PAY-1.2"]);
});

test("[SS-3.2] a comment holding an unbalanced fence does not flip fence parity; unclosed comments hide nothing", () => {
  const p = parseClauses("<!--\n```\n-->\n- [PAY-1.1] A\n```\ncode [PAY-9.9]\n```\n- [PAY-1.2] B\n", "PAY", "x.md");
  assert.deepEqual(p.clauses.map((c) => [c.id, c.line]), [["PAY-1.1", 4], ["PAY-1.2", 8]]);
  assert.deepEqual(parseClauses("```\n<!--\n```\n- [PAY-1.1] A\n<!-- [PAY-9.9] -->\n- [PAY-1.2] B\n", "PAY", "x.md").clauses.map((c) => c.id), ["PAY-1.1", "PAY-1.2"]);
  assert.deepEqual(parseClauses("- [PAY-1.1] a\n<!-- oops\n- [PAY-1.2] b\n", "PAY", "x.md").clauses.map((c) => [c.id, c.line]), [["PAY-1.1", 1], ["PAY-1.2", 3]]);
  assert.deepEqual(parseClauses("- [PAY-1.1] use `<!--` here\n- [PAY-1.2] b <!-- x --> `-->`\n- [PAY-1.3] c\n", "PAY", "x.md").clauses.map((c) => c.id), ["PAY-1.1", "PAY-1.2", "PAY-1.3"]);
});

test("[SS-3.4] in Markdown a marker followed by ( or [ is a link, not a definition", () => {
  const toc = "# Pay\n\n- [PAY-1.1](#pay-11) Charge\n- [PAY-1.2][] Refund\n\n## [PAY-1.1] Charge\ncaptured once\n\n## [PAY-1.2] Refund\ncapped\n";
  const p = parseClauses(toc, "PAY", "x.md");
  assert.deepEqual(p.duplicates, []);
  assert.deepEqual(p.clauses.map((c) => [c.id, c.line]), [["PAY-1.1", 6], ["PAY-1.2", 9]]);
});

test("[SS-3.4] a link reference definition needs a destination-like token, and only in Markdown", () => {
  const ids = (text: string, path: string) => parseClauses(text, "PAY", path).clauses.map((c) => c.id);
  assert.deepEqual(ids("[PAY-1.3]: Idempotent.\n", "x.md"), ["PAY-1.3"]);
  assert.deepEqual(ids("[PAY-1.4]: Required.\n", "x.txt"), ["PAY-1.4"]);
  assert.deepEqual(ids("[PAY-1.4]: #pay-14\n", "x.txt"), ["PAY-1.4"], "no link references outside Markdown");
  assert.deepEqual(ids("[PAY-1.1]: #pay-11\n[PAY-1.2]: pay.md\n[PAY-1.6]: docs/pay.md\n", "x.md"), []);
  // An extensionless slash token reads like prose (`N/A`, `HTTP/2`): a clause, never silently dropped.
  assert.deepEqual(ids("[PAY-1.5]: docs/pay\n", "x.md"), ["PAY-1.5"]);
  assert.deepEqual(clausePrefixes("[ISO-8601]: https://x\n", "x.md"), []);
});

test("[SS-3.5] a setext underline after a wrapped clause keeps the clause's last line", () => {
  const before = "- [PAY-1.2] A refund never\n  exceeds the charge.\n---\n";
  assert.match(parseClauses(before, "PAY", "x.md").clauses[0]!.text, /exceeds the charge/);
  assert.equal(clauseTextChanged(before, before.replace("exceeds", "equals"), "PAY", "x.md"), true);
  assert.doesNotMatch(parseClauses("- [PAY-1.1] a\n\nNext\n===\n", "PAY", "x.md").clauses[0]!.text, /Next/, "a one-line heading still ends the clause");
});

test("[SS-4.7] the deletion log parser fails closed on output before a commit header", () => {
  assert.deepEqual(parseDeletionLog("\x01123\0\na.ts\0b.ts\0\x01100\0\nc.ts\0"), [
    { path: "a.ts", ms: 123_999 }, { path: "b.ts", ms: 123_999 }, { path: "c.ts", ms: 100_999 },
  ]);
  assert.deepEqual(parseDeletionLog(""), []);
  assert.throws(() => parseDeletionLog("junk\n\x01123\0\npath\0"), /before a commit header/);
  assert.throws(() => parseDeletionLog("gpg: Signature made\0\x01123\0\npath\0"), /before a commit header/);
  assert.throws(() => parseDeletionLog("\x01abc\0\npath\0"), /unreadable commit time/);
});

const ids = (text: string, path = "pay.md") => parseClauses(text, "PAY", path).clauses.map((c) => c.id);

test("[SS-3.2] `<!-->` and `<!--->` are complete comments, not unclosed openers", () => {
  assert.deepEqual(ids("<!-->\n[PAY-1.1] visible clause\n\n<!-- note -->\n[PAY-1.2] shown"), ["PAY-1.1", "PAY-1.2"]);
  assert.deepEqual(ids("<!--->\n[PAY-1.1] visible clause\n"), ["PAY-1.1"]);
});

test("[SS-3.5] rst: an overline heading ends the previous clause at the overline", () => {
  const spec = (title: string) => `[PAY-1.1] charge once\n\n=====\n${title}\n=====\n[PAY-1.2] other`;
  const a = parseClauses(spec("Next"), "PAY", "pay.rst").clauses[0]!;
  assert.doesNotMatch(a.text, /=/);
  assert.equal(clauseTextChanged(spec("Next"), spec("Renamed"), "PAY", "pay.rst"), false);
});

test("[SS-3.5] markdown: a thematic break is no clause text", () => {
  for (const hr of ["***", "___", "* * *"]) {
    const c = parseClauses(`[PAY-1.1] x\n\n${hr}\nSection Two\n-----------\n`, "PAY", "pay.md").clauses[0]!;
    assert.equal(c.text.replace(/\s+/g, ""), "x", hr);
  }
});

test("[SS-3.2] link reference definitions need a destination-like token; prose after the id is a clause", () => {
  for (const rest of ["N/A", "HTTP/2", "v2.0", "Node.js", "note:", "<removed>"]) {
    assert.deepEqual(ids(`[PAY-1.1]: ${rest}`), ["PAY-1.1"], rest);
  }
  for (const rest of ["#pay-11", "https://x.y/z", "./spec.md", "docs/a.md#x", "<https://x>"]) {
    assert.deepEqual(ids(`[PAY-1.1]: ${rest}`), [], rest);
  }
});

test("[SS-3.5] parseClauses stays linear in headings x clauses", () => {
  const n = 20_000;
  const text = Array.from({ length: n }, (_, i) => `# H${i}\n[PAY-${i + 1}] clause ${i}\n`).join("\n");
  const t0 = Date.now();
  assert.equal(parseClauses(text, "PAY", "pay.md").clauses.length, n);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
