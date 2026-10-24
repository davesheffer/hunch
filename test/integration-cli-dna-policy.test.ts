import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
/**
 * Black-box CLI coverage for Project DNA, the Constitution policy lifecycle
 * (corpus, history, demote, withdraw, exception, relations, consolidation) and
 * the read-only constitution delta/scorecard commands. One temp git repo after
 * `hunch init --no-providers`, records seeded as JSON (the source of truth),
 * deterministic synthesis, no network. Each command gets an observable effect
 * plus one refusal path that must write nothing.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Decision } from "../src/core/types.js";
import { hunchCliArgs } from "./cli-invocation.js";

const NOW = new Date(Date.now() - 86_400_000).toISOString();
const DEC_LAYER = "dec_d4a0000001";
const DEC_EXC = "dec_d4a0000002";
const DEC_HIST = "dec_d4a0000003";
const PARENT = "pol_d1d1d1d1d1";
const CHILD = "pol_e1e1e1e1e1";
const HUMAN = "human:cli-owner";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string }
interface PolicyFile {
  id: string; state: string; revision: number; severity: string; exception_of: string | null;
  authority: { actor: string } | null; proof: string | null; audit: { action: string; actor?: string; reason?: string }[];
  scope: { repos: string[]; paths: string[]; components: string[] };
  assertion: { kind: string };
}

function makeEnv(sandbox: string): NodeJS.ProcessEnv {
  const home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  return isolatedCliEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData"),
    GIT_CONFIG_NOSYSTEM: "1",
    HUNCH_PRIVATE_DIR: "",
    HUNCH_SYNC: "1",
    HUNCH_SYNTH_PROVIDER: "deterministic",
    NO_COLOR: "1",
    CI: "1",
  });
}

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", args, { cwd: f.root, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(f: Fixture, ...args: string[]): Run {
  const r = spawnSync(process.execPath, hunchCliArgs(...args), { cwd: f.root, env: f.env, encoding: "utf8", timeout: 180_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ok(f: Fixture, ...args: string[]): Run {
  const r = hunch(f, ...args);
  assert.equal(r.status, 0, `hunch ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function refused(f: Fixture, pattern: RegExp, ...args: string[]): Run {
  const r = hunch(f, ...args);
  assert.notEqual(r.status, 0, `hunch ${args.join(" ")} must be refused:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, pattern);
  return r;
}

function write(f: Fixture, rel: string, text: string): void {
  mkdirSync(join(f.root, rel, ".."), { recursive: true });
  writeFileSync(join(f.root, rel), text);
}

function commit(f: Fixture, message: string): string {
  git(f, "add", "-A");
  git(f, "commit", "-qm", message);
  return git(f, "rev-parse", "HEAD");
}

/** Every file under `root` except git internals and the derived SQLite index. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name.startsWith("hunch.sqlite")) continue;
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.set(relative(root, file).replace(/\\/g, "/"), readFileSync(file).toString("base64"));
    }
  };
  walk(root);
  return out;
}

function assertUnchanged(before: Map<string, string>, root: string, what: string): void {
  const now = snapshot(root);
  const added = [...now.keys()].filter((k) => !before.has(k));
  const changed = [...now.keys()].filter((k) => before.has(k) && before.get(k) !== now.get(k));
  const removed = [...before.keys()].filter((k) => !now.has(k));
  assert.deepEqual({ added, changed, removed }, { added: [], changed: [], removed: [] }, `${what} must write nothing`);
}

function decision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    title: "Order controllers must use OrderService for persistence",
    topic: "orders.controller-db-boundary",
    status: "accepted",
    context: "A direct controller-to-DB optimization reintroduced the N+1 incident.",
    decision: "Controllers reach persistence through the service boundary.",
    consequences: [],
    alternatives_rejected: ["Direct database access from controllers."],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/api/orders.ts", "src/services/orders.ts", "src/db/client.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: "bug_n_plus_one",
    commit: null,
    valid_from: NOW,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }],
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-431"] },
    date: NOW,
    ...overrides,
  };
}

function putJson(f: Fixture, kind: string, rec: { id: string }): void {
  mkdirSync(join(f.root, ".hunch", kind), { recursive: true });
  writeFileSync(join(f.root, ".hunch", kind, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}

function policyFile(f: Fixture, id: string): PolicyFile {
  return JSON.parse(readFileSync(join(f.root, ".hunch", "policies", `${id}.json`), "utf8")) as PolicyFile;
}

function policyIds(f: Fixture): string[] {
  const dir = join(f.root, ".hunch", "policies");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort() : [];
}

const GOOD_API = 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u: string) { return fetchOrders(u); }\n';
const BAD_API = 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u: string) { return dbQuery(u); }\n';

describe("CLI dna, policy lifecycle and constitution inspection", () => {
  let f: Fixture;
  let firstSha = "";
  let knownBad = "";
  let fixSha = "";
  let policyId = "";

  before(() => {
    const sandbox = tempDir("hunch-cli-dna-policy-");
    const root = join(sandbox, "repo");
    mkdirSync(root, { recursive: true });
    f = { sandbox, root, env: makeEnv(sandbox) };
    git(f, "init", "-q", "-b", "main");
    git(f, "config", "user.email", "cli-dna@example.com");
    git(f, "config", "user.name", "CLI DNA");
    git(f, "config", "commit.gpgsign", "false");
    git(f, "config", "maintenance.auto", "false");
    git(f, "config", "gc.auto", "0");
    write(f, "package.json", `${JSON.stringify({ name: "cli-dna-policy", private: true, type: "module" }, null, 2)}\n`);
    write(f, "CONTRIBUTING.md", "Behavior changes must include tests. Keep changes focused. Explain why the change is needed in the pull request.\n");
    write(f, "src/db/client.ts", "export function dbQuery(sql: string) { return sql; }\n");
    write(f, "src/services/orders.ts", 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u: string) { return dbQuery(u); }\n');
    write(f, "src/api/orders.ts", GOOD_API);
    firstSha = commit(f, "fix: layered orders baseline");
    // A known-bad bypass on a side branch: resolvable for the corpus, never in accepted first-parent history.
    git(f, "checkout", "-q", "-b", "bad-bypass");
    write(f, "src/api/orders.ts", BAD_API);
    knownBad = commit(f, "fix: controller bypasses service");
    git(f, "checkout", "-q", "main");
    write(f, "src/auth/session.ts", "export function verifySession() { return true; }\n");
    write(f, "src/payments/charge.ts", "export function charge() { return true; }\n");
    commit(f, "fix: add payment baseline");
    write(f, "src/payments/charge.ts", 'import { verifySession } from "../auth/session.js";\nexport function charge() { return verifySession(); }\n');
    fixSha = commit(f, "fix: restore required session validation");
    for (let i = 1; i <= 3; i++) {
      write(f, "notes.txt", `${i}\n`);
      commit(f, `fix: update notes ${i}`);
    }
    ok(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
    commit(f, "chore: hunch init scaffolding");

    putJson(f, "decisions", decision(DEC_LAYER));
    putJson(f, "decisions", decision(DEC_EXC, {
      title: "API handlers never reach the db client",
      topic: "orders.api-db-reach",
      caused_by_bug: null,
      related_files: ["src/api/orders.ts"],
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-432"] },
    }));
    const { conformance: _c, ...hist } = decision(DEC_HIST, {
      title: "charge must call verifySession",
      topic: "payments.session-validation",
      context: "The charge path skipped verifySession and reopened the session-bypass bug.",
      decision: "Keep the exact charge -> verifySession call in the static graph.",
      commit: fixSha,
      caused_by_bug: "bug_session_bypass",
      related_files: ["src/payments/charge.ts"],
    });
    putJson(f, "decisions", hist as Decision);
    commit(f, "chore: seed decisions");

    ok(f, "policy", "compile", DEC_LAYER, "--through", "fetchOrders");
    const ids = policyIds(f);
    assert.equal(ids.length, 1, `exactly one compiled policy: ${ids.join(", ")}`);
    policyId = ids[0]!;
    assert.equal(policyFile(f, policyId).state, "compiled");
  });

  after(() => { if (f) cleanupDir(f.sandbox); });

  // ---- dna ---------------------------------------------------------------

  test("cli:dna: bare group prints its subcommands; an unknown subcommand is refused", () => {
    const before = snapshot(f.root);
    const bare = hunch(f, "dna");
    const text = bare.stdout + bare.stderr;
    for (const sub of ["inspect", "match", "context", "diff"]) assert.match(text, new RegExp(`\\b${sub}\\b`), text);
    refused(f, /unknown command 'bogus'/, "dna", "bogus");
    assertUnchanged(before, f.root, "dna help/unknown");
  });

  test("cli:dna inspect: --json profile is bound to HEAD and writes nothing; an unknown ref is refused", () => {
    const before = snapshot(f.root);
    const head = git(f, "rev-parse", "HEAD");
    const json = ok(f, "dna", "inspect", "--json");
    const profile = JSON.parse(json.stdout) as { schema: string; profile_id: string; repository_revision: string; source_files: string[] };
    assert.equal(profile.schema, "hunch.project-dna/1");
    assert.match(profile.profile_id, /^pdna_[a-f0-9]{24}$/);
    assert.equal(profile.repository_revision, head);
    assert.ok(profile.source_files.includes("CONTRIBUTING.md"), profile.source_files.join(", "));
    const human = ok(f, "dna", "inspect", "--ref", firstSha);
    assert.match(human.stdout, new RegExp(`^Project DNA at ${firstSha}`, "m"));
    assert.match(human.stdout, /Advisory observation only; no trait was adopted into graph authority\./);
    refused(f, /Git revision .no-such-ref-xyz. does not name a commit/, "dna", "inspect", "--ref", "no-such-ref-xyz");
    assertUnchanged(before, f.root, "dna inspect");
  });

  test("cli:dna context: renders the bounded advisory supplement; a bad ref is refused", () => {
    const before = snapshot(f.root);
    const text = ok(f, "dna", "context", "--traits", "3");
    assert.ok(text.stdout.trim().length > 0);
    const json = ok(f, "dna", "context", "--json");
    assert.ok(json.stdout.trim().startsWith("{") || json.stdout.trim() === "null", json.stdout);
    refused(f, /Git revision .no-such-ref-xyz. does not name a commit/, "dna", "context", "--ref", "no-such-ref-xyz");
    assertUnchanged(before, f.root, "dna context");
  });

  test("cli:dna match: scores a conventional commit subject; an unknown --kind is refused", () => {
    const before = snapshot(f.root);
    const r = ok(f, "dna", "match", "--kind", "commit", "--title", "fix: handle order timeout", "--json");
    const match = JSON.parse(r.stdout) as { schema: string; score: number | null; checks: { key: string; applicable: boolean }[] };
    assert.equal(match.schema, "hunch.project-dna-match/1");
    assert.ok(Array.isArray(match.checks));
    const human = ok(f, "dna", "match", "--kind", "pull_request", "--title", "Fix order timeout", "--body", "Adds tests.");
    assert.match(human.stdout, /^Project Match: /m);
    assert.match(human.stdout, /Advisory only; the score does not grant or change enforcement authority\./);
    refused(f, /--kind must be commit, pull_request, issue, or message/, "dna", "match", "--kind", "tweet", "--title", "x");
    assertUnchanged(before, f.root, "dna match");
  });

  test("cli:dna diff: compares two exact revisions without rewriting either; a bad revision is refused", () => {
    const before = snapshot(f.root);
    const r = ok(f, "dna", "diff", firstSha, "HEAD", "--json");
    const delta = JSON.parse(r.stdout) as { schema: string; delta_id: string; changed: boolean; changes: unknown[] };
    assert.equal(delta.schema, "hunch.project-dna-delta/1");
    assert.equal(typeof delta.changed, "boolean");
    const same = ok(f, "dna", "diff", "HEAD", "HEAD");
    assert.match(same.stdout, /no observed change/);
    assert.match(same.stdout, /Observation only; no Project DNA profile or graph authority was rewritten\./);
    refused(f, /Git revision .no-such-ref-xyz. does not name a commit/, "dna", "diff", "no-such-ref-xyz", "HEAD");
    assertUnchanged(before, f.root, "dna diff");
  });

  // ---- policy ------------------------------------------------------------

  test("cli:policy corpus: imports an immutable known-good/bad corpus and inspects it; refusals write nothing", () => {
    const before = snapshot(f.root);
    refused(f, new RegExp(`policy ${policyId} has no imported proof corpus`), "policy", "corpus", policyId);
    refused(f, /policy pol_0000000000 not found/, "policy", "corpus", "pol_0000000000");
    const corpusFile = join(f.sandbox, "corpus.json");
    writeFileSync(corpusFile, JSON.stringify({
      known_bad: [{ ref: "bad-bypass", label: "confirmed controller bypass" }],
      known_good: [{ ref: firstSha, label: "accepted service path", attestation: { actor: "github:reviewer", reason: "Reviewed service-only path." } }],
    }));
    refused(f, /--public-only cannot be combined with --import/, "policy", "corpus", policyId, "--import", corpusFile, "--public-only");
    assertUnchanged(before, f.root, "refused corpus");

    const r = ok(f, "policy", "corpus", policyId, "--import", corpusFile);
    assert.match(r.stdout, new RegExp(`for ${policyId}: 1 known bad, 1 known good \\(1 human-attested\\)`));
    assert.ok(existsSync(join(f.root, ".hunch", "corpora", `${policyId}.json`)));
    const shown = JSON.parse(ok(f, "policy", "corpus", policyId).stdout) as { policy_id: string; known_bad: { ref: string }[]; known_good: { ref: string }[] };
    assert.equal(shown.policy_id, policyId);
    assert.deepEqual(shown.known_bad.map((x) => x.ref), [knownBad], "branch ref resolves to an immutable SHA");
    assert.deepEqual(shown.known_good.map((x) => x.ref), [firstSha]);
  });

  test("cli:policy history: lists accepted-history receipts after proof; partial classification is refused", () => {
    const pre = snapshot(f.root);
    refused(f, new RegExp(`policy ${policyId} has no proof`), "policy", "history", policyId);
    refused(f, /history classification requires --commit, --classify, --actor, and --reason/, "policy", "history", policyId, "--classify", "unknown_insufficient_parser");
    assertUnchanged(pre, f.root, "refused history");

    ok(f, "policy", "prove", policyId);
    assert.equal(policyFile(f, policyId).state, "proposed");
    const view = JSON.parse(ok(f, "policy", "history", policyId).stdout) as { policy_id: string; proof_id: string; violations: unknown[]; current: unknown[]; audit: unknown[] };
    assert.equal(view.policy_id, policyId);
    assert.equal(view.proof_id, policyFile(f, policyId).proof);
    assert.deepEqual(view.violations, [], "the side-branch bypass is not accepted first-parent history");
    assert.deepEqual(view.current, []);

    const post = snapshot(f.root);
    const r = hunch(f, "policy", "history", policyId, "--commit", firstSha, "--classify", "true_positive_accepted_exception", "--actor", HUMAN, "--reason", "not a receipt");
    assert.notEqual(r.status, 0, `classifying a commit with no violated receipt must be refused:\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.trim().length > 0);
    assertUnchanged(post, f.root, "refused classification");
  });

  test("cli:policy demote: active blocking -> active advisory with an audit entry; demoting again is refused", () => {
    const before = snapshot(f.root);
    refused(f, new RegExp(`policy ${policyId} is proposed; only active blocking policy can be demoted`), "policy", "demote", policyId, "--actor", HUMAN, "--reason", "too early");
    assertUnchanged(before, f.root, "refused demote");

    ok(f, "policy", "accept", policyId, "--blocking", "--actor", HUMAN);
    assert.equal(policyFile(f, policyId).state, "active_blocking");
    const r = ok(f, "policy", "demote", policyId, "--actor", HUMAN, "--reason", "Refactor exception under review.");
    assert.match(r.stdout, new RegExp(`${policyId} demoted to active_advisory; history retained`));
    const demoted = policyFile(f, policyId);
    assert.equal(demoted.state, "active_advisory");
    assert.equal(demoted.severity, "warning");
    assert.deepEqual(demoted.audit.at(-1), { ...demoted.audit.at(-1), action: "demoted", actor: HUMAN, reason: "Refactor exception under review." });

    const mid = snapshot(f.root);
    refused(f, /is active_advisory; only active blocking policy can be demoted/, "policy", "demote", policyId, "--actor", HUMAN, "--reason", "again");
    refused(f, /human/i, "policy", "demote", policyId, "--actor", "machine:agent", "--reason", "agent says so");
    assertUnchanged(mid, f.root, "second demote");
  });

  test("cli:policy withdraw: active advisory -> proposed with authority cleared; withdrawing again is refused", () => {
    const r = ok(f, "policy", "withdraw", policyId, "--actor", HUMAN, "--reason", "Back to the escalation loop.");
    assert.match(r.stdout, new RegExp(`${policyId} withdrawn to proposed; authority returned to the human pool`));
    const withdrawn = policyFile(f, policyId);
    assert.equal(withdrawn.state, "proposed");
    assert.equal(withdrawn.authority, null);
    assert.deepEqual(withdrawn.audit.slice(-2).map((a) => a.action), ["demoted", "withdrawn"], "history keeps the full lifecycle");

    const before = snapshot(f.root);
    refused(f, /is proposed; only active advisory policy can be withdrawn to proposed/, "policy", "withdraw", policyId, "--actor", HUMAN, "--reason", "again");
    refused(f, /required option '--reason/, "policy", "withdraw", policyId, "--actor", HUMAN);
    assertUnchanged(before, f.root, "second withdraw");
  });

  test("cli:policy exception: links a strictly narrower opposite policy to its parent; a broader child is refused", () => {
    ok(f, "policy", "compile", DEC_EXC);
    const compiledIds = policyIds(f).filter((id) => id !== policyId);
    assert.equal(compiledIds.length, 1, compiledIds.join(", "));
    const base = policyFile(f, compiledIds[0]!);
    assert.equal(base.assertion.kind, "not-reaches");
    const parent = { ...base, id: PARENT, scope: { repos: [], paths: ["src/api/**"], components: [] } };
    const child = { ...parent, id: CHILD, scope: { repos: [], paths: ["src/api/orders.ts"], components: [] }, assertion: { ...parent.assertion, kind: "reaches" }, exception_of: null };
    putJson(f, "policies", parent);
    putJson(f, "policies", child);

    const before = snapshot(f.root);
    refused(f, /exception scope must be strictly narrower than and contained by its parent scope/, "policy", "exception", PARENT, "--parent", CHILD, "--actor", HUMAN, "--reason", "wrong way round");
    refused(f, /a policy cannot be its own exception parent/, "policy", "exception", CHILD, "--parent", CHILD, "--actor", HUMAN, "--reason", "self");
    refused(f, /policy pol_0000000000 not found/, "policy", "exception", CHILD, "--parent", "pol_0000000000", "--actor", HUMAN, "--reason", "missing");
    assertUnchanged(before, f.root, "refused exception");

    const r = ok(f, "policy", "exception", CHILD, "--parent", PARENT, "--actor", HUMAN, "--reason", "orders handler intentionally reaches the db");
    assert.match(r.stdout, new RegExp(`${CHILD} linked as a non-blocking exception of ${PARENT}`));
    const linked = policyFile(f, CHILD);
    assert.equal(linked.exception_of, PARENT);
    assert.equal(linked.state, "compiled");
    assert.equal(linked.proof, null);
    assert.equal(linked.audit.at(-1)?.action, "linked_exception");
  });

  test("cli:policy relations: shows the exception edge from both sides; an unknown id is refused", () => {
    const before = snapshot(f.root);
    const parentView = JSON.parse(ok(f, "policy", "relations", PARENT).stdout) as { policy: { id: string }; exception_parent: unknown; exceptions: { id: string }[] };
    assert.equal(parentView.policy.id, PARENT);
    assert.equal(parentView.exception_parent, null);
    assert.deepEqual(parentView.exceptions.map((e) => e.id), [CHILD]);
    const childView = JSON.parse(ok(f, "policy", "relations", CHILD).stdout) as { exception_parent: { id: string } | null; missing_exception_parent: string | null };
    assert.equal(childView.exception_parent?.id, PARENT);
    assert.equal(childView.missing_exception_parent, null);
    refused(f, /policy pol_0000000000 not found/, "policy", "relations", "pol_0000000000");
    assertUnchanged(before, f.root, "relations");
  });

  test("cli:policy consolidation: emits a non-mutating candidate envelope; an unknown id is refused", () => {
    const before = snapshot(f.root);
    for (const id of [policyId, CHILD]) {
      const c = JSON.parse(ok(f, "policy", "consolidation", id).stdout) as { anchor: { id: string }; status: string; members: unknown[]; reasons: string[] };
      assert.equal(c.anchor.id, id);
      assert.equal(typeof c.status, "string");
      assert.ok(Array.isArray(c.members) && Array.isArray(c.reasons));
    }
    refused(f, /policy pol_0000000000 not found/, "policy", "consolidation", "pol_0000000000");
    assertUnchanged(before, f.root, "consolidation");
  });

  // ---- constitution ------------------------------------------------------

  test("cli:constitution delta: inspects the exact fix-commit structural delta; an unanchored decision is refused", () => {
    const before = snapshot(f.root);
    const r = ok(f, "constitution", "delta", DEC_HIST, "--public-only");
    const inspection = JSON.parse(r.stdout) as { kind: string; delta: { calls: { added: unknown[]; removed: unknown[] } }; candidates: { assertion: { kind: string } }[] };
    assert.equal(inspection.kind, "bug_fix");
    assert.equal(inspection.delta.calls.added.length, 1);
    assert.equal(inspection.delta.calls.removed.length, 0);
    assert.equal(inspection.candidates[0]?.assertion.kind, "reaches");
    refused(f, new RegExp(`decision ${DEC_LAYER} has no commit anchor`), "constitution", "delta", DEC_LAYER);
    refused(f, /decision dec_0000000000 not found/, "constitution", "delta", "dec_0000000000", "--public-only");
    assertUnchanged(before, f.root, "constitution delta");
  });

  test("cli:constitution scorecard: scores the shipped EXP-03 bank; a malformed bank is refused", () => {
    const before = snapshot(f.root);
    const human = ok(f, "constitution", "scorecard");
    assert.ok(human.stdout.trim().length > 0);
    const json = JSON.parse(ok(f, "constitution", "scorecard", "--json").stdout) as { passed: boolean };
    assert.equal(json.passed, true);
    const bad = join(f.sandbox, "bank.json");
    writeFileSync(bad, JSON.stringify({ version: 99, cases: "nope" }));
    const r = hunch(f, "constitution", "scorecard", bad);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stderr.trim().length > 0, "a refused bank explains itself");
    refused(f, /ENOENT|no such file/i, "constitution", "scorecard", join(f.sandbox, "missing.json"));
    assertUnchanged(before, f.root, "constitution scorecard");
  });
});
