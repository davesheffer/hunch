import { test } from "node:test";
import assert from "node:assert/strict";
import { automateReviewMemory } from "../src/core/automaticReviewMemory.js";
import { fetchPullDiscussions } from "../src/cli/automaticReviewMemory.js";
import { compileReviewRules, prepareReviewMemory, pullDiscussionsFromGraphql, validateReviewPacket } from "../src/core/reviewMemory.js";

const now = "2026-09-10T00:00:00Z";
const code = "export function auth(tenant) { if (!tenant) throw new Error('missing tenant'); }";
const author = (login = "alice", __typename = "User") => ({ login, __typename });
const node = (over: Record<string, unknown> = {}) => ({
  number: 7,
  comments: { totalCount: 2, nodes: [
    { databaseId: 11, body: "Missing tenant must fail validation; we rejected a silent default.",
      url: "https://github.com/acme/app/pull/7#issuecomment-11", createdAt: now, updatedAt: now, author: author() },
    { databaseId: 12, body: "Preview deployed.", url: "https://github.com/acme/app/pull/7#issuecomment-12",
      createdAt: now, updatedAt: now, author: author("vercel", "Bot") },
  ] },
  reviews: { totalCount: 2, nodes: [
    { databaseId: 21, body: "", url: "https://github.com/acme/app/pull/7#pullrequestreview-21", createdAt: now, updatedAt: now,
      commit: { oid: "b".repeat(40) }, author: author("bob") },
    { databaseId: 22, body: "Agreed, keep the throw.", url: "https://github.com/acme/app/pull/7#pullrequestreview-22",
      createdAt: now, updatedAt: now, commit: { oid: "b".repeat(40) }, author: null },
  ] },
  files: { totalCount: 2, nodes: [{ path: "src/auth.ts" }, { path: "src/[id].ts" }] },
  ...over,
});
const pages = (...nodes: unknown[]) => [{ data: { repository: { pullRequests: { nodes } } } }];
const input = (...nodes: unknown[]) => ({ review_comments: [], ...pullDiscussionsFromGraphql(pages(...nodes)) });

test("GraphQL pull discussions normalize conversation comments and non-empty review bodies", () => {
  const { pull_requests, incomplete_discussions } = pullDiscussionsFromGraphql(pages(node(),
    node({ number: 8, comments: { totalCount: 101, nodes: [] } })));
  assert.equal(incomplete_discussions, 1);
  assert.equal(pull_requests.length, 1);
  const pr = pull_requests[0] as { number: number; files: string[]; entries: { id: number; kind: string; user: { login: string; type: string } }[] };
  assert.equal(pr.number, 7);
  // Glob-like paths cannot become literal rule scopes.
  assert.deepEqual(pr.files, ["src/auth.ts"]);
  assert.deepEqual(pr.entries.map(e => [e.kind, e.id]), [["comment", 11], ["comment", 12], ["review", 22]]);
  assert.deepEqual(pr.entries[2]!.user, { login: "ghost", type: "User" });
});

test("conversation discussions become PR-level candidates with bots excluded", () => {
  const packet = prepareReviewMemory("acme/app", input(node()));
  assert.equal(packet.candidates.length, 0);
  assert.equal(packet.discussions!.length, 1);
  const discussion = packet.discussions![0]!;
  assert.equal(discussion.id, "review_pr_7");
  assert.deepEqual(discussion.entries.map(e => e.id), [11, 22]);
  assert.equal(packet.excluded_bots, 1);
  assert.equal(packet.incomplete_discussions, 0);
  assert.deepEqual(validateReviewPacket(packet), packet);
  const tampered = structuredClone(packet);
  tampered.discussions![0]!.entries[0]!.body = "Tenant may be omitted.";
  assert.throws(() => validateReviewPacket(tampered), /changed/);
});

test("discussion entries must belong to the named pull request", () => {
  const foreign = node();
  foreign.comments.nodes[0]!.url = "https://github.com/acme/app/pull/8#issuecomment-11";
  assert.throws(() => prepareReviewMemory("acme/app", input(foreign)), /does not belong/);
  const wrongId = node();
  wrongId.comments.nodes[0]!.url = "https://github.com/acme/app/pull/7#issuecomment-99";
  assert.throws(() => prepareReviewMemory("acme/app", input(wrongId)), /does not belong/);
});

test("PR-level rules must scope to one of the pull request's files", () => {
  const packet = prepareReviewMemory("acme/app", input(node()));
  const d = packet.discussions![0]!;
  const selection = { candidate_id: d.id, evidence_hash: d.evidence_hash, rule: "Missing tenant must fail validation.",
    check: "Call auth without a tenant and assert it throws." };
  assert.throws(() => compileReviewRules(packet, [selection], now), /file/);
  assert.throws(() => compileReviewRules(packet, [{ ...selection, file: "src/other.ts" }], now), /file/);
  const [rule] = compileReviewRules(packet, [{ ...selection, file: "src/auth.ts" }], now);
  assert.deepEqual(rule!.scope, ["src/auth.ts"]);
  assert.ok(rule!.provenance.evidence.includes("https://github.com/acme/app/pull/7#issuecomment-11"));
  assert.ok(rule!.provenance.evidence.includes(`git:${"b".repeat(40)}`));
});

const locate = { action: "locate", file: "src/auth.ts", reason: "The tenant check lives in the auth module." };
const proposal = { action: "accept", reason: "The current code requires tenant context.",
  rule: "Missing tenant must fail validation.", check: "Pass no tenant and assert that auth throws.",
  comment_id: 11, review_quote: "Missing tenant must fail validation", code_quote: "if (!tenant) throw new Error('missing tenant');" };
const verdict = { supported: true, reusable: true, current: true, checkable: true, no_conflict: true,
  reason: "The discussion and current code both support this behavior." };
function run(responses: unknown[], extra: Partial<Parameters<typeof automateReviewMemory>[0]> = {}) {
  const prompts: string[] = [];
  const reads: string[] = [];
  const result = automateReviewMemory({ packet: prepareReviewMemory("acme/app", input(node())), existing: [],
    readCurrent: file => { reads.push(file); if (file !== "src/auth.ts") throw new Error("missing"); return code; },
    provider: "fixture", limit: 20, now, generate: async p => {
      prompts.push(p);
      assert.ok(responses.length, "unexpected provider call");
      return JSON.stringify(responses.shift());
    }, ...extra });
  return { result, prompts, reads };
}

test("conversation-tab rationale is located, drafted, verified and scoped to the chosen file", async () => {
  const { result, prompts } = run([locate, proposal, verdict]);
  const report = await result;
  assert.equal(prompts.length, 3);
  assert.match(prompts[0]!, /UNTRUSTED DATA/);
  assert.match(prompts[0]!, /src\/auth\.ts/);
  assert.match(prompts[2]!, /Independently audit/);
  assert.equal(report.entries[0]!.candidate_id, "review_pr_7");
  assert.equal(report.entries[0]!.status, "ready");
  assert.equal(report.entries[0]!.file, "src/auth.ts");
  const rule = report.rules[0]!;
  assert.deepEqual(rule.scope, ["src/auth.ts"]);
  assert.ok(rule.provenance.evidence.includes("review_pr_7"));
  assert.ok(rule.provenance.evidence.some(e => e.startsWith("code:")));
  assert.equal(rule.provenance.confidence, 0.65);
});

test("a located file outside the pull request, or a fabricated quote, withholds the rule", async () => {
  for (const responses of [[{ ...locate, file: "src/other.ts" }], [locate, { ...proposal, review_quote: "An invented review quote." }],
    [locate, { ...proposal, comment_id: 12 }]]) {
    const report = await run(responses).result;
    assert.equal(report.rules.length, 0);
    assert.equal(report.entries[0]!.status, "review");
  }
});

test("discussion replay: cached dispositions and captured rules cost no provider calls", async () => {
  const first = await run([{ action: "skip", reason: "Only a deployment notice and agreement, no durable rule." }]).result;
  assert.equal(first.entries[0]!.status, "skipped");
  const replay = run([], { previous: first.entries });
  assert.equal((await replay.result).entries[0]!.cached, true);
  assert.equal(replay.prompts.length, 0);
  const saved = await run([locate, proposal, verdict]).result;
  const again = run([], { existing: saved.rules });
  const report = await again.result;
  assert.equal(report.entries[0]!.status, "skipped");
  assert.equal(again.prompts.length, 0);
  const changed = await run([], { existing: saved.rules, readCurrent: () => code + "\n// changed" }).result;
  assert.equal(changed.entries[0]!.status, "review");
  assert.match(changed.entries[0]!.reason, /code changed/);
});

test("a pull request with more files than one page is reported incomplete, never sliced", () => {
  const files = { totalCount: 101, nodes: Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` })) };
  const { pull_requests, incomplete_discussions } = pullDiscussionsFromGraphql(pages(node({ files })));
  assert.equal(incomplete_discussions, 1);
  assert.equal(pull_requests.length, 0);
});

test("the run report surfaces incomplete discussions", async () => {
  const packet = prepareReviewMemory("acme/app", input(node({ number: 8, comments: { totalCount: 101, nodes: [] } })));
  const report = await automateReviewMemory({ packet, existing: [], readCurrent: () => code, provider: "fixture",
    limit: 20, now, generate: async () => assert.fail("no candidate to analyze") });
  assert.equal(report.incomplete_discussions, 1);
});

test("locate-stage dispositions that depend on current files stay retryable", async () => {
  const unreadable = await run([], { readCurrent: () => { throw new Error("missing"); } }).result;
  assert.match(unreadable.entries[0]!.reason, /None of the pull request's files/);
  assert.equal(unreadable.entries[0]!.retryable, true);
  const later = await run([locate, proposal, verdict], { previous: unreadable.entries }).result;
  assert.equal(later.entries[0]!.status, "ready");
  const outside = await run([{ ...locate, file: "src/other.ts" }]).result;
  assert.equal(outside.entries[0]!.retryable, true);
});

test("the discussion fetch passes owner and name as strings", () => {
  const calls: string[][] = [];
  const result = fetchPullDiscussions("acme/2048", args => { calls.push(args); return JSON.stringify(pages(node())); });
  assert.equal(result.pull_requests.length, 1);
  const args = calls[0]!;
  assert.ok(!args.includes("-F"));
  assert.equal(args[args.indexOf("owner=acme") - 1], "-f");
  assert.equal(args[args.indexOf("name=2048") - 1], "-f");
  assert.match(args.find(a => a.startsWith("query="))!, /files\(first:100\)\{totalCount/);
});

test("inline-only packets keep their existing shape", () => {
  const packet = prepareReviewMemory("acme/app", []);
  assert.equal("discussions" in packet, false);
});
