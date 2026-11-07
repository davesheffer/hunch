/**
 * `hunch ui` Deliberate: what in memory deserves a person's judgment. False cards burn trust, so
 * each guard here pins a card that must NOT appear, most of them taken from the real store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComponentSchema, DecisionSchema, EdgeSchema, FindingSchema, type Decision } from "../src/core/types.js";
import type { DriftFinding } from "../src/core/drift.js";
import { pathsAliveInRepo } from "../src/extractors/git.js";
import { normalizeTitle, reviewCards, type Review, type ReviewCard, type ReviewKind } from "../src/ui/review.js";
import type { MemorySource } from "../src/ui/model.js";
import { mkConstraint, prov } from "./helpers.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";

const now = "2026-11-04T00:00:00Z";
const human = { source: "human_confirmed", confidence: 0.95 };
const agent = { source: "agent_recorded", confidence: 0.75 };
const inferred = { source: "inferred", confidence: 0.3 };

function dec(id: string, over: Record<string, unknown> & { provenance?: Record<string, unknown> }): Decision {
  const { provenance, ...rest } = over;
  return DecisionSchema.parse({ id, title: id, status: "accepted", decision: `${id} text`, context: `${id} because`, date: "2026-09-01", ...rest, provenance: { ...prov(), ...agent, ...provenance } });
}

const empty = (over: Partial<MemorySource>): MemorySource => ({ decisions: [], constraints: [], bugs: [], findings: [], components: [], ...over });
const allAlive = (paths: readonly string[]): ReadonlySet<string> => new Set(paths);
const noneAlive = (): ReadonlySet<string> => new Set<string>();

function review(src: MemorySource, drift: DriftFinding[] = [], alive: (paths: readonly string[]) => ReadonlySet<string> = allAlive, edges: Parameters<typeof reviewCards>[1] = []): Review {
  return reviewCards(src, edges, { drift, alive });
}
const cards = (r: Review, kind: ReviewKind): ReviewCard[] => r.groups.find((g) => g.kind === kind)!.cards;
const files = ["src/a.ts"];

test("title: a commit prefix and a PR number say nothing about the choice", () => {
  assert.equal(normalizeTitle("fix(mcp): Compare as JSON (#460)"), "compare as json");
  assert.equal(normalizeTitle("feat!: Drop it"), "drop it");
  assert.equal(normalizeTitle("Full audit: eight"), "full audit: eight", "a label with a space is part of the title");
});

test("duplicate: equal titles with shared files are one memory; the signed one stays", () => {
  const r = review(empty({ decisions: [
    dec("dec_b", { title: "fix(x): keep the token", related_files: files, provenance: human, date: "2026-10-01" }),
    dec("dec_a", { title: "Keep the token (#12)", related_files: [...files, "src/b.ts"], date: "2026-01-01" }),
  ] }));
  const [card] = cards(r, "duplicate");
  assert.equal(card!.recommend, "merge");
  assert.deepEqual(card!.records.map((m) => m.id), ["dec_b", "dec_a"]);
  assert.deepEqual(card!.actions.merge, { survivor: "dec_b", duplicate: "dec_a", reason: "Duplicate of dec_b: fix(x): keep the token", supersededBy: null, addFiles: ["src/b.ts"], addComponents: [], feature: null, leftBehind: [], oneWay: false });
});

test("duplicate: confidence, then the older record, then the lower id decide who stays", () => {
  const stays = (a: Record<string, unknown>, b: Record<string, unknown>): string => cards(review(empty({ decisions: [
    dec("dec_x", { title: "Same words here", related_files: files, ...a }), dec("dec_y", { title: "Same words here", related_files: files, ...b }),
  ] })), "duplicate")[0]!.actions.merge!.survivor;
  assert.equal(stays({ provenance: { confidence: 0.3 } }, { provenance: { confidence: 0.9 } }), "dec_y");
  assert.equal(stays({ date: "2026-05-01" }, { date: "2026-01-01" }), "dec_y");
  assert.equal(stays({}, {}), "dec_x");
});

test("duplicate guard: an equal title with no shared files is not one memory", () => {
  // The real shape: a record carrying another commit's message on that commit's files.
  const r = review(empty({ decisions: [
    dec("dec_a", { title: "fix: degrade on bad data", related_files: ["src/cli/index.ts"] }),
    dec("dec_b", { title: "fix: degrade on bad data", related_files: ["src/core/review.ts"] }),
  ] }));
  assert.equal(cards(r, "duplicate").length, 0);
});

test("duplicate guard: 'never' and 'not' change the meaning, though dupTerms drops them", () => {
  const r = review(empty({ decisions: [
    dec("dec_a", { title: "Readers must retry publish windows forever", related_files: files }),
    dec("dec_b", { title: "Readers must never retry publish windows forever", related_files: files }),
  ] }));
  assert.equal(cards(r, "duplicate").length, 0);
});

test("duplicate guard: different numbers are different things, though dupTerms drops digits", () => {
  const titles = (a: string, b: string): number => cards(review(empty({ decisions: [
    dec("dec_a", { title: a, related_files: files }), dec("dec_b", { title: b, related_files: files }),
  ] })), "duplicate").length;
  assert.equal(titles("release 1.40.1 changelog locale notes", "release 1.41.0 changelog locale notes"), 0);
  assert.equal(titles("Gate 0/5 live measurement notes", "Gate 1/5 live measurement notes"), 0);
  assert.equal(titles("Release changelog locale notes (#1)", "Release changelog locale notes (#2)"), 1, "a PR number is not a difference");
});

test("duplicate guard: a record and what it replaced are history, not duplicates", () => {
  const r = review(empty({ decisions: [
    dec("dec_new", { title: "Same words here", supersedes: "dec_old", related_files: files }),
    dec("dec_old", { title: "Same words here", superseded_by: "dec_new", status: "proposed", related_files: files }),
  ] }));
  assert.equal(cards(r, "duplicate").length, 0);
});

test("duplicate guard: two decisions with topics answer their own questions", () => {
  const r = review(empty({ decisions: [
    dec("dec_a", { title: "Same words here", topic: "one", related_files: files }), dec("dec_b", { title: "Same words here", topic: "two", related_files: files }),
  ] }));
  assert.equal(cards(r, "duplicate").length, 0);
});

test("duplicate guard: kinds are never paired, and a bug can't be merged away", () => {
  const r = review(empty({
    decisions: [dec("dec_a", { title: "Same words here", related_files: files })],
    findings: [FindingSchema.parse({ id: "fnd_a", title: "Same words here", observation: "o", affected_files: files, observed_at: now, provenance: prov() })],
  }));
  assert.equal(cards(r, "duplicate").length, 0);
});

test("duplicate: a commit-template body is no evidence, only the words a person chose", () => {
  const template = "Changed code in src/core (1 file(s)).";
  const r = review(empty({ decisions: [
    dec("dec_a", { title: "Alpha things happen", decision: template, related_files: files, provenance: inferred }),
    dec("dec_b", { title: "Totally different subject", decision: template, related_files: files, provenance: inferred }),
  ] }));
  assert.equal(cards(r, "duplicate").length, 0);
});

test("duplicate: greedy, so a cluster of three shows one pair and the third waits", () => {
  const r = review(empty({ decisions: ["dec_a", "dec_b", "dec_c"].map((id) => dec(id, { title: "Same words here", related_files: files })) }));
  const [card, ...rest] = cards(r, "duplicate");
  assert.deepEqual(card!.records.map((m) => m.id), ["dec_a", "dec_b"]);
  assert.equal(rest.length, 0);
  const seen = r.groups.flatMap((g) => g.cards.flatMap((c) => c.records.map((m) => m.id)));
  assert.equal(new Set(seen).size, seen.length, "each record appears in one card");
});

test("conflict: two live decisions on a topic, kept apart from duplicates and weak", () => {
  const r = review(empty({ decisions: [
    dec("dec_a", { title: "Same words here", topic: "auth", related_files: files, provenance: human }),
    dec("dec_b", { title: "Same words here", topic: "auth", related_files: files, provenance: inferred }),
  ] }));
  const [card] = cards(r, "conflict");
  assert.match(card!.claim, /2 live decisions answer "auth"/);
  assert.equal(card!.recommend, null, "which answer is right is the person's call");
  assert.equal(card!.actions.merge!.survivor, "dec_a");
  assert.equal(r.total, 1);
});

const stillInForce = (id: string, target: string): DriftFinding => ({ kind: "supersede", id, detail: `supersedes "${target}", but it is still in force` });

test("conflict: a replaced decision that is still live goes when both are unconfirmed", () => {
  const src = empty({ decisions: [dec("dec_new", { supersedes: "dec_old" }), dec("dec_old", {})] });
  const [card] = cards(review(src, [stillInForce("dec_new", "dec_old")]), "conflict");
  assert.equal(card!.recommend, "remove");
  assert.deepEqual(card!.records.map((m) => m.id), ["dec_new", "dec_old"]);
  assert.equal(card!.actions.merge!.duplicate, "dec_old");
  assert.equal(card!.actions.swap!.duplicate, "dec_new", "the person can keep the older one instead");
  assert.deepEqual(card!.evidence, ["dec_new says it replaces dec_old, which is still accepted."]);
});

test("record: a commit message's sign-offs aren't part of its why", () => {
  const r = review(empty({ decisions: [dec("dec_a", { context: "Readers wait out a publish.\n\nCo-Authored-By: Someone <s@example.com>", provenance: { source: "llm_draft", confidence: 0.4 } })] }));
  assert.equal(cards(r, "weak")[0]!.records[0]!.why, "Readers wait out a publish.");
});

test("duplicate: either record can be the one that stays, and the plan follows", () => {
  const r = review(empty({ decisions: [
    dec("dec_a", { title: "Same words here", related_files: ["src/a.ts"], date: "2026-01-01" }),
    dec("dec_b", { title: "Same words here", related_files: ["src/a.ts", "src/b.ts"], date: "2026-02-01" }),
  ] }));
  const { merge, swap } = cards(r, "duplicate")[0]!.actions;
  assert.deepEqual([merge!.survivor, merge!.addFiles], ["dec_a", ["src/b.ts"]]);
  assert.deepEqual([swap!.survivor, swap!.addFiles, swap!.reason], ["dec_b", [], "Duplicate of dec_b: Same words here"]);
});

test("conflict guard: an unconfirmed claim never gets a one-click win over a person's decision", () => {
  const src = empty({ decisions: [dec("dec_new", { supersedes: "dec_old" }), dec("dec_old", { provenance: human })] });
  const [card] = cards(review(src, [stillInForce("dec_new", "dec_old")]), "conflict");
  assert.equal(card!.recommend, null);
  assert.ok(card!.evidence.some((e) => /dec_old is confirmed by a person/.test(e)));
});

test("conflict guard: a self-supersede has no verb to clear it, so no card", () => {
  const src = empty({ decisions: [dec("dec_self", { supersedes: "dec_self" })] });
  assert.equal(cards(review(src, [stillInForce("dec_self", "dec_self")]), "conflict").length, 0);
});

const deadRef = (id: string, path: string): DriftFinding => ({ kind: "dead-ref", id, detail: `references missing file "${path}"`, path });

test("stale guard: a file another branch or a gitignore still has is not gone", () => {
  const src = empty({ decisions: [dec("dec_a", { related_files: ["src/elsewhere.ts"] })] });
  const r = review(src, [deadRef("dec_a", "src/elsewhere.ts")], allAlive);
  assert.equal(cards(r, "stale").length, 0);
});

test("stale: a commit nobody explained, with every link gone, can go", () => {
  const src = empty({ decisions: [dec("dec_a", { related_files: files, decision: "Changed code in src (1 file(s)).", context: "Touched 1 file(s) across src.", provenance: inferred })] });
  const [card] = cards(review(src, [deadRef("dec_a", "src/a.ts")], noneAlive), "stale");
  assert.equal(card!.recommend, "remove");
  assert.deepEqual(card!.records[0]!.missing, ["src/a.ts"]);
  assert.ok(card!.evidence.includes("On no branch: src/a.ts"));
  assert.ok(card!.evidence.some((e) => /Written from a commit/.test(e)), "stale keeps what made it weak");
  assert.equal(cards(review(src, [deadRef("dec_a", "src/a.ts")], noneAlive), "weak").length, 0, "a record appears in one card");
});

test("stale guard: a dead link doesn't sink a decision with a real why", () => {
  const src = empty({ decisions: [dec("dec_a", { related_files: files })] });
  const [card] = cards(review(src, [deadRef("dec_a", "src/a.ts")], noneAlive), "stale");
  assert.equal(card!.recommend, null);
  assert.equal(card!.actions.remove, true, "the person can still remove it");
});

test("stale: some links gone means drop them, signed or not", () => {
  const src = empty({ decisions: [dec("dec_a", { related_files: ["src/a.ts", "src/b.ts"], provenance: human })] });
  const [card] = cards(review(src, [deadRef("dec_a", "src/a.ts")], noneAlive), "stale");
  assert.equal(card!.recommend, "drop-links");
  assert.deepEqual(card!.actions.dropLinks, ["src/a.ts"]);
  assert.match(card!.claim, /1 of 2 linked paths is gone/);
});

test("stale: an observation whose every anchor is gone can go, unless a person confirmed it", () => {
  const finding = (provenance: Record<string, unknown>): MemorySource => empty({ findings: [FindingSchema.parse({ id: "fnd_a", title: "Seen", observation: "o", affected_files: files, observed_at: now, provenance: { ...prov(), ...provenance } })] });
  const drift: DriftFinding = { kind: "finding-stale", id: "fnd_a", detail: "gone", path: "src/a.ts" };
  assert.equal(cards(review(finding(agent), [drift], noneAlive), "stale")[0]!.recommend, "remove");
  assert.equal(cards(review(finding(human), [drift], noneAlive), "stale")[0]!.recommend, null);
});

test("stale: a dead premise has no one-click verdict", () => {
  const src = empty({ decisions: [dec("dec_a", { related_files: files })] });
  const [card] = cards(review(src, [{ kind: "premise-stale", id: "dec_a", detail: 'premise "X" no longer holds — gone. Re-attest, supersede, or retire; authority unchanged.' }]), "stale");
  assert.equal(card!.recommend, null);
  assert.deepEqual(card!.evidence, ['premise "X" no longer holds — gone']);
  assert.match(card!.claim, /rests on no longer holds/);
});

test("stale: a rule whose scope is gone can't lose its last entry, and a live glob base is fine", () => {
  const r = review(empty({ constraints: [
    mkConstraint({ id: "con_all", statement: "All gone", scope: ["old/**"] }),
    mkConstraint({ id: "con_some", statement: "Some gone", scope: ["old/**", "src/**"] }),
    mkConstraint({ id: "con_live", statement: "Alive", scope: ["src/**"] }),
    mkConstraint({ id: "con_private", statement: "Elsewhere", scope: ["private:notes/**"] }),
    mkConstraint({ id: "con_repo", statement: "Whole repo", scope: ["**"] }),
  ] }), [], (paths) => new Set(paths.filter((p) => p === "src")));
  const stale = Object.fromEntries(cards(r, "stale").map((c) => [c.records[0]!.id, c]));
  assert.deepEqual(Object.keys(stale).sort(), ["con_all", "con_some"]);
  assert.equal(stale.con_all!.recommend, null);
  assert.deepEqual(stale.con_all!.actions.dropLinks, []);
  assert.equal(stale.con_some!.recommend, "drop-links");
  assert.deepEqual(stale.con_some!.actions.dropLinks, ["old/**"]);
});

test("weak: all three signals can go; a commit with a real message gets its wording fixed", () => {
  const r = review(empty({ decisions: [
    dec("dec_junk", { decision: "Changed code in src (1 file(s)).", context: "Touched 1 file(s) across src.", provenance: inferred }),
    dec("dec_msg", { decision: "Introduced src/a: added foo.", context: "Because readers wait out a publish.", provenance: inferred }),
    dec("dec_low", { provenance: { source: "llm_draft", confidence: 0.4 } }),
    dec("dec_ok", { decision: "We chose cookies", context: "Stateless." }),
  ] }));
  const weak = Object.fromEntries(cards(r, "weak").map((c) => [c.records[0]!.id, c]));
  assert.deepEqual(Object.keys(weak).sort(), ["dec_junk", "dec_low", "dec_msg"]);
  assert.equal(weak.dec_junk!.recommend, "remove");
  assert.match(weak.dec_junk!.claim, /Nobody said why/);
  assert.equal(weak.dec_msg!.recommend, "fix-wording");
  assert.match(weak.dec_msg!.claim, /Written from a commit, not by a person/);
  assert.equal(weak.dec_low!.recommend, "fix-wording");
  assert.ok(weak.dec_junk!.evidence.some((e) => e.includes('"Changed code in src (1 file(s))."')), "evidence quotes the actual text");
  assert.equal(weak.dec_junk!.actions.keep, "confirm");
});

test("weak guard: signed records and imported ADRs are never weak, and text an edit hit isn't a template", () => {
  const r = review(empty({ decisions: [
    dec("dec_signed", { decision: "Changed code in src (1 file(s)).", context: "Touched 1 file(s) across src.", provenance: { source: "human_confirmed", confidence: 0.3 } }),
    dec("dec_adr", { context: "", provenance: { source: "imported:madr", confidence: 0.3 } }),
    dec("dec_edited", { decision: "Changed code in src (1 file(s)).", context: "We picked this on purpose.", provenance: { source: "human_edited", confidence: 0.9 } }),
  ] }));
  assert.deepEqual(cards(r, "weak").map((c) => c.records[0]!.id), []);
});

test("weak: a rule with a template why offers review, never the one-click confirm", () => {
  const r = review(empty({ constraints: [mkConstraint({ id: "con_a", statement: "Rule", rationale: "", provenance: { ...prov(), source: "llm_draft", confidence: 0.4 } })] }));
  const [card] = cards(r, "weak");
  assert.equal(card!.actions.keep, "review-rule");
});

test("reach: the same walk as the Brain trace, over a cycle, not counting the record's own", () => {
  const component = (id: string, paths: string[]) => ComponentSchema.parse({ id, kind: "module", name: id, paths, provenance: prov(), created_at: now, updated_at: now });
  const edge = (from: string, to: string) => EdgeSchema.parse({ id: `edge_${from}_${to}`, from, to, type: "depends_on", provenance: prov() });
  const src = empty({
    components: [component("cmp_a", ["src/a/**"]), component("cmp_b", ["src/b/**"]), component("cmp_c", ["src/c/**"]), component("cmp_far", ["src/far/**"])],
    decisions: [dec("dec_a", { decision: "Changed code in src (1 file(s)).", context: "Touched 1 file(s) across src.", related_files: ["src/a/x.ts"], provenance: inferred }), dec("dec_far", { decision: "Changed code in src (1 file(s)).", context: "Touched 1 file(s) across src.", related_files: ["src/far/x.ts"], provenance: inferred })],
  });
  // a <- b <- c <- a: a cycle, and far stands alone.
  const r = review(src, [], allAlive, [edge("cmp_b", "cmp_a"), edge("cmp_c", "cmp_b"), edge("cmp_a", "cmp_c")]);
  const weak = cards(r, "weak");
  assert.deepEqual(weak.map((c) => [c.records[0]!.id, c.reach]), [["dec_a", 2], ["dec_far", 0]], "ranked by reach");
});

test("limit: a group's total still counts what the answer left out", () => {
  const src = empty({ decisions: ["dec_a", "dec_b", "dec_c"].map((id) => dec(id, { decision: "Changed code in src (1 file(s)).", context: "Touched 1 file(s) across src.", provenance: inferred })) });
  const r = reviewCards(src, [], { drift: [], alive: allAlive, limit: 2 });
  const weak = r.groups.find((g) => g.kind === "weak")!;
  assert.equal(weak.total, 3);
  assert.equal(weak.cards.length, 2);
  assert.equal(r.total, 3);
});

test("alive: a path on another branch or gitignored is alive; gone from every branch isn't", () => {
  const root = tempDir("hunch-review-alive-");
  try {
    const env = isolatedCliEnv({ HOME: root, USERPROFILE: root });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), "/wiki/\nlocal.json\n");
    writeFileSync(join(root, "kept.ts"), "");
    git("add", "."); git("commit", "-qm", "base");
    git("switch", "-qc", "feature");
    mkdirSync(join(root, "feat"));
    writeFileSync(join(root, "feat", "only-here.ts"), "");
    git("add", "."); git("commit", "-qm", "feature");
    git("switch", "-q", "main");
    const alive = pathsAliveInRepo(["kept.ts", "feat", "feat/only-here.ts", "wiki", "local.json", ".git/hooks/pre-push", "gone.ts", "old/deep.ts"], root);
    assert.ok(alive);
    assert.deepEqual([...alive].sort(), [".git/hooks/pre-push", "feat", "feat/only-here.ts", "kept.ts", "local.json", "wiki"]);
    assert.deepEqual(pathsAliveInRepo([], root), new Set());
    assert.equal(pathsAliveInRepo(["kept.ts"], join(root, "no-such-directory")), null, "git couldn't say: the caller shows nothing");
    // Any of these alone used to kill the batch or shift the answers, and Stale went empty.
    const odd = pathsAliveInRepo(["../x", "a/../../x", "a\nb", "/abs", "C:/x", "kept.ts", "./kept.ts", "gone.ts"], root);
    assert.deepEqual([...(odd ?? [])].sort(), ["./kept.ts", "kept.ts"]);
    assert.deepEqual(pathsAliveInRepo(["../x"], join(root, "no-such-directory")), new Set(), "nothing to ask git");
    writeFileSync(join(root, ".gitignore"), "/wiki/\nlocal.json\nignored-é.json\n");
    assert.deepEqual([...(pathsAliveInRepo(["ignored-é.json", "other-é.json"], root) ?? [])], ["ignored-é.json"], "git quotes this path unless asked not to");
    assert.deepEqual([...(pathsAliveInRepo(["feat//only-here.ts", "feat/./only-here.ts"], root) ?? [])].sort(), ["feat/./only-here.ts", "feat//only-here.ts"], "git only finds the tidy spelling");
    // check-ignore dies on a path at or under a submodule, which used to empty all of Stale.
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    git("update-index", "--add", "--cacheinfo", `160000,${head},sub`);
    assert.deepEqual([...(pathsAliveInRepo(["sub", "sub/deep/y", "kept.ts", "gone.ts"], root) ?? [])].sort(), ["kept.ts", "sub", "sub/deep/y"]);
    assert.deepEqual([...(pathsAliveInRepo(["sub/deep/y"], root) ?? [])], ["sub/deep/y"], "nothing left to ask check-ignore");
  } finally { cleanupDir(root); }
});

test("alive: a submodule on another branch answers for what's under it; paths are the Hunch root's", () => {
  const root = tempDir("hunch-review-alive-sub-");
  try {
    const env = isolatedCliEnv({ HOME: root, USERPROFILE: root });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "in.ts"), "");
    git("add", "."); git("commit", "-qm", "base");
    git("switch", "-qc", "feature");
    writeFileSync(join(root, ".gitmodules"), "[submodule \"vendor/sub\"]\n\tpath = vendor/sub\n\turl = ./elsewhere\n");
    git("add", ".gitmodules");
    // As in any real submodule, the commit it points at isn't in this repo, so cat-file calls it missing.
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
    git("commit", "-qm", "submodule");
    git("switch", "-qc", "nested", "main");
    // A repo someone just `git add`ed: a gitlink with no .gitmodules anywhere on this branch.
    git("update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},pkg/nested`);
    git("commit", "-qm", "nested");
    git("switch", "-q", "main");
    const alive = pathsAliveInRepo(["vendor/sub", "vendor/sub/deep/y", "vendor/subway", "vendor/other", "gone.ts", "pkg/in.ts", "pkg/nested/x.ts"], root);
    assert.deepEqual([...(alive ?? [])].sort(), ["pkg/in.ts", "pkg/nested/x.ts", "vendor/sub", "vendor/sub/deep/y"]);
    assert.deepEqual([...(pathsAliveInRepo(["vendor/sub/deep/y"], root) ?? [])], ["vendor/sub/deep/y"], "asked alone, with nothing naming the submodule itself");
    assert.deepEqual([...(pathsAliveInRepo(["vendor/other/x", "pkg/in.ts/x"], root) ?? [])], [], "an ordinary directory or a file above a path proves nothing");
    assert.deepEqual([...(pathsAliveInRepo(["vendor/*", ":(top)gone.ts", "gone.ts"], root) ?? [])], [], "a stored path is a path, not a pathspec");
    // A Hunch root below the git toplevel: its paths are relative to it, not to the toplevel.
    const pkg = join(root, "pkg");
    assert.deepEqual([...(pathsAliveInRepo(["in.ts", "pkg/in.ts", "nested", "nested/x.ts"], pkg) ?? [])].sort(), ["in.ts", "nested", "nested/x.ts"]);
    // A hook's exported GIT_DIR outranks -C and would answer for the wrong base.
    const hadGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, ".git");
    try {
      assert.deepEqual([...(pathsAliveInRepo(["in.ts", "pkg/in.ts"], pkg) ?? [])], ["in.ts"]);
    } finally {
      if (hadGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = hadGitDir;
    }
  } finally { cleanupDir(root); }
});

test("merge: a duplicate already marked replaced can't be undone, and the card says so before the click", () => {
  const [card] = cards(review(empty({ decisions: [
    dec("dec_keep", { title: "Same words here", related_files: files, provenance: human }),
    dec("dec_old", { title: "Same words here", related_files: [...files, "src/b.ts"], superseded_by: "dec_gone" }),
    dec("dec_gone", { title: "Something else entirely", status: "superseded", supersedes: "dec_old", related_files: ["src/z.ts"] }),
  ] })), "duplicate");
  assert.equal(card!.actions.merge!.duplicate, "dec_old");
  assert.equal(card!.actions.merge!.oneWay, true, "restore refuses a record marked replaced");
  assert.equal(card!.actions.swap!.oneWay, false, "removing the other one can be undone");
});

test("merge: the survivor takes the duplicate's topic only when it has none", () => {
  const merge = (keep: object, go: object) => cards(review(empty({ decisions: [
    dec("dec_keep", { title: "Same words here", related_files: files, provenance: human, ...keep }),
    dec("dec_go", { title: "Same words here", related_files: files, ...go }),
  ] })), "duplicate")[0]!.actions.merge!;
  const carried = merge({}, { topic: "auth" });
  assert.equal(carried.feature, "auth");
  assert.equal(carried.oneWay, false, "undo clears the topic before the restore, so the guard passes");
  assert.equal(merge({ topic: "auth" }, {}).feature, null, "the survivor's own topic stays");
});

test("merge: what the CLI would refuse on the survivor stays behind, or the remove runs and the link fails", () => {
  const component = ComponentSchema.parse({ id: "cmp_real", kind: "module", name: "Real", paths: ["src/real/**"], provenance: prov(), created_at: now, updated_at: now });
  const src = empty({ components: [component], decisions: [
    dec("dec_pub", { title: "Same words here", related_files: files, provenance: human }),
    dec("dec_priv", { title: "Same words here", related_files: [...files, "private:notes/a.md", "src/b.ts"], related_components: ["cmp_real", "cmp_gone"] }),
  ] });
  const merged = (inOverlay: (id: string) => boolean) => cards(reviewCards(src, [], { drift: [], alive: allAlive, inOverlay }), "duplicate")[0]!.actions.merge!;
  const onPublic = merged((id) => id === "dec_priv");
  assert.equal(onPublic.survivor, "dec_pub");
  assert.deepEqual(onPublic.addFiles, ["src/b.ts"]);
  assert.deepEqual(onPublic.addComponents, ["cmp_real"]);
  assert.deepEqual(onPublic.leftBehind, ["private:notes/a.md", "cmp_gone"]);
  const onPrivate = merged(() => true);
  assert.deepEqual(onPrivate.addFiles, ["private:notes/a.md", "src/b.ts"], "both in the overlay: the link is allowed");
  assert.deepEqual(onPrivate.leftBehind, ["cmp_gone"]);
});

test("merge: more links than one request takes stay behind, not refused after the remove", () => {
  const many = Array.from({ length: 205 }, (_, i) => `src/f${i}.ts`);
  const merge = cards(review(empty({ decisions: [
    dec("dec_stay", { title: "Same words here", related_files: files, provenance: human }),
    dec("dec_go", { title: "Same words here", related_files: [...files, ...many] }),
  ] })), "duplicate")[0]!.actions.merge!;
  assert.equal(merge.addFiles.length, 200);
  assert.deepEqual(merge.leftBehind, many.slice(200));
  const long = Array.from({ length: 150 }, (_, i) => `src/${"d".repeat(300)}/${i}.ts`);
  const big = cards(review(empty({ decisions: [
    dec("dec_stay", { title: "Same words here", related_files: files, provenance: human }),
    dec("dec_go", { title: "Same words here", related_files: [...files, ...long] }),
  ] })), "duplicate")[0]!.actions.merge!;
  assert.ok(big.addFiles.reduce((n, f) => n + "--add-file".length + f.length + 2, 0) <= 29_000, "the route refuses a command line past its limit");
  assert.equal(big.addFiles.length + big.leftBehind.length, long.length);
  assert.ok(big.leftBehind.length > 0);
});

test("conflict: keeping one on a shared topic can't be undone, and the card says so before the click", () => {
  const topic = review(empty({ decisions: [dec("dec_a", { topic: "auth" }), dec("dec_b", { topic: "auth" })] }));
  const [same] = cards(topic, "conflict");
  assert.equal(same!.actions.merge!.oneWay, true);
  assert.equal(same!.actions.swap!.oneWay, true);
  const replaced = review(empty({ decisions: [dec("dec_new", { supersedes: "dec_old" }), dec("dec_old", {})] }), [{ kind: "supersede", id: "dec_new", detail: "x" }]);
  const [claim] = cards(replaced, "conflict");
  assert.equal(claim!.actions.merge!.oneWay, false, "no shared topic: restore has nothing to refuse");
  // Restore refuses a record already marked replaced, even one still live.
  const marked = review(empty({ decisions: [dec("dec_new", { supersedes: "dec_old" }), dec("dec_old", { superseded_by: "dec_new" })] }), [{ kind: "supersede", id: "dec_new", detail: "x" }]);
  const [half] = cards(marked, "conflict");
  assert.equal(half!.actions.merge!.oneWay, true, "removing the old one can't be undone");
  assert.equal(half!.actions.swap!.oneWay, false, "removing the new one can");
});

test("conflict: keeping the newer one records the replacement, only when the CLI will take it", () => {
  const drift = [{ kind: "supersede" as const, id: "dec_new", detail: "x" }];
  const live = cards(review(empty({ decisions: [dec("dec_new", { supersedes: "dec_old" }), dec("dec_old", {})] }), drift), "conflict")[0]!;
  assert.equal(live.actions.merge!.supersededBy, "dec_new");
  assert.equal(live.actions.swap!.supersededBy, null, "keeping the older one replaces nothing");
  const draft = cards(review(empty({ decisions: [dec("dec_new", { supersedes: "dec_old", status: "proposed" }), dec("dec_old", {})] }), drift), "conflict")[0]!;
  assert.equal(draft.actions.merge!.supersededBy, null, "a draft can't replace a live decision");
  const src = empty({ decisions: [dec("dec_new", { supersedes: "dec_old" }), dec("dec_old", {})] });
  const crossing = cards(reviewCards(src, [], { drift, alive: () => new Set(), inOverlay: (id) => id === "dec_new" }), "conflict")[0]!;
  assert.equal(crossing.actions.merge!.supersededBy, null, "a replacement never crosses stores");
});

test("stale: a private: link is the overlay's answer, never asked of git and never grounds a remove", () => {
  const asked: string[] = [];
  const finding = FindingSchema.parse({ id: "fnd_a", title: "Seen", observation: "Seen it", affected_files: ["private:notes/a.md"], observed_at: now, provenance: prov() });
  const r = review(empty({ findings: [finding] }), [{ kind: "finding-stale", id: "fnd_a", detail: "missing", path: "private:notes/a.md" }], (paths) => { asked.push(...paths); return new Set(); });
  const [card] = cards(r, "stale");
  assert.deepEqual(asked, []);
  assert.deepEqual(card!.evidence, ["A shared record can't use an overlay path: private:notes/a.md"]);
  assert.equal(card!.recommend, null, "an unconfirmed finding with a dead public link would get a remove");
  const inOverlay = reviewCards(empty({ findings: [finding] }), [], { drift: [{ kind: "finding-stale", id: "fnd_a", detail: "missing", path: "private:notes/a.md" }], alive: allAlive, inOverlay: () => true });
  assert.deepEqual(cards(inOverlay, "stale")[0]!.evidence, ["Not in the overlay: private:notes/a.md"]);
});

test("stale: a glob next to a dead file is still something it links to", () => {
  const r = review(empty({ decisions: [dec("dec_a", { related_files: ["src/**", "old/a.ts"] })] }), [{ kind: "dead-ref", id: "dec_a", detail: "x", path: "old/a.ts" }], noneAlive);
  const [card] = cards(r, "stale");
  assert.match(card!.claim, /1 of 2 linked paths is gone/);
  assert.equal(card!.recommend, "drop-links");
});
