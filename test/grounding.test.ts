import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, mkConstraint } from "./helpers.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHunchSection, upsertSection, preserveNewerTemplate, groundingTemplate, GROUNDING_TEMPLATE } from "../src/integrations/claudemd.js";
import { writeCursorRule, refreshExistingGrounding, regenerateGrounding } from "../src/integrations/providers.js";
import { parseGroundingCounts, classifyGroundingBlock, describeGroundingFreshness } from "../src/core/groundingLag.js";

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

// A retired constraint has an explicitly closed valid-time window — the invariant it
// describes is no longer true. Rendering it into "Top invariants (do not break)" tells
// every future agent to enforce a rule that's already been withdrawn.
test("renderHunchSection excludes retired constraints from Top invariants", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);

  store.json.put("constraints", mkConstraint({
    id: "con_retired0001", statement: "RETIRED_INVARIANT_MUST_NOT_APPEAR", severity: "blocking",
    status: "retired", valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-06-01T00:00:00.000Z",
  }));
  store.json.put("constraints", mkConstraint({
    id: "con_active0001", statement: "ACTIVE_INVARIANT_MUST_APPEAR", severity: "blocking",
  }));

  const md = renderHunchSection(store);
  assert.doesNotMatch(md, /RETIRED_INVARIANT_MUST_NOT_APPEAR/);
  assert.match(md, /ACTIVE_INVARIANT_MUST_APPEAR/);
});

// Retiring a constraint by hand-editing its JSON (the only path that exists today, per
// #21) can close valid_to without also flipping status — hunchStore.ts's own staleness
// check already treats either signal as dead (`status === "retired" || !!valid_to`); the
// render must agree, or a hand-retired constraint keeps appearing as "do not break".
test("renderHunchSection excludes a constraint whose valid_to is closed even if status wasn't flipped", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);

  store.json.put("constraints", mkConstraint({
    id: "con_closed0001", statement: "CLOSED_VALID_TO_MUST_NOT_APPEAR", severity: "blocking",
    status: "active", valid_to: "2026-06-01T00:00:00.000Z",
  }));

  const md = renderHunchSection(store);
  assert.doesNotMatch(md, /CLOSED_VALID_TO_MUST_NOT_APPEAR/);
});

// renderHunchSection caps "Top invariants" at 8 entries. Retired constraints sorting
// ahead of active ones (by severity) must not consume those slots and starve real,
// still-enforced invariants out of the rendered list entirely.
test("renderHunchSection doesn't let retired constraints starve active ones out of the top-8 slice", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);

  for (let i = 0; i < 8; i++) {
    store.json.put("constraints", mkConstraint({
      id: `con_retired000${i}`, statement: `RETIRED_${i}_MUST_NOT_APPEAR`, severity: "blocking", status: "retired",
      valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-06-01T00:00:00.000Z",
    }));
  }
  store.json.put("constraints", mkConstraint({
    id: "con_active0001", statement: "ACTIVE_MUST_SURVIVE_SLICE", severity: "advisory",
  }));

  const md = renderHunchSection(store);
  assert.match(md, /ACTIVE_MUST_SURVIVE_SLICE/);
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
