/**
 * Black-box flag coverage for the governance commands: conform, record-constraint,
 * dna match, review, policy, constitution and review-memory. One temp git repo after
 * `hunch init --no-providers`, records seeded as JSON (the source of truth),
 * deterministic synthesis, no model or network. Each flag is asserted by its
 * observable effect versus the default, or by its argument-validation refusal where
 * the flag's real path needs a private overlay, a model CLI, or GitHub.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "../src/core/types.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";

const NOW = new Date(Date.now() - 86_400_000).toISOString();
const DEC = "dec_9f0a000001";
const DRAFT = "dec_9f0a000002";
const HUMAN = "human:flags-owner";

interface Fixture { sandbox: string; root: string; env: NodeJS.ProcessEnv }
interface Run { status: number | null; stdout: string; stderr: string }

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
  if (git(f, "status", "--porcelain")) git(f, "commit", "-qm", message);
  return git(f, "rev-parse", "HEAD");
}

function readRec<T>(f: Fixture, kind: string, id: string): T {
  return JSON.parse(readFileSync(join(f.root, ".hunch", kind, `${id}.json`), "utf8")) as T;
}

function putJson(f: Fixture, kind: string, rec: { id: string }): void {
  mkdirSync(join(f.root, ".hunch", kind), { recursive: true });
  writeFileSync(join(f.root, ".hunch", kind, `${rec.id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
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
    caused_by_bug: null,
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

const GOOD_API = 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u: string) { return fetchOrders(u); }\n';

describe("cli flags: governance commands", { timeout: 900_000 }, () => {
  let f: Fixture;
  let firstSha = "";
  let policyId = "";

  before(() => {
    const sandbox = tempDir("hunch-cli-flags-gov-");
    const root = join(sandbox, "repo");
    const home = join(sandbox, "home");
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    f = { sandbox, root, env: isolatedCliEnv({
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"),
      GIT_CONFIG_NOSYSTEM: "1", HUNCH_PRIVATE_DIR: "", HUNCH_SYNC: "1", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1", CI: "1",
    }) };
    git(f, "init", "-q", "-b", "main");
    for (const [k, v] of [["user.email", "gov@example.com"], ["user.name", "Gov"], ["commit.gpgsign", "false"], ["maintenance.auto", "false"], ["gc.auto", "0"]]) git(f, "config", k!, v!);
    write(f, "package.json", `${JSON.stringify({ name: "cli-flags-gov", private: true, type: "module" }, null, 2)}\n`);
    write(f, "CONTRIBUTING.md", "Behavior changes must include tests. Keep changes focused.\n");
    write(f, "src/db/client.ts", "export function dbQuery(sql: string) { return sql; }\n");
    write(f, "src/services/orders.ts", 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u: string) { return dbQuery(u); }\n');
    write(f, "src/api/orders.ts", GOOD_API);
    firstSha = commit(f, "fix: layered orders baseline");
    write(f, "notes.txt", "1\n");
    commit(f, "docs: notes");
    ok(f, "init", "--no-providers", "--no-agent-hooks", "--no-auto-commit");
    commit(f, "chore: hunch init scaffolding");
    putJson(f, "decisions", decision(DEC));
    commit(f, "chore: seed decision");
    ok(f, "policy", "compile", DEC, "--through", "fetchOrders");
    const ids = readdirSync(join(f.root, ".hunch", "policies")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    assert.equal(ids.length, 1, ids.join(", "));
    policyId = ids[0]!;
    commit(f, "chore: compile policy");
  });

  after(() => { if (f) cleanupDir(f.sandbox); });

  test("policy list --state filters by lifecycle state", () => {
    assert.match(ok(f, "policy", "list").stdout, new RegExp(`${policyId}\\s+\\[compiled\\]`));
    assert.match(ok(f, "policy", "list", "--state", "compiled").stdout, new RegExp(policyId));
    assert.match(ok(f, "policy", "list", "--state", "active_blocking").stdout, /No Constitution policies found\./);
  });

  test("policy plan --history --mutations --minutes set the ProofPlan budget; invalid budgets are refused", () => {
    const base = ok(f, "policy", "plan", policyId).stdout;
    assert.match(base, /"max_commits": 20/);
    assert.match(base, /"max_mutations": 3/);
    assert.match(base, /"max_minutes": 5/);
    const custom = ok(f, "policy", "plan", policyId, "--history", "7", "--mutations", "1", "--minutes", "9").stdout;
    assert.match(custom, /"max_commits": 7/);
    assert.match(custom, /"max_mutations": 1/);
    assert.match(custom, /"max_minutes": 9/);
    const msg = /history\/mutation budgets must be non-negative and minutes must be positive/;
    refused(f, msg, "policy", "plan", policyId, "--history", "-1");
    refused(f, msg, "policy", "plan", policyId, "--mutations", "nope");
    refused(f, msg, "policy", "plan", policyId, "--minutes", "0");
    commit(f, "chore: plan");
  });

  test("policy history --supersedes and --public-only are validated before any write", () => {
    refused(f, /history classification requires --commit, --classify, --actor, and --reason/, "policy", "history", policyId, "--supersedes", "hdisp_x");
    refused(f, /--public-only cannot be combined with history classification/, "policy", "history", policyId, "--public-only", "--commit", firstSha);
  });

  test("policy shadow --event --classify --actor --reason --supersedes classification is validated", () => {
    refused(f, /shadow classification requires --event, --classify, --actor, and --reason/, "policy", "shadow", policyId, "--event", "shd_x", "--classify", "true_positive_actionable", "--actor", HUMAN, "--supersedes", "sdisp_x");
    refused(f, /choose either --record or a shadow classification/, "policy", "shadow", policyId, "--record", "--reason", "x");
    refused(f, /--public-only cannot be combined with shadow writes/, "policy", "shadow", policyId, "--public-only", "--event", "shd_x");
    refused(f, /invalid|enum|expected/i, "policy", "shadow", policyId, "--event", "shd_x", "--classify", "bogus", "--actor", HUMAN, "--reason", "r");
  });

  test("policy relations/consolidation --public-only still see a public policy", () => {
    assert.deepEqual(JSON.parse(ok(f, "policy", "relations", policyId, "--public-only").stdout), JSON.parse(ok(f, "policy", "relations", policyId).stdout));
    assert.deepEqual(JSON.parse(ok(f, "policy", "consolidation", policyId, "--public-only").stdout), JSON.parse(ok(f, "policy", "consolidation", policyId).stdout));
  });

  test("policy accept --advisory activates a proved policy as advisory; --advisory with --blocking is refused", () => {
    refused(f, /choose exactly one of --advisory or --blocking/, "policy", "accept", policyId, "--advisory", "--blocking", "--actor", HUMAN);
    ok(f, "policy", "prove", policyId);
    commit(f, "chore: prove policy");
    const r = ok(f, "policy", "accept", policyId, "--advisory", "--actor", HUMAN);
    assert.match(r.stdout, new RegExp(`${policyId} is active_advisory by ${HUMAN}`));
    assert.equal(readRec<{ state: string }>(f, "policies", policyId).state, "active_advisory");
    commit(f, "chore: accept policy");
  });

  test("prove --public-only scopes the change proof memory to the public home", () => {
    const union = JSON.parse(ok(f, "prove", firstSha, "HEAD", "--json").stdout) as { memory: { scope: string } };
    const pub = JSON.parse(ok(f, "prove", firstSha, "HEAD", "--public-only", "--json").stdout) as { memory: { scope: string } };
    assert.equal(union.memory.scope, "union");
    assert.equal(pub.memory.scope, "public");
  });

  test("dna match --ref scores against the profile at that exact revision", () => {
    const head = JSON.parse(ok(f, "dna", "match", "--kind", "commit", "--title", "fix: x", "--json").stdout) as { repository_revision: string };
    assert.equal(head.repository_revision, git(f, "rev-parse", "HEAD"));
    const old = JSON.parse(ok(f, "dna", "match", "--kind", "commit", "--title", "fix: x", "--ref", firstSha, "--json").stdout) as { repository_revision: string };
    assert.equal(old.repository_revision, firstSha);
    refused(f, /Git revision .no-such-ref-xyz. does not name a commit/, "dna", "match", "--kind", "commit", "--title", "fix: x", "--ref", "no-such-ref-xyz");
  });

  test("constitution ingest --instructions adds committed instruction evidence; --max-events is validated", () => {
    refused(f, /--max-events must be a positive number/, "constitution", "ingest", "--max-events", "0");
    write(f, "AGENTS.md", "# Agents\n\nControllers must never call the database client directly; go through OrderService.\n");
    commit(f, "docs: agent instructions");
    const scanned = (r: Run) => Number(/scanned (\d+) record/.exec(r.stdout)?.[1] ?? NaN);
    const plain = ok(f, "constitution", "ingest", "--max-events", "5");
    const withInstr = ok(f, "constitution", "ingest", "--instructions", "--max-events", "5");
    assert.ok(scanned(withInstr) > scanned(plain), `--instructions must scan more:\n${plain.stdout}\n${withInstr.stdout}`);
    commit(f, "chore: ingest");
  });

  test("constitution bootstrap --history switches to the exact first-parent history bootstrap", () => {
    assert.match(ok(f, "constitution", "bootstrap").stdout, /^Constitution bootstrap: /m);
    commit(f, "chore: bootstrap");
    assert.match(ok(f, "constitution", "bootstrap", "--history").stdout, /^Constitution history bootstrap: /m);
    commit(f, "chore: history bootstrap");
  });

  test("constitution g2 action flags are validated before any private write", () => {
    const g2 = (pattern: RegExp, ...args: string[]) => refused(f, pattern, "constitution", "g2", ...args);
    g2(/choose only one G2/, "--plan", "plan.json", "--observe");
    g2(/choose only one G2/, "--backfill", "3", "--drill", "all");
    g2(/--drill must be all or one of/, "--drill", "bogus");
    g2(/--behavior-decision requires a behavior candidate/, "--behavior-decision", DEC);
    g2(/--behavior-candidates does not accept --behavior-review-hash/, "--behavior-candidates", "5", "--behavior-review-hash", "h");
    g2(/--behavior-replay requires --behavior-review-hash/, "--behavior-replay", "cand_x");
    g2(/--behavior-deps requires --behavior-review-hash/, "--behavior-deps", "cand_x", "--dependency-timeout-ms", "1000");
    g2(/--behavior-attest requires --disposition selected\|rejected/, "--behavior-attest", "cand_x", "--behavior-review-hash", "h");
    g2(/--behavior-policy-materialize accepts no human evidence/, "--behavior-policy-materialize", "--result", "passed");
    g2(/--rehearse requires --result passed\|failed/, "--rehearse", "rb_x");
    g2(/--rehearse requires --actor/, "--rehearse", "rb_x", "--result", "passed");
    g2(/--rehearse requires at least one --evidence/, "--rehearse", "rb_x", "--result", "passed", "--actor", HUMAN);
    g2(/--rehearse requires --notes/, "--rehearse", "rb_x", "--result", "passed", "--actor", HUMAN, "--evidence", "a".repeat(40));
    g2(/human evidence options require --rehearse/, "--supersedes", "rh_x");
    g2(/human evidence options require --rehearse/, "--notes", "n");
  });

  test("constitution g3 action flags are mutually exclusive", () => {
    const msg = /choose only one G3 preregistration, plan, proof review, or adapter-conformance action/;
    refused(f, msg, "constitution", "g3", "--plan", "plan.json", "--review", "review.json");
    refused(f, msg, "constitution", "g3", "--conformance", "--timeout-ms", "1000", "--experiment", "exp.json");
  });

  test("review-memory auto validates --limit, --private/--public/--dry-run and the --initiator binding before reading --from", () => {
    const out = join(f.sandbox, "report.json");
    const cfg = join(f.sandbox, "adapters.json");
    writeFileSync(cfg, "[]\n");
    writeFileSync(join(f.sandbox, "comments.json"), "[]\n");
    refused(f, /--limit must be 1\.\.100/, "review-memory", "auto", "--repository", "acme/app", "--dry-run", "--limit", "0");
    refused(f, /exactly one of --private or --public, or --dry-run/, "review-memory", "auto", "--repository", "acme/app", "--private", "--public");
    refused(f, /exactly one of --private or --public, or --dry-run/, "review-memory", "auto", "--repository", "acme/app");
    refused(f, /repository does not match this checkout's remotes/, "review-memory", "auto", "--repository", "acme/app", "--dry-run");
    git(f, "remote", "add", "origin", "https://github.com/acme/app.git");
    // Offline mode (HUNCH_SYNTH_PROVIDER=deterministic) never binds to an agent account.
    refused(f, /Initiating provider fake-agent is unavailable/, "review-memory", "auto", "--repository", "acme/app", "--dry-run",
      "--initiator", "fake-agent", "--cli-config", cfg, "--from", join(f.sandbox, "comments.json"), "--retry", "--output", out);
    assert.equal(existsSync(out), false, "a refused run writes no --output report");
  });

  test("record-constraint --enforcement and --match are persisted on the constraint", () => {
    const id = (r: Run) => /constraint (con_\w+)/.exec(r.stdout)?.[1] ?? "";
    const plain = readRec<{ enforcement: string; match: string | null }>(f, "constraints", id(ok(f, "record-constraint", "Orders API handlers stay small", "--scope", "src/api/**")));
    assert.equal(plain.enforcement, "advisory_v1");
    assert.equal(plain.match, null);
    const r = ok(f, "record-constraint", "Orders API handlers never call eval", "--scope", "src/api/**", "--enforcement", "ci", "--match", "eval\\(");
    const c = readRec<{ enforcement: string; match: string | null }>(f, "constraints", id(r));
    assert.equal(c.enforcement, "ci");
    assert.equal(c.match, "eval\\(");
    commit(f, "chore: constraints");
  });

  test("conform --add records --object --transitive --why --bug; transitive reach is caught and the receipt shows why and bug", () => {
    refused(f, /--object is required for --assert not-calls/, "conform", "--add", "x", "--assert", "not-calls", "--subject", "listOrders");
    const direct = ok(f, "conform", "--add", "listOrders never calls dbQuery directly", "--assert", "not-calls", "--subject", "listOrders", "--object", "dbQuery");
    const trans = ok(f, "conform", "--add", "listOrders never reaches dbQuery", "--assert", "not-calls", "--subject", "listOrders", "--object", "dbQuery",
      "--transitive", "--why", "handlers must stay storage-agnostic", "--bug", "bug_orders_n1");
    const idOf = (r: Run) => /invariant (dec_\w+)/.exec(r.stdout)?.[1] ?? "";
    const rec = readRec<Decision>(f, "decisions", idOf(trans));
    assert.deepEqual(rec.conformance[0], { assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: true });
    assert.equal(rec.context, "handlers must stay storage-agnostic");
    assert.equal(rec.caused_by_bug, "bug_orders_n1");
    assert.equal(readRec<Decision>(f, "decisions", idOf(direct)).conformance[0]!.transitive, false);
    const check = hunch(f, "conform").stdout;
    assert.match(check, new RegExp(`✅ ${idOf(direct)}`), check);
    assert.match(check, new RegExp(`⛔ ${idOf(trans)}`), check);
    assert.match(check, /↳ why: handlers must stay storage-agnostic/);
    assert.match(check, /↳ prevents recurrence of: bug_orders_n1/);
    commit(f, "chore: invariants");
  });

  test("review --min-grounded moves a Critic-verified draft between ready and scrutiny", () => {
    putJson(f, "decisions", decision(DRAFT, {
      title: "Cache order lists for a minute", topic: "orders.cache", status: "proposed", conformance: [],
      provenance: { source: "llm_draft+verified", confidence: 0.6, evidence: ["synth: provider=deterministic grounded=0.8"] },
    }));
    assert.match(ok(f, "review", "--min-grounded", "0.5").stdout, /1 ready to confirm — Critic-verified, grounded ≥ 0\.5/);
    const strict = ok(f, "review", "--min-grounded", "0.9").stdout;
    assert.doesNotMatch(strict, /ready to confirm/);
    assert.match(strict, /1 need scrutiny/);
    assert.match(ok(f, "review", "--accept-verified", "--min-grounded", "0.95").stdout, /No Critic-verified drafts at grounded ≥ 0\.95/);
  });
});
