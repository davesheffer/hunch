import { cleanupDir, isolatedCliEnv } from "./fixtures.js";
/**
 * Cross-area integration: each test drives one import edge between source areas from a
 * public entry (CLI spawn or `hunch serve` over HTTP) and asserts the downstream effect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Constraint, Decision } from "../src/core/types.js";
import { canonicalHash } from "../src/constitution/canonical.js";
import { createServeApp } from "../src/serve/app.js";
import { initServeConfig, readServeConfig } from "../src/serve/config.js";
import { createStateClient } from "../src/client/state.js";
import { stateHash } from "../src/core/stateContract.js";
import { hunchCliArgs } from "./cli-invocation.js";

const NOW = "2026-07-10T10:00:00.000Z";

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, hunchCliArgs(...args), { cwd: root, encoding: "utf8", env: { ...isolatedCliEnv(), HUNCH_LEAN_GROUNDING: "0" }, timeout: 120_000 });
  // ^ full grounding block: these journeys assert the policy-tool and wiki lines, which the lean default omits.
}

function repo(): { root: string; git: (...a: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-xarea-"));
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
  git("init", "-q");
  git("config", "maintenance.auto", "false");
  git("config", "gc.auto", "0");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test Human");
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(join(root, "src/services"), { recursive: true });
  mkdirSync(join(root, "src/db"), { recursive: true });
  writeFileSync(join(root, "src/db/client.ts"), "export function dbQuery(sql){ return sql; }\n");
  writeFileSync(join(root, "src/services/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u){ return dbQuery(u); }\n');
  writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
  writeFileSync(join(root, "CLAUDE.md"), "# fixture\n\nUser prose stays.\n");
  git("add", "-A");
  git("commit", "-qm", "fixture: layered orders");
  return { root, git };
}

/** Seed records through the store, then close it so the spawned CLI owns the files. */
function seed(root: string, fn: (store: HunchStore) => void): void {
  const store = new HunchStore(hunchPaths(root));
  try { store.json.ensureDirs(); fn(store); } finally { store.close(); }
}

function decision(id: string): Decision {
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
  };
}

function blockingConstraint(id: string): Constraint {
  return {
    id, type: "correctness", statement: "API handlers must never touch the orders ledger directly", scope: ["src/api/**"],
    severity: "blocking", enforcement: "advisory_v1", match: null, forbids: null, rationale: "", source_decision: null,
    violations: [], status: "active", valid_from: NOW, valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-1"] },
  };
}

test("serve->integrations: a served write flushes through integrations/sync into a git commit of the partition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-xarea-serve-"));
  try {
    const file = join(dir, "hunch-serve.json");
    const root = join(dir, "david");
    const david = { kind: "user" as const, id: "david" };
    const init = initServeConfig({ file, scope: david, root, principal: { id: "sofia@david", kind: "agent" } });
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "test"]);
    const app = createServeApp(readServeConfig(file), { version: "test" });
    try {
      await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
      const address = app.address();
      const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const client = createStateClient({ baseUrl: base, token: init.token! });
      const receipt = {
        schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment",
        target: { system: "crm", object_type: "event", object_key: "1", observed_at: NOW },
        request_fingerprint: stateHash({ x: 1 }), state: "verified", occurred_at: NOW,
        provenance: { source: "imported:test", confidence: 0.9, evidence: ["row 1"] }, invalidates: [],
      };
      const created = await client.write({ scope: david, facet: "receipts", record: receipt, idempotency_key: "xarea-serve-1" });
      assert.equal(created.outcome, "created");
      assert.equal(created.durability, "committed");
      const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--", ".hunch/receipts"], { encoding: "utf8" });
      assert.equal(status.trim(), "", "the flushed record is committed, not left dirty");
      const log = execFileSync("git", ["-C", root, "log", "--format=%s", "--name-only"], { encoding: "utf8" });
      assert.match(log, /\.hunch\/receipts\/nrc_[a-f0-9]+\.json/);
    } finally { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); }
  } finally { cleanupDir(dir); }
});

test("integrations->constitution: a compiled policy appears in the regenerated CLAUDE.md grounding block", () => {
  const { root } = repo();
  try {
    seed(root, (store) => { store.json.put("decisions", decision("dec_xarea_policy")); });
    const before = cli(root, "grounding", "--refresh", "--quiet");
    assert.equal(before.status, 0, before.stderr);
    const without = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.doesNotMatch(without, /hunch_policy_evaluate/, "no policy yet: policy tools are not advertised");
    const compiled = cli(root, "policy", "compile", "dec_xarea_policy", "--through", "fetchOrders");
    assert.equal(compiled.status, 0, compiled.stderr + compiled.stdout);
    assert.match(compiled.stdout, /compiled pol_/);
    const after = cli(root, "grounding", "--refresh", "--quiet");
    assert.equal(after.status, 0, after.stderr);
    const doc = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.match(doc, /1 polic(y|ies)/, "the policy count from constitution/PolicyRepository is rendered");
    assert.match(doc, /hunch_policy_evaluate/, "policy tools are advertised once a policy exists");
    assert.match(doc, /User prose stays\./, "user prose around the managed block is preserved");
  } finally { cleanupDir(root); }
});

test("integrations->wiki: a generated wiki manifest is summarized in the regenerated grounding block", () => {
  const { root } = repo();
  try {
    const indexed = cli(root, "index");
    assert.equal(indexed.status, 0, indexed.stderr);
    const wiki = cli(root, "wiki", "--no-llm");
    assert.equal(wiki.status, 0, wiki.stderr + wiki.stdout);
    const manifest = JSON.parse(readFileSync(join(root, ".hunch", "wiki-manifest.json"), "utf8")) as { dir: string; pages: Record<string, unknown> };
    const pages = Object.keys(manifest.pages).length;
    assert.ok(pages > 0, "the wiki wrote at least one page");
    const refreshed = cli(root, "grounding", "--refresh", "--quiet");
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const doc = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.ok(doc.includes(`Component wiki: \`${manifest.dir}/\` (${pages} page(s))`), doc);
  } finally { cleanupDir(root); }
});

test("core->constitution: review-memory prepare hashes evidence canonically and capture --apply persists the rule", () => {
  const { root, git } = repo();
  try {
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    const comment = {
      id: 101, body: "Do not call dbQuery from controllers; go through the service.", path: "src/api/orders.ts",
      html_url: "https://github.com/acme/widgets/pull/7#discussion_r101", commit_id: "a".repeat(40),
      created_at: NOW, updated_at: NOW, user: { login: "reviewer", type: "User" },
    };
    const bot = { ...comment, id: 102, html_url: "https://github.com/acme/widgets/pull/7#discussion_r102", user: { login: "ci-bot", type: "Bot" } };
    const work = mkdtempSync(join(tmpdir(), "hunch-xarea-review-"));
    try {
      writeFileSync(join(work, "comments.json"), JSON.stringify([comment, bot]));
      const prepared = cli(root, "review-memory", "prepare", "--from", join(work, "comments.json"), "--repository", "acme/widgets");
      assert.equal(prepared.status, 0, prepared.stderr);
      const packet = JSON.parse(prepared.stdout) as { candidates: { id: string; evidence_hash: string }[]; excluded_bots: number };
      assert.equal(packet.excluded_bots, 1);
      assert.equal(packet.candidates.length, 1);
      assert.equal(packet.candidates[0]!.evidence_hash, canonicalHash({ repository: "acme/widgets", comments: [comment] }), "evidence hash is the constitution canonical hash");
      writeFileSync(join(work, "packet.json"), prepared.stdout);
      writeFileSync(join(work, "rules.json"), JSON.stringify([{ candidate_id: "review_101", evidence_hash: packet.candidates[0]!.evidence_hash, rule: "Controllers must not call dbQuery directly.", check: "listOrders reaches persistence only via fetchOrders." }]));

      const tampered = { ...JSON.parse(prepared.stdout), candidates: [{ ...packet.candidates[0], evidence_hash: "0".repeat(64) }] };
      writeFileSync(join(work, "tampered.json"), JSON.stringify(tampered));
      const refused = cli(root, "review-memory", "capture", "--from", join(work, "tampered.json"), "--rules", join(work, "rules.json"));
      assert.notEqual(refused.status, 0, "a packet whose hash no longer matches is refused");
      assert.match(refused.stderr, /evidence hash or membership changed/);

      const applied = cli(root, "review-memory", "capture", "--from", join(work, "packet.json"), "--rules", join(work, "rules.json"), "--apply", "--public");
      assert.equal(applied.status, 0, applied.stderr + applied.stdout);
      const out = JSON.parse(applied.stdout) as { applied: boolean; rules: Constraint[] };
      assert.equal(out.applied, true);
      const id = out.rules[0]!.id;
      const files = readdirSync(join(root, ".hunch", "constraints"));
      assert.ok(files.includes(`${id}.json`), `constraint ${id} persisted in the public store`);
    } finally { cleanupDir(work); }
  } finally { cleanupDir(root); }
});

test("cli->eval / eval->core: `hunch eval --guards` scores cases through the real check verdict", () => {
  const { root } = repo();
  try {
    seed(root, (store) => { store.json.put("constraints", blockingConstraint("con_xarea_guard")); });
    const cases = [
      { name: "touches guarded api", files: ["src/api/orders.ts"], expect: "catch" },
      { name: "unrelated db edit", files: ["src/db/client.ts"], expect: "pass" },
    ];
    writeFileSync(join(root, "guards.json"), JSON.stringify(cases));
    const run = cli(root, "eval", "--guards", "--file", join(root, "guards.json"));
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /Guard eval over 2 case\(s\)/);
    assert.match(run.stdout, /CAUGHT\s+1\/1/);
    assert.match(run.stdout, /FALSE-POSITIVE\s+0\/1/);
    assert.match(run.stdout, /every case matched/);
  } finally { cleanupDir(root); }
});

test("cli->eval / eval->store: `hunch eval` retrieval finds the seeded decision through the store index", () => {
  const { root } = repo();
  try {
    seed(root, (store) => { store.json.put("decisions", decision("dec_xarea_retrieval")); });
    writeFileSync(join(root, "golden.json"), JSON.stringify([{ query: "controller persistence service boundary", expected: ["dec_xarea_retrieval"] }]));
    const run = cli(root, "eval", "--file", join(root, "golden.json"), "--k", "5");
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /Eval over 1 case\(s\), k=5 \(FTS \+ graph\)/);
    assert.match(run.stdout, /graph OFF\s+100\.0%/);
    assert.doesNotMatch(run.stdout, /no expected hit/);
  } finally { cleanupDir(root); }
});
