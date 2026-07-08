/**
 * Markdown topic anchors (doc≠graph for PROSE): parseDocAnchors, the
 * doc-anchor-stale / doc-anchor-dangling drift kinds, and the pre-edit
 * doc-grounding renderer. Deterministic: only an explicit pin can fire drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
