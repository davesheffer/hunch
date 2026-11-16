import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { addedLinesSinceHead, dirtyFilesSinceHead, shellVetoReason, vetoForWrittenFiles } from "../src/core/shellveto.js";
import { postToolBlockOutput } from "../src/core/agenthook.js";

// A repo whose committed users-list.tsx already contains the rejected pattern once:
// the Veto must judge what an edit ADDS, never what was there before.
function repo(t: { after: (f: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellveto-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  mkdirSync(join(root, "src", "users"), { recursive: true });
  writeFileSync(join(root, "src", "users", "users-list.tsx"), "export const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(root); });
  return { root, store };
}

function seedStorageVeto(store: HunchStore, source = "human_confirmed") {
  store.json.put("decisions", {
    id: "dec_storage", title: "No browser storage for user data", status: "accepted", context: "",
    decision: "user preferences are saved on the server", consequences: [],
    alternatives_rejected: ["localStorage / sessionStorage"],
    rejected_tripwires: [{
      alternative: "localStorage / sessionStorage",
      scope: ["src/**"], forbids: { deps: [], symbols: [], patterns: ["\\b(localStorage|sessionStorage)\\b"] },
      provenance: { source, confidence: 1, evidence: [] },
    }],
    related_components: [], related_files: [],
    supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
  } as never);
  store.reindex();
}

const LIST = "src/users/users-list.tsx";

test("addedLinesSinceHead: only what the file gained; a moved or re-indented line was already there", t => {
  const { root } = repo(t);
  writeFileSync(join(root, LIST), "export const legacy = () => {\n    const old = localStorage.getItem('legacy');\n  return old;\n};\nconst sort = window.localStorage.getItem('users-sort');\nexport const UsersList = () => null;\n");
  assert.deepEqual(addedLinesSinceHead(root, LIST), ["const sort = window.localStorage.getItem('users-sort');"]);
});

test("addedLinesSinceHead: an untracked file counts in full; Hunch's own state never", t => {
  const { root } = repo(t);
  writeFileSync(join(root, "src", "users", "use-sort.ts"), "export const s = localStorage.getItem('s');\n");
  assert.deepEqual(addedLinesSinceHead(root, "src/users/use-sort.ts").filter(Boolean), ["export const s = localStorage.getItem('s');"]);
  assert.deepEqual(addedLinesSinceHead(root, ".hunch/events.log"), []);
});

test("vetoForWrittenFiles: a shell write that adds a rejected approach is caught", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), `${"const sort = localStorage.getItem('users-sort');\n"}export const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n`);
  const found = vetoForWrittenFiles(store, root, [LIST]);
  assert.ok(found, "the added localStorage line trips the confirmed tripwire");
  assert.equal(found!.target, LIST);
  assert.match(found!.hit.reason, /REVERSE decision dec_storage/);
});

test("vetoForWrittenFiles: an edit to a file that ALREADY holds the pattern is not a violation", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), "export const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => 'sorted';\n");
  assert.equal(vetoForWrittenFiles(store, root, [LIST]), null);
});

test("vetoForWrittenFiles: an llm_draft tripwire never blocks (advisory only, like the live Veto)", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store, "llm_draft");
  writeFileSync(join(root, "src", "users", "use-sort.ts"), "export const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/use-sort.ts"]), null);
});

test("dirtyFilesSinceHead lists changed and new files, never Hunch's state or deletions", t => {
  const { root } = repo(t);
  writeFileSync(join(root, LIST), "export const UsersList = () => 1;\n");
  writeFileSync(join(root, "src", "users", "new.ts"), "export const n = 1;\n");
  mkdirSync(join(root, ".hunch-cache"), { recursive: true });
  writeFileSync(join(root, ".hunch-cache", "x.json"), "{}");
  assert.deepEqual(dirtyFilesSinceHead(root)!.sort(), ["src/users/new.ts", LIST].sort());
});

test("shell veto text says what to do and never how to get around the guard", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), "const s = sessionStorage.getItem('x');\nexport const UsersList = () => null;\n");
  const found = vetoForWrittenFiles(store, root, [LIST])!;
  for (const when of ["write", "stop"] as const) {
    const text = shellVetoReason(found.target, found.hit, when);
    assert.match(text, /Revert that change/);
    assert.doesNotMatch(text, /supersede|firmness|disable|bypass|--no-/i);
  }
});

test("postToolBlockOutput: Claude Code gets a block, hosts without one get context", () => {
  assert.deepEqual(postToolBlockOutput("claude", "PostToolUse", "r"), { decision: "block", reason: "r", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "r" } });
  assert.notEqual((postToolBlockOutput("codex", "PostToolUse", "r") as { decision?: string } | null)?.decision, "block");
});
