import { cleanupDir } from "./fixtures.js";
/** The pre-edit grounding block must not invalidate its OWN dedup hash.
 *
 * Serving the full block writes delivery receipts; the next hook call's task
 * ranking reads them back and the recent-task line moves — its top reason flips,
 * or its age word goes "today" → "delivered today" — so the content hash changes
 * and a SECOND full 3-4KB block goes out for the same agent and file. Measured
 * 2026-09-19: 63 of 169 full injections in subagents were such repeats.
 *
 * The rule under test (provider-independent, all call sites): nothing that
 * depends on delivery receipts, ranking warmth/scores, slot labels, ordering or
 * `now` may enter the dedupe hash; a record entering, leaving or changing
 * content must. Run for every hook provider whose pre-edit path reaches the
 * shared grounding assembler. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryEnvelope, deliveryDedupeInput, type DeliverySupplement } from "../src/core/delivery.js";
import { finishReportTask, recordTaskDelivery, reportHash, startReportTask } from "../src/core/taskReport.js";
import { persistTaskRecord } from "../src/core/taskRecord.js";
import { HunchStore, type AssembledContext } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");

/** The delivery a fixture task records, and the lesson that reaches it — shared
 *  so a test can add a SECOND finished task to a live fixture repo. */
function ctx(): AssembledContext {
  const assembled = {
    target: "src/config.ts", constraints: [], decisions: [], bugs: [], blast_radius: [],
    components: [], findings: [], budget_tokens: 1500,
  } as unknown as AssembledContext;
  assembled.constraints.push({
    id: "con_dedupe_hook", type: "architecture", statement: "Preserve existing settings", scope: ["src/config.ts"],
    severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null,
    violations: [], status: "active", valid_from: "2026-09-11T00:00:00.000Z", valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
  });
  return assembled;
}

const lesson = () => ({
  record_id: "con_dedupe_hook", kind: "constraints", title: "Preserve existing settings",
  lesson: "Merge settings.", content_hash: reportHash("fixture revision"), recorded_at: "2026-09-11T00:00:00.000Z",
});

/** A repo whose src/config.ts carries one invariant AND one finished task
 *  record, so the pre-edit block contains a ranked recent-task line — the
 *  self-invalidating part. Its own fixture graph; nothing from this repo. */
function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-hook-dedupe-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  writeFileSync(join(root, "src", "config.ts"), "export const settings = {};\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("constraints", mkConstraint({ id: "con_dedupe_hook", statement: "Preserve existing settings", scope: ["src/config.ts"], severity: "blocking" }));
  store.reindex();

  const earlier = startReportTask(root, "Earlier settings work");
  recordTaskDelivery(root, earlier.task_id, buildDeliveryEnvelope(ctx()), [lesson()], undefined, "src/config.ts");
  finishReportTask(root, earlier.task_id);
  assert.ok(persistTaskRecord(root, store, earlier.task_id, { flush: false }), "the fixture needs a persisted finished task");
  store.close();
  return root;
}

/** The dedup cache is keyed by session id alone and lives in the OS tmpdir, so a
 *  reused session id would inherit another test's — or another RUN's — entries
 *  and fake a delta. Every test gets its own. */
const sessionId = () => `hunch-dedupe-${process.pid}-${Math.floor(performance.now() * 1000)}`;

function runHook(root: string, provider: string, session: string, payload: Record<string, unknown>) {
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", provider], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" },
    input: JSON.stringify({ cwd: root, session_id: session, prompt_id: "prompt-dedupe", turn_id: "turn-1", ...payload }),
    encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}

/** The pre-edit payload each provider's own tool contract carries for one file. */
const PRE_EDIT: Record<string, (root: string) => Record<string, unknown>> = {
  claude: (root) => ({
    hook_event_name: "PreToolUse", tool_name: "Edit",
    tool_input: { file_path: join(root, "src", "config.ts"), new_string: "merge settings" },
  }),
  codex: () => ({
    hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { input: ["*** Begin Patch", "*** Update File: src/config.ts", "@@", "-export const settings = {};", "+export const settings = { merged: true };", "*** End Patch", ""].join("\n") },
  }),
};

for (const provider of Object.keys(PRE_EDIT)) {
  test(`${provider}: a crowded task selection does not change after its own delivery`, { timeout: 120_000 }, t => {
    const root = fixture(t);
    const store = new HunchStore(hunchPaths(root));
    for (let i = 0; i < 6; i++) {
      const prior = startReportTask(root, `Earlier settings work ${i}`);
      const context = ctx();
      if (i >= 3) context.constraints = [];
      recordTaskDelivery(root, prior.task_id, buildDeliveryEnvelope(context), i < 3 ? [lesson()] : [], undefined, "src/config.ts");
      finishReportTask(root, prior.task_id);
      persistTaskRecord(root, store, prior.task_id, { flush: false });
    }
    store.close();
    const session = sessionId();
    runHook(root, provider, session, { hook_event_name: "UserPromptSubmit", prompt: "merge the settings" });
    const ground = () => runHook(root, provider, session, PRE_EDIT[provider]!(root))?.hookSpecificOutput?.additionalContext as string;
    assert.doesNotMatch(ground(), /unchanged this session/);
    assert.match(ground(), /unchanged this session/, "delivery must not add its own rule ids to the next ranking query");
    assert.match(ground(), /unchanged this session/);
  });

  test(`${provider}: repeated pre-edit calls with no record change stay deltas — a delivery receipt must not re-send the full block`, { timeout: 120_000 }, t => {
    const root = fixture(t);
    const session = sessionId();
    // The prompt task is what makes the block self-invalidating: the hook records
    // this delivery against it, and the NEXT call's ranking query is built from
    // that task's record ids and files, so the recent-task reason flips with no
    // record change. Without a prompt task there is nothing to feed back.
    runHook(root, provider, session, { hook_event_name: "UserPromptSubmit", prompt: "merge the settings" });
    const payload = PRE_EDIT[provider]!(root);
    const ground = () => runHook(root, provider, session, payload)?.hookSpecificOutput?.additionalContext as string;

    const first = ground();
    assert.match(first, /Preserve existing settings/, "the first call is the full grounding block");
    assert.match(first, /supplemental\/recent-task \| /, "the fixture must actually deliver a recent-task line");

    assert.match(ground(), /unchanged this session/, "nothing about the RECORDS changed, so the second call must be a delta");
    assert.match(ground(), /unchanged this session/, "and it must stay a delta, not oscillate");
  });

  test(`${provider}: a subagent gets one full block then deltas, even though its own serve writes receipts`, { timeout: 120_000 }, t => {
    const root = fixture(t);
    const session = sessionId();
    runHook(root, provider, session, { hook_event_name: "UserPromptSubmit", prompt: "merge the settings" });
    const payload = { ...PRE_EDIT[provider]!(root), agent_id: "agent-dedupe" };
    const ground = () => runHook(root, provider, session, payload)?.hookSpecificOutput?.additionalContext as string;

    assert.doesNotMatch(ground(), /unchanged this session/, "a fresh subagent never saw the grounding");
    assert.match(ground(), /unchanged this session/);
    assert.match(ground(), /unchanged this session/);
  });

  test(`${provider}: a CHANGED record still re-sends the full block — the dedup must not hide new memory`, { timeout: 180_000 }, t => {
    const root = fixture(t);
    const session = sessionId();
    runHook(root, provider, session, { hook_event_name: "UserPromptSubmit", prompt: "merge the settings" });
    const payload = PRE_EDIT[provider]!(root);
    const ground = () => runHook(root, provider, session, payload)?.hookSpecificOutput?.additionalContext as string;

    assert.doesNotMatch(ground(), /unchanged this session/, "the first call is the full block");
    assert.match(ground(), /unchanged this session/, "settled into a delta");

    // A record the block RENDERS changes: the invariant's own statement.
    const store = new HunchStore(hunchPaths(root));
    store.json.put("constraints", mkConstraint({
      id: "con_dedupe_hook", statement: "Preserve existing settings AND never delete keys",
      scope: ["src/config.ts"], severity: "blocking",
    }));
    store.reindex();
    store.close();

    const changed = ground();
    assert.doesNotMatch(changed, /unchanged this session/, "a changed constraint statement must re-send the FULL block");
    assert.match(changed, /never delete keys/, "and the full block must carry the new statement");
    assert.match(ground(), /unchanged this session/, "then settle back into deltas");

    // A record ENTERING the block: a second finished task on the same file.
    const store2 = new HunchStore(hunchPaths(root));
    const later = startReportTask(root, "Later settings work");
    recordTaskDelivery(root, later.task_id, buildDeliveryEnvelope(ctx()), [lesson()], undefined, "src/config.ts");
    finishReportTask(root, later.task_id);
    assert.ok(persistTaskRecord(root, store2, later.task_id, { flush: false }), "the second task must persist");
    store2.close();

    assert.doesNotMatch(ground(), /unchanged this session/, "a new task record entering the block must re-send the FULL block");
    assert.match(ground(), /unchanged this session/, "and then settle back into deltas");
  });
}

test("the identity projection drops presentation and keeps records: order is not a change, membership is", () => {
  const bare = {
    target: "src/config.ts", constraints: [], decisions: [], bugs: [], blast_radius: [],
    components: [], findings: [], budget_tokens: 1500,
  } as unknown as AssembledContext;
  const sup = (id: string, text: string, hash_text: string): DeliverySupplement =>
    ({ id, kind: "recent-task", priority: 414, text, hash_text });

  const a = sup("htask_a", 'latest   htask_a · 2026-09-19 · "T" — same file · today · 1 lesson(s)', "htask_a@rev1");
  const b = sup("htask_b", 'relevant htask_b · 2026-09-18 · "U" — same file · today · 2 lesson(s)', "htask_b@rev1");
  // Same records, presentation moved: reason word flipped AND slots swapped.
  const aMoved = sup("htask_a", 'relevant htask_a · 2026-09-19 · "T" — same file · delivered today · 1 lesson(s)', "htask_a@rev1");
  const bMoved = sup("htask_b", 'latest   htask_b · 2026-09-18 · "U" — same file · delivered today · 2 lesson(s)', "htask_b@rev1");

  const project = (s: readonly DeliverySupplement[]) => deliveryDedupeInput(buildDeliveryEnvelope(bare, { supplements: s }), s);
  assert.equal(project([a, b]), project([bMoved, aMoved]), "reason wording, slot labels and order are presentation, not identity");
  assert.notEqual(project([a, b]), project([a]), "a record LEAVING the block is a real change");
  assert.notEqual(
    project([a, b]),
    project([a, sup("htask_b", b.text, "htask_b@rev2")]),
    "a record whose own content hash changed is a real change",
  );

  // A supplement's staleness (its record's file anchors no longer all exist) is
  // a property of the REPO, not of a receipt: it must reach the identity.
  const aStale = sup("htask_a", a.text, "htask_a@rev1!stale");
  assert.notEqual(project([a, b]), project([aStale, b]), "a picked task whose anchors died is a real change");

  // No hash_text anywhere → nothing is SUBSTITUTED, so the projection is the
  // text with each contiguous run of `- ` list lines sorted (order-insensitive).
  // With a single list line that is byte-identical to `envelope.text`.
  const plain = [{ id: "x", kind: "note", priority: 10, text: "a plain supplement" }];
  const envelope = buildDeliveryEnvelope(bare, { supplements: plain });
  assert.equal(deliveryDedupeInput(envelope, plain), envelope.text, "no hash_text: no substitution (one list line, so sorting is a no-op)");
  assert.equal(deliveryDedupeInput(envelope), envelope.text, "and with no supplements passed at all");
});
