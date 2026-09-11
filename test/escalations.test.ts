import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingEscalations, policyEscalations, commitRepairEscalations, actionableEscalations, summarizeEscalations, escalationHeadline, type Escalation, type PolicyLite } from "../src/core/escalations.js";
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

test("commitRepairEscalations: a queued match surfaces as one inline question naming the decision's title", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "commit-repair-pending");
  assert.equal(items[0]!.topic, "dec_1");
  assert.deepEqual(items[0]!.decisionIds, ["dec_1"]);
  assert.match(items[0]!.question, /Add the feature/);
  assert.match(items[0]!.question, /no longer reachable from HEAD/, "states the actual evidence, not a stated conclusion");
  assert.match(items[0]!.question, /likely squash-merged away/, "still names the likely explanation, just not as asserted fact");
  assert.match(items[0]!.question, /one newly-merged commit touches all its related files/);
  assert.equal(items[0]!.detail, "sha_old → sha_new");
  assert.match(items[0]!.resolution, /repair-provenance --apply --only dec_1/, "gives a copy-pasteable command targeting just this decision");
  assert.match(items[0]!.resolution, /--drop dec_1/, "also offers rejecting just this one from the queue");
  assert.match(items[0]!.resolution, /tombstoned durably/, "--drop is durable — the wording must say so, not imply it's a mere queue clear");
  assert.match(items[0]!.resolution, /won't resurface/, "must say the identical match won't come back");
});

test("commitRepairEscalations: a queued entry whose decision no longer exists asks nothing — not a permanently unanswerable question", () => {
  const items = commitRepairEscalations([{ id: "dec_gone", from: "sha_old", to: "sha_new" }], []);
  assert.deepEqual(items, []);
});

test("commitRepairEscalations: a queued entry whose decision's commit already moved on asks nothing — repairDecisionCommit would refuse it anyway", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_moved_on" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.deepEqual(items, []);
});

test("commitRepairEscalations: a decision invisible on the advisory scope (private overlay) still asks — liveness checked against the full store, not the visible one", () => {
  const full = [D({ id: "dec_private", title: "Private decision", commit: "sha_old" })];
  const visible: Decision[] = []; // e.g. store.advisoryRecs() in private mode never sees an overlay record
  const items = commitRepairEscalations([{ id: "dec_private", from: "sha_old", to: "sha_new" }], visible, full);
  assert.equal(items.length, 1, "the repair is fully answerable via repair-provenance, which reads the full store — the question must not go silent");
  assert.equal(items[0]!.decisionIds[0], "dec_private");
  assert.doesNotMatch(items[0]!.question, /Private decision/, "the visible (advisory) scope doesn't have this decision — never disclose its title from the full-store lookup");
});

test("commitRepairEscalations: without a third argument, liveness still defaults to the visible decisions list (backward compatible)", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.equal(items.length, 1);
  assert.match(items[0]!.question, /Add the feature/);
});

test("commitRepairEscalations: without a fourth argument, no entry is treated as withheld (backward compatible)", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.match(items[0]!.resolution, /--apply --only dec_1 --expect sha256:[a-f0-9]{64} to accept/);
});

test("commitRepairEscalations: a withheld entry (its `to` doesn't resolve here) still asks, but never advertises --apply --only as a working resolution", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const entry = { id: "dec_1", from: "sha_old", to: "sha_ghost" };
  const items = commitRepairEscalations([entry], decs, decs, new Set([entry]));
  assert.equal(items.length, 1, "a withheld entry still needs a human — it still escalates");
  assert.equal(items[0]!.kind, "commit-repair-pending");
  assert.match(items[0]!.question, /doesn't resolve in this repository/);
  assert.match(items[0]!.question, /reject it\?/);
  assert.doesNotMatch(items[0]!.resolution, /--apply --only dec_1 --expect sha256:[a-f0-9]{64} to accept/, "must never advertise an action that's guaranteed to no-op forever");
  assert.match(items[0]!.resolution, /--drop dec_1/, "the only working resolution — --drop — must still be named");
});

test("commitRepairEscalations: withheld is keyed by OBJECT, so an untouched sibling in the same batch keeps the ordinary (apply-works) wording", () => {
  const decs = [
    D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" }),
    D({ id: "dec_b", title: "Decision B", commit: "sha_b_old" }),
  ];
  const entryA = { id: "dec_a", from: "sha_a_old", to: "sha_ghost" };
  const entryB = { id: "dec_b", from: "sha_b_old", to: "sha_b_new" };
  const items = commitRepairEscalations([entryA, entryB], decs, decs, new Set([entryA]));
  const forA = items.find((i) => i.decisionIds.includes("dec_a"))!;
  const forB = items.find((i) => i.decisionIds.includes("dec_b"))!;
  assert.match(forA.question, /doesn't resolve in this repository/);
  assert.doesNotMatch(forB.question, /doesn't resolve in this repository/, "dec_b was never withheld — must not inherit dec_a's wording");
  assert.match(forB.resolution, /--apply --only dec_b --expect sha256:[a-f0-9]{64} to accept/);
});

test("commitRepairEscalations: a corrupted queue with two entries sharing an id — the WITHHELD one queued first, the resolvable one second — resolvable gets accurate apply-works wording, and the drop-target (ghost) keeps its ordinary withheld wording", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const ghost = { id: "dec_a", from: "sha_a_old", to: "sha_ghost" };
  const resolvable = { id: "dec_a", from: "sha_a_old", to: "sha_real" };
  const items = commitRepairEscalations([ghost, resolvable], decs, decs, new Set([ghost]));
  assert.equal(items.length, 2, "both entries still surface — liveRewrites doesn't dedupe by id");
  const forGhost = items.find((i) => i.detail === "sha_a_old → sha_ghost")!;
  const forResolvable = items.find((i) => i.detail === "sha_a_old → sha_real")!;
  // ghost is queued FIRST, so --drop dec_a genuinely targets it (src/cli/index.ts: --drop
  // ignores withheld status and just takes firstFor(queue, id)) — the ordinary withheld
  // wording is accurate for it, unchanged.
  assert.match(forGhost.question, /doesn't resolve in this repository/);
  assert.doesNotMatch(forGhost.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "never claims --apply works for a withheld entry");
  assert.match(forGhost.resolution, /--drop dec_a/, "--drop dec_a really does target ghost here — it's the first survivor");
  // resolvable is second in the queue, but --apply --only excludes withheld entries when
  // picking the first match (src/cli/index.ts: plan.rewrites = applicable, the
  // withheld-filtered half) — so --apply --only dec_a DOES resolve to `resolvable`, even
  // though it isn't the absolute first-queued entry. --drop dec_a, however, still targets
  // ghost (--drop doesn't filter by withheld), not resolvable.
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "--apply --only skips the withheld sibling ahead of it and reaches this entry");
  assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "the ordinary --drop wording would be wrong here — --drop dec_a actually tombstones ghost");
  assert.match(forResolvable.resolution, /--drop dec_a.*won't reject|won't reject.*--drop dec_a|earlier.*sibling/i, "must say --drop targets the earlier (withheld) sibling instead");
});

test("commitRepairEscalations: a corrupted queue with two entries sharing an id — one withheld, one not, WITHHELD SECOND — must not tag the resolvable (first) sibling as withheld too, and must not claim the withheld sibling is reachable by id either (an id-keyed set, or a naive first-queued check, would get one of these wrong)", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const resolvable = { id: "dec_a", from: "sha_a_old", to: "sha_real" };
  const ghost = { id: "dec_a", from: "sha_a_old", to: "sha_ghost" };
  const items = commitRepairEscalations([resolvable, ghost], decs, decs, new Set([ghost]));
  assert.equal(items.length, 2, "both entries still surface — liveRewrites doesn't dedupe by id");
  const forResolvable = items.find((i) => i.detail === "sha_a_old → sha_real")!;
  const forGhost = items.find((i) => i.detail === "sha_a_old → sha_ghost")!;
  // resolvable is first-queued AND not withheld — both --apply --only and --drop genuinely
  // target it, so it keeps the ordinary, unmodified wording.
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the resolvable sibling is both the drop-target and the apply-target — ordinary wording");
  // ghost is second-queued AND withheld — neither --apply --only nor --drop reaches it: a
  // human reading its escalation must not be told either command acts on it, and must not
  // be told (falsely) that it becomes freely accept/reject-able once the sibling clears —
  // it will only ever be droppable, since it's withheld.
  assert.doesNotMatch(forGhost.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forGhost.resolution, /^hunch repair-provenance --drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "must not claim --drop dec_a targets THIS entry — resolvable is queued ahead of it");
  assert.match(forGhost.resolution, /doesn't resolve here either/i, "must still surface that ghost's own `to` doesn't resolve, once information the pre-#59 code always showed");
  assert.match(forGhost.resolution, /drop-only/i, "stays drop-only — but must not claim this is forever (a fresh detection run can still supersede it)");
  assert.match(forGhost.resolution, /fresh detection run|fresh match/i, "must not contradict the ordinary withheld wording's own \"wait for a fresh match to supersede it\" — withheld isn't permanent");
  assert.doesNotMatch(forGhost.resolution, /accepted or rejected the normal way|can be accepted/i, "must not promise ghost becomes freely actionable — it stays drop-only even once first in line");
});

test("commitRepairEscalations: a duplicate-id queue's second live entry never advertises --apply --only/--drop <id> as acting on IT, when neither command actually reaches it (#59)", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const first = { id: "dec_a", from: "sha_a_old", to: "sha_first" };
  const second = { id: "dec_a", from: "sha_a_old", to: "sha_second" };
  const items = commitRepairEscalations([first, second], decs);
  assert.equal(items.length, 2);
  const forFirst = items.find((i) => i.detail === "sha_a_old → sha_first")!;
  const forSecond = items.find((i) => i.detail === "sha_a_old → sha_second")!;
  assert.match(forFirst.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the first-queued match keeps the ordinary, working wording");
  assert.match(forFirst.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "and the ordinary --drop wording, which IS actionable against it");
  assert.doesNotMatch(forSecond.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "--apply --only would apply the FIRST entry, not this one");
  assert.doesNotMatch(forSecond.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "--drop would tombstone the FIRST entry, not this one");
  assert.match(forSecond.resolution, /hunch repair-provenance --apply --only dec_a/, "gives the copy-pasteable command for the entry actually ahead of it, not just prose");
  assert.match(forSecond.resolution, /hunch repair-provenance --drop dec_a/);
  assert.match(forSecond.question, /queued replacement candidate/);
});

test("commitRepairEscalations: the losing duplicate's resolution must not claim applying the winner brings IT back — applying retires it as stale (the decision moves past their shared `from`); only dropping the winner does", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const first = { id: "dec_a", from: "sha_a_old", to: "sha_first" };
  const second = { id: "dec_a", from: "sha_a_old", to: "sha_second" };
  const items = commitRepairEscalations([first, second], decs);
  const forSecond = items.find((i) => i.detail === "sha_a_old → sha_second")!;
  assert.doesNotMatch(forSecond.resolution, /resolving that entry \(apply or drop it\) brings this one back/i, "applying the winner moves the decision's `commit` past `from` — deadRewrites then prunes the loser as stale on the NEXT run, it is never reconsidered");
  assert.match(forSecond.resolution, /drop.*brings this one back|brings this one back.*drop/is, "only dropping the winner (not applying it) actually returns this entry to consideration");
  assert.match(forSecond.resolution, /retire|stale/i, "must say what applying the winner actually does to this entry (retires it), not just what dropping does");
});

test("commitRepairEscalations: a THIRD duplicate entry gets the same non-actionable wording, and it isn't described as merely 'a second' candidate", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const e1 = { id: "dec_a", from: "sha_a_old", to: "sha_1" };
  const e2 = { id: "dec_a", from: "sha_a_old", to: "sha_2" };
  const e3 = { id: "dec_a", from: "sha_a_old", to: "sha_3" };
  const items = commitRepairEscalations([e1, e2, e3], decs);
  assert.equal(items.length, 3);
  const for3 = items.find((i) => i.detail === "sha_a_old → sha_3")!;
  assert.doesNotMatch(for3.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(for3.question, /a second queued replacement candidate/i, "there are two entries ahead of it, not one — 'second' would misdescribe its position");
});

test("commitRepairEscalations: a three-way duplicate (withheld, withheld, resolvable) — drop-target/apply-target/neither all coexist, each getting its own distinct wording", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const ghost1 = { id: "dec_a", from: "sha_a_old", to: "sha_ghost1" };
  const ghost2 = { id: "dec_a", from: "sha_a_old", to: "sha_ghost2" };
  const resolvable = { id: "dec_a", from: "sha_a_old", to: "sha_real" };
  const items = commitRepairEscalations([ghost1, ghost2, resolvable], decs, decs, new Set([ghost1, ghost2]));
  assert.equal(items.length, 3);
  const forGhost1 = items.find((i) => i.detail === "sha_a_old → sha_ghost1")!;
  const forGhost2 = items.find((i) => i.detail === "sha_a_old → sha_ghost2")!;
  const forResolvable = items.find((i) => i.detail === "sha_a_old → sha_real")!;
  // ghost1 is the absolute first survivor — the genuine --drop target — and withheld,
  // so it keeps the ordinary withheld wording unchanged.
  assert.match(forGhost1.question, /doesn't resolve in this repository/);
  assert.match(forGhost1.resolution, /--drop dec_a/);
  assert.doesNotMatch(forGhost1.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  // ghost2 is neither the drop target (ghost1 is) nor the apply target (also withheld,
  // so excluded from `applicable` too) — the "neither" branch, with the withheld caveat.
  assert.doesNotMatch(forGhost2.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forGhost2.resolution, /^hunch repair-provenance --drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/);
  assert.match(forGhost2.resolution, /doesn't resolve here either/i);
  // resolvable is the first NON-withheld survivor, so --apply --only genuinely reaches it,
  // even though it's third in queue order — but --drop dec_a still targets ghost1.
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/);
});

test("commitRepairEscalations: which entry is 'first' for a duplicate id follows the queue's post-prune order, not raw array order — a dead first sibling doesn't make the live survivor look like a duplicate (#59)", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const deadFirst = { id: "dec_a", from: "sha_stale", to: "sha_dead_target" }; // from mismatches the decision's commit — deadRewrites prunes this before --apply/--drop ever run
  const liveSecond = { id: "dec_a", from: "sha_a_old", to: "sha_live" };
  const items = commitRepairEscalations([deadFirst, liveSecond], decs);
  assert.equal(items.length, 1, "the dead entry never asks anything — liveRewrites excludes it");
  assert.match(items[0]!.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the CLI prunes deadFirst before --drop/--apply ever consult the queue, so liveSecond IS what they'd act on — must not read as a duplicate stuck behind a phantom sibling");
});

test("commitRepairEscalations: which entry is 'first' for a duplicate id follows queue order, not the order liveRewrites happens to return", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const earlier = { id: "dec_a", from: "sha_a_old", to: "sha_earlier" };
  const later = { id: "dec_a", from: "sha_a_old", to: "sha_later" };
  const items = commitRepairEscalations([later, earlier], decs); // later queued first this time
  const forLater = items.find((i) => i.detail === "sha_a_old → sha_later")!;
  const forEarlier = items.find((i) => i.detail === "sha_a_old → sha_earlier")!;
  assert.match(forLater.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "whichever entry is first in the queue array wins, regardless of its `to`");
  assert.doesNotMatch(forEarlier.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
});

test("commitRepairEscalations: a duplicate-id queue's non-actionable follower (neither drop-target nor apply-target) is flagged actionable:false (#61)", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const first = { id: "dec_a", from: "sha_a_old", to: "sha_first" };
  const second = { id: "dec_a", from: "sha_a_old", to: "sha_second" };
  const items = commitRepairEscalations([first, second], decs);
  const forFirst = items.find((i) => i.detail === "sha_a_old → sha_first")!;
  const forSecond = items.find((i) => i.detail === "sha_a_old → sha_second")!;
  assert.deepEqual(actionableEscalations(items), [forFirst], "only the genuine drop-target/apply-target passes the filter — resolving it requires acting on a different entry first, so `forSecond` must not gate on this row itself");
});

test("commitRepairEscalations: an ordinary, non-duplicate entry is actionable (field left true/undefined)", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const items = commitRepairEscalations([{ id: "dec_1", from: "sha_old", to: "sha_new" }], decs);
  assert.deepEqual(actionableEscalations(items), items);
});

test("commitRepairEscalations: a withheld entry that IS the drop-target stays actionable — only the drop-only wording changes, not the actionable flag", () => {
  const decs = [D({ id: "dec_1", title: "Add the feature", commit: "sha_old" })];
  const entry = { id: "dec_1", from: "sha_old", to: "sha_ghost" };
  const items = commitRepairEscalations([entry], decs, decs, new Set([entry]));
  assert.deepEqual(actionableEscalations(items), items);
});

test("commitRepairEscalations: a three-way duplicate — only the middle (neither drop- nor apply-target) entry is actionable:false; the drop-target and apply-target both stay actionable", () => {
  const decs = [D({ id: "dec_a", title: "Decision A", commit: "sha_a_old" })];
  const ghost1 = { id: "dec_a", from: "sha_a_old", to: "sha_ghost1" };
  const ghost2 = { id: "dec_a", from: "sha_a_old", to: "sha_ghost2" };
  const resolvable = { id: "dec_a", from: "sha_a_old", to: "sha_real" };
  const items = commitRepairEscalations([ghost1, ghost2, resolvable], decs, decs, new Set([ghost1, ghost2]));
  const forGhost1 = items.find((i) => i.detail === "sha_a_old → sha_ghost1")!;
  const forGhost2 = items.find((i) => i.detail === "sha_a_old → sha_ghost2")!;
  const forResolvable = items.find((i) => i.detail === "sha_a_old → sha_real")!;
  assert.deepEqual(actionableEscalations(items), [forGhost1, forResolvable], "the drop-target and the apply-target pass; the middle entry (neither) is filtered out");
});

test("pendingEscalations: a topic-conflict entry is always actionable (only commit-repair followers ever set actionable:false)", () => {
  const decs = [D({ id: "dec_a", topic: "store.writes" }), D({ id: "dec_b", topic: "store.writes" })];
  const items = pendingEscalations(decs);
  assert.deepEqual(actionableEscalations(items), items);
});

test("actionableEscalations: drops only entries explicitly marked actionable:false, preserving order", () => {
  const a: Escalation = { kind: "commit-repair-pending", topic: "dec_a", decisionIds: ["dec_a"], question: "q-a", detail: "d-a", resolution: "r-a" };
  const b: Escalation = { kind: "commit-repair-pending", topic: "dec_b", decisionIds: ["dec_b"], question: "q-b", detail: "d-b", resolution: "r-b", actionable: false };
  const c: Escalation = { kind: "commit-repair-pending", topic: "dec_c", decisionIds: ["dec_c"], question: "q-c", detail: "d-c", resolution: "r-c" };
  assert.deepEqual(actionableEscalations([a, b, c]), [a, c]);
});

test("actionableEscalations: an empty list stays empty", () => {
  assert.deepEqual(actionableEscalations([]), []);
});

test("summarizeEscalations: splits a mixed list into its actionable subset and a context count of the rest", () => {
  const a: Escalation = { kind: "commit-repair-pending", topic: "dec_a", decisionIds: ["dec_a"], question: "q-a", detail: "d-a", resolution: "r-a" };
  const b: Escalation = { kind: "commit-repair-pending", topic: "dec_b", decisionIds: ["dec_b"], question: "q-b", detail: "d-b", resolution: "r-b", actionable: false };
  const summary = summarizeEscalations([a, b]);
  assert.deepEqual(summary.actionable, [a]);
  assert.equal(summary.context, 1);
});

test("summarizeEscalations: an all-actionable list has a zero context count", () => {
  const a: Escalation = { kind: "commit-repair-pending", topic: "dec_a", decisionIds: ["dec_a"], question: "q-a", detail: "d-a", resolution: "r-a" };
  const summary = summarizeEscalations([a]);
  assert.deepEqual(summary.actionable, [a]);
  assert.equal(summary.context, 0);
});

test("summarizeEscalations: an empty list summarizes to nothing actionable and zero context", () => {
  const summary = summarizeEscalations([]);
  assert.deepEqual(summary.actionable, []);
  assert.equal(summary.context, 0);
});

test("escalationHeadline (cli audience): an all-actionable list omits the context suffix", () => {
  const a: Escalation = { kind: "commit-repair-pending", topic: "dec_a", decisionIds: ["dec_a"], question: "q-a", detail: "d-a", resolution: "r-a" };
  assert.equal(escalationHeadline([a], "cli"), "1 decision(s) need your call — asked here, never decided for you:");
});

test("escalationHeadline (cli audience): a context remainder is appended, not gating", () => {
  const a: Escalation = { kind: "commit-repair-pending", topic: "dec_a", decisionIds: ["dec_a"], question: "q-a", detail: "d-a", resolution: "r-a" };
  const b: Escalation = { kind: "commit-repair-pending", topic: "dec_b", decisionIds: ["dec_b"], question: "q-b", detail: "d-b", resolution: "r-b", actionable: false };
  assert.equal(escalationHeadline([a, b], "cli"), "1 decision(s) need your call — asked here, never decided for you (+1 shown below for context only, not gating):");
});

test("escalationHeadline (mcp audience): same shape, distinct wording from the CLI audience", () => {
  const a: Escalation = { kind: "commit-repair-pending", topic: "dec_a", decisionIds: ["dec_a"], question: "q-a", detail: "d-a", resolution: "r-a" };
  const b: Escalation = { kind: "commit-repair-pending", topic: "dec_b", decisionIds: ["dec_b"], question: "q-b", detail: "d-b", resolution: "r-b", actionable: false };
  assert.equal(escalationHeadline([a, b], "mcp"), "1 decision(s) need the human's call — ask each inline, don't decide it for them (+1 shown below for context only, not a decision):");
});

test("escalationHeadline: a list with nothing actionable (no real producer emits this today, per commitRepairEscalations' own invariant, but the field's contract allows it) falls back to the neutral branch", () => {
  const b: Escalation = { kind: "commit-repair-pending", topic: "dec_b", decisionIds: ["dec_b"], question: "q-b", detail: "d-b", resolution: "r-b", actionable: false };
  assert.equal(escalationHeadline([b], "cli"), "Nothing needs your decision right now — 1 entry shown below for context only (resolving another entry will clear them):");
  assert.equal(escalationHeadline([b, b], "mcp"), "Nothing needs the human's call right now — 2 entries shown below for context only (resolving another entry will clear them):");
});
