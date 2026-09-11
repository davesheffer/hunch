import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedLastChangeDates } from "../src/extractors/git.js";
import { tempStore, prov } from "./helpers.js";

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
  t.after(() => rmSync(codeRoot, { recursive: true, force: true }));
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
