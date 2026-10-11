/**
 * Issue #381: the places the docanchors code scanner disagreed with a CommonMark
 * renderer (checked against micromark), plus the unclosed-fence drift report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { computeDrift } from "../src/core/drift.js";
import { parseDocAnchors, scanDocAnchors } from "../src/core/docanchors.js";

const doc = (...lines: string[]): string => lines.join("\n");
const topics = (md: string): string[] => parseDocAnchors(md).map((a) => a.topic);

test("a BOM-prefixed file: a fence on line 1 is still a fence", () => {
  const md = "﻿" + doc("```md", "<!-- hunch:topic bom.example -->", "```", "<!-- hunch:topic real.topic -->");
  assert.deepEqual(parseDocAnchors(md), [{ topic: "real.topic", pin: null, line: 4 }]);
  assert.deepEqual(topics("﻿<!-- hunch:topic first.line -->"), ["first.line"], "a marker on line 1 still parses");
});

test("HTML blocks are raw HTML: a ``` inside one opens no fence, and its marker stays live", () => {
  assert.deepEqual(topics(doc("<details>", "```", "<!-- hunch:topic in.details -->", "```", "</details>")), ["in.details"]);
  assert.deepEqual(topics(doc("<div>", "", "```", "<!-- hunch:topic after.blank -->", "```")), [], "a type-6 block ends at a blank line; the fence after it is real");
  assert.deepEqual(topics(doc("<pre>", "", "    <!-- hunch:topic in.pre -->", "</pre>")), ["in.pre"], "a <pre> block runs to </pre> across blank lines; no indented code inside");
  assert.deepEqual(topics(doc("<!--", "```", "-->", "<!-- hunch:topic after.comment -->")), ["after.comment"], "a multi-line comment opens no fence");
});

test("blockquotes are containers: a quoted fence hides its example, and leaving the quote ends the fence", () => {
  assert.deepEqual(topics(doc("> ```md", "> <!-- hunch:topic quoted.example -->", "> ```", "", "<!-- hunch:topic real.topic -->")), ["real.topic"]);
  assert.deepEqual(topics(doc("> ```", "> unclosed in the quote", "", "<!-- hunch:topic after.quote -->")), ["after.quote"], "the fence ends with its quote, not at EOF");
  assert.deepEqual(topics(doc("> - item", ">   ```", ">   <!-- hunch:topic nested.example -->", ">   ```")), [], "a list item inside a quote hosts a fence too");
  assert.deepEqual(topics("> <!-- hunch:topic quoted.live -->"), ["quoted.live"], "a marker in a quote is not code");
});

test("lazy continuation keeps a list item open, so its fence ends where the item really ends", () => {
  // `bar` continues `foo`'s paragraph (a renderer keeps the item open); the fence is the item's
  // and the column-0 marker ends both. Closing the item at `bar` made the fence top-level and
  // swallowed the marker.
  assert.deepEqual(topics(doc("- foo", "bar", "  ```", "<!-- hunch:topic lazy.live -->", "  ```")), ["lazy.live"]);
  assert.deepEqual(topics(doc("> quoted paragraph", "lazy line", "> ```", "> <!-- hunch:topic quoted.example -->", "> ```")), [], "a lazy line keeps the quote open too");
});

test("indented code blocks hide their markers, including after a paragraph that a `2.` cannot interrupt (#358)", () => {
  assert.deepEqual(topics(doc("Prose.", "", "    <!-- hunch:topic indented.example -->", "", "<!-- hunch:topic real.topic -->")), ["real.topic"]);
  assert.deepEqual(topics(doc("para", "2. x", "", "    ```", "    <!-- hunch:topic issue358.example -->", "    ```")), []);
  assert.deepEqual(topics(doc("para", "    <!-- hunch:topic continuation.live -->")), ["continuation.live"], "an indented line continuing a paragraph is text, not code");
  assert.deepEqual(topics(doc("    code", "", "    <!-- hunch:topic still.code -->", "<!-- hunch:topic after.code -->")), ["after.code"], "blank lines stay inside an indented block");
});

test("an unclosed fence is reported with the markers it hides; a closed fence or nothing hidden is not", () => {
  const md = doc("intro", "```md", "<!-- hunch:topic a.topic dec_aaaa000001 -->", "text", "<!-- hunch:topic b.topic -->");
  assert.deepEqual(scanDocAnchors(md), { anchors: [], unclosedFence: { line: 2, hidden: 2 } });
  assert.equal(scanDocAnchors(doc("```", "<!-- hunch:topic a.topic -->", "```")).unclosedFence, null);
  assert.equal(scanDocAnchors(doc("<!-- hunch:topic a.topic -->", "```", "code to EOF")).unclosedFence, null, "nothing hidden: nothing to report");
});

test("drift reports an unclosed fence as doc-fence-unclosed (advisory)", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  writeFileSync(join(root, "AGENTS.md"), doc("# Agents", "", "```sh", "npm test", "", "<!-- hunch:topic auth.session -->", "Sessions are cookies."));
  const findings = computeDrift(store, root).findings.filter((f) => f.kind === "doc-fence-unclosed");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.id, "AGENTS.md");
  assert.match(findings[0]!.detail, /fence opened at line 3 never closes; 1 marker\(s\) below it are hidden/);
});

test("the scanner stays linear on a long quoted, nested line", () => {
  const line = "> ".repeat(20_000) + "- ".repeat(20_000) + "x";
  const started = Date.now();
  parseDocAnchors(doc(line, line, "<!-- hunch:topic t -->"));
  assert.ok(Date.now() - started < 2_000, "no quadratic walk");
});
