import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkConstraint, tsxLoaderUrl } from "./helpers.js";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { refreshShellBaseline } from "../src/core/shellwrites.js";
import { HOOK_REMINDER } from "../src/core/hookText.js";
import { PIPELINE_LOOP, quietEmptyEnabled } from "../src/core/pipeline.js";

const cli = resolve("src/cli/index.ts");
const prov = { source: "human_confirmed", confidence: 1, evidence: [] } as const;

function repo(t: { after: (f: () => void) => void }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-quiet-")));
  t.after(() => cleanupDir(root));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n.tmp/\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  return root;
}

function decision(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id, title, topic: null, status: "accepted", context: "", decision: title, consequences: [],
    alternatives_rejected: [], rejected_tripwires: [], related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null,
    retired: { symbols: [], deps: [] }, provenance: prov, date: "2026-01-01T00:00:00Z", ...over,
  };
}

const component = {
  id: "cmp_quiet0001", kind: "module", name: "Src", responsibility: "", paths: ["src/**"], status: "active", owners: [],
  fragility: 0, provenance: prov, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

function seed(root: string, fill: (store: HunchStore) => void): void {
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  fill(store);
  store.reindex();
  store.close();
}

/** Runs the claude hook in a child; `quiet` sets HUNCH_QUIET_EMPTY through the spawned env. Returns the injected context ("" when silent). */
function ctx(root: string, quiet: boolean, payload: Record<string, unknown>): string {
  const tmp = join(root, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.HUNCH_PIPELINE;
  env.HUNCH_QUIET_EMPTY = quiet ? "1" : "0";
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env, input: JSON.stringify({ cwd: root, session_id: "quiet-s", prompt_id: "quiet-p", ...payload }), encoding: "utf8",
  }).trim();
  if (!out) return "";
  return (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
}

const edit = (file: string) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file } });

test("quiet-empty: the flag is read at call time", () => {
  const prior = process.env.HUNCH_QUIET_EMPTY;
  try {
    delete process.env.HUNCH_QUIET_EMPTY;
    assert.equal(quietEmptyEnabled(), true, "quiet-empty is the default");
    process.env.HUNCH_QUIET_EMPTY = "1";
    assert.equal(quietEmptyEnabled(), true);
    process.env.HUNCH_QUIET_EMPTY = "0";
    assert.equal(quietEmptyEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.HUNCH_QUIET_EMPTY; else process.env.HUNCH_QUIET_EMPTY = prior;
  }
});

test("quiet-empty: SessionStart on decisions only drops orientation but keeps the operating loop under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  seed(root, (s) => s.json.put("decisions", decision("dec_quiet0001", "Use zebracache for sessions") as never));
  const off = ctx(root, false, { hook_event_name: "SessionStart", source: "startup" });
  assert.match(off, /Hunch orientation — 1 decision/);
  assert.ok(off.includes(PIPELINE_LOOP));
  const quiet = ctx(root, true, { hook_event_name: "SessionStart", source: "startup" });
  assert.doesNotMatch(quiet, /Hunch orientation/);
  assert.ok(quiet.includes(PIPELINE_LOOP), "the verify loop is not memory: quiet mode must keep it");
});

test("quiet-empty: SessionStart with an active constraint still orients under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  seed(root, (s) => {
    s.json.put("decisions", decision("dec_quiet0001", "Use zebracache for sessions") as never);
    s.json.put("constraints", mkConstraint({ id: "con_quiet0001", statement: "Keep module a free of side effects", scope: ["src/a.ts"], severity: "blocking" }));
  });
  assert.match(ctx(root, true, { hook_event_name: "SessionStart", source: "startup" }), /Hunch orientation/);
});

test("quiet-empty: a prompt matching no record drops the reminder and keeps a minimal task line; a later matching prompt gets the reminder in full", t => {
  const root = repo(t);
  seed(root, (s) => s.json.put("decisions", decision("dec_quiet0001", "Use zebracache for session storage") as never));
  const offRoot = repo(t);
  seed(offRoot, (s) => s.json.put("decisions", decision("dec_quiet0001", "Use zebracache for session storage") as never));
  const off = ctx(offRoot, false, { hook_event_name: "UserPromptSubmit", prompt: "hello there", prompt_id: "p1" });
  assert.ok(off.includes(HOOK_REMINDER), "flag off: reminder present");

  const quiet = ctx(root, true, { hook_event_name: "UserPromptSubmit", prompt: "hello there", prompt_id: "p1" });
  assert.ok(!quiet.includes(HOOK_REMINDER), "flag on, empty retrieval: no reminder");
  assert.match(quiet, /Hunch report for this prompt: htask_[0-9a-f]+/);
  assert.match(quiet, /task verify htask_/);
  assert.doesNotMatch(quiet, /Same rules as this session's first report/);
  assert.ok(!quiet.includes("Hunch memory for this task"));

  const later = ctx(root, true, { hook_event_name: "UserPromptSubmit", prompt: "explain zebracache session storage", prompt_id: "p2" });
  assert.ok(later.includes("Hunch memory for this task"), "second prompt retrieves memory");
  assert.ok(later.includes(HOOK_REMINDER), "the reminder was never stamped, so it arrives in full");
});

test("quiet-empty: a correction prompt keeps reminder and nudge when retrieval is empty", t => {
  const prompt = "No, that is wrong. Never edit generated files by hand.";
  const root = repo(t);
  const on = ctx(root, true, { hook_event_name: "UserPromptSubmit", prompt });
  const offRoot = repo(t);
  const off = ctx(offRoot, false, { hook_event_name: "UserPromptSubmit", prompt });
  assert.ok(on.includes(HOOK_REMINDER));
  assert.match(on, /hunch_record_correction/);
  assert.ok(off.includes(HOOK_REMINDER));
  assert.match(off, /hunch_record_correction/);
});

test("quiet-empty: PreToolUse Edit with only structural content is silent under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  seed(root, (s) => s.json.put("components", component as never));
  const off = ctx(root, false, edit(join(root, "src", "a.ts")));
  const on = ctx(root, true, edit(join(root, "src", "a.ts")));
  // A component alone yields no block today; the flag must never ADD output.
  assert.equal(on, off);
  assert.equal(on, "");
});

test("quiet-empty: a pre-edit block that delivers no record (a withheld weak decision) is emitted today and suppressed under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  seed(root, (s) => s.json.put("decisions", decision("dec_quiet0003", "Prefer tabs in module a", {
    related_files: ["src/a.ts"],
    provenance: { source: "llm_inferred", confidence: 0.2, evidence: [] },
  }) as never));
  // A prompt that selects nothing for this file keeps the unfiltered grounding.
  ctx(root, false, { hook_event_name: "UserPromptSubmit", prompt: "rename the variable", prompt_id: "p-off", session_id: "quiet-off" });
  const off = ctx(root, false, { ...edit(join(root, "src", "a.ts")), prompt_id: "p-off", session_id: "quiet-off" });
  ctx(root, true, { hook_event_name: "UserPromptSubmit", prompt: "rename the variable", prompt_id: "p-on", session_id: "quiet-on" });
  const on = ctx(root, true, { ...edit(join(root, "src", "a.ts")), prompt_id: "p-on", session_id: "quiet-on" });
  assert.match(off, /# Hunch context for "src\/a\.ts"/, `flag off emits a block today:\n${off}`);
  assert.doesNotMatch(off, /^- (decisions|constraints|bugs|findings) /m);
  assert.equal(on, "");
});

test("quiet-empty: PreToolUse Edit in scope of an active constraint still grounds under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  seed(root, (s) => s.json.put("constraints", mkConstraint({ id: "con_quiet0001", statement: "Keep module a free of side effects", scope: ["src/a.ts"], severity: "blocking" })));
  const on = ctx(root, true, edit(join(root, "src", "a.ts")));
  assert.match(on, /Keep module a free of side effects/);
});

test("quiet-empty: PreToolUse on a markdown topic anchor still grounds under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n\n<!-- hunch:topic sessionstore -->\nSessions live in redis.\n");
  seed(root, (s) => s.json.put("decisions", decision("dec_quiet0002", "Sessions use zebracache", { topic: "sessionstore" }) as never));
  const on = ctx(root, true, edit(join(root, "docs", "guide.md")));
  assert.match(on, /zebracache/);
});

test("quiet-empty: a PostToolUse shell write of an unanchored file adds no grounding under HUNCH_QUIET_EMPTY", t => {
  const root = repo(t);
  seed(root, (s) => s.json.put("components", component as never));
  const shell = (quiet: boolean, session: string, ahead: number) => {
    refreshShellBaseline(root, session);
    writeFileSync(join(root, "src", "b.ts"), `export const b = ${ahead};\n`);
    const at = new Date(Date.now() + ahead * 1000);
    utimesSync(join(root, "src", "b.ts"), at, at);
    return ctx(root, quiet, { hook_event_name: "PostToolUse", session_id: session, tool_name: "Bash", tool_input: { command: "echo" } });
  };
  assert.doesNotMatch(shell(false, "quiet-shell-off", 5), /RETIRED|Keep module/);
  assert.doesNotMatch(shell(true, "quiet-shell-on", 10), /this shell command wrote/);
});
