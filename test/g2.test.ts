import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Runbook } from "../src/core/types.js";
import type { PolicySpec } from "../src/constitution/schema.js";
import { ConstitutionService } from "../src/constitution/service.js";
import {
  G2_RUNBOOK_CATEGORIES,
  compileG2Plan,
  compileRunbookRehearsal,
  currentG2Plans,
  currentRunbookRehearsals,
  scoreG2Readiness,
  type G2PolicyEvidence,
} from "../src/constitution/g2.js";

const NOW = "2026-07-11T10:00:00.000Z";
const POLICY_IDS = Array.from({ length: 10 }, (_, index) => `pol_${index.toString(16).padStart(10, "0")}`);
const RUNBOOKS = Object.fromEntries(
  G2_RUNBOOK_CATEGORIES.map((category, index) => [category, `rb_gate_${index}`]),
) as Record<(typeof G2_RUNBOOK_CATEGORIES)[number], string>;

function privateFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunch-g2-"));
  const privateRoot = join(root, "private-memory", ".hunch");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const service = new ConstitutionService(store, root);
  return { root, privateRoot, store, service, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function createTwoCommitHistory(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "g2-test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "G2 Test"], { cwd: root });
  const fixture = join(root, "fixture.txt");
  writeFileSync(fixture, "first\n");
  execFileSync("git", ["add", "fixture.txt"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "first fixture state"], { cwd: root });
  writeFileSync(fixture, "second\n");
  execFileSync("git", ["add", "fixture.txt"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "second fixture state"], { cwd: root });
}

function privatePolicy(id: string): PolicySpec {
  return {
    id,
    topic: `g2.${id}`,
    ir_version: 1,
    revision: 1,
    state: "compiled",
    statement: `G2 private policy ${id}`,
    rationale: "Dogfood candidate.",
    scope: { repos: [], paths: ["src/**"], components: [] },
    assertion: { kind: "exists", subject: { selector: `symbol:${id}` } },
    severity: "warning",
    surfaces: ["cli", "mcp"],
    authority: null,
    evidence: [],
    proof: null,
    reversal_conditions: [],
    supersedes: null,
    superseded_by: null,
    exception_of: null,
    valid_from: NOW,
    valid_to: null,
    data_class: "private",
    limitations: [],
    candidate: { alternatives: [], uncertainty: [], conflicts: [], incumbent: null, scope_suggestion: null, counterexamples: [] },
    legacy_refs: [],
    audit: [],
    created_at: NOW,
    updated_at: NOW,
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["private:g2-test"] },
  };
}

function privateRunbook(id: string, category: string): Runbook {
  return {
    id,
    task: `Recover from ${category}`,
    trigger: [category],
    steps: ["Detect the failure.", "Recover without enabling blocking behavior."],
    files: [],
    gotchas: [],
    outcome: "Recovery is demonstrated.",
    source_range: null,
    valid_from: NOW,
    valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["private:g2-test"] },
    date: NOW,
  };
}

test("G2 plan is private, human-selected, content-addressed, and append-only", () => {
  const first = compileG2Plan({
    policy_ids: POLICY_IDS,
    runbooks: RUNBOOKS,
    min_shadow_applicable: 20,
    actor: "human:release-owner",
    reason: "Select the exact dogfood evidence for G2.",
  }, { now: NOW });

  assert.match(first.id, /^g2plan_[a-f0-9]{10}$/);
  assert.match(first.content_hash, /^sha1:[a-f0-9]{40}$/);
  assert.equal(first.data_class, "private");
  assert.equal(first.authority, "none");
  assert.deepEqual(first.policy_ids, [...POLICY_IDS].sort());
  assert.deepEqual(currentG2Plans([first]), [first]);

  assert.throws(
    () => compileG2Plan({ ...first, policy_ids: POLICY_IDS.slice(0, 9) }, { now: NOW }),
    /at least 10/i,
  );
  assert.throws(
    () => compileG2Plan({
      policy_ids: POLICY_IDS,
      runbooks: { ...RUNBOOKS, adapter_break: RUNBOOKS.corrupt_graph },
      actor: "human:release-owner",
      reason: "Duplicate rehearsal target.",
    }, { now: NOW }),
    /unique runbook/i,
  );
  assert.throws(
    () => compileG2Plan({ policy_ids: POLICY_IDS, runbooks: RUNBOOKS, actor: "model:auto", reason: "No." }, { now: NOW }),
    /human actor/i,
  );

  const correction = compileG2Plan({
    policy_ids: POLICY_IDS,
    runbooks: RUNBOOKS,
    actor: "human:release-owner",
    reason: "Correct the selected evidence without rewriting history.",
    supersedes: first.id,
  }, { now: "2026-07-11T10:01:00.000Z" });
  assert.deepEqual(currentG2Plans([first, correction]), [correction]);
  const branch = compileG2Plan({
    policy_ids: [...POLICY_IDS].reverse(),
    runbooks: RUNBOOKS,
    min_shadow_applicable: 21,
    actor: "human:other-owner",
    reason: "Conflicting correction.",
    supersedes: first.id,
  }, { now: "2026-07-11T10:01:30.000Z" });
  assert.throws(
    () => currentG2Plans([first, correction, branch]),
    /branched supersession chain/i,
  );
});

test("runbook rehearsal binds the exact runbook content and corrections retract eligibility", () => {
  const passed = compileRunbookRehearsal({
    runbook_id: "rb_gate_0",
    runbook_hash: "sha1:" + "a".repeat(40),
    result: "passed",
    actor: "human:operator",
    evidence_hashes: ["sha1:" + "b".repeat(40)],
    notes: "Evaluator failure drill completed.",
  }, { now: NOW });
  assert.equal(passed.data_class, "private");
  assert.equal(passed.authority, "none");
  assert.deepEqual(currentRunbookRehearsals([passed]), [passed]);

  const failed = compileRunbookRehearsal({
    runbook_id: passed.runbook_id,
    runbook_hash: passed.runbook_hash,
    result: "failed",
    actor: "human:operator",
    evidence_hashes: ["sha1:" + "c".repeat(40)],
    notes: "Correction: recovery did not complete.",
    supersedes: passed.id,
  }, { now: "2026-07-11T10:02:00.000Z" });
  assert.deepEqual(currentRunbookRehearsals([passed, failed]), [failed]);
});

test("G2 scorer reports eligibility but never grants authority", () => {
  const manifest = compileG2Plan({
    policy_ids: POLICY_IDS,
    runbooks: RUNBOOKS,
    actor: "human:release-owner",
    reason: "Exact dogfood set.",
  }, { now: NOW });
  const policyEvidence: G2PolicyEvidence[] = POLICY_IDS.map((policy_id) => ({
    policy_id,
    complete: true,
    proof_id: `proof_${policy_id.slice(-10)}`,
    corpus_id: `corpus_${policy_id.slice(-10)}`,
    shadow_applicable: 20,
    shadow_violations: 2,
    shadow_unclassified: 0,
    confirmed_precision: 1,
    reasons: [],
  }));
  const runbookEvidence = G2_RUNBOOK_CATEGORIES.map((category) => ({
    category,
    runbook_id: RUNBOOKS[category],
    runbook_hash: "sha1:" + "d".repeat(40),
    rehearsal_id: `rehearsal_${category.slice(0, 10).padEnd(10, "0")}`,
    passed: true,
    reasons: [],
  }));

  const ready = scoreG2Readiness({ manifest, policy_evidence: policyEvidence, runbook_evidence: runbookEvidence, active_blocking_policy_ids: [] });
  assert.equal(ready.recommendation, "eligible_for_human_g2_signoff");
  assert.equal(ready.authority, "none");
  assert.equal(ready.g2_passed, false);

  const blocked = scoreG2Readiness({ ...ready, manifest, policy_evidence: policyEvidence, runbook_evidence: runbookEvidence, active_blocking_policy_ids: [POLICY_IDS[0]!] });
  assert.equal(blocked.recommendation, "not_ready");
  assert.match(blocked.blockers.join("\n"), /blocking behavior/i);
});

test("G2 service stores only exact private evidence and reports real blockers", () => {
  const { root, privateRoot, store, service, cleanup } = privateFixture();
  try {
    for (const id of POLICY_IDS) service.repository.putPolicy(privatePolicy(id), { private: true });
    for (const category of G2_RUNBOOK_CATEGORIES) store.putPrivate("runbooks", privateRunbook(RUNBOOKS[category], category));

    const publicCollision = join(root, ".hunch/policies", `${POLICY_IDS[0]}.json`);
    mkdirSync(join(root, ".hunch/policies"), { recursive: true });
    writeFileSync(publicCollision, JSON.stringify({ ...privatePolicy(POLICY_IDS[0]!), data_class: "public" }));
    assert.throws(
      () => service.createG2Plan({ policy_ids: POLICY_IDS, runbooks: RUNBOOKS, actor: "human:release-owner", reason: "Ambiguous home." }, { now: NOW }),
      /only in the configured private overlay/i,
    );
    rmSync(publicCollision);

    const plan = service.createG2Plan({
      policy_ids: POLICY_IDS,
      runbooks: RUNBOOKS,
      actor: "human:release-owner",
      reason: "Select the exact private dogfood packet.",
    }, { now: NOW });
    assert.ok(existsSync(join(privateRoot, "gates", `${plan.id}.json`)));
    assert.equal(existsSync(join(root, ".hunch/gates")), false, "private G2 plan never lands in the public source of truth");
    assert.equal(service.createG2Plan({ policy_ids: POLICY_IDS, runbooks: RUNBOOKS, actor: "human:release-owner", reason: "Select the exact private dogfood packet." }, { now: NOW }).id, plan.id, "exact retry is idempotent");
    assert.throws(
      () => service.createG2Plan({ policy_ids: POLICY_IDS, runbooks: RUNBOOKS, actor: "human:release-owner", reason: "Silent rewrite." }, { now: "2026-07-11T10:03:00.000Z" }),
      /pass supersedes/i,
    );

    const rehearsal = service.recordRunbookRehearsal(RUNBOOKS.evaluator_error, "passed", "human:operator", ["sha1:" + "e".repeat(40)], "Drill passed.", { now: NOW });
    assert.ok(existsSync(join(privateRoot, "rehearsals", `${rehearsal.id}.json`)));
    assert.equal(existsSync(join(root, ".hunch/rehearsals")), false, "private rehearsal never lands in the public source of truth");

    const report = service.g2Readiness();
    assert.equal(report.recommendation, "not_ready");
    assert.equal(report.authority, "none");
    assert.equal(report.g2_passed, false);
    assert.equal(report.policy_evidence.length, 10);
    assert.equal(report.runbook_evidence.length, 7);
    assert.match(report.blockers.join("\n"), /no current proof/i);
    assert.match(report.blockers.join("\n"), /no current rehearsal receipt/i);
    assert.equal(service.list().some((policy) => policy.state === "active_blocking"), false, "G2 evidence writes never activate policy authority");

    const file = join(privateRoot, "gates", `${plan.id}.json`);
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.reason = "tampered";
    writeFileSync(file, JSON.stringify(tampered));
    assert.throws(() => service.g2Readiness(), /content hash mismatch/i, "tampered private evidence fails closed");
  } finally {
    cleanup();
  }
});

test("G2 operational drills bind exact runbooks and historical backfill aborts atomically on preflight errors", async () => {
  const { root, privateRoot, store, cleanup } = privateFixture();
  let client: Client | null = null;
  try {
    const service = new ConstitutionService(store, process.cwd());
    for (const id of POLICY_IDS) service.repository.putPolicy(privatePolicy(id), { private: true });
    for (const category of G2_RUNBOOK_CATEGORIES) store.putPrivate("runbooks", privateRunbook(RUNBOOKS[category], category));
    const plan = service.createG2Plan({
      policy_ids: POLICY_IDS,
      runbooks: RUNBOOKS,
      actor: "human:release-owner",
      reason: "Bind exact operational drills.",
    }, { now: NOW });

    const drill = service.g2OperationalDrill("provider_outage");
    assert.equal(drill.plan_id, plan.id);
    assert.equal(drill.runbook_id, RUNBOOKS.provider_outage);
    assert.equal(drill.result, "passed");
    assert.equal(drill.selected_event, "passed");
    assert.equal(drill.authority, "none");
    assert.equal(drill.writes, "none");
    assert.equal(existsSync(join(privateRoot, "rehearsals")), false, "diagnostic drill never self-attests a rehearsal");

    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const cli = join(process.cwd(), "src/cli/index.ts");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, cli, "mcp"],
      cwd: process.cwd(),
      env: { ...process.env, HUNCH_PRIVATE_DIR: privateRoot },
    });
    client = new Client({ name: "g2-operational-drill-test", version: "1.0.0" });
    await client.connect(transport);
    const mcpCall = await client.callTool({ name: "hunch_constitution_g2_operational_drill", arguments: { category: "provider_outage" } });
    const mcpDrill = JSON.parse((mcpCall.content[0] as { type: "text"; text: string }).text) as typeof drill;
    assert.equal(mcpDrill.category, drill.category);
    assert.equal(mcpDrill.plan_id, drill.plan_id);
    assert.equal(mcpDrill.runbook_hash, drill.runbook_hash);
    assert.equal(mcpDrill.result, "passed");
    assert.equal(mcpDrill.writes, "none");
    await client.close();
    client = null;

    createTwoCommitHistory(root);
    const backfillService = new ConstitutionService(store, root);
    const backfill = backfillService.g2ShadowBackfill(2, { now: NOW });
    assert.equal(backfill.plan_id, plan.id);
    assert.equal(backfill.commits.length, 2);
    assert.equal(backfill.attempted, 20);
    assert.equal(backfill.preflight_failures.length, 20, "every unproved policy fails before any write");
    assert.equal(backfill.recorded.length, 0);
    assert.equal(backfill.writes, "none");
    assert.match(backfill.skipped_reason ?? "", /preflight.*wrote nothing/i);
    assert.equal(existsSync(join(privateRoot, "shadow")), false, "failed backfill is atomic across the whole policy/commit matrix");
    assert.throws(() => backfillService.g2ShadowBackfill(0), /positive integer/i);
  } finally {
    if (client) await client.close();
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
