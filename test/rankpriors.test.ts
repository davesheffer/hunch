import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedLastChangeDates } from "../src/extractors/git.js";
import { tempStore, prov } from "./helpers.js";
import { formatSearchHit } from "../src/core/format.js";

const NOW = "2026-07-05T00:00:00Z";
const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_x", title: "t", topic: null, status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: NOW, valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: NOW,
  ...over,
});

function git(root: string, args: string[], date?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
  }).trim();
}

test("rank priors: a LIVE human-confirmed decision outranks its superseded twin on the same terms", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old", title: "Gorpletron uses offset pagination", decision: "Gorpletron paginates by offset.", status: "superseded", superseded_by: "dec_new", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", title: "Gorpletron uses cursor pagination", decision: "Gorpletron paginates by cursor.", supersedes: "dec_old", provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("gorpletron pagination", 5)).map((h) => h.ref);
  assert.ok(refs.indexOf("dec_new") < refs.indexOf("dec_old"), `live before superseded, got ${refs.join(",")}`);
});

test("rank priors: topic-chain promotion surfaces the CURRENT decision even when only the superseded one matches lexically", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // Old title carries the distinctive term; the successor shares NO query term.
  store.json.put("decisions", DEC({ id: "dec_old", topic: "zorp.api", title: "Blimfrazzle endpoint returns XML", decision: "Blimfrazzle speaks XML.", status: "superseded", superseded_by: "dec_new", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", topic: "zorp.api", title: "Endpoint speaks JSON now", decision: "JSON only.", supersedes: "dec_old", provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("blimfrazzle", 5)).map((h) => h.ref);
  assert.ok(refs.includes("dec_new"), `successor injected via topic chain, got ${refs.join(",")}`);
  assert.ok(refs.indexOf("dec_new") < refs.indexOf("dec_old"), "and it outranks the stale hit");
});

test("rank priors: runbook trigger phrase beats keyword luck in scoped retrieval", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const RB = (id: string, task: string, trigger: string[], steps: string[]) => ({
    id, task, trigger, steps, files: [], gotchas: [], outcome: "", source_range: null,
    valid_from: NOW, valid_to: null, provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: NOW,
  });
  store.json.put("runbooks", RB("rb_release", "cut a frobwidget release", ["cut a release"], ["bump frobwidget version", "publish frobwidget to npm", "tag frobwidget release notes"]) as never);
  store.json.put("runbooks", RB("rb_wiki", "work on the frobwidget wiki", ["work on the wiki"], ["read frobwidget docs"]) as never);
  store.reindex();
  const refs = (await store.searchRunbooks("work on the wiki", 5, { embedder: null as never })).map((h) => h.ref);
  assert.equal(refs[0], "rb_wiki", `trigger match first, got ${refs.join(",")}`);
});

test("rank priors: recorded intent outranks code symbols that merely share the query's vocabulary", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // A "why" question whose term appears in BOTH a decision and many code symbols.
  // Before the memory-record prior, the symbols filled the whole top-k on the real
  // graph and buried the one live decision (bench/golden-retrieval.json: 70% -> 80%).
  const SYM = (id: string, name: string, file: string) => ({
    id, file, name, kind: "function", signature_hash: "sha1:test",
    calls: [], called_by: [],
    metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "commit:test",
  });
  for (let i = 0; i < 12; i++) {
    store.json.put("symbols", SYM(`sym_${i}`, `quibbleflange${i}`, `src/q${i}.ts`) as never);
  }
  store.json.put("decisions", DEC({
    id: "dec_intent", title: "Quibbleflange batching is deliberate",
    decision: "Quibbleflange batches writes to survive an interrupted run.",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("quibbleflange", 5)).map((h) => h.ref);
  // The prior is a BOUNDED tie-break, not a filter: a symbol whose name is a near-exact
  // lexical match may still lead. What must hold is that the decision is not buried
  // beneath a wall of same-vocabulary symbols the way it was before.
  assert.ok(refs.includes("dec_intent"), `the decision must reach the top-5, got ${refs.join(",")}`);
});

test("rank priors: the memory prior re-ranks WITHOUT excluding code symbols", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // The tie-break must never turn into a filter: a symbol-shaped query still returns
  // symbols, otherwise `hunch_structure`-style lookups would regress.
  const SYM = (id: string, name: string, file: string) => ({
    id, file, name, kind: "function", signature_hash: "sha1:test",
    calls: [], called_by: [],
    metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "commit:test",
  });
  store.json.put("symbols", SYM("sym_only", "wobblesprocket", "src/w.ts") as never);
  store.reindex();
  const refs = (await store.hybridSearch("wobblesprocket", 5)).map((h) => h.ref);
  assert.ok(refs.includes("sym_only"), `symbols stay reachable, got ${refs.join(",")}`);
});

test("rank priors: a small addition of sibling functions does not bury already-retrievable intent", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const symbol = (i: number) => ({
    id: `sym_growth_${i}`, file: `src/q${i}.ts`, name: `quibbleflange${i}`, kind: "function",
    signature_hash: "sha1:test", calls: [], called_by: [],
    metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 }, last_changed: "commit:test",
  });
  for (let i = 0; i < 16; i++) store.json.put("symbols", symbol(i) as never);
  store.json.put("decisions", DEC({
    id: "dec_growth_intent", title: "Quibbleflange batching is deliberate",
    decision: "Quibbleflange batches writes to survive an interrupted run.",
    date: "2000-01-01T00:00:00Z", valid_from: "2000-01-01T00:00:00Z",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  }) as never);
  store.reindex();
  assert.ok((await store.hybridSearch("quibbleflange", 10)).some(h => h.ref === "dec_growth_intent"));
  for (let i = 16; i < 20; i++) store.json.put("symbols", symbol(i) as never);
  store.reindex();
  const refs = (await store.hybridSearch("quibbleflange", 10)).map(h => h.ref);
  assert.ok(refs.includes("dec_growth_intent"), `intent survives four sibling additions: ${refs.join(",")}`);
  assert.ok((await store.hybridSearch("quibbleflange19", 10)).some(h => h.ref === "sym_growth_19"), "exact symbol remains reachable");
});

test("rank priors: a changed decision anchor dims after HEAD advances while the exact record stays visible", (t) => {
  const { store, cleanup } = tempStore();
  const codeRoot = mkdtempSync(join(tmpdir(), "hunch-freshness-code-"));
  t.after(cleanup);
  t.after(() => cleanupDir(codeRoot));
  git(codeRoot, ["init", "--initial-branch=main"]);
  mkdirSync(join(codeRoot, "src"), { recursive: true });
  writeFileSync(join(codeRoot, "src", "stale.ts"), "export const stale = 1;\n");
  writeFileSync(join(codeRoot, "src", "fresh.ts"), "export const fresh = 1;\n");
  git(codeRoot, ["add", "src"]);
  git(codeRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], "2026-01-01T00:00:00Z");

  const verified = "2026-02-01T00:00:00Z";
  const provenance = { source: "human_confirmed", confidence: 1, evidence: [], last_verified: verified };
  store.json.put("decisions", DEC({
    id: "dec_z_fresh", title: "Nimblecache batching policy", decision: "Nimblecache batches writes.",
    related_files: ["src/fresh.ts"], provenance,
  }) as never);
  store.json.put("decisions", DEC({
    id: "dec_a_stale", title: "Nimblecache batching policy", decision: "Nimblecache batches writes.",
    related_files: ["src/stale.ts"], provenance,
  }) as never);
  store.reindex();

  const lexical = store.search("nimblecache batching", 5).map((hit) => hit.ref);
  assert.ok(lexical.indexOf("dec_a_stale") < lexical.indexOf("dec_z_fresh"), `fixture starts with the stale candidate first: ${lexical.join(",")}`);
  const before = store.rankedSearch("nimblecache batching", 5, { freshnessRoot: codeRoot }).map((hit) => hit.ref);
  assert.ok(before.indexOf("dec_a_stale") < before.indexOf("dec_z_fresh"), `equal-currentness ties preserve fused order: ${before.join(",")}`);

  writeFileSync(join(codeRoot, "src", "stale.ts"), "export const stale = 2;\n");
  git(codeRoot, ["add", "src/stale.ts"]);
  git(codeRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "change stale anchor"], "2026-03-01T00:00:00Z");

  const changed = scopedLastChangeDates(["src/stale.ts", "src/fresh.ts"], codeRoot);
  assert.equal(Date.parse(changed?.get("src/stale.ts") ?? ""), Date.parse("2026-03-01T00:00:00Z"));
  assert.equal(Date.parse(changed?.get("src/fresh.ts") ?? ""), Date.parse("2026-01-01T00:00:00Z"));
  const after = store.rankedSearch("nimblecache batching", 5, { freshnessRoot: codeRoot }).map((hit) => hit.ref);
  assert.ok(after.indexOf("dec_z_fresh") < after.indexOf("dec_a_stale"), `fresh anchor must outrank changed anchor: ${after.join(",")}`);
  assert.ok(after.includes("dec_a_stale"), "staleness dims the decision but never withholds it");
});

test("rank priors: missing freshness clocks remain neutral rather than guessed stale", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  git(root, ["init", "--initial-branch=main"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "unknown.ts"), "export const value = 1;\n");
  git(root, ["add", "src/unknown.ts"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base"], "2026-03-01T00:00:00Z");
  store.json.put("decisions", DEC({
    id: "dec_unknown", title: "Quasarqueue policy", decision: "Quasarqueue is bounded.",
    related_files: ["src/unknown.ts"], provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  }) as never);
  store.json.put("decisions", DEC({
    id: "dec_peer", title: "Quasarqueue policy", decision: "Quasarqueue is bounded.",
    related_files: [], provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  }) as never);
  store.reindex();
  const lexical = store.search("quasarqueue policy", 5).map((hit) => hit.ref);
  const refs = store.rankedSearch("quasarqueue policy", 5).map((hit) => hit.ref);
  assert.deepEqual(refs, lexical, "unknown freshness stays neutral and preserves lexical order");
});

test("rank priors: a superseded decision never outranks its live successor when neither is human-confirmed", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // Both records are months old and extracted, so provenance × recency alone saturates
  // the trust clamp for BOTH; the old one is also the stronger lexical match. Liveness
  // must still decide which answers "what is the rule now".
  store.json.put("decisions", DEC({ id: "dec_old", title: "Wuzzlecache stores sessions in Redis", decision: "Wuzzlecache sessions live in Redis. Wuzzlecache sessions expire after twelve hours.", status: "superseded", superseded_by: "dec_new", valid_to: "2026-03-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", title: "Sessions moved to Postgres", decision: "Wuzzlecache sessions now live in Postgres.", supersedes: "dec_old", valid_from: "2026-03-01T00:00:00Z", date: "2026-03-01T00:00:00Z" }) as never);
  store.reindex();
  for (const q of ["wuzzlecache sessions", "where are wuzzlecache sessions stored"]) {
    const refs = (await store.hybridSearch(q, 5)).map((h) => h.ref);
    assert.equal(refs[0], "dec_new", `live successor first for "${q}", got ${refs.join(",")}`);
    assert.ok(refs.includes("dec_old"), "history stays in the result");
  }
});

test("rank priors: a superseded record sinks below a live record of a different subject that fused just behind it", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_dead", title: "Frobnik deploy host keeps secrets in dotenv", decision: "Frobnik production secrets sit in dotenv files on the frobnik deploy host.", status: "superseded", valid_to: "2026-03-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_live", title: "Frobnik deploys daily", decision: "Frobnik production deploys run every weekday.", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.reindex();
  const lexical = store.search("frobnik production deploy host", 5).map((h) => h.ref);
  assert.equal(lexical[0], "dec_dead", `precondition: the dead record is the top lexical hit, got ${lexical.join(",")}`);
  const refs = (await store.hybridSearch("frobnik production deploy host", 5)).map((h) => h.ref);
  assert.deepEqual(refs.slice(0, 2), ["dec_live", "dec_dead"], `live first, dead dimmed but present, got ${refs.join(",")}`);
});

test("rank priors: a weakly matching successor already in the pool takes its predecessor's slot", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // The successor uses new vocabulary and shares only one weak term with the query, so it
  // enters the pool far behind the stale record and unrelated noise; promotion used to
  // skip it because it was "already present".
  store.json.put("decisions", DEC({ id: "dec_old", topic: "glorp.pagination", title: "Glorp orders API paginates with offset and limit", decision: "Glorp orders API paginates with offset and limit query parameters.", status: "superseded", superseded_by: "dec_new", valid_to: "2026-03-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  for (let i = 0; i < 6; i++) {
    store.json.put("decisions", DEC({ id: `dec_noise${i}`, title: `Glorp orders noise ${i}`, decision: `Glorp orders API note ${i}.`, valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  }
  store.json.put("decisions", DEC({ id: "dec_new", topic: "glorp.pagination", title: "Listing endpoints hand back a continuation token", decision: "Clients pass the opaque token to fetch the next batch of glorp results.", supersedes: "dec_old", valid_from: "2026-03-01T00:00:00Z", date: "2026-03-01T00:00:00Z" }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("how does glorp orders API paginate", 10)).map((h) => h.ref);
  assert.ok(refs.includes("dec_new") && refs.includes("dec_old"), `both present, got ${refs.join(",")}`);
  const lexical = store.search("how does glorp orders API paginate", 10).map((h) => h.ref);
  assert.equal(lexical[0], "dec_old", `precondition: the stale record is the top lexical hit, got ${lexical.join(",")}`);
  assert.ok(lexical.indexOf("dec_new") > 1, `precondition: the successor enters the pool behind noise, got ${lexical.join(",")}`);
  assert.equal(refs[0], "dec_new", `successor takes the slot its predecessor earned, got ${refs.join(",")}`);
});

test("rank priors: an explicit supersede chain without a topic still injects the live end", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_a", title: "Quibbleshard logs through winston", decision: "Quibbleshard uses winston.", status: "superseded", superseded_by: "dec_b", valid_to: "2026-02-01T00:00:00Z", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_b", title: "Logging moved to bunyan", decision: "bunyan.", status: "superseded", supersedes: "dec_a", superseded_by: "dec_c", valid_to: "2026-03-01T00:00:00Z", valid_from: "2026-02-01T00:00:00Z", date: "2026-02-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_c", title: "Logging moved to pino", decision: "pino.", supersedes: "dec_b", valid_from: "2026-03-01T00:00:00Z", date: "2026-03-01T00:00:00Z" }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("quibbleshard", 5)).map((h) => h.ref);
  assert.equal(refs[0], "dec_c", `the chain's live end leads, got ${refs.join(",")}`);
  assert.ok(refs.includes("dec_a"), "the matched history stays");
});

test("format: a non-accepted decision hit names its status and successor", () => {
  const hit = { ref: "dec_old", kind: "decisions", title: "T", snippet: "s", score: 0 };
  assert.equal(formatSearchHit(hit, { id: "dec_old", status: "superseded", superseded_by: "dec_new" }), "• [decisions · superseded → dec_new] dec_old — T\n    s");
  assert.equal(formatSearchHit(hit, { id: "dec_old", status: "rejected", superseded_by: null }), "• [decisions · rejected] dec_old — T\n    s");
  assert.equal(formatSearchHit(hit, { id: "dec_old", status: "accepted", superseded_by: null }), "• [decisions] dec_old — T\n    s");
  assert.equal(formatSearchHit(hit, { id: "dec_old", status: "accepted", superseded_by: null, valid_to: "2026-03-01T00:00:00Z" }), "• [decisions · closed 2026-03-01] dec_old — T\n    s");
});

test("rank priors: an injected successor never borrows its predecessor's trust to jump an exact live match", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const human = { source: "human_confirmed", confidence: 1, evidence: [] };
  const draft = { source: "llm_draft", confidence: 0.8, evidence: [] };
  store.json.put("decisions", DEC({ id: "dec_L", title: "Grumble retry budget is three", decision: "Grumble retry budget is three attempts.", provenance: draft, valid_from: "2025-06-01T00:00:00Z", date: "2025-06-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_S", title: "Grumble logging level", decision: "Grumble logs at debug.", status: "superseded", superseded_by: "dec_C", provenance: human }) as never);
  store.json.put("decisions", DEC({ id: "dec_C", title: "Logging level is info", decision: "Info only.", supersedes: "dec_S", provenance: draft }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("grumble retry budget", 8)).map((h) => h.ref);
  assert.equal(refs[0], "dec_L", `the exact live match keeps the top slot, got ${refs.join(",")}`);
  assert.ok(refs.indexOf("dec_C") < refs.indexOf("dec_S"), "the successor still outranks its own predecessor");
});

test("rank priors: a topic-anchored predecessor whose successor was recorded without a topic falls back to the chain", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old", topic: "snorf.api", title: "Snorfgate returns XML", decision: "Snorfgate speaks XML.", status: "superseded", superseded_by: "dec_new", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", title: "Endpoint speaks JSON now", decision: "JSON only.", supersedes: "dec_old" }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("snorfgate", 5)).map((h) => h.ref);
  assert.ok(refs.includes("dec_new"), `successor reached through superseded_by, got ${refs.join(",")}`);
  assert.ok(refs.indexOf("dec_new") < refs.indexOf("dec_old"), "and it outranks the stale hit");
});

test("rank priors: a proposed draft at the end of a chain is not injected as the current successor", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old", title: "Plinkbox uses winston", decision: "Plinkbox logs via winston.", status: "superseded", superseded_by: "dec_new", valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z" }) as never);
  store.json.put("decisions", DEC({ id: "dec_new", title: "Maybe pino", decision: "pino?", status: "proposed", supersedes: "dec_old" }) as never);
  store.reindex();
  const refs = (await store.hybridSearch("plinkbox", 5)).map((h) => h.ref);
  assert.ok(!refs.includes("dec_new"), `a draft is not the current rule, got ${refs.join(",")}`);
});

test("rank priors: a dead record never leapfrogs a live record that fused ahead of it, however fresh or trusted", async (t) => {
  const human = { source: "human_confirmed", confidence: 1, evidence: [] };
  const fresh = new Date().toISOString();
  for (const extra of [{ status: "rejected" }, { status: "superseded", superseded_by: "dec_C" }]) {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    store.json.put("decisions", DEC({ id: "dec_L", title: "Grumble retry budget is three", decision: "Grumble retry budget is three attempts.", provenance: human, valid_from: "2025-06-01T00:00:00Z", date: "2025-06-01T00:00:00Z" }) as never);
    store.json.put("decisions", DEC({ id: "dec_S", title: "Grumble logging level", decision: "Grumble logs at debug.", provenance: human, valid_from: fresh, date: fresh, ...extra }) as never);
    // The successor shares no query term and is as trusted and fresh as it gets.
    store.json.put("decisions", DEC({ id: "dec_C", title: "Logging level is info", decision: "Info only.", supersedes: "dec_S", provenance: human, valid_from: fresh, date: fresh }) as never);
    store.reindex();
    const refs = (await store.hybridSearch("grumble retry budget", 8)).map((h) => h.ref);
    assert.equal(refs[0], "dec_L", `${extra.status}: the standing exact match stays first, got ${refs.join(",")}`);
    if (refs.includes("dec_C")) assert.ok(refs.indexOf("dec_C") < refs.indexOf("dec_S"), "a successor still outranks its predecessor");
  }
});

test("rank priors: code symbols fused ahead of a superseded decision do not pin its successor behind them", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  // The successor's floor is a MATCH bound, not a kind bound: a symbol carries no memory
  // shift, so comparing raw positions across kinds once parked the live successor one
  // notch above its dead predecessor — behind the code and behind a live record the
  // predecessor outranked.
  const SYM = (id: string, name: string, file: string) => ({
    id, file, name, kind: "function", signature_hash: "sha1:test",
    calls: [], called_by: [],
    metrics: { loc: 1, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 0 },
    last_changed: "commit:test",
  });
  for (let i = 0; i < 12; i++) store.json.put("symbols", SYM(`sym_${i}`, "zibblewort", `src/z${i}.ts`) as never);
  const human = { source: "human_confirmed", confidence: 1, evidence: [] };
  store.json.put("decisions", DEC({ id: "dec_P", topic: "zibblewort.sessions", title: "Session storage for the zibblewort service lives in Redis", decision: "Session rows for the zibblewort service are stored in Redis with a twelve hour expiry.", status: "superseded", superseded_by: "dec_C", provenance: human }) as never);
  store.json.put("decisions", DEC({ id: "dec_C", topic: "zibblewort.sessions", title: "Moved to Postgres", decision: "Stored in Postgres now.", supersedes: "dec_P", provenance: human }) as never);
  store.json.put("decisions", DEC({ id: "dec_R", title: "Deploy cadence for the zibblewort service", decision: "The zibblewort service deploys every weekday morning after the smoke suite.", provenance: human }) as never);
  store.reindex();
  const lexical = store.search("zibblewort", 24).map((h) => h.ref);
  assert.ok(lexical.indexOf("sym_0") < lexical.indexOf("dec_P"), `precondition: code fuses ahead of the predecessor, got ${lexical.join(",")}`);
  const refs = (await store.hybridSearch("zibblewort", 8)).map((h) => h.ref);
  const firstSym = refs.findIndex((r) => r.startsWith("sym_"));
  assert.ok(refs.indexOf("dec_C") >= 0 && refs.indexOf("dec_C") < firstSym, `the live successor ranks with recorded intent, not behind code, got ${refs.join(",")}`);
  assert.ok(refs.indexOf("dec_C") < refs.indexOf("dec_P"), "and above its predecessor");
});

test("rank priors: a dead record fused ahead of a superseded decision does not shield its successor", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_D", title: "Wobblecrank wobblecrank cache uses memcached", decision: "Wobblecrank wobblecrank caches in memcached.", status: "rejected" }) as never);
  store.json.put("decisions", DEC({ id: "dec_P", topic: "wobblecrank.cache", title: "Wobblecrank cache uses Redis", decision: "Wobblecrank caches in Redis.", status: "superseded", superseded_by: "dec_C" }) as never);
  store.json.put("decisions", DEC({ id: "dec_C", topic: "wobblecrank.cache", title: "In-process LRU now", decision: "LRU only.", supersedes: "dec_P" }) as never);
  store.reindex();
  const lexical = store.search("wobblecrank cache", 5).map((h) => h.ref);
  assert.deepEqual(lexical.slice(0, 2), ["dec_D", "dec_P"], `precondition: the rejected record fuses first, got ${lexical.join(",")}`);
  const refs = (await store.hybridSearch("wobblecrank cache", 5)).map((h) => h.ref);
  assert.equal(refs[0], "dec_C", `the one live answer leads over closed history, got ${refs.join(",")}`);
});

test("rank priors: a chain end that is one side of its own topic's collision is not injected as current", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_A", topic: "flimbo.queue", title: "Flimbo queue runs on RabbitMQ", decision: "Flimbo queues through RabbitMQ.", status: "superseded", superseded_by: "dec_B" }) as never);
  store.json.put("decisions", DEC({ id: "dec_B", topic: "transport.broker", title: "Broker is Kafka", decision: "Kafka.", supersedes: "dec_A" }) as never);
  store.json.put("decisions", DEC({ id: "dec_C", topic: "transport.broker", title: "Broker is NATS", decision: "NATS." }) as never);
  store.reindex();
  const hits = await store.hybridSearch("flimbo queue", 5);
  assert.ok(!hits.some((h) => h.ref === "dec_B" || h.ref === "dec_C"), `an unresolved collision has no single current answer, got ${hits.map((h) => h.ref).join(",")}`);
  // Resolve the collision: the chain end is now injected, and labelled by how it was found.
  store.json.put("decisions", DEC({ id: "dec_C", topic: "transport.broker", title: "Broker is NATS", decision: "NATS.", status: "rejected" }) as never);
  store.reindex();
  const after = await store.hybridSearch("flimbo queue", 5);
  const b = after.find((h) => h.ref === "dec_B");
  assert.ok(b, `chain end injected once its topic has one live answer, got ${after.map((h) => h.ref).join(",")}`);
  assert.equal(b.snippet, "live end of the supersede chain from dec_A");
});
