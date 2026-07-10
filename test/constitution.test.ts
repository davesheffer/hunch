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
import { clampCandidateLimit } from "../src/constitution/bootstrap.js";
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

function commitFiles(root: string, files: string[], message: string): string {
  execFileSync("git", ["add", "--", ...files], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", message], { cwd: root, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function historyDecision(id: string, commit: string, overrides: Partial<Decision> = {}): Decision {
  const { conformance: _conformance, ...base } = decision(id);
  return {
    ...base,
    title: "charge must call verifySession",
    context: "The charge path skipped verifySession and reopened the session-bypass bug.",
    decision: "Keep the exact charge -> verifySession call in the static graph.",
    commit,
    caused_by_bug: "bug_session_bypass",
    related_files: ["src/payments/charge.ts"],
    ...overrides,
  };
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
    assert.equal(service.compile("dec_layer", { through: "fetchOrders", now: NOW }).state, "proposed", "recompile preserves incumbent lifecycle state");

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
    assert.deepEqual(moved, { policies: 1, proofs: 1, evidence: 0 });
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

test("Phase 2A bootstrap deterministically caps the open review queue at three and is idempotent", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    for (let i = 1; i <= 4; i++) {
      store.json.put("decisions", {
        ...decision(`dec_boot_${i}`),
        title: `Boundary decision ${i}`,
        date: `2026-07-0${i}T10:00:00.000Z`,
        valid_from: `2026-07-0${i}T10:00:00.000Z`,
      });
    }
    store.json.put("decisions", { ...decision("dec_ignored"), status: "proposed" });
    store.reindex();
    const service = new ConstitutionService(store, root);
    const first = service.bootstrap({ maxCandidates: 99, since: "90d", publicOnly: true, now: "2026-07-10T12:00:00.000Z" });
    assert.equal(clampCandidateLimit(99), 3);
    assert.equal(first.scanned, 5);
    assert.equal(first.eligible, 4);
    assert.equal(first.compiled.length, 3, "hard maximum is three even when caller asks for 99");
    assert.equal(first.deferred, 1);
    assert.ok(first.compiled.every((c) => c.policy.state === "compiled" && c.policy.authority === null));
    assert.deepEqual(first.compiled.map((c) => c.policy.statement), ["Boundary decision 4", "Boundary decision 3", "Boundary decision 2"], "newest attributable evidence wins deterministically");
    assert.equal(service.repository.listEvidence({ publicOnly: true }).length, 4, "eligible evidence is normalized even when candidate is deferred");

    const policyIds = service.list({ publicOnly: true }).map((p) => p.id).sort();
    const eventJson = canonicalJson(service.repository.listEvidence({ publicOnly: true }));
    const second = service.bootstrap({ maxCandidates: 3, since: "90d", publicOnly: true, now: "2026-07-10T12:00:00.000Z" });
    assert.equal(second.compiled.length, 0, "three open candidates consume the bounded review queue");
    assert.equal(second.covered, 3);
    assert.equal(second.deferred, 1);
    assert.deepEqual(service.list({ publicOnly: true }).map((p) => p.id).sort(), policyIds, "rerun creates no duplicate/downgrade");
    assert.equal(canonicalJson(service.repository.listEvidence({ publicOnly: true })), eventJson, "rerun leaves evidence byte-semantics stable");

    const retired = first.compiled[0]!.policy;
    service.repository.putPolicy({
      ...retired,
      state: "retired",
      updated_at: "2026-07-10T12:01:00.000Z",
      audit: [...retired.audit, {
        action: "retired",
        actor_kind: "human",
        actor: "human:test-owner",
        at: "2026-07-10T12:01:00.000Z",
        reason: "Close one review slot for the recovery-path test.",
        proof: null,
      }],
    });
    const recovered = service.bootstrap({ maxCandidates: 3, since: "90d", publicOnly: true, now: "2026-07-10T12:02:00.000Z" });
    assert.equal(recovered.compiled.length, 1, "a deferred eligible event compiles when a bounded review slot opens");
    assert.equal(recovered.compiled[0]!.policy.statement, "Boundary decision 1");
    assert.equal(recovered.compiled[0]!.evidence.compiler?.status, "compiled");
    assert.equal(service.get(retired.id, { publicOnly: true }).state, "retired", "bootstrap preserves closed lifecycle state");
  } finally {
    cleanup();
  }
});

test("Phase 2A bootstrap inherits private taint and public-only reads reveal nothing", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-bootstrap/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putPrivate("decisions", decision("dec_private_bootstrap", { private: true }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.bootstrap({ privateOnly: true, maxCandidates: 3, since: "90d", now: "2026-07-10T12:00:00.000Z" });
    assert.equal(report.compiled.length, 1);
    const candidate = report.compiled[0]!;
    assert.equal(candidate.policy.data_class, "private");
    assert.equal(candidate.evidence.data_class, "private");
    assert.ok(existsSync(join(privateRoot, "evidence", `${candidate.evidence.id}.json`)));
    assert.ok(existsSync(join(privateRoot, "policies", `${candidate.policy.id}.json`)));
    assert.equal(service.repository.listEvidence({ publicOnly: true }).length, 0);
    assert.equal(service.list({ publicOnly: true }).length, 0);
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2A home selection cannot substitute a same-id private decision into public bootstrap", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-collision/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.json.put("decisions", { ...decision("dec_collision"), title: "PUBLIC boundary evidence" });
    store.putPrivate("decisions", { ...decision("dec_collision", { private: true }), title: "PRIVATE SECRET boundary evidence" });
    store.reindex();
    const service = new ConstitutionService(store, root);

    const publicReport = service.bootstrap({ publicOnly: true, since: "90d", now: "2026-07-10T12:00:00.000Z" });
    assert.equal(publicReport.compiled.length, 1);
    assert.equal(publicReport.compiled[0]!.policy.statement, "PUBLIC boundary evidence");
    assert.equal(publicReport.compiled[0]!.policy.data_class, "public");
    assert.doesNotMatch(readFileSync(join(root, ".hunch/policies", `${publicReport.compiled[0]!.policy.id}.json`), "utf8"), /PRIVATE SECRET/);

    const privateReport = service.bootstrap({ privateOnly: true, since: "90d", now: "2026-07-10T12:00:00.000Z" });
    assert.equal(privateReport.compiled.length, 1, "private review queue is independent of the public home");
    assert.equal(privateReport.compiled[0]!.policy.statement, "PRIVATE SECRET boundary evidence");
    assert.equal(privateReport.compiled[0]!.policy.data_class, "private");
    const direct = service.compile("dec_collision", { private: false, now: "2026-07-10T12:00:00.000Z" });
    assert.equal(direct.statement, "PRIVATE SECRET boundary evidence", "direct compilation resolves the tainted source and its exact private home");
    assert.equal(direct.data_class, "private");
    assert.doesNotMatch(canonicalJson(service.list({ publicOnly: true })), /PRIVATE SECRET/);
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2A bootstrap rejects invalid windows and has no synthesis dependency", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_window"));
    const service = new ConstitutionService(store, root);
    assert.throws(() => service.bootstrap({ since: "forever", now: "2026-07-10T12:00:00.000Z" }), /--since/);
    for (const file of ["bootstrap.ts", "structural.ts", "delta.ts"]) {
      const source = readFileSync(join(process.cwd(), "src/constitution", file), "utf8");
      assert.doesNotMatch(source, /synthesis\/|selectProvider|SynthesisProvider/, `${file} has no model/provider dependency`);
    }
  } finally {
    cleanup();
  }
});

test("Phase 2B history bootstrap compiles one exact added call, deduplicates semantics, and is idempotent", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/auth"), { recursive: true });
    mkdirSync(join(root, "src/payments"), { recursive: true });
    writeFileSync(join(root, "src/auth/session.ts"), "export function verifySession(){ return true; }\n");
    writeFileSync(join(root, "src/payments/charge.ts"), "export function charge(){ return true; }\n");
    commitFiles(root, ["src/auth/session.ts", "src/payments/charge.ts"], "fixture: add payment baseline");
    writeFileSync(join(root, "src/payments/charge.ts"), 'import { verifySession } from "../auth/session.js";\nexport function charge(){ return verifySession(); }\n');
    const fix = commitFiles(root, ["src/payments/charge.ts"], "fix: restore required session validation");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_a", fix));
    store.json.put("decisions", historyDecision("dec_history_b", fix, { title: "Equivalent wording must not duplicate policy semantics" }));
    store.reindex();
    const service = new ConstitutionService(store, root);

    const inspection = service.inspectStructural("dec_history_a", { publicOnly: true });
    assert.equal(inspection.kind, "bug_fix");
    assert.equal(inspection.delta.calls.added.length, 1);
    assert.equal(inspection.delta.calls.removed.length, 0);
    assert.equal(inspection.candidates.length, 1);
    assert.equal(inspection.candidates[0]!.assertion.kind, "reaches");
    assert.ok(inspection.unsupported.some((r) => r.includes("awaits an import assertion evaluator")), "unsupported import fact stays visible");

    const sourceBefore = readFileSync(join(root, "src/payments/charge.ts"), "utf8");
    const first = service.bootstrap({ history: true, publicOnly: true, since: "90d", maxCandidates: 3, now: "2026-07-11T12:00:00.000Z" });
    assert.equal(first.eligible, 2);
    assert.equal(first.compiled.length, 1);
    assert.equal(first.covered, 1, "equivalent assertion+scope from a second judgment enriches evidence, not the queue");
    const policy = first.compiled[0]!.policy;
    assert.equal(policy.assertion.kind, "reaches");
    assert.deepEqual(policy.scope.paths, ["src/payments/charge.ts"]);
    assert.equal(policy.state, "compiled");
    assert.equal(policy.authority, null);
    assert.equal(first.compiled[0]!.evidence.structural_delta?.after_commit, fix);
    assert.equal(readFileSync(join(root, "src/payments/charge.ts"), "utf8"), sourceBefore, "blob inspection never mutates the active worktree");

    const events = canonicalJson(service.repository.listEvidence({ publicOnly: true }));
    const second = service.bootstrap({ history: true, publicOnly: true, since: "90d", maxCandidates: 3, now: "2026-07-11T12:00:00.000Z" });
    assert.equal(second.compiled.length, 0);
    assert.equal(second.covered, 2);
    assert.equal(canonicalJson(service.repository.listEvidence({ publicOnly: true })), events, "history rerun preserves evidence byte-semantics");
  } finally {
    cleanup();
  }
});

test("Phase 2B refuses structurally exact but human-unnamed coincidence", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/auth"), { recursive: true });
    mkdirSync(join(root, "src/payments"), { recursive: true });
    writeFileSync(join(root, "src/auth/session.ts"), "export function verifySession(){ return true; }\n");
    writeFileSync(join(root, "src/payments/charge.ts"), "export function charge(){ return true; }\n");
    commitFiles(root, ["src/auth/session.ts", "src/payments/charge.ts"], "fixture: unnamed baseline");
    writeFileSync(join(root, "src/payments/charge.ts"), 'import { verifySession } from "../auth/session.js";\nexport function charge(){ return verifySession(); }\n');
    const fix = commitFiles(root, ["src/payments/charge.ts"], "fix: restore required validation");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_unnamed", fix, {
      title: "Restore required validation",
      context: "The prior behavior reopened a security regression.",
      decision: "Keep the corrected behavior.",
      consequences: [],
      alternatives_rejected: [],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const inspection = service.inspectStructural("dec_history_unnamed", { publicOnly: true });
    assert.equal(inspection.candidates.length, 0);
    assert.ok(inspection.unsupported.some((r) => /structural coincidence not explicitly named/.test(r)));
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 0, "exact graph delta without human identifier grounding cannot become policy");
    assert.equal(report.uncompilable, 1);
  } finally {
    cleanup();
  }
});

test("Phase 2B revert removal compiles an exact not-reaches candidate", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/runtime"), { recursive: true });
    writeFileSync(join(root, "src/runtime/worker.ts"), "export function dangerous(){ return true; }\nexport function run(){ return dangerous(); }\n");
    commitFiles(root, ["src/runtime/worker.ts"], "fixture: dangerous shortcut");
    writeFileSync(join(root, "src/runtime/worker.ts"), "export function dangerous(){ return true; }\nexport function run(){ return true; }\n");
    const revert = commitFiles(root, ["src/runtime/worker.ts"], 'Revert "dangerous shortcut"');
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_revert", revert, {
      title: "Keep the dangerous shortcut out of the worker",
      caused_by_bug: null,
      related_files: ["src/runtime/worker.ts"],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 1);
    assert.equal(report.compiled[0]!.evidence.kind, "revert");
    assert.equal(report.compiled[0]!.policy.assertion.kind, "not-reaches");
    assert.equal(report.compiled[0]!.policy.authority, null);

    mkdirSync(join(root, "src/other"), { recursive: true });
    writeFileSync(join(root, "src/other/danger.ts"), "export function dangerous(){ return false; }\n");
    commitFiles(root, ["src/other/danger.ts"], "fixture: duplicate historical target name");
    indexRepo(store, root, { churn: false });
    store.reindex();
    const ambiguous = service.inspectStructural("dec_history_revert", { publicOnly: true });
    assert.equal(ambiguous.candidates.length, 0, "a removed call cannot guess among duplicate current targets");
    assert.ok(ambiguous.unsupported.some((r) => /removed-call target is ambiguous/.test(r)));
  } finally {
    cleanup();
  }
});

test("Phase 2B ambiguous before/after stays honestly uncompilable", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/route"), { recursive: true });
    writeFileSync(join(root, "src/route/handler.ts"), "export function oldRoute(){ return true; }\nexport function newRoute(){ return true; }\nexport function handler(){ return oldRoute(); }\n");
    commitFiles(root, ["src/route/handler.ts"], "fixture: old route");
    writeFileSync(join(root, "src/route/handler.ts"), "export function oldRoute(){ return true; }\nexport function newRoute(){ return true; }\nexport function handler(){ return newRoute(); }\n");
    const fix = commitFiles(root, ["src/route/handler.ts"], "fix: route through the replacement");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_ambiguous", fix, {
      title: "handler must replace oldRoute with newRoute",
      related_files: ["src/route/handler.ts"],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const inspection = service.inspectStructural("dec_history_ambiguous", { publicOnly: true });
    assert.equal(inspection.candidates.length, 2, "removed and added calls are both exact facts; neither is silently selected");
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 0);
    assert.equal(report.uncompilable, 1);
    const event = service.repository.listEvidence({ publicOnly: true })[0]!;
    assert.equal(event.compiler?.status, "uncompilable");
    assert.match(event.compiler?.reason ?? "", /enumerated 2 exact supported candidates; Hunch refused to choose/);
    assert.equal(service.list({ publicOnly: true }).length, 0);
  } finally {
    cleanup();
  }
});

test("Phase 2B unsupported import-only judgment is never substituted into another rule", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/domain"), { recursive: true });
    writeFileSync(join(root, "src/domain/model.ts"), "export function model(){ return true; }\n");
    commitFiles(root, ["src/domain/model.ts"], "fixture: domain baseline");
    writeFileSync(join(root, "src/domain/model.ts"), 'import framework from "framework";\nexport function model(){ return true; }\n');
    const fix = commitFiles(root, ["src/domain/model.ts"], "fix: restore framework integration");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_import_only", fix, {
      title: "Use the framework integration",
      related_files: ["src/domain/model.ts"],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const inspection = service.inspectStructural("dec_history_import_only", { publicOnly: true });
    assert.equal(inspection.candidates.length, 0);
    assert.ok(inspection.unsupported.some((r) => /awaits an import assertion evaluator/.test(r)));
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.uncompilable, 1);
    assert.equal(report.compiled.length, 0);
    assert.match(service.repository.listEvidence({ publicOnly: true })[0]?.compiler?.reason ?? "", /No exact supported structural assertion/);
  } finally {
    cleanup();
  }
});

test("Phase 2B exact-home history compilation cannot leak a same-id private judgment", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  mkdirSync(join(root, "src/auth"), { recursive: true });
  mkdirSync(join(root, "src/payments"), { recursive: true });
  writeFileSync(join(root, "src/auth/session.ts"), "export function verifySession(){ return true; }\n");
  writeFileSync(join(root, "src/payments/charge.ts"), "export function charge(){ return true; }\n");
  commitFiles(root, ["src/auth/session.ts", "src/payments/charge.ts"], "fixture: private history baseline");
  writeFileSync(join(root, "src/payments/charge.ts"), 'import { verifySession } from "../auth/session.js";\nexport function charge(){ return verifySession(); }\n');
  const fix = commitFiles(root, ["src/payments/charge.ts"], "fix: private history session validation");
  initial.close();
  const privateRoot = join(root, "private-history/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_collision", fix, { title: "PUBLIC session judgment" }));
    store.putPrivate("decisions", historyDecision("dec_history_collision", fix, { title: "PRIVATE SECRET session judgment" }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const pub = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(pub.compiled.length, 1);
    assert.equal(pub.compiled[0]!.policy.statement, "PUBLIC session judgment");
    assert.equal(pub.compiled[0]!.policy.data_class, "public");
    const priv = service.bootstrap({ history: true, privateOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(priv.compiled.length, 1);
    assert.equal(priv.compiled[0]!.policy.statement, "PRIVATE SECRET session judgment");
    assert.equal(priv.compiled[0]!.policy.data_class, "private");
    assert.doesNotMatch(canonicalJson(service.repository.listEvidence({ publicOnly: true })), /PRIVATE SECRET/);
    assert.doesNotMatch(canonicalJson(service.list({ publicOnly: true })), /PRIVATE SECRET/);
  } finally {
    store.close();
    cleanup();
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
