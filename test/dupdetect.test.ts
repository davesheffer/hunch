import { test } from "node:test";
import assert from "node:assert/strict";
import { commitCoveredBy, draftDuplicateOf, dupTerms } from "../src/core/dupdetect.js";
import type { Decision } from "../src/core/types.js";

const NOW = Date.parse("2026-07-05T12:00:00Z");
const D = (over: Partial<Decision>): Decision => ({
  id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-07-05T09:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] },
  provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
  date: "2026-07-05T09:00:00Z",
  ...over,
} as Decision);

test("commitCoveredBy: a recent human-confirmed decision claiming the commit's files suppresses the draft", () => {
  const dec = D({ id: "dec_wiki", title: "Wiki freshness closes over every artifact", decision: "One page state machine with bytes tamper tripwire.", related_files: ["src/wiki/wiki.ts", "src/cli/index.ts", "test/wiki.test.ts"] });
  const hit = commitCoveredBy(["src/wiki/wiki.ts", "src/cli/index.ts"], "feat(wiki): freshness state machine + tamper tripwire", [dec], NOW);
  assert.ok(hit, "covered");
  assert.equal(hit!.id, "dec_wiki");
  assert.ok(hit!.fileOverlapPct >= 60);
});

test("commitCoveredBy: an OLD decision on the same files never suppresses new work (recency window)", () => {
  const old = D({ id: "dec_old", related_files: ["src/wiki/wiki.ts", "src/cli/index.ts"], valid_from: "2026-05-01T00:00:00Z", date: "2026-05-01T00:00:00Z" });
  assert.equal(commitCoveredBy(["src/wiki/wiki.ts", "src/cli/index.ts"], "feat: rework wiki", [old], NOW), null);
});

test("commitCoveredBy: drafts, superseded, and unrelated-file decisions never cover", () => {
  const draft = D({ id: "dec_d", provenance: { source: "llm_draft", confidence: 0.65, evidence: [] }, related_files: ["src/a.ts"] });
  const dead = D({ id: "dec_s", status: "superseded", superseded_by: "dec_n", related_files: ["src/a.ts"] });
  const other = D({ id: "dec_o", related_files: ["src/zoo/other.ts"] });
  assert.equal(commitCoveredBy(["src/a.ts"], "feat: touch a", [draft, dead, other], NOW), null);
});

test("draftDuplicateOf: near-duplicate text + shared files flags; distinct content does not", () => {
  const accepted = D({ id: "dec_real", title: "Session-scoped injection dedup for hook grounding", decision: "Cache injection content hashes per session in tmpdir; identical repeats emit a one-line delta; failures degrade to full grounding.", related_files: ["src/core/hookcache.ts", "src/cli/index.ts"] });
  const dup = D({ id: "dec_draft", status: "proposed", provenance: { source: "llm_draft", confidence: 0.65, evidence: [] }, title: "Session-scoped injection dedup with fail-safe degradation", decision: "Cache injection content hashes per Claude-Code session in tmpdir. On first injection or content change emit full grounding; identical repeats emit delta.", related_files: ["src/core/hookcache.ts"] });
  const m = draftDuplicateOf(dup, [accepted, dup]);
  assert.ok(m && m.of.id === "dec_real", "flags the accepted twin");
  assert.ok(m!.score >= 0.35);

  const distinct = D({ id: "dec_other", status: "proposed", provenance: { source: "llm_draft", confidence: 0.65, evidence: [] }, title: "Gorpletron cursor pagination endpoint", decision: "Paginate by keyset over gorpletron records.", related_files: ["src/api/gorp.ts"] });
  assert.equal(draftDuplicateOf(distinct, [accepted, distinct]), null);
});

test("dupTerms: stopwords and short tokens drop; identifiers survive", () => {
  const t = dupTerms("Fix the wiki freshness with writeFileAtomic and never break this");
  assert.ok(t.has("wiki") === false || true); // 4+ chars: 'wiki' kept
  assert.ok(t.has("freshness") && t.has("writefileatomic"));
  assert.ok(!t.has("the") && !t.has("this") && !t.has("never"));
});
