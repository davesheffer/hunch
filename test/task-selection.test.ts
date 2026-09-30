import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BugSchema, DecisionSchema, FindingSchema, type Decision } from "../src/core/types.js";
import { isBareFollowUp, selectForTask, liveSelectionRecords, promptPaths, type TaskSelectionRecords } from "../src/core/taskSelection.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { listReportTasks } from "../src/core/taskReport.js";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";

const provenance = { source: "human_confirmed", confidence: 0.9, evidence: [] };
function dec(id: string, title: string, over: Partial<Decision> = {}): Decision {
  return DecisionSchema.parse({ id, title, status: "accepted", decision: "", provenance, date: "2026-09-01", ...over });
}
function records(over: Partial<TaskSelectionRecords> = {}): TaskSelectionRecords {
  return { decisions: [], bugs: [], constraints: [], findings: [], ...over };
}

test("a record qualifies on two distinct task terms in its title/rationale, not on one", () => {
  const two = dec("dec_two", "Retry webhook delivery with backoff");
  const one = dec("dec_one", "Webhook payload schema");
  const out = selectForTask(records({ decisions: [two, one] }), "make webhook retries use exponential backoff");
  assert.deepEqual(out.qualifying, ["dec_two"]);
  assert.deepEqual(out.top, [{ id: "dec_two", kind: "decision", title: "Retry webhook delivery with backoff" }]);
});

test("stop words and tokens under three characters never count as task terms", () => {
  const d = dec("dec_stop", "Use the io of a db for this", { context: "it is ok to go" });
  assert.deepEqual(selectForTask(records({ decisions: [d] }), "use the io of a db for this, it is ok to go").qualifying, []);
});

test("a repo path named in the prompt qualifies a record on its own (related_files, affected_files, scope glob)", () => {
  const d = dec("dec_path", "Unrelated wording entirely", { related_files: ["src/core/io.ts"] });
  const b = BugSchema.parse({ id: "bug_path", title: "Different words", affected_files: ["src/core/io.ts"], provenance });
  const c = mkConstraint({ id: "con_glob", statement: "Something else", scope: ["src/core/**"], severity: "warning" });
  const other = dec("dec_other", "Unrelated wording entirely", { related_files: ["src/cli/index.ts"] });
  const out = selectForTask(records({ decisions: [d, other], bugs: [b], constraints: [c] }), "look at `./src/core/io.ts`.");
  assert.deepEqual(new Set(out.qualifying), new Set(["dec_path", "bug_path", "con_glob"]));
  const absolute = selectForTask(records({ decisions: [d] }), "open /repo/src/core/io.ts please", { root: "/repo" });
  assert.deepEqual(absolute.qualifying, ["dec_path"]);
  const missing = selectForTask(records({ decisions: [d] }), "open src/core/io.ts", { pathExists: () => false });
  assert.deepEqual(missing.qualifying, [], "a path the optional check rejects names nothing");
});

test("top is capped at k, ordered path match > term overlap > kind/severity priority > id, and excludes blocking constraints", () => {
  const prompt = "tighten the session token rotation policy in src/auth/session.ts";
  const pathOnly = dec("dec_z_path", "Nothing shared here", { related_files: ["src/auth/session.ts"] });
  const three = dec("dec_three", "Session token rotation window");
  const twoDec = dec("dec_b_two", "Session token storage");
  const twoBug = BugSchema.parse({ id: "bug_a_two", title: "Session token leaked", provenance });
  const blocking = mkConstraint({ id: "con_block", statement: "Session token rotation must be atomic", scope: ["lib/**"], severity: "blocking" });
  const finding = FindingSchema.parse({ id: "fnd_two", title: "Session token audit", observed_at: "2026-09-01", provenance });
  // Unrelated live records keep "session"/"token" (in 5 records) under the DF cap: max(3, ceil(0.05 × 100)) = 5.
  const filler = Array.from({ length: 94 }, (_, i) => dec(`dec_fill_${i}`, "Unrelated filler note"));
  const input = records({ decisions: [twoDec, three, pathOnly, ...filler], bugs: [twoBug], constraints: [blocking], findings: [finding] });
  const out = selectForTask(input, prompt, { k: 3 });
  assert.deepEqual(out.top.map((x) => x.id), ["dec_z_path", "dec_three", "dec_b_two"]);
  assert.ok(out.qualifying.includes("con_block"), "a blocking constraint still qualifies; it is only kept off the list");
  assert.ok(!out.top.some((x) => x.id === "con_block"));
  // Decision (800) outranks bug (750) outranks finding (650) at equal overlap.
  const all = selectForTask(input, prompt, { k: 10 });
  assert.deepEqual(all.top.map((x) => x.id), ["dec_z_path", "dec_three", "dec_b_two", "bug_a_two", "fnd_two"]);
  assert.deepEqual(selectForTask(input, prompt, { k: 10 }), all, "deterministic");
});

test("a record anchored to more of the prompt's named files outranks one sharing only the hub file", () => {
  const prompt = "the writer in src/integrations/providers.ts drops comments; test/providers.test.ts misses it";
  const hubOnly = dec("dec_a_hub", "Writer drops comments while the test misses it", { related_files: ["src/integrations/providers.ts", "src/mcp/server.ts"] });
  const both = dec("dec_z_both", "Unrelated wording entirely", { related_files: ["src/integrations/providers.ts", "test/providers.test.ts"] });
  const out = selectForTask(records({ decisions: [hubOnly, both] }), prompt);
  assert.deepEqual(out.top.map((x) => x.id), ["dec_z_both", "dec_a_hub"], "two named files beat one, whatever the term overlap");
});

test("an empty prompt selects nothing, and superseded/retired records are not live", () => {
  const d = dec("dec_x", "Session token rotation");
  assert.deepEqual(selectForTask(records({ decisions: [d] }), ""), { qualifying: [], top: [] });
  const live = liveSelectionRecords(records({
    decisions: [d, dec("dec_old", "Session token rotation", { status: "superseded", superseded_by: "dec_x" })],
    constraints: [mkConstraint({ id: "con_ret", status: "retired" })],
  }));
  assert.deepEqual(live.decisions.map((x) => x.id), ["dec_x"]);
  assert.deepEqual(live.constraints, []);
});

test("a term common to more than the DF cap of live records does not count; rare terms do", () => {
  const filler = Array.from({ length: 30 }, (_, i) => dec(`dec_fill_${String(i).padStart(2, "0")}`, "Telemetry sampling note"));
  const rare = dec("dec_rare", "Telemetry flush ordering");
  const common = dec("dec_common", "Telemetry flush tweak");
  const input = records({ decisions: [...filler, rare, common] });
  // 32 live records: cap = max(3, ceil(0.05 × 32)) = 3; "telemetry" is in all 32.
  assert.deepEqual(selectForTask(input, "telemetry flush ordering").qualifying, ["dec_rare"]);
  // Under the cap the same shared term still counts.
  assert.deepEqual(new Set(selectForTask(records({ decisions: [rare, common] }), "telemetry flush ordering").qualifying), new Set(["dec_rare", "dec_common"]));
  // Path matches ignore the cap.
  const pathed = dec("dec_pathed", "Telemetry sampling note", { related_files: ["src/t.ts"] });
  assert.ok(selectForTask(records({ decisions: [...filler, pathed] }), "telemetry sampling in src/t.ts").qualifying.includes("dec_pathed"));
});

test("promptPaths strips :line[:col] and possessives, and folds drive-letter case", () => {
  assert.deepEqual(promptPaths("see foo.ts:12:3 and bar.ts:7"), ["foo.ts", "bar.ts"]);
  assert.deepEqual(promptPaths("src/core/io.ts's writer and src/core/db.ts\u2019s index"), ["src/core/io.ts", "src/core/db.ts"]);
  assert.deepEqual(promptPaths("open C:\\Repo\\src\\a.ts:3", "c:/repo"), ["src/a.ts"]);
  assert.deepEqual(promptPaths("open /Repo/src/a.ts", "/repo"), [], "a POSIX root stays case-sensitive off Windows");
});

test("promptPaths strips a :start-end line range and reads markdown link targets", () => {
  assert.deepEqual(promptPaths("see src/a.ts:12-20 now"), ["src/a.ts"]);
  assert.deepEqual(promptPaths("the [io](src/core/io.ts) writer"), ["src/core/io.ts"]);
  assert.deepEqual(promptPaths("[src/b.ts](src/b.ts:4)"), ["src/b.ts"]);
  assert.deepEqual(promptPaths("see [page](src/app/(auth)/login/page.tsx) now"), ["src/app/(auth)/login/page.tsx"]);
  assert.deepEqual(promptPaths("[page](src/app/(auth)/login/page.tsx)."), ["src/app/(auth)/login/page.tsx"]);
  assert.deepEqual(promptPaths("[app/[id]/page.tsx](app/[id]/page.tsx)"), ["app/[id]/page.tsx"]);
});

test("promptPaths keeps brackets a path uses and strips only wrapping or unmatched ones", () => {
  assert.deepEqual(promptPaths("edit src/app/(auth)/login/page.tsx now"), ["src/app/(auth)/login/page.tsx"]);
  assert.deepEqual(promptPaths("open src/app/users/[id]/page.tsx"), ["src/app/users/[id]/page.tsx"]);
  assert.deepEqual(promptPaths("routes/[slug]/+page.svelte."), ["routes/[slug]/+page.svelte"]);
  assert.deepEqual(promptPaths("(see src/core/io.ts)"), ["src/core/io.ts"]);
  assert.deepEqual(promptPaths("wrapped (src/app/(auth)/x.ts)."), ["src/app/(auth)/x.ts"]);
  assert.deepEqual(promptPaths("relative (auth)/x.ts and [id]/page.tsx,"), ["(auth)/x.ts", "[id]/page.tsx"]);
  assert.deepEqual(promptPaths("look at (src/app/(auth)/login/page.tsx first)"), ["src/app/(auth)/login/page.tsx"]);
  assert.deepEqual(promptPaths("see [src/app/[id]/page.tsx and more]"), ["src/app/[id]/page.tsx"]);
  assert.deepEqual(promptPaths("[id]/page.tsx["), ["[id]/page.tsx"], "a trailing opening bracket goes, not the path's own head");
  assert.deepEqual(promptPaths("see )src/x.ts"), ["src/x.ts"]);
  assert.deepEqual(promptPaths("\u201csrc/x.ts\u201d and \u2018src/y.ts\u2019,"), ["src/x.ts", "src/y.ts"], "typographic quotes from pasted prose");
});

test("promptPaths stays fast on pasted junk: no token-length or bracket-run blowup", () => {
  const started = Date.now();
  promptPaths(`src/a.ts${")".repeat(100_000)} ${"[".repeat(100_000)} ${"[x](".repeat(25_000)}`);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.deepEqual(promptPaths(`${"x".repeat(1100)}/a.ts src/b.ts`), ["src/b.ts"]);
  const worst = Date.now();
  promptPaths(`${"[".repeat(256)}](${`(${"x".repeat(256)})`.repeat(4096)}`);
  assert.ok(Date.now() - worst < 300, `a [-run before a long link target took ${Date.now() - worst} ms`);
  for (const junk of [")".repeat(1024), "(".repeat(1024), `${"[".repeat(1023)}x`, `${"(".repeat(512)}${")".repeat(512)}`]) {
    const atCap = Date.now();
    promptPaths(Array(97).fill(junk).join(" "));
    assert.ok(Date.now() - atCap < 300, `tokens at the length cap took ${Date.now() - atCap} ms`);
  }
});

test("a bare follow-up is made only of continuation words; anything else is a task of its own", () => {
  for (const prompt of ["continue", "go on", "yes do it", "ok, next step please"]) assert.equal(isBareFollowUp(prompt), true, prompt);
  for (const prompt of ["fix sampler", "fix db io", "refactor auth", "src/core/io.ts", "исправь сэмплер", "update README", ""]) {
    assert.equal(isBareFollowUp(prompt), false, prompt);
  }
});

test("without a pathExists check only a slashed token counts as a path", () => {
  const broad = dec("dec_broad", "Unrelated wording entirely", { related_files: ["**"] });
  for (const prompt of ["e.g. please", "bump Node.js", "ship v1.2 today"]) {
    assert.deepEqual(selectForTask(records({ decisions: [broad] }), prompt).qualifying, [], `"${prompt}" named a path`);
  }
  assert.deepEqual(selectForTask(records({ decisions: [broad] }), "look at src/core/io.ts").qualifying, ["dec_broad"]);
  // With the existence check the bare file name is still a path, as before.
  assert.deepEqual(selectForTask(records({ decisions: [broad] }), "open io.ts", { pathExists: () => true }).qualifying, ["dec_broad"]);
});

// ---- end to end through the real hook entry ----

const cli = resolve("src/cli/index.ts");
const PROMPT = "Make the webhook retry backoff exponential with jitter PRIVATE_SELECTION_SENTINEL";

function fixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-selection-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  writeFileSync(join(root, "src", "hub.ts"), "export const hub = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", dec("dec_task_a", "Webhook retry uses exponential backoff", { related_files: ["src/hub.ts"], decision: "Retry with backoff and jitter." }));
  store.json.put("decisions", dec("dec_other_b", "Telemetry sampling rate is ten percent", { related_files: ["src/hub.ts"], decision: "Sample telemetry at 10%." }));
  store.json.put("constraints", mkConstraint({ id: "con_block_hub", statement: "Never log secrets from the hub", scope: ["src/hub.ts"], severity: "blocking" }));
  store.json.put("constraints", mkConstraint({ id: "con_warn_hub", statement: "Prefer named exports in the hub module", scope: ["src/hub.ts"], severity: "warning" }));
  store.reindex(); store.close();
  return root;
}
function hook(root: string, event: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const tmp = join(root, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0", HUNCH_TASK_SELECTION: "", TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...env },
    input: JSON.stringify({ hook_event_name: event, cwd: root, session_id: "session-sel", prompt_id: "prompt-sel", ...extra }), encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) : null;
}
function selectionFiles(root: string): Map<string, string> {
  const dir = join(root, ".tmp");
  return new Map(existsSync(dir) ? filesUnder(dir).filter((f) => /task-htask_/.test(f)).map((f) => [f, readFileSync(f, "utf8")]) : []);
}
const recordIds = (text: string) => new Set(text.match(/\b(?:dec|con|bug|fnd)_[a-z0-9_]+/g) ?? []);
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path)); else out.push(path);
  }
  return out;
}

test("e2e: a scored prompt conditions file grounding on the task; blocking constraints still arrive", t => {
  const root = fixture(t);
  const prompt = hook(root, "UserPromptSubmit", { prompt: PROMPT });
  assert.match(prompt.hookSpecificOutput.additionalContext, /Hunch memory for this task: dec_task_a — Webhook retry uses exponential backoff \(hunch_why\(id\) for detail\)/);
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /dec_other_b|con_block_hub/);
  const edit = hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" } });
  const text = edit.hookSpecificOutput.additionalContext as string;
  assert.match(text, /dec_task_a/);
  assert.doesNotMatch(text, /dec_other_b/, "a record merely anchored to the file is not delivered when the task never selected it");
  assert.match(text, /con_block_hub/, "blocking constraints are exempt from task selection");
  // No raw prompt text is retained anywhere in the hook cache (or the repo's own caches).
  const cacheFiles = filesUnder(join(root, ".tmp"));
  assert.ok(cacheFiles.some((f) => /task-htask_/.test(f)), "the per-task selection file was written");
  for (const file of [...cacheFiles, ...filesUnder(join(root, ".hunch-cache"))]) {
    assert.equal(readFileSync(file).includes(Buffer.from("PRIVATE_SELECTION_SENTINEL")), false, `${file} retains the prompt`);
  }
});

test("e2e: a prompt that selects nothing writes no selection and keeps the unfiltered grounding", t => {
  const edit = (root: string) => hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" } }).hookSpecificOutput.additionalContext as string;
  const unfiltered = edit(fixture(t));
  for (const words of ["rename a variable", "go", ""]) {
    const root = fixture(t);
    const prompt = hook(root, "UserPromptSubmit", { prompt: words });
    assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /Hunch memory for this task/);
    assert.equal(selectionFiles(root).size, 0, `"${words}" wrote a selection file`);
    const text = edit(root);
    assert.deepEqual(recordIds(text), recordIds(unfiltered), `"${words}" filtered the grounding`);
    assert.match(text, /dec_task_a/);
    assert.match(text, /dec_other_b/);
  }
});

test("e2e: constraints of any severity scoped to the file arrive under a selection that omits them", t => {
  const root = fixture(t);
  hook(root, "UserPromptSubmit", { prompt: PROMPT });
  const [file] = [...selectionFiles(root).values()];
  assert.ok(file && !JSON.parse(file).qualifying.includes("con_warn_hub"), "the fixture must not select the warning");
  const text = hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" } }).hookSpecificOutput.additionalContext as string;
  assert.match(text, /con_warn_hub/);
  assert.match(text, /con_block_hub/);
  assert.doesNotMatch(text, /dec_other_b/);
});

test("e2e: a host notification prompt leaves the task's selection untouched", t => {
  const root = fixture(t);
  hook(root, "UserPromptSubmit", { prompt: PROMPT, prompt_id: "p1" });
  const before = selectionFiles(root);
  assert.equal(before.size, 1);
  const out = hook(root, "UserPromptSubmit", { prompt: "<task-notification>\nTelemetry sampling rate is ten percent\n</task-notification>", prompt_id: "p2" });
  assert.doesNotMatch(out?.hookSpecificOutput?.additionalContext ?? "", /Hunch memory for this task/);
  assert.deepEqual(selectionFiles(root), before);
});

test("e2e: HUNCH_TASK_SELECTION=0 writes no selection and grounds unfiltered", t => {
  const root = fixture(t);
  const off = { HUNCH_TASK_SELECTION: "0" };
  const prompt = hook(root, "UserPromptSubmit", { prompt: PROMPT }, off);
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /Hunch memory for this task/);
  assert.equal(selectionFiles(root).size, 0);
  const text = hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" } }, off).hookSpecificOutput.additionalContext as string;
  assert.match(text, /dec_task_a/);
  assert.match(text, /dec_other_b/);
  // A selection written while on is ignored once switched off.
  hook(root, "UserPromptSubmit", { prompt: PROMPT, prompt_id: "p-on" });
  assert.equal(selectionFiles(root).size, 1);
  const offText = hook(root, "PreToolUse", { prompt_id: "p-on", tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "y" } }, off).hookSpecificOutput.additionalContext as string;
  assert.match(offText, /dec_other_b/);
});

test("e2e: without a UserPromptSubmit (no selection file) file grounding is unfiltered, as before", t => {
  const root = fixture(t);
  const edit = hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" } });
  const text = edit.hookSpecificOutput.additionalContext as string;
  assert.match(text, /dec_task_a/);
  assert.match(text, /dec_other_b/);
  assert.match(text, /con_block_hub/);
});

test("e2e: a follow-up prompt that continues the task keeps the previous prompt's selection without re-listing it", t => {
  const root = fixture(t);
  hook(root, "UserPromptSubmit", { prompt: PROMPT, prompt_id: "p1" });
  hook(root, "Stop", { prompt_id: "p1" });
  const [first] = listReportTasks(root);
  const followUp = hook(root, "UserPromptSubmit", { prompt: "continue", prompt_id: "p2" });
  const second = listReportTasks(root).find((x) => x.task_id !== first!.task_id)!;
  assert.equal(second.continues, first!.task_id, "the fixture must exercise a continuation");
  assert.doesNotMatch(followUp.hookSpecificOutput.additionalContext, /Hunch memory for this task/, "an inherited selection is not listed again");
  const edit = hook(root, "PreToolUse", { prompt_id: "p2", tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" } });
  const text = edit.hookSpecificOutput.additionalContext as string;
  assert.match(text, /dec_task_a/, "the continued task still receives what its first prompt selected");
  assert.doesNotMatch(text, /dec_other_b/);
  assert.match(text, /con_block_hub/);
});

/** dec_hub_a and dec_hub_b both anchor src/hub.ts; con_other is a warning scoped elsewhere. */
function hubFixture(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-selection-hub-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".hunch"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  writeFileSync(join(root, "src", "hub.ts"), "export const hub = 1;\n");
  writeFileSync(join(root, "src", "other.ts"), "export const other = 1;\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", dec("dec_hub_a", "Webhook retry uses exponential backoff", { related_files: ["src/hub.ts"], decision: "Retry with backoff and jitter." }));
  store.json.put("decisions", dec("dec_hub_b", "Telemetry sampling rate is ten percent", { related_files: ["src/hub.ts"], decision: "Sample telemetry at 10%." }));
  store.json.put("constraints", mkConstraint({ id: "con_other", statement: "Keep the other module small", scope: ["src/other.ts"], severity: "warning" }));
  store.reindex(); store.close();
  return root;
}
const editHub = (root: string, extra: Record<string, unknown> = {}) =>
  hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, "src", "hub.ts"), new_string: "x" }, ...extra }).hookSpecificOutput.additionalContext as string;

test("e2e: a selection holding only constraints is no selection — the file's decisions still arrive", t => {
  const baseline = recordIds(editHub(hubFixture(t)));
  assert.ok(baseline.has("dec_hub_a") && baseline.has("dec_hub_b"), "the baseline must carry both decisions");
  const root = hubFixture(t);
  hook(root, "UserPromptSubmit", { prompt: "look at src/other.ts" });
  assert.equal(selectionFiles(root).size, 0, "a constraint-only selection must not be persisted");
  const text = editHub(root);
  assert.match(text, /dec_hub_a/);
  assert.match(text, /dec_hub_b/);
  assert.deepEqual(recordIds(text), baseline);
});

test("e2e: a substantive same-session prompt that selects nothing does not inherit the previous task's selection", t => {
  const baseline = recordIds(editHub(hubFixture(t)));
  const root = hubFixture(t);
  hook(root, "UserPromptSubmit", { prompt: "make the webhook retry backoff exponential", prompt_id: "p1" });
  assert.equal(selectionFiles(root).size, 1, "p1 must select dec_hub_a");
  hook(root, "Stop", { prompt_id: "p1" });
  const [first] = listReportTasks(root);
  hook(root, "UserPromptSubmit", { prompt: "now rework how the sampler picks traces", prompt_id: "p2" });
  const second = listReportTasks(root).find((x) => x.task_id !== first!.task_id)!;
  assert.equal(second.continues, first!.task_id, "the fixture must exercise a continuation");
  assert.ok(![...selectionFiles(root).keys()].some((f) => f.includes(second.task_id)), "p2 wrote a selection file");
  const text = editHub(root, { prompt_id: "p2" });
  assert.match(text, /dec_hub_a/);
  assert.match(text, /dec_hub_b/);
  assert.deepEqual(recordIds(text), baseline);
});

test("e2e: a new same-session task prompt of a verb and an object does not inherit the previous task's selection", t => {
  const baseline = recordIds(editHub(hubFixture(t)));
  const root = hubFixture(t);
  hook(root, "UserPromptSubmit", { prompt: "make the webhook retry backoff exponential", prompt_id: "p1" });
  hook(root, "Stop", { prompt_id: "p1" });
  const [first] = listReportTasks(root);
  hook(root, "UserPromptSubmit", { prompt: "fix sampler", prompt_id: "p2" });
  const second = listReportTasks(root).find((x) => x.task_id !== first!.task_id)!;
  assert.equal(second.continues, first!.task_id, "the fixture must exercise a continuation");
  const text = editHub(root, { prompt_id: "p2" });
  assert.match(text, /dec_hub_b/, "the new task must not be narrowed to the previous task's selection");
  assert.deepEqual(recordIds(text), baseline);
});

test("e2e: a prompt naming a bracketed route path selects the decision anchored to it", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-task-selection-route-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  const route = "src/app/(auth)/login/page.tsx";
  mkdirSync(join(root, ".hunch"));
  mkdirSync(join(root, "src", "app", "(auth)", "login"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  writeFileSync(join(root, ...route.split("/")), "export default function Page() { return null; }\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", dec("dec_route_terms", "Login layout uses a centered card", { related_files: [route] }));
  store.json.put("decisions", dec("dec_route_path", "Session cookie is httpOnly", { related_files: [route] }));
  store.reindex(); store.close();
  hook(root, "UserPromptSubmit", { prompt: `tweak the login layout in ${route}` });
  assert.equal(selectionFiles(root).size, 1, "the prompt must write a selection");
  const text = hook(root, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: join(root, ...route.split("/")), new_string: "x" } }).hookSpecificOutput.additionalContext as string;
  assert.match(text, /dec_route_terms/);
  assert.match(text, /dec_route_path/, "the path the prompt names qualifies its decision");
});
