import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import type { Decision } from "../src/core/types.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { canonicalJson, policySemanticHash } from "../src/constitution/canonical.js";
import { approvePolicy } from "../src/constitution/lifecycle.js";
import { movePolicyArtifactsToPrivate } from "../src/constitution/repository.js";
import { evaluatePolicyOnSnapshot, graphSnapshot, mutateSnapshotForPolicy } from "../src/constitution/evaluator.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const NOW = "2026-07-10T10:00:00.000Z";

function decision(id: string, opts: { private?: boolean } = {}): Decision {
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
    provenance: { source: "human_confirmed", confidence: 1, evidence: [opts.private ? "private-review" : "review-431"] },
    date: NOW,
  };
}

function layeredRepo(apiBody = 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n') {
  const root = execFileSync("mktemp", ["-d", join(tmpdir(), "hunch-constitution-XXXXXX")], { encoding: "utf8" }).trim();
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test Human");
  mkdirSync(join(root, "src/api"), { recursive: true });
  mkdirSync(join(root, "src/services"), { recursive: true });
  mkdirSync(join(root, "src/db"), { recursive: true });
  writeFileSync(join(root, "src/db/client.ts"), "export function dbQuery(sql){ return sql; }\n");
  writeFileSync(join(root, "src/services/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function fetchOrders(u){ return dbQuery(u); }\n');
  writeFileSync(join(root, "src/api/orders.ts"), apiBody);
  git("add", "-A");
  git("commit", "-qm", "fixture: layered orders");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  indexRepo(store, root, { churn: false });
  store.reindex();
  return { root, store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Gate G1: decision -> must-pass-through policy -> P3 proof -> human block -> demotion", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_layer"));
    store.reindex();
    const service = new ConstitutionService(store, root);

    const compiled = service.compile("dec_layer", { through: "fetchOrders", now: NOW });
    assert.equal(compiled.state, "compiled");
    assert.equal(compiled.assertion.kind, "must-pass-through");
    assert.equal(compiled.authority, null, "compiler has no authority");
    assert.ok(existsSync(join(root, ".hunch/policies", `${compiled.id}.json`)), "Policy IR is Git-native JSON");

    const before = service.evaluate({ id: compiled.id })[0]!;
    assert.equal(before.evaluation.result, "satisfied");
    assert.equal(before.blocks, false, "compiled candidate cannot block");
    assert.equal(service.evaluate({ id: compiled.id })[0]!.evaluation.deterministic_hash, before.evaluation.deterministic_hash, "same graph yields byte-stable receipt hash");

    const proved = service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
    assert.equal(proved.proof.proof_class, "P3", "clean baseline + caught bypass mutation earns P3");
    assert.equal(proved.proof.current.satisfied, 1);
    assert.equal(proved.proof.mutations.violated, 1);
    assert.equal(proved.policy.state, "proposed");

    assert.throws(
      () => service.approve(compiled.id, "blocking", "machine:agent", { now: "2026-07-10T10:02:00.000Z" }),
      /human actor/,
      "machine/model identity cannot activate policy",
    );
    const active = service.approve(compiled.id, "blocking", "human:test-owner", { now: "2026-07-10T10:02:00.000Z" });
    assert.equal(active.state, "active_blocking");
    assert.equal(active.authority?.kind, "human");
    assert.equal(service.evaluate({ id: active.id })[0]!.blocks, false, "valid architecture passes");

    writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
    indexRepo(store, root, { churn: false });
    store.reindex();
    const violated = service.evaluate({ id: active.id })[0]!;
    assert.equal(violated.evaluation.result, "violated");
    assert.equal(violated.blocks, true, "only active+blocking+human policy blocks");
    assert.match(violated.evaluation.explanation, /without passing through/);

    const demoted = service.demote(active.id, "human:test-owner", "Refactor exception under review.", { now: "2026-07-10T10:03:00.000Z" });
    assert.equal(demoted.state, "active_advisory");
    assert.equal(service.evaluate({ id: active.id })[0]!.blocks, false, "demotion restores advisory behavior without deleting history");
    assert.deepEqual(demoted.audit.map((e) => e.action), ["compiled", "proved", "approved_blocking", "demoted"]);
  } finally {
    cleanup();
  }
});

test("ambiguous selector is unknown and never blocks", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/other"), { recursive: true });
    writeFileSync(join(root, "src/other/client.ts"), "export function dbQuery(sql){ return sql; }\n");
    execFileSync("git", ["add", "src/other/client.ts"], { cwd: root, stdio: "ignore" });
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", decision("dec_ambiguous"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const compiled = service.compile("dec_ambiguous", { through: "fetchOrders", now: NOW });
    const evaluation = service.evaluate({ id: compiled.id })[0]!;
    assert.equal(evaluation.evaluation.result, "unknown");
    assert.equal(evaluation.blocks, false);
    assert.match(evaluation.evaluation.explanation, /ambiguous/);
  } finally {
    cleanup();
  }
});

test("neutral result algebra keeps not_applicable, unknown, and error distinct", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_algebra"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const policy = service.compile("dec_algebra", { through: "fetchOrders", now: NOW });
    const snapshot = graphSnapshot(store, root);
    assert.equal(evaluatePolicyOnSnapshot(policy, snapshot).result, "satisfied");

    const notApplicable = { ...policy, scope: { ...policy.scope, repos: ["another/repository"] } };
    assert.equal(evaluatePolicyOnSnapshot(notApplicable, snapshot).result, "not_applicable");

    const assertion = policy.assertion;
    assert.equal(assertion.kind, "must-pass-through");
    if (assertion.kind !== "must-pass-through") throw new Error("fixture compiler did not produce must-pass-through");
    const unknown = { ...policy, assertion: { ...assertion, object: { selector: "symbol:missingDb" } } };
    assert.equal(evaluatePolicyOnSnapshot(unknown, snapshot).result, "unknown");

    const invalid = { ...policy, assertion: { ...assertion, via: assertion.subject } };
    assert.equal(evaluatePolicyOnSnapshot(invalid, snapshot).result, "error");

    const mutation = mutateSnapshotForPolicy(policy, snapshot);
    assert.ok(mutation);
    assert.equal(evaluatePolicyOnSnapshot(policy, mutation.snapshot).result, "violated");
  } finally {
    cleanup();
  }
});

test("proof is bound to policy semantics and cannot authorize a changed assertion", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_hash"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const compiled = service.compile("dec_hash", { through: "fetchOrders", now: NOW });
    const { policy, proof } = service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
    const changed = { ...policy, assertion: { ...policy.assertion, via: { selector: "symbol:otherService" } } } as typeof policy;
    assert.notEqual(policySemanticHash(changed), proof.policy_hash);
    assert.throws(() => approvePolicy(changed, proof, "blocking", "human:test", "2026-07-10T10:02:00.000Z"), /does not match/);
  } finally {
    cleanup();
  }
});

test("a hand-edited blocking state without its P3 proof fails safe and cannot authorize a block", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_tamper"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const compiled = service.compile("dec_tamper", { through: "fetchOrders", now: NOW });
    service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
    const active = service.approve(compiled.id, "blocking", "human:test", { now: "2026-07-10T10:02:00.000Z" });
    service.repository.putPolicy({ ...active, proof: null });
    const result = service.evaluate({ id: active.id })[0]!;
    assert.equal(result.blocks, false);
    assert.equal(result.strict_error, true);
    assert.match(result.gate_error ?? "", /no readable proof/);
  } finally {
    cleanup();
  }
});

test("corrupt policy JSON is a visible error, never a skipped false pass", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, ".hunch/policies"), { recursive: true });
    writeFileSync(join(root, ".hunch/policies/pol_bad.json"), "{ not json");
    const service = new ConstitutionService(store, root);
    assert.throws(() => service.list(), /invalid policies\/pol_bad\.json/);
    assert.throws(() => service.evaluate({ activeOnly: true }), /invalid policies\/pol_bad\.json/);
  } finally {
    cleanup();
  }
});

test("private evidence produces private policy/proof and public-only evaluation leaks no identifier", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-overlay/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putPrivate("decisions", decision("dec_private", { private: true }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const policy = service.compile("dec_private", { through: "fetchOrders", now: NOW });
    assert.equal(policy.data_class, "private");
    assert.ok(existsSync(join(privateRoot, "policies", `${policy.id}.json`)));
    const proved = service.prove(policy.id, { now: "2026-07-10T10:01:00.000Z" });
    assert.ok(existsSync(join(privateRoot, "proofs", `${proved.proof.id}.json`)));
    assert.equal(service.list({ publicOnly: true }).some((p) => p.id === policy.id), false);
    assert.deepEqual(service.evaluate({ activeOnly: false, publicOnly: true }), []);
    assert.doesNotMatch(canonicalJson(service.list({ publicOnly: true })), new RegExp(policy.id));
  } finally {
    store.close();
    cleanup();
  }
});

test("private migration moves policy/proof artifacts only after validation", () => {
  const root = execFileSync("mktemp", ["-d", join(tmpdir(), "hunch-policy-migrate-XXXXXX")], { encoding: "utf8" }).trim();
  const privateHome = join(root, "private/.hunch");
  const publicHome = join(root, ".hunch");
  try {
    const fixture = layeredRepo();
    try {
      fixture.store.json.put("decisions", decision("dec_migrate"));
      fixture.store.reindex();
      const service = new ConstitutionService(fixture.store, fixture.root);
      const compiled = service.compile("dec_migrate", { through: "fetchOrders", now: NOW });
      const proved = service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
      mkdirSync(join(publicHome, "policies"), { recursive: true });
      mkdirSync(join(publicHome, "proofs"), { recursive: true });
      writeFileSync(join(publicHome, "policies", `${compiled.id}.json`), readFileSync(join(fixture.root, ".hunch/policies", `${compiled.id}.json`)));
      writeFileSync(join(publicHome, "proofs", `${proved.proof.id}.json`), readFileSync(join(fixture.root, ".hunch/proofs", `${proved.proof.id}.json`)));
    } finally {
      fixture.cleanup();
    }
    const moved = movePolicyArtifactsToPrivate(publicHome, privateHome);
    assert.deepEqual(moved, { policies: 1, proofs: 1 });
    assert.equal(existsSync(join(publicHome, "policies")), false);
    assert.ok(existsSync(join(privateHome, "policies")));
    assert.ok(existsSync(join(privateHome, "proofs")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private migration preserves the public source when any policy artifact is invalid", () => {
  const root = execFileSync("mktemp", ["-d", join(tmpdir(), "hunch-policy-invalid-XXXXXX")], { encoding: "utf8" }).trim();
  const privateHome = join(root, "private/.hunch");
  const publicHome = join(root, ".hunch");
  try {
    mkdirSync(join(publicHome, "policies"), { recursive: true });
    const corrupt = join(publicHome, "policies/pol_corrupt.json");
    writeFileSync(corrupt, "{ corrupt");
    assert.throws(() => movePolicyArtifactsToPrivate(publicHome, privateHome), /invalid policies/);
    assert.equal(readFileSync(corrupt, "utf8"), "{ corrupt", "source survives a refused migration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gate G1 adapter contract: CLI, MCP, and strict CI expose the identical receipt", async () => {
  const fixture = layeredRepo();
  const projectRoot = process.cwd();
  const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
  const cli = join(projectRoot, "src/cli/index.ts");
  let client: Client | null = null;
  try {
    fixture.store.json.put("decisions", decision("dec_adapter"));
    fixture.store.reindex();
    const service = new ConstitutionService(fixture.store, fixture.root);
    const compiled = service.compile("dec_adapter", { through: "fetchOrders", now: NOW });
    service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
    service.approve(compiled.id, "blocking", "human:adapter-owner", { now: "2026-07-10T10:02:00.000Z" });
    fixture.store.close();

    writeFileSync(join(fixture.root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
    const env = { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" };

    const cliRun = spawnSync(process.execPath, [tsx, cli, "policy", "evaluate", "--active", "--public-only", "--json"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliReceipts = JSON.parse(cliRun.stdout) as Array<{ deterministic_hash: string; result: string }>;
    assert.equal(cliReceipts[0]?.result, "violated");
    const receipt = cliReceipts[0]!.deterministic_hash;

    const ciRun = spawnSync(process.execPath, [tsx, cli, "check", "--working", "--strict", "--public-only"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(ciRun.status, 1, "strict CI blocks the authorized violation");
    assert.match(ciRun.stdout, new RegExp(receipt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: fixture.root, env });
    client = new Client({ name: "constitution-contract-test", version: "1.0.0" });
    await client.connect(transport);
    const mcp = await client.callTool({ name: "hunch_policy_evaluate", arguments: { policy_id: compiled.id, public_only: true } });
    const text = (mcp.content[0] as { type: "text"; text: string }).text;
    const mcpReceipts = JSON.parse(text) as Array<{ deterministic_hash: string; result: string }>;
    assert.equal(mcpReceipts[0]?.result, "violated");
    assert.equal(mcpReceipts[0]?.deterministic_hash, receipt, "all three surfaces share one canonical evaluator receipt");
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});
