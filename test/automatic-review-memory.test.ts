import { test } from "node:test";
import assert from "node:assert/strict";
import { automateReviewMemory } from "../src/core/automaticReviewMemory.js";
import { prepareReviewMemory } from "../src/core/reviewMemory.js";

const now = "2026-09-10T00:00:00Z";
const code = "export function auth(tenant) { if (!tenant) throw new Error('missing tenant'); }";
const comment = (id = 1, body = "Missing tenant must fail validation.") => ({ id, path: "src/auth.ts", body,
  html_url: `https://github.com/acme/app/pull/1#discussion_r${id}`, commit_id: "a".repeat(40),
  created_at: now, updated_at: now, user: { login: "alice", type: "User" } });
const packet = prepareReviewMemory("acme/app", [comment()]);
const proposal = { action: "accept", reason: "The current code requires tenant context.",
  rule: "Missing tenant must fail validation.", check: "Pass no tenant and assert that auth throws.",
  comment_id: 1, review_quote: "Missing tenant must fail validation.", code_quote: "if (!tenant) throw new Error('missing tenant');" };
const verdict = { supported: true, reusable: true, current: true, checkable: true, no_conflict: true,
  reason: "The full discussion and current code both support this behavior." };
function run(responses: unknown[], extra: Partial<Parameters<typeof automateReviewMemory>[0]> = {}) {
  const prompts: string[] = [];
  const result = automateReviewMemory({ packet, existing: [], readCurrent: () => code,
    provider: "fixture", limit: 20, now, generate: async p => {
      prompts.push(p);
      assert.ok(responses.length, "unexpected provider call");
      return JSON.stringify(responses.shift());
    }, ...extra });
  return { result, prompts };
}

test("automatic rules have exact evidence, two passes, and no blocking authority", async () => {
  const { result, prompts } = run([proposal, verdict]);
  const report = await result;
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /UNTRUSTED DATA/);
  assert.match(prompts[1]!, /Independently audit/);
  const rule = report.rules[0]!;
  assert.equal(report.entries[0]!.status, "ready");
  assert.equal(rule.severity, "warning");
  assert.equal(rule.provenance.source, "agent_recorded");
  assert.equal(rule.provenance.confidence, 0.65);
  assert.equal(rule.match, null);
  assert.equal(rule.forbids, null);
  assert.deepEqual(rule.scope, ["src/auth.ts"]);
  assert.ok(rule.provenance.evidence.includes(packet.candidates[0]!.evidence_hash));
  assert.ok(rule.provenance.evidence.some(e => e.startsWith("code:")));
  assert.match(rule.rationale, /not human approved/);
});

test("replay preserves existing and retired rules; changed threads need explicit review", async () => {
  const initial = await run([proposal, verdict]).result;
  const existing = initial.rules;
  existing[0]!.status = "retired";
  const replay = run([], { existing });
  assert.equal((await replay.result).entries[0]!.status, "skipped");
  assert.equal(replay.prompts.length, 0);
  const changed = prepareReviewMemory("acme/app", [comment(1, "This advice has now changed completely.")]);
  const report = await run([], { existing, packet: changed }).result;
  assert.equal(report.entries[0]!.status, "review");
  assert.equal(report.rules.length, 0);
});

test("fabricated supporting quotes cannot create a rule", async () => {
  for (const bad of [{ ...proposal, review_quote: "An invented review quote." },
    { ...proposal, code_quote: "an invented code fragment" }, { ...proposal, comment_id: 999 }]) {
    const { result, prompts } = run([bad]);
    assert.equal((await result).rules.length, 0);
    assert.equal(prompts.length, 1);
  }
});

test("each skeptical rejection withholds the rule including semantic conflicts", async () => {
  for (const key of ["supported", "reusable", "current", "checkable", "no_conflict"]) {
    const report = await run([proposal, { ...verdict, [key]: false }]).result;
    assert.equal(report.rules.length, 0);
    assert.equal(report.entries[0]!.status, "review");
  }
});

test("invalid output and provider failures become review entries, never promoted or echoed", async () => {
  for (const generate of [async () => "not JSON", async () => { throw new Error("SECRET"); },
    async () => JSON.stringify({ ...proposal, severity: "blocking" })]) {
    const report = await run([], { generate }).result;
    assert.equal(report.rules.length, 0);
    assert.equal(report.entries[0]!.status, "review");
    assert.ok(!JSON.stringify(report).includes("SECRET"));
  }
});

test("bounded analysis keeps deferred work visible and includes full replies", async () => {
  const reply = { ...comment(3, "Actually that requirement was rejected."), in_reply_to_id: 1 };
  const multi = prepareReviewMemory("acme/app", [comment(), comment(2), reply]);
  const { result, prompts } = run([{ action: "review", reason: "The replies reject the original requirement." }], { packet: multi, limit: 1 });
  const report = await result;
  assert.equal(report.analyzed, 1);
  assert.match(prompts[0]!, /Actually that requirement was rejected/);
  assert.equal(report.entries.filter(e => e.status === "deferred").length, 1);
});

test("missing and oversized code cause no provider calls", async () => {
  for (const readCurrent of [() => { throw new Error("missing"); }, () => "x".repeat(65537)]) {
    const { result, prompts } = run([], { readCurrent });
    assert.equal((await result).rules.length, 0);
    assert.equal(prompts.length, 0);
  }
});

test("existing scoped rules enter the audit; duplicate ids never overwrite", async () => {
  const initial = await run([proposal, verdict]).result;
  const existing = initial.rules;
  existing[0]!.provenance.evidence = [];
  const { result, prompts } = run([proposal, verdict], { existing });
  assert.equal((await result).rules.length, 0);
  assert.match(prompts[1]!, new RegExp(existing[0]!.id));
});

test("cached dispositions do not consume the run limit; changed code triggers a new analysis", async () => {
  const first = await run([{ action: "skip", reason: "This is only a one-off implementation suggestion." }]).result;
  const replay = run([], { previous: first.entries, limit: 1 });
  const cached = await replay.result;
  assert.equal(cached.analyzed, 0);
  assert.equal(cached.entries[0]!.cached, true);
  assert.equal(replay.prompts.length, 0);
  const changed = await run([{ action: "review", reason: "Current implementation has changed substantially." }],
    { previous: first.entries, readCurrent: () => code + "\n// modified" }).result;
  assert.equal(changed.analyzed, 1);
  assert.equal(changed.entries[0]!.cached, undefined);
});

test("changed code on an already captured rule is surfaced without overwriting", async () => {
  const first = await run([proposal, verdict]).result;
  const result = await run([], { existing: first.rules, readCurrent: () => code + "\n// changed" }).result;
  assert.equal(result.entries[0]!.status, "review");
  assert.match(result.entries[0]!.reason, /code changed/);
  assert.equal(result.rules.length, 0);
});
