/**
 * Markdown topic anchors (doc≠graph for PROSE): parseDocAnchors, the
 * doc-anchor-stale / doc-anchor-dangling drift kinds, and the pre-edit
 * doc-grounding renderer. Deterministic: only an explicit pin can fire drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempStore, prov } from "./helpers.js";
import { computeDrift } from "../src/core/drift.js";
import { parseDocAnchors, renderDocGrounding } from "../src/core/docanchors.js";
import type { Decision } from "../src/core/types.js";

const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_x", title: "t", status: "accepted", context: "", decision: "d",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: "2026-01-01T00:00:00Z",
  topic: null,
  ...over,
});

test("parseDocAnchors: pinned, unpinned, line numbers; prose without markers parses empty", () => {
  const md = [
    "# Auth",
    "",
    "<!-- hunch:topic auth.session dec_aaaa000001 -->",
    "Sessions are cookies.",
    "",
    "<!-- hunch:topic store.driver -->",
    "The index uses SQLite.",
    "<!--hunch:topic tight.spacing dec_bbbb000002-->",
  ].join("\n");
  const anchors = parseDocAnchors(md);
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors[0], { topic: "auth.session", pin: "dec_aaaa000001", line: 3 });
  assert.deepEqual(anchors[1], { topic: "store.driver", pin: null, line: 6 });
  assert.deepEqual(anchors[2], { topic: "tight.spacing", pin: "dec_bbbb000002", line: 8 });
  assert.deepEqual(parseDocAnchors("# just prose\nno markers here"), []);
});

test("parseDocAnchors: markers inside fenced code blocks are examples, not declarations", () => {
  const md = [
    "# How to anchor a doc",
    "",
    "```markdown",
    "<!-- hunch:topic example.topic dec_ffff000009 -->",   // documentation example → ignored
    "```",
    "",
    "~~~",
    "<!-- hunch:topic tilde.example -->",                  // tilde fence → ignored
    "~~~",
    "",
    "````md info",
    "```",
    "<!-- hunch:topic nested.example -->",                 // shorter fence can't close a longer one
    "```",
    "````",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",      // outside all fences → live
    "Prose about the real topic.",
  ].join("\n");
  const anchors = parseDocAnchors(md);
  assert.deepEqual(anchors, [{ topic: "real.topic", pin: "dec_aaaa000001", line: 17 }]);

  // An unclosed fence swallows everything to EOF.
  assert.deepEqual(parseDocAnchors("```\n<!-- hunch:topic dangling.example -->"), []);
});

test("parseDocAnchors: a CRLF checkout still detects the fence — an example marker inside one stays inert (issue #298)", () => {
  const md = [
    "# How to anchor a doc",
    "",
    "```markdown",
    "<!-- hunch:topic example.topic dec_ffff000009 -->",   // documentation example → must stay ignored on CRLF too
    "```",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",      // outside the fence → live
    "Prose about the real topic.",
  ].join("\r\n");
  const anchors = parseDocAnchors(md);
  assert.deepEqual(anchors, [{ topic: "real.topic", pin: "dec_aaaa000001", line: 7 }]);
});

test("parseDocAnchors: mixed LF and CRLF line endings in the same document still detect the fence", () => {
  const md =
    "# How to anchor a doc\r\n\n```markdown\r\n<!-- hunch:topic example.topic dec_ffff000009 -->\n```\r\n\n<!-- hunch:topic real.topic dec_aaaa000001 -->\r\nProse about the real topic.\n";
  const anchors = parseDocAnchors(md);
  assert.deepEqual(anchors, [{ topic: "real.topic", pin: "dec_aaaa000001", line: 7 }]);
});

test("parseDocAnchors: an unclosed fence on CRLF still swallows everything to EOF", () => {
  assert.deepEqual(parseDocAnchors("```\r\n<!-- hunch:topic dangling.example -->"), []);
});

test("parseDocAnchors: a lone-CR document — stray backticks on different lines must not pair into a false span", () => {
  // split("\n") does not split on a bare \r, so without normalization the whole
  // document is one "line" and the same-line pairing rule swallows the marker.
  const md = "stray ` backtick\r<!-- hunch:topic real.topic dec_aaaa000001 -->\ranother stray ` backtick\r";
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 2 }]);
});

const LIST_DOC = [
  "# How to anchor a doc",
  "",
  "1. Anchor a doc like this:",
  "",
  "    ```markdown",
  "    <!-- hunch:topic example.topic dec_ffff000009 -->",  // example inside a list-item fence → inert
  "    ```",
  "",
  "<!-- hunch:topic real.topic dec_aaaa000001 -->",         // back at column 0 → live
  "Prose about the real topic.",
];

test("parseDocAnchors: a fence indented inside a list item still hides its example marker (issue #331)", () => {
  assert.deepEqual(parseDocAnchors(LIST_DOC.join("\n")), [
    { topic: "real.topic", pin: "dec_aaaa000001", line: 9 },
  ]);
});

test("parseDocAnchors: a list-item fence on a CRLF checkout behaves the same (issue #331)", () => {
  assert.deepEqual(parseDocAnchors(LIST_DOC.join("\r\n")), [
    { topic: "real.topic", pin: "dec_aaaa000001", line: 9 },
  ]);
});

test("parseDocAnchors: bullet items and nested items hide their fenced examples (issue #331)", () => {
  const md = [
    "- item",
    "",
    "  ```md",
    "  <!-- hunch:topic bullet.example dec_ffff000009 -->",
    "  ```",
    "",
    "- a",
    "  - b",
    "",
    "    ```md",
    "    <!-- hunch:topic nested.example -->",
    "    ```",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 14 }]);
});

test("parseDocAnchors: a fence opened on the list-marker line itself hides its example (issue #331)", () => {
  const md = [
    "- ```md",
    "  <!-- hunch:topic marker.line.example dec_ffff000009 -->",
    "  ```",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 5 }]);
});

test("parseDocAnchors: an unclosed list-item fence ends with the item, not at EOF (issue #331)", () => {
  const md = [
    "1. step:",
    "",
    "    ```md",
    "    <!-- hunch:topic example.topic dec_ffff000009 -->",  // inside the unclosed fence → inert
    "",
    "Back to ordinary prose.",                                // column 0 → the item (and the fence) ends
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",         // must stay live
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 8 }]);
});

test("parseDocAnchors: with no list open, an indented ``` line is still an indented code block (issue #331)", () => {
  const md = [
    "Prose.",
    "",
    "    ```",
    "    <!-- hunch:topic indented.topic dec_ffff000009 -->",  // indented code block, not a fence → live
    "    ```",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "indented.topic", pin: "dec_ffff000009", line: 4 }]);
});

test("parseDocAnchors: a thematic break does not open a list item (issue #331)", () => {
  for (const rule of ["- - -", "* * *"]) {
    const md = [
      rule,
      "",
      "    ```",
      "    <!-- hunch:topic break.topic dec_ffff000009 -->",  // no item is open → indented code block → live
      "    ```",
    ].join("\n");
    assert.deepEqual(parseDocAnchors(md), [{ topic: "break.topic", pin: "dec_ffff000009", line: 4 }], rule);
  }
});

test("parseDocAnchors: an indented code block INSIDE a list item is not a fence (issue #331)", () => {
  const md = [
    "1. step:",           // content offset 3
    "",
    "       ```",         // 7 spaces = 4 past the item content → indented code block
    "       <!-- hunch:topic deep.topic dec_ffff000009 -->",
    "       ```",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "deep.topic", pin: "dec_ffff000009", line: 4 }]);
});

test("parseDocAnchors: a line of nothing but list markers stays linear, not quadratic (issue #331)", () => {
  // The list-marker walk used to re-slice the line and re-scan the remainder
  // per marker, so a pathological line cost O(L²): a 1 MB line did not finish
  // in ten minutes. Both shapes are 1 MB of markers and nothing else.
  for (const line of ["- ".repeat(500_000) + "x", "-" + " -".repeat(500_000) + " x"]) {
    const started = performance.now();
    assert.deepEqual(parseDocAnchors(line), []);
    const ms = performance.now() - started;
    // Generously above the ~30 ms this takes; the point is minutes → milliseconds.
    assert.ok(ms < 2000, `1 MB marker line took ${ms.toFixed(0)}ms`);
  }
});

test("parseDocAnchors: only a bullet or `1.` with content interrupts a paragraph (issue #331)", () => {
  // CommonMark: mid-paragraph, an ordered marker opens an item only when it is
  // numbered 1 — otherwise "2. the second point" is prose, and the fence below
  // it is measured from column 0, not from a phantom item.
  const withBlank = [
    "See the changelog for",
    "2. the second point",                                    // prose, not an item
    "",
    "   ```md",                                               // 3 spaces → a real fence
    "<!-- hunch:topic ex.topic dec_aaaa000001 -->",           // inside it → inert
    "   ```",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(withBlank), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 7 }]);

  const tight = [
    "Paragraph text",
    "2. something",                                           // prose, not an item
    "    ```",                                                // 4 spaces from column 0 → not a fence
    "    <!-- hunch:topic real.topic dec_aaaa000001 -->",     // nothing hides it
  ].join("\n");
  assert.deepEqual(parseDocAnchors(tight), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 4 }]);
});

test("parseDocAnchors: a `1.` item and sibling `2.` items still work after a paragraph (issue #331)", () => {
  const md = [
    "Steps:",
    "1. first",                                               // `1.` may interrupt a paragraph
    "2. second",                                              // a sibling of an OPEN item
    "",
    "   ```md",
    "   <!-- hunch:topic ex.topic dec_ffff000009 -->",
    "   ```",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 9 }]);

  // The same shape with a fence that is ONLY a fence if `10.` opened an item
  // (4 columns from column 0 would be an indented block): a sibling marker
  // dedents out of the previous item, so it is a fresh block start and the
  // paragraph-interruption rule does not apply to it.
  const wide = [
    "9. nine",
    "10. ten",                                                // sibling, numbered ≠ 1
    "",
    "    ```md",
    "    <!-- hunch:topic ex.topic dec_ffff000009 -->",
    "    ```",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(wide), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 8 }]);

  // A bullet list followed straight by an ordered list starting at 10: the
  // bullet item closes on the dedent, so `10.` starts a list, not prose.
  const afterBullet = wide.replace("9. nine", "- nine");
  assert.deepEqual(parseDocAnchors(afterBullet), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 8 }]);
});

test("parseDocAnchors: a thematic break is ONE repeated char at ≤3 columns (issue #331)", () => {
  // `- - - * -` mixes break chars: five nested items, the innermost at column
  // 8, so a fence indented 8 belongs to it. Read as a break, the fence would
  // be an indented block and its example marker would go live.
  const mixed = [
    "- - - * -",
    "        ```md",
    "        <!-- hunch:topic ex.topic dec_ffff000009 -->",
    "        ```",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(mixed), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 6 }]);

  // `    ---` under a paragraph is paragraph text, so the paragraph is still
  // open on the next line and `2. x` cannot interrupt it.
  const indented = [
    "Paragraph text",
    "    ---",
    "2. something",                                           // prose, not an item
    "    ```",                                                // 4 columns from 0 → not a fence
    "    <!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(indented), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 5 }]);
});

test("parseDocAnchors: tabs expand to the next tab stop, not a flat 4 columns (issue #331)", () => {
  // Under a `- a` item (content base 2) a tab is column 4 — inside the item, so
  // "\t```" is a fence; "  \t```" is ALSO column 4 (the tab advances 2, not 4)
  // and closes it. A flat-4 expansion put the latter at column 6 and left the
  // fence open, swallowing the live marker.
  const md = [
    "- a",
    "",
    "\t```",
    "\t<!-- hunch:topic ex.topic dec_ffff000009 -->",         // inside the fence → inert
    "  \t```",                                                // same column → closes it
    "",
    "  <!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: "dec_aaaa000001", line: 7 }]);
});

test("parseDocAnchors: a list-item fence ends where the ITEM ends, as rendered (issue #331)", () => {
  // Pins the deliberate rule in fencedRanges' docblock: a fence hosted in an
  // item ends at the first non-blank line dedented below the item's content
  // base. Each expectation below was verified against micromark (CommonMark).
  const dedentedCloser = [
    "1. Run:",
    "   ```sh",
    "   cmd",
    "```",                                                    // column 0 → leaves the item, ends that
    "2. Next",                                                // fence, and OPENS a top-level one
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",         // swallowed to EOF
  ].join("\n");
  assert.deepEqual(parseDocAnchors(dedentedCloser), []);

  const dedentedContent = [
    "- Run:",
    "  ```sh",
    "cmd",                                                    // column 0 → ends the item's fence
    "  ```",                                                  // opens a fence that runs to EOF
    "- Next",
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(dedentedContent), []);

  const markerOutsideItem = [
    "1. Step:",
    "",
    "   ```md",
    "<!-- hunch:topic ex.topic dec_ffff000009 -->",           // column 0 → outside the item, so LIVE
    "   ```",                                                 // opens a fence that hides `real`
    "",
    "<!-- hunch:topic real.topic dec_aaaa000001 -->",
  ].join("\n");
  assert.deepEqual(parseDocAnchors(markerOutsideItem), [{ topic: "ex.topic", pin: "dec_ffff000009", line: 4 }]);
});

test("parseDocAnchors: markers inside inline code spans are examples too", () => {
  const md = [
    "Anchor a section with `<!-- hunch:topic span.example -->` in the doc.",   // inline span → ignored
    "Double form: ``<!-- hunch:topic double.example -->`` also renders literally.",
    "A lone backtick ` does not open a span: <!-- hunch:topic real.topic -->",  // unpaired run → live
    "<!-- hunch:topic plain.topic dec_aaaa000001 -->",                          // no backticks → live
  ].join("\n");
  assert.deepEqual(parseDocAnchors(md), [
    { topic: "real.topic", pin: null, line: 3 },
    { topic: "plain.topic", pin: "dec_aaaa000001", line: 4 },
  ]);
});

test("drift doc-anchor-stale: a pin to a superseded decision fires (and gates); current pin and unpinned stay silent", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old1111111", topic: "auth.session", status: "superseded", superseded_by: "dec_new2222222" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new2222222", topic: "auth.session", title: "Sessions via JWT", valid_from: "2026-02-01T00:00:00Z" }) as never);
  writeFileSync(join(root, "AGENTS.md"), [
    "<!-- hunch:topic auth.session dec_old1111111 -->",   // stale pin → fires
    "Sessions are server-side cookies.",
    "<!-- hunch:topic auth.session dec_new2222222 -->",   // current pin → silent
    "<!-- hunch:topic auth.session -->",                  // unpinned → silent
  ].join("\n"));

  const findings = computeDrift(store, root).findings.filter((f) => f.kind === "doc-anchor-stale");
  assert.equal(findings.length, 1, "only the stale pin fires");
  assert.equal(findings[0]!.id, "AGENTS.md");
  assert.match(findings[0]!.detail, /line 1/);
  assert.match(findings[0]!.detail, /dec_old1111111/);
  assert.match(findings[0]!.detail, /dec_new2222222/);
});

test("drift doc-anchor-dangling: a pin to a decision that does not exist is flagged", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  writeFileSync(join(root, "CLAUDE.md"), "<!-- hunch:topic ghost.topic dec_gone9999999 -->\n");
  const findings = computeDrift(store, root).findings.filter((f) => f.kind === "doc-anchor-dangling");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.id, "CLAUDE.md");
  assert.match(findings[0]!.detail, /dec_gone9999999/);
});

test("renderDocGrounding: current decision + rejected alternatives + stale-pin warning; empty when nothing resolves", () => {
  const decisions = [
    DEC({ id: "dec_old1111111", topic: "auth.session", status: "superseded", superseded_by: "dec_new2222222" }),
    DEC({
      id: "dec_new2222222", topic: "auth.session", title: "Sessions via JWT",
      decision: "stateless JWT with rotation", valid_from: "2026-02-01T00:00:00Z",
      alternatives_rejected: ["server-side cookie store"],
    }),
  ] as unknown as Decision[];

  const stale = renderDocGrounding([{ topic: "auth.session", pin: "dec_old1111111", line: 1 }], decisions);
  assert.match(stale, /dec_new2222222/);
  assert.match(stale, /stateless JWT with rotation/);
  assert.match(stale, /PINNED to dec_old1111111/);

  const fresh = renderDocGrounding([{ topic: "auth.session", pin: "dec_new2222222", line: 1 }], decisions);
  assert.ok(!fresh.includes("PINNED"), "current pin gets no warning");

  assert.equal(renderDocGrounding([{ topic: "unknown.topic", pin: null, line: 1 }], decisions), "");
});

test("renderDocGrounding: stale-pin warning survives an earlier unpinned marker on the same topic (order independence)", () => {
  const decisions = [
    DEC({ id: "dec_old1111111", topic: "auth.session", status: "superseded", superseded_by: "dec_new2222222" }),
    DEC({ id: "dec_new2222222", topic: "auth.session", valid_from: "2026-02-01T00:00:00Z" }),
  ] as unknown as Decision[];
  const out = renderDocGrounding(
    [
      { topic: "auth.session", pin: null, line: 1 },              // unpinned marker first — used to swallow the ⚠
      { topic: "auth.session", pin: "dec_old1111111", line: 5 },  // stale pin later in the doc
    ],
    decisions,
  );
  assert.match(out, /PINNED to dec_old1111111/, "topic dedupe must not hide a later stale pin");
});

test("drift scans .claude/skills prose: a stale pin in a skill file fires doc-anchor-stale", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old1111111", topic: "auth.session", status: "superseded", superseded_by: "dec_new2222222" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new2222222", topic: "auth.session", title: "Sessions via JWT", valid_from: "2026-02-01T00:00:00Z" }) as never);
  mkdirSync(join(root, ".claude", "skills", "my-skill"), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", "my-skill", "SKILL.md"), "<!-- hunch:topic auth.session dec_old1111111 -->\nDoctrine written against the old decision.\n");

  const findings = computeDrift(store, root).findings.filter((f) => f.kind === "doc-anchor-stale");
  assert.equal(findings.length, 1, "skill prose is drift-checked like any spec");
  assert.equal(findings[0]!.id, ".claude/skills/my-skill/SKILL.md");
  assert.match(findings[0]!.detail, /dec_new2222222/);
});
