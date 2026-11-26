import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, isolatedCliEnv, personHomeSeam, personTokenEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { hashToken, initPersonToken, requirePerson, personTokenFile, takePersonToken, resetHeldPersonToken } from "../src/core/personGate.js";
import { readProposalQueue, writeProposalQueue } from "../src/core/docRuleProposals.js";
import type { Constraint } from "../src/core/types.js";

/** Person-only rule actions are enforced inside the CLI: a terminal confirmation or a registered person token. */

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; out: string; stdout: string; stderr: string }

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function hunch(f: Fixture, extra: NodeJS.ProcessEnv, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: { ...f.env, ...extra }, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function con(id: string, extra: Record<string, unknown> = {}): Constraint {
  return {
    id, type: "architecture", statement: `rule ${id}`, scope: ["src/**"], severity: "warning", enforcement: "advisory_v1",
    match: null, forbids: null, rationale: "because", source_decision: null, violations: [], status: "active",
    valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
    provenance: { source: "agent_recorded", confidence: 0.8, evidence: [] }, ...extra,
  } as Constraint;
}
/** Every .hunch/constraints file's bytes, so "no store change" is a real comparison. */
function snapshot(f: Fixture): string {
  const dir = join(f.root, ".hunch");
  const files = git(dir, f.env, "ls-files", "-o", "-c", "--exclude-standard", "--", "constraints").split("\n").filter(Boolean).sort();
  return JSON.stringify(files.map((n) => [n, readFileSync(join(dir, n), "utf8")]));
}
function rulesOf(f: Fixture): Array<Record<string, any>> {
  const r = hunch(f, {}, "rules", "--json");
  assert.equal(r.status, 0, r.out);
  return JSON.parse(r.stdout);
}

function makeRepo(): Fixture {
  const sandbox = tempDir("hunch-person-gate-");
  const root = join(sandbox, "repo");
  const home = join(sandbox, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = isolatedCliEnv({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1", ...personHomeSeam(join(sandbox, "person-home")), HUNCH_PERSON_TOKEN: "", HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDER: "none", NO_COLOR: "1", CI: "1" });
  const f: Fixture = { sandbox, root, env };
  git(root, env, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "l@example.com"], ["user.name", "L"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(root, env, "config", k!, v!);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "person-gate", private: true, type: "module" })}\n`);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "fixture");
  const init = hunch(f, {}, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
  assert.equal(init.status, 0, init.out);
  git(root, env, "add", "-A");
  git(root, env, "commit", "-qm", "chore: hunch init");
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.ensureDirs();
    for (const c of [con("con_act"), con("con_dra", { status: "draft" }), con("con_new"),
      con("con_chal", { challenge: { reason: "odd", at: "2026-02-01T00:00:00.000Z", by_session: null, by_run: null } })]) store.json.put("constraints", c);
    store.reindex();
  } finally { store.close(); }
  return f;
}

const GATED: Array<[string, string[]]> = [
  ["review --confirm", ["review", "--confirm", "con_dra"]],
  ["review --unconfirm", ["review", "--unconfirm", "con_act"]],
  ["challenge clear", ["challenge", "clear", "con_chal", "--reason", "fine"]],
  ["replace", ["replace", "con_act", "--with", "con_new", "--reason", "newer"]],
  ["retire-constraint", ["retire-constraint", "con_act"]],
  ["remove con_", ["remove", "con_act", "--reason", "x"]],
  ["restore con_", ["restore", "con_act"]],
  ["edit con_", ["edit", "con_act", "--rationale", "new"]],
  ["link con_", ["link", "con_act", "--add-file", "src/x.ts"]],
];

test("every gated command exits 4 without a person and changes nothing; a registered token lets it through", () => {
  const f = makeRepo();
  try {
    for (const [name, args] of GATED) {
      const before = snapshot(f);
      const r = hunch(f, {}, ...args);
      assert.equal(r.status, 4, `${name} must exit 4:\n${r.out}`);
      assert.match(r.stderr, /Only a person can/, name);
      assert.equal(snapshot(f), before, `${name} must not change the store`);
    }
    const person = personTokenEnv(join(f.sandbox, "person-home"), "tok-abc");
    const done = hunch(f, person, "review", "--confirm", "con_dra");
    assert.equal(done.status, 0, done.out);
    assert.equal(rulesOf(f).find((r) => r.id === "con_dra")!.status, "active");
    const cleared = hunch(f, person, "challenge", "clear", "con_chal", "--reason", "fine");
    assert.equal(cleared.status, 0, cleared.out);
    const edited = hunch(f, person, "edit", "con_new", "--rationale", "r2");
    assert.equal(edited.status, 0, edited.out);
  } finally { cleanupDir(f.sandbox); }
});

test("review --accept, --reject, --accept-verified and derive-rules --accept exit 4 without a person and change nothing", () => {
  const f = makeRepo();
  try {
    writeProposalQueue(join(f.root, ".hunch"), { pending: [{ id: "con_prop", file: "CONTRIBUTING.md", statement: "s", quote: "q", scope: ["src/**"], severity: "warning", type: "correctness", provider: "p", proposedAt: "2026-01-01T00:00:00.000Z", hash: "sha256:x" }], dropped: [] });
    const cases: Array<[string, string[]]> = [
      ["review --accept", ["review", "--accept", "dec_none"]],
      ["review --reject", ["review", "--reject", "dec_none"]],
      ["review --accept-verified", ["review", "--accept-verified"]],
      ["derive-rules --accept", ["derive-rules", "--accept", "con_prop", "--expect", "sha256:x"]],
    ];
    for (const [name, args] of cases) {
      const before = snapshot(f);
      const r = hunch(f, {}, ...args);
      assert.equal(r.status, 4, `${name} must exit 4:
${r.out}`);
      assert.match(r.stderr, /Only a person can/, name);
      assert.equal(snapshot(f), before, `${name} must not change the store`);
    }
    assert.equal(readProposalQueue(join(f.root, ".hunch")).pending.length, 1, "the queued proposal stays queued");
  } finally { cleanupDir(f.sandbox); }
});

test("a wrong token exits 4 and there is no terminal fallback", () => {
  const f = makeRepo();
  try {
    const person = personTokenEnv(join(f.sandbox, "person-home"), "right-token");
    const before = snapshot(f);
    const r = hunch(f, { ...person, HUNCH_PERSON_TOKEN: "wrong-token" }, "review", "--confirm", "con_dra");
    assert.equal(r.status, 4, r.out);
    assert.doesNotMatch(r.out, /wrong-token|right-token/);
    assert.equal(snapshot(f), before);
    const missing = hunch(f, { ...personHomeSeam(join(f.sandbox, "nowhere")), HUNCH_PERSON_TOKEN: "x" }, "retire-constraint", "con_act");
    assert.equal(missing.status, 4, missing.out);
  } finally { cleanupDir(f.sandbox); }
});

test("a symlinked token hash file is refused", (t) => {
  const f = makeRepo();
  try {
    const real = join(f.sandbox, "real-home");
    personTokenEnv(real, "tok");
    const linkHome = join(f.sandbox, "link-home");
    mkdirSync(join(linkHome, ".hunch"), { recursive: true });
    try { symlinkSync(personTokenFile(real), personTokenFile(linkHome)); } catch { t.skip("cannot create symlinks here"); return; }
    const r = hunch(f, { ...personHomeSeam(linkHome), HUNCH_PERSON_TOKEN: "tok" }, "retire-constraint", "con_act");
    assert.equal(r.status, 4, r.out);
    assert.match(r.stderr, /symlink/);
  } finally { cleanupDir(f.sandbox); }
});

test("record-constraint: new without a person is an agent_recorded draft; with a person it is active", () => {
  const f = makeRepo();
  try {
    const made = hunch(f, {}, "record-constraint", "never import lodash anywhere", "--scope", "src/**");
    assert.equal(made.status, 0, made.out);
    assert.match(made.stdout, /review --confirm/);
    const rec = rulesOf(f).find((r) => /never import lodash/.test(r.statement))!;
    assert.equal(rec.status, "draft");
    const person = personTokenEnv(join(f.sandbox, "person-home"), "tok");
    const ok = hunch(f, person, "record-constraint", "never import axios either", "--scope", "src/**");
    assert.equal(ok.status, 0, ok.out);
    assert.equal(rulesOf(f).find((r) => /never import axios/.test(r.statement))!.status, "active");
  } finally { cleanupDir(f.sandbox); }
});

test("record-constraint over a challenged rule without a person exits 4 and the challenge stays; a person keeps it too", () => {
  const f = makeRepo();
  try {
    const person = personTokenEnv(join(f.sandbox, "person-home"), "tok");
    const made = hunch(f, person, "record-constraint", "never import moment", "--scope", "src/**");
    assert.equal(made.status, 0, made.out);
    const id = rulesOf(f).find((r) => /never import moment/.test(r.statement))!.id;
    assert.equal(hunch(f, {}, "challenge", id, "--reason", "odd").status, 0);
    assert.equal(rulesOf(f).find((r) => r.id === id)!.status, "challenged");
    const before = snapshot(f);
    const r = hunch(f, {}, "record-constraint", "never import moment", "--scope", "src/**");
    assert.equal(r.status, 4, r.out);
    assert.equal(snapshot(f), before);
    assert.equal(hunch(f, person, "record-constraint", "never import moment", "--scope", "src/**").status, 0);
    assert.equal(rulesOf(f).find((x) => x.id === id)!.status, "challenged");
  } finally { cleanupDir(f.sandbox); }
});

test("person-token init refuses without a terminal (exit 4)", () => {
  const f = makeRepo();
  try {
    const r = hunch(f, {}, "person-token", "init", "--rotate");
    assert.equal(r.status, 4, r.out);
    assert.equal(existsSync(personTokenFile(join(f.sandbox, "person-home"))), false);
  } finally { cleanupDir(f.sandbox); }
});

test("initPersonToken writes the hash only, refuses overwrite without rotate, and refuses a symlinked .hunch", (t) => {
  const dir = tempDir("hunch-ptok-");
  try {
    const a = initPersonToken(dir, false);
    assert.ok(a.ok);
    if (!a.ok) return;
    const text = readFileSync(a.file, "utf8");
    assert.equal(JSON.parse(text).sha256, hashToken(a.token));
    assert.equal(JSON.parse(text).v, 1);
    assert.ok(!text.includes(a.token));
    assert.equal(initPersonToken(dir, false).ok, false);
    const b = initPersonToken(dir, true);
    assert.ok(b.ok && b.token !== a.token);
    const other = tempDir("hunch-ptok2-");
    const target = tempDir("hunch-ptok3-");
    try {
      try { symlinkSync(target, join(other, ".hunch"), "junction"); } catch { t.skip("cannot create symlinks here"); return; }
      assert.equal(initPersonToken(other, false).ok, false);
    } finally { cleanupDir(other); cleanupDir(target); }
  } finally { cleanupDir(dir); }
});

test("requirePerson: terminal path needs the exact id; no terminal and no token refuses", async () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: {} as NodeJS.ProcessEnv };
  const prompts: string[] = [];
  const yes = await requirePerson("retire a rule", "con_a", { ...tty, readLine: async (p) => { prompts.push(p); return "con_a\n"; } });
  assert.deepEqual(yes, { ok: true, via: "tty" });
  assert.match(prompts[0]!, /^Type con_a to confirm: retire a rule/);
  const no = await requirePerson("retire a rule", "con_a", { ...tty, readLine: async () => "con_b" });
  assert.equal(no.ok, false);
  const none = await requirePerson("retire a rule", "con_a", { stdinIsTTY: false, stdoutIsTTY: true, env: {} });
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.message, /^Only a person can retire a rule\. Run this in your own terminal/);
  const half = await requirePerson("retire a rule", "con_a", { stdinIsTTY: true, stdoutIsTTY: false, env: {} });
  assert.equal(half.ok, false);
});

test("requirePerson: a token never falls back to the terminal and is never echoed", async () => {
  const dir = tempDir("hunch-ptok-");
  try {
    personTokenEnv(dir, "good");
    const io = { stdinIsTTY: true, stdoutIsTTY: true, home: dir, readLine: async (): Promise<string> => { throw new Error("must not prompt"); } };
    assert.deepEqual(await requirePerson("x", "con_a", { ...io, env: { HUNCH_PERSON_TOKEN: "good" } }), { ok: true, via: "token" });
    const bad = await requirePerson("x", "con_a", { ...io, env: { HUNCH_PERSON_TOKEN: "bad-secret" } });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.doesNotMatch(bad.message, /bad-secret|good/);
    writeFileSync(personTokenFile(dir), "{not json");
    assert.equal((await requirePerson("x", "con_a", { ...io, env: { HUNCH_PERSON_TOKEN: "good" } })).ok, false);
  } finally { cleanupDir(dir); }
});

// ---- every CLI path that can write a rule: refused without a person, or only an unapproved agent draft ----

function ruleFiles(f: Fixture): Map<string, { text: string; rec: Record<string, any> }> {
  const dir = join(f.root, ".hunch", "constraints");
  const out = new Map<string, { text: string; rec: Record<string, any> }>();
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const text = readFileSync(join(dir, n), "utf8");
    out.set(n, { text, rec: JSON.parse(text) });
  }
  return out;
}
function commitAll(f: Fixture, msg: string): void { git(f.root, f.env, "add", "-A"); git(f.root, f.env, "commit", "-qm", msg); }
function queueProposal(f: Fixture): void {
  writeProposalQueue(join(f.root, ".hunch"), { pending: [{ id: "con_prop", file: "CONTRIBUTING.md", statement: "s", quote: "q", scope: ["src/**"], severity: "warning", type: "correctness", provider: "p", proposedAt: "2026-01-01T00:00:00.000Z", hash: "sha256:x" }], dropped: [] } as never);
}

interface WriteCase { name: string; args: string[]; expect: "refuse" | "draft"; source?: RegExp; exit?: number; setup?: (f: Fixture, person: NodeJS.ProcessEnv) => void }
const MARKER_DOC = (text: string) => `# Rules\n\n<!-- hunch:rule scope=src/** severity=warning id=tbl -->\n${text}\n`;
const HASHES = ["--expected-source-hash", `sha256:${"0".repeat(64)}`, "--expected-review-hash", `sha256:${"1".repeat(64)}`, "--reviewed-by", "human:test"];
// Two failing TAP scripts with the same failure text: the second `hunch test` is a recurrence and promotes a guard.
const tapFail = (name: string) => `console.log("TAP version 13");
console.log("not ok 1 - ${name}");
console.log("  ---");
console.log("  error: 'checkout total rounding mismatch in cart totals'");
console.log("  ...");
console.log("1..1");
process.exit(1);
`
const WRITE_CASES: WriteCase[] = [
  { name: "record-constraint (new)", args: ["record-constraint", "never import lodash anywhere", "--scope", "src/**"], expect: "draft" },
  { name: "new constraint", args: ["new", "constraint", "--text", "never call eval in src", "--file", "src/**"], expect: "draft" },
  { name: "hunch test promotes a guard (draft)", args: ["test", "node", "second.cjs"], expect: "draft", source: /^derived/, exit: 1,
    setup: (f) => {
      writeFileSync(join(f.root, "first.cjs"), tapFail("cart total rounds wrongly"));
      writeFileSync(join(f.root, "second.cjs"), tapFail("order total rounds wrongly"));
      const first = hunch(f, {}, "test", "node", "first.cjs");
      assert.equal(first.status, 1, first.out);
      commitAll(f, "first failure");
    } },
  { name: "review-memory capture --apply (draft)", args: ["review-memory", "capture", "--from", "packet.json", "--rules", "rules.json", "--apply", "--public"], expect: "draft",
    setup: (f) => {
      git(f.root, f.env, "remote", "add", "origin", "https://github.com/acme/app.git");
      mkdirSync(join(f.root, "src"), { recursive: true });
      writeFileSync(join(f.root, "src", "auth.ts"), "export const auth = true;\n");
      writeFileSync(join(f.root, "reviews.json"), JSON.stringify([{ id: 1, path: "src/auth.ts", body: "Handle missing tenant.",
        html_url: "https://github.com/acme/app/pull/1#discussion_r1", commit_id: "a".repeat(40),
        created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z", user: { login: "alice", type: "User" } }]));
      const prepared = hunch(f, {}, "review-memory", "prepare", "--from", "reviews.json", "--repository", "acme/app");
      assert.equal(prepared.status, 0, prepared.out);
      writeFileSync(join(f.root, "packet.json"), prepared.stdout);
      const packet = JSON.parse(prepared.stdout);
      writeFileSync(join(f.root, "rules.json"), JSON.stringify([{ candidate_id: packet.candidates[0].id, evidence_hash: packet.candidates[0].evidence_hash,
        rule: "Missing tenant must fail validation.", check: "Send a request without a tenant and assert validation fails." }]));
      commitAll(f, "review inputs");
    } },
  { name: "derive-rules (default)", args: ["derive-rules"], expect: "draft",
    setup: (f) => { writeFileSync(join(f.root, "RULES.md"), MARKER_DOC("Never log the session cookie.")); commitAll(f, "doc rule"); } },
  { name: "derive-rules --accept-changes", args: ["derive-rules", "--accept-changes"], expect: "refuse",
    setup: (f, person) => {
      writeFileSync(join(f.root, "RULES.md"), MARKER_DOC("Never log the session cookie."));
      commitAll(f, "doc rule");
      const imported = hunch(f, person, "derive-rules");
      assert.equal(imported.status, 0, imported.out);
      commitAll(f, "imported");
      writeFileSync(join(f.root, "RULES.md"), MARKER_DOC("Never log any cookie at all."));
      commitAll(f, "doc rule edited");
    } },
  { name: "derive-rules --accept", args: ["derive-rules", "--accept", "con_prop", "--expect", "sha256:x"], expect: "refuse", setup: queueProposal },
  { name: "derive-rules --drop", args: ["derive-rules", "--drop", "con_prop"], expect: "refuse", setup: queueProposal },
  { name: "capture-comments", args: ["capture-comments"], expect: "draft",
    setup: (f) => { mkdirSync(join(f.root, "src"), { recursive: true }); writeFileSync(join(f.root, "src", "a.ts"), "// hunch-rule: never mutate the shared cache outside cache.ts\nexport const a = 1;\n"); commitAll(f, "inline rule"); } },
  { name: "review --confirm", args: ["review", "--confirm", "con_dra"], expect: "refuse" },
  { name: "review --unconfirm", args: ["review", "--unconfirm", "con_act"], expect: "refuse" },
  { name: "review --accept", args: ["review", "--accept", "dec_none"], expect: "refuse" },
  { name: "review --accept-verified", args: ["review", "--accept-verified"], expect: "refuse" },
  { name: "review --reject", args: ["review", "--reject", "dec_none"], expect: "refuse" },
  { name: "review --reject-duplicates", args: ["review", "--reject-duplicates"], expect: "refuse" },
  { name: "review --approve-import", args: ["review", "--approve-import", "dec_none", ...HASHES], expect: "refuse" },
  { name: "review --decline-import", args: ["review", "--decline-import", "dec_none", ...HASHES], expect: "refuse" },
  { name: "challenge clear", args: ["challenge", "clear", "con_chal", "--reason", "fine"], expect: "refuse" },
  { name: "replace", args: ["replace", "con_act", "--with", "con_new", "--reason", "newer"], expect: "refuse" },
  { name: "retire-constraint", args: ["retire-constraint", "con_act"], expect: "refuse" },
  { name: "remove", args: ["remove", "con_act", "--reason", "x"], expect: "refuse" },
  { name: "restore", args: ["restore", "con_act"], expect: "refuse" },
  { name: "edit", args: ["edit", "con_act", "--rationale", "new"], expect: "refuse" },
  { name: "link", args: ["link", "con_act", "--add-file", "src/x.ts"], expect: "refuse" },
];

test("every CLI path that writes a rule, without a TTY or a token, is refused (exit 4, no change) or leaves only an agent_recorded draft", () => {
  for (const c of WRITE_CASES) {
    const f = makeRepo();
    try {
      c.setup?.(f, personTokenEnv(join(f.sandbox, "person-home"), "tok-table"));
      const beforeSnap = snapshot(f);
      const before = ruleFiles(f);
      const r = hunch(f, {}, ...c.args);
      if (c.expect === "refuse") {
        assert.equal(r.status, 4, `${c.name} must exit 4:\n${r.out}`);
        assert.equal(snapshot(f), beforeSnap, `${c.name} must not change the store`);
        continue;
      }
      assert.equal(r.status, c.exit ?? 0, `${c.name}:\n${r.out}`);
      const changed = [...ruleFiles(f)].filter(([n, v]) => before.get(n)?.text !== v.text);
      assert.ok(changed.length > 0, `${c.name} should have recorded a draft`);
      for (const [n, v] of changed) {
        assert.equal(v.rec.status, "draft", `${c.name}: ${n} must be a draft`);
        assert.match(String(v.rec.provenance.source), c.source ?? /^agent_recorded/, `${c.name}: ${n}`);
        assert.doesNotMatch(String(v.rec.provenance.source), /human_confirmed/, `${c.name}: ${n}`);
      }
    } finally { cleanupDir(f.sandbox); }
  }
});

test("a token store forged through HOME, USERPROFILE or HUNCH_HOME is refused: the store is read from the OS account home only", () => {
  const f = makeRepo();
  try {
    const forged = join(f.sandbox, "forged");
    mkdirSync(join(forged, ".hunch"), { recursive: true });
    writeFileSync(join(forged, ".hunch", "person-token.json"), `${JSON.stringify({ v: 1, sha256: hashToken("forged-token"), created: "2026-01-01T00:00:00.000Z" })}\n`);
    const before = snapshot(f);
    for (const seam of [{ HOME: forged }, { USERPROFILE: forged }, { HUNCH_HOME: forged }, { HOME: forged, USERPROFILE: forged, HUNCH_HOME: forged }]) {
      const r = hunch(f, { ...seam, HUNCH_PERSON_TOKEN: "forged-token" }, "retire-constraint", "con_act");
      assert.equal(r.status, 4, `${JSON.stringify(seam)}:\n${r.out}`);
      assert.equal(snapshot(f), before);
    }
  } finally { cleanupDir(f.sandbox); }
});

test("takePersonToken removes the token from the environment (so children never inherit it) and keeps it for later gates", async () => {
  const dir = tempDir("hunch-person-take-");
  try {
    personTokenEnv(dir, "held-token");
    process.env.HUNCH_PERSON_TOKEN = "held-token";
    assert.equal(takePersonToken(), "held-token");
    assert.equal(process.env.HUNCH_PERSON_TOKEN, undefined);
    assert.equal(takePersonToken(), "held-token", "later gates in the same process still see it");
  } finally { resetHeldPersonToken(); delete process.env.HUNCH_PERSON_TOKEN; cleanupDir(dir); }
});

test("challenging an already challenged rule keeps the first challenge and refuses", () => {
  const f = makeRepo();
  try {
    const before = snapshot(f);
    const r = hunch(f, {}, "challenge", "con_chal", "--reason", "overwrite attempt");
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /already challenged/);
    assert.equal(snapshot(f), before);
    assert.equal(rulesOf(f).find((x) => x.id === "con_chal")!.challenge.reason, "odd");
  } finally { cleanupDir(f.sandbox); }
});

// ---- an agent re-running a failure must not rewrite an existing guard ----

function guardFile(f: Fixture): { name: string; text: string; rec: Record<string, any> } {
  const guards = [...ruleFiles(f)].filter(([, v]) => /^Regression guard:/.test(String(v.rec.statement)));
  assert.equal(guards.length, 1, `expected exactly one regression guard, got ${guards.length}`);
  return { name: guards[0]![0], ...guards[0]![1] };
}
/** A person records two failures through `hunch test`, so the second promotes a guard (active: a person wrote it). */
function personGuard(f: Fixture, person: NodeJS.ProcessEnv): void {
  writeFileSync(join(f.root, "first.cjs"), tapFail("cart total rounds wrongly"));
  writeFileSync(join(f.root, "second.cjs"), tapFail("order total rounds wrongly"));
  assert.equal(hunch(f, person, "test", "node", "first.cjs").status, 1);
  commitAll(f, "first failure");
  const second = hunch(f, person, "test", "node", "second.cjs");
  assert.equal(second.status, 1, second.out);
  commitAll(f, "guard");
}

test("hunch test with a person token writes an active guard on a fresh repo", () => {
  const f = makeRepo();
  try {
    personGuard(f, personTokenEnv(join(f.sandbox, "person-home"), "tok-pos"));
    assert.equal(guardFile(f).rec.status, "active");
  } finally { cleanupDir(f.sandbox); }
});

test("an agent re-running hunch test or record-bug leaves an existing person-approved guard byte-identical", () => {
  const f = makeRepo();
  try {
    const person = personTokenEnv(join(f.sandbox, "person-home"), "tok-agent");
    personGuard(f, person);
    const g = guardFile(f);
    const confirmed = hunch(f, person, "review", "--confirm", g.rec.id, "--severity", "blocking");
    assert.equal(confirmed.status, 0, confirmed.out);
    commitAll(f, "confirmed");
    const before = guardFile(f);
    assert.equal(before.rec.status, "active");
    assert.equal(before.rec.severity, "blocking");
    const rerun = hunch(f, {}, "test", "node", "second.cjs");
    assert.match(rerun.out, /kept existing guard/, rerun.out);
    assert.equal(guardFile(f).text, before.text, "hunch test by an agent must not rewrite the guard");
    const bug = hunch(f, {}, "record-bug", "--test", "order total rounds wrongly", "--message", "checkout total rounding mismatch in cart totals");
    assert.equal(bug.status, 0, bug.out);
    assert.match(bug.out, /kept existing guard/, bug.out);
    assert.equal(guardFile(f).text, before.text, "record-bug by an agent must not rewrite the guard");
  } finally { cleanupDir(f.sandbox); }
});

test("a tokenless hunch test --private never writes an overlay twin of a person-approved public guard", () => {
  const f = makeRepo();
  try {
    const person = personTokenEnv(join(f.sandbox, "person-home"), "tok-xhome");
    personGuard(f, person);
    const g = guardFile(f);
    assert.equal(hunch(f, person, "review", "--confirm", g.rec.id, "--severity", "blocking").status, 0);
    commitAll(f, "confirmed");
    const confirmedText = guardFile(f).text;
    const overlay = join(f.sandbox, "overlay");
    mkdirSync(overlay, { recursive: true });
    const priv = { HUNCH_PRIVATE_DIR: overlay };
    hunch(f, priv, "test", "--private", "node", "first.cjs");
    const second = hunch(f, priv, "test", "--private", "node", "second.cjs");
    assert.match(second.out, /kept existing guard/, second.out);
    assert.equal(existsSync(join(overlay, "constraints", `${g.rec.id}.json`)), false, "no overlay twin");
    const rule = rulesOf(f).find((r) => r.id === g.rec.id)!;
    assert.equal(rule.status, "active");
    assert.equal(rule.severity, "blocking");
    assert.equal(guardFile(f).text, confirmedText);
  } finally { cleanupDir(f.sandbox); }
});

test("a tokenless public hunch test never writes a public twin of an overlay guard", () => {
  const f = makeRepo();
  try {
    const overlay = join(f.sandbox, "overlay");
    mkdirSync(overlay, { recursive: true });
    const priv = { HUNCH_PRIVATE_DIR: overlay };
    writeFileSync(join(f.root, "first.cjs"), tapFail("cart total rounds wrongly"));
    writeFileSync(join(f.root, "second.cjs"), tapFail("order total rounds wrongly"));
    hunch(f, priv, "test", "--private", "node", "first.cjs");
    hunch(f, priv, "test", "--private", "node", "second.cjs");
    const twins = existsSync(join(overlay, "constraints")) ? readdirSync(join(overlay, "constraints")) : [];
    assert.equal(twins.length, 1, `overlay guard expected, got ${twins.join(",")}`);
    const id = twins[0]!.replace(/\.json$/, "");
    const before = readFileSync(join(overlay, "constraints", twins[0]!), "utf8");
    hunch(f, priv, "test", "node", "first.cjs");
    const pub = hunch(f, priv, "test", "node", "second.cjs");
    assert.match(pub.out, /kept existing guard/, pub.out);
    assert.equal(existsSync(join(f.root, ".hunch", "constraints", `${id}.json`)), false, "no public twin");
    assert.equal(readFileSync(join(overlay, "constraints", twins[0]!), "utf8"), before);
  } finally { cleanupDir(f.sandbox); }
});

test("a corrupt rule file at the guard id is not overwritten by a tokenless hunch test", () => {
  const f = makeRepo();
  try {
    personGuard(f, personTokenEnv(join(f.sandbox, "person-home"), "tok-corrupt"));
    const g = guardFile(f);
    const path = join(f.root, ".hunch", "constraints", g.name);
    writeFileSync(path, "{ not json");
    const rerun = hunch(f, {}, "test", "node", "second.cjs");
    assert.match(rerun.out, /kept existing guard/, rerun.out);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
  } finally { cleanupDir(f.sandbox); }
});

test("an agent re-running hunch test keeps a challenge on an existing guard", () => {
  const f = makeRepo();
  try {
    personGuard(f, personTokenEnv(join(f.sandbox, "person-home"), "tok-chal"));
    const g = guardFile(f);
    const rec = { ...g.rec, challenge: { reason: "disputed", by_session: null, by_run: null, at: "2026-02-01T00:00:00.000Z" } };
    writeFileSync(join(f.root, ".hunch", "constraints", g.name), `${JSON.stringify(rec, null, 2)}\n`);
    commitAll(f, "challenged");
    const before = guardFile(f);
    const rerun = hunch(f, {}, "test", "node", "second.cjs");
    assert.equal(rerun.status, 1, rerun.out);
    const after = guardFile(f);
    assert.equal(after.text, before.text);
    assert.ok(after.rec.challenge, "challenge must survive");
  } finally { cleanupDir(f.sandbox); }
});

test("review-memory capture --apply without a token prints the draft status it wrote", () => {
  const c = WRITE_CASES.find((w) => w.name.startsWith("review-memory capture"))!;
  const f = makeRepo();
  try {
    c.setup!(f, {});
    const r = hunch(f, {}, ...c.args);
    assert.equal(r.status, 0, r.out);
    const printed = JSON.parse(r.stdout);
    assert.equal(printed.applied, true);
    assert.ok(printed.rules.length > 0);
    for (const rule of printed.rules) assert.equal(rule.status, "draft");
  } finally { cleanupDir(f.sandbox); }
});
