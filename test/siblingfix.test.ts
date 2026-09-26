import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  attributable, changeLines, codeTokens, isFixSubject, isSubstantive, nameTokens, overlap, parseLineLog,
  renderSiblingLessons, siblingCounters, siblingLessonsFor,
} from "../src/core/siblingfix.js";
import { emptyState, lessonReminder, onLessonsDelivered } from "../src/core/pipeline.js";
import { tsxLoaderUrl } from "./helpers.js";

test("name and body tokens: camelCase split, comments ignored, containment not Jaccard", () => {
  assert.deepEqual([...nameTokens("isHunchProviderHook")], ["is", "hunch", "provider", "hook"]);
  assert.deepEqual([...nameTokens("parse_HTTPHeader")], ["parse", "http", "header"]);
  const body = "// a long explanation about foreign entries\nreturn entry.hooks.every(isOurs);";
  assert.ok(!codeTokens(body).has("foreign"), "comment prose is not shape");
  assert.ok(codeTokens(body).has("every"));
  const small = new Set(["a", "b"]);
  assert.equal(overlap(small, new Set(["a", "b", "c", "d", "e", "f"])), 1, "a grown copy still contains the original");
});

test("fix subjects, substantive changes, and lost line tracking", () => {
  assert.ok(isFixSubject("fix(scaffold): keep foreign hooks"));
  assert.ok(isFixSubject("Fixes a regression in merge"));
  assert.ok(!isFixSubject("feat: add SessionEnd"));
  const base = { sha: "a".repeat(40), subject: "x", span: 4, created: false, diff: [] };
  assert.ok(!isSubstantive({ ...base, added: ["  return a;\r"], removed: ["return a;"] }), "line endings / indentation only");
  assert.ok(isSubstantive({ ...base, added: ["return a && b;"], removed: ["return a;"] }));
  const commits = [
    { ...base, sha: "1".repeat(40), span: 5 },
    { ...base, sha: "2".repeat(40), span: 500 },
    { ...base, sha: "3".repeat(40), span: 5 },
  ];
  const { kept, lostAt } = attributable(commits, 10);
  assert.deepEqual(kept.map((c) => c.sha[0]), ["1"]);
  assert.equal(lostAt, "2".repeat(40), "the whole-file hunk and everything older are not the function's");
});

test("parseLineLog reads commits, hunks and creation from `git log -L` output", () => {
  const out = [
    "\x1eC " + "b".repeat(40) + "\x1ffix: tighten",
    "", "diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -3,2 +3,3 @@", " function f() {", "-  return a;", "+  return a && b;", "+  // why",
    "\x1eC " + "c".repeat(40) + "\x1ffeat: add f",
    "", "diff --git a/x.ts b/x.ts", "--- /dev/null", "+++ b/x.ts", "@@ -0,0 +1,3 @@", "+function f() {", "+  return a;", "+}",
  ].join("\n");
  const [fix, created] = parseLineLog(out);
  assert.equal(fix?.subject, "fix: tighten");
  assert.deepEqual(fix?.removed, ["  return a;"]);
  assert.deepEqual(fix?.diff, ["-  return a;", "+  return a && b;", "+  // why"], "hunk order kept");
  assert.equal(fix?.span, 3);
  assert.equal(fix?.created, false);
  assert.equal(created?.created, true);
});

// ---- a real repo: two copies of one matcher, a fix lands on only one ----
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}
function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}
const matcher = (name: string, extra = "") => `export function ${name}(entry: { hooks?: { command?: string }[] }): boolean {
  return !!entry.hooks?.some((h) => {
    if (typeof h.command !== "string") return false;
    const command = h.command;${extra}
    return /[\\\\/]index\\.(js|ts)"?\\s+hook\\s*$/.test(command);
  });
}
`;
const fixedMatcher = (name: string) => `export function ${name}(entry: { hooks?: { command?: string }[] }): boolean {
  // A mixed entry stays foreign: every nested command must be ours.
  return !!entry.hooks?.length && entry.hooks.every((h) => {
    if (typeof h.command !== "string") return false;
    const command = h.command;
    return /"[^"]*(dist|src)[\\\\/]+cli[\\\\/]+index\\.(js|ts)"\\s+"?hook"?\\s*$/.test(command);
  });
}
`;
function repo(t: { after: (f: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "hunch-sibling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "claude.ts"), `import { x } from "./x.js";\n\n${matcher("isOurClaudeHook")}\nexport const other = 1;\n`);
  writeFileSync(join(root, "src", "providers.ts"), `\n${matcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "feat: hook matchers");
  return root;
}

test("changeLines drops blank lines and caps a long change", () => {
  assert.deepEqual(changeLines(["+", "-  a;  ", "+  b;"]), ["-  a;", "+  b;"]);
  const long = changeLines(Array.from({ length: 20 }, (_, i) => `+ line ${i}`));
  assert.equal(long.length, 13);
  assert.match(long.at(-1)!, /8 more changed line/);
  // A fix commit's change is the lesson: it gets the larger cap.
  assert.equal(changeLines(Array.from({ length: 21 }, (_, i) => `+ line ${i}`), true).length, 21);
});

test("a truncated fix points at the rest, and every listed commit counts", () => {
  const change = changeLines(Array.from({ length: 40 }, (_, i) => `+ line ${i}`), true);
  const lesson = {
    symbol: "isHunchHook", file: "src/a.ts", line: 3, sibling: "isHunchProviderHook", siblingFile: "src/b.ts",
    siblingStart: 10, siblingEnd: 30, similarity: 0.8,
    commits: [
      { sha: "a900d893aaaaaaaa", subject: "fix: anchored launcher", fix: true, change },
      { sha: "83a55d42bbbbbbbb", subject: "fix: prune per command", fix: true, change: ["+ x"] },
    ],
  };
  const text = renderSiblingLessons([lesson]);
  assert.match(text, /8 more changed line\(s\) not shown are part of this change; read them before carrying it: git show a900d893 -- src\/b\.ts/);
  assert.doesNotMatch(text, /```diff[^`]*… 8 more/);
  assert.match(text, /All 2 commits above are part of what this copy lacks/);
  assert.doesNotMatch(renderSiblingLessons([{ ...lesson, commits: [lesson.commits[1]!] }]), /All \d+ commits/);
});

test("a fix to one copy surfaces on the other copy, with the change itself", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  // Roomy budget: the first parse in a process loads the grammars.
  const lessons = siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 });
  assert.equal(lessons.length, 1);
  const [lesson] = lessons;
  assert.equal(lesson?.symbol, "isOurClaudeHook");
  assert.equal(lesson?.sibling, "isOurProviderHook");
  assert.equal(lesson?.siblingFile, "src/providers.ts");
  assert.equal(lesson?.line, 3, "HEAD line of the target function");
  assert.deepEqual(lesson?.commits.map((c) => c.subject), ["fix(providers): a mixed hook entry keeps the user's command"]);
  const text = renderSiblingLessons(lessons);
  assert.match(text, /Fix not carried to this function/);
  assert.match(text, /^\s*\+\s*\/\/ A mixed entry stays foreign/m, "the commit's added lines carry the lesson");
  assert.match(text, /^\s*-\s*return !!entry\.hooks\?\.some/m, "and the behaviour it replaced");
  assert.doesNotMatch(text, /never reached|same flaw is likely/, "heuristic wording, not a verdict");
  assert.match(text, /git log -L \d+,\d+:src\/providers\.ts/);
  assert.match(text, /"Pre-existing" or "outside this task" does not count/, "the scope escape is closed");
  assert.doesNotMatch(text, /blocking invariant/, "no invariant line without an invariant");
  assert.match(renderSiblingLessons(lessons, new Map(), [{ id: "con_x", statement: "never clobber user hooks" }]),
    /covered by blocking invariant con_x \("never clobber user hooks"\): if the gap is real, it violates it/);
  // The fixed copy itself is not told to copy the broken one: the target's
  // history holds no fix the sibling lacks.
  assert.deepEqual(siblingLessonsFor(root, "src/providers.ts", [], { cache: false }), []);
});

test("a fix applied to BOTH copies is shared history, not divergence", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  writeFileSync(join(root, "src", "claude.ts"), `import { x } from "./x.js";\n\n${fixedMatcher("isOurClaudeHook")}\nexport const other = 1;\n`);
  commit(root, "fix: both matchers keep mixed entries");
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false }), []);
});

test("a non-fix divergence alone is not surfaced", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${matcher("isOurProviderHook", "\n    if (!command) return false;")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "feat(providers): early return");
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false }), []);
});

test("a caller is not a copy of its callee", t => {
  const root = repo(t);
  const wrapper = `export function isOurClaudeHook(entry: { hooks?: { command?: string }[] }): boolean {\n  const hooks = entry.hooks ?? [];\n  if (!hooks.length) return false;\n  return isOurProviderHook({ hooks: hooks.filter((h) => typeof h.command === "string") });\n}\n`;
  writeFileSync(join(root, "src", "claude.ts"), `import { isOurProviderHook } from "./providers.js";\n\n${wrapper}`);
  commit(root, "refactor: delegate");
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): mixed entries");
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false }), []);
});

test("history survives a whole-file line-ending rewrite by re-anchoring on the function name", t => {
  const root = repo(t);
  // Big enough that a whole-file hunk dwarfs the function: git's range mapping
  // is then genuinely lost at the rewrite.
  const padding = Array.from({ length: 80 }, (_, i) => `export const p${i} = ${i};`).join("\n") + "\n";
  for (const f of ["claude.ts", "providers.ts"]) {
    const p = join(root, "src", f);
    writeFileSync(p, readFileSync(p, "utf8") + padding);
  }
  commit(root, "chore: constants");
  const providers = join(root, "src", "providers.ts");
  writeFileSync(providers, readFileSync(providers, "utf8").replace(matcher("isOurProviderHook"), fixedMatcher("isOurProviderHook")));
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  for (const f of ["claude.ts", "providers.ts"]) {
    const p = join(root, "src", f);
    writeFileSync(p, readFileSync(p, "utf8").replace(/\n/g, "\r\n"));
  }
  commit(root, "chore: CRLF everywhere");
  for (const f of ["claude.ts", "providers.ts"]) {
    const p = join(root, "src", f);
    writeFileSync(p, `// header\n${readFileSync(p, "utf8").replace(/\r\n/g, "\n")}`);
  }
  commit(root, "chore: LF again, with a header");
  const lessons = siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 });
  assert.deepEqual(lessons.flatMap((l) => l.commits.map((c) => c.subject)), ["fix(providers): a mixed hook entry keeps the user's command"],
    "the rewrites are skipped, the fix behind them is still found");
});

test("a fix that reached the target inside a whole-file rewrite is shared history, not divergence", t => {
  const root = repo(t);
  // Padding makes the target's rewrite hunk dwarf the function, so git loses
  // its line range at exactly the commit that carried the fix to both copies.
  const padding = Array.from({ length: 80 }, (_, i) => `export const p${i} = ${i};`).join("\n");
  writeFileSync(join(root, "src", "claude.ts"), `${padding}\n${matcher("isOurClaudeHook")}\n`);
  commit(root, "chore: constants");
  writeFileSync(join(root, "src", "providers.ts"), `\n${matcher("isOurProviderHook", "\n    if (!command) return false;")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  writeFileSync(join(root, "src", "claude.ts"), `${padding}\n${matcher("isOurClaudeHook", "\n    if (!command) return false;")}\n`.replace(/\n/g, "\r\n"));
  commit(root, "fix: empty command is not ours (both copies)");
  // A roomy budget: an exhausted one also answers [], which would prove nothing.
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("a truncated inventory keeps what it parsed and the next call carries on", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-sibling-inv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  for (const d of ["a", "z"]) {
    const D = d.toUpperCase();
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, "x.ts"), `\n${matcher(`isOur${D}ClaudeHook`)}\n`);
    writeFileSync(join(root, d, "y.ts"), `\n${matcher(`isOur${D}ProviderHook`)}\n`);
  }
  commit(root, "feat: matchers");
  for (const d of ["a", "z"]) writeFileSync(join(root, d, "y.ts"), `\n${fixedMatcher(`isOur${d.toUpperCase()}ProviderHook`)}\n`);
  commit(root, "fix: mixed entries stay foreign");
  // A zero scan budget parses nothing: no candidates, no lesson.
  assert.deepEqual(siblingLessonsFor(root, "a/x.ts", [], { inventoryBudgetMs: 0 }), []);
  const inventoryFile = join(root, ".hunch-cache", "siblingfix", "inventory.json");
  assert.deepEqual(JSON.parse(readFileSync(inventoryFile, "utf8")), { version: 1, files: {} });
  // The next call parses what is missing and finds z's sibling.
  const lessons = siblingLessonsFor(root, "z/x.ts", [], { budgetMs: 60_000 });
  assert.deepEqual(lessons.map((l) => `${l.symbol}~${l.sibling}`), ["isOurZClaudeHook~isOurZProviderHook"]);
  const rebuilt = JSON.parse(readFileSync(inventoryFile, "utf8")) as { files: Record<string, { blob: string }> };
  assert.deepEqual(Object.keys(rebuilt.files).sort(), ["a/x.ts", "a/y.ts", "z/y.ts"]);
  // The "no candidates" answer cached for a/x.ts no longer matches its
  // candidate set: it is recomputed, not served.
  assert.equal(siblingLessonsFor(root, "a/x.ts", [], { budgetMs: 60_000 }).length, 1);
});

test("the cache is keyed by content: an unrelated commit keeps the answer, a sibling change recomputes it", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 }).length, 1);
  const cacheDir = join(root, ".hunch-cache", "siblingfix");
  const [entry] = readdirSync(cacheDir).filter((f) => f !== "inventory.json");
  const mark = () => {
    const cached = JSON.parse(readFileSync(join(cacheDir, entry!), "utf8")) as { lessons: { similarity: number }[] };
    cached.lessons[0]!.similarity = 0.01;
    writeFileSync(join(cacheDir, entry!), JSON.stringify(cached));
  };
  mark();
  writeFileSync(join(root, "README.md"), "unrelated\n");
  commit(root, "docs: readme");
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 })[0]?.similarity, 0.01, "served from the cache across HEADs");
  writeFileSync(join(root, "src", "providers.ts"), readFileSync(join(root, "src", "providers.ts"), "utf8").replace("const a = 1;", "const a = 2;"));
  commit(root, "chore: touch the sibling's file");
  assert.notEqual(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 })[0]?.similarity, 0.01, "a candidate's new content recomputes");
});

test("a cache hit validates by digest and never re-runs the candidate scan", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  const before = siblingCounters.candidateScans;
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 }).length, 1);
  assert.equal(siblingCounters.candidateScans, before + 1, "a miss scans once");
  writeFileSync(join(root, "README.md"), "unrelated\n");
  commit(root, "docs: readme");
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 }).length, 1);
  assert.equal(siblingCounters.candidateScans, before + 1, "a hit across an unrelated commit does not scan");
  // A new function whose name overlaps the target's OWN names becomes a real
  // candidate in a new file: the digest moves, the one-shot fallback scan
  // finds a genuinely different candidate set (extra.ts is now included), so
  // it falls through to a full recompute — two scans total for this call.
  writeFileSync(join(root, "src", "extra.ts"), "export function isOurExtraHook(): boolean {\n  const a = 1;\n  return a > 0;\n}\n");
  commit(root, "feat: another hook");
  siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 });
  assert.equal(siblingCounters.candidateScans, before + 3, "digest miss: one fallback scan plus one full-miss scan");
});

test("an unrelated new function is served from cache with no lesson recompute; a test-file function keeps the digest unchanged", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 }).length, 1);
  const scansAfterFirst = siblingCounters.candidateScans;
  const computesAfterFirst = siblingCounters.lessonComputes;
  // A brand-new function with zero token overlap with the target's own names
  // (`isOurClaudeHook`) can never itself become a candidate, but it is still
  // matchable so the digest moves: the one-shot fallback retry confirms the
  // candidate set is unchanged and serves the cached lessons without a recompute.
  writeFileSync(join(root, "src", "zzz.ts"), "export function totallyDifferentThing(): number {\n  return 42;\n}\n");
  commit(root, "feat: unrelated helper");
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 }).length, 1);
  // The digest moved (a matchable function was added), so the fallback runs
  // ONE retry scan; its candidate content matches the cached one, so the
  // cached lessons are still served and no lesson recompute happens.
  assert.equal(siblingCounters.candidateScans, scansAfterFirst + 1, "one fallback scan on the digest miss");
  assert.equal(siblingCounters.lessonComputes, computesAfterFirst, "no recompute of lessons: the fallback served the cached answer");
  siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 });
  assert.equal(siblingCounters.candidateScans, scansAfterFirst + 1, "the digest was healed: the next call is a pure digest hit");
  // A function added inside a test path is excluded from the digest outright
  // (candidatesFor already ignores TEST_PATH), so it never even takes the
  // fallback path: the digest itself does not move.
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "extra.test.ts"), "export function isOurTestHook(): boolean {\n  return true;\n}\n");
  commit(root, "test: add a fixture");
  siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 });
  assert.equal(siblingCounters.candidateScans, scansAfterFirst + 1, "a test-file function does not move the digest: still a pure digest hit");
});

test("a spent budget during the candidate scan yields no lessons and caches no partial answer", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  const realNow = Date.now;
  let jumped = false;
  // The clock passes every deadline the moment the scan reaches the indexed symbols.
  const trip = { file: "lib/trip.ts", name: "isOurTripHook", get kind() { jumped = true; return "function"; } };
  const many = Array.from({ length: 2_000 }, (_, i) => ({ file: `lib/f${i}.ts`, name: `isOurHook${i}`, kind: "function" }));
  Date.now = () => realNow() + (jumped ? 3_600_000 : 0);
  let lessons;
  try {
    lessons = siblingLessonsFor(root, "src/claude.ts", [trip, ...many], { budgetMs: 60_000 });
  } finally { Date.now = realNow; }
  assert.ok(jumped, "the scan ran");
  assert.deepEqual(lessons, []);
  const cacheDir = join(root, ".hunch-cache", "siblingfix");
  const [entry] = readdirSync(cacheDir).filter((f) => f !== "inventory.json");
  const cached = JSON.parse(readFileSync(join(cacheDir, entry!), "utf8")) as { complete: boolean; lessons: unknown[]; candidates: object };
  assert.equal(cached.complete, false);
  assert.deepEqual(cached.lessons, []);
  assert.deepEqual(cached.candidates, {}, "no partial candidate set kept");
});

test("a reverted fix is not a lesson; an unrelated later commit keeps it", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  const kept = repo(t);
  writeFileSync(join(kept, "src", "providers.ts"), readFileSync(join(root, "src", "providers.ts"), "utf8"));
  commit(kept, "fix(providers): a mixed hook entry keeps the user's command");
  git(root, "revert", "--no-edit", "HEAD");
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }), []);
  writeFileSync(join(kept, "README.md"), "unrelated\n");
  commit(kept, "docs: readme");
  assert.equal(siblingLessonsFor(kept, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }).length, 1);
});

function commitWithMessage(root: string, message: string): void {
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", message], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

test("a revert naming two shas cancels both", t => {
  const root = repo(t);
  // Two separate fix-shaped commits to the sibling, oldest first.
  writeFileSync(join(root, "src", "providers.ts"), `\n${matcher("isOurProviderHook", "\n    if (!command) return false;")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): first mixed-entry fix");
  const firstSha = git(root, "rev-parse", "HEAD").trim();
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): second mixed-entry fix");
  const secondSha = git(root, "rev-parse", "HEAD").trim();
  // One revert commit whose message names BOTH prior shas: it must cancel
  // both, not only the nearer one. Restore the pre-fix body so the revert is
  // a real (substantive) change too.
  writeFileSync(join(root, "src", "providers.ts"), `\n${matcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commitWithMessage(root, `revert: undo both fixes\n\nThis reverts commit ${firstSha}.\nThis reverts commit ${secondSha}.`);
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("a revert whose target lies outside the log window is not itself surfaced as a fix", t => {
  const root = repo(t);
  // A revert commit that names a sha not present in this line's log (the fix
  // was never applied to THIS function's history) must still never surface
  // as a fix lesson on its own subject.
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  const bogusSha = "f".repeat(40);
  commitWithMessage(root, `fix(providers): a mixed hook entry keeps the user's command\n\nThis reverts commit ${bogusSha}.`);
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("reverts toggle: a revert of the revert re-lands the fix; reverting that cancels it again", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  const lessons = () => siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 });
  assert.equal(lessons().length, 1, "the fix");
  git(root, "revert", "--no-edit", "HEAD");
  assert.deepEqual(lessons(), [], "reverted");
  git(root, "revert", "--no-edit", "HEAD");
  const relanded = lessons();
  assert.equal(relanded.length, 1, "the revert of the revert makes the fix live again");
  assert.ok(relanded[0]!.commits.every((c) => !/^(Revert|Reapply)\b/.test(c.subject)), "the lesson is the original fix, never a revert commit");
  git(root, "revert", "--no-edit", "HEAD");
  assert.deepEqual(lessons(), [], "reverting the reapply cancels it again");
});

test("a mixed revert (drops one fix, re-lands another) is undone per fix when it is reverted", t => {
  const root = repo(t);
  const body = (m: string) => `\n${m}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`;
  const sha = () => git(root, "rev-parse", "HEAD").trim();
  const lessons = () => siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }).flatMap((l) => l.commits.map((c) => c.sha));
  writeFileSync(join(root, "src", "providers.ts"), body(matcher("isOurProviderHook", "\n    if (!command) return false;")));
  commit(root, "fix(providers): first mixed-entry fix");
  const a = sha();
  writeFileSync(join(root, "src", "providers.ts"), body(matcher("isOurProviderHook")));
  commitWithMessage(root, `Revert "fix(providers): first mixed-entry fix"\n\nThis reverts commit ${a}.`);
  const b = sha();
  writeFileSync(join(root, "src", "providers.ts"), body(fixedMatcher("isOurProviderHook")));
  commit(root, "fix(providers): second mixed-entry fix");
  const x = sha();
  // One commit that reverts X AND the revert B: X is dropped, A re-lands.
  writeFileSync(join(root, "src", "providers.ts"), body(matcher("isOurProviderHook", "\n    if (!command) return false;")));
  commitWithMessage(root, `revert: swap the fixes back\n\nThis reverts commit ${x}.\nThis reverts commit ${b}.`);
  const e = sha();
  const afterE = lessons();
  assert.ok(!afterE.includes(x), "X was reverted");
  assert.ok(afterE.includes(a), "A re-landed (so the check below is not vacuous)");
  // Reverting E restores X and cancels A again: A must not come back.
  writeFileSync(join(root, "src", "providers.ts"), body(fixedMatcher("isOurProviderHook")));
  commitWithMessage(root, `Revert "revert: swap the fixes back"\n\nThis reverts commit ${e}.`);
  const f = sha();
  const after = lessons();
  assert.ok(after.includes(x), "X re-lands");
  assert.ok(!after.includes(a), "A stays cancelled");
  assert.ok(!after.includes(f), "the final revert is not a lesson");
  assert.ok(!after.includes(e) && !after.includes(b), "no revert commit is a lesson");
});

test("a revert whose body lost the `This reverts commit` line is still never a lesson", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commitWithMessage(root, `Revert "fix(providers): a mixed hook entry keeps the user's command"`);
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("cache: false neither reads nor writes the inventory", t => {
  const root = repo(t);
  siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 });
  assert.equal(existsSync(join(root, ".hunch-cache", "siblingfix", "inventory.json")), false);
  assert.equal(existsSync(join(root, ".hunch-cache")), false);
});

test("the cache directory is pruned to a bound on write, keeping the inventory", t => {
  const root = repo(t);
  const cacheDir = join(root, ".hunch-cache", "siblingfix");
  mkdirSync(cacheDir, { recursive: true });
  const old = new Date(Date.now() - 86_400_000);
  for (let i = 0; i < 300; i++) {
    writeFileSync(join(cacheDir, `stale-${i}.json`), "{}");
    utimesSync(join(cacheDir, `stale-${i}.json`), old, old);
  }
  siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 });
  const left = readdirSync(cacheDir);
  assert.ok(left.length <= 257, `bounded, got ${left.length}`);
  assert.ok(left.includes("inventory.json"));
  assert.equal(left.filter((f) => !f.startsWith("stale-") && f !== "inventory.json").length, 1, "the fresh answer survives");
});

test("a tiny consumer is not a copy of the large producer whose words it uses", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-sibling-size-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  mkdirSync(join(root, "src"));
  // The renderer prints the plan's buckets; the planner builds them. Every
  // word of the renderer occurs in the planner (containment 1.0).
  writeFileSync(join(root, "src", "cli.ts"), `export function printReviewPlan(plan: { accept: string[]; reject: string[] }): void {
  console.log(\`accept \${plan.accept.length} duplicate\`);
  console.log(\`reject \${plan.reject.length} irrelevant\`);
}
`);
  const planner = (guard: string) => `export function planReview(drafts: { id: string; score: number; duplicate: boolean; irrelevant: boolean }[]): { accept: string[]; reject: string[] } {
  const accept: string[] = [];
  const reject: string[] = [];
  const ranked = drafts.slice().sort((left, right) => right.score - left.score);
  for (const draft of ranked) {${guard}
    if (draft.duplicate || draft.irrelevant) { reject.push(draft.id); continue; }
    const threshold = Math.round(draft.score * 100);
    if (threshold >= 70) accept.push(draft.id); else reject.push(draft.id);
  }
  console.log(\`planned \${accept.length} of \${drafts.length}\`);
  return { accept, reject };
}
`;
  writeFileSync(join(root, "src", "planner.ts"), planner(""));
  commit(root, "feat: review plan");
  writeFileSync(join(root, "src", "planner.ts"), planner("\n    if (!draft.id) { reject.push(\"anonymous\"); continue; }"));
  commit(root, "fix(review): anchor dedup to accepted records");
  assert.deepEqual(siblingLessonsFor(root, "src/cli.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("a pair exactly twice apart in size is not a copy", t => {
  const root = mkdtempSync(join(tmpdir(), "hunch-sibling-2x-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), ".hunch-cache/\n");
  mkdirSync(join(root, "src"));
  // Shape of writeVscodeMcp (21 tokens) ~ writeMcpJson (42): every word of the
  // small one is in the large one, at exactly half its size.
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
  const extra = ["hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar"];
  const small = `export function writeHookConfig(): number {\n  return ${words.join(" + ")};\n}\n`;
  const large = (guard: string) => `export function writeHookConfigFile(): number {${guard}\n  return ${[...words, ...extra].join(" + ")};\n}\n`;
  writeFileSync(join(root, "src", "a.ts"), small);
  writeFileSync(join(root, "src", "b.ts"), large(""));
  commit(root, "feat: writers");
  writeFileSync(join(root, "src", "b.ts"), large("\n  if (!zulu) return 0;"));
  commit(root, "fix(b): refuse an unparseable file");
  assert.equal(codeTokens(small).size * 2, codeTokens(large("\n  if (!zulu) return 0;")).size, "exactly 2x");
  assert.deepEqual(siblingLessonsFor(root, "src/a.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("a history rewrite invalidates the cache: amend-reworded fixes surface, cited SHAs exist", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "chore(providers): tidy the matcher");
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 }), [], "not a fix: no lesson, cached");
  git(root, "commit", "-q", "--amend", "-m", "fix(providers): a mixed hook entry keeps the user's command");
  const lessons = siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 });
  assert.equal(lessons.length, 1, "same blobs, rewritten history: recomputed");
  git(root, "commit", "-q", "--amend", "-m", "fix(providers): mixed entries stay foreign");
  const again = siblingLessonsFor(root, "src/claude.ts", [], { budgetMs: 60_000 });
  const history = new Set(git(root, "log", "--format=%H").split("\n"));
  assert.equal(again.length, 1);
  for (const c of again.flatMap((l) => l.commits)) assert.ok(history.has(c.sha), `cited ${c.sha} is in history`);
  assert.equal(again[0]?.commits[0]?.subject, "fix(providers): mixed entries stay foreign");
});

test("a fix commit that also modified the target file is not divergence", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  // The same commit edits the target file, outside the target function.
  writeFileSync(join(root, "src", "claude.ts"), readFileSync(join(root, "src", "claude.ts"), "utf8").replace("other = 1", "other = 2"));
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 }), []);
});

test("an incomplete computation is no answer for a while, then retried a bounded number of times", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  // Remove the sibling's older blob: its history walk now fails, as a timed-out
  // or broken git call would.
  const blob = git(root, "rev-parse", "HEAD~1:src/providers.ts").trim();
  const object = join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  const bytes = readFileSync(object);
  rmSync(object, { force: true });
  const t0 = 1_000_000_000;
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { now: t0 }), []);
  const cacheDir = join(root, ".hunch-cache", "siblingfix");
  const entries = readdirSync(cacheDir).filter((f) => f !== "inventory.json");
  assert.equal(entries.length, 1);
  const { complete, lessons: cachedLessons, attempts, at } = JSON.parse(readFileSync(join(cacheDir, entries[0]!), "utf8")) as Record<string, unknown>;
  assert.deepEqual({ complete, lessons: cachedLessons, attempts, at }, { complete: false, lessons: [], attempts: 1, at: t0 });
  // History restored: inside the retry window the cached "no answer" still
  // wins, and answers fast.
  writeFileSync(object, bytes);
  const started = Date.now();
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { now: t0 + 1_000 }), []);
  assert.ok(Date.now() - started < 1_000, "served from the cache");
  // After the window a momentary failure no longer silences the lesson.
  assert.equal(siblingLessonsFor(root, "src/claude.ts", [], { now: t0 + 120_000, budgetMs: 60_000 }).length, 1);
  // A history that keeps failing stops being retried after three attempts.
  const failing = JSON.parse(readFileSync(join(cacheDir, entries[0]!), "utf8")) as Record<string, unknown>;
  writeFileSync(join(cacheDir, entries[0]!), JSON.stringify({ ...failing, complete: false, lessons: [], attempts: 3, at: t0 }));
  assert.deepEqual(siblingLessonsFor(root, "src/claude.ts", [], { now: t0 + 10_000_000, budgetMs: 60_000 }), []);
});

test("a tiny wall-clock budget returns promptly without throwing", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  const started = Date.now();
  const lessons = siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 50 });
  assert.ok(Date.now() - started < 2_000);
  assert.ok(Array.isArray(lessons));
});

test("the real pre-edit hook injects the lesson even when the graph holds no record for the file", { timeout: 120_000 }, t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const hook = (session: string) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "hook"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0" }, encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src", "claude.ts"), old_string: "other = 1", new_string: "other = 2" } }),
  }).trim();
  const first = JSON.parse(hook("sib-session")) as { hookSpecificOutput?: { additionalContext?: string } };
  const context = first.hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /Fix not carried to this function/);
  assert.match(context, /isOurClaudeHook/);
  assert.match(context, /A mixed entry stays foreign/);
  assert.equal(context.match(/^## .*/m)?.[0], "## ⚠ Fix not carried to this function", "the lesson leads the grounding");
  const again = JSON.parse(hook("sib-session")) as { hookSpecificOutput?: { additionalContext?: string } };
  assert.match(again.hookSpecificOutput?.additionalContext ?? "", /unchanged this session .*sibling-fix lesson/, "a repeat edit gets the one-line delta");
});

test("a file edited through a shell command gets the same grounding after the command", { timeout: 120_000 }, t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  for (const pipeline of ["0", "1"]) {
    const session = `sib-shell-${pipeline}-${process.pid}-${Date.now()}`;
    const hook = (event: object) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "hook"], {
      cwd: root, env: { ...process.env, HUNCH_PIPELINE: pipeline }, encoding: "utf8",
      input: JSON.stringify({ session_id: session, cwd: root, ...event }),
    }).trim();
    const bash = (command: string) => hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } });
    hook({ hook_event_name: "UserPromptSubmit", prompt: "extend the claude matcher" });
    assert.equal(bash("cat src/claude.ts"), "", "a command that wrote nothing gets nothing");
    // The edit arrives through the shell, never through Edit/Write.
    writeFileSync(join(root, "src", "claude.ts"), readFileSync(join(root, "src", "claude.ts"), "utf8").replace("other = 1", `other = ${pipeline}2`)
      + `export function installHooks(entries: { hooks?: { command?: string }[] }[]): number {\n  const ours = entries.filter((e) => isOurClaudeHook(e));\n  return ours.length;\n}\n`);
    const out = JSON.parse(bash("python3 edit.py")) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    assert.equal(out.hookSpecificOutput?.hookEventName, "PostToolUse");
    const context = out.hookSpecificOutput?.additionalContext ?? "";
    assert.match(context, /this shell command wrote src\/claude\.ts/);
    assert.match(context, /same-shaped function elsewhere received and this file's copy never did/, "the header names the lesson");
    assert.equal(context.match(/^## .*/m)?.[0], "## ⚠ Fix not carried to this function", "the lesson leads the grounding");
    assert.match(context, /A mixed entry stays foreign/);
    assert.match(context, /`installHooks` calls `isOurClaudeHook`/, "the lesson names the code here that runs through the unfixed copy");
    assert.match(context, /then say which, in your final answer/);
    const check = () => (JSON.parse(bash("npx tsx --test test/claude.test.ts") || "{}") as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
    if (pipeline === "0") {
      assert.doesNotMatch(check(), /before you finish/, "no pipeline state, no follow-up");
      continue;
    }
    const followUp = check();
    assert.match(followUp, /Hunch — before you finish/, "the first check after an ignored lesson gets one follow-up");
    assert.match(followUp, /`isOurClaudeHook` \(src\/claude\.ts\) is unchanged/);
    assert.match(followUp, /`installHooks` calls it/);
    assert.doesNotMatch(check(), /before you finish/, "once per lesson");
  }
});

test("the follow-up stays silent once the agent changed the function", { timeout: 120_000 }, t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  mkdirSync(join(root, ".hunch"));
  writeFileSync(join(root, ".hunch", "config.json"), JSON.stringify({ firmness: "advisory" }));
  const hook = (event: object) => execFileSync(process.execPath, ["--import", tsxLoaderUrl(), resolve("src/cli/index.ts"), "hook"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "1" }, encoding: "utf8",
    input: JSON.stringify({ session_id: `sib-carried-${process.pid}-${Date.now()}`, cwd: root, ...event }),
  }).trim();
  hook({ hook_event_name: "UserPromptSubmit", prompt: "extend the claude matcher" });
  const pre = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src", "claude.ts"), old_string: "some(", new_string: "every(" } });
  assert.match(pre, /Fix not carried to this function/);
  // The agent carries the fix into the function itself.
  writeFileSync(join(root, "src", "claude.ts"), readFileSync(join(root, "src", "claude.ts"), "utf8").replace("entry.hooks?.some(", "entry.hooks?.every("));
  hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(root, "src", "claude.ts") }, tool_response: {} });
  const out = hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "" } });
  assert.doesNotMatch(out, /before you finish/);
});

test("lessonReminder: only on a check, once, and only while the function is untouched", () => {
  const lesson = { id: "a", file: "src/a.ts", symbol: "isA", sibling: "isB", siblingFile: "src/b.ts", change: "abc12345 fix: b", callers: ["run"], hash: "h1" };
  const state = onLessonsDelivered(emptyState(), [lesson]);
  assert.equal(onLessonsDelivered(state, [{ ...lesson, hash: "h2" }]).lessons[0]?.hash, "h1", "first delivery keeps its baseline");
  assert.equal(lessonReminder(state, "cat src/a.ts", () => "h1").reminder, "", "not a check");
  assert.equal(lessonReminder(state, "npx tsc --noEmit", () => null).reminder, "", "cannot tell, stays silent");
  const changed = lessonReminder(state, "npm test", () => "h2");
  assert.equal(changed.reminder, "", "the agent touched the function");
  assert.equal(changed.state.lessons[0]?.reminded, true);
  const fired = lessonReminder(state, "pytest -q", () => "h1");
  assert.match(fired.reminder, /`isA` \(src\/a\.ts\) is unchanged .* abc12345 fix: b\. `run` calls it/);
  assert.equal(lessonReminder(fired.state, "pytest -q", () => "h1").reminder, "", "once per lesson");
});

test("the fix commit's tests are named in the lesson", t => {
  const root = repo(t);
  writeFileSync(join(root, "src", "providers.ts"), `\n${fixedMatcher("isOurProviderHook")}\nexport function unrelated(): number {\n  const a = 1;\n  return a + 1;\n}\n`);
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "providers.test.ts"), "// mixed entry stays foreign\n");
  commit(root, "fix(providers): a mixed hook entry keeps the user's command");
  const lessons = siblingLessonsFor(root, "src/claude.ts", [], { cache: false, budgetMs: 60_000 });
  assert.deepEqual(lessons[0]?.commits[0]?.tests, ["test/providers.test.ts"]);
  assert.match(renderSiblingLessons(lessons), /The fix came with tests in test\/providers\.test\.ts/);
});

