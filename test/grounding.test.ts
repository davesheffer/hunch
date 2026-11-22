import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, mkConstraint } from "./helpers.js";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHunchSection, upsertSection, preserveNewerTemplate, groundingTemplate, GROUNDING_TEMPLATE, HUNCH_START, HUNCH_END } from "../src/integrations/claudemd.js";
import { writeCursorRule, refreshExistingGrounding, regenerateGrounding, refreshCommittableGrounding } from "../src/integrations/providers.js";
import { execFileSync } from "node:child_process";
import { parseGroundingCounts, classifyGroundingBlock, describeGroundingFreshness } from "../src/core/groundingLag.js";

// These tests pin the full block (per-moment tool list, policy tools); the lean default
// is covered by test/lean-grounding.test.ts.
process.env.HUNCH_LEAN_GROUNDING = "0";

// The grounding documents each MCP tool's call signature. If a documented param name
// drifts from the tool's actual inputSchema key, an agent copies the wrong key and the
// call fails Zod validation ("expected string, received undefined"). Lock the signatures
// to the real param names in src/mcp/server.ts.
test("grounding tool signatures match the real MCP param names (no agent-misleading drift)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const md = renderHunchSection(store);

  assert.match(md, /hunch_context\(target, task_id\)/, "context retains its target and carries explicit task correlation");
  assert.match(md, /hunch_query\(query\)/, "hunch_query param is `query`, not `question`");
  assert.match(md, /hunch_bug_lineage\(symptom_or_symbol\)/, "hunch_bug_lineage param is `symptom_or_symbol`");
  assert.match(md, /hunch_runbook\(task\)/, "hunch_runbook is advertised so agents can discover it");
  assert.match(md, /hunch_compare\(candidates\)/, "hunch_compare is advertised");
  assert.match(md, /hunch_conformance\(\)/, "hunch_conformance is advertised");
  assert.match(md, /hunch_policy_plan\(policy_id\)/, "the canonical ProofPlan is discoverable before proof review");
  assert.match(md, /hunch_policy_card\(policy_id\)/, "the deterministic proof-card review surface is discoverable across clients");
  assert.match(md, /only a human activates a policy/, "grounding separates proof evidence from authority");
  assert.match(md, /hunch_why\(target\)/);
  assert.match(md, /hunch_check_constraints\(scope\)/);
  assert.match(md, /hunch_get_dependents\(symbol\)/);

  // the old, wrong signatures must not reappear
  assert.doesNotMatch(md, /hunch_context\(target_or_task\)/);
  assert.doesNotMatch(md, /hunch_query\(question\)/);
  assert.doesNotMatch(md, /hunch_bug_lineage\(symptom\)/);
});
test("a retired constraint is excluded from the top-invariants list", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("constraints", mkConstraint({
    id: "con_retired_one", severity: "blocking", status: "retired",
    valid_from: "2024-01-01T00:00:00Z", valid_to: "2025-01-01T00:00:00Z",
    statement: "RETIREDMARKER-alpha must hold",
  }));
  store.json.put("constraints", mkConstraint({
    id: "con_active_one", severity: "blocking", statement: "ACTIVEMARKER-alpha must hold",
  }));
  const md = renderHunchSection(store, root);
  assert.doesNotMatch(md, /RETIREDMARKER-alpha/);
  assert.match(md, /ACTIVEMARKER-alpha/);
});

test("a closed valid_to alone excludes the constraint", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("constraints", mkConstraint({
    id: "con_closed_window", severity: "blocking", status: "active",
    valid_to: "2025-01-01T00:00:00Z", statement: "CLOSEDMARKER-beta must hold",
  }));
  assert.doesNotMatch(renderHunchSection(store, root), /CLOSEDMARKER-beta/);
});

test("retired constraints do not starve active ones out of the 8-entry cap", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  for (let i = 0; i < 8; i++) {
    store.json.put("constraints", mkConstraint({
      id: `con_retired_cap_${i}`, severity: "blocking", status: "retired",
      valid_from: "2024-01-01T00:00:00Z", valid_to: "2025-01-01T00:00:00Z",
      statement: `RETIREDCAP-${i} must hold`,
    }));
  }
  store.json.put("constraints", mkConstraint({
    id: "con_active_cap", severity: "advisory", statement: "ACTIVECAPMARKER must hold",
  }));
  assert.match(renderHunchSection(store, root), /ACTIVECAPMARKER/);
});

// The policy-tools grounding line must track whether the MCP server actually registers
// the policy group (src/mcp/toolset.ts) — a root with no policy evidence and no config
// opt-in must not advertise a tool that isn't listed.
test("renderHunchSection names the policy tools only when the repo holds a committed policy", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);

  const withoutPolicies = renderHunchSection(store, root);
  assert.doesNotMatch(withoutPolicies, /hunch_policy_evaluate/);

  // .hunch/config.json is gitignored: a local opt-in must not change the committed block.
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory", mcp_tools: "core,policy" }));
  assert.equal(renderHunchSection(store, root), withoutPolicies);
  assert.match(renderHunchSection(store), /hunch_policy_evaluate/, "a bare render keeps the full list");
});

// fnd_f6875f475b: the post-commit capture runs the PINNED hunch, which can be older
// than the renderer that wrote the committed block. It must move the counts and
// leave the newer prose alone.
function newerBlock(section: string): string {
  return section
    .replace(`<!-- hunch:template ${GROUNDING_TEMPLATE} -->`, `<!-- hunch:template ${GROUNDING_TEMPLATE + 1} -->`)
    .replace("## 🧠 Hunch (Engineering Memory)", "## 🧠 Hunch (Engineering Memory)\nNEWER_PROSE_MUST_SURVIVE");
}

test("grounding block carries its template version", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(groundingTemplate(renderHunchSection(store)), GROUNDING_TEMPLATE);
  assert.equal(groundingTemplate("<!-- HUNCH:START -->\nold\n<!-- HUNCH:END -->"), 1, "an unstamped block is template 1");
});

test("an older renderer moves only the counts of a newer-template block", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const older = renderHunchSection(store);
  const committed = newerBlock(older).replace(parseGroundingCounts(older)!.match, "**7 decisions, 0 bugs, 0 constraints, 0 components, 0 policies**");
  const kept = preserveNewerTemplate(`# Doc\n\n${committed}\n`, older);
  assert.match(kept, /NEWER_PROSE_MUST_SURVIVE/);
  assert.equal(groundingTemplate(kept), GROUNDING_TEMPLATE + 1);
  assert.deepEqual(parseGroundingCounts(kept)!.counts, parseGroundingCounts(older)!.counts, "counts follow the store");
  assert.equal(preserveNewerTemplate(`# Doc\n\n${older}\n`, older), older, "same template renders normally");
  assert.equal(preserveNewerTemplate("# Doc\n", older), older, "no block renders normally");
});

test("a kept newer block drops invariant lines this version no longer renders", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("constraints", mkConstraint({ id: "con_stillpublic", statement: "STILL_PUBLIC_INVARIANT", severity: "blocking" }));
  store.json.put("constraints", mkConstraint({ id: "con_goneprivate", statement: "GONE_PRIVATE_INVARIANT", severity: "blocking" }));
  const committed = newerBlock(renderHunchSection(store));
  store.json.dropAll("constraints");
  store.json.put("constraints", mkConstraint({ id: "con_stillpublic", statement: "STILL_PUBLIC_INVARIANT", severity: "blocking" }));
  const kept = preserveNewerTemplate(`# Doc\n\n${committed}\n`, renderHunchSection(store));
  assert.match(kept, /NEWER_PROSE_MUST_SURVIVE/);
  assert.match(kept, /STILL_PUBLIC_INVARIANT/);
  assert.doesNotMatch(kept, /GONE_PRIVATE_INVARIANT/, "a constraint that left the public store is not republished");

  const crlf = preserveNewerTemplate(`# Doc\r\n\r\n${committed.replace(/\n/g, "\r\n")}\r\n`, renderHunchSection(store));
  assert.doesNotMatch(crlf, /GONE_PRIVATE_INVARIANT/, "CRLF docs drop it too");
  assert.doesNotMatch(crlf, /[^\r]\n/, "line endings stay CRLF");

  store.json.dropAll("constraints");
  store.json.put("constraints", mkConstraint({ id: "con_citesother", statement: "Replaces con_goneprivate", severity: "blocking" }));
  const cited = preserveNewerTemplate(`# Doc\n\n${committed}\n`, renderHunchSection(store));
  assert.doesNotMatch(cited, /GONE_PRIVATE_INVARIANT/, "an id cited in another statement is not a rendered invariant");

  store.json.dropAll("constraints");
  const none = preserveNewerTemplate(`# Doc\n\n${committed}\n`, renderHunchSection(store));
  assert.doesNotMatch(none, /Top invariants/, "no orphan heading");
  assert.match(none, /NEWER_PROSE_MUST_SURVIVE/);
});

test("grounding writers never downgrade newer prose, but still upgrade older prose", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const root = mkdtempSync(join(tmpdir(), "hunch-template-"));
  t.after(() => cleanupDir(root));
  const section = renderHunchSection(store, root);

  const doc = join(root, "AGENTS.md");
  writeFileSync(doc, `# Mine\n\n${newerBlock(section)}\n\nTail.\n`);
  upsertSection(doc, section, "# AGENTS.md");
  assert.match(readFileSync(doc, "utf8"), /NEWER_PROSE_MUST_SURVIVE/);

  mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
  const rule = join(root, ".cursor", "rules", "hunch.mdc");
  writeFileSync(rule, `---\nalwaysApply: true\n---\n\n${newerBlock(section)}\n`);
  writeCursorRule(root, store);
  assert.match(readFileSync(rule, "utf8"), /NEWER_PROSE_MUST_SURVIVE/);

  writeFileSync(doc, "# Mine\n\n<!-- HUNCH:START — auto-generated, do not edit by hand -->\nOld prose\n<!-- HUNCH:END -->\n");
  upsertSection(doc, section, "# AGENTS.md");
  const upgraded = readFileSync(doc, "utf8");
  assert.doesNotMatch(upgraded, /Old prose/);
  assert.equal(groundingTemplate(upgraded), GROUNDING_TEMPLATE);
});

// The path that actually reverted the short block on this repo's branches: the
// post-commit capture (`sync --commit`) folds refreshCommittableGrounding's output into
// its memory commit. Every committed grounding doc must keep its newer prose there too.
test("the capture-commit refresh keeps newer-template prose in every committed grounding doc", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  const section = renderHunchSection(store, root);
  const docs = ["CLAUDE.md", "AGENTS.md", join(".github", "copilot-instructions.md"), join(".cursor", "rules", "hunch.mdc"), join(".windsurf", "rules", "hunch.md")];
  for (const rel of docs) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `# Doc\n\n${newerBlock(section)}\n`);
  }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "docs");

  refreshCommittableGrounding(root, store);
  for (const rel of docs) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.match(text, /NEWER_PROSE_MUST_SURVIVE/, `${rel} keeps the newer prose`);
    assert.equal(groundingTemplate(text), GROUNDING_TEMPLATE + 1, `${rel} keeps the newer template stamp`);
  }
});

test("a block from a newer template classifies as newer, not stale", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const generated = renderHunchSection(store);
  assert.deepEqual(classifyGroundingBlock(newerBlock(generated), generated), {
    kind: "newer", committedTemplate: GROUNDING_TEMPLATE + 1, rendererTemplate: GROUNDING_TEMPLATE, countsReadable: true,
  });
});

test("a newer-template block whose counts run AHEAD of the store still fails as ahead", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const generated = renderHunchSection(store);
  const counts = parseGroundingCounts(generated)!;
  const ahead = newerBlock(generated).replace(counts.match, counts.match.replace(/\*\*\d+ decisions?/, "**99 decisions"));
  const verdict = classifyGroundingBlock(ahead, generated);
  assert.equal(verdict.kind, "ahead");
  assert.deepEqual(verdict.kind === "ahead" && verdict.ahead, ["decisions"]);
  assert.match(describeGroundingFreshness("CLAUDE.md", verdict), /newer Hunch .*--refresh --force/);
  const plain = classifyGroundingBlock(generated.replace(counts.match, counts.match.replace(/\*\*\d+ decisions?/, "**99 decisions")), generated);
  assert.equal(plain.kind === "ahead" && plain.newerTemplate, undefined, "a same-template ahead verdict is unchanged");
});

test("a newer-template block with unreadable counts says a refresh cannot move them", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const generated = renderHunchSection(store);
  const reworded = newerBlock(generated).replace(parseGroundingCounts(generated)!.match, "a reworded counts sentence");
  const verdict = classifyGroundingBlock(reworded, generated);
  assert.deepEqual(verdict, { kind: "newer", committedTemplate: GROUNDING_TEMPLATE + 1, rendererTemplate: GROUNDING_TEMPLATE, countsReadable: false });
  assert.match(describeGroundingFreshness("CLAUDE.md", verdict), /cannot read its counts sentence/);
  assert.match(describeGroundingFreshness("CLAUDE.md", classifyGroundingBlock(newerBlock(generated), generated)), /a refresh updates only the counts/);
});

test("regenerateGrounding (private --migrate) re-renders even a newer-template block", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const root = mkdtempSync(join(tmpdir(), "hunch-template-migrate-"));
  t.after(() => cleanupDir(root));
  store.json.put("constraints", mkConstraint({ id: "con_nowprivate1", statement: "NOW_PRIVATE_INVARIANT", severity: "blocking" }));
  const withSecret = newerBlock(renderHunchSection(store, root));
  assert.match(withSecret, /NOW_PRIVATE_INVARIANT/);
  store.json.dropAll("constraints");
  writeFileSync(join(root, "CLAUDE.md"), `# Mine\n\n${withSecret}\n`);
  mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(root, ".cursor", "rules", "hunch.mdc"), `---\nalwaysApply: true\n---\n\n${withSecret}\n`);

  regenerateGrounding(root, store);
  for (const rel of ["CLAUDE.md", ".cursor/rules/hunch.mdc"]) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.doesNotMatch(text, /NOW_PRIVATE_INVARIANT/, `${rel}: a now-private constraint must not stay published`);
    assert.doesNotMatch(text, /NEWER_PROSE_MUST_SURVIVE/, `${rel}: the migrate path re-renders`);
    assert.equal(groundingTemplate(text), GROUNDING_TEMPLATE);
  }
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /^# Mine/, "user prose outside the block survives");
});

test("refreshExistingGrounding keeps newer prose unless forced", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const root = mkdtempSync(join(tmpdir(), "hunch-template-force-"));
  t.after(() => cleanupDir(root));
  const doc = join(root, "CLAUDE.md");
  writeFileSync(doc, `# Mine\n\n${newerBlock(renderHunchSection(store, root))}\n`);

  refreshExistingGrounding(root, store);
  assert.match(readFileSync(doc, "utf8"), /NEWER_PROSE_MUST_SURVIVE/);
  assert.equal(groundingTemplate(readFileSync(doc, "utf8")), GROUNDING_TEMPLATE + 1);

  refreshExistingGrounding(root, store, { force: true });
  const forced = readFileSync(doc, "utf8");
  assert.doesNotMatch(forced, /NEWER_PROSE_MUST_SURVIVE/);
  assert.equal(groundingTemplate(forced), GROUNDING_TEMPLATE);
  assert.match(forced, /^# Mine/, "user prose outside the block survives");
});

// #659: pre-release builds stamped 7 (CLAUDE.md) and 4 (AGENTS.md); the release must outrank both.
test("pre-release stamps 7 and 4 are older, re-render on a normal refresh, and 9 stays newer (#659)", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const root = mkdtempSync(join(tmpdir(), "hunch-template-659-"));
  t.after(() => cleanupDir(root));
  const generated = renderHunchSection(store, root);
  const stamped = (n: number) => generated.replace(`<!-- hunch:template ${GROUNDING_TEMPLATE} -->`, `<!-- hunch:template ${n} -->`).replace("## 🧠 Hunch (Engineering Memory)", "## 🧠 Hunch (Engineering Memory)\nPRE_RELEASE_PROSE");
  assert.ok(GROUNDING_TEMPLATE > 7, "above every pre-release stamp (4, 7)");
  for (const n of [4, 7]) {
    const v = classifyGroundingBlock(stamped(n), generated);
    assert.notEqual(v.kind, "newer", `template ${n} is not newer`);
  }
  assert.equal(classifyGroundingBlock(stamped(9), generated).kind, "newer", "template 9 is still newer");

  writeFileSync(join(root, "CLAUDE.md"), `# Mine\n\n${stamped(7)}\n\nTail claude.\n`);
  writeFileSync(join(root, "AGENTS.md"), `# Agents\n\n${stamped(4)}\n\nTail agents.\n`);
  refreshExistingGrounding(root, store);
  for (const [rel, head, tail] of [["CLAUDE.md", "# Mine\n\n", "\n\nTail claude.\n"], ["AGENTS.md", "# Agents\n\n", "\n\nTail agents.\n"]]) {
    const text = readFileSync(join(root, rel), "utf8");
    assert.equal(groundingTemplate(text), GROUNDING_TEMPLATE, `${rel} re-rendered to the current template`);
    assert.doesNotMatch(text, /PRE_RELEASE_PROSE/);
    assert.ok(text.startsWith(head) && text.endsWith(tail), `${rel} keeps text outside the block`);
  }
});

test("Top invariants never clip a blocking statement; others clip at a word boundary", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const long = (tag: string) => `${tag} ${"alpha beta gamma delta ".repeat(12)}END_OF_STATEMENT`;
  store.json.put("constraints", mkConstraint({ id: "con_blocklong01", statement: long("BLOCKING_LONG"), severity: "blocking" }));
  store.json.put("constraints", mkConstraint({ id: "con_warnlong001", statement: long("WARNING_LONG"), severity: "warning" }));

  const md = renderHunchSection(store);
  assert.ok(long("BLOCKING_LONG").length > 200);
  assert.ok(md.includes(long("BLOCKING_LONG")), "blocking statement renders in full");
  const line = md.split("\n").find((l) => l.includes("WARNING_LONG"))!;
  const m = /\*\*\[warning\]\*\* (.*?) _\(scope:/.exec(line)!;
  assert.ok(m, line);
  const clipped = m[1];
  assert.ok(clipped.endsWith("…"), clipped);
  assert.ok(clipped.length <= 200, `clipped to ${clipped.length} chars`);
  assert.doesNotMatch(clipped, /END_OF_STATEMENT/);
  const words = clipped.slice(0, -1).split(" ");
  assert.ok(["alpha", "beta", "gamma", "delta"].includes(words[words.length - 1]), `ends on a whole word: ${clipped}`);
});

// A core.autocrlf=true checkout is CRLF: a refresh must keep the doc uniformly CRLF
// (no mixed endings) and an unchanged refresh must not rewrite it (no EOL-only dirt).
const lfOnly = (s: string) => !s.includes("\r");
const crlfOnly = (s: string) => !/[^\r]\n/.test(s) && !s.startsWith("\n");

test("grounding refresh keeps a CRLF doc all-CRLF when the counts change", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, "CLAUDE.md");
  writeFileSync(file, "# Proj\r\n\r\nUser prose.\r\n");
  upsertSection(file, renderHunchSection(store, root), "# Proj");
  const first = readFileSync(file, "utf8");
  assert.ok(crlfOnly(first), "first upsert emits CRLF");
  store.json.put("constraints", mkConstraint({ id: "con_eol_one", severity: "warning", statement: "EOL marker" }));
  assert.deepEqual(refreshExistingGrounding(root, store), ["CLAUDE.md"]);
  const after = readFileSync(file, "utf8");
  assert.notEqual(after, first, "counts moved");
  assert.ok(crlfOnly(after), "still all-CRLF");
  assert.ok(after.startsWith("# Proj\r\n\r\nUser prose.\r\n"), "user prose kept verbatim");
});

test("grounding refresh with identical content does not rewrite an LF or CRLF doc", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  for (const eol of ["\n", "\r\n"]) {
    for (const rel of ["CLAUDE.md", join(".cursor", "rules", "hunch.mdc")]) {
      const file = join(root, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      if (rel === "CLAUDE.md") {
        writeFileSync(file, `# P${eol}`);
        upsertSection(file, renderHunchSection(store, root), "# P");
      } else {
        writeCursorRule(root, store);
        writeFileSync(file, readFileSync(file, "utf8").replace(/\r?\n/g, eol));
      }
      const before = readFileSync(file, "utf8");
      assert.ok(eol === "\n" ? lfOnly(before) : crlfOnly(before), `${rel} starts in ${JSON.stringify(eol)}`);
      const old = new Date(2001, 0, 1);
      utimesSync(file, old, old);
      assert.deepEqual(refreshExistingGrounding(root, store).filter((r) => r === rel), [], `${rel} not reported changed`);
      assert.equal(statSync(file).mtimeMs, old.getTime(), `${rel} not rewritten`);
      assert.equal(readFileSync(file, "utf8"), before);
    }
  }
});

test("grounding refresh keeps an LF doc LF", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, "AGENTS.md");
  writeFileSync(file, "# A\n\nProse.\n");
  upsertSection(file, renderHunchSection(store, root), "# A");
  store.json.put("constraints", mkConstraint({ id: "con_eol_two", severity: "warning", statement: "EOL marker" }));
  refreshExistingGrounding(root, store);
  const after = readFileSync(file, "utf8");
  assert.ok(lfOnly(after) && after.startsWith("# A\n\nProse.\n"));
});

const blockOf = (s: string) => s.slice(s.indexOf(HUNCH_START), s.indexOf(HUNCH_END) + HUNCH_END.length);
const innerOf = (s: string) => s.slice(s.indexOf(HUNCH_START) + HUNCH_START.length, s.indexOf(HUNCH_END)).trim();

test("a refreshed CRLF doc keeps a CRLF block and the freshness check calls it fresh", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, "CLAUDE.md");
  writeFileSync(file, `# P\r\n\r\n${renderHunchSection(store, root).replace(/\n/g, "\r\n")}\r\n`);
  store.json.put("constraints", mkConstraint({ id: "con_eol_fresh", severity: "warning", statement: "EOL marker" }));
  refreshExistingGrounding(root, store);
  const after = readFileSync(file, "utf8");
  assert.ok(crlfOnly(after), "block re-emitted in CRLF");
  assert.equal(classifyGroundingBlock(innerOf(after), innerOf(renderHunchSection(store, root))).kind, "fresh");
});

test("a refresh keeps mixed-EOL prose byte-for-byte and emits the block in the block's EOL", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, "AGENTS.md");
  const prose = "# P\r\nlf line\nlone 10%\r20%\r30%\ncrlf line\r\n";
  writeFileSync(file, `${prose}\r\n${renderHunchSection(store, root).replace(/\n/g, "\r\n")}\r\ntail lf\n`);
  store.json.put("constraints", mkConstraint({ id: "con_eol_mixed", severity: "warning", statement: "EOL marker" }));
  assert.deepEqual(refreshExistingGrounding(root, store), ["AGENTS.md"]);
  const after = readFileSync(file, "utf8");
  assert.ok(after.startsWith(`${prose}\r\n${HUNCH_START}\r\n`), "prose kept, block CRLF");
  assert.ok(after.endsWith(`${HUNCH_END}\r\ntail lf\n`), "trailing prose kept");
  assert.ok(crlfOnly(blockOf(after) + "\r\n"), "block uniformly CRLF");
  assert.match(after, /EOL marker/);
});

test("a refresh preserves lone CRs in an LF doc", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const file = join(root, "AGENTS.md");
  writeFileSync(file, "# P\n10%\r20%\r30%\n");
  upsertSection(file, renderHunchSection(store, root), "# P");
  store.json.put("constraints", mkConstraint({ id: "con_eol_cr", severity: "warning", statement: "EOL marker" }));
  refreshExistingGrounding(root, store);
  const after = readFileSync(file, "utf8");
  assert.equal((after.match(/\r/g) ?? []).length, 2);
  assert.ok(after.startsWith("# P\n10%\r20%\r30%\n\n<!--"));
});

test("the capture-commit refresh stages nothing on a CRLF checkout whose counts are current", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  const section = renderHunchSection(store, root);
  for (const rel of ["CLAUDE.md", "AGENTS.md", join(".github", "copilot-instructions.md")]) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `# Doc\r\n\r\n${section}\n`.replace(/\r?\n/g, "\r\n"));
  }
  writeCursorRule(root, store);
  const mdc = join(root, ".cursor", "rules", "hunch.mdc");
  writeFileSync(mdc, readFileSync(mdc, "utf8").replace(/\n/g, "\r\n"));
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "docs");
  assert.deepEqual(refreshCommittableGrounding(root, store), []);
  assert.equal(git("status", "--porcelain").toString(), "");
});

test("the grounding freshness check is EOL-insensitive", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const lf = innerOf(renderHunchSection(store, root));
  assert.equal(classifyGroundingBlock(lf.replace(/\n/g, "\r\n"), lf).kind, "fresh");
});
