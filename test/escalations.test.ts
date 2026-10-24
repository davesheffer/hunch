import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingEscalations, policyEscalations, commitRepairEscalations, actionableEscalations, summarizeEscalations, escalationHeadline, relevantEscalations, type Escalation, type PolicyLite } from "../src/core/escalations.js";
import type { Decision } from "../src/core/types.js";

const D = (over: Partial<Decision> & { id: string }): Decision => ({
  id: over.id, title: over.title ?? `title ${over.id}`, decision: "did a thing",
  status: over.status ?? "accepted", topic: over.topic ?? null,
  superseded_by: over.superseded_by ?? null, valid_to: over.valid_to ?? null,
  alternatives_rejected: [], related_files: [], commit: over.commit ?? null,
  provenance: { source: over.source ?? "llm_draft", confidence: 0.6, evidence: [] },
  valid_from: "2026-01-01T00:00:00Z", date: "2026-01-01T00:00:00Z",
} as Decision);

test("pendingEscalations: a healthy graph needs no human decision (empty)", () => {
  const decs = [D({ id: "dec_a", topic: "store.writes" }), D({ id: "dec_b", topic: "mcp.shape" })];
  assert.deepEqual(pendingEscalations(decs), []);
});

test("pendingEscalations: two LIVE decisions on one topic surface as one inline question", () => {
  const decs = [
    D({ id: "dec_a", topic: "store.writes" }),
    D({ id: "dec_b", topic: "store.writes" }), // collision — both accepted, in-force
  ];
  const items = pendingEscalations(decs);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "topic-conflict");
  assert.equal(items[0]!.topic, "store.writes");
  assert.deepEqual(items[0]!.decisionIds.sort(), ["dec_a", "dec_b"]);
  assert.match(items[0]!.question, /which one is current/);
});

test("pendingEscalations: auto-captured (topic null) memory never collides — no escalation", () => {
  // The whole point: auto-trust writes topic:null, so ordinary captured memory
  // piling up NEVER creates a human decision. Only human-anchored topics can.
  const decs = [D({ id: "dec_a" }), D({ id: "dec_b" }), D({ id: "dec_c" })];
  assert.deepEqual(pendingEscalations(decs), []);
});

const P = (over: Partial<PolicyLite> & { id: string }): PolicyLite => ({
  state: "proposed", statement: `rule ${over.id}`, proof: null, authority: null, ...over,
});

test("policyEscalations: candidates and proposals surface as questions; active/retired stay silent", () => {
  const items = policyEscalations([
    P({ id: "pol_a", state: "compiled" }),
    P({ id: "pol_b", state: "proposed", proof: "proof_x" }),
    P({ id: "pol_c", state: "proposed" }),                       // no proof → "prove first"
    P({ id: "pol_d", state: "active_advisory", authority: { actor: "human:x" } }),
    P({ id: "pol_e", state: "retired" }),
  ]);
  assert.equal(items.length, 3, "only candidate + the two proposals ask; active/retired never do");
  assert.equal(items[0]!.kind, "policy-candidate");
  assert.match(items[0]!.resolution, /policy prove pol_a/);
  assert.equal(items[1]!.kind, "policy-proposal");
  assert.match(items[1]!.question, /activate it \(advisory\/blocking\) or reject/);
  assert.match(items[1]!.resolution, /policy accept pol_b/);
  assert.match(items[2]!.question, /no current proof — prove it/);
});

test("policyEscalations: an empty policy store asks nothing", () => {
  assert.deepEqual(policyEscalations([]), []);
});

test("policyEscalations: an auto-repaired policy asks for a re-prove, exactly once", () => {
  const items = policyEscalations([
    P({ id: "pol_r", state: "active_advisory", proof: "proof_x", authority: { actor: "human:x" }, last_action: "repaired" }),
    P({ id: "pol_ok", state: "active_advisory", authority: { actor: "human:x" }, last_action: "approved_advisory" }), // healthy active → silent
    P({ id: "pol_rp", state: "proposed", proof: "proof_y", last_action: "repaired" }), // repaired wins over the proposal ask
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, "policy-repaired");
  assert.match(items[0]!.question, /auto-repaired after a rename/);
  assert.match(items[0]!.resolution, /policy prove pol_r/);
  assert.equal(items[1]!.kind, "policy-repaired", "a repaired proposed policy asks once, not twice");
});

test("pendingEscalations: a superseded decision on the topic does not count (only live collide)", () => {
  const decs = [
    D({ id: "dec_old", topic: "store.writes", status: "superseded", superseded_by: "dec_new" }),
    D({ id: "dec_new", topic: "store.writes" }),
  ];
  assert.deepEqual(pendingEscalations(decs), []);
});

test("commitRepairEscalations: an empty queue asks nothing", () => {
  assert.deepEqual(commitRepairEscalations([], []), []);
});

test("commitRepairEscalations: a queued, still-live repair surfaces as one question", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "commit-repair-pending");
  assert.equal(items[0]!.topic, "dec_1");
  assert.deepEqual(items[0]!.decisionIds, ["dec_1"]);
  assert.match(items[0]!.question, /Add the feature/);
  assert.match(items[0]!.question, /no longer reachable from HEAD/);
  assert.match(items[0]!.question, /likely squash-merged away/);
  assert.match(items[0]!.question, /one newly-merged commit touches all its related files/);
  assert.equal(items[0]!.detail, "sha_old → sha_new");
  assert.match(items[0]!.resolution, /repair-provenance --apply --only dec_1/);
  assert.match(items[0]!.resolution, /--drop dec_1/);
  assert.match(items[0]!.resolution, /tombstoned durably/);
  assert.match(items[0]!.resolution, /won't resurface/);
});

test("commitRepairEscalations: an entry whose decision does not exist asks nothing", () => {
  assert.deepEqual(commitRepairEscalations([{ id: "dec_missing", from: "sha_old", to: "sha_new" }], []), []);
});

test("commitRepairEscalations: a decision whose commit already moved asks nothing", () => {
  const decs = [D({ id: "dec_1", commit: "sha_other" })];
  assert.deepEqual(commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs), []);
});

test("commitRepairEscalations: liveness is checked against the full scope without leaking a private title", () => {
  const all = [D({ id: "dec_private", title: "Private decision", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_private", from: "sha_old", to: "sha_new" }], [], all);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.decisionIds[0], "dec_private");
  assert.doesNotMatch(items[0]!.question, /Private decision/);
});

test("commitRepairEscalations: with two arguments liveness defaults to the visible list", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.equal(items.length, 1);
  assert.match(items[0]!.question, /Add the feature/);
});

test("commitRepairEscalations: with no withheld set, nothing is treated as withheld", () => {
  const decs = [D({ id: "dec_1", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.match(items[0]!.resolution, /--apply --only dec_1 --expect sha256:[a-f0-9]{64} to accept/);
});

test("commitRepairEscalations: a withheld entry asks for a reject, never an apply", () => {
  const entry = { id: "dec_1", from: "sha_old", to: "sha_ghost" };
  const decs = [D({ id: "dec_1", commit: "sha_old" })];
  const items = commitRepairEscalations([entry], decs, decs, new Set([entry]));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "commit-repair-pending");
  assert.match(items[0]!.question, /doesn't resolve in this repository/);
  assert.match(items[0]!.question, /reject it\?/);
  assert.doesNotMatch(items[0]!.resolution, /--apply --only dec_1 --expect sha256:[a-f0-9]{64} to accept/, "must never advertise an action that's guaranteed to no-op forever");
  assert.match(items[0]!.resolution, /--drop dec_1/);
});

test("commitRepairEscalations: withheld is keyed by object, not id", () => {
  const entryA = { id: "dec_a", from: "sha_a_old", to: "sha_ghost" };
  const entryB = { id: "dec_b", from: "sha_b_old", to: "sha_b_new" };
  const decs = [D({ id: "dec_a", commit: "sha_a_old" }), D({ id: "dec_b", commit: "sha_b_old" })];
  const items = commitRepairEscalations([entryA, entryB], decs, decs, new Set([entryA]));
  const forA = items.find((i) => i.decisionIds[0] === "dec_a")!;
  const forB = items.find((i) => i.decisionIds[0] === "dec_b")!;
  assert.match(forA.question, /doesn't resolve in this repository/);
  assert.doesNotMatch(forB.question, /doesn't resolve in this repository/);
  assert.match(forB.resolution, /--apply --only dec_b --expect sha256:[a-f0-9]{64} to accept/);
});

test("commitRepairEscalations: a withheld entry queued ahead of a resolvable sibling is the drop target", () => {
  const ghost = { id: "dec_a", from: "sha_old", to: "sha_ghost" };
  const resolvable = { id: "dec_a", from: "sha_old", to: "sha_real" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([ghost, resolvable], decs, decs, new Set([ghost]));
  assert.equal(items.length, 2);
  const forGhost = items.find((i) => i.detail === "sha_old → sha_ghost")!;
  const forResolvable = items.find((i) => i.detail === "sha_old → sha_real")!;
  assert.match(forGhost.question, /doesn't resolve in this repository/);
  assert.doesNotMatch(forGhost.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "never claims --apply works for a withheld entry");
  assert.match(forGhost.resolution, /--drop dec_a/); // ghost is the first survivor, so it is what --drop targets
  // resolvable is the apply target (--apply skips withheld entries) while --drop still hits ghost.
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "--apply --only skips the withheld sibling ahead of it and reaches this entry");
  assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "the ordinary --drop wording would be wrong here — --drop dec_a actually tombstones ghost");
  assert.match(forResolvable.resolution, /(--drop dec_a[^]*won't reject|won't reject[^]*--drop dec_a|earlier[^]*sibling)/i);
});

test("commitRepairEscalations: a withheld entry queued behind a resolvable one is only ever droppable", () => {
  const resolvable = { id: "dec_a", from: "sha_old", to: "sha_real" };
  const ghost = { id: "dec_a", from: "sha_old", to: "sha_ghost" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([resolvable, ghost], decs, decs, new Set([ghost]));
  assert.equal(items.length, 2);
  const forResolvable = items.find((i) => i.detail === "sha_old → sha_real")!;
  const forGhost = items.find((i) => i.detail === "sha_old → sha_ghost")!;
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the resolvable sibling is both the drop-target and the apply-target — ordinary wording");
  // ghost is queued second and withheld: neither command reaches it, so it is only ever droppable.
  assert.doesNotMatch(forGhost.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forGhost.resolution, /^hunch repair-provenance --drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "must not claim --drop dec_a targets THIS entry — resolvable is queued ahead of it");
  assert.match(forGhost.resolution, /doesn't resolve here either/i);
  assert.match(forGhost.resolution, /drop-only/);
  assert.match(forGhost.resolution, /fresh detection run|fresh match/);
  assert.doesNotMatch(forGhost.resolution, /accepted or rejected the normal way/);
  assert.doesNotMatch(forGhost.resolution, /can be accepted/);
});

test("commitRepairEscalations: a second queued entry for the same id is context, not a decision", () => {
  const first = { id: "dec_a", from: "sha_old", to: "sha_one" };
  const second = { id: "dec_a", from: "sha_old", to: "sha_two" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([first, second], decs);
  assert.equal(items.length, 2);
  const forFirst = items.find((i) => i.detail === "sha_old → sha_one")!;
  const forSecond = items.find((i) => i.detail === "sha_old → sha_two")!;
  assert.match(forFirst.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the first-queued match keeps the ordinary, working wording");
  assert.match(forFirst.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "and the ordinary --drop wording, which IS actionable against it");
  assert.doesNotMatch(forSecond.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "--apply --only would apply the FIRST entry, not this one");
  assert.doesNotMatch(forSecond.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "--drop would tombstone the FIRST entry, not this one");
  assert.match(forSecond.resolution, /hunch repair-provenance --apply --only dec_a/);
  assert.match(forSecond.resolution, /hunch repair-provenance --drop dec_a/);
  assert.match(forSecond.question, /queued replacement candidate/);
});

test("commitRepairEscalations: the follower's resolution says dropping, not applying, brings it back", () => {
  const first = { id: "dec_a", from: "sha_old", to: "sha_one" };
  const second = { id: "dec_a", from: "sha_old", to: "sha_two" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([first, second], decs);
  const forSecond = items.find((i) => i.detail === "sha_old → sha_two")!;
  assert.doesNotMatch(forSecond.resolution, /(appl(y|ying)|resolving)[^.]*brings this one back/i);
  assert.match(forSecond.resolution, /(drop[^]*brings this one back|brings this one back[^]*drop)/i);
  assert.match(forSecond.resolution, /retire|stale/i);
});

test("commitRepairEscalations: three entries for one id", () => {
  const e1 = { id: "dec_a", from: "sha_old", to: "sha_1" };
  const e2 = { id: "dec_a", from: "sha_old", to: "sha_2" };
  const e3 = { id: "dec_a", from: "sha_old", to: "sha_3" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([e1, e2, e3], decs);
  assert.equal(items.length, 3);
  const for3 = items.find((i) => i.detail === "sha_old → sha_3")!;
  assert.doesNotMatch(for3.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(for3.question, /a second queued replacement candidate/i);
});

test("commitRepairEscalations: two withheld entries ahead of a resolvable one", () => {
  const ghost1 = { id: "dec_a", from: "sha_old", to: "sha_g1" };
  const ghost2 = { id: "dec_a", from: "sha_old", to: "sha_g2" };
  const resolvable = { id: "dec_a", from: "sha_old", to: "sha_real" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([ghost1, ghost2, resolvable], decs, decs, new Set([ghost1, ghost2]));
  assert.equal(items.length, 3);
  const forGhost1 = items.find((i) => i.detail === "sha_old → sha_g1")!;
  const forGhost2 = items.find((i) => i.detail === "sha_old → sha_g2")!;
  const forResolvable = items.find((i) => i.detail === "sha_old → sha_real")!;
  assert.match(forGhost1.question, /doesn't resolve in this repository/);
  assert.match(forGhost1.resolution, /--drop dec_a/);
  assert.doesNotMatch(forGhost1.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  // ghost2 is neither the drop target (ghost1 is) nor the apply target (resolvable is).
  assert.doesNotMatch(forGhost2.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forGhost2.resolution, /^hunch repair-provenance --drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/);
  assert.match(forGhost2.resolution, /doesn't resolve here either/i);
  // resolvable is the first non-withheld survivor, hence the apply target.
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/);
});

test("commitRepairEscalations: 'first' follows post-prune order, not raw queue order", () => {
  const deadFirst = { id: "dec_a", from: "sha_stale", to: "sha_x" };
  const liveSecond = { id: "dec_a", from: "sha_a_old", to: "sha_y" };
  const decs = [D({ id: "dec_a", commit: "sha_a_old" })];
  const items = commitRepairEscalations([deadFirst, liveSecond], decs);
  assert.equal(items.length, 1);
  assert.match(items[0]!.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the CLI prunes deadFirst before --drop/--apply ever consult the queue, so liveSecond IS what they'd act on — must not read as a duplicate stuck behind a phantom sibling");
});

test("commitRepairEscalations: 'first' follows queue array order", () => {
  const later = { id: "dec_a", from: "sha_old", to: "sha_later" };
  const earlier = { id: "dec_a", from: "sha_old", to: "sha_earlier" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([later, earlier], decs);
  const forLater = items.find((i) => i.detail === "sha_old → sha_later")!;
  const forEarlier = items.find((i) => i.detail === "sha_old → sha_earlier")!;
  assert.match(forLater.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "whichever entry is first in the queue array wins, regardless of its `to`");
  assert.doesNotMatch(forEarlier.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
});

const dupQueue = () => {
  const first = { id: "dec_a", from: "sha_old", to: "sha_one" };
  const second = { id: "dec_a", from: "sha_old", to: "sha_two" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([first, second], decs);
  return { items, forFirst: items[0]!, forSecond: items[1]! };
};

test("actionableEscalations: a duplicate-id queue gates only on the first entry", () => {
  const { items, forFirst } = dupQueue();
  assert.deepEqual(actionableEscalations(items), [forFirst]);
});

test("actionableEscalations: a single ordinary entry is actionable", () => {
  const decs = [D({ id: "dec_1", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.deepEqual(actionableEscalations(items), items);
});

test("actionableEscalations: a lone withheld drop target stays actionable", () => {
  const entry = { id: "dec_1", from: "sha_old", to: "sha_ghost" };
  const decs = [D({ id: "dec_1", commit: "sha_old" })];
  const items = commitRepairEscalations([entry], decs, decs, new Set([entry]));
  assert.deepEqual(actionableEscalations(items), items);
});

test("actionableEscalations: in the ghost1/ghost2/resolvable case the filter keeps ghost1 and resolvable", () => {
  const ghost1 = { id: "dec_a", from: "sha_old", to: "sha_g1" };
  const ghost2 = { id: "dec_a", from: "sha_old", to: "sha_g2" };
  const resolvable = { id: "dec_a", from: "sha_old", to: "sha_real" };
  const decs = [D({ id: "dec_a", commit: "sha_old" })];
  const items = commitRepairEscalations([ghost1, ghost2, resolvable], decs, decs, new Set([ghost1, ghost2]));
  const [forGhost1, , forResolvable] = items;
  assert.deepEqual(actionableEscalations(items), [forGhost1, forResolvable]);
});

test("actionableEscalations: topic conflicts are all actionable", () => {
  const items = pendingEscalations([D({ id: "dec_a", topic: "t" }), D({ id: "dec_b", topic: "t" })]);
  assert.deepEqual(actionableEscalations(items), items);
});

const E = (topic: string, actionable?: boolean): Escalation => ({
  kind: "topic-conflict", topic, decisionIds: [topic], question: `q ${topic}`, detail: "", resolution: "",
  ...(actionable === undefined ? {} : { actionable }),
});

test("actionableEscalations: drops only explicit false, keeps order", () => {
  const a = E("a"), b = E("b", false), c = E("c");
  assert.deepEqual(actionableEscalations([a, b, c]), [a, c]);
  assert.deepEqual(actionableEscalations([]), []);
});

test("summarizeEscalations: splits gating entries from context", () => {
  const a = E("a"), b = E("b", false);
  assert.deepEqual(summarizeEscalations([a, b]), { actionable: [a], context: 1 });
  assert.deepEqual(summarizeEscalations([a]), { actionable: [a], context: 0 });
  assert.deepEqual(summarizeEscalations([]), { actionable: [], context: 0 });
});

test("escalationHeadline: exact strings per audience", () => {
  const a = E("a"), b = E("b", false);
  assert.equal(escalationHeadline([a], "cli"), "1 decision(s) need your call — asked here, never decided for you:");
  assert.equal(escalationHeadline([a, b], "cli"), "1 decision(s) need your call — asked here, never decided for you (+1 shown below for context only, not gating):");
  assert.equal(escalationHeadline([a, b], "mcp"), "1 decision(s) need the human's call — ask each inline, don't decide it for them (+1 shown below for context only, not a decision):");
  assert.equal(escalationHeadline([b], "cli"), "Nothing needs your decision right now — 1 entry shown below for context only (resolving another entry will clear them):");
  assert.equal(escalationHeadline([b, b], "mcp"), "Nothing needs the human's call right now — 2 entries shown below for context only (resolving another entry will clear them):");
});

test("relevantEscalations keeps only entries the prompt's task touches (dec_12ba37db1c)", () => {
  const esc = (topic: string, ids: string[]): Escalation => ({ kind: "topic-conflict", topic, decisionIds: ids, question: `q ${topic}`, detail: "", resolution: "" });
  const items = [esc("synthesis-provider", ["dec_a", "dec_b"]), esc("pol_x", ["pol_x"]), esc("dec_c", ["dec_c"])];
  const files = (id: string) => ({ dec_a: ["src/synthesis/provider.ts"], dec_c: ["docs/a.md"] } as Record<string, string[]>)[id] ?? [];
  const pick = (prompt: string, paths: string[] = [], selected: string[] = []) =>
    relevantEscalations(items, { prompt, paths, selectedIds: new Set(selected) }, files).map((e) => e.topic);
  assert.deepEqual(pick("add a flag to the parser"), [], "unrelated prompt asks nothing");
  assert.deepEqual(pick("edit it", ["src/synthesis/provider.ts"]), ["synthesis-provider"], "a related file the prompt names");
  assert.deepEqual(pick("edit it", ["src/synthesis"]), ["synthesis-provider"], "a directory covers the files under it");
  assert.deepEqual(pick("revisit the synthesis-provider choice"), ["synthesis-provider"], "a topic the prompt names");
  assert.deepEqual(pick("synthesis-providers are fine"), [], "a topic is matched whole, not as a prefix");
  assert.deepEqual(pick("prove POL_X now"), ["pol_x"], "an id the prompt names, any case");
  assert.deepEqual(pick("go", [], ["dec_c"]), ["dec_c"], "an id the task selection chose");
  assert.deepEqual(pick("edit it", ["src/"]), ["synthesis-provider"], "a trailing slash still names the directory");
  assert.equal(pick("show me the escalations").length, 3, "asking about escalations asks them all");
  assert.equal(pick("call hunch_escalations").length, 3, "the tool name counts as asking");
  assert.deepEqual(pick("de-escalation of the parser"), [], "de-escalation is not a question about escalations");
});

test("relevantEscalations anchors policies by scope, matches globs, and ignores path tokens for the keyword", () => {
  const esc = (kind: Escalation["kind"], topic: string, ids: string[]): Escalation => ({ kind, topic, decisionIds: ids, question: `q ${topic}`, detail: "", resolution: "" });
  const items = [esc("policy-proposal", "pol_0123456789", ["pol_0123456789"]), esc("topic-conflict", "storage", ["dec_s"]), esc("topic-conflict", "other", ["dec_o"])];
  const anchors: Record<string, string[]> = { pol_0123456789: ["src/auth/**"], dec_s: ["src/store/**"], dec_o: ["docs/o.md"] };
  const pick = (prompt: string, paths: string[] = [], selected: string[] = []) =>
    relevantEscalations(items, { prompt, paths, selectedIds: new Set(selected) }, (id) => anchors[id] ?? []).map((e) => e.topic);
  // policy anchored by its scope paths/globs, without naming its pol_ id
  assert.deepEqual(pick("harden src/auth/login.ts", ["src/auth/login.ts"]), ["pol_0123456789"]);
  assert.deepEqual(pick("touch src/billing/x.ts", ["src/billing/x.ts"]), [], "a path outside the scope asks nothing");
  // glob-aware related_files, keeping directory nesting both ways
  assert.deepEqual(pick("fix src/store/db.ts", ["src/store/db.ts"]), ["storage"], "a glob covers the file");
  assert.deepEqual(pick("look at src/store", ["src/store"]), ["storage"], "the glob's own directory");
  assert.deepEqual(pick("look at src/", ["src/"]), ["pol_0123456789", "storage"], "a parent of the glob's literal prefix");
  assert.deepEqual(pick("fix db.ts", ["db.ts"]), [], "no basename-only matching");
  // the keyword is tested against prose only
  assert.deepEqual(pick("add a case to test/escalations.test.ts", ["test/escalations.test.ts"]), [], "a file named escalations is not a question about them");
  assert.deepEqual(pick("update escalations.ts, then stop", ["escalations.ts"]), [], "a bare file name with an extension is a path token too");
  assert.equal(pick("which escalations are open?").length, 3, "prose still asks them all");
  // a selection id (top or qualifying, unioned by the caller) counts
  assert.deepEqual(pick("go", [], ["dec_o"]), ["other"]);
});
