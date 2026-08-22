import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  extractJsonObjects,
  decisionDraftFromText,
  bugDraftFromText,
  type SynthProvider,
  type CommitInput,
  type FailureInput,
} from "../src/synthesis/provider.js";
import { draftDecisionSafe, draftBugSafe, shouldPromoteConstraint } from "../src/synthesis/synthesize.js";

// ---------------------------------------------------------------------------
// extractJson / extractJsonObjects — robust, string-aware extraction.
// ---------------------------------------------------------------------------

test("extractJson keeps braces/quotes INSIDE string values (regression: depth counter closed early)", () => {
  const obj = extractJson('{"decision": "guard the } brace and { the other", "context": "ok"}');
  assert.equal(obj!.decision, "guard the } brace and { the other");
  assert.equal(obj!.context, "ok");
});

test("extractJson handles escaped quotes and a trailing escaped backslash before the closing quote", () => {
  assert.equal(extractJson('{"decision": "she said \\"hi\\" then left"}')!.decision, 'she said "hi" then left');
  // value is `path C:\` — the \\ must not escape the closing quote
  assert.equal(extractJson('{"decision":"path C:\\\\"}')!.decision, "path C:\\");
});

test("extractJson digs the object out of a prose + code-fence wrapper", () => {
  const obj = extractJson('Sure, here it is:\n```json\n{"decision": "x", "context": "y"}\n```\nHope that helps!');
  assert.equal(obj!.decision, "x");
});

test("extractJson tolerates trailing commas (string-aware lenient pass)", () => {
  const obj = extractJson('{"decision": "x", "consequences": ["a", "b",],}');
  assert.deepEqual(obj!.consequences, ["a", "b"]);
});

test("lenient trailing-comma pass does NOT mutate a comma inside a string value (regression: string-blind regex)", () => {
  // real trailing comma forces the lenient pass; a string value containing ',}' / ',]' must survive
  assert.equal(extractJson('{"decision":"ends ,}", "context":"ok",}')!.decision, "ends ,}");
  assert.equal(extractJson('{"decision":"see list ,]", "context":"y",}')!.decision, "see list ,]");
});

test("extractJson returns null for prose-only / no object / array / truncated", () => {
  assert.equal(extractJson("I'm sorry, I can't help with that."), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("[1, 2, 3]"), null, "a top-level array is not a decision object");
  assert.equal(extractJson('{"decision": "x"'), null, "truncated/unbalanced → null");
});

test("extractJsonObjects returns every top-level object; extractJson returns the first", () => {
  const objs = extractJsonObjects('{"decision":"first"} then {"decision":"second"}');
  assert.equal(objs.length, 2);
  assert.equal(objs[0]!.decision, "first");
  assert.equal(extractJson('{"decision":"first"} then {"decision":"second"}')!.decision, "first");
});

test("a stray '{...}' fragment in prose is skipped, not mistaken for the answer", () => {
  // "{core}" is balanced but unparseable → filtered; the real object still wins
  const objs = extractJsonObjects("Refactored the {core} module. Final answer:\n{\"decision\":\"split core\"}");
  assert.equal(objs.length, 1);
  assert.equal(objs[0]!.decision, "split core");
});

test("a truncated wrapper does NOT leak its nested child as a top-level object (regression R2)", () => {
  // outer brace never closes; a complete nested object lives inside
  const t = '{"decision":"REAL","metadata":{"decision":"LEAK","context":"x"}';
  assert.deepEqual(extractJsonObjects(t), [], "no top-level object → fall back, don't mine the interior");
  assert.equal(extractJson(t), null);
  // but a genuinely balanced nested object is still read fine
  assert.equal(extractJson('{"decision":"REAL","meta":{"x":1}}')!.decision, "REAL");
});

// ---------------------------------------------------------------------------
// decisionDraftFromText — only "llm_draft" with real substance; last wins.
// ---------------------------------------------------------------------------

test("decisionDraftFromText maps a substantive object to an llm_draft", () => {
  const d = decisionDraftFromText(
    '{"title": "Use Redis sessions", "context": "need revocation", "decision": "store in Redis", "consequences": ["adds dep"], "alternatives_rejected": ["JWT-only"], "nontrivial": true}',
    "feat: sessions",
  );
  assert.equal(d!.title, "Use Redis sessions");
  assert.equal(d!.decision, "store in Redis");
  assert.deepEqual(d!.consequences, ["adds dep"]);
  assert.equal(d!.source, "llm_draft");
  assert.equal(d!.confidence, 0.65, "nontrivial → higher of the two LLM tiers");
});

test("decisionDraftFromText prefers the real answer over a leading template/example object", () => {
  const text =
    '{"title":"<imperative>","context":"<why>","decision":"<what>"}\n' +
    '{"title":"Adopt Redis","context":"need revocation","decision":"store sessions in Redis","nontrivial":true}';
  const d = decisionDraftFromText(text, "feat: x");
  assert.equal(d!.decision, "store sessions in Redis", "the filled-in answer, not the placeholder");
  assert.equal(d!.confidence, 0.65);
});

test("decisionDraftFromText coerces a stringified boolean: nontrivial=\"false\" stays the LOW tier", () => {
  assert.equal(decisionDraftFromText('{"decision":"x","nontrivial":"false"}', "t")!.confidence, 0.4);
  assert.equal(decisionDraftFromText('{"decision":"x","nontrivial":"true"}', "t")!.confidence, 0.65);
  assert.equal(decisionDraftFromText('{"decision":"x","nontrivial":1}', "t")!.confidence, 0.4, "only true/\"true\" lifts the tier");
});

test("decisionDraftFromText falls back to the subject for a missing/non-string title and drops a non-array consequences", () => {
  const d = decisionDraftFromText('{"title": 123, "decision": "did a thing", "consequences": "adds a dep"}', "feat: subject");
  assert.equal(d!.title, "feat: subject", "numeric title ignored");
  assert.deepEqual(d!.consequences, [], "a scalar string is not coerced into the array");
});

test("decisionDraftFromText returns null when the LLM added nothing usable (title-only, whitespace, prose)", () => {
  assert.equal(decisionDraftFromText('{"title": "Something"}', "feat: x"), null);
  assert.equal(decisionDraftFromText('{"decision":"   ","context":""}', "feat: x"), null, "whitespace-only is empty");
  assert.equal(decisionDraftFromText("garbage, no json", "feat: x"), null);
});

// ---------------------------------------------------------------------------
// bugDraftFromText — root_cause OR a deliberate severity is worth keeping.
// ---------------------------------------------------------------------------

test("bugDraftFromText maps a rooted bug and coerces an invalid/non-string severity to medium", () => {
  const b = bugDraftFromText(
    '{"title": "Token reuse", "symptom": "old token works", "root_cause": "stateless JWT", "severity": "catastrophic"}',
    "auth.spec.ts",
    "old token still valid",
  );
  assert.equal(b!.root_cause, "stateless JWT");
  assert.equal(b!.severity, "medium", "unknown severity coerced");
  assert.equal(b!.source, "test_failure+llm");
  assert.equal(b!.confidence, 0.55);
  // a non-string severity must never leak through as a non-enum value
  assert.equal(bugDraftFromText('{"root_cause":"x","severity":["high"]}', "t", "m")!.severity, "medium");
  assert.equal(bugDraftFromText('{"root_cause":"x","severity":2}', "t", "m")!.severity, "medium");
});

test("bugDraftFromText keeps a deliberate severity even without a root_cause (so constraint promotion survives)", () => {
  const b = bugDraftFromText('{"symptom":"prod auth bypass","severity":"critical"}', "t.spec.ts", "raw msg");
  assert.ok(b, "a critical classification is value-add even with no root cause");
  assert.equal(b!.severity, "critical");
  assert.equal(b!.symptom, "prod auth bypass");
  assert.equal(b!.root_cause, "");
  assert.equal(b!.source, "test_failure+llm_partial", "honestly labeled as partial");
  assert.equal(b!.confidence, 0.4, "lower than a full root-caused draft");
});

test("bugDraftFromText returns null when it would only echo the input (no root_cause, no deliberate severity)", () => {
  assert.equal(bugDraftFromText('{"symptom": "it broke"}', "t.spec.ts", "msg"), null);
  assert.equal(bugDraftFromText('{"symptom":"x","severity":"medium"}', "t.spec.ts", "msg"), null, "medium is the default, not deliberate");
  assert.equal(bugDraftFromText("no json here", "t.spec.ts", "msg"), null);
  assert.equal(bugDraftFromText('["array"]', "t.spec.ts", "msg"), null);
});

test("bugDraftFromText falls back to test id + message for missing title/symptom", () => {
  const b = bugDraftFromText('{"root_cause": "off-by-one"}', "t.spec.ts", "expected 1 got 2");
  assert.equal(b!.title, "t.spec.ts");
  assert.equal(b!.symptom, "expected 1 got 2");
});

// ---------------------------------------------------------------------------
// Content-based object selection — neither first nor last position wins; the
// real answer beats a template/recap whether it leads OR trails (regression R1).
// ---------------------------------------------------------------------------

test("a TRAILING template/recap object does not shadow the real answer (decision)", () => {
  const text =
    '{"title":"Adopt Redis","context":"need revocation","decision":"store sessions in Redis","nontrivial":true}\n' +
    "Note: the expected output format is just:\n" +
    '{"title":"<imperative>","context":"see above","decision":"..."}';
  const d = decisionDraftFromText(text, "feat: x");
  assert.equal(d!.decision, "store sessions in Redis", "the filled answer, not the trailing placeholder");
  assert.equal(d!.confidence, 0.65);
});

test("a TRAILING real-looking example does not override the first substantive answer", () => {
  const text =
    '{"decision":"REAL set timeout to 30","context":"perf"}\n' +
    'Example response: {"decision":"do the thing","context":"because reasons"}';
  assert.equal(decisionDraftFromText(text, "t")!.decision, "REAL set timeout to 30");
});

test("a placeholder-only object is not mistaken for a real draft", () => {
  assert.equal(decisionDraftFromText('{"decision":"...","context":"see above"}', "feat"), null);
  assert.equal(decisionDraftFromText('{"title":"<imperative>","decision":"<what>"}', "feat"), null);
});

test("a stray UNBALANCED prose brace before the answer does not discard the real object (regression R3)", () => {
  // `interface Config {` / `{field:` etc. open a brace that never closes in prose
  const d = decisionDraftFromText(
    'I will use the notation {field: value below.\n{"decision":"adopt Redis","context":"need revocation","nontrivial":true}',
    "feat: config",
  );
  assert.equal(d!.decision, "adopt Redis", "prose brace skipped, real JSON still found");
  assert.equal(d!.confidence, 0.65);
  const b = bugDraftFromText('at foo() {\n{"root_cause":"npe","severity":"high"}', "t", "m");
  assert.equal(b!.root_cause, "npe");
  assert.equal(b!.severity, "high");
});

test("a leading generic example loses to the answer the model flagged nontrivial (regression R3)", () => {
  const text =
    '{"decision":"Use a database","context":"Store data"}\n' +
    '{"decision":"Adopt Redis for sessions","context":"need revocation","nontrivial":true}';
  const d = decisionDraftFromText(text, "fb");
  assert.equal(d!.decision, "Adopt Redis for sessions");
  assert.equal(d!.confidence, 0.65);
});

test("isPlaceholder stays narrow: a terse real value is NOT blanked", () => {
  // a bracketed sentence (cross-ref) is a real value, not a <metavar> template
  assert.equal(
    decisionDraftFromText('{"decision":"<see the linked PR for the full rollout plan>","context":""}', "fb")!.decision,
    "<see the linked PR for the full rollout plan>",
  );
  // a multi-word root_cause beginning with a blocklist-ish word survives
  const b = bugDraftFromText('{"root_cause":"none of the validators ran","severity":"critical"}', "t", "m");
  assert.equal(b!.root_cause, "none of the validators ran");
  assert.equal(b!.source, "test_failure+llm", "substantiated → full draft, not partial");
});

test("bug selection prefers the substantiated/most-severe object regardless of position (regression R1)", () => {
  // trailing low-severity recap must NOT downgrade a leading critical+rooted bug
  const trailing =
    '{"title":"Auth bypass","symptom":"expired token accepted","root_cause":"missing exp check","severity":"critical"}\n' +
    'Summary: probably minor.\n{"symptom":"recap","severity":"low"}';
  const a = bugDraftFromText(trailing, "auth.spec.ts", "expired token accepted");
  assert.equal(a!.severity, "critical");
  assert.equal(a!.root_cause, "missing exp check");
  // leading bare-low must NOT shadow a later rooted-critical bug either
  const leading = '{"severity":"low"}\n{"root_cause":"real cause","severity":"critical"}';
  const b = bugDraftFromText(leading, "t", "m");
  assert.equal(b!.severity, "critical");
  assert.equal(b!.root_cause, "real cause");
});

// ---------------------------------------------------------------------------
// Constraint promotion is gated on substantiation (regression R3): a bare,
// root-cause-less severity label must not auto-mint a do-not-break invariant.
// ---------------------------------------------------------------------------

test("shouldPromoteConstraint requires a real root cause for severity-driven promotion", () => {
  assert.equal(shouldPromoteConstraint("critical", "stateless JWT", false), true, "substantiated critical promotes");
  assert.equal(shouldPromoteConstraint("critical", "", false), false, "bare severity must not mint an invariant");
  assert.equal(shouldPromoteConstraint("high", "   ", false), false, "whitespace root cause is not substantiation");
  assert.equal(shouldPromoteConstraint("medium", "real cause", false), false, "medium is not severe");
  assert.equal(shouldPromoteConstraint("low", "", true), true, "a recurrence always promotes");
});

// ---------------------------------------------------------------------------
// The core contract: provider THROW on null draft → safe wrapper → deterministic.
// ---------------------------------------------------------------------------

const COMMIT: CommitInput = { subject: "feat: add cache", body: "", files: ["src/cache.ts"], diff: "" };
const FAILURE: FailureInput = { test: "cache.spec.ts", message: "expected hit got miss", recentDiff: "", suspects: [] };

function throwingProvider(): SynthProvider {
  return {
    name: "stub-throws",
    available: async () => true,
    draftDecision: async () => { throw new Error("unparseable output"); },
    draftBug: async () => { throw new Error("unparseable output"); },
  };
}

test("draftDecisionSafe: a throwing provider degrades to an honest 'inferred' deterministic draft", async () => {
  const d = await draftDecisionSafe(throwingProvider(), COMMIT);
  assert.equal(d.source, "inferred", "never a hollow llm_draft");
  assert.ok(d.confidence <= 0.45);
  assert.ok(d.title.length > 0);
  assert.equal(d.fellBackTo, "deterministic", "caller must be told a fallback happened");
  assert.equal(d.fallbackReason, "unparseable output", "the actual thrown error message must be preserved");
});

test("draftBugSafe: a throwing provider degrades to an honest 'test_failure' deterministic draft", async () => {
  const b = await draftBugSafe(throwingProvider(), FAILURE);
  assert.equal(b.source, "test_failure");
  assert.ok(b.confidence <= 0.3);
  assert.equal(b.fellBackTo, "deterministic", "caller must be told a fallback happened");
  assert.equal(b.fallbackReason, "unparseable output", "the actual thrown error message must be preserved");
});

test("draftDecisionSafe passes a successful provider draft through unchanged", async () => {
  const passing: SynthProvider = {
    name: "stub-ok",
    available: async () => true,
    draftDecision: async () => ({ title: "T", context: "C", decision: "D", consequences: [], alternatives_rejected: [], confidence: 0.65, source: "llm_draft" }),
    draftBug: async () => { throw new Error("n/a"); },
  };
  const d = await draftDecisionSafe(passing, COMMIT);
  assert.equal(d.source, "llm_draft");
  assert.equal(d.decision, "D");
  assert.equal(d.fellBackTo, undefined, "a successful draft must never get a false-positive fallback marker");
});
