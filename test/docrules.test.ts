import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocRules, planDocRules, docRuleId, recordedDocRuleKey, docRuleToConstraint, docRulePlanIsDirty, withoutMarkedRules } from "../src/extractors/docRules.js";
import { constraintId } from "../src/core/ids.js";
import { validateProposals, proposalHash, enqueueProposals, acceptProposal, readProposalQueue, writeProposalQueue, type DocRuleProposal } from "../src/core/docRuleProposals.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";

const PROJECT_ROOT = process.cwd();
const TSX = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(PROJECT_ROOT, "src/cli/index.ts");
const NOW = "2026-10-30T00:00:00.000Z";

test("parseDocRules lifts the paragraph after a marker; skips code examples; reports malformed markers", () => {
  const doc = [
    "# Contributing",
    "",
    "<!-- hunch:rule scope=src/ui/**,src/web/** severity=blocking id=ui-no-billing type=architecture -->",
    "UI code must never import",
    "the billing client directly.",
    "",
    "<!-- hunch:rule scope=src/** --> - Validate every request body.",
    "",
    "```md",
    "<!-- hunch:rule scope=x/** -->",
    "an example inside a fence",
    "```",
    "Inline `<!-- hunch:rule scope=y/** -->` is an example too.",
    "",
    "<!-- hunch:rule severity=warning -->",
    "missing scope",
    "",
    "<!-- hunch:rule scope=a/** severity=fatal -->",
    "bad severity",
    "",
    "<!-- hunch:rule scope=a/** -->",
    "",
    "## Next heading",
  ].join("\r\n");
  const { rules, issues } = parseDocRules(doc, "CONTRIBUTING.md");
  assert.deepEqual(rules.map((r) => [r.line, r.key, r.statement, r.scope, r.severity, r.type]), [
    [3, "ui-no-billing", "UI code must never import the billing client directly.", ["src/ui/**", "src/web/**"], "blocking", "architecture"],
    [7, null, "Validate every request body.", ["src/**"], "warning", "correctness"],
  ]);
  assert.deepEqual(issues.map((i) => [i.line, i.detail.split(" ")[0]]), [[15, "missing"], [18, "severity"], [21, "no"]]);
});

test("docRuleId: explicit id survives moves and rewording; implicit id is path + statement", () => {
  const base = { file: "a.md", line: 1, statement: "S", scope: ["**"], severity: "warning" as const, type: "correctness" as const };
  assert.equal(docRuleId({ ...base, key: "k" }), docRuleId({ ...base, key: "k", file: "docs/b.md", statement: "S2" }));
  assert.notEqual(docRuleId({ ...base, key: null }), docRuleId({ ...base, key: null, file: "b.md" }));
});

test("planDocRules: create / unchanged / moved / changed / orphaned / conflict / retired-stays-retired", () => {
  const mk = (statement: string, key: string, file = "A.md", line = 1) =>
    ({ file, line, key, statement, scope: ["src/**"], severity: "warning" as const, type: "correctness" as const });
  const kept = mk("kept", "kept");
  const moved = mk("moved", "moved");
  const edited = mk("edited", "edited");
  const gone = mk("gone", "gone");
  const elsewhere = mk("elsewhere", "elsewhere", "B.md");
  const retired = mk("retired", "retired");
  const existing: Constraint[] = [
    docRuleToConstraint(kept, undefined, NOW),
    docRuleToConstraint({ ...moved, file: "old.md", line: 9 }, undefined, NOW),
    docRuleToConstraint({ ...edited, statement: "edited (old wording)" }, undefined, NOW),
    docRuleToConstraint(gone, undefined, NOW),
    docRuleToConstraint(elsewhere, undefined, NOW),
    { ...docRuleToConstraint(retired, undefined, NOW), status: "retired", valid_to: NOW },
    // a hand-recorded constraint that happens to own the id a marker would claim
    { ...docRuleToConstraint(mk("clash", "clash"), undefined, NOW), provenance: { source: "human_confirmed", confidence: 1, evidence: [] } },
  ];
  // a reviewer raised the kept rule's severity in the graph; an unchanged doc must not undo it
  existing[0] = { ...existing[0]!, severity: "blocking" };
  const fresh = mk("fresh", "fresh");
  const plan = planDocRules(
    { rules: [kept, moved, edited, fresh, retired, mk("clash", "clash"), mk("dup", "fresh", "A.md", 40)], issues: [] },
    existing,
    (src) => src === "A.md",
    new Set(),
    NOW,
  );
  assert.deepEqual(plan.create.map((x) => x.rule.key), ["fresh"]);
  assert.deepEqual(plan.unchanged.map((r) => r.key), ["kept", "retired"]);
  assert.deepEqual(plan.moved.map((x) => [x.rule.key, x.from]), [["moved", "old.md"]]);
  assert.equal(plan.moved[0]!.next.provenance.evidence[0], "A.md:1");
  assert.deepEqual(plan.changed.map((x) => x.rule.key), ["edited"]);
  // B.md was not scanned, so its rule is not orphaned
  assert.deepEqual(plan.orphaned.map((c) => c.id), [docRuleId(gone)]);
  assert.deepEqual(plan.conflicts.map((x) => x.rule.key), ["clash"]);
  assert.match(plan.conflicts[0]!.reason, /non-doc constraint/);
  assert.match(plan.issues[0]!.detail, /duplicate rule/);
  assert.equal(docRulePlanIsDirty(plan), true);

  const clean = planDocRules({ rules: [kept, { ...moved, file: "A.md", line: 30 }], issues: [] }, existing.slice(0, 2), (src) => src === "A.md", new Set(), NOW);
  assert.equal(docRulePlanIsDirty(clean), false, "a move alone never fails a check");
});

test("hunch derive-rules: writes constraints, is idempotent, gates edits, reports orphans, --check exits 1", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-docrules-"));
  const cli = (...args: string[]) => spawnSync(process.execPath, [TSX, CLI, "derive-rules", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  const write = (body: string) => { writeFileSync(join(root, "CONTRIBUTING.md"), body); git("add", "CONTRIBUTING.md"); };
  const ruleA = "<!-- hunch:rule scope=src/ui/** severity=blocking id=ui-no-billing -->\nUI must not import billing.\n";
  const ruleB = "<!-- hunch:rule scope=src/** -->\nValidate input.\n";
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "docrules@test.invalid");
    git("config", "user.name", "DocRules Test");
    writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch/local.json\n");
    git("add", ".gitignore");
    const bootstrap = new HunchStore(hunchPaths(root));
    bootstrap.json.ensureDirs();
    bootstrap.close();
    write(`# Rules\n\n${ruleA}\n${ruleB}`);
    const idA = constraintId("doc-rule:ui-no-billing");
    const conPath = join(hunchPaths(root).hunch, "constraints", `${idA}.json`);

    let r = cli("--check");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!existsSync(conPath), "--check never writes");
    r = cli("--dry-run");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dry run: 2 write\(s\) planned/);
    assert.ok(!existsSync(conPath), "--dry-run never writes");

    r = cli();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 new/);
    const a = JSON.parse(readFileSync(conPath, "utf8")) as Constraint;
    assert.equal(a.severity, "blocking");
    assert.deepEqual(a.scope, ["src/ui/**"]);
    assert.equal(a.statement, "UI must not import billing.");

    r = cli("--check");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = cli();
    assert.match(r.stdout, /0 new, 0 updated, 0 moved, 2 unchanged/);

    // Edit the paragraph: surfaced, not applied, until --accept-changes.
    write(`# Rules\n\n${ruleA.replace("billing.", "the billing client.")}\n${ruleB}`);
    r = cli();
    assert.match(r.stdout, /changed since import — run with --accept-changes/);
    assert.equal((JSON.parse(readFileSync(conPath, "utf8")) as Constraint).statement, "UI must not import billing.");
    assert.equal(cli("--check").status, 1);
    r = cli("--accept-changes");
    assert.match(r.stdout, /1 updated/);
    assert.equal((JSON.parse(readFileSync(conPath, "utf8")) as Constraint).statement, "UI must not import the billing client.");

    // Remove a marker: reported as orphaned, constraint left active.
    write(`# Rules\n\n${ruleB}`);
    r = cli();
    assert.match(r.stdout, new RegExp(`\\? ${idA} marker gone`));
    assert.equal((JSON.parse(readFileSync(conPath, "utf8")) as Constraint).status, "active");
    assert.equal(cli("--check").status, 1);
  } finally {
    cleanupDir(root);
  }
});

test("hunch derive-rules on a subtree with no tracked markdown fails clearly", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-docrules-empty-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "docs"));
    const bootstrap = new HunchStore(hunchPaths(root));
    bootstrap.json.ensureDirs();
    bootstrap.close();
    const r = spawnSync(process.execPath, [TSX, CLI, "derive-rules", "docs"], { cwd: root, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /no tracked markdown under docs/);
    const priv = spawnSync(process.execPath, [TSX, CLI, "derive-rules", "--private"], { cwd: root, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "" } });
    assert.notEqual(priv.status, 0);
    assert.match(priv.stdout + priv.stderr, /--private needs HUNCH_PRIVATE_DIR/);
  } finally {
    cleanupDir(root);
  }
});

const DOC = "# Policy\n\nUI code must not import the billing client.\nAlso, keep handlers small.\n";

test("validateProposals keeps only drafts whose quote is verbatim in the doc; caps severity; rejects unsafe scope", () => {
  const raw = { rules: [
    { statement: "UI must not import billing", quote: "UI code must not   import the billing client.", scope: ["src/ui/**"], severity: "blocking", type: "architecture" },
    { statement: "Invented rule", quote: "Never use tabs anywhere in code.", scope: ["src/**"], severity: "warning" },
    { statement: "Escapes repo", quote: "Also, keep handlers small.", scope: ["../other/**"] },
    "junk",
  ] };
  const { proposals, rejected } = validateProposals(raw, { file: "docs/policy.md", text: DOC }, { provider: "test", now: NOW });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.severity, "warning", "blocking is capped; a human raises it");
  assert.equal(proposals[0]!.type, "architecture");
  assert.equal(proposals[0]!.hash, proposalHash(proposals[0]!));
  assert.equal(rejected.length, 3);
  assert.match(rejected.join("\n"), /quote not found verbatim/);
  assert.deepEqual(validateProposals(null, { file: "a.md", text: DOC }, { provider: "t", now: NOW }).proposals, []);
});

test("enqueueProposals skips pending, dropped, and existing-statement duplicates; acceptProposal re-checks hash and doc", () => {
  const { proposals } = validateProposals({ rules: [
    { statement: "UI must not import billing", quote: "UI code must not import the billing client.", scope: ["src/ui/**"] },
    { statement: "Keep handlers small", quote: "Also, keep handlers small.", scope: ["src/api/**"] },
  ] }, { file: "docs/policy.md", text: DOC }, { provider: "test", now: NOW });
  const existing = [{ ...docRuleToConstraint({ file: "x.md", line: 1, key: "k", statement: "keep handlers small", scope: ["**"], severity: "warning", type: "correctness" }, undefined, NOW) }];
  const first = enqueueProposals({ pending: [], dropped: [] }, proposals, existing);
  assert.deepEqual(first.added.map((p) => p.statement), ["UI must not import billing"]);
  assert.equal(enqueueProposals(first.queue, proposals, existing).added.length, 0, "idempotent");
  assert.equal(enqueueProposals({ pending: [], dropped: [proposals[0]!.id] }, proposals.slice(0, 1), []).added.length, 0, "dropped stays dropped");

  const p = proposals[0]!;
  assert.throws(() => acceptProposal(p, "sha256:" + "0".repeat(64), DOC, NOW), /does not match --expect/);
  assert.throws(() => acceptProposal(p, p.hash, "# Policy\n\nrewritten\n", NOW), /no longer says/);
  assert.throws(() => acceptProposal({ ...p, statement: "tampered" }, p.hash, DOC, NOW), /does not match/);
  const c = acceptProposal(p, p.hash, DOC, NOW);
  assert.equal(c.status, "active");
  assert.equal(c.severity, "warning");
  assert.match(c.provenance.source, /imported:doc-proposal/);
});

test("hunch derive-rules --propose/--proposals/--accept/--drop: review queue round-trip", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-docrules-prop-"));
  const env = { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (...args: string[]) => spawnSync(process.execPath, [TSX, CLI, ...args], { cwd: root, encoding: "utf8", env });
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "docrules@test.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "DocRules Test"], { cwd: root });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/policy.md"), DOC);
    execFileSync("git", ["add", "docs/policy.md"], { cwd: root });
    const bootstrap = new HunchStore(hunchPaths(root));
    bootstrap.json.ensureDirs();
    bootstrap.close();

    let r = run("derive-rules", "--propose");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /--propose needs an explicit <path>/);
    r = run("derive-rules", "docs", "--propose");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /needs a coding-assistant subscription CLI \(selected: deterministic\)/);

    // Seed the queue the way --propose would, then review it.
    const { proposals } = validateProposals({ rules: [
      { statement: "UI must not import billing", quote: "UI code must not import the billing client.", scope: ["src/ui/**"] },
      { statement: "Keep handlers small", quote: "Also, keep handlers small.", scope: ["src/api/**"] },
    ] }, { file: "docs/policy.md", text: DOC }, { provider: "test", now: NOW });
    const hunchDir = hunchPaths(root).hunch;
    writeProposalQueue(hunchDir, { pending: proposals, dropped: [] });
    const [a, b] = proposals as [DocRuleProposal, DocRuleProposal];

    r = run("derive-rules", "--proposals");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`--accept ${a.id} --expect ${a.hash}`));

    r = run("derive-rules", "--accept", a.id);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /requires --expect/);
    r = run("derive-rules", "--accept", a.id, "--expect", a.hash);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const con = JSON.parse(readFileSync(join(hunchDir, "constraints", `${a.id}.json`), "utf8")) as Constraint;
    assert.equal(con.statement, "UI must not import billing");

    r = run("derive-rules", "--drop", b.id);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(join(hunchDir, "constraints", `${b.id}.json`)));
    const q = readProposalQueue(hunchDir);
    assert.deepEqual(q.pending, []);
    assert.deepEqual(q.dropped, [b.id]);
  } finally {
    cleanupDir(root);
  }
});

test("withoutMarkedRules blanks each marker + its paragraph, keeps unmarked prose and line count", () => {
  const doc = "# T\n\n<!-- hunch:rule scope=a/** -->\n\nMarked one.\nstill marked.\n\nUnmarked prose.\n<!-- hunch:rule scope=b/** --> Inline marked.\n\nAfter inline.\n";
  const out = withoutMarkedRules(doc, "T.md");
  assert.equal(out.split("\n").length, doc.split("\n").length);
  assert.doesNotMatch(out, /Marked one|still marked|Inline marked|hunch:rule/);
  assert.match(out, /Unmarked prose\./);
  assert.match(out, /After inline\./, "an inline-statement marker does not swallow the next paragraph");
});

const rule = (over: Partial<Parameters<typeof docRuleToConstraint>[0]> = {}) =>
  ({ file: "A.md", line: 1, key: null, statement: "Validate input.", scope: ["src/**"], severity: "warning" as const, type: "correctness" as const, ...over });
const sameDoc = (src: string) => src === "A.md";

test("planDocRules: an edited key-less paragraph is held, not auto-created; keyed rules are never held", () => {
  const old = docRuleToConstraint(rule(), undefined, NOW);
  assert.equal(recordedDocRuleKey(old), null);
  const edited = rule({ statement: "Validate all input." });
  const plan = planDocRules({ rules: [edited, rule({ statement: "Brand new keyed", key: "fresh" })], issues: [] }, [old], sameDoc, new Set(), NOW);
  assert.deepEqual(plan.held.map((x) => x.rule.statement), ["Validate all input."]);
  assert.deepEqual(plan.create.map((x) => x.rule.key), ["fresh"]);
  assert.deepEqual(plan.orphaned.map((c) => c.id), [old.id]);
  assert.equal(docRulePlanIsDirty({ ...plan, create: [], orphaned: [], issues: [] }), true, "held alone is dirty");
  assert.ok(docRuleToConstraint(rule({ key: "k" }), undefined, NOW).provenance.evidence.includes("doc-rule-key:k"));
  // a keyed orphan is a genuine removal, so a new rule elsewhere in that doc is simply new
  const keyed = docRuleToConstraint(rule({ key: "gone" }), undefined, NOW);
  const p2 = planDocRules({ rules: [rule({ statement: "Other rule" })], issues: [] }, [keyed], sameDoc, new Set(), NOW);
  assert.equal(p2.create.length, 1);
  assert.equal(p2.held.length, 0);
});

test("planDocRules: an accepted edit keeps graph-side enforcement, match, forbids, source_decision, violations, valid_from", () => {
  const old = docRuleToConstraint(rule({ key: "k" }), undefined, NOW);
  const prev: Constraint = { ...old, enforcement: "ci", match: "TODO", forbids: { deps: ["billing"], symbols: [], patterns: [] }, source_decision: "dec_x", violations: ["v1"], valid_from: "2020-01-01T00:00:00.000Z" };
  const plan = planDocRules({ rules: [rule({ key: "k", statement: "Validate everything.", severity: "blocking" })], issues: [] }, [prev], sameDoc, new Set(), NOW);
  const next = plan.changed[0]!.next;
  assert.equal(next.statement, "Validate everything.");
  assert.equal(next.severity, "blocking");
  assert.equal(next.enforcement, "ci");
  assert.equal(next.match, "TODO");
  assert.deepEqual(next.forbids, prev.forbids);
  assert.equal(next.source_decision, "dec_x");
  assert.deepEqual(next.violations, ["v1"]);
  assert.equal(next.valid_from, prev.valid_from);
});

test("planDocRules: a deleted doc still orphans its rules within the covered path; other paths stay untouched", () => {
  const c = docRuleToConstraint(rule({ file: "docs/gone.md", key: "k" }), undefined, NOW);
  assert.deepEqual(planDocRules({ rules: [], issues: [] }, [c], () => true, new Set(), NOW).orphaned.map((x) => x.id), [c.id]);
  assert.deepEqual(planDocRules({ rules: [], issues: [] }, [c], (s) => s === "other.md", new Set(), NOW).orphaned, []);
});

test("planDocRules: an id held by the other home is a conflict; a retired non-doc constraint still owns its id", () => {
  const r = rule({ key: "k" });
  const plan = planDocRules({ rules: [r], issues: [] }, [], sameDoc, new Set([docRuleId(r)]), NOW);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.conflicts[0]!.existing, null);
  assert.match(plan.conflicts[0]!.reason, /other memory home/);
  const retiredNonDoc: Constraint = { ...docRuleToConstraint(r, undefined, NOW), status: "retired", valid_to: NOW, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } };
  const p2 = planDocRules({ rules: [r], issues: [] }, [retiredNonDoc], sameDoc, new Set(), NOW);
  assert.equal(p2.conflicts.length, 1);
  assert.equal(p2.unchanged.length, 0);
});

test("parseDocRules: blockquote prefixes, same-line neighbours, raw HTML, and unclosed fences", () => {
  const doc = [
    "> <!-- hunch:rule scope=a/** id=q -->",
    "> Quoted rule line one",
    "> continues here.",
    "",
    "<!-- hunch:rule scope=b/** id=one --> First on line <!-- hunch:rule scope=c/** id=two --> Second.",
    "",
    "<!-- hunch:rule scope=d/** id=pre -->",
    "<pre>not prose</pre>",
  ].join("\n");
  const { rules, issues } = parseDocRules(doc, "A.md");
  assert.deepEqual(rules.map((r) => [r.key, r.statement]), [["q", "Quoted rule line one continues here."], ["one", "First on line"], ["two", "Second."]]);
  assert.deepEqual(issues.map((i) => [i.line, i.detail]), [[7, "statement looks like raw HTML"]]);
  const blanked = withoutMarkedRules("> <!-- hunch:rule scope=a/** -->\n> Quoted rule.\n> more.\n\nKeep me.\n", "A.md");
  assert.doesNotMatch(blanked, /Quoted rule|more\./);
  assert.match(blanked, /Keep me\./);

  const unclosed = parseDocRules("# T\n\n```md\n<!-- hunch:rule scope=a/** -->\nhidden rule\n<!-- hunch:rule scope=b/** -->\nalso hidden\n", "A.md");
  assert.deepEqual(unclosed.rules, []);
  assert.deepEqual(unclosed.issues.map((i) => [i.line, i.detail]), [[3, "unclosed code fence hides 2 hunch:rule marker(s) below it"]]);
});

test("validateProposals rejects short quotes; the proposal hash covers provider and proposedAt", () => {
  const raw = { rules: [
    { statement: "Be careful", quote: "keep handlers small.", scope: ["src/**"] },
    { statement: "UI must not import billing", quote: "UI code must not import the billing client.", scope: ["src/ui/**"] },
  ] };
  const a = validateProposals(raw, { file: "docs/policy.md", text: DOC }, { provider: "one", now: NOW });
  assert.equal(a.proposals.length, 1);
  assert.match(a.rejected.join("\n"), /quote too short to ground/);
  const b = validateProposals(raw, { file: "docs/policy.md", text: DOC }, { provider: "two", now: NOW });
  const c = validateProposals(raw, { file: "docs/policy.md", text: DOC }, { provider: "one", now: "2027-01-01T00:00:00.000Z" });
  assert.notEqual(a.proposals[0]!.hash, b.proposals[0]!.hash);
  assert.notEqual(a.proposals[0]!.hash, c.proposals[0]!.hash);
});

function mkRepo(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const run = (...args: string[]) => spawnSync(process.execPath, [TSX, CLI, "derive-rules", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, HUNCH_PRIVATE_DIR: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "docrules@test.invalid");
  git("config", "user.name", "DocRules Test");
  writeFileSync(join(root, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch/local.json\n");
  git("add", ".gitignore");
  const bootstrap = new HunchStore(hunchPaths(root));
  bootstrap.json.ensureDirs();
  bootstrap.close();
  const doc = (name: string, body: string) => { writeFileSync(join(root, name), body); git("add", name); };
  const conFiles = () => readdirSync(join(hunchPaths(root).hunch, "constraints")).length;
  return { root, run, git, doc, conFiles };
}

test("hunch derive-rules: implicit-id edit is held until --accept-changes; git rm'd doc orphans; `.` scans the whole repo", () => {
  const { root, run, git, doc, conFiles } = mkRepo("hunch-docrules-held-");
  try {
    doc("GUIDE.md", "# G\n\n<!-- hunch:rule scope=src/** -->\nValidate input.\n");
    let r = run(".");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 new/);
    assert.equal(conFiles(), 1);
    for (const alias of ["./", root]) assert.equal(run(alias, "--check").status, 0, alias);

    doc("GUIDE.md", "# G\n\n<!-- hunch:rule scope=src/** -->\nValidate all input.\n");
    r = run();
    assert.match(r.stdout, /new rule while .* vanished from the same doc/);
    assert.equal(conFiles(), 1, "held rule is not written");
    assert.equal(run("--check").status, 1);
    r = run("--accept-changes");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(conFiles(), 2);

    git("rm", "-q", "-f", "GUIDE.md");
    r = run("--check");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /marker gone/);
  } finally {
    cleanupDir(root);
  }
});

test("hunch derive-rules rejects contradictory flag combinations", () => {
  const { root, run, doc } = mkRepo("hunch-docrules-flags-");
  try {
    doc("A.md", "# A\n");
    const bad = (re: RegExp, ...args: string[]) => {
      const r = run(...args);
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stdout + r.stderr, re, args.join(" "));
    };
    bad(/--dry-run cannot be combined with --propose: drafting still bills your subscription/, "A.md", "--propose", "--dry-run");
    bad(/--expect only applies to --accept/, "--expect", "sha256:x");
    bad(/--accept-changes cannot be combined/, "--check", "--accept-changes");
    bad(/work on the queue, not a <path>/, "A.md", "--proposals");
  } finally {
    cleanupDir(root);
  }
});
