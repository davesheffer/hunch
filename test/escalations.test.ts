import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingEscalations, policyEscalations, commitRepairEscalations, actionableEscalations, summarizeEscalations, escalationHeadline, relevantEscalations, type Escalation, type PolicyLite } from "../src/core/escalations.js";
import type { Decision } from "../src/core/types.js";

const D = (over: Partial<Decision> & { id: string }): Decision => ({
  id: over.id, title: over.title ?? `title ${over.id}`, decision: "did a thing",
  status: over.status ?? "accepted", topic: over.topic ?? null,
  superseded_by: over.superseded_by ?? null, valid_to: over.valid_to ?? null,
@@CLEANROOM_HOLE_1@@
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
@@CLEANROOM_HOLE_2@@
  assert.match(items[0]!.resolution, /--apply --only dec_1 --expect sha256:[a-f0-9]{64} to accept/);
@@CLEANROOM_HOLE_3@@
  assert.doesNotMatch(items[0]!.resolution, /--apply --only dec_1 --expect sha256:[a-f0-9]{64} to accept/, "must never advertise an action that's guaranteed to no-op forever");
@@CLEANROOM_HOLE_4@@
  assert.match(forB.resolution, /--apply --only dec_b --expect sha256:[a-f0-9]{64} to accept/);
@@CLEANROOM_HOLE_5@@
  assert.doesNotMatch(forGhost.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "never claims --apply works for a withheld entry");
@@CLEANROOM_HOLE_6@@
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "--apply --only skips the withheld sibling ahead of it and reaches this entry");
  assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "the ordinary --drop wording would be wrong here — --drop dec_a actually tombstones ghost");
@@CLEANROOM_HOLE_7@@
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the resolvable sibling is both the drop-target and the apply-target — ordinary wording");
@@CLEANROOM_HOLE_8@@
  assert.doesNotMatch(forGhost.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forGhost.resolution, /^hunch repair-provenance --drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "must not claim --drop dec_a targets THIS entry — resolvable is queued ahead of it");
@@CLEANROOM_HOLE_9@@
  assert.match(forFirst.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the first-queued match keeps the ordinary, working wording");
  assert.match(forFirst.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "and the ordinary --drop wording, which IS actionable against it");
  assert.doesNotMatch(forSecond.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "--apply --only would apply the FIRST entry, not this one");
  assert.doesNotMatch(forSecond.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/, "--drop would tombstone the FIRST entry, not this one");
@@CLEANROOM_HOLE_10@@
  assert.doesNotMatch(for3.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
@@CLEANROOM_HOLE_11@@
  assert.doesNotMatch(forGhost1.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
@@CLEANROOM_HOLE_12@@
  assert.doesNotMatch(forGhost2.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forGhost2.resolution, /^hunch repair-provenance --drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/);
@@CLEANROOM_HOLE_13@@
  assert.match(forResolvable.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
  assert.doesNotMatch(forResolvable.resolution, /--drop dec_a --expect sha256:[a-f0-9]{64} to reject it \(tombstoned durably/);
@@CLEANROOM_HOLE_14@@
  assert.match(items[0]!.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "the CLI prunes deadFirst before --drop/--apply ever consult the queue, so liveSecond IS what they'd act on — must not read as a duplicate stuck behind a phantom sibling");
@@CLEANROOM_HOLE_15@@
  assert.match(forLater.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/, "whichever entry is first in the queue array wins, regardless of its `to`");
  assert.doesNotMatch(forEarlier.resolution, /--apply --only dec_a --expect sha256:[a-f0-9]{64} to accept/);
@@CLEANROOM_HOLE_16@@

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
