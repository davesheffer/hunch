import { test } from "node:test";
import assert from "node:assert/strict";
import { tempStore, mkConstraint } from "./helpers.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHunchSection, upsertSection, preserveNewerTemplate, groundingTemplate, GROUNDING_TEMPLATE } from "../src/integrations/claudemd.js";
import { writeCursorRule, refreshExistingGrounding, regenerateGrounding, refreshCommittableGrounding } from "../src/integrations/providers.js";
import { execFileSync } from "node:child_process";
import { parseGroundingCounts, classifyGroundingBlock, describeGroundingFreshness, renderCountsMatch } from "../src/core/groundingLag.js";

// The always-loaded block only routes: one hunch_context line plus named blocking
// invariants. The per-moment tool list lives in the hunch_context description
// (test/mcp-instructions.test.ts locks its param names).
test("grounding block routes to hunch_context and stays small", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  for (let i = 0; i < 9; i++) {
    store.json.put("constraints", mkConstraint({
      id: `con_ceiling00${i}`, severity: "blocking", scope: ["src/a/**", "src/b/**", "src/c/**"],
      statement: `Blocking invariant ${i} ${"with a long rationale that keeps going ".repeat(8)}END`,
    }));
  }
  const md = renderHunchSection(store);
  assert.match(md, /hunch_context\(target\)` first, before reading or editing/);
  assert.ok(md.length <= 1_200, `block is ${md.length} chars; ceiling 1,200`);
  assert.match(md, /- …and 3 more: `hunch_check_constraints\(scope\)`/, "blocking invariants past the limit are counted, not listed");
  assert.doesNotMatch(md, /\*\*(Start|Design|Edit|Merge|Record|Finish):\*\*/, "no moment list in the block");
  assert.doesNotMatch(md, /hunch_policy_|Component wiki/);
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
    id: "con_active0001", statement: "ACTIVE_MUST_SURVIVE_SLICE", severity: "blocking",
  }));

  const md = renderHunchSection(store);
  assert.match(md, /ACTIVE_MUST_SURVIVE_SLICE/);
});

// Policy tools are named in the hunch_context description, never in the block: the
// committed block must not differ by machine or by a gitignored opt-in.
test("renderHunchSection never names the policy tools", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);

  const withoutPolicies = renderHunchSection(store, root);
  assert.doesNotMatch(withoutPolicies, /hunch_policy_evaluate/);
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory", mcp_tools: "core,policy" }));
  assert.equal(renderHunchSection(store, root), withoutPolicies);
  assert.doesNotMatch(renderHunchSection(store), /hunch_policy_evaluate/);
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
  assert.doesNotMatch(none, /⛔/, "no orphan heading");
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

test("Top invariants name blocking statements clipped at a word boundary and leave the rest to the pre-edit hook", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const long = (tag: string) => `${tag} ${"alpha beta gamma delta ".repeat(12)}END_OF_STATEMENT`;
  store.json.put("constraints", mkConstraint({ id: "con_blocklong01", statement: long("BLOCKING_LONG"), severity: "blocking" }));
  store.json.put("constraints", mkConstraint({ id: "con_warnlong001", statement: long("WARNING_LONG"), severity: "warning" }));

  const md = renderHunchSection(store);
  assert.doesNotMatch(md, /WARNING_LONG/, "non-blocking invariants reach the pre-edit hook, not the block");
  const m = /^- con_blocklong01: (.*)$/m.exec(md)!;
  assert.ok(m, md);
  const clipped = m[1];
  assert.ok(clipped.endsWith("…"), clipped);
  assert.ok(clipped.length <= 120, `clipped to ${clipped.length} chars`);
  assert.doesNotMatch(clipped, /END_OF_STATEMENT/);
  const words = clipped.slice(0, -1).split(" ");
  assert.ok(["alpha", "beta", "gamma", "delta"].includes(words[words.length - 1]), `ends on a whole word: ${clipped}`);
});

// The template-2 renderer (base f72927a9) stays installed globally and runs from
// post-commit hooks. Its preserveNewerTemplate, copied verbatim below, must leave a
// template-3 block intact: it drops a heading starting "### ⛔ Top invariants" when
// none of ITS invariant lines follow, which would orphan the `- con_x: …` bullets.
const V2_START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const V2_END = "<!-- HUNCH:END -->";
const V2_INVARIANTS_HEADING = "### ⛔ Top invariants";
const V2_INVARIANT_LINE_RE = /^- \*\*\[[a-z]+\]\*\* .*; (con_[A-Za-z0-9_]+)\)_\r?$/;
function v2PreserveNewerTemplate(existing: string, section: string): string {
  const iStart = existing.indexOf(V2_START);
  const iEnd = existing.indexOf(V2_END);
  if (iStart < 0 || iEnd <= iStart) return section;
  const current = existing.slice(iStart, iEnd + V2_END.length);
  if (groundingTemplate(current) <= groundingTemplate(section)) return section;
  const rendered = new Set(section.split(/\r?\n/).map((line) => V2_INVARIANT_LINE_RE.exec(line)?.[1]).filter(Boolean));
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/).filter((line) => {
    const id = V2_INVARIANT_LINE_RE.exec(line)?.[1];
    return !id || rendered.has(id);
  });
  const h = lines.findIndex((line) => line.startsWith(V2_INVARIANTS_HEADING));
  if (h >= 0 && !lines.slice(h + 1).some((line) => V2_INVARIANT_LINE_RE.test(line))) {
    lines.splice(lines[h - 1] === "" ? h - 1 : h, lines[h - 1] === "" ? 2 : 1);
  }
  const kept = lines.join(eol);
  const have = parseGroundingCounts(kept);
  const next = parseGroundingCounts(section);
  return have && next ? kept.replace(have.match, next.match) : kept;
}

test("the installed template-2 renderer leaves a template-3 block intact", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  for (let i = 0; i < 8; i++) store.json.put("constraints", mkConstraint({ id: `con_blocking0${i}`, statement: `BLOCKING_${i}`, severity: "blocking" }));
  const v3 = renderHunchSection(store);
  assert.match(v3, /^- con_blocking00: BLOCKING_0$/m);
  assert.match(v3, /^- …and 2 more/m);
  const counts = parseGroundingCounts(v3)!.counts;
  // What the template-2 renderer writes for the same store (its invariant lines included).
  const v2Lines = [V2_START, "<!-- hunch:template 2 -->", "## 🧠 Hunch (Engineering Memory)", "",
    `This repo has **Hunch**, a graph of *why* the code is the way it is. It holds ${renderCountsMatch(counts)}. Use the \`hunch_*\` MCP tools by moment:`, "",
    "### ⛔ Top invariants (do not break)"];
  for (let i = 0; i < 8; i++) v2Lines.push(`- **[blocking]** BLOCKING_${i} _(scope: src/**; con_blocking0${i})_`);
  v2Lines.push(V2_END);
  const v2 = v2Lines.join("\n");
  assert.equal(groundingTemplate(v2), 2);

  assert.equal(v2PreserveNewerTemplate(`# Doc\n\n${v3}\n`, v2), v3, "the block survives unchanged");
  const moved = renderCountsMatch({ ...counts, decisions: counts.decisions + 5 });
  const v2Moved = v2.replace(renderCountsMatch(counts), moved);
  assert.equal(v2PreserveNewerTemplate(`# Doc\n\n${v3}\n`, v2Moved), v3.replace(renderCountsMatch(counts), moved), "only the counts move");
  // Sanity: under the old heading the same logic orphaned the bullets.
  const oldHeading = v3.replace(/^### ⛔ .*$/m, "### ⛔ Top invariants (blocking)");
  assert.doesNotMatch(v2PreserveNewerTemplate(`# Doc\n\n${oldHeading}\n`, v2), /### ⛔/);

  // This renderer still keeps a newer block's heading over either template's lines.
  for (const block of [v2, v3]) {
    const kept = preserveNewerTemplate(`# Doc\n\n${newerBlock(block.replace("<!-- hunch:template 2 -->", `<!-- hunch:template ${GROUNDING_TEMPLATE} -->`))}\n`, v3);
    assert.match(kept, /NEWER_PROSE_MUST_SURVIVE/);
    assert.match(kept, /^### ⛔ /m);
    assert.match(kept, /con_blocking00/);
  }
  // And replaces either template in place, idempotently.
  const dir = mkdtempSync(join(tmpdir(), "hunch-v2v3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const block of [v2, v3]) {
    const doc = join(dir, "AGENTS.md");
    writeFileSync(doc, `# Mine\n\n${block}\n\ntail\n`);
    upsertSection(doc, v3, "# x");
    const once = readFileSync(doc, "utf8");
    upsertSection(doc, v3, "# x");
    assert.equal(readFileSync(doc, "utf8"), once);
    assert.equal(once, `# Mine\n\n${v3}\n\ntail\n`);
  }
});
