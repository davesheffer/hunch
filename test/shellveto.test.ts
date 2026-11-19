import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { addedLinesSinceHead, filesChangedSinceHead, shellVetoReason, vetoForWrittenFiles } from "../src/core/shellveto.js";
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
  assert.deepEqual(addedLinesSinceHead(root, [LIST], Date.now() + 30_000)!.get(LIST), ["const sort = window.localStorage.getItem('users-sort');"]);
});

test("addedLinesSinceHead: an untracked file counts in full; Hunch's own state never", t => {
  const { root } = repo(t);
  writeFileSync(join(root, "src", "users", "use-sort.ts"), "export const s = localStorage.getItem('s');\n");
  assert.deepEqual(addedLinesSinceHead(root, ["src/users/use-sort.ts"], Date.now() + 30_000)!.get("src/users/use-sort.ts")!.filter(Boolean), ["export const s = localStorage.getItem('s');"]);
  assert.equal(addedLinesSinceHead(root, [".hunch/events.log"], Date.now() + 30_000)!.size, 0);
});

test("vetoForWrittenFiles: a shell write that adds a rejected approach is caught", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), `${"const sort = localStorage.getItem('users-sort');\n"}export const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n`);
  const found = vetoForWrittenFiles(store, root, [LIST], 30_000);
  assert.ok(found, "the added localStorage line trips the confirmed tripwire");
  assert.equal(found!.target, LIST);
  assert.match(found!.hit.reason, /REVERSE decision dec_storage/);
});

test("vetoForWrittenFiles: an edit to a file that ALREADY holds the pattern is not a violation", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), "export const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => 'sorted';\n");
  assert.equal(vetoForWrittenFiles(store, root, [LIST], 30_000), null);
});

test("vetoForWrittenFiles: an llm_draft tripwire never blocks (advisory only, like the live Veto)", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store, "llm_draft");
  writeFileSync(join(root, "src", "users", "use-sort.ts"), "export const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/use-sort.ts"], 30_000), null);
});

test("shell veto text says what to do and never how to get around the guard", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), "const s = sessionStorage.getItem('x');\nexport const UsersList = () => null;\n");
  const found = vetoForWrittenFiles(store, root, [LIST], 30_000)!;
  for (const when of ["write", "stop"] as const) {
    const text = shellVetoReason(found.target, found.hit, when);
    assert.match(text, /Revert that change/);
    assert.doesNotMatch(text, /supersede|firmness|disable|bypass|--no-/i);
  }
});

test("postToolBlockOutput: Claude Code gets a block, hosts without one get context", () => {
  assert.deepEqual(postToolBlockOutput("claude", "PostToolUse", "r"), { decision: "block", reason: "r" });
  assert.deepEqual(postToolBlockOutput("claude", "PostToolUse", "r", "g"), { decision: "block", reason: "r", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "g" } });
  assert.notEqual((postToolBlockOutput("codex", "PostToolUse", "r") as { decision?: string } | null)?.decision, "block");
});

test("vetoForWrittenFiles: a git mv of a file that already held the pattern gains nothing", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  execFileSync("git", ["-C", root, "mv", LIST, "src/users/moved.tsx"]);
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/moved.tsx"], 30_000), null);
});

const BIG = 30_000;
const sh = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("vetoForWrittenFiles: a tracked path with a space is still judged", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  mkdirSync(join(root, "src", "my dir"), { recursive: true });
  writeFileSync(join(root, "src", "my dir", "x.ts"), "export const x = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "space");
  writeFileSync(join(root, "src", "my dir", "x.ts"), "export const x = localStorage.getItem('x');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/my dir/x.ts"], BIG)?.target, "src/my dir/x.ts");
});

test("vetoForWrittenFiles: user diff prefix config (mnemonicPrefix, noprefix) does not hide a hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "o");
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
  sh(root, "config", "diff.mnemonicPrefix", "true");
  assert.ok(vetoForWrittenFiles(store, root, ["src/users/other.ts"], BIG));
  sh(root, "config", "diff.noprefix", "true");
  assert.ok(vetoForWrittenFiles(store, root, ["src/users/other.ts"], BIG));
});

test("addedLinesSinceHead: a deleted tracked file's body is never read into the diff", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "big.ts"), Array.from({ length: 20_000 }, (_, i) => `export const deletedBody${i} = ${i};`).join("\n"));
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "big");
  sh(root, "rm", "-q", "src/big.ts");
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = localStorage.getItem('o');\n");
  const added = addedLinesSinceHead(root, ["src/users/other.ts"], Date.now() + BIG)!;
  assert.ok(![...added.values()].flat().some((l) => l.includes("deletedBody")));
  assert.ok(vetoForWrittenFiles(store, root, ["src/users/other.ts"], BIG));
});

test("addedLinesSinceHead: an added line starting with '++ ' is content, not a header", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "o");
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\n++ marker\nconst s = localStorage.getItem('s');\n");
  assert.deepEqual(addedLinesSinceHead(root, ["src/users/other.ts"], Date.now() + BIG)!.get("src/users/other.ts"), ["++ marker", "const s = localStorage.getItem('s');"]);
  assert.ok(vetoForWrittenFiles(store, root, ["src/users/other.ts"], BIG));
});

test("vetoForWrittenFiles: git spawns stay bounded for many in-scope files; the newest are judged", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const files = Array.from({ length: 60 }, (_, i) => `src/users/f${i}.ts`);
  for (const f of files) writeFileSync(join(root, f), "export const f = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "many");
  for (const f of files) writeFileSync(join(root, f), "export const f = 2;\n");
  writeFileSync(join(root, files[59]!), "export const f = localStorage.getItem('f');\n");
  const trace = join(root, "..", `trace-${Date.now()}-${process.pid}.log`);
  const prior = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = trace;
    assert.equal(vetoForWrittenFiles(store, root, files, BIG, { newestFirst: true })?.target, files[59]);
    const spawns = readFileSync(trace, "utf8").split("\n").filter((l) => /trace: built-in: git /.test(l)).length;
    // One cat-file batch, whatever the file count.
    assert.ok(spawns >= 1 && spawns <= 3, `bounded git spawns, got ${spawns}`);
  } finally {
    if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior;
    cleanupDir(trace);
  }
});

const withEnv = <T>(key: string, value: string, f: () => T): T => {
  const prior = process.env[key];
  try {
    process.env[key] = value;
    return f();
  } finally {
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
  }
};

test("vetoForWrittenFiles: HUNCH_SHELL_VETO_BUDGET_MS=1 fails open on a write that hits under a large budget", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "use-sort.ts"), "export const s = localStorage.getItem('s');\n");
  assert.ok(withEnv("HUNCH_SHELL_VETO_BUDGET_MS", "30000", () => vetoForWrittenFiles(store, root, ["src/users/use-sort.ts"])), "hits with time to spare");
  assert.equal(withEnv("HUNCH_SHELL_VETO_BUDGET_MS", "1", () => vetoForWrittenFiles(store, root, ["src/users/use-sort.ts"])), null);
});

test("vetoForWrittenFiles: a fractional HUNCH_SHELL_VETO_BUDGET_MS still leaves the Veto on", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "use-sort.ts"), "export const s = localStorage.getItem('s');\n");
  assert.ok(withEnv("HUNCH_SHELL_VETO_BUDGET_MS", "30000.5", () => vetoForWrittenFiles(store, root, ["src/users/use-sort.ts"])));
});

test("vetoForWrittenFiles: a huge tracked rewrite in the same batch cannot hide a hit in another file", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const big = join(root, "src", "generated.ts");
  writeFileSync(big, Array.from({ length: 100_000 }, (_, i) => `export const generatedValue${i} = "${"a".repeat(30)}";`).join("\n"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "gen");
  // Every line changes: a diff of ~10 MB, past the 8 MB buffer of one batched diff.
  writeFileSync(big, Array.from({ length: 100_000 }, (_, i) => `export const generatedValue${i} = "${"b".repeat(30)}";`).join("\n"));
  writeFileSync(join(root, LIST), "const sort = localStorage.getItem('users-sort');\nexport const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/generated.ts", LIST], BIG)?.target, LIST);
});

test("vetoForWrittenFiles: one command's writes are all judged, past the first 50", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const files = Array.from({ length: 60 }, (_, i) => `src/users/g${String(i).padStart(2, "0")}.ts`);
  for (const f of files) writeFileSync(join(root, f), "export const g = 1;\n");
  writeFileSync(join(root, files[3]!), "export const g = localStorage.getItem('g');\n");
  assert.equal(vetoForWrittenFiles(store, root, files, BIG)?.target, files[3]);
});

test("postToolBlockOutput: on PostToolUseFailure Claude also gets the reason as context", () => {
  assert.deepEqual(postToolBlockOutput("claude", "PostToolUseFailure", "r", "g"), { decision: "block", reason: "r", hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "r\n\ng" } });
});

test("vetoForWrittenFiles: a file with more than 20k changed lines is still judged", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const mid = (c: string) => Array.from({ length: 11_000 }, (_, i) => `export const v${i} = "${c}";`).join("\n") + "\n";
  writeFileSync(join(root, "src", "users", "mid.ts"), mid("a"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "mid");
  writeFileSync(join(root, "src", "users", "mid.ts"), mid("b") + "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/mid.ts"], BIG)?.target, "src/users/mid.ts");
});

test("vetoForWrittenFiles: a ~10 MB long-line rewrite cannot hide a small file's hit at the default budget", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const gen = join(root, "src", "users", "gen.ts");
  const body = (c: string) => Array.from({ length: 2000 }, () => `// ${c.repeat(2500)}`).join("\n");
  writeFileSync(gen, body("a"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "gen");
  writeFileSync(gen, body("b"));
  writeFileSync(join(root, LIST), "const sort = localStorage.getItem('users-sort');\nexport const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n");
  // No budget given and no env override: the 5 s default.
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/gen.ts", LIST])?.target, LIST);
});

test("vetoForWrittenFiles: a minified one-line bundle with one changed char cannot hide a hit elsewhere", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const gen = join(root, "src", "users", "bundle.js");
  const line = "x".repeat(4_500_000);
  writeFileSync(gen, line);
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "bundle");
  writeFileSync(gen, "z" + line.slice(1));
  writeFileSync(join(root, LIST), "const sort = localStorage.getItem('users-sort');\nexport const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/bundle.js", LIST], BIG)?.target, LIST);
});

// Round 6: every case below runs at the DEFAULT budget (no override).
const LEGACY_BODY = "export const cache = () => {\n  const v = localStorage.getItem(\"cache\");\n  return v;\n};\nexport const a = 1;\n";
const BAD_LIST = "const sort = localStorage.getItem('users-sort');\nexport const legacy = () => {\n  const old = localStorage.getItem('legacy');\n  return old;\n};\nexport const UsersList = () => null;\n";

test("default budget: 50 tracked files rewritten at once, the violation in the LARGEST → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const files = Array.from({ length: 50 }, (_, i) => `src/users/w${i}.ts`);
  files.forEach((f, i) => writeFileSync(join(root, f), `export const w = ${i};\n`.repeat(i + 1)));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "w");
  files.forEach((f, i) => writeFileSync(join(root, f), `export const w = ${i + 1};\n`.repeat(i + 1)));
  writeFileSync(join(root, files[49]!), `export const w = 99;\n`.repeat(60) + "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, files)?.target, files[49]);
});

test("default budget: at most 3 git spawns for 50 files", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const files = Array.from({ length: 50 }, (_, i) => `src/users/n${i}.ts`);
  for (const f of files) writeFileSync(join(root, f), "export const n = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "n");
  for (const f of files) writeFileSync(join(root, f), "export const n = 2;\n");
  writeFileSync(join(root, "src", "users", "fresh.ts"), "export const f = 1;\n");
  const trace = join(root, "..", `trace3-${Date.now()}-${process.pid}.log`);
  const prior = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = trace;
    assert.equal(vetoForWrittenFiles(store, root, [...files, "src/users/fresh.ts"].slice(-50), undefined, { newestFirst: true }), null);
    const spawns = readFileSync(trace, "utf8").split("\n").filter((l) => /trace: built-in: git /.test(l)).length;
    assert.ok(spawns >= 1 && spawns <= 3, `at most 3 git spawns, got ${spawns}`);
  } finally {
    if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior;
    cleanupDir(trace);
  }
});

test("rename into scope: git mv legacy/store.ts → src/users/store.ts carries the pattern in → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  mkdirSync(join(root, "legacy"), { recursive: true });
  writeFileSync(join(root, "legacy", "store.ts"), LEGACY_BODY);
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "legacy");
  sh(root, "mv", "legacy/store.ts", "src/users/store.ts");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/store.ts"])?.target, "src/users/store.ts");
});

test("rename into scope: an out-of-scope unstaged delete + a staged new in-scope copy → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "example.ts"), LEGACY_BODY);
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "docs");
  rmSync(join(root, "docs", "example.ts"));
  writeFileSync(join(root, "src", "users", "prefs.ts"), LEGACY_BODY + "export const added = 3;\n");
  sh(root, "add", "src/users/prefs.ts");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/prefs.ts"])?.target, "src/users/prefs.ts");
});

test("rename into scope: plain mv then git add -A → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  mkdirSync(join(root, "legacy"), { recursive: true });
  writeFileSync(join(root, "legacy", "store.ts"), LEGACY_BODY);
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "legacy");
  renameSync(join(root, "legacy", "store.ts"), join(root, "src", "users", "store.ts"));
  sh(root, "add", "-A");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/store.ts"])?.target, "src/users/store.ts");
});

test("220 deleted tracked files with long paths do not stop the check", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const dir = join(root, "src", "d".repeat(60), "e".repeat(60));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 220; i++) writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}-${"x".repeat(20)}.ts`), `export const v${i} = ${i};\n`);
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "many");
  rmSync(dir, { recursive: true, force: true }); // rmSync-ok: deletes committed files as the scenario under test
  writeFileSync(join(root, "src", "users", "other.ts"), "export const o = 1;\nconst s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/other.ts"])?.target, "src/users/other.ts");
});

test("CRLF working copy against an LF blob: only the changed line counts", t => {
  const { root } = repo(t);
  writeFileSync(join(root, "src", "users", "eol.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "eol");
  writeFileSync(join(root, "src", "users", "eol.ts"), "export const a = 1;\r\nexport const b = 22;\r\nexport const c = 3;\r\n");
  assert.deepEqual(addedLinesSinceHead(root, ["src/users/eol.ts"])!.get("src/users/eol.ts"), ["export const b = 22;"]);
});

test("binary file and Git LFS pointer → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "blob.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "src", "users", "lfs.ts"), "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "bin");
  writeFileSync(join(root, "src", "users", "blob.bin"), Buffer.concat([Buffer.from([0]), Buffer.from("localStorage.getItem('x')\n")]));
  // Pointer to pointer (the text a new pointer carries is not code): no hit.
  writeFileSync(join(root, "src", "users", "lfs.ts"), "version https://git-lfs.github.com/spec/v1\noid sha256:localStorage\nsize 4\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/blob.bin", "src/users/lfs.ts"]), null);
});

test("a path with a space and unicode is judged", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const rel = "src/my dir/ünï cødé.ts";
  mkdirSync(join(root, "src", "my dir"), { recursive: true });
  writeFileSync(join(root, rel), "export const u = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "u");
  writeFileSync(join(root, rel), "export const u = localStorage.getItem('u');\n");
  assert.equal(vetoForWrittenFiles(store, root, [rel])?.target, rel);
});

test("a repository with no commit yet: everything counts", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellveto-nocommit-")));
  sh(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const s = localStorage.getItem('s');\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(root); });
  seedStorageVeto(store);
  assert.equal(vetoForWrittenFiles(store, root, ["src/a.ts"])?.target, "src/a.ts");
});

test("a staged new file counts in full", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "staged.ts"), "const s = localStorage.getItem('s');\n");
  sh(root, "add", "src/users/staged.ts");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/staged.ts"])?.target, "src/users/staged.ts");
});

test("a Hunch root in a subdirectory resolves HEAD paths against itself", t => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellveto-sub-")));
  sh(top, "init", "-q");
  const root = join(top, "pkg");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  sh(top, "add", "-A"); sh(top, "commit", "-q", "-m", "sub");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nconst s = localStorage.getItem('s');\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(top); });
  seedStorageVeto(store);
  assert.deepEqual(addedLinesSinceHead(root, ["src/a.ts"])!.get("src/a.ts"), ["const s = localStorage.getItem('s');"]);
  assert.equal(vetoForWrittenFiles(store, root, ["src/a.ts"])?.target, "src/a.ts");
});

test("default budget: >20k changed lines and a 10 MB long-line rewrite still hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const mid = (c: string) => Array.from({ length: 11_000 }, (_, i) => `export const v${i} = "${c}";`).join("\n") + "\n";
  writeFileSync(join(root, "src", "users", "mid.ts"), mid("a"));
  const gen = (c: string) => Array.from({ length: 2000 }, () => `// ${c.repeat(2500)}`).join("\n");
  writeFileSync(join(root, "src", "users", "gen.ts"), gen("a"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "big");
  writeFileSync(join(root, "src", "users", "mid.ts"), mid("b") + "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/mid.ts"])?.target, "src/users/mid.ts");
  writeFileSync(join(root, "src", "users", "mid.ts"), mid("a"));
  writeFileSync(join(root, "src", "users", "gen.ts"), gen("b"));
  writeFileSync(join(root, LIST), BAD_LIST);
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/gen.ts", LIST])?.target, LIST);
});

// Round 7: exact-content 1:1 move pairing, UTF-16, size batching (default budget).
function seedEvalVeto(store: HunchStore, scope: string[]) {
  store.json.put("decisions", {
    id: "dec_eval", title: "No eval", status: "accepted", context: "", decision: "no dynamic code", consequences: [],
    alternatives_rejected: ["eval"],
    rejected_tripwires: [{ alternative: "eval", scope, forbids: { deps: [], symbols: [], patterns: ["\\beval\\("] }, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }],
    related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
  } as never);
  store.reindex();
}

for (const [tag, scope] of [["T1a", [] as string[]], ["T1b", ["**/*.ts"]]] as const) {
  test(`move into scope with an unrelated blocking tripwire (${tag}, scope ${JSON.stringify(scope)}) → hit`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    seedEvalVeto(store, [...scope]);
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(join(root, "legacy", "store.ts"), LEGACY_BODY);
    sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "legacy");
    sh(root, "mv", "legacy/store.ts", "src/users/store.ts");
    assert.equal(vetoForWrittenFiles(store, root, ["src/users/store.ts"])?.target, "src/users/store.ts");
  });
}

test("one deleted file's line copied into three new files (T2) → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  rmSync(join(root, LIST));
  const body = (n: string) => `export const ${n} = () => {\n  const old = localStorage.getItem("legacy");\n  return old + "${n}";\n};\n`;
  for (const n of ["a", "b", "c"]) writeFileSync(join(root, "src", "users", `${n}.ts`), body(n));
  assert.ok(vetoForWrittenFiles(store, root, ["src/users/a.ts", "src/users/b.ts", "src/users/c.ts"]));
});

test("an unrelated deleted file sharing one line does not excuse a new file (T2b) → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  mkdirSync(join(root, "src", "old"), { recursive: true });
  writeFileSync(join(root, "src", "old", "junk.ts"), "// junk\nlocalStorage.clear();\n" + "// filler\n".repeat(200));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "junk");
  rmSync(join(root, "src", "old", "junk.ts"));
  writeFileSync(join(root, "src", "users", "logout.ts"), "export function logout() {\n  localStorage.clear();\n}\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/logout.ts"])?.target, "src/users/logout.ts");
});

test("an in-scope git mv that also adds a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  sh(root, "mv", LIST, "src/users/moved.tsx");
  writeFileSync(join(root, "src", "users", "moved.tsx"), readFileSync(join(root, "src", "users", "moved.tsx"), "utf8") + "const s = sessionStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/moved.tsx"])?.target, "src/users/moved.tsx");
});

test("a UTF-16LE working-tree-encoding file gaining a violating line (T3) → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, ".gitattributes"), "*.ps1 text working-tree-encoding=UTF-16LE-BOM eol=crlf\n");
  const enc = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s.replace(/\n/g, "\r\n"), "utf16le")]);
  writeFileSync(join(root, "src", "users", "tool.ps1"), enc("Write-Host 'hi'\n$x = 1\n"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "ps1");
  writeFileSync(join(root, "src", "users", "tool.ps1"), enc("Write-Host 'hi'\n$x = 1\n$y = localStorage.getItem('k')\n"));
  assert.deepEqual(addedLinesSinceHead(root, ["src/users/tool.ps1"])!.get("src/users/tool.ps1"), ["$y = localStorage.getItem('k')"]);
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/tool.ps1"])?.target, "src/users/tool.ps1");
});

test("default budget: a small violating file is judged before several 8 MB rewrites", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const bigs = Array.from({ length: 5 }, (_, i) => `src/users/big${i}.ts`);
  const big = (c: string) => `// ${c.repeat(1000)}\n`.repeat(8_000);
  for (const f of bigs) writeFileSync(join(root, f), big("a"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "bigs");
  for (const f of bigs) writeFileSync(join(root, f), big("b"));
  writeFileSync(join(root, LIST), BAD_LIST);
  assert.equal(vetoForWrittenFiles(store, root, [...bigs, LIST])?.target, LIST);
});

// Round 8.
function seedPatternVeto(store: HunchStore, id: string, pattern: string, scope: string[]) {
  store.json.put("decisions", {
    id, title: id, status: "accepted", context: "", decision: "chosen", consequences: [],
    alternatives_rejected: ["rejected"],
    rejected_tripwires: [{ alternative: "rejected", scope, forbids: { deps: [], symbols: [], patterns: [pattern] }, provenance: { source: "human_confirmed", confidence: 1, evidence: [] } }],
    related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
    valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: "2026-01-01T00:00:00Z",
  } as never);
  store.reindex();
}

test("every candidate is judged: 51 session files, the violation in the EARLIEST → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const files = Array.from({ length: 51 }, (_, i) => `src/users/s${String(i).padStart(2, "0")}.ts`);
  for (const f of files) writeFileSync(join(root, f), "export const s = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "s");
  for (const f of files) writeFileSync(join(root, f), "export const s = 2;\n");
  writeFileSync(join(root, files[0]!), "export const s = localStorage.getItem('s');\n");
  // Logic, not timing: a loaded runner must not turn the second chunk into a fail-open.
  assert.equal(vetoForWrittenFiles(store, root, files, BIG, { newestFirst: true })?.target, files[0]);
});

test("tree mode, no commit yet: a staged violating file is listed and judged", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellveto-tree0-")));
  sh(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "const s = localStorage.getItem('s');\n");
  sh(root, "add", "-A");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(root); });
  seedStorageVeto(store);
  const listed = filesChangedSinceHead(root)!;
  assert.ok(listed.includes("src/a.ts"), `listed: ${listed.join(",")}`);
  assert.equal(vetoForWrittenFiles(store, root, listed)?.target, "src/a.ts");
});

test("an anchored pattern sees the added module-level line, not an old indented twin", t => {
  const { root, store } = repo(t);
  seedPatternVeto(store, "dec_cache", "^const cache = new Map", ["src/**"]);
  writeFileSync(join(root, "src", "users", "cache.ts"), "export function f() {\n  const cache = new Map();\n  return cache;\n}\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "cache");
  writeFileSync(join(root, "src", "users", "cache.ts"), "const cache = new Map();\nexport function f() {\n  const cache = new Map();\n  return cache;\n}\n");
  // The screen is a superset (both spellings of the surplus line); the confirm decides.
  assert.ok(addedLinesSinceHead(root, ["src/users/cache.ts"])!.get("src/users/cache.ts")!.includes("const cache = new Map();"));
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/cache.ts"])?.target, "src/users/cache.ts");
});

test("one deleted file excuses one new copy across chunks: a00.ts and z99.ts both copy it → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const body = readFileSync(join(root, LIST), "utf8");
  rmSync(join(root, LIST));
  const files = ["src/users/a00.ts", ...Array.from({ length: 49 }, (_, i) => `src/users/m${String(i).padStart(2, "0")}.ts`), "src/users/z99.ts"];
  for (const f of files) writeFileSync(join(root, f), f.includes("/m") ? `export const m = "${f}";\n` : body);
  const found = vetoForWrittenFiles(store, root, files, BIG);
  assert.ok(found, "the second copy is not a move");
  assert.equal(found!.target, "src/users/z99.ts");
});

test("an untracked file with a NUL byte is still read as text → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "nul.ts"), Buffer.concat([Buffer.from("// \u0000 marker\n"), Buffer.from("const s = localStorage.getItem('s');\n")]));
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/nul.ts"])?.target, "src/users/nul.ts");
});

test("Q5a: an LFS pointer in HEAD replaced by real violating text (no lfs filter) → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "data.ts"), "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "lfs");
  writeFileSync(join(root, "src", "users", "data.ts"), "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/data.ts"])?.target, "src/users/data.ts");
});

test("Q5c: an untracked file starting FF FE then ASCII is read as text → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "fffe.ts"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("\nconst s = localStorage.getItem('s');\n")]));
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/fffe.ts"])?.target, "src/users/fffe.ts");
});

// Round 9 (default budget throughout).
const fixture150k = (): string => "[\n" + Array.from({ length: 150_000 }, (_, i) => `  {"k": ${i}},`).join("\n") + "\n]\n";

test("a 150k-line untracked file sorted before a tracked violator does not hide it (w3 A)", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, "src", "users", "aaa-data.json"), fixture150k());
  writeFileSync(join(root, LIST), readFileSync(join(root, LIST), "utf8") + "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/aaa-data.json", LIST])?.target, LIST);
});

test("Stop order: violator written first, then a 150k-line new file, newest first → hit (w4)", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  writeFileSync(join(root, LIST), readFileSync(join(root, LIST), "utf8") + "const s = localStorage.getItem('s');\n");
  writeFileSync(join(root, "src", "users", "aaa-data.json"), fixture150k());
  assert.equal(vetoForWrittenFiles(store, root, [LIST, "src/users/aaa-data.json"], undefined, { newestFirst: true })?.target, LIST);
});

for (const [ext, enc, encode] of [
  ["ps1", "UTF-16LE", (s: string) => Buffer.from(s, "utf16le")],
  ["rc", "UTF-16BE", (s: string) => Buffer.from(s, "utf16le").swap16()],
] as const) {
  test(`BOM-less ${enc} working-tree-encoding: a violating line appended → hit (w1 W1)`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    writeFileSync(join(root, ".gitattributes"), `*.${ext} text working-tree-encoding=${enc}\n`);
    const f = `src/users/tool.${ext}`;
    writeFileSync(join(root, f), encode("x = 1\n"));
    sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", enc);
    writeFileSync(join(root, f), encode("x = 1\ns = localStorage.getItem('s')\n"));
    assert.equal(vetoForWrittenFiles(store, root, [f])?.target, f);
  });
}

test("anchored tripwire: a move that dedents the line → hit; a verbatim move → no hit (w1 W5)", t => {
  const { root, store } = repo(t);
  seedPatternVeto(store, "dec_anch", "^const old = localStorage", ["src/**"]);
  const seed = readFileSync(join(root, LIST), "utf8");
  rmSync(join(root, LIST));
  writeFileSync(join(root, "src", "users", "moved.tsx"), seed);
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/moved.tsx"]), null, "verbatim move");
  writeFileSync(join(root, "src", "users", "moved.tsx"), seed.split("\n").map((l) => l.trim()).join("\n"));
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/moved.tsx"])?.target, "src/users/moved.tsx");
});

// Round 10 (default budget).
test("a fresh store with 1501 decisions: loading them does not spend the budget → hit (k3/k2 T)", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  for (let i = 0; i < 1500; i++) {
    store.json.put("decisions", {
      id: `dec_draft${String(i).padStart(4, "0")}`, title: `draft ${i}`, status: "accepted", context: "", decision: `d${i}`, consequences: [],
      alternatives_rejected: ["x"],
      rejected_tripwires: [{ alternative: "x", scope: ["src/**"], forbids: { deps: [], symbols: [], patterns: [`\\bnever_${i}\\b`] }, provenance: { source: "llm_draft", confidence: 0.5, evidence: [] } }],
      related_components: [], related_files: [], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null,
      valid_from: "2026-01-01T00:00:00Z", valid_to: null, retired: { symbols: [], deps: [] },
      provenance: { source: "llm_draft", confidence: 0.5, evidence: [] }, date: "2026-01-01T00:00:00Z",
    } as never);
  }
  store.reindex();
  writeFileSync(join(root, LIST), readFileSync(join(root, LIST), "utf8") + "const s = localStorage.getItem('s');\n");
  const fresh = new HunchStore(hunchPaths(root));
  try {
    assert.equal(vetoForWrittenFiles(fresh, root, [LIST])?.target, LIST);
  } finally { fresh.close(); }
});

for (const mode of ["add", "add -N"] as const) {
  test(`a 600 KB new file ending in a violating line, \`git ${mode}\`-ed → hit (k1)`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    const f = "src/users/big-new.ts";
    writeFileSync(join(root, f), "// filler line for size\n".repeat(25_000) + "const s = localStorage.getItem('s');\n");
    if (mode === "add") sh(root, "add", f); else sh(root, "add", "-N", f);
    assert.equal(vetoForWrittenFiles(store, root, [f])?.target, f);
  });
}

// Round 11: screen + confirm.
for (const [pattern, line] of [["^import moment", "import moment from 'moment';"], ["^localStorage\\.setItem", "localStorage.setItem('k', '1');"]] as const) {
  test(`M1: re-indent an old column-0 line and append a new column-0 copy (${pattern}) → hit`, t => {
    const { root, store } = repo(t);
    seedPatternVeto(store, "dec_m1", pattern, ["src/**"]);
    const f = join(root, "src", "users", "m1.ts");
    writeFileSync(f, `${line}\nexport const a = 1;\n`);
    sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "m1");
    writeFileSync(f, `function wrap() {\n  ${line}\n}\nexport const a = 1;\n${line}\n`);
    assert.equal(vetoForWrittenFiles(store, root, ["src/users/m1.ts"])?.target, "src/users/m1.ts");
  });
}

test("M1 control: a pure re-indent of an anchored line → no hit", t => {
  const { root, store } = repo(t);
  seedPatternVeto(store, "dec_m1", "^localStorage\\.setItem", ["src/**"]);
  const f = join(root, "src", "users", "m1.ts");
  writeFileSync(f, "localStorage.setItem('k', '1');\nexport const a = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "m1");
  writeFileSync(f, "function wrap() {\n  localStorage.setItem('k', '1');\n}\nexport const a = 1;\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/m1.ts"]), null);
});

for (const mode of ["add -N", "add", "untracked"] as const) {
  test(`M2: a new BOM-less UTF-16LE .ps1 under working-tree-encoding (${mode})`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    writeFileSync(join(root, ".gitattributes"), "*.ps1 text working-tree-encoding=UTF-16LE\n");
    sh(root, "add", ".gitattributes"); sh(root, "commit", "-q", "-m", "attrs");
    const f = "src/users/new.ps1";
    writeFileSync(join(root, f), Buffer.from("$x = 1\n$s = localStorage.getItem('s')\n", "utf16le"));
    if (mode === "add -N") sh(root, "add", "-N", f);
    if (mode === "add") sh(root, "add", f);
    // The screen decodes BOM-less UTF-16 for an untracked file too.
    assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
  });
}

test("M3: `git rm --cached` plus a copy is not an exact move → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  sh(root, "rm", "-q", "--cached", LIST);
  writeFileSync(join(root, "src", "users", "copy.tsx"), readFileSync(join(root, LIST)));
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/copy.tsx"])?.target, "src/users/copy.tsx");
});

const u16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);

test("S4: `git rm --cached` then a violating line appended → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  sh(root, "rm", "-q", "--cached", LIST);
  writeFileSync(join(root, LIST), readFileSync(join(root, LIST), "utf8") + "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, [LIST], BIG)?.target, LIST);
});

test("S9: `git rm --cached` with no content change → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  assert.match(readFileSync(join(root, LIST), "utf8"), /localStorage/);
  sh(root, "rm", "-q", "--cached", LIST);
  assert.equal(vetoForWrittenFiles(store, root, [LIST], BIG), null);
});

test("H9: tracked NUL file under a `diff` attribute gaining a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/d.dat";
  writeFileSync(join(root, ".gitattributes"), "*.dat diff\n");
  writeFileSync(join(root, f), Buffer.from("a\u0000b\n"));
  sh(root, "add", ".gitattributes", f); sh(root, "commit", "-q", "-m", "dat");
  writeFileSync(join(root, f), Buffer.from("a\u0000b\nconst s = localStorage.getItem('s');\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("H9: tracked NUL file under a `diff` attribute, violation already in HEAD, unrelated edit → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/d.dat";
  writeFileSync(join(root, ".gitattributes"), "*.dat diff\n");
  writeFileSync(join(root, f), Buffer.from("a\u0000b\nconst s = localStorage.getItem('s');\n"));
  sh(root, "add", ".gitattributes", f); sh(root, "commit", "-q", "-m", "dat");
  writeFileSync(join(root, f), Buffer.from("a\u0000c\nconst s = localStorage.getItem('s');\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG), null);
});

for (const staged of [true, false]) {
  test(`R14: pure move of a UTF-16LE+BOM file already holding the pattern (${staged ? "git mv" : "unstaged"}) → no hit`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    const a = "src/users/a.ps1", b = "src/users/b.ps1";
    writeFileSync(join(root, a), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
    sh(root, "add", a); sh(root, "commit", "-q", "-m", "a16");
    if (staged) sh(root, "mv", a, b);
    else { writeFileSync(join(root, b), readFileSync(join(root, a))); rmSync(join(root, a)); }
    assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
    // The same move gaining a violating line still counts.
    writeFileSync(join(root, b), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n$t = localStorage.getItem('t')\r\n"));
    assert.equal(vetoForWrittenFiles(store, root, [b], BIG)?.target, b);
  });
}

const bomless = (s: string) => Buffer.from(s, "utf16le");
for (const [label, wte, staged] of [["raw, git mv", false, true], ["raw, unstaged", false, false], ["working-tree-encoding, unstaged", true, false]] as const) {
  test(`R15: pure move of a BOM-less UTF-16LE file already holding the pattern (${label}) → no hit`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    const a = "src/users/a.ps1", b = "src/users/b.ps1";
    if (wte) { writeFileSync(join(root, ".gitattributes"), "*.ps1 text working-tree-encoding=UTF-16LE\n"); sh(root, "add", ".gitattributes"); }
    writeFileSync(join(root, a), bomless("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
    sh(root, "add", a); sh(root, "commit", "-q", "-m", "a16");
    if (staged) sh(root, "mv", a, b);
    else { writeFileSync(join(root, b), readFileSync(join(root, a))); rmSync(join(root, a)); }
    assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
    writeFileSync(join(root, b), bomless("$x = 1\r\n$s = localStorage.getItem('s')\r\n$t = localStorage.getItem('t')\r\n"));
    assert.equal(vetoForWrittenFiles(store, root, [b], BIG)?.target, b);
  });
}

test("R16: case-only git mv of a UTF-16LE+BOM file holding the pattern → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const a = "src/users/a.ps1", b = "src/users/A.ps1";
  writeFileSync(join(root, a), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
  sh(root, "add", a); sh(root, "commit", "-q", "-m", "a16");
  if (!existsSync(join(root, "src/users/A.PS1"))) { t.skip("case-sensitive filesystem"); return; }
  sh(root, "mv", a, b);
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
  // The same rename gaining a violating line still counts.
  writeFileSync(join(root, b), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n$t = localStorage.getItem('t')\r\n"));
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG)?.target, b);
});

test("R16: 210 deleted in-scope files plus a pure git mv of a UTF-16LE+BOM file holding the pattern → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  // Names sort AFTER the deleted paths, so only blob-id pairing (not the 200-path content window) can pair them.
  const a = "src/users/zz.ps1", b = "src/users/zzz.ps1";
  mkdirSync(join(root, "src", "users", "old"), { recursive: true });
  for (let i = 0; i < 210; i++) writeFileSync(join(root, "src", "users", "old", `f${i}.ts`), `export const f${i} = ${i};\n`);
  writeFileSync(join(root, a), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "many");
  sh(root, "rm", "-r", "-q", "src/users/old");
  sh(root, "mv", a, b);
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
});

test("R17: pure git mv of a working-tree-encoding UTF-16LE file with U+2500 holding the pattern → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const a = "src/users/a.ps1", b = "src/users/b.ps1";
  mkdirSync(join(root, "src", "users"), { recursive: true });
  writeFileSync(join(root, ".gitattributes"), "*.ps1 text working-tree-encoding=UTF-16LE\n");
  writeFileSync(join(root, a), Buffer.from("# \u2500\u2500 header\r\n$s = localStorage.getItem(1)\r\n", "utf16le"));
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "wte");
  sh(root, "mv", a, b);
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
  // The same move gaining a violating line still counts.
  writeFileSync(join(root, b), Buffer.from("# \u2500\u2500 header\r\n$s = localStorage.getItem(1)\r\n$t = localStorage.getItem(2)\r\n", "utf16le"));
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG)?.target, b);
});

test("R17: 210 deleted files plus a pure git mv of a CRLF working copy (core.autocrlf=true) holding the pattern, name sorting last → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  sh(root, "config", "core.autocrlf", "true");
  const a = "src/users/zz.ts", b = "src/users/zzz.ts";
  mkdirSync(join(root, "src", "users", "old"), { recursive: true });
  for (let i = 0; i < 210; i++) writeFileSync(join(root, "src", "users", "old", `f${i}.ts`), `export const f${i} = ${i};
`);
  writeFileSync(join(root, a), "export const x = 1;\r\nconst s = localStorage.getItem('s');\r\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "many");
  sh(root, "rm", "-r", "-q", "src/users/old");
  sh(root, "mv", a, b);
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
});

function subRepo(t: { after: (f: () => void) => void }) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "hunch-shellveto-sub-")));
  sh(top, "init", "-q");
  const root = join(top, "pkg");
  mkdirSync(join(root, "src", "users"), { recursive: true });
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => { store.close(); cleanupDir(top); });
  seedStorageVeto(store);
  return { top, root, store };
}

test("R18: subdirectory root, 210 deleted plus a pure git mv of a CRLF working copy holding the pattern → no hit", t => {
  const { top, root, store } = subRepo(t);
  sh(top, "config", "core.autocrlf", "true");
  mkdirSync(join(root, "src", "users", "old"), { recursive: true });
  for (let i = 0; i < 210; i++) writeFileSync(join(root, "src", "users", "old", `f${i}.ts`), `export const f${i} = ${i};\n`);
  writeFileSync(join(root, "src/users/zz.ts"), "export const x = 1;\r\nconst s = localStorage.getItem('s');\r\n");
  sh(top, "add", "-A"); sh(top, "commit", "-q", "-m", "many");
  sh(top, "rm", "-r", "-q", "pkg/src/users/old");
  sh(top, "mv", "pkg/src/users/zz.ts", "pkg/src/users/zzz.ts");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/zzz.ts"], BIG), null);
});

test("R18: subdirectory root, a same-path twin at the repo top does not excuse a new violating file", t => {
  const { top, root, store } = subRepo(t);
  // <top>/src/users/new.ts equals the deleted pkg/src/users/old.ts; the new pkg file differs.
  mkdirSync(join(top, "src", "users"), { recursive: true });
  writeFileSync(join(top, "src/users/new.ts"), "export const o = 1;\n");
  writeFileSync(join(root, "src/users/old.ts"), "export const o = 1;\n");
  sh(top, "add", "-A"); sh(top, "commit", "-q", "-m", "twin");
  sh(top, "rm", "-q", "pkg/src/users/old.ts");
  mkdirSync(join(root, "src", "users"), { recursive: true });
  writeFileSync(join(root, "src/users/new.ts"), "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/new.ts"], BIG)?.target, "src/users/new.ts");
});

test("R17: 3000 deleted files in a surviving directory do not stall the check", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const dir = join(root, "src", "users", "many");
  mkdirSync(dir, { recursive: true });
  const N = 3000;
  for (let i = 0; i < N; i++) { writeFileSync(join(dir, `d${i}.ts`), `export const d${i} = ${i};
`); writeFileSync(join(dir, `k${i}.ts`), `export const k${i} = ${i};
`); }
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "many");
  // Delete from disk and index in one pass (a pathspec file keeps git fast).
  for (let i = 0; i < N; i++) rmSync(join(dir, `d${i}.ts`));
  sh(root, "add", "-A", "--", "src/users/many");
  writeFileSync(join(root, "src/users/new.ts"), "export const fresh = 1;\n");
  const t0 = Date.now();
  assert.equal(vetoForWrittenFiles(store, root, ["src/users/new.ts"], 1000), null);
  const ms = Date.now() - t0;
  console.log(`R17 3000-deleted check took ${ms} ms`);
  assert.ok(ms < 8000, `took ${ms} ms`);
});

for (const intent of [false, true]) {
  test(`R16: new staged WTE UTF-16LE file with U+2500 and a violating line (git add${intent ? " -N" : ""}) → hit`, t => {
    const { root, store } = repo(t);
    seedStorageVeto(store);
    const f = "src/users/w.ps1";
    writeFileSync(join(root, ".gitattributes"), "*.ps1 text working-tree-encoding=UTF-16LE\n");
    sh(root, "add", ".gitattributes"); sh(root, "commit", "-q", "-m", "wte");
    writeFileSync(join(root, f), bomless("# ── header\r\n$s = localStorage.getItem(1)\r\n"));
    sh(root, "add", ...(intent ? ["-N"] : []), f);
    assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
  });
}

test("R16: tracked UTF-16LE+BOM file gaining a violating line still hits (git reports Binary; decoded reading stands)", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/g16.ps1";
  writeFileSync(join(root, f), u16("$x = 1\r\n"));
  sh(root, "add", f); sh(root, "commit", "-q", "-m", "g16");
  writeFileSync(join(root, f), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("R16: byte-identical unstaged move of a NUL file holding pattern bytes → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const a = "src/users/n.dat", b = "src/users/m.dat";
  writeFileSync(join(root, a), Buffer.from("a\u0000b\nconst s = localStorage.getItem('s');\n"));
  sh(root, "add", a); sh(root, "commit", "-q", "-m", "nul");
  writeFileSync(join(root, b), readFileSync(join(root, a))); rmSync(join(root, a));
  assert.equal(vetoForWrittenFiles(store, root, [b], BIG), null);
});

test("H9: tracked binary (no `diff` attribute) gaining pattern bytes → no hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/b.dat";
  writeFileSync(join(root, f), Buffer.from("a\u0000b\n"));
  sh(root, "add", f); sh(root, "commit", "-q", "-m", "bin");
  writeFileSync(join(root, f), Buffer.from("a\u0000b\nconst s = localStorage.getItem('s');\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG), null);
});

test("UTF-16: untracked new UTF-16LE+BOM file with a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/new16.ps1";
  writeFileSync(join(root, f), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("UTF-16: tracked UTF-8 file rewritten as UTF-16LE+BOM gaining a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/t16.ps1";
  writeFileSync(join(root, f), "$x = 1\n");
  sh(root, "add", f); sh(root, "commit", "-q", "-m", "t16");
  writeFileSync(join(root, f), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("UTF-16: tracked UTF-16LE+BOM on both sides, no gained violation → no hit; a second distinct one → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/b16.ps1";
  writeFileSync(join(root, f), u16("$x = 1\r\n$s = localStorage.getItem('s')\r\n"));
  sh(root, "add", f); sh(root, "commit", "-q", "-m", "b16");
  writeFileSync(join(root, f), u16("$x = 2\r\n$s = localStorage.getItem('s')\r\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG), null);
  writeFileSync(join(root, f), u16("$x = 2\r\n$s = localStorage.getItem('s')\r\n$t = localStorage.getItem('t')\r\n"));
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("NUL: staged new file with a NUL byte and a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/nulbyte.ts";
  writeFileSync(join(root, f), Buffer.from("// a\u0000b\nconst s = localStorage.getItem('s');\n"));
  sh(root, "add", f);
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("600 KB: untracked new file ending in a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/big.ts";
  writeFileSync(join(root, f), "// pad\n".repeat(86000) + "const s = localStorage.getItem('s');\n");
  assert.equal(vetoForWrittenFiles(store, root, [f], BIG)?.target, f);
});

test("m2 R1: an untracked FF FE file of ASCII with one NUL and a violating line → hit", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const f = "src/users/r1.ts";
  writeFileSync(join(root, f), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("// x\u0000y\nconst s = localStorage.getItem('s');\n")]));
  assert.equal(vetoForWrittenFiles(store, root, [f])?.target, f);
});

test("confirm spawns: one tracked violator among 50 rewrites → at most 4 git spawns", t => {
  const { root, store } = repo(t);
  seedStorageVeto(store);
  const files = Array.from({ length: 50 }, (_, i) => `src/users/c${String(i).padStart(2, "0")}.ts`);
  for (const f of files) writeFileSync(join(root, f), "export const c = 1;\n");
  sh(root, "add", "-A"); sh(root, "commit", "-q", "-m", "c");
  for (const f of files) writeFileSync(join(root, f), "export const c = 2;\n");
  writeFileSync(join(root, files[7]!), "export const c = localStorage.getItem('c');\n");
  const trace = join(root, "..", `trace4-${Date.now()}-${process.pid}.log`);
  const prior = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = trace;
    assert.equal(vetoForWrittenFiles(store, root, files, BIG)?.target, files[7]);
    const spawns = readFileSync(trace, "utf8").split("\n").filter((l) => /trace: built-in: git /.test(l)).length;
    assert.ok(spawns >= 2 && spawns <= 4, `at most 4 git spawns, got ${spawns}`);
  } finally {
    if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior;
    cleanupDir(trace);
  }
});
