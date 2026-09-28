import { cleanupDir } from "./fixtures.js";
/** Hook diet: the pre-edit and shell-write hooks stop re-injecting grounding the
 *  agent can fetch on demand.
 *
 *  D1 — a file a shell command wrote gets a POINTER (record ids, blocking
 *       invariants, hunch_why), not the grounding, and the pointer counts as no
 *       delivery: a later Edit of that file still receives it in full.
 *  D2 — an unchanged repeat of the pre-edit grounding is silent (the receipt
 *       still attests the earlier serve).
 *  D3 — full pre-edit grounding is capped at 8,000 characters per session and
 *       agent identity; past the cap the file gets the pointer instead.
 *  HUNCH_HOOK_DIET=0 restores the v1.42.0 output. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { withServedDatabase } from "../src/core/served.js";
import { listReportTasks, readTaskReport } from "../src/core/taskReport.js";
import { mkConstraint, mkSymbol, prov, tsxLoaderUrl } from "./helpers.js";
import type { Decision } from "../src/core/types.js";

const cli = resolve("src/cli/index.ts");
const BUDGET = 8_000;
const LONG = (tag: string) => `${tag}: ${"keep the recorded contract intact across every caller and every release of this module ".repeat(3)}`.slice(0, 180);

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** A repo with its own graph:
 *  - src/a.ts: one blocking + seven warning invariants (more ids than a pointer lists)
 *  - src/b.ts: one blocking invariant; src/c.ts, src/d.ts: one warning each
 *  - src/plain.ts: nothing Hunch knows
 *  - src/budget/f1..f4.ts: eight blocking invariants each (~3KB grounding apiece)
 *  - src/huge.ts: forty blocking invariants (one grounding over the whole budget)
 *  - src/retired.ts: code an in-force decision retired
 *  - docs/guide.md: a topic anchor pinned to its current decision, and forty
 *    blocking invariants (over the budget on its own) */
function fixture(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-hook-diet-"));
  t.after(() => cleanupDir(root));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  mkdirSync(join(root, "src", "budget"), { recursive: true });
  mkdirSync(join(root, "docs"));
  const files = ["a", "b", "c", "d", "plain", "huge", "retired", "budget/f1", "budget/f2", "budget/f3", "budget/f4"];
  for (const f of files) writeFileSync(join(root, "src", `${f}.ts`), `export const v = 1;\n`);
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n\n<!-- hunch:topic guide.layout dec_aaaa000001 -->\nThe layout rules.\n");
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const put = (id: string, scope: string, severity: "blocking" | "warning", statement: string) =>
    store.json.put("constraints", mkConstraint({ id, statement, scope: [scope], severity }));
  put("con_a_block", "src/a.ts", "blocking", "Never write settings outside the lock");
  for (let i = 1; i <= 7; i++) put(`con_a_warn${i}`, "src/a.ts", "warning", `Settings rule ${i}`);
  put("con_b_block", "src/b.ts", "blocking", "Billing totals are computed once");
  put("con_c_warn", "src/c.ts", "warning", "Prefer the shared formatter");
  put("con_d_warn", "src/d.ts", "warning", "Keep exports sorted");
  for (const f of ["f1", "f2", "f3", "f4"]) {
    for (let i = 0; i < 8; i++) put(`con_budget_${f}_${i}`, `src/budget/${f}.ts`, "blocking", LONG(`${f} rule ${i}`));
  }
  for (let i = 0; i < 40; i++) put(`con_huge_${i}`, "src/huge.ts", "blocking", LONG(`huge rule ${i}`));
  for (let i = 0; i < 40; i++) put(`con_guide_${i}`, "docs/guide.md", "blocking", LONG(`guide rule ${i}`));
  const decision = (over: Partial<Decision> & { id: string }): Decision => ({
    title: "t", status: "accepted", context: "", decision: "d",
    consequences: [], alternatives_rejected: [], rejected_tripwires: [],
    related_components: [], related_files: [], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
    retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: "2026-01-01T00:00:00Z", topic: null,
    ...over,
  } as Decision);
  store.json.put("decisions", decision({ id: "dec_aaaa000001", title: "Two-column layout", decision: "Guides use the two-column layout", topic: "guide.layout" }));
  store.json.put("decisions", decision({ id: "dec_bbbb000002", title: "Drop the legacy helper", decision: "Use the shared helper", related_files: ["src/retired.ts"], retired: { symbols: ["legacyHelper"], deps: [] } }));
  store.reindex();
  store.close();
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

const sid = () => `hunch-diet-${process.pid}-${Math.floor(performance.now() * 1000)}`;

type HookOut = { hookSpecificOutput?: { additionalContext?: string } } | null;
/** The hook, isolated: its own tmpdir holds this fixture's dedup/budget cache
 *  and shell baselines. Diet ON unless the caller overrides it. */
function hook(root: string, session: string, payload: Record<string, unknown>, env: Record<string, string> = {}): HookOut {
  const tmp = join(root, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const output = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0", HUNCH_HOOK_DIET: "1", TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...env },
    input: JSON.stringify({ cwd: root, session_id: session, ...payload }), encoding: "utf8",
  }).trim();
  return output ? JSON.parse(output) as HookOut : null;
}
const ctxOf = (out: HookOut) => out?.hookSpecificOutput?.additionalContext ?? "";
const edit = (root: string, file: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, ...file.split("/")), new_string: "x" }, ...extra,
});
const bash = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "python3 edit.py" }, tool_response: { stdout: "" }, ...extra,
});
let tick = 1;
/** A write the shell-write fingerprint sees even inside one clock tick. */
function shellWrite(root: string, ...files: string[]): void {
  const at = new Date(Date.now() + tick++ * 1000);
  for (const f of files) {
    writeFileSync(join(root, "src", `${f}.ts`), `export const v = ${tick};\n`);
    utimesSync(join(root, "src", `${f}.ts`), at, at);
  }
}
/** Receipts written for one session, in order. */
function receipts(root: string, session: string): Array<{ event: string; target: string }> {
  if (!existsSync(join(root, ".hunch-cache", "served.db"))) return [];
  return withServedDatabase(root, (db) => (db.prepare("SELECT event, target FROM served WHERE session = ? ORDER BY rowid").all(session) as Array<{ event: string; target: string }>)
    .map((r) => ({ event: r.event, target: r.target })));
}
/** Record ids of the ranked lines a full grounding block shows, in order. */
const shownIds = (text: string) => [...text.matchAll(/^- (con_\w+) \|/gm)].map((m) => m[1]!);

test("D1: a shell write gets one pointer per file — ids capped at six, blocking invariants spelled out, no grounding body", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy the settings" });
  shellWrite(root, "a", "b", "c", "d", "plain");
  const pointer = ctxOf(hook(root, session, bash({ prompt_id: "p1" })));
  const lines = pointer.split("\n");
  assert.match(lines[0]!, /^Hunch: src\/a\.ts was written by a shell command\. Records that apply: (con_\w+, ){5}con_\w+ \(\+2 more\)\. Full grounding: hunch_why\("src\/a\.ts"\)\.$/);
  assert.equal(lines[1], "  ⛔ blocking con_a_block: Never write settings outside the lock");
  assert.equal(lines[2], 'Hunch: src/b.ts was written by a shell command. Records that apply: con_b_block. Full grounding: hunch_why("src/b.ts").');
  assert.equal(lines[3], "  ⛔ blocking con_b_block: Billing totals are computed once");
  assert.equal(lines[4], 'Hunch: src/c.ts was written by a shell command. Records that apply: con_c_warn. Full grounding: hunch_why("src/c.ts").');
  assert.equal(lines[5], "Hunch: (2 more written file(s) not checked)", "the files past the cap are still counted");
  assert.equal(lines.length, 6);
  assert.doesNotMatch(pointer, /this shell command wrote|re-check|constraint\/warning \|/, "no header paragraph, no imperative, no grounding body");

  // No side effects: no receipts, no dedup entry, no task delivery — the next
  // Edit of the same file still gets its FULL grounding, as a first delivery.
  assert.deepEqual(receipts(root, session), [], "a pointer is not a serve");
  const task = listReportTasks(root)[0]!.task_id;
  assert.equal(readTaskReport(root, task).deliveries.length, 0, "a pointer is not a task delivery");
  const full = ctxOf(hook(root, session, edit(root, "src/a.ts", { prompt_id: "p1" })));
  assert.match(full, /con_a_block \| constraint\/blocking/, "the later Edit receives the full grounding");
  assert.match(full, new RegExp(`Hunch task ${task} · delivery `));
  assert.equal(readTaskReport(root, task).deliveries.length, 1, "the Edit's grounding is the task's first delivery");
  assert.deepEqual(new Set(receipts(root, session).map((r) => `${r.event} ${r.target}`)), new Set(["served src/a.ts"]));
  // The pointer named exactly the records the full grounding shows, in rank order.
  const ids = shownIds(full);
  assert.equal(ids.length, 8);
  assert.ok(lines[0]!.includes(`Records that apply: ${ids.slice(0, 6).join(", ")} (+2 more).`), `${lines[0]} vs ${ids.join(", ")}`);
});

test("D1: no pointer for grounding already served, and a pointer is given once per session and agent", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy" });
  assert.match(ctxOf(hook(root, session, edit(root, "src/a.ts", { prompt_id: "p1" }))), /con_a_block/, "src/a.ts served in full first");
  shellWrite(root, "a");
  assert.equal(hook(root, session, bash({ prompt_id: "p1" })), null, "the agent already holds src/a.ts's grounding: no pointer");

  shellWrite(root, "b");
  assert.match(ctxOf(hook(root, session, bash({ prompt_id: "p1" }))), /^Hunch: src\/b\.ts was written by a shell command/);
  shellWrite(root, "b");
  assert.equal(hook(root, session, bash({ prompt_id: "p1" })), null, "same file, same records: the pointer is not repeated");
  // A subagent starts with fresh context: its own pointer.
  hook(root, session, { hook_event_name: "SubagentStart", agent_id: "agent-d1", agent_type: "Explore" });
  shellWrite(root, "b");
  assert.match(ctxOf(hook(root, session, bash({ prompt_id: "p1", agent_id: "agent-d1" }))), /^Hunch: src\/b\.ts was written by a shell command/);
  // And a written file Hunch knows nothing about never gets a pointer.
  shellWrite(root, "plain");
  assert.equal(hook(root, session, bash({ prompt_id: "p1" })), null);
});

test("D2: an unchanged repeat is silent and still records the refreshed receipt; HUNCH_HOOK_DIET=0 restores the one-liner", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  assert.match(ctxOf(hook(root, session, edit(root, "src/b.ts"))), /con_b_block \| constraint\/blocking/);
  assert.equal(hook(root, session, edit(root, "src/b.ts")), null, "a repeat emits nothing");
  assert.deepEqual(receipts(root, session), [{ event: "served", target: "src/b.ts" }, { event: "refreshed", target: "src/b.ts" }]);

  const old = sid();
  const off = { HUNCH_HOOK_DIET: "0" };
  assert.match(ctxOf(hook(root, old, edit(root, "src/b.ts"), off)), /con_b_block \| constraint\/blocking/);
  assert.equal(
    ctxOf(hook(root, old, edit(root, "src/b.ts"), off)),
    'Hunch grounding for src/b.ts: unchanged this session (0 decision(s), 1 invariant(s) shown earlier — still current; hunch_why("src/b.ts") to re-expand).',
  );
  assert.deepEqual(receipts(root, old).map((r) => r.event), ["served", "refreshed"]);
});

test("HUNCH_HOOK_DIET=0: a shell write gets the v1.42.0 full grounding and header", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  const off = { HUNCH_HOOK_DIET: "0" };
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy" }, off);
  shellWrite(root, "a", "b", "c", "d", "plain");
  const out = ctxOf(hook(root, session, bash({ prompt_id: "p1" }), off));
  assert.ok(out.startsWith("Hunch: this shell command wrote src/a.ts, src/b.ts, src/c.ts (2 more written file(s) not checked). Edits made outside the Edit/Write tools skip the pre-edit grounding, so it arrives now: re-check the change against it before relying on it.\n\n"), out.slice(0, 300));
  assert.match(out, /con_a_block \| constraint\/blocking/);
  assert.match(out, /con_b_block \| constraint\/blocking/);
  assert.match(out, /con_c_warn \| constraint\/warning/);
  assert.doesNotMatch(out, /was written by a shell command|⛔ blocking/);
  assert.equal(new Set(receipts(root, session).filter((r) => r.event === "served").map((r) => r.target)).size, 3, "the old path serves (and dedups) each grounded file");
  shellWrite(root, "a");
  assert.equal(hook(root, session, bash({ prompt_id: "p1" }), off), null, "already served: no repeat");
});

test("D3: full grounding is capped per session; the crossing file gets the pointer, with no side effects", { timeout: 240_000 }, t => {
  const root = fixture(t);
  const session = sid();
  let used = 0;
  let withheld = "";
  let pointer = "";
  for (const f of ["f1", "f2", "f3", "f4"]) {
    const out = ctxOf(hook(root, session, edit(root, `src/budget/${f}.ts`)));
    if (/withheld/.test(out)) { withheld = f; pointer = out; break; }
    assert.match(out, new RegExp(`con_budget_${f}_0 \\| constraint/blocking`));
    used += out.length; // no prompt task → the context IS the charged grounding text
  }
  assert.ok(withheld, "four ~3KB groundings must cross an 8,000-character budget");
  assert.ok(used <= BUDGET, `delivered ${used} within the budget`);
  // The same file's full grounding, measured in a session with the diet off.
  const wouldBe = ctxOf(hook(root, sid(), edit(root, `src/budget/${withheld}.ts`), { HUNCH_HOOK_DIET: "0" }));
  assert.ok(used + wouldBe.length > BUDGET, `withheld only because ${used} + ${wouldBe.length} crosses ${BUDGET}`);
  const lines = pointer.split("\n");
  assert.match(lines[0]!, new RegExp(`^Hunch: grounding for src/budget/${withheld}\\.ts withheld \\(session grounding budget reached\\)\\. Records that apply: (con_budget_${withheld}_\\d, ){5}con_budget_${withheld}_\\d \\(\\+2 more\\)\\. Full grounding: hunch_why\\("src/budget/${withheld}\\.ts"\\)\\.$`));
  assert.equal(lines.length, 9, "eight blocking lines under the pointer");
  assert.ok(lines.slice(1).every((l) => new RegExp(`^  ⛔ blocking con_budget_${withheld}_\\d: ${withheld} rule \\d: keep the recorded contract`).test(l)), lines.slice(1).join("\n"));
  assert.ok(!receipts(root, session).some((r) => r.target === `src/budget/${withheld}.ts`), "the withheld grounding wrote no receipt");
  assert.equal(hook(root, session, edit(root, `src/budget/${withheld}.ts`)), null, "the pointer is not repeated");
  // An earlier-served file's repeat is free and stays silent.
  assert.equal(hook(root, session, edit(root, "src/budget/f1.ts")), null);

  // Per agent identity: a subagent has its own budget.
  assert.match(ctxOf(hook(root, session, edit(root, `src/budget/${withheld}.ts`, { agent_id: "agent-d3" }))), new RegExp(`con_budget_${withheld}_0 \\| constraint/blocking`));
  // Compaction resets the budget with the dedup map.
  hook(root, session, { hook_event_name: "PreCompact" });
  assert.match(ctxOf(hook(root, session, edit(root, `src/budget/${withheld}.ts`))), new RegExp(`con_budget_${withheld}_0 \\| constraint/blocking`), "post-compact grounding is full again");
});

test("D3: a single grounding over the whole budget is withheld; a cache error or HUNCH_HOOK_DEDUP=0 fails toward grounding", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  const huge = ctxOf(hook(root, session, edit(root, "src/huge.ts")));
  assert.match(huge, /^Hunch: grounding for src\/huge\.ts withheld \(session grounding budget reached\)\. Records that apply: (con_huge_\d+, ){5}con_huge_\d+ \(\+34 more\)\./);
  assert.equal(huge.split("\n").length, 41);
  assert.ok(ctxOf(hook(root, sid(), edit(root, "src/huge.ts"), { HUNCH_HOOK_DIET: "0" })).length > BUDGET, "the fixture's grounding really is over the cap");

  // The session's cache path is unusable: every answer falls back to full.
  const broken = sid();
  mkdirSync(join(root, ".tmp", "hunch-hookcache", `${broken}.json`), { recursive: true });
  for (let i = 0; i < 2; i++) assert.match(ctxOf(hook(root, broken, edit(root, "src/huge.ts"))), /con_huge_0 \| constraint\/blocking/, "grounded beats budgeted");
  // The dedup kill switch also disables the budget.
  assert.match(ctxOf(hook(root, sid(), edit(root, "src/huge.ts"), { HUNCH_HOOK_DEDUP: "0" })), /con_huge_0 \| constraint\/blocking/);
});

test("pointer content: what hunch_why cannot re-expand rides along verbatim — a markdown file's current decision, retired code — and its decisions count as applying", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  const guide = ctxOf(hook(root, session, edit(root, "docs/guide.md")));
  const lines = guide.split("\n");
  assert.match(lines[0]!, /^Hunch: grounding for docs\/guide\.md withheld \(session grounding budget reached\)\. Records that apply: (con_guide_\d+, ){5}con_guide_\d+ \(\+35 more\)\. Full grounding: hunch_why\("docs\/guide\.md"\)\.$/, "forty invariants plus the anchored decision");
  assert.ok(lines.slice(1, 41).every((l) => l.startsWith("  ⛔ blocking con_guide_")), "blocking lines first");
  assert.deepEqual(lines.slice(41), [
    "🧭 Doc-grounding — this document declares topic anchors; the GRAPH is the source of truth. Follow the current decision, update prose to match it:",
    '• topic "guide.layout" → current decision dec_aaaa000001 — "Two-column layout": Guides use the two-column layout',
  ], "then the current decision block, verbatim");

  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy" });
  shellWrite(root, "retired");
  assert.equal(ctxOf(hook(root, session, bash({ prompt_id: "p1" }))), [
    'Hunch: src/retired.ts was written by a shell command. Records that apply: dec_bbbb000002. Full grounding: hunch_why("src/retired.ts").',
    "⚠ Deliberately RETIRED from this file — do not re-introduce without cause: legacyHelper (dec_bbbb000002).",
  ].join("\n"));
});

/** The main agent's charged grounding budget, read from the hook's session cache. */
function budgetUsed(root: string, session: string): number {
  const map = JSON.parse(readFileSync(join(root, ".tmp", "hunch-hookcache", `${session}.json`), "utf8")) as Record<string, string>;
  return Number(map["budget:grounding"] ?? 0);
}

test("D2: grounding served in full under one prompt is a repeat under the next — silent, free, no task delivery, no shell-write pointer, receipt refreshed", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy billing" });
  const p1 = listReportTasks(root)[0]!.task_id;
  assert.match(ctxOf(hook(root, session, edit(root, "src/b.ts", { prompt_id: "p1" }))), /con_b_block \| constraint\/blocking/);
  const spent = budgetUsed(root, session);
  assert.ok(spent > 0, "the full delivery was charged");
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: "now the totals" });
  const p2 = listReportTasks(root).find((x) => x.task_id !== p1)!.task_id;
  // Rows per event for src/b.ts (a refresh under p2 also covers its task line).
  const count = (event: string) => receipts(root, session).filter((r) => r.target === "src/b.ts" && r.event === event).length;
  assert.equal(count("refreshed"), 0);

  assert.equal(hook(root, session, edit(root, "src/b.ts", { prompt_id: "p2" })), null, "the agent still holds it: silent under the new prompt");
  assert.equal(budgetUsed(root, session), spent, "a repeat costs no budget");
  assert.equal(readTaskReport(root, p2).deliveries.length, 0, "a repeat is no delivery to the later prompt's task");
  const served = count("served");
  const refreshed = count("refreshed");
  assert.ok(refreshed > 0, "the repeat still attests the serve");

  shellWrite(root, "b");
  assert.equal(hook(root, session, bash({ prompt_id: "p2" })), null, "no pointer to grounding the agent holds");
  assert.ok(count("refreshed") > refreshed, "the shell write still attests the serve");
  assert.equal(count("served"), served, "and serves nothing new");
  assert.equal(budgetUsed(root, session), spent);
});

test("pointer dedupe is on the pointer's own text: a shell-write pointer does not hide a later withheld pointer; neither repeats", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy" });
  shellWrite(root, "huge");
  assert.match(ctxOf(hook(root, session, bash({ prompt_id: "p1" }))), /^Hunch: src\/huge\.ts was written by a shell command\./);
  shellWrite(root, "huge");
  assert.equal(hook(root, session, bash({ prompt_id: "p1" })), null, "the same pointer is not repeated");
  assert.match(ctxOf(hook(root, session, edit(root, "src/huge.ts", { prompt_id: "p1" }))), /^Hunch: grounding for src\/huge\.ts withheld \(session grounding budget reached\)\./, "a different pointer is shown");
  assert.equal(hook(root, session, edit(root, "src/huge.ts", { prompt_id: "p1" })), null, "and not repeated either");
});

test("pointer kinds dedupe apart: shell-write and withheld pointers for one file do not alternate forever", { timeout: 180_000 }, t => {
  const root = fixture(t);
  const session = sid();
  hook(root, session, { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "tidy" });
  shellWrite(root, "huge");
  assert.match(ctxOf(hook(root, session, bash({ prompt_id: "p1" }))), /^Hunch: src\/huge\.ts was written by a shell command\./, "A");
  assert.match(ctxOf(hook(root, session, edit(root, "src/huge.ts", { prompt_id: "p1" }))), /^Hunch: grounding for src\/huge\.ts withheld \(session grounding budget reached\)\./, "B");
  shellWrite(root, "huge");
  assert.equal(hook(root, session, bash({ prompt_id: "p1" })), null, "A is not given again after B");
  assert.equal(hook(root, session, edit(root, "src/huge.ts", { prompt_id: "p1" })), null, "B is not given again after A");
});

test("pointer blocking lines: every invariant the full grounding reserves as mandatory, not only direct-glob matches", { timeout: 180_000 }, t => {
  const root = fixture(t);
  // src/core.ts is not a file and not indexed: its grounding reaches the forty
  // blocking invariants only through the matched symbol in pkg/src/core.ts.
  const store = new HunchStore(hunchPaths(root));
  store.json.put("symbols", mkSymbol("sym_core", "pkg/src/core.ts", "coreFn") as never);
  for (let i = 0; i < 40; i++) store.json.put("constraints", mkConstraint({ id: `con_core_${i}`, statement: LONG(`core rule ${i}`), scope: ["pkg/src/core.ts"], severity: "blocking" }));
  store.reindex();
  store.close();
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "core");
  const session = sid();
  const lines = ctxOf(hook(root, session, edit(root, "src/core.ts"))).split("\n");
  assert.match(lines[0]!, /^Hunch: grounding for src\/core\.ts withheld \(session grounding budget reached\)\. Records that apply: (con_core_\d+, ){5}con_core_\d+ \(\+34 more\)\./);
  assert.equal(lines.length, 41, lines.join("\n"));
  assert.ok(lines.slice(1).every((l) => /^ {2}⛔ blocking con_core_\d+: core rule \d+: keep the recorded contract/.test(l)), lines.slice(1).join("\n"));
  assert.equal(new Set(lines.slice(1)).size, 40, "each invariant once");
});
