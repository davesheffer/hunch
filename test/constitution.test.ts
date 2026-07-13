import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { indexRepo } from "../src/extractors/indexer.js";
import type { Bug, Constraint, Decision, Runbook } from "../src/core/types.js";
import { buildCorrectionConstraint } from "../src/core/correction.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { canonicalHash, canonicalJson, policySemanticHash } from "../src/constitution/canonical.js";
import { policyProofHash } from "../src/constitution/composition.js";
import { approvePolicy, blockingEvidenceError, linkPolicyException } from "../src/constitution/lifecycle.js";
import { movePolicyArtifactsToPrivate } from "../src/constitution/repository.js";
import { evaluateCompositePolicyOnSnapshot, evaluatePolicyOnSnapshot, graphSnapshot, mutateSnapshotForPolicy } from "../src/constitution/evaluator.js";
import { clampCandidateLimit } from "../src/constitution/bootstrap.js";
import { provePolicy } from "../src/constitution/proof.js";
import { replayProofPlan } from "../src/constitution/replay.js";
import { loadReplaySnapshot, replayCacheFile } from "../src/constitution/replayCache.js";
import { PolicyProofSchema, PolicySpecSchema, ProofPlanSchema } from "../src/constitution/schema.js";
import { scoreCompilerCaseBank } from "../src/constitution/scorecard.js";
import { shortHash } from "../src/core/ids.js";
import { externalImportNodeId, externalPackage } from "../src/core/externalImports.js";
import { buildProofCard, renderProofCard } from "../src/constitution/card.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { nodeTestInfrastructureError } from "../src/constitution/g2BehaviorCandidates.js";

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
    assert.equal(proved.proof.current.satisfied, 1);
    assert.equal(proved.proof.mutation_receipts.length, 3);
    assert.deepEqual(proved.proof.mutation_controls, {
      total: 2,
      passed: 2,
      failed: 0,
      receipt_hashes: proved.proof.mutation_controls.receipt_hashes,
    });
    const primaryMutation = proved.proof.mutation_receipts.find((receipt) => receipt.kind === "primary")!;
    assert.equal(primaryMutation.error_code, undefined, JSON.stringify(primaryMutation));
    assert.equal(primaryMutation.passed, true, JSON.stringify(primaryMutation));
    assert.equal(proved.proof.mutations.violated, 1);
    assert.equal(proved.proof.proof_class, "P3", "clean baseline + caught bypass mutation earns P3");
    assert.equal(primaryMutation.graph_diff.added_edges.length, 2, "the exact call and its source-grounding import dependency are persisted in the proof");
    assert.equal(primaryMutation.parseability, "parseable");
    assert.deepEqual(primaryMutation.source_patch?.files, ["src/api/orders.ts"]);
    assert.match(primaryMutation.source_patch?.diff ?? "", /hunch deterministic source mutation/);
    assert.match(primaryMutation.source_patch?.diff ?? "", /import \{ dbQuery \} from "\.\.\/db\/client\.js"/);
    assert.ok(primaryMutation.source_patch?.diff_hash.startsWith("sha1:"));
    const commentControl = proved.proof.mutation_receipts.find((receipt) => receipt.operator === "comment-string-control")!;
    assert.equal(commentControl.parseability, "parseable");
    assert.deepEqual(commentControl.parser_control?.observed_target_calls, []);
    assert.deepEqual(commentControl.parser_control?.observed_target_imports, []);
    const ambiguityControl = proved.proof.mutation_receipts.find((receipt) => receipt.operator === "same-name-ambiguity-control")!;
    assert.equal(ambiguityControl.expected, "unknown");
    assert.equal(ambiguityControl.result, "unknown", "bare-name selectors fail safely when same-named symbols are introduced");
    assert.equal(ambiguityControl.passed, true);
    assert.deepEqual(proved.proof.project_checks, { build: "not_run", test: "not_run", required_for_evaluator_sensitivity: false });
    assert.ok(proved.proof.artifact_hashes.mutation_manifest);
    assert.equal(proved.proof.replay_receipts.some((receipt) => receipt.leg === "current_baseline"), true);
    const card = service.card(compiled.id);
    assert.equal(card.policy.id, compiled.id);
    assert.equal(card.authority.eligible_for_human_blocking_approval, true);
    assert.equal(card.authority.can_block_now, false, "proof readiness never substitutes for explicit authority");
    assert.equal(card.evidence_vector.mutation_controls.passed, 2);
    assert.equal(buildProofCard(proved.policy, proved.proof).card_hash, card.card_hash);
    assert.match(renderProofCard(card), /proof cannot activate policy/);
    assert.match(renderProofCard(card), /mutation controls: 2\/2 passed/);
    assert.match(renderProofCard(card), /project checks: build not_run · test not_run/);
    assert.doesNotMatch(renderProofCard(card), /confidence/i, "proof card reports a vector, never an opaque confidence score");
    const plan = service.repository.listPlans({ publicOnly: true })[0]!;
    assert.ok(plan);
    assert.equal(proved.proof.plan_hash, plan.content_hash, "proof binds the persisted canonical plan");
    assert.equal(plan.corpus.current_baseline.expected, "satisfied");
    assert.deepEqual(plan.mutation_engine, { name: "hunch-static-graph-controls", version: "5" });
    assert.equal(plan.mutations[0]?.operator, "add-bypass-edge");
    assert.deepEqual(plan.mutations.map((mutation) => mutation.operator), ["add-bypass-edge", "comment-string-control", "same-name-ambiguity-control"]);
    assert.ok(existsSync(join(root, ".hunch/plans", `${plan.id}.json`)), "ProofPlan is Git-native JSON");
    const planJson = canonicalJson(plan);
    assert.equal(canonicalJson(service.plan(compiled.id, { publicOnly: true, now: "2026-07-10T10:05:00.000Z" })), planJson, "same immutable inputs reuse the byte-stable plan");
    assert.throws(
      () => provePolicy(store, root, compiled, { publicOnly: true, now: NOW, plan: { ...plan, mutation_engine: undefined } }),
      /requires regeneration for mutation engine/,
      "a plan without the current mutation-engine identity cannot reuse proof authority",
    );
    const boundedPlan = service.plan(compiled.id, { publicOnly: true, maxCommits: 0, maxMutations: 0, now: "2026-07-10T10:05:00.000Z" });
    const boundedProof = provePolicy(store, root, compiled, { publicOnly: true, now: "2026-07-10T10:05:00.000Z", plan: boundedPlan });
    assert.equal(boundedProof.accepted_history.total, 0);
    assert.equal(boundedProof.mutations.total, 0, "a zero-mutation ProofPlan executes no implicit mutation outside its budget");
    assert.equal(boundedProof.mutation_receipts.length, 0);
    assert.equal(boundedProof.mutation_controls.total, 0);
    assert.equal(boundedProof.proof_class, "P2", "clean baseline plus completed zero-commit history earns P2 without inventing P3 sensitivity");
    assert.equal(proved.policy.state, "proposed");
    assert.equal(service.compile("dec_layer", { through: "fetchOrders", now: NOW }).state, "proposed", "recompile preserves incumbent lifecycle state");

    assert.throws(
      () => service.approve(compiled.id, "blocking", "machine:agent", { now: "2026-07-10T10:02:00.000Z" }),
      /human actor/,
      "machine/model identity cannot activate policy",
    );
    const unclassified = {
      ...proved.proof,
      accepted_history: {
        total: 1, satisfied: 0, violated: 1, not_applicable: 0, unknown: 0, error: 0,
        receipt_hashes: ["sha1:unclassified"], classified_hits: [],
      },
    };
    assert.throws(
      () => approvePolicy(proved.policy, unclassified, "blocking", "human:test-owner", "2026-07-10T10:01:30.000Z"),
      /accepted-history/,
      "a historical hit cannot be silently treated as a false positive or approved for blocking",
    );
    const failedControl = {
      ...proved.proof,
      mutation_controls: { total: 2, passed: 1, failed: 1, receipt_hashes: proved.proof.mutation_controls.receipt_hashes },
    };
    assert.throws(
      () => approvePolicy(proved.policy, failedControl, "blocking", "human:test-owner", "2026-07-10T10:01:31.000Z"),
      /failed required mutation controls/,
      "a failed required control refuses blocking approval",
    );
    const failedPrimary = {
      ...proved.proof,
      mutation_receipts: proved.proof.mutation_receipts.map((receipt, index) => index === 0 ? { ...receipt, passed: false } : receipt),
    };
    assert.throws(
      () => approvePolicy(proved.policy, failedPrimary, "blocking", "human:test-owner", "2026-07-10T10:01:32.000Z"),
      /failed required mutation receipt/,
      "a failed required primary mutation cannot borrow P3 strength from another proof leg",
    );
    const unsafeCard = buildProofCard(proved.policy, unclassified);
    assert.equal(unsafeCard.authority.eligible_for_human_blocking_approval, false);
    assert.equal(unsafeCard.uncertainty.unclassified_history_hits, 1);
    assert.ok(unsafeCard.actions.some((action) => action.startsWith("Classify every")));
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

    // Targeted advisory withdrawal (§57): authority returns to the human pool and
    // the policy is proposed again — it re-enters the escalation loop.
    const withdrawn = service.withdraw(active.id, "human:test-owner", "Scope changed; re-decide.", { now: "2026-07-10T10:04:00.000Z" });
    assert.equal(withdrawn.state, "proposed");
    assert.equal(withdrawn.authority, null, "withdrawal removes the human authority");
    assert.equal(withdrawn.audit.at(-1)!.action, "withdrawn");
    assert.throws(() => service.withdraw(active.id, "human:test-owner", "again", { now: "2026-07-10T10:05:00.000Z" }),
      /only active advisory policy can be withdrawn/, "withdraw is advisory-only");

    // Permanent retirement: window closed, history kept, authority gone.
    const retired = service.retire(active.id, "human:test-owner", "Guarded module deleted.", { now: "2026-07-10T10:06:00.000Z" });
    assert.equal(retired.state, "retired");
    assert.equal(retired.valid_to, "2026-07-10T10:06:00.000Z");
    assert.equal(retired.authority, null);
    assert.equal(retired.audit.at(-1)!.action, "retired");
    assert.throws(() => service.retire(active.id, "human:test-owner", "again", { now: "2026-07-10T10:07:00.000Z" }),
      /only an active or proposed policy can be retired/, "retired is terminal");
    writeFileSync(join(root, ".hunch/plans", `${plan.id}.json`), JSON.stringify({ ...plan, budgets: { ...plan.budgets, max_commits: 99 } }, null, 2));
    assert.throws(() => service.repository.listPlans({ publicOnly: true }), /content hash mismatch/, "hand-edited plan cannot retain trusted identity");
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

test("ProofPlan fallback stays anchored to the policy introduction commit across lifecycle updates", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_plan_origin"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const compiled = service.compile("dec_plan_origin", { through: "fetchOrders", now: NOW });
    const file = `.hunch/policies/${compiled.id}.json`;
    const introduced = commitFiles(root, [file], "fixture: introduce policy semantics");
    const first = service.plan(compiled.id, { publicOnly: true, now: NOW });
    assert.equal(first.source_commit, introduced);

    service.repository.putPolicy({
      ...compiled,
      revision: compiled.revision + 1,
      state: "validating",
      updated_at: "2026-07-10T10:05:00.000Z",
    });
    commitFiles(root, [file], "fixture: update policy lifecycle only");
    const later = service.plan(compiled.id, { publicOnly: true, now: "2026-07-10T10:06:00.000Z" });
    assert.equal(later.source_commit, introduced, "proof attachment and lifecycle commits cannot erase earlier accepted history");
    assert.notEqual(later.corpus.current_baseline.ref, introduced);
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

test("Phase 2H human-linked exceptions are exact, narrower, proof-invalidating, and non-authoritative", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_exception_base"));
    store.reindex();
    const base = new ConstitutionService(store, root).compile("dec_exception_base", { now: NOW });
    assert.notEqual(base.assertion.kind, "exists");
    const parent = PolicySpecSchema.parse({
      ...base,
      id: "pol_cccccccccc",
      scope: { repos: [], paths: ["src/api/**"], components: [] },
      assertion: base.assertion.kind === "exists" ? base.assertion : { ...base.assertion, kind: "not-reaches" },
    });
    const child = PolicySpecSchema.parse({
      ...parent,
      id: "pol_dddddddddd",
      revision: 4,
      state: "proposed",
      scope: { repos: [], paths: ["src/api/legacy.ts"], components: [] },
      assertion: parent.assertion.kind === "exists" ? parent.assertion : { ...parent.assertion, kind: "reaches" },
      proof: "proof_old",
      authority: null,
      exception_of: null,
    });
    const beforeHash = policySemanticHash(child);
    const linked = linkPolicyException(child, parent, "human:architect", "Legacy migration endpoint is an intentional narrow exception.", "2026-07-10T11:00:00.000Z");
    assert.equal(linked.exception_of, parent.id);
    assert.equal(linked.revision, 5);
    assert.equal(linked.state, "compiled");
    assert.equal(linked.proof, null);
    assert.equal(linked.authority, null);
    assert.equal(linked.audit.at(-1)?.action, "linked_exception");
    assert.notEqual(policySemanticHash(linked), beforeHash, "exception composition invalidates the previous proof hash");
    assert.equal(linkPolicyException(linked, parent, "human:architect", "same", "2026-07-10T11:01:00.000Z"), linked, "same link is idempotent");
    assert.throws(() => linkPolicyException(child, parent, "model:auto", "not human", NOW), /explicit human actor/);
    assert.throws(() => linkPolicyException(PolicySpecSchema.parse({ ...child, scope: parent.scope }), parent, "human:architect", "too broad", NOW), /strictly narrower/);
  } finally {
    cleanup();
  }
});

test("Phase 2J exception relations are read-only, reverse-indexed, and surface a missing parent", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_exception_relations"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const base = service.compile("dec_exception_relations", { now: NOW });
    assert.notEqual(base.assertion.kind, "exists");
    const parent = PolicySpecSchema.parse({
      ...base,
      id: "pol_eeeeeeeeee",
      scope: { repos: [], paths: ["src/api/**"], components: [] },
      assertion: base.assertion.kind === "exists" ? base.assertion : { ...base.assertion, kind: "not-reaches" },
    });
    const child = PolicySpecSchema.parse({
      ...parent,
      id: "pol_fffffffff0",
      scope: { repos: [], paths: ["src/api/legacy.ts"], components: [] },
      assertion: parent.assertion.kind === "exists" ? parent.assertion : { ...parent.assertion, kind: "reaches" },
      exception_of: null,
    });
    service.repository.putPolicy(parent);
    service.repository.putPolicy(child);
    const linked = service.linkException(child.id, parent.id, "github:architect", "Legacy migration endpoint is intentionally narrow.", { now: "2026-07-10T11:00:00.000Z" });
    const parentRelations = service.relations(parent.id, { publicOnly: true });
    assert.equal(parentRelations.policy.id, parent.id);
    assert.equal(parentRelations.exception_parent, null);
    assert.equal(parentRelations.missing_exception_parent, null);
    assert.deepEqual(parentRelations.exceptions.map((exception) => exception.id), [linked.id]);
    assert.equal(parentRelations.exceptions[0]!.exception_of, parent.id);
    const childRelations = service.relations(linked.id, { publicOnly: true });
    assert.equal(childRelations.exception_parent?.id, parent.id);
    assert.deepEqual(childRelations.exceptions, []);

    const damaged = PolicySpecSchema.parse({ ...linked, id: "pol_fffffffff1", exception_of: "pol_aaaaaaaaaa" });
    service.repository.putPolicy(damaged);
    const damagedRelations = service.relations(damaged.id, { publicOnly: true });
    assert.equal(damagedRelations.exception_parent, null);
    assert.equal(damagedRelations.missing_exception_parent, "pol_aaaaaaaaaa");
    assert.equal(service.get(linked.id, { publicOnly: true }).exception_of, parent.id, "inspection never mutates linked policy state");

    const suggestedParent = PolicySpecSchema.parse({
      ...parent,
      candidate: { ...parent.candidate, scope_suggestion: parent.scope },
    });
    service.repository.putPolicy(suggestedParent);
    const protectedConsolidation = service.consolidation(parent.id, { publicOnly: true });
    assert.equal(protectedConsolidation.status, "challenged");
    assert.deepEqual(protectedConsolidation.exception_linked_members, [parent.id]);
    assert.match(protectedConsolidation.reasons.join("\n"), /combined exception semantics first/);
  } finally {
    cleanup();
  }
});

test("Phase 3E applies an exists mutation to isolated source and persists a parseable deletion diff", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", {
      ...decision("dec_exists_source_mutation"),
      title: "The order service entrypoint must exist",
      conformance: [{ assert: "exists", subject: "fetchOrders", transitive: false }],
    });
    store.reindex();
    const service = new ConstitutionService(store, root);
    const policy = service.compile("dec_exists_source_mutation", { now: NOW });
    const sourceFile = join(root, "src/services/orders.ts");
    const before = readFileSync(sourceFile, "utf8");
    const proved = service.prove(policy.id, { now: "2026-07-10T10:01:00.000Z" });
    const primary = proved.proof.mutation_receipts.find((receipt) => receipt.kind === "primary")!;
    assert.equal(primary.operator, "delete-required-symbol");
    assert.equal(primary.result, "violated");
    assert.equal(primary.passed, true);
    assert.equal(primary.parseability, "parseable");
    assert.deepEqual(primary.source_patch?.files, ["src/services/orders.ts"]);
    assert.match(primary.source_patch?.diff ?? "", /-export function fetchOrders/);
    assert.equal(primary.graph_diff.removed_symbols.length, 1);
    assert.equal(readFileSync(sourceFile, "utf8"), before, "source mutation never changes the active checkout");
    assert.deepEqual(readdirSync(join(root, ".hunch-cache/mutations")), []);
  } finally {
    cleanup();
  }
});

test("Phase 3F imports immutable known-good/bad fixtures and hash-binds them into replay", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    const initialGood = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
    const knownBad = commitFiles(root, ["src/api/orders.ts"], "fixture: controller bypasses service");
    writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
    const currentGood = commitFiles(root, ["src/api/orders.ts"], "fixture: restore service boundary");
    store.json.put("decisions", decision("dec_imported_corpus"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const policy = service.compile("dec_imported_corpus", { through: "fetchOrders", now: NOW });
    const imported = service.importCorpus(policy.id, {
      known_bad: [{ ref: knownBad.slice(0, 12), label: "confirmed controller bypass" }],
      known_good: [{
        ref: initialGood,
        label: "earlier accepted service path",
        attestation: { actor: "github:reviewer", reason: "Reviewed legacy service-only path before the regression." },
      }],
    }, { now: "2026-07-10T10:00:30.000Z" });
    assert.deepEqual(imported.known_bad.map((fixture) => fixture.ref), [knownBad]);
    assert.deepEqual(imported.known_good.map((fixture) => fixture.ref), [initialGood]);
    assert.deepEqual(imported.known_good[0]!.attestation, {
      actor: "github:reviewer",
      reason: "Reviewed legacy service-only path before the regression.",
    });
    assert.ok(existsSync(join(root, ".hunch/corpora", `${policy.id}.json`)));
    const importedAgain = service.importCorpus(policy.id, {
      known_bad: [{ ref: knownBad, label: "confirmed controller bypass" }],
      known_good: [{
        ref: initialGood,
        label: "earlier accepted service path",
        attestation: { actor: "github:reviewer", reason: "Reviewed legacy service-only path before the regression." },
      }],
    }, { now: "2026-07-10T10:00:59.000Z" });
    assert.deepEqual(importedAgain, imported, "same canonical corpus import is byte-stable and keeps its original timestamp");
    assert.throws(() => service.importCorpus(policy.id, {
      known_bad: [{ ref: currentGood, label: "bad" }],
      known_good: [{ ref: currentGood, label: "good" }],
    }), /duplicated in known_bad and known_good/);
    assert.equal(service.corpus(policy.id).id, imported.id, "refused import preserves the previous canonical corpus");

    const plan = service.plan(policy.id, { now: "2026-07-10T10:01:00.000Z" });
    assert.deepEqual(plan.corpus_manifest, { id: imported.id, content_hash: imported.content_hash });
    assert.deepEqual(plan.corpus.known_bad.map((fixture) => fixture.ref), [knownBad]);
    assert.deepEqual(plan.corpus.known_good.map((fixture) => fixture.ref).sort(), [currentGood, initialGood].sort());
    assert.deepEqual(plan.corpus.known_good.find((fixture) => fixture.ref === initialGood)?.attestation, imported.known_good[0]!.attestation);
    assert.ok(plan.corpus.accepted_history.exclude.includes(initialGood), "human-attested corpus evidence is not double-counted as accepted history");
    assert.match(plan.limitations.join("\n"), /attestation cannot waive a policy or grant authority/);
    assert.throws(() => service.importCorpus(policy.id, {
      known_good: [{
        ref: initialGood,
        label: "model-attested path",
        attestation: { actor: "model:hunch", reason: "not a human reviewer" },
      }],
    }), /fixture attestation requires an explicit human actor/);
    const { proof } = service.prove(policy.id, { now: "2026-07-10T10:02:00.000Z" });
    assert.equal(proof.proof_class, "P3");
    assert.equal(proof.known_bad.violated, 1);
    assert.equal(proof.known_good.satisfied, 2);
    assert.equal(proof.known_bad.unknown + proof.known_bad.error + proof.known_good.unknown + proof.known_good.error, 0);
    assert.deepEqual(proof.replay_receipts.filter((receipt) => receipt.leg === "known_bad").map((receipt) => receipt.commit), [knownBad]);
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
    const proved = service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
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
    mkdirSync(join(root, ".hunch/plans"), { recursive: true });
    writeFileSync(join(root, ".hunch/plans/plan_bad.json"), "{ not json");
    assert.throws(() => service.repository.listPlans(), /invalid plans\/plan_bad\.json/);
    mkdirSync(join(root, ".hunch/corpora"), { recursive: true });
    writeFileSync(join(root, ".hunch/corpora/pol_bad.json"), "{ not json");
    assert.throws(() => service.repository.getCorpus("pol_bad"), /invalid corpora\/pol_bad\.json/);
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
    const corpus = service.importCorpus(policy.id, {
      known_good: [{ ref: "HEAD", label: "PRIVATE_CORPUS_SENTINEL" }],
    }, { now: "2026-07-10T10:00:30.000Z" });
    assert.ok(existsSync(join(privateRoot, "corpora", `${policy.id}.json`)));
    assert.equal(existsSync(join(root, ".hunch/corpora", `${policy.id}.json`)), false);
    assert.equal(service.repository.getCorpus(policy.id, { publicOnly: true }), undefined);
    const proved = service.prove(policy.id, { now: "2026-07-10T10:01:00.000Z" });
    assert.ok(existsSync(join(privateRoot, "proofs", `${proved.proof.id}.json`)));
    const baselineReceipt = proved.proof.replay_receipts.find((receipt) => receipt.leg === "current_baseline")!;
    const privateHit = {
      ...baselineReceipt,
      leg: "accepted_history" as const,
      result: "violated" as const,
      deterministic_hash: canonicalHash({ private_history_hit: baselineReceipt.commit }),
    };
    const privateProof = PolicyProofSchema.parse({
      ...proved.proof,
      accepted_history: { total: 1, satisfied: 0, violated: 1, not_applicable: 0, unknown: 0, error: 0, receipt_hashes: [privateHit.deterministic_hash], classified_hits: [] },
      replay_receipts: [...proved.proof.replay_receipts.filter((receipt) => receipt.leg !== "accepted_history"), privateHit],
    });
    service.repository.putProof(privateProof, policy.id);
    const privateDisposition = service.classifyHistory(policy.id, privateHit.commit, "true_positive_actionable", "human:private-owner", "PRIVATE_DISPOSITION_SENTINEL", { now: "2026-07-10T10:01:30.000Z" });
    assert.ok(existsSync(join(privateRoot, "dispositions", `${privateDisposition.id}.json`)));
    assert.equal(existsSync(join(root, ".hunch/dispositions", `${privateDisposition.id}.json`)), false);
    assert.deepEqual(service.repository.listDispositions({ publicOnly: true }), []);
    assert.doesNotMatch(canonicalJson(service.repository.listDispositions({ publicOnly: true })), /PRIVATE_DISPOSITION_SENTINEL/);
    const plan = service.repository.listPlans({ privateOnly: true })[0]!;
    assert.ok(plan);
    assert.ok(existsSync(join(privateRoot, "plans", `${plan.id}.json`)));
    assert.equal(service.repository.listPlans({ publicOnly: true }).length, 0);
    const privateCache = replayCacheFile(root, plan.corpus.current_baseline.ref, "private");
    assert.ok(existsSync(privateCache));
    assert.doesNotMatch(readFileSync(privateCache, "utf8"), new RegExp(policy.id), "graph cache is policy-neutral and carries no private rationale");
    assert.equal(existsSync(replayCacheFile(root, plan.corpus.current_baseline.ref, "public")), false, "private replay cache never shares a public cache home");
    assert.equal(service.list({ publicOnly: true }).some((p) => p.id === policy.id), false);
    assert.deepEqual(service.evaluate({ activeOnly: false, publicOnly: true }), []);
    assert.doesNotMatch(canonicalJson(service.list({ publicOnly: true })), new RegExp(policy.id));
    assert.doesNotMatch(canonicalJson(service.repository.getCorpus(policy.id, { publicOnly: true }) ?? null), /PRIVATE_CORPUS_SENTINEL/);
    assert.match(corpus.known_good[0]!.label, /PRIVATE_CORPUS_SENTINEL/);
  } finally {
    store.close();
    cleanup();
  }
});

test("private composite receipts and member hashes never cross into the public policy home", () => {
  const { root, store: initial, cleanup } = layeredRepo('import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
  initial.close();
  const privateRoot = join(root, "private-overlay/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putPrivate("decisions", decision("dec_private_composite", { private: true }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const base = service.compile("dec_private_composite", { now: NOW });
    assert.equal(base.assertion.kind, "not-reaches");
    const parent = PolicySpecSchema.parse({ ...base, id: "pol_d1d1d1d1d1", scope: { repos: [], paths: ["src/api/**"], components: [] } });
    const child = PolicySpecSchema.parse({
      ...parent,
      id: "pol_e1e1e1e1e1",
      scope: { repos: [], paths: ["src/api/orders.ts"], components: [] },
      assertion: { ...parent.assertion, kind: "reaches" },
      exception_of: null,
    });
    service.repository.putPolicy(parent, { private: true });
    service.repository.putPolicy(child, { private: true });
    const linked = service.linkException(child.id, parent.id, "human:private-owner", "PRIVATE_COMPOSITION_SENTINEL", { now: "2026-07-11T13:10:00.000Z" });
    const proved = service.prove(parent.id, { now: "2026-07-11T13:11:00.000Z" });
    assert.equal(proved.proof.composition?.members[0]?.policy_id, linked.id);
    assert.ok(existsSync(join(privateRoot, "proofs", `${proved.proof.id}.json`)));
    assert.ok(service.repository.listPlans({ privateOnly: true }).some((plan) => plan.composition?.members[0]?.policy_id === linked.id));
    assert.deepEqual(service.repository.listPlans({ publicOnly: true }), []);
    assert.equal(service.repository.getProof(proved.proof.id, { publicOnly: true }), undefined);
    assert.doesNotMatch(canonicalJson(service.list({ publicOnly: true })), /pol_[de]1[de]1/);
    writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
    commitFiles(root, ["src/api/orders.ts"], "fixture: private shadow exception violation");
    indexRepo(store, root, { churn: false });
    store.reindex();
    const shadow = service.recordShadow(parent.id, { now: "2026-07-11T13:12:00.000Z", latencyMs: 5 });
    assert.equal(shadow.evaluation.result, "violated");
    const shadowDisposition = service.classifyShadow(parent.id, shadow.id, "true_positive_actionable", "human:private-owner", "PRIVATE_SHADOW_SENTINEL", { now: "2026-07-11T13:13:00.000Z" });
    assert.ok(existsSync(join(privateRoot, "shadow", `${shadow.id}.json`)));
    assert.ok(existsSync(join(privateRoot, "shadow", `${shadowDisposition.id}.json`)));
    assert.deepEqual(service.repository.listShadowEvaluations({ publicOnly: true }), []);
    assert.deepEqual(service.repository.listShadowDispositions({ publicOnly: true }), []);
    assert.doesNotMatch(canonicalJson({
      evaluations: service.repository.listShadowEvaluations({ publicOnly: true }),
      dispositions: service.repository.listShadowDispositions({ publicOnly: true }),
    }), /PRIVATE_SHADOW_SENTINEL/);
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
      const corpus = service.importCorpus(compiled.id, { known_good: [{ ref: "HEAD", label: "migration fixture" }] }, { now: NOW });
      const proved = service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
      const shadow = service.recordShadow(compiled.id, { now: "2026-07-10T10:02:00.000Z", latencyMs: 3 });
      mkdirSync(join(publicHome, "policies"), { recursive: true });
      mkdirSync(join(publicHome, "proofs"), { recursive: true });
      mkdirSync(join(publicHome, "plans"), { recursive: true });
      mkdirSync(join(publicHome, "corpora"), { recursive: true });
      mkdirSync(join(publicHome, "shadow"), { recursive: true });
      writeFileSync(join(publicHome, "policies", `${compiled.id}.json`), readFileSync(join(fixture.root, ".hunch/policies", `${compiled.id}.json`)));
      writeFileSync(join(publicHome, "proofs", `${proved.proof.id}.json`), readFileSync(join(fixture.root, ".hunch/proofs", `${proved.proof.id}.json`)));
      const plan = service.repository.listPlans({ publicOnly: true })[0]!;
      writeFileSync(join(publicHome, "plans", `${plan.id}.json`), readFileSync(join(fixture.root, ".hunch/plans", `${plan.id}.json`)));
      writeFileSync(join(publicHome, "corpora", `${compiled.id}.json`), readFileSync(join(fixture.root, ".hunch/corpora", `${compiled.id}.json`)));
      writeFileSync(join(publicHome, "shadow", `${shadow.id}.json`), readFileSync(join(fixture.root, ".hunch/shadow", `${shadow.id}.json`)));
      assert.equal(corpus.policy_id, compiled.id);
    } finally {
      fixture.cleanup();
    }
    const moved = movePolicyArtifactsToPrivate(publicHome, privateHome);
    assert.deepEqual(moved, { policies: 1, proofs: 1, plans: 1, evidence: 0, corpora: 1, dispositions: 0, shadow: 1 });
    assert.equal(existsSync(join(publicHome, "policies")), false);
    assert.ok(existsSync(join(privateHome, "policies")));
    assert.ok(existsSync(join(privateHome, "proofs")));
    assert.ok(existsSync(join(privateHome, "plans")));
    assert.ok(existsSync(join(privateHome, "corpora")));
    assert.ok(existsSync(join(privateHome, "shadow")));
    assert.deepEqual(readdirSync(join(privateHome, "corpora")), readdirSync(join(privateHome, "policies")), "migrated corpus keeps its policy-keyed filename");
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

test("private migration validates late corpus artifacts before moving an earlier valid policy", () => {
  const root = execFileSync("mktemp", ["-d", join(tmpdir(), "hunch-corpus-migrate-invalid-XXXXXX")], { encoding: "utf8" }).trim();
  const privateHome = join(root, "private/.hunch");
  const publicHome = join(root, ".hunch");
  const fixture = layeredRepo();
  try {
    fixture.store.json.put("decisions", decision("dec_migrate_late_failure"));
    fixture.store.reindex();
    const policy = new ConstitutionService(fixture.store, fixture.root).compile("dec_migrate_late_failure", { through: "fetchOrders", now: NOW });
    mkdirSync(join(publicHome, "policies"), { recursive: true });
    mkdirSync(join(publicHome, "corpora"), { recursive: true });
    const policyFile = join(publicHome, "policies", `${policy.id}.json`);
    writeFileSync(policyFile, readFileSync(join(fixture.root, ".hunch/policies", `${policy.id}.json`)));
    writeFileSync(join(publicHome, "corpora", `${policy.id}.json`), "{ corrupt");
    assert.throws(() => movePolicyArtifactsToPrivate(publicHome, privateHome), /invalid corpora/);
    assert.ok(existsSync(policyFile), "two-phase validation preserves earlier valid categories on a late failure");
    assert.equal(existsSync(join(privateHome, "policies", `${policy.id}.json`)), false);
  } finally {
    fixture.cleanup();
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
    const publicPlan = service.plan(publicReport.compiled[0]!.policy.id, { publicOnly: true, now: "2026-07-10T12:01:00.000Z" });
    const privatePlan = service.plan(privateReport.compiled[0]!.policy.id, { privateOnly: true, now: "2026-07-10T12:01:00.000Z" });
    assert.notEqual(publicPlan.id, privatePlan.id);
    assert.ok(existsSync(join(root, ".hunch/plans", `${publicPlan.id}.json`)));
    assert.ok(existsSync(join(privateRoot, "plans", `${privatePlan.id}.json`)));
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
    for (const file of ["bootstrap.ts", "structural.ts", "delta.ts", "adapters.ts", "corpus.ts", "plan.ts", "replay.ts", "replayWorker.ts", "replayCache.ts", "mutation.ts", "sourceMutation.ts", "card.ts"]) {
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
    assert.ok(inspection.unsupported.some((r) => /relative import .* structural coincidence/.test(r)), "the ungrounded component interpretation stays visible instead of competing with the exact call");

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
    const enriched = service.list({ publicOnly: true }).find((candidate) => candidate.id === policy.id)!;
    assert.equal(enriched.revision, 2, "equivalent evidence enriches the incumbent exactly once");
    assert.ok(enriched.evidence.includes("dec_history_a") && enriched.evidence.includes("dec_history_b"));
    assert.equal(enriched.audit.at(-1)?.action, "enriched");
    assert.equal(enriched.authority, null, "enrichment cannot grant authority");
    const plan = service.plan(policy.id, { publicOnly: true, now: "2026-07-11T12:00:00.000Z" });
    const parent = execFileSync("git", ["rev-parse", `${fix}^`], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(plan.source_commit, fix);
    assert.equal(plan.corpus.known_bad[0]?.ref, parent, "the exact first parent of an attributable fix is the known-bad replay leg");
    assert.equal(plan.corpus.known_bad[0]?.expected, "violated");
    assert.equal(plan.expected.find((e) => e.leg === "accepted_history")?.classification_required, true);
    assert.equal(readFileSync(join(root, "src/payments/charge.ts"), "utf8"), sourceBefore, "blob inspection never mutates the active worktree");

    const events = canonicalJson(service.repository.listEvidence({ publicOnly: true }));
    const second = service.bootstrap({ history: true, publicOnly: true, since: "90d", maxCandidates: 3, now: "2026-07-11T12:00:00.000Z" });
    assert.equal(second.compiled.length, 0);
    assert.equal(second.covered, 2);
    assert.equal(canonicalJson(service.repository.listEvidence({ publicOnly: true })), events, "history rerun preserves evidence byte-semantics");
    assert.equal(service.list({ publicOnly: true }).find((candidate) => candidate.id === policy.id)?.revision, 2, "idempotent rerun does not churn the incumbent revision");
  } finally {
    cleanup();
  }
});

test("Phase 3 replays current, known-bad, known-good, and bounded accepted history without hooks or active-worktree mutation", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/auth"), { recursive: true });
    mkdirSync(join(root, "src/payments"), { recursive: true });
    writeFileSync(join(root, "src/auth/session.ts"), "export function verifySession(){ return true; }\n");
    writeFileSync(join(root, "src/payments/charge.ts"), "export function charge(){ return true; }\n");
    commitFiles(root, ["src/auth/session.ts", "src/payments/charge.ts"], "fixture: replay known-bad baseline");
    writeFileSync(join(root, "src/payments/charge.ts"), 'import { verifySession } from "../auth/session.js";\nexport function charge(){ return verifySession(); }\n');
    const fix = commitFiles(root, ["src/payments/charge.ts"], "fix: restore replayed session validation");
    writeFileSync(join(root, "src/payments/accepted.ts"), "export const accepted = true;\n");
    const accepted = commitFiles(root, ["src/payments/accepted.ts"], "fixture: accepted history after fix");
    writeFileSync(join(root, "src/payments/head.ts"), "export const head = true;\n");
    commitFiles(root, ["src/payments/head.ts"], "fixture: current replay baseline");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_phase3_replay", fix));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    const policy = report.compiled[0]!.policy;

    const sentinel = join(root, "hook-ran");
    const hook = join(root, ".git/hooks/post-checkout");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(sentinel)}\n`);
    chmodSync(hook, 0o755);
    const sourceBefore = readFileSync(join(root, "src/payments/charge.ts"), "utf8");
    const diffBefore = execFileSync("git", ["diff", "--", "src"], { cwd: root, encoding: "utf8" });
    const worktreesBefore = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });

    const first = service.prove(policy.id, { now: "2026-07-11T12:01:00.000Z" });
    assert.equal(first.proof.proof_class, "P3");
    assert.equal(first.proof.current.satisfied, 1);
    assert.equal(first.proof.known_bad.total, 1);
    assert.equal(first.proof.known_bad.violated, 1, "the confirmed first-parent regression is caught");
    assert.equal(first.proof.known_good.satisfied, 1);
    assert.equal(first.proof.accepted_history.total, 1, "HEAD is not duplicated inside accepted history");
    assert.equal(first.proof.accepted_history.satisfied, 1);
    assert.equal(first.proof.accepted_history.error, 0);
    assert.deepEqual(first.proof.mutation_controls, {
      total: 2,
      passed: 2,
      failed: 0,
      receipt_hashes: first.proof.mutation_controls.receipt_hashes,
    });
    const exactAmbiguityControl = first.proof.mutation_receipts.find((receipt) => receipt.operator === "same-name-ambiguity-control")!;
    assert.equal(exactAmbiguityControl.expected, "satisfied");
    assert.equal(exactAmbiguityControl.result, "satisfied", "file-qualified selectors ignore unrelated same-name symbols");
    const sourceMutation = first.proof.mutation_receipts.find((receipt) => receipt.kind === "primary")!;
    assert.equal(sourceMutation.parseability, "parseable");
    assert.deepEqual(sourceMutation.source_patch?.files, ["src/payments/charge.ts"]);
    assert.match(sourceMutation.source_patch?.diff ?? "", /hunchMutationRemovedCall/);
    assert.equal(first.proof.replay_receipts.find((receipt) => receipt.leg === "accepted_history")?.commit, accepted);
    assert.ok(first.proof.artifact_hashes.replay_manifest);
    assert.equal(first.policy.authority, null);

    const replayPlan = service.repository.listPlans({ publicOnly: true }).find((candidate) => candidate.content_hash === first.proof.plan_hash)!;
    rmSync(join(root, ".hunch-cache", "replay"), { recursive: true, force: true });
    const parallel = replayProofPlan(root, first.policy, replayPlan, { maxWorkers: 2 });
    assert.deepEqual(parallel.replay_receipts, first.proof.replay_receipts, "parallel scheduling cannot perturb canonical receipts");
    assert.deepEqual(parallel.cache_stats, { hits: 0, misses: 3, rebuilds: 0, memory_hits: 1 });
    assert.deepEqual(parallel.worker_stats, { limit: 2, peak: 2, scheduled: 3 }, "cold unique snapshots use the bounded worker pool");
    const cached = replayProofPlan(root, first.policy, replayPlan);
    assert.deepEqual(cached.replay_receipts, first.proof.replay_receipts);
    assert.deepEqual(cached.cache_stats, { hits: 3, misses: 0, rebuilds: 0, memory_hits: 1 }, "second replay reuses every unique immutable graph");
    assert.deepEqual(cached.worker_stats, { limit: 4, peak: 0, scheduled: 0 }, "warm replay launches no worker process");
    assert.equal(replayProofPlan(root, first.policy, replayPlan, { maxWorkers: 99 }).worker_stats.limit, 8, "worker concurrency has a hard upper bound");
    const currentCache = replayCacheFile(root, replayPlan.corpus.current_baseline.ref, "public");
    assert.ok(existsSync(currentCache));
    writeFileSync(currentCache, "{ corrupt");
    const rebuilt = replayProofPlan(root, first.policy, replayPlan);
    assert.equal(rebuilt.cache_stats.rebuilds, 1);
    assert.deepEqual(rebuilt.replay_receipts, first.proof.replay_receipts, "corrupt derived cache rebuild cannot perturb proof semantics");
    assert.doesNotThrow(() => JSON.parse(readFileSync(currentCache, "utf8")));
    assert.notEqual(currentCache, replayCacheFile(root, replayPlan.corpus.current_baseline.ref, "public", "2"), "engine version changes invalidate by key");
    assert.equal(loadReplaySnapshot(root, replayPlan.corpus.current_baseline.ref, "public", "2").status, "miss");

    const second = service.prove(policy.id, { now: "2026-07-11T12:01:00.000Z" });
    assert.equal(canonicalJson(second.proof), canonicalJson(first.proof), "same plan and evaluator produce byte-equivalent replay proof");
    assert.equal(readFileSync(join(root, "src/payments/charge.ts"), "utf8"), sourceBefore);
    assert.equal(execFileSync("git", ["diff", "--", "src"], { cwd: root, encoding: "utf8" }), diffBefore);
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }), worktreesBefore);
    assert.equal(existsSync(sentinel), false, "repository post-checkout hook is disabled for replay worktrees");
    assert.deepEqual(readdirSync(join(root, ".hunch-cache/worktrees")), [], "every disposable checkout and graph is removed");
    assert.deepEqual(readdirSync(join(root, ".hunch-cache/mutations")), [], "every disposable source-mutation checkout and graph is removed");
  } finally {
    cleanup();
  }
});

test("Phase 2L human history dispositions are append-only, receipt-bound, fail-closed, and separately activated", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/auth"), { recursive: true });
    mkdirSync(join(root, "src/payments"), { recursive: true });
    writeFileSync(join(root, "src/auth/session.ts"), "export function verifySession(){ return true; }\n");
    writeFileSync(join(root, "src/payments/charge.ts"), "export function charge(){ return true; }\n");
    commitFiles(root, ["src/auth/session.ts", "src/payments/charge.ts"], "fixture: disposition known-bad baseline");
    writeFileSync(join(root, "src/payments/charge.ts"), 'import { verifySession } from "../auth/session.js";\nexport function charge(){ return verifySession(); }\n');
    const fix = commitFiles(root, ["src/payments/charge.ts"], "fix: restore disposition session validation");
    writeFileSync(join(root, "src/payments/charge.ts"), "export function charge(){ return true; }\n");
    const historicalViolation = commitFiles(root, ["src/payments/charge.ts"], "fixture: accepted regression requiring disposition");
    writeFileSync(join(root, "src/payments/charge.ts"), 'import { verifySession } from "../auth/session.js";\nexport function charge(){ return verifySession(); }\n');
    commitFiles(root, ["src/payments/charge.ts"], "fixture: restore current disposition baseline");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_history_disposition", fix));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    const policy = report.compiled[0]!.policy;
    const proved = service.prove(policy.id, { now: "2026-07-11T12:01:00.000Z" });
    assert.equal(proved.proof.proof_class, "P3");
    assert.equal(proved.proof.accepted_history.violated, 1);
    const hit = proved.proof.replay_receipts.find((receipt) => receipt.leg === "accepted_history" && receipt.result === "violated")!;
    assert.equal(hit.commit, historicalViolation);
    assert.equal(service.historyDispositions(policy.id, { publicOnly: true }).violations[0]?.disposition, null);
    assert.throws(() => service.classifyHistory(policy.id, historicalViolation, "true_positive_actionable", "model:auto", "machine guess"), /explicit human actor/);
    assert.throws(() => service.classifyHistory(policy.id, fix, "true_positive_actionable", "human:owner", "not a violated history receipt"), /no violated accepted-history receipt/);

    const falsePositive = service.classifyHistory(
      policy.id,
      historicalViolation,
      "false_positive_selector",
      "github:reviewer",
      "Selector overmatched a historical alias.",
      { now: "2026-07-11T12:02:00.000Z" },
    );
    assert.ok(existsSync(join(root, ".hunch/dispositions", `${falsePositive.id}.json`)));
    assert.throws(() => service.repository.putDisposition({ ...falsePositive, created_at: "2026-07-11T12:02:01.000Z" }, policy.id), /content hash mismatch/, "audit timestamps are hash-bound");
    assert.equal(service.classifyHistory(policy.id, historicalViolation, "false_positive_selector", "github:reviewer", "Selector overmatched a historical alias.", { now: "2026-07-11T12:02:30.000Z" }).id, falsePositive.id, "same canonical judgment is idempotent");
    assert.throws(() => service.approve(policy.id, "blocking", "human:owner", { now: "2026-07-11T12:03:00.000Z" }), /human-classified accepted-history false positive/);
    assert.match(service.card(policy.id).authority.blocking_evidence_error ?? "", /false positive/);

    const acceptedException = service.classifyHistory(
      policy.id,
      historicalViolation,
      "true_positive_accepted_exception",
      "human:owner",
      "The legacy migration was intentionally accepted.",
      { now: "2026-07-11T12:04:00.000Z", supersedes: falsePositive.id },
    );
    assert.throws(() => service.approve(policy.id, "blocking", "human:owner", { now: "2026-07-11T12:04:30.000Z" }), /requires separately proved parent\/exception composition/);

    const actionable = service.classifyHistory(
      policy.id,
      historicalViolation,
      "true_positive_actionable",
      "human:owner",
      "Confirmed real historical violation; future recurrence should be blocked.",
      { now: "2026-07-11T12:05:00.000Z", supersedes: acceptedException.id },
    );
    assert.throws(() => service.classifyHistory(policy.id, historicalViolation, "unknown_insufficient_parser", "human:owner", "branch attempt", { supersedes: falsePositive.id }), /pass --supersedes/);
    const view = service.historyDispositions(policy.id, { publicOnly: true });
    assert.deepEqual(view.current.map((record) => record.id), [actionable.id]);
    assert.equal(view.audit.length, 3);
    assert.equal(view.violations[0]?.disposition?.classification, "true_positive_actionable");
    const spoofed = { ...proved.proof, accepted_history: { ...proved.proof.accepted_history, classified_hits: ["spoof"] } };
    assert.match(blockingEvidenceError(spoofed, []) ?? "", /unclassified/, "hand-edited classified_hits cannot replace disposition records");

    const activated = service.approve(policy.id, "blocking", "human:owner", { now: "2026-07-11T12:06:00.000Z" });
    assert.equal(activated.state, "active_blocking");
    assert.equal(activated.authority?.actor, "human:owner", "actionable disposition clears evidence review but never substitutes for activation authority");
    assert.equal(service.evaluate({ id: policy.id })[0]!.strict_error, false);
    service.classifyHistory(
      policy.id,
      historicalViolation,
      "false_positive_semantics",
      "human:owner",
      "Later review found evaluator semantics were wrong; retract the gate immediately.",
      { now: "2026-07-11T12:07:00.000Z", supersedes: actionable.id },
    );
    const retracted = service.evaluate({ id: policy.id })[0]!;
    assert.equal(retracted.blocks, false);
    assert.equal(retracted.strict_error, true);
    assert.match(retracted.gate_error ?? "", /human-classified accepted-history false positive/);
  } finally {
    cleanup();
  }
});

test("Phase 2M parent and scoped exceptions produce one exact composite proof receipt", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    const introduced = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
    const acceptedException = commitFiles(root, ["src/api/orders.ts"], "fixture: accepted legacy direct persistence");
    writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\n// legacy endpoint\nexport function listOrders(u){ return dbQuery(u); }\n');
    commitFiles(root, ["src/api/orders.ts"], "fixture: retain legacy exception at current baseline");
    store.json.put("decisions", { ...decision("dec_composite_exception"), commit: introduced });
    indexRepo(store, root, { churn: false });
    store.reindex();
    const service = new ConstitutionService(store, root);
    const base = service.compile("dec_composite_exception", { now: NOW });
    assert.equal(base.assertion.kind, "not-reaches");
    const parent = PolicySpecSchema.parse({
      ...base,
      id: "pol_a1a1a1a1a1",
      scope: { repos: [], paths: ["src/api/**"], components: [] },
    });
    const child = PolicySpecSchema.parse({
      ...parent,
      id: "pol_b1b1b1b1b1",
      scope: { repos: [], paths: ["src/api/orders.ts"], components: [] },
      assertion: { ...parent.assertion, kind: "reaches" },
      exception_of: null,
    });
    service.repository.putPolicy(parent);
    service.repository.putPolicy(child);
    const linked = service.linkException(child.id, parent.id, "human:architect", "The legacy orders endpoint intentionally reaches persistence directly.", { now: "2026-07-11T13:00:00.000Z" });

    const standalone = evaluatePolicyOnSnapshot(parent, graphSnapshot(store, root));
    assert.equal(standalone.result, "violated", "the broad parent alone still sees the accepted exception as a violation");
    const composite = evaluateCompositePolicyOnSnapshot(parent, [linked], graphSnapshot(store, root));
    assert.equal(composite.result, "satisfied");
    assert.equal(composite.composition?.selected_policy_id, linked.id);
    assert.deepEqual(composite.composition?.applicable_policy_ids, [parent.id, linked.id]);

    const proved = service.prove(parent.id, { now: "2026-07-11T13:01:00.000Z" });
    const plan = service.repository.listPlans({ publicOnly: true }).find((candidate) => candidate.content_hash === proved.proof.plan_hash)!;
    const compositeHash = policyProofHash(parent, [linked]);
    assert.equal(plan.policy_candidate_hash, compositeHash);
    assert.equal(plan.composition?.composite_hash, compositeHash);
    assert.deepEqual(proved.proof.composition, plan.composition);
    assert.equal(proved.proof.policy_hash, compositeHash);
    assert.equal(proved.proof.current.satisfied, 1);
    assert.equal(proved.proof.proof_class, "P3");
    assert.equal(proved.proof.mutation_receipts.find((receipt) => receipt.kind === "primary")?.operator, "remove-required-path");
    assert.equal(proved.proof.mutation_receipts.find((receipt) => receipt.kind === "primary")?.passed, true);
    const historical = proved.proof.replay_receipts.find((receipt) => receipt.leg === "accepted_history" && receipt.commit === acceptedException)!;
    assert.equal(historical.result, "satisfied", "the exact narrow exception resolves the parent's historical hit through composition");
    assert.equal(historical.policy_hash, compositeHash);
    assert.equal(proved.proof.replay_receipts.every((receipt) => receipt.policy_hash === compositeHash), true);
    assert.throws(
      () => service.repository.putProof(PolicyProofSchema.parse({
        ...proved.proof,
        composition: { ...proved.proof.composition!, root_policy_hash: canonicalHash("tampered parent") },
      }), parent.id),
      /current parent\/exception composition/,
      "repository writes independently reject a tampered composite binding",
    );

    const activated = service.approve(parent.id, "blocking", "human:architect", { now: "2026-07-11T13:02:00.000Z" });
    assert.equal(activated.state, "active_blocking", "proof readiness still requires a separate human activation event");
    assert.equal(service.evaluate({ id: parent.id })[0]?.blocks, false);

    const second = PolicySpecSchema.parse({
      ...child,
      id: "pol_c1c1c1c1c1",
      scope: { repos: [], paths: ["src/api/other.ts"], components: [] },
      exception_of: null,
    });
    service.repository.putPolicy(second);
    service.linkException(second.id, parent.id, "human:architect", "A second explicit exception changes the composite semantics.", { now: "2026-07-11T13:03:00.000Z" });
    const stale = service.evaluate({ id: parent.id })[0]!;
    assert.equal(stale.blocks, false);
    assert.equal(stale.strict_error, true);
    assert.match(stale.gate_error ?? "", /current parent\/exception composition/);
  } finally {
    cleanup();
  }
});

test("Phase 2N shadow outcomes are append-only, disposition-bound, and precision-only", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_shadow_precision"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const compiled = service.compile("dec_shadow_precision", { now: NOW });
    const proved = service.prove(compiled.id, { now: "2026-07-11T14:00:00.000Z" });
    assert.equal(proved.proof.proof_class, "P3");

    const baseline = service.recordShadow(compiled.id, { now: "2026-07-11T14:01:00.000Z", latencyMs: 7 });
    assert.equal(baseline.evaluation.result, "satisfied");
    assert.ok(existsSync(join(root, ".hunch/shadow", `${baseline.id}.json`)));
    assert.throws(() => service.classifyShadow(compiled.id, baseline.id, "true_positive_actionable", "human:owner", "not a violation"), /only to violated/);

    writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
    commitFiles(root, ["src/api/orders.ts"], "fixture: shadow direct persistence violation");
    indexRepo(store, root, { churn: false });
    store.reindex();
    const violation = service.recordShadow(compiled.id, { now: "2026-07-11T14:02:00.000Z", latencyMs: 9 });
    assert.equal(violation.evaluation.result, "violated");
    assert.equal(service.recordShadow(compiled.id, { now: "2026-07-11T14:03:00.000Z", latencyMs: 99 }).id, violation.id, "same exact evaluation cannot inflate the denominator");

    const falsePositive = service.classifyShadow(
      compiled.id,
      violation.id,
      "false_positive_semantics",
      "human:owner",
      "The first judgment was intentionally pessimistic for the fixture.",
      { now: "2026-07-11T14:04:00.000Z" },
    );
    assert.throws(
      () => service.repository.putShadowEvaluation({ ...violation, observed_at: "2026-07-11T14:04:01.000Z" }, compiled.id),
      /content hash mismatch/,
    );
    const blocked = service.shadowReport(compiled.id, { minApplicable: 2 });
    assert.deepEqual(blocked.counts, {
      total: 2,
      applicable: 2,
      satisfied: 1,
      violated: 1,
      not_applicable: 0,
      unknown: 0,
      error: 0,
      stale_excluded: 0,
    });
    assert.equal(blocked.precision.confirmed, 0);
    assert.equal(blocked.precision.lower_bound, 0);
    assert.equal(blocked.recommendation, "not_ready");
    assert.match(blocked.reasons.join("\n"), /confirmed false positive/);
    const shadowCard = service.card(compiled.id);
    assert.equal(shadowCard.shadow_precision?.counts.total, 2);
    assert.match(renderProofCard(shadowCard), /shadow: 2 recent applicable/);

    const actionable = service.classifyShadow(
      compiled.id,
      violation.id,
      "true_positive_actionable",
      "human:owner",
      "Confirmed after reviewing the exact graph receipt.",
      { now: "2026-07-11T14:05:00.000Z", supersedes: falsePositive.id },
    );
    const ready = service.shadowReport(compiled.id, { minApplicable: 2 });
    assert.equal(ready.precision.confirmed, 1);
    assert.equal(ready.precision.lower_bound, 1);
    assert.equal(ready.recommendation, "eligible_for_p4_review");
    assert.equal(service.get(compiled.id).state, "proposed");
    assert.equal(service.get(compiled.id).authority, null, "shadow readiness never activates policy authority");
    assert.throws(
      () => service.classifyShadow(compiled.id, violation.id, "false_positive_selector", "human:owner", "branched correction", { now: "2026-07-11T14:06:00.000Z", supersedes: falsePositive.id }),
      new RegExp(`current disposition ${actionable.id}`),
    );

    rmSync(join(root, "src/db/client.ts"));
    commitFiles(root, ["src/db/client.ts"], "fixture: shadow unknown binding");
    indexRepo(store, root, { churn: false });
    store.reindex();
    const unknown = service.recordShadow(compiled.id, { now: "2026-07-11T14:07:00.000Z", latencyMs: 11 });
    assert.equal(unknown.evaluation.result, "unknown");
    const uncertain = service.shadowReport(compiled.id, { minApplicable: 2 });
    assert.equal(uncertain.recommendation, "not_ready");
    assert.match(uncertain.reasons.join("\n"), /unknown\/error rate/);
  } finally {
    cleanup();
  }
});

test("Phase 2Q G2 shadow sweep is real-state deduplicated, retry-safe, private, and review-bounded", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-g2-shadow/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putPrivate("decisions", decision("dec_g2_shadow", { private: true }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const compiled = service.compile("dec_g2_shadow", { through: "fetchOrders", now: NOW });
    const proved = service.prove(compiled.id, { now: "2026-07-11T11:00:00.000Z" });
    const policyIds = [proved.policy.id];
    for (let index = 1; index < 10; index += 1) {
      const id = `pol_${index.toString(16).padStart(10, "0")}`;
      policyIds.push(id);
      service.repository.putPolicy(PolicySpecSchema.parse({
        ...proved.policy,
        id,
        topic: `g2-shadow-${index}`,
        statement: `G2 unproved fixture ${index}`,
        state: "compiled",
        proof: null,
        authority: null,
        audit: [],
      }), { private: true });
    }
    const runbooks = Object.fromEntries([
      "evaluator_error",
      "false_positive",
      "private_leak",
      "stale_policy",
      "provider_outage",
      "corrupt_graph",
      "adapter_break",
    ].map((category) => {
      const id = `rb_g2_${category}`;
      store.putPrivate("runbooks", {
        id,
        task: `Recover from ${category}`,
        trigger: [category],
        steps: ["Detect.", "Recover."],
        files: [],
        gotchas: [],
        outcome: "Recovery demonstrated.",
        source_range: null,
        valid_from: NOW,
        valid_to: null,
        provenance: { source: "human_confirmed", confidence: 1, evidence: ["test"] },
        date: NOW,
      } as Runbook);
      return [category, id];
    })) as Record<"evaluator_error" | "false_positive" | "private_leak" | "stale_policy" | "provider_outage" | "corrupt_graph" | "adapter_break", string>;
    const g2Plan = service.createG2Plan({ policy_ids: policyIds, runbooks, actor: "human:g2-owner", reason: "Test exact shadow operation." }, { now: "2026-07-11T11:01:00.000Z" });

    const first = service.g2ShadowSweep({ now: "2026-07-11T11:02:00.000Z" });
    assert.equal(first.selected, 10);
    assert.equal(first.recorded.length, 1);
    assert.equal(first.existing.length, 0);
    assert.equal(first.failures.length, 9, "one unproved policy cannot suppress another policy's real observation");
    assert.equal(first.authority, "none");
    assert.equal(existsSync(join(root, ".hunch/shadow")), false);
    assert.ok(existsSync(join(privateRoot, "shadow", `${first.recorded[0]}.json`)));

    const retry = service.g2ShadowSweep({ now: "2026-07-11T11:03:00.000Z" });
    assert.equal(retry.recorded.length, 0);
    assert.deepEqual(retry.existing, first.recorded, "same HEAD and graph are idempotent even when observed_at changes");
    assert.equal(retry.failures.length, 9);
    assert.equal(service.g2ShadowQueue(5).total_unclassified, 0);

    writeFileSync(join(root, "src/api/orders.ts"), 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n');
    commitFiles(root, ["src/api/orders.ts"], "fixture: real G2 shadow change");
    const projectRoot = process.cwd();
    const syncRun = spawnSync(process.execPath, [join(projectRoot, "node_modules/tsx/dist/cli.mjs"), join(projectRoot, "src/cli/index.ts"), "sync", "HEAD", "--quiet", "--no-commit"], {
      cwd: root,
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.equal(syncRun.status, 0, syncRun.stderr);
    const exactObservations = service.repository.listShadowEvaluations({ privateOnly: true }).filter((record) => record.policy_id === proved.policy.id);
    assert.equal(exactObservations.length, 2, "post-commit sync adds one observation for the changed real HEAD/graph");
    const queue = service.g2ShadowQueue(1);
    assert.equal(queue.total_unclassified, 1);
    assert.equal(queue.items.length, 1);
    assert.equal(queue.has_more, false);
    assert.equal(queue.items[0]?.policy_id, proved.policy.id);
    assert.equal(queue.items[0]?.result, "violated");
    assert.equal(queue.authority, "none");
    assert.throws(() => service.g2ShadowQueue(0), /positive integer/i);

    service.classifyShadow(proved.policy.id, queue.items[0]!.shadow_id, "true_positive_actionable", "human:reviewer", "Real bypass in the changed graph.", { now: "2026-07-11T11:05:00.000Z" });
    assert.equal(service.g2ShadowQueue(5).total_unclassified, 0, "a current human disposition removes the item immediately");

    const planFile = join(privateRoot, "gates", `${g2Plan.id}.json`);
    const tampered = JSON.parse(readFileSync(planFile, "utf8"));
    tampered.reason = "tampered plan";
    writeFileSync(planFile, JSON.stringify(tampered));
    writeFileSync(join(root, "src/api/orders.ts"), `${readFileSync(join(root, "src/api/orders.ts"), "utf8")}\n// another real commit\n`);
    commitFiles(root, ["src/api/orders.ts"], "fixture: corrupt G2 plan must not block sync");
    const corruptPlanSync = spawnSync(process.execPath, [join(projectRoot, "node_modules/tsx/dist/cli.mjs"), join(projectRoot, "src/cli/index.ts"), "sync", "HEAD", "--quiet", "--no-commit"], {
      cwd: root,
      env: { ...process.env, HUNCH_SYNTH_PROVIDER: "deterministic" },
      encoding: "utf8",
    });
    assert.equal(corruptPlanSync.status, 0, "corrupt private G2 evidence never blocks the post-commit learning path");
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2R G2 candidate review separates human grounding from structural coincidence without writes", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-g2-candidates/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));

  writeFileSync(join(root, "src/global.ts"), "export function resolve(id){ return id; }\n");
  commitFiles(root, ["src/global.ts"], "chore: add unrelated resolver");
  writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\nexport function guardedOrders(){ return fetchOrders("guarded"); }\n');
  writeFileSync(join(root, "src/provider.ts"), 'export function execute(){ return new Promise((resolve) => resolve("ok")); }\n');
  const groundedCommit = commitFiles(root, ["src/api/orders.ts", "src/provider.ts"], "fix: guardedOrders must call fetchOrders");
  writeFileSync(join(root, "src/api/orders.ts"), `${readFileSync(join(root, "src/api/orders.ts"), "utf8")}export function auditedOrders(){ return fetchOrders("audited"); }\n`);
  const unattestedCommit = commitFiles(root, ["src/api/orders.ts"], "fix: add audited order path");

  const store = new HunchStore(hunchPaths(root));
  try {
    store.putPrivate("decisions", {
      ...decision("dec_g2_candidate", { private: true }),
      title: "guardedOrders must call fetchOrders",
      context: "A real fix introduced guardedOrders and its fetchOrders call.",
      decision: "Keep guardedOrders calling fetchOrders.",
      related_files: ["src/api/orders.ts", "src/services/orders.ts"],
      commit: groundedCommit,
    });
    indexRepo(store, root, { churn: false });
    const publicSymbols = store.json.loadAll("symbols");
    const execute = publicSymbols.find((symbol) => symbol.file === "src/provider.ts" && symbol.name === "execute")!;
    const unrelatedResolve = publicSymbols.find((symbol) => symbol.file === "src/global.ts" && symbol.name === "resolve")!;
    store.putPrivate("edges", {
      id: "edge_stale_private_resolve",
      from: execute.id,
      to: unrelatedResolve.id,
      type: "calls",
      reason: "stale private graph incorrectly linked callback resolve",
      strength: 0.8,
      provenance: { source: "extracted", confidence: 0.8, evidence: ["stale-private-index"] },
    });
    store.reindex();
    const service = new ConstitutionService(store, root);
    const beforePolicies = service.repository.listPolicies({ privateOnly: true }).length;
    const beforeEvidence = service.repository.listEvidence({ privateOnly: true }).length;
    const beforeGraph = canonicalJson({
      symbols: store.json.loadAll("symbols"),
      edges: store.json.loadAll("edges"),
      components: store.json.loadAll("components"),
    });

    const report = service.g2CandidateReview({ since: "30d", maxCommits: 20, limit: 20 });
    assert.match(report.id, /^g2candidates_[a-f0-9]{10}$/);
    assert.match(report.content_hash, /^sha1:[a-f0-9]{40}$/);
    assert.equal(report.authority, "none");
    assert.equal(report.writes, "none");
    assert.equal(report.proof_status, "not_run");
    assert.ok(report.items.some((item) => item.commit === groundedCommit && item.attestation.status === "human_grounded_needs_selection"));
    assert.ok(report.items.some((item) => item.commit === unattestedCommit && item.attestation.status === "unattested_structural_coincidence"));
    assert.equal(report.items.some((item) => item.reason.includes("execute -> resolve")), false, "stale private derived edges cannot manufacture public-code candidates");
    assert.ok(report.items.filter((item) => item.commit === groundedCommit && item.reason.includes("guardedOrders")).every((item) => item.attestation.decision_ids.includes("dec_g2_candidate")));
    assert.ok(report.items.every((item) => item.proposed_corpus.known_bad.ref !== item.proposed_corpus.known_good.ref));
    assert.ok(report.items.every((item) => item.proposed_corpus.observed === false));
    assert.deepEqual(service.g2CandidateReview({ since: "30d", maxCommits: 20, limit: 20 }), report, "same repository and bounds yield a byte-stable review packet");

    const bounded = service.g2CandidateReview({ since: "30d", maxCommits: 20, limit: 1 });
    assert.equal(bounded.items.length, 1);
    assert.equal(bounded.has_more, true);
    assert.notEqual(bounded.items[0]?.attestation.status, "unattested_structural_coincidence", "human-grounded review work ranks ahead of coincidence");
    assert.throws(() => service.g2CandidateReview({ since: "30d", maxCommits: 0, limit: 1 }), /positive integer/i);
    assert.equal(service.repository.listPolicies({ privateOnly: true }).length, beforePolicies);
    assert.equal(service.repository.listEvidence({ privateOnly: true }).length, beforeEvidence);
    assert.equal(canonicalJson({
      symbols: store.json.loadAll("symbols"),
      edges: store.json.loadAll("edges"),
      components: store.json.loadAll("components"),
    }), beforeGraph, "candidate review leaves the workspace graph byte-stable");
    assert.equal(existsSync(join(privateRoot, "policies")), false);
    assert.equal(existsSync(join(privateRoot, "evidence")), false);
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2S G2 candidate attestations are exact, append-only, private, and non-authoritative", async () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-g2-attestations/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));

  writeFileSync(join(root, "src/api/orders.ts"), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\nexport function guardedOrders(){ return fetchOrders("guarded"); }\n');
  const groundedCommit = commitFiles(root, ["src/api/orders.ts"], "fix: guardedOrders must call fetchOrders");
  const store = new HunchStore(hunchPaths(root));
  let client: Client | null = null;
  try {
    store.putPrivate("decisions", {
      ...decision("dec_g2_attestation", { private: true }),
      title: "guardedOrders must call fetchOrders",
      context: "The fixing commit introduced the exact guarded order path.",
      decision: "Keep guardedOrders calling fetchOrders.",
      related_files: ["src/api/orders.ts", "src/services/orders.ts"],
      commit: groundedCommit,
    });
    const service = new ConstitutionService(store, root);
    const bounds = { since: "30d", maxCommits: 20, limit: 20 };
    const beforePolicies = service.repository.listPolicies({ privateOnly: true }).length;
    const beforeEvidence = service.repository.listEvidence({ privateOnly: true }).length;
    const review = service.g2CandidateReview(bounds);
    const candidate = review.items.find((item) => item.reason.includes("guardedOrders -> fetchOrders"))!;
    assert.ok(candidate, "the exact reviewed call candidate is present");
    assert.equal(candidate.human_review, null);
    assert.throws(
      () => service.attestG2Candidate(candidate.id, review.content_hash, "selected", "model:hunch", "model choice", { ...bounds, now: "2026-07-11T16:00:00.000Z" }),
      /explicit human actor/i,
    );

    const selected = service.attestG2Candidate(
      candidate.id,
      review.content_hash,
      "selected",
      "human:reviewer",
      "This exact call expresses the durable reviewed intent.",
      { ...bounds, now: "2026-07-11T16:01:00.000Z" },
    );
    assert.match(selected.id, /^g2attest_[a-f0-9]{10}$/);
    assert.equal(selected.candidate_id, candidate.id);
    assert.equal(selected.structural_candidate_id, candidate.candidate_id);
    assert.equal(selected.review_hash, review.content_hash);
    assert.equal(selected.disposition, "selected");
    assert.equal(selected.authority, "none");
    assert.equal(selected.effects, "review_only");
    assert.ok(existsSync(join(privateRoot, "candidate-attestations", `${selected.id}.json`)));
    assert.equal(existsSync(join(root, ".hunch/candidate-attestations")), false);
    const retried = service.attestG2Candidate(
      candidate.id,
      review.content_hash,
      "selected",
      "human:reviewer",
      "This exact call expresses the durable reviewed intent.",
      { ...bounds, now: "2026-07-11T16:01:30.000Z" },
    );
    assert.equal(retried.id, selected.id, "an exact retry after a lost response returns the existing immutable append");

    const afterSelected = service.g2CandidateReview(bounds);
    const selectedItem = afterSelected.items.find((item) => item.id === candidate.id)!;
    assert.equal(selectedItem.human_review?.id, selected.id);
    assert.equal(selectedItem.human_review?.disposition, "selected");
    assert.throws(
      () => service.attestG2Candidate(candidate.id, afterSelected.content_hash, "rejected", "human:reviewer", "missing supersession", { ...bounds, now: "2026-07-11T16:02:00.000Z" }),
      /current.*supersedes/i,
    );
    assert.throws(
      () => service.attestG2Candidate("g2candidate_0000000000", afterSelected.content_hash, "selected", "human:reviewer", "unknown", { ...bounds, now: "2026-07-11T16:02:00.000Z" }),
      /not present in review/i,
    );
    assert.throws(
      () => service.attestG2Candidate(candidate.id, review.content_hash, "rejected", "human:reviewer", "stale packet", { ...bounds, now: "2026-07-11T16:02:00.000Z", supersedes: selected.id }),
      /review hash does not match/i,
    );

    const rejected = service.attestG2Candidate(
      candidate.id,
      afterSelected.content_hash,
      "rejected",
      "human:reviewer",
      "Correction: existence is durable, but this exact call edge is incidental.",
      { ...bounds, now: "2026-07-11T16:03:00.000Z", supersedes: selected.id },
    );
    assert.equal(rejected.supersedes, selected.id);
    assert.equal(existsSync(join(privateRoot, "candidate-attestations", `${selected.id}.json`)), true, "superseded review remains append-only history");
    const afterRejected = service.g2CandidateReview(bounds);
    assert.equal(afterRejected.items.find((item) => item.id === candidate.id)?.human_review?.disposition, "rejected");
    assert.throws(
      () => service.attestG2Candidate(candidate.id, review.content_hash, "selected", "human:reviewer", "This exact call expresses the durable reviewed intent.", { ...bounds, now: "2026-07-11T16:03:30.000Z" }),
      /review hash does not match/i,
      "an old exact request stops being retryable after its attestation is superseded",
    );
    assert.throws(
      () => service.attestG2Candidate(candidate.id, afterRejected.content_hash, "selected", "human:reviewer", "branched correction", { ...bounds, now: "2026-07-11T16:04:00.000Z", supersedes: selected.id }),
      /current.*supersedes|branched/i,
    );
    assert.equal(service.repository.listPolicies({ privateOnly: true }).length, beforePolicies);
    assert.equal(service.repository.listEvidence({ privateOnly: true }).length, beforeEvidence);
    assert.equal(existsSync(join(privateRoot, "policies")), false);
    assert.equal(existsSync(join(privateRoot, "evidence")), false);

    const secondCandidate = afterRejected.items.find((item) => item.id !== candidate.id && item.reason.includes("guardedOrders"))!;
    assert.ok(secondCandidate, "a second exact sibling candidate is available for the CLI adapter check");
    const cliRun = spawnSync(process.execPath, [
      join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      join(process.cwd(), "src/cli/index.ts"),
      "constitution", "g2",
      "--attest", secondCandidate.id,
      "--review-hash", afterRejected.content_hash,
      "--disposition", "selected",
      "--actor", "human:cli-reviewer",
      "--reason", "The introduced symbol itself is the durable reviewed meaning.",
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const cliOutput = JSON.parse(cliRun.stdout) as { appended: { candidate_id: string; disposition: string; authority: string }; review: { content_hash: string } };
    assert.equal(cliOutput.appended.candidate_id, secondCandidate.id);
    assert.equal(cliOutput.appended.disposition, "selected");
    assert.equal(cliOutput.appended.authority, "none");
    assert.notEqual(cliOutput.review.content_hash, afterRejected.content_hash, "the read receipt now binds the appended review status");

    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const cli = join(process.cwd(), "src/cli/index.ts");
    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: root });
    client = new Client({ name: "g2-candidate-attestation-test", version: "1.0.0" });
    await client.connect(transport);
    const mcpCall = await client.callTool({
      name: "hunch_constitution_g2_candidates",
      arguments: { since: bounds.since, max_commits: bounds.maxCommits, limit: bounds.limit },
    });
    const mcpReview = JSON.parse((mcpCall.content[0] as { type: "text"; text: string }).text) as {
      content_hash: string;
      items: Array<{ id: string; human_review: { disposition: string } | null }>;
    };
    assert.equal(mcpReview.content_hash, cliOutput.review.content_hash, "CLI and read-only MCP expose the identical resolved review receipt");
    assert.equal(mcpReview.items.find((item) => item.id === candidate.id)?.human_review?.disposition, "rejected");
    assert.equal(mcpReview.items.find((item) => item.id === secondCandidate.id)?.human_review?.disposition, "selected");
    await client.close();
    client = null;

    const file = join(privateRoot, "candidate-attestations", `${rejected.id}.json`);
    const tampered = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    tampered.reason = "tampered in place";
    writeFileSync(file, JSON.stringify(tampered));
    assert.throws(() => service.g2CandidateReview(bounds), /content hash mismatch/i);
  } finally {
    if (client) await client.close();
    store.close();
    cleanup();
  }
});

test("Phase 2Y direct decision replay executes regex-punctuated test names exactly", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    writeFileSync(join(root, "src/direct.mjs"), "export function guarded(){ return false; }\n");
    commitFiles(root, ["src/direct.mjs"], "fixture: direct behavior baseline");
    writeFileSync(join(root, "src/direct.mjs"), "export function guarded(){ return true; }\n");
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test/direct.test.mjs"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { guarded } from "../src/direct.mjs";',
      'test("guarded path validates behavior (exact)", () => assert.equal(guarded(), true));',
      "",
    ].join("\n"));
    const fix = commitFiles(root, ["src/direct.mjs", "test/direct.test.mjs"], "fix: direct exact behavior");
    store.json.put("decisions", {
      ...decision("dec_g2_exact_name"),
      title: "Execute exact decision-grounded regression",
      context: "Regex punctuation in a test name must never turn zero execution into a pass.",
      decision: "The exact selected regression must produce one real pass or fail event.",
      related_files: ["src/direct.mjs", "test/direct.test.mjs"],
      commit: fix,
    });
    const service = new ConstitutionService(store, root);
    const opts = { decisionId: "dec_g2_exact_name", since: "30d", maxCommits: 10, limit: 10 };
    const review = service.g2BehaviorCandidateReview(opts);
    assert.equal(review.items.length, 1);
    const candidate = review.items[0]!;
    assert.equal(candidate.runner.argv[2], "--test-name-pattern=^guarded path validates behavior \\(exact\\)$");
    const replay = service.g2BehaviorCandidateReplay(candidate.id, review.content_hash, opts);
    assert.equal(replay.known_bad.result, "failed");
    assert.equal(replay.known_good.result, "passed");
    assert.equal(replay.verdict, "behavior_confirmed");
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2Z direct decision review captures assertions added to an existing named test", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "src/direct.mjs"), "export function outcome(){ return null; }\n");
    writeFileSync(join(root, "test/direct.test.mjs"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { outcome } from "../src/direct.mjs";',
      'test("reports the actual outcome", () => {',
      '  outcome();',
      '  assert.ok(true);',
      '});',
      "",
    ].join("\n"));
    commitFiles(root, ["src/direct.mjs", "test/direct.test.mjs"], "fixture: existing behavior baseline");
    writeFileSync(join(root, "src/direct.mjs"), 'export function outcome(){ return "committed"; }\n');
    writeFileSync(join(root, "test/direct.test.mjs"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { outcome } from "../src/direct.mjs";',
      'const documentation = \'test("not a registered test", () => {})\';',
      'test("reports the actual outcome", () => {',
      '  const result = outcome();',
      '  assert.equal(result, "committed");',
      '});',
      "",
    ].join("\n"));
    const fix = commitFiles(root, ["src/direct.mjs", "test/direct.test.mjs"], "fix: report actual outcome");
    store.json.put("decisions", {
      ...decision("dec_g2_modified_test"),
      title: "Prove an existing regression strengthened by the fix",
      context: "The fixing commit adds its durable assertion inside a pre-existing named test.",
      decision: "Modified existing tests are executable behavior candidates when the fixing diff adds a line inside the exact test call.",
      related_files: ["src/direct.mjs", "test/direct.test.mjs"],
      commit: fix,
    });
    const service = new ConstitutionService(store, root);
    const opts = { decisionId: "dec_g2_modified_test", since: "30d", maxCommits: 10, limit: 10 };
    const review = service.g2BehaviorCandidateReview(opts);
    assert.equal(review.items.length, 1);
    const candidate = review.items[0]!;
    assert.equal(candidate.test.name, "reports the actual outcome");
    assert.doesNotMatch(candidate.test.name, /not a registered test/);
    assert.equal(candidate.grounding, "human_decision_plus_modified_test");
    assert.match(review.limitations[0]!, /existing literal-named cases/i);
    const replay = service.g2BehaviorCandidateReplay(candidate.id, review.content_hash, opts);
    assert.equal(replay.known_bad.result, "failed");
    assert.equal(replay.known_good.result, "passed");
    assert.equal(replay.verdict, "behavior_confirmed");
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2Z direct decision review decodes escaped literal test names exactly", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    writeFileSync(join(root, "src/direct.mjs"), "export function guarded(){ return false; }\n");
    commitFiles(root, ["src/direct.mjs"], "fixture: escaped-name baseline");
    writeFileSync(join(root, "src/direct.mjs"), "export function guarded(){ return true; }\n");
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test/direct.test.mjs"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { guarded } from "../src/direct.mjs";',
      'test("escaped \\u0028exact\\u0029", () => assert.equal(guarded(), true));',
      "",
    ].join("\n"));
    const fix = commitFiles(root, ["src/direct.mjs", "test/direct.test.mjs"], "fix: escaped exact behavior");
    store.json.put("decisions", {
      ...decision("dec_g2_escaped_name"),
      title: "Execute an escaped literal test name exactly",
      context: "The source spelling and registered node:test name differ when the literal contains JavaScript escapes.",
      decision: "Direct review decodes the literal to the runtime test name before exact replay.",
      related_files: ["src/direct.mjs", "test/direct.test.mjs"],
      commit: fix,
    });
    const service = new ConstitutionService(store, root);
    const opts = { decisionId: "dec_g2_escaped_name", since: "30d", maxCommits: 10, limit: 10 };
    const review = service.g2BehaviorCandidateReview(opts);
    assert.equal(review.items.length, 1);
    const candidate = review.items[0]!;
    assert.equal(candidate.test.name, "escaped (exact)");
    assert.equal(candidate.runner.argv[2], "--test-name-pattern=^escaped \\(exact\\)$");
    const replay = service.g2BehaviorCandidateReplay(candidate.id, review.content_hash, opts);
    assert.equal(replay.known_bad.result, "failed");
    assert.equal(replay.known_good.result, "passed");
    assert.equal(replay.verdict, "behavior_confirmed");
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2U/2V/2W/2X/2Y replays, attests, and proves exact executable behavior", async () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-g2-behavior/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));

  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "behavior-fixture",
    version: "1.0.0",
    type: "module",
    scripts: { preinstall: "node -e \"throw new Error('repository lifecycle script ran')\"" },
  }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: "behavior-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "behavior-fixture", version: "1.0.0" } },
  }));
  writeFileSync(join(root, "src/guard.mjs"), "export function guarded(){ return false; }\n");
  commitFiles(root, ["package.json", "package-lock.json", "src/guard.mjs"], "fixture: behavior baseline");
  writeFileSync(join(root, "src/guard.mjs"), "export function verify(){ return true; }\nexport function guarded(){ return verify(); }\n");
  writeFileSync(join(root, "test/guard.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { guarded } from "../src/guard.mjs";',
    'test("guarded path validates behavior", () => assert.equal(guarded(), true));',
    "",
  ].join("\n"));
  const fix = commitFiles(root, ["src/guard.mjs", "test/guard.test.mjs"], "fix: guarded path validates behavior");

  const store = new HunchStore(hunchPaths(root));
  let client: Client | null = null;
  try {
    store.putPrivate("decisions", {
      ...decision("dec_g2_behavior", { private: true }),
      title: "Guarded path validates behavior",
      context: "A regression test reproduces the unguarded result and passes after the fix.",
      decision: "The guarded path must validate before returning success.",
      related_files: ["src/guard.mjs", "test/guard.test.mjs"],
      commit: fix,
    });
    store.json.put("decisions", {
      ...decision("dec_g2_direct"),
      title: "Guarded path validates behavior directly",
      context: "The exact fixing commit added an executable regression for the human-confirmed behavior.",
      decision: "The guarded path must validate before returning success.",
      related_files: ["src/guard.mjs", "test/guard.test.mjs"],
      commit: fix,
    });
    const service = new ConstitutionService(store, root);
    const bounds = { since: "30d", maxCommits: 20, limit: 20 };
    const directBounds = { ...bounds, decisionId: "dec_g2_direct" };
    const directReview = service.g2BehaviorCandidateReview(directBounds);
    assert.equal(directReview.grounding_mode, "human_decision_plus_added_test");
    assert.equal(directReview.source_decision_id, "dec_g2_direct");
    assert.equal(directReview.items.length, 1);
    assert.equal(directReview.items[0]?.grounding, "human_decision_plus_added_test");
    assert.deepEqual(directReview.items[0]?.decision_ids, ["dec_g2_direct"]);
    assert.deepEqual(directReview.items[0]?.source_candidate_ids, []);
    assert.deepEqual(directReview.items[0]?.source_attestation_ids, []);
    const directReplay = service.g2BehaviorCandidateReplay(
      directReview.items[0]!.id,
      directReview.content_hash,
      directBounds,
    );
    assert.equal(directReplay.verdict, "behavior_confirmed");
    assert.equal(directReplay.known_bad.result, "failed");
    assert.equal(directReplay.known_good.result, "passed");

    const structural = service.g2CandidateReview(bounds);
    const proxy = structural.items.find((item) => item.commit === fix && item.attestation.decision_ids.includes("dec_g2_behavior"))!;
    assert.ok(proxy, "the human-grounded structural proxy is available for explicit rejection");
    service.attestG2Candidate(
      proxy.id,
      structural.content_hash,
      "rejected",
      "human:reviewer",
      "The executable regression is durable; this structural proxy is not.",
      { ...bounds, now: "2026-07-11T18:00:00.000Z" },
    );

    const review = service.g2BehaviorCandidateReview(bounds);
    assert.match(review.id, /^g2behaviorcandidates_[a-f0-9]{10}$/);
    assert.equal(review.authority, "none");
    assert.equal(review.writes, "none");
    assert.equal(review.proof_status, "not_run");
    assert.equal(review.items.length, 1);
    const candidate = review.items[0]!;
    assert.equal(candidate.test.file, "test/guard.test.mjs");
    assert.equal(candidate.test.name, "guarded path validates behavior");
    assert.deepEqual(candidate.source_attestation_ids.length, 1);
    assert.deepEqual(candidate.decision_ids, ["dec_g2_behavior"]);
    assert.equal(candidate.proposed_corpus.known_bad.expected, "failed");
    assert.equal(candidate.proposed_corpus.known_good.expected, "passed");
    assert.deepEqual(service.g2BehaviorCandidateReview(bounds), review, "behavior review is byte-stable");
    assert.equal(nodeTestInfrastructureError("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'legacy-db'"), "dependency-snapshot-unavailable");
    assert.equal(nodeTestInfrastructureError("Error: Could not locate the bindings file"), "dependency-snapshot-unavailable");
    assert.equal(nodeTestInfrastructureError("AssertionError: expected true"), null, "real assertion failures remain behavioral failures");

    assert.throws(
      () => service.g2BehaviorCandidateReplay(candidate.id, "sha1:" + "0".repeat(40), bounds),
      /review hash/i,
    );
    const replay = service.g2BehaviorCandidateReplay(candidate.id, review.content_hash, bounds);
    assert.match(replay.id, /^g2behaviorreplay_[a-f0-9]{10}$/);
    assert.equal(replay.candidate_id, candidate.id);
    assert.equal(replay.review_hash, review.content_hash);
    assert.equal(replay.known_bad.result, "failed");
    assert.equal(replay.known_good.result, "passed");
    assert.equal(replay.verdict, "behavior_confirmed");
    assert.equal(replay.authority, "none");
    assert.equal(replay.effects, "diagnostic_only");
    assert.equal(replay.writes, "disposable_only");
    assert.equal(replay.known_bad.dependency_snapshot_id, undefined, "replay does not install dependencies implicitly");
    assert.throws(
      () => service.attestG2BehaviorCandidate(
        candidate.id,
        review.content_hash,
        "selected",
        "human:reviewer",
        "must not select without an exact historical environment",
        bounds,
      ),
      /snapshot-backed behavior_confirmed replay/i,
    );
    assert.equal(existsSync(join(privateRoot, "policies")), false);
    assert.equal(existsSync(join(privateRoot, "evidence")), false);
    assert.deepEqual(readdirSync(join(root, ".hunch-cache/worktrees")), []);

    const snapshots = service.g2BehaviorDependencySnapshots(candidate.id, review.content_hash, {
      ...bounds,
      allowInstallScripts: [],
    });
    assert.equal(snapshots.authority, "none");
    assert.equal(snapshots.effects, "cache_only");
    assert.equal(snapshots.snapshots.length, 1, "identical bad/good lock inputs reuse one content-addressed snapshot");
    const cachedPackage = JSON.parse(readFileSync(join(root, ".hunch-cache/behavior-deps", snapshots.snapshots[0]!.id, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.deepEqual(cachedPackage.scripts, {}, "repository lifecycle scripts are stripped from the synthetic install root");
    assert.throws(
      () => service.g2BehaviorDependencySnapshots(candidate.id, review.content_hash, {
        ...bounds,
        allowInstallScripts: ["legacy-db; touch escaped"],
      }),
      /invalid dependency install-script package/,
    );
    assert.throws(
      () => service.g2BehaviorDependencySnapshots(candidate.id, "sha1:" + "0".repeat(40), bounds),
      /review hash/i,
    );
    assert.deepEqual(service.g2BehaviorDependencySnapshots(candidate.id, review.content_hash, {
      ...bounds,
      allowInstallScripts: [],
    }), snapshots, "an exact retry validates and reuses the immutable snapshot");

    const directSnapshots = service.g2BehaviorDependencySnapshots(
      directReview.items[0]!.id,
      directReview.content_hash,
      { ...directBounds, allowInstallScripts: [] },
    );
    assert.deepEqual(directSnapshots.snapshots.map((snapshot) => snapshot.id), snapshots.snapshots.map((snapshot) => snapshot.id));
    const directSelection = service.attestG2BehaviorCandidate(
      directReview.items[0]!.id,
      directReview.content_hash,
      "selected",
      "human:reviewer",
      "The decision-grounded executable regression proves the durable behavior without a structural proxy.",
      { ...directBounds, now: "2026-07-11T19:30:00.000Z" },
    );
    assert.equal(directSelection.disposition, "selected");
    const directAssessment = service.g2BehaviorMaterializationAssessment(directBounds);
    assert.equal(directAssessment.selected_attestations, 1);
    assert.equal(directAssessment.source_review.source_decision_id, "dec_g2_direct");

    const replayWithSnapshot = service.g2BehaviorCandidateReplay(candidate.id, review.content_hash, bounds);
    assert.equal(replayWithSnapshot.known_bad.dependency_snapshot_id, snapshots.snapshots[0]!.id);
    assert.equal(replayWithSnapshot.known_good.dependency_snapshot_id, snapshots.snapshots[0]!.id);
    assert.equal(replayWithSnapshot.verdict, "behavior_confirmed");
    assert.throws(
      () => service.g2BehaviorMaterializationAssessment(bounds),
      /every behavior candidate.*current human disposition/i,
      "an unresolved review cannot be materialized",
    );
    assert.deepEqual(
      readdirSync(join(root, ".hunch-cache/behavior-deps")).filter((entry) => entry.startsWith(".")),
      [],
      "snapshot builds and replay leave no mutable temp or identity directories",
    );

    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const cli = join(process.cwd(), "src/cli/index.ts");
    const cliDepsRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-deps", candidate.id,
      "--behavior-review-hash", review.content_hash,
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliDepsRun.status, 0, cliDepsRun.stderr);
    const cliDeps = JSON.parse(cliDepsRun.stdout) as { content_hash: string };
    assert.equal(cliDeps.content_hash, snapshots.content_hash, "CLI provisions the exact same cache-only receipt as the core service");

    const cliReviewRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-candidates", "20",
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliReviewRun.status, 0, cliReviewRun.stderr);
    const cliReview = JSON.parse(cliReviewRun.stdout) as { content_hash: string };
    assert.equal(cliReview.content_hash, review.content_hash, "CLI exposes the exact core behavior review receipt");
    const cliDirectReviewRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-candidates", "20",
      "--behavior-decision", "dec_g2_direct",
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliDirectReviewRun.status, 0, cliDirectReviewRun.stderr);
    const cliDirectReview = JSON.parse(cliDirectReviewRun.stdout) as { content_hash: string };
    const currentDirectReview = service.g2BehaviorCandidateReview(directBounds);
    assert.equal(cliDirectReview.content_hash, currentDirectReview.content_hash, "CLI exposes the exact current direct-decision review receipt");

    const cliReplayRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-replay", candidate.id,
      "--behavior-review-hash", review.content_hash,
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliReplayRun.status, 0, cliReplayRun.stderr);
    const cliReplay = JSON.parse(cliReplayRun.stdout) as { content_hash: string; verdict: string };
    assert.equal(cliReplay.content_hash, replayWithSnapshot.content_hash);
    assert.equal(cliReplay.verdict, "behavior_confirmed");

    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: root });
    client = new Client({ name: "g2-behavior-candidate-test", version: "1.0.0" });
    await client.connect(transport);
    const mcpReviewCall = await client.callTool({
      name: "hunch_constitution_g2_behavior_candidates",
      arguments: { since: bounds.since, max_commits: bounds.maxCommits, limit: bounds.limit },
    });
    const mcpReview = JSON.parse((mcpReviewCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(mcpReview.content_hash, review.content_hash, "MCP exposes the exact core behavior review receipt");
    const mcpDirectReviewCall = await client.callTool({
      name: "hunch_constitution_g2_behavior_candidates",
      arguments: { decision_id: "dec_g2_direct", since: bounds.since, max_commits: bounds.maxCommits, limit: bounds.limit },
    });
    const mcpDirectReview = JSON.parse((mcpDirectReviewCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(mcpDirectReview.content_hash, currentDirectReview.content_hash, "MCP exposes the exact current direct-decision review receipt");
    const mcpReplayCall = await client.callTool({
      name: "hunch_constitution_g2_behavior_replay",
      arguments: {
        candidate_id: candidate.id,
        review_hash: review.content_hash,
        since: bounds.since,
        max_commits: bounds.maxCommits,
        limit: bounds.limit,
      },
    });
    const mcpReplay = JSON.parse((mcpReplayCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string; verdict: string };
    assert.equal(mcpReplay.content_hash, replayWithSnapshot.content_hash, "MCP replay is byte-identical to core and CLI");
    assert.equal(mcpReplay.verdict, "behavior_confirmed");
    await client.close();
    client = null;

    const manifestFile = join(root, ".hunch-cache/behavior-deps", snapshots.snapshots[0]!.id, "manifest.json");
    const manifest = readFileSync(manifestFile, "utf8");
    const tamperedManifest = JSON.parse(manifest) as Record<string, unknown>;
    tamperedManifest.installed_lock_hash = "sha256:" + "0".repeat(64);
    writeFileSync(manifestFile, JSON.stringify(tamperedManifest));
    const replayAfterTamper = service.g2BehaviorCandidateReplay(candidate.id, review.content_hash, bounds);
    assert.equal(replayAfterTamper.known_bad.dependency_snapshot_id, undefined, "a tampered snapshot is never attached to replay");
    assert.equal(replayAfterTamper.known_good.dependency_snapshot_id, undefined, "tampering invalidates every leg sharing the snapshot");
    writeFileSync(manifestFile, manifest);

    const behaviorReason = "The executable regression proves the durable behavior without binding its implementation.";
    const behaviorSelection = service.attestG2BehaviorCandidate(
      candidate.id,
      review.content_hash,
      "selected",
      "human:reviewer",
      behaviorReason,
      { ...bounds, now: "2026-07-11T20:00:00.000Z" },
    );
    assert.match(behaviorSelection.id, /^g2behaviorattest_[a-f0-9]{10}$/);
    assert.equal(behaviorSelection.disposition, "selected");
    assert.equal(behaviorSelection.replay_hash, replayWithSnapshot.content_hash);
    assert.deepEqual(behaviorSelection.dependency_snapshot_ids, [snapshots.snapshots[0]!.id]);
    assert.equal(behaviorSelection.authority, "none");
    assert.equal(behaviorSelection.effects, "review_only");
    assert.equal(existsSync(join(privateRoot, "behavior-attestations", `${behaviorSelection.id}.json`)), true);
    assert.equal(existsSync(join(root, ".hunch/behavior-attestations")), false);
    const behaviorRetry = service.attestG2BehaviorCandidate(
      candidate.id,
      review.content_hash,
      "selected",
      "human:reviewer",
      behaviorReason,
      { ...bounds, now: "2026-07-11T20:01:00.000Z" },
    );
    assert.equal(behaviorRetry.id, behaviorSelection.id, "an exact lost-response retry returns the immutable behavior attestation");
    const afterBehaviorSelection = service.g2BehaviorCandidateReview(bounds);
    assert.equal(afterBehaviorSelection.selected_candidates, 1);
    assert.equal(afterBehaviorSelection.rejected_candidates, 0);
    assert.equal(afterBehaviorSelection.unreviewed_candidates, 0);
    assert.equal(afterBehaviorSelection.items[0]?.human_review?.id, behaviorSelection.id);
    const materialization = service.g2BehaviorMaterializationAssessment(bounds);
    assert.match(materialization.id, /^g2behaviormaterialization_[a-f0-9]{10}$/);
    assert.equal(materialization.source_review.id, afterBehaviorSelection.id);
    assert.equal(materialization.source_review.content_hash, afterBehaviorSelection.content_hash);
    assert.equal(materialization.selected_attestations, 1);
    assert.equal(materialization.materialized_policies, 0);
    assert.equal(materialization.readiness, "ready_for_materialization");
    assert.deepEqual(materialization.supported_assertion_kinds, ["executable-behavior", "exists", "must-pass-through", "not-reaches", "reaches"]);
    assert.equal(materialization.items[0]?.attestation_id, behaviorSelection.id);
    assert.equal(materialization.items[0]?.attestation_hash, behaviorSelection.content_hash);
    assert.equal(materialization.items[0]?.status, "ready_for_materialization");
    assert.match(materialization.items[0]?.reason ?? "", /known-bad.*known-good.*mutation-control/i);
    assert.deepEqual(materialization.outputs, { policies: [], corpora: [], plans: [], proofs: [] });
    assert.equal(materialization.authority, "none");
    assert.equal(materialization.effects, "assessment_only");
    assert.equal(materialization.writes, "none");
    assert.deepEqual(service.g2BehaviorMaterializationAssessment(bounds), materialization, "materialization assessment is byte-stable");
    assert.equal(existsSync(join(privateRoot, "policies")), false);
    assert.equal(existsSync(join(privateRoot, "evidence")), false);
    const policyMaterialization = service.g2BehaviorPolicyMaterialize({
      ...bounds,
      now: "2026-07-11T20:30:00.000Z",
      allowInstallScripts: [],
    });
    assert.match(policyMaterialization.id, /^g2behaviorpolicies_[a-f0-9]{10}$/);
    assert.equal(policyMaterialization.assessment_hash, materialization.content_hash);
    assert.equal(policyMaterialization.materialized_policies, 1);
    assert.equal(policyMaterialization.authority, "none");
    assert.equal(policyMaterialization.effects, "policy_proposal_only");
    assert.equal(policyMaterialization.activation, "separate_human_action_required");
    assert.equal(policyMaterialization.items[0]?.proof_class, "P3");
    assert.equal(policyMaterialization.items[0]?.policy_state, "proposed");
    const behaviorPolicy = service.get(policyMaterialization.items[0]!.policy_id, { privateOnly: true });
    assert.equal(behaviorPolicy.assertion.kind, "executable-behavior");
    assert.equal(behaviorPolicy.authority, null);
    assert.equal(behaviorPolicy.surfaces.includes("pre_edit"), false);
    assert.throws(() => PolicySpecSchema.parse({ ...behaviorPolicy, ir_version: 1 }), /Policy IR v2/i);
    assert.throws(() => PolicySpecSchema.parse({
      ...behaviorPolicy,
      assertion: { ...behaviorPolicy.assertion, runner: "shell-command", argv: ["sh", "-c", "true"] },
    }), /Invalid option/i, "Policy IR rejects arbitrary behavior command arrays");
    const behaviorProof = service.proof(policyMaterialization.items[0]!.proof_id, { privateOnly: true });
    assert.equal(behaviorProof.current.satisfied, 1);
    assert.equal(behaviorProof.known_bad.violated, 1);
    assert.equal(behaviorProof.known_good.satisfied, 1);
    assert.equal(behaviorProof.mutation_receipts.find((receipt) => receipt.kind === "primary")?.passed, true);
    assert.equal(behaviorProof.mutation_receipts.find((receipt) => receipt.kind === "control")?.error_code, "selected-test-not-executed");
    assert.equal(behaviorProof.mutation_controls.failed, 0);
    assert.equal(behaviorProof.project_checks.required_for_evaluator_sensitivity, true);
    assert.throws(
      () => approvePolicy(behaviorPolicy, behaviorProof, "advisory", "human:reviewer", "2026-07-11T20:30:30.000Z"),
      /current exact selected human attestation/i,
      "the low-level lifecycle cannot activate executable behavior without repository attestation validation",
    );
    assert.equal(service.evaluate({ id: behaviorPolicy.id })[0]?.evaluation.result, "satisfied");
    const prePolicyShadow = service.recordShadow(behaviorPolicy.id, {
      commit: candidate.proposed_corpus.known_bad.ref,
      now: "2026-07-11T20:30:40.000Z",
      latencyMs: 1,
    });
    assert.equal(prePolicyShadow.evaluation.result, "violated", "raw pre-policy evidence remains append-only and inspectable");
    const postIntroductionPrecision = service.shadowReport(behaviorPolicy.id, { minApplicable: 0 }, { privateOnly: true });
    assert.equal(postIntroductionPrecision.counts.total, 0, "commits before the policy fixing commit never enter its operational precision denominator");
    assert.equal(postIntroductionPrecision.evaluations.length, 1, "the excluded raw observation remains in the audit view");
    assert.deepEqual(service.g2BehaviorPolicyMaterialize({
      ...bounds,
      now: "2026-07-11T20:31:00.000Z",
      allowInstallScripts: [],
    }), policyMaterialization, "exact behavior policy materialization is retry-safe and byte-stable");
    const directPolicyMaterialization = service.g2BehaviorPolicyMaterialize({
      ...directBounds,
      now: "2026-07-11T20:32:00.000Z",
      allowInstallScripts: [],
    });
    assert.equal(directPolicyMaterialization.materialized_policies, 1);
    assert.equal(directPolicyMaterialization.items[0]?.proof_class, "P3");
    assert.notEqual(directPolicyMaterialization.items[0]?.policy_id, behaviorPolicy.id);
    const cliPolicyMaterializeRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-policy-materialize",
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliPolicyMaterializeRun.status, 0, cliPolicyMaterializeRun.stderr);
    const cliPolicyMaterialization = JSON.parse(cliPolicyMaterializeRun.stdout) as { content_hash: string };
    assert.equal(cliPolicyMaterialization.content_hash, policyMaterialization.content_hash, "CLI exposes the exact core policy materialization receipt");
    const cliDirectPolicyMaterializeRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-policy-materialize",
      "--behavior-decision", "dec_g2_direct",
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliDirectPolicyMaterializeRun.status, 0, cliDirectPolicyMaterializeRun.stderr);
    const cliDirectPolicyMaterialization = JSON.parse(cliDirectPolicyMaterializeRun.stdout) as { content_hash: string };
    assert.equal(cliDirectPolicyMaterialization.content_hash, directPolicyMaterialization.content_hash, "CLI materializes only the exact direct-decision batch");
    const cliMaterializeRun = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-materialize",
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliMaterializeRun.status, 0, cliMaterializeRun.stderr);
    const cliMaterialization = JSON.parse(cliMaterializeRun.stdout) as { content_hash: string; materialized_policies: number };
    assert.equal(cliMaterialization.content_hash, materialization.content_hash, "CLI exposes the exact core materialization assessment");
    assert.equal(cliMaterialization.materialized_policies, 0);

    const materializationTransport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: root });
    client = new Client({ name: "g2-behavior-materialization-test", version: "1.0.0" });
    await client.connect(materializationTransport);
    const mcpMaterializationCall = await client.callTool({
      name: "hunch_constitution_g2_behavior_materialization",
      arguments: { since: bounds.since, max_commits: bounds.maxCommits, limit: bounds.limit },
    });
    const mcpMaterialization = JSON.parse((mcpMaterializationCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(mcpMaterialization.content_hash, materialization.content_hash, "MCP exposes the exact core materialization assessment");
    const mcpPolicyMaterializationCall = await client.callTool({
      name: "hunch_constitution_g2_behavior_policy_materialize",
      arguments: { since: bounds.since, max_commits: bounds.maxCommits, limit: bounds.limit },
    });
    const mcpPolicyMaterialization = JSON.parse((mcpPolicyMaterializationCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(mcpPolicyMaterialization.content_hash, policyMaterialization.content_hash, "MCP exposes the exact core policy materialization receipt");
    const mcpDirectPolicyMaterializationCall = await client.callTool({
      name: "hunch_constitution_g2_behavior_policy_materialize",
      arguments: { decision_id: "dec_g2_direct", since: bounds.since, max_commits: bounds.maxCommits, limit: bounds.limit },
    });
    const mcpDirectPolicyMaterialization = JSON.parse((mcpDirectPolicyMaterializationCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(mcpDirectPolicyMaterialization.content_hash, directPolicyMaterialization.content_hash, "MCP materializes only the exact direct-decision batch");
    await client.close();
    client = null;
    assert.throws(
      () => service.attestG2BehaviorCandidate(
        candidate.id,
        afterBehaviorSelection.content_hash,
        "rejected",
        "human:reviewer",
        "missing supersession",
        bounds,
      ),
      /current.*supersedes/i,
    );
    assert.throws(
      () => service.attestG2BehaviorCandidate(
        candidate.id,
        review.content_hash,
        "rejected",
        "human:reviewer",
        "stale correction",
        { ...bounds, supersedes: behaviorSelection.id },
      ),
      /review hash/i,
    );

    const cliBehaviorAttest = spawnSync(process.execPath, [
      tsx, cli, "constitution", "g2",
      "--behavior-attest", candidate.id,
      "--behavior-review-hash", review.content_hash,
      "--disposition", "selected",
      "--actor", "human:reviewer",
      "--reason", behaviorReason,
      "--candidate-since", bounds.since,
      "--candidate-commits", String(bounds.maxCommits),
      "--candidate-limit", String(bounds.limit),
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliBehaviorAttest.status, 0, cliBehaviorAttest.stderr);
    const cliBehaviorOutput = JSON.parse(cliBehaviorAttest.stdout) as {
      appended: { id: string; authority: string };
      review: { selected_candidates: number; items: Array<{ human_review?: { id: string } }> };
    };
    assert.equal(cliBehaviorOutput.appended.id, behaviorSelection.id);
    assert.equal(cliBehaviorOutput.appended.authority, "none");
    assert.equal(cliBehaviorOutput.review.selected_candidates, 1);
    assert.equal(cliBehaviorOutput.review.items[0]?.human_review?.id, behaviorSelection.id);

    const behaviorCorrection = service.attestG2BehaviorCandidate(
      candidate.id,
      afterBehaviorSelection.content_hash,
      "rejected",
      "human:reviewer",
      "The selected meaning was corrected before policy materialization.",
      { ...bounds, supersedes: behaviorSelection.id, now: "2026-07-11T21:00:00.000Z" },
    );
    assert.equal(behaviorCorrection.supersedes, behaviorSelection.id);
    assert.equal(service.g2BehaviorCandidateReview(bounds).selected_candidates, 0);
    assert.throws(
      () => service.g2BehaviorMaterializationAssessment(bounds),
      /at least one current selected attestation/i,
      "correcting the selected disposition retracts materialization eligibility immediately",
    );
    assert.throws(
      () => service.approve(behaviorPolicy.id, "advisory", "human:reviewer"),
      /not bound to a current exact selected human attestation/i,
      "a corrected behavior selection cannot activate an already materialized proposal",
    );
    assert.match(service.evaluate({ id: behaviorPolicy.id })[0]?.gate_error ?? "", /not bound to a current exact selected human attestation/i);

    const behaviorFile = join(privateRoot, "behavior-attestations", `${behaviorSelection.id}.json`);
    const behaviorRecord = readFileSync(behaviorFile, "utf8");
    const tamperedBehavior = JSON.parse(behaviorRecord) as Record<string, unknown>;
    tamperedBehavior.reason = "tampered in place";
    writeFileSync(behaviorFile, JSON.stringify(tamperedBehavior));
    assert.throws(() => service.g2BehaviorCandidateReview(bounds), /content hash mismatch/i);
    writeFileSync(behaviorFile, behaviorRecord);
    assert.equal(service.repository.listPolicies({ privateOnly: true }).length, 2);
    assert.equal(service.repository.listEvidence({ privateOnly: true }).length, 0);
  } finally {
    if (client) await client.close();
    store.close();
    cleanup();
  }
});

test("Phase 3 unresolved refs and history-enumeration failures stay visible as deterministic proof errors", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    store.json.put("decisions", decision("dec_phase3_error"));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const policy = service.compile("dec_phase3_error", { through: "fetchOrders", now: NOW });
    const base = service.plan(policy.id, { publicOnly: true, now: NOW });
    const { id: _id, content_hash: _hash, created_at, ...rest } = base;
    const missing = "f".repeat(40);
    const body = {
      ...rest,
      corpus: {
        current_baseline: { kind: "commit" as const, ref: missing, label: "missing current", expected: "satisfied" as const },
        accepted_history: { ...base.corpus.accepted_history, from: missing, to: missing, max_commits: 1 },
        known_bad: [],
        known_good: [],
      },
    };
    const contentHash = canonicalHash(body);
    const broken = ProofPlanSchema.parse({
      id: `plan_${shortHash(contentHash)}`,
      content_hash: contentHash,
      ...body,
      created_at,
    });
    const proof = provePolicy(store, root, policy, { publicOnly: true, now: NOW, plan: broken });
    assert.equal(proof.proof_class, "P0");
    assert.equal(proof.current.error, 1);
    assert.equal(proof.accepted_history.error, 1);
    assert.deepEqual(proof.replay_receipts.map((receipt) => receipt.error_code), ["commit-ref-unresolved", "history-ref-unresolved"]);
    assert.equal(proof.replay_receipts.every((receipt) => receipt.deterministic_hash.startsWith("sha1:")), true);
    assert.match(proof.limitations.join("\n"), /prevent blocking approval/);
    assert.deepEqual(readdirSync(join(root, ".hunch-cache/worktrees")), []);

    const filterSentinel = join(root, "unsafe-filter-ran");
    execFileSync("git", ["config", "filter.evil.smudge", `touch ${filterSentinel}`], { cwd: root, stdio: "ignore" });
    const refused = provePolicy(store, root, policy, { publicOnly: true, now: NOW, plan: base });
    assert.equal(refused.current.error, 1);
    assert.equal(refused.replay_receipts[0]?.error_code, "unsafe-local-filter-config");
    assert.equal(existsSync(filterSentinel), false, "replay refuses arbitrary local checkout filters instead of executing them");
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

test("Phase 2E compiles a human-named removed external import and proves it with replay plus source mutation", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    const file = "src/services/orders.ts";
    const clean = readFileSync(join(root, file), "utf8");
    writeFileSync(join(root, file), `import axios from "axios";\n${clean}`);
    commitFiles(root, [file], "fixture: legacy orders axios dependency");
    const fixed = `${clean}export function withTxMarker(){ return true; }\n`;
    writeFileSync(join(root, file), fixed);
    const fix = commitFiles(root, [file], "refactor: replace axios in the orders service");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_external_import", fix, {
      title: "The orders service must not import axios",
      context: "The axios dependency crossed the service boundary; the replacement also introduced withTxMarker.",
      decision: "Keep axios out of src/services/orders.ts.",
      related_files: [file],
      caused_by_bug: null,
      retired: { symbols: [], deps: ["axios"] },
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);

    const inspection = service.inspectStructural("dec_external_import", { publicOnly: true });
    assert.equal(inspection.kind, "decision", "explicit retired.deps admits an architectural replacement without pretending it is a bug fix");
    assert.deepEqual(inspection.delta.imports.removed, [{ file, specifier: "axios" }]);
    assert.deepEqual(inspection.delta.symbols.added.map((symbol) => symbol.name), ["withTxMarker"]);
    assert.equal(inspection.candidates.length, 1);
    assert.equal(inspection.candidates[0]?.basis, "removed-import");
    assert.ok(inspection.unsupported.some((reason) => /call\/symbol candidate\(s\) excluded/.test(reason)));
    assert.deepEqual(inspection.candidates[0]?.assertion, {
      kind: "not-reaches",
      subject: inspection.candidates[0]!.assertion.subject,
      relation: { edges: ["imports"], transitive: false, max_depth: 1 },
      object: { selector: "external:axios" },
    });

    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 1);
    const policy = report.compiled[0]!.policy;
    assert.equal(policy.authority, null);
    assert.equal(service.evaluate({ id: policy.id, publicOnly: true })[0]?.evaluation.result, "satisfied");
    const plan = service.plan(policy.id, { publicOnly: true, now: "2026-07-11T12:01:00.000Z" });
    assert.equal(plan.mutations[0]?.operator, "add-forbidden-import");
    const proved = service.prove(policy.id, { now: "2026-07-11T12:02:00.000Z" });
    assert.equal(proved.proof.current.satisfied, 1);
    assert.equal(proved.proof.known_bad.violated, 1);
    assert.equal(proved.proof.proof_class, "P3");
    const primary = proved.proof.mutation_receipts.find((receipt) => receipt.kind === "primary")!;
    assert.equal(primary.operator, "add-forbidden-import");
    assert.equal(primary.result, "violated");
    assert.equal(primary.passed, true);
    assert.equal(primary.parseability, "parseable");
    assert.deepEqual(primary.source_patch?.files, [file]);
    assert.match(primary.source_patch?.diff ?? "", /import "axios"; \/\/ hunch deterministic source mutation/);
    assert.equal(proved.proof.mutation_controls.passed, 2);
    assert.equal(proved.policy.authority, null, "replay and source mutation prove sensitivity but never grant authority");
    assert.equal(readFileSync(join(root, file), "utf8"), fixed, "isolated proof never mutates the active worktree");
  } finally {
    cleanup();
  }
});

test("Phase 2E canonicalizes package subpaths while refusing relative, import-map, URL, and malformed scoped specifiers", () => {
  assert.equal(externalPackage("lodash/groupBy"), "lodash");
  assert.equal(externalPackage("@scope/pkg/subpath"), "@scope/pkg");
  assert.equal(externalPackage("node:fs/promises"), "node:fs/promises");
  assert.equal(externalPackage("../local.js"), null);
  assert.equal(externalPackage("#internal"), null);
  assert.equal(externalPackage("https://example.com/mod.js"), null);
  assert.equal(externalPackage("@scope"), null);
  assert.equal(externalImportNodeId("lodash/groupBy"), externalImportNodeId("lodash/map"));
});

test("Phase 2F compiles an exact relative-import component boundary and proves it end to end", () => {
  const direct = 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n';
  const { root, store, cleanup } = layeredRepo(direct);
  try {
    const file = "src/api/orders.ts";
    const corrected = 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n';
    writeFileSync(join(root, file), corrected);
    const fix = commitFiles(root, [file], "fix: remove the Api to Db dependency");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_relative_component", fix, {
      title: "Api must not depend directly on Db",
      context: "The Api to Db component dependency bypassed the architecture boundary.",
      decision: "Keep the direct Api to Db dependency removed.",
      related_files: [file],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const inspection = service.inspectStructural("dec_relative_component", { publicOnly: true });
    assert.equal(inspection.candidates.length, 1, JSON.stringify(inspection.unsupported));
    assert.equal(inspection.candidates[0]?.basis, "removed-relative-import");
    assert.deepEqual(inspection.candidates[0]?.assertion, {
      kind: "not-reaches",
      subject: inspection.candidates[0]!.assertion.subject,
      relation: { edges: ["depends_on"], transitive: false, max_depth: 1 },
      object: inspection.candidates[0]!.assertion.kind === "exists" ? undefined : inspection.candidates[0]!.assertion.object,
    });

    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 1);
    assert.equal(report.conflicted, 0);
    const policy = report.compiled[0]!.policy;
    assert.equal(policy.candidate.alternatives[0]?.basis, "removed-relative-import");
    assert.ok(policy.candidate.uncertainty.some((reason) => /structural coincidence/.test(reason)), "rejected coincident call/add-import meanings stay visible");
    assert.equal(service.evaluate({ id: policy.id, publicOnly: true })[0]?.evaluation.result, "satisfied");
    const proof = service.prove(policy.id, { now: "2026-07-11T12:01:00.000Z" }).proof;
    assert.equal(proof.current.satisfied, 1);
    assert.equal(proof.known_bad.violated, 1);
    assert.equal(proof.mutations.violated, 1);
    assert.equal(proof.mutation_controls.passed, 2);
    assert.equal(proof.proof_class, "P3");
    const primary = proof.mutation_receipts.find((receipt) => receipt.kind === "primary")!;
    assert.equal(primary.operator, "add-forbidden-edge");
    assert.match(primary.source_patch?.diff ?? "", /hunch deterministic component mutation/);
    assert.equal(readFileSync(join(root, file), "utf8"), corrected, "component mutation stays inside its disposable worktree");
  } finally {
    cleanup();
  }
});

test("Phase 2F component selectors are exact and direct semantic contradictions are surfaced, never minted", () => {
  const direct = 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n';
  const { root, store, cleanup } = layeredRepo(direct);
  try {
    const file = "src/api/orders.ts";
    writeFileSync(join(root, file), 'import { fetchOrders } from "../services/orders.js";\nexport function listOrders(u){ return fetchOrders(u); }\n');
    const fix = commitFiles(root, [file], "fix: remove the Api to Db dependency");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_relative_conflict", fix, {
      title: "Api must not depend directly on Db",
      context: "Remove the Api to Db dependency.",
      decision: "Keep Api and Db decoupled.",
      related_files: [file],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const candidate = service.inspectStructural("dec_relative_conflict", { publicOnly: true }).candidates[0]!;
    assert.ok(candidate);
    assert.equal(candidate.assertion.kind, "not-reaches");
    const assertion = candidate.assertion.kind === "exists" ? candidate.assertion : { ...candidate.assertion, kind: "reaches" as const };
    const incumbent = PolicySpecSchema.parse({
      id: "pol_aaaaaaaaaa",
      topic: "fixture.component-conflict",
      ir_version: 1,
      revision: 1,
      state: "proposed",
      statement: "Api must depend directly on Db",
      scope: candidate.scope,
      assertion,
      severity: "warning",
      surfaces: ["cli"],
      authority: null,
      evidence: ["fixture"],
      proof: null,
      data_class: "public",
      created_at: NOW,
      updated_at: NOW,
      provenance: { source: "human_confirmed", confidence: 1, evidence: ["fixture"] },
    });
    service.repository.putPolicy(incumbent);
    const snapshot = graphSnapshot(store, root, { publicOnly: true });
    assert.equal(evaluatePolicyOnSnapshot(incumbent, snapshot).result, "violated", "component-id selectors resolve exactly against current graph components");

    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 0);
    assert.equal(report.conflicted, 1);
    const event = service.repository.listEvidence({ publicOnly: true }).find((item) => item.text_ref === "dec_relative_conflict")!;
    assert.equal(event.compiler?.status, "conflicted");
    assert.deepEqual(event.compiler?.conflicts, [incumbent.id]);
    assert.equal(event.compiler?.policy, null);
    assert.equal(service.list({ publicOnly: true }).length, 1, "only the human-authored incumbent remains live");
  } finally {
    cleanup();
  }
});

test("EXP-03 scorecard validates 20 reviewed cases, raw denominators, uncertainty, and silent-substitution failure", () => {
  const file = join(process.cwd(), "bench/constitution-exp03-v1.json");
  const bank = JSON.parse(readFileSync(file, "utf8"));
  const report = scoreCompilerCaseBank(bank);
  assert.equal(report.denominator, 20);
  assert.equal(report.numerator, 20);
  assert.equal(report.rate, 1);
  assert.ok(Math.abs(report.risk_difference_vs_threshold - 0.3) < Number.EPSILON);
  assert.ok(report.wilson_95.low > 0.8 && report.wilson_95.high <= 1);
  assert.equal(report.silent_semantic_substitutions, 0);
  assert.equal(report.passed, true);

  const unsafe = structuredClone(bank);
  const prose = unsafe.cases.find((item: { id: string }) => item.id === "exp03_prose_only_instruction");
  prose.actual = unsafe.cases[0].actual;
  const failed = scoreCompilerCaseBank(unsafe);
  assert.equal(failed.silent_semantic_substitutions, 1);
  assert.equal(failed.passed, false, "one unsupported-to-assertion substitution fails the scorecard even above the aggregate threshold");
  assert.notEqual(failed.deterministic_hash, report.deterministic_hash);
});

test("Phase 2G repeated component evidence suggests a broader scope without silently widening any policy", () => {
  const direct = 'import { dbQuery } from "../db/client.js";\nexport function listOrders(u){ return dbQuery(u); }\n';
  const { root, store, cleanup } = layeredRepo(direct);
  try {
    const files = ["src/api/orders.ts", "src/api/invoices.ts", "src/api/reports.ts"];
    writeFileSync(join(root, files[1]!), 'import { dbQuery } from "../db/client.js";\nexport function listInvoices(u){ return dbQuery(u); }\n');
    writeFileSync(join(root, files[2]!), 'import { dbQuery } from "../db/client.js";\nexport function listReports(u){ return dbQuery(u); }\n');
    commitFiles(root, files.slice(1), "fixture: repeated Api to Db boundaries");
    const functions = ["listOrders", "listInvoices", "listReports"];
    const commits: string[] = [];
    for (let index = 0; index < files.length; index++) {
      writeFileSync(join(root, files[index]!), `import { fetchOrders } from "../services/orders.js";\nexport function ${functions[index]}(u){ return fetchOrders(u); }\n`);
      commits.push(commitFiles(root, [files[index]!], `fix: remove Api to Db dependency ${index + 1}`));
    }
    indexRepo(store, root, { churn: false });
    for (let index = 0; index < files.length; index++) {
      store.json.put("decisions", historyDecision(`dec_scope_${String.fromCharCode(97 + index)}`, commits[index]!, {
        title: "Api must not depend directly on Db",
        context: "Repeated Api to Db corrections indicate a component boundary.",
        decision: "Keep Api decoupled from Db.",
        related_files: [files[index]!],
      }));
    }
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", maxCandidates: 3, now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 3);
    const suggested = service.list({ publicOnly: true }).find((policy) => policy.candidate.scope_suggestion);
    assert.ok(suggested);
    assert.deepEqual(suggested.candidate.scope_suggestion?.paths, ["src/api/**"]);
    assert.equal(suggested.scope.paths.length, 1);
    assert.ok(files.includes(suggested.scope.paths[0]!), "the compiled scope stays on one evidenced file until human review");
    assert.notDeepEqual(suggested.scope, suggested.candidate.scope_suggestion);
    assert.equal(suggested.authority, null);
    const beforeConsolidation = service.list({ publicOnly: true }).map((policy) => canonicalJson(policy));
    const consolidation = service.consolidation(suggested.id, { publicOnly: true });
    assert.equal(consolidation.status, "reviewable");
    assert.deepEqual(consolidation.suggested_scope, suggested.candidate.scope_suggestion);
    assert.equal(consolidation.members.length, 3);
    assert.deepEqual(consolidation.independent_decisions, ["dec_scope_a", "dec_scope_b", "dec_scope_c"]);
    assert.deepEqual(consolidation.counterexamples, []);
    assert.match(consolidation.reasons[0]!, /no policy is merged, widened, evaluated, activated, or enforced/);
    assert.deepEqual(service.list({ publicOnly: true }).map((policy) => canonicalJson(policy)), beforeConsolidation, "consolidation inspection never changes policies");
  } finally {
    cleanup();
  }
});

test("Phase 2G discovers an out-of-scope counterexample and keeps it advisory", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "src/runtime"), { recursive: true });
    mkdirSync(join(root, "src/security"), { recursive: true });
    writeFileSync(join(root, "src/security/danger.ts"), "export function dangerous(){ return true; }\n");
    const importing = 'import { dangerous } from "../security/danger.js";\n';
    writeFileSync(join(root, "src/runtime/a.ts"), `${importing}export function run(){ return dangerous(); }\n`);
    writeFileSync(join(root, "src/runtime/b.ts"), `${importing}export function run(){ return dangerous(); }\n`);
    commitFiles(root, ["src/security/danger.ts", "src/runtime/a.ts", "src/runtime/b.ts"], "fixture: repeated dangerous callers");
    writeFileSync(join(root, "src/runtime/a.ts"), `${importing}export function run(){ return true; }\n`);
    const fix = commitFiles(root, ["src/runtime/a.ts"], "fix: remove run dangerous call");
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", historyDecision("dec_counterexample", fix, {
      title: "run must not call dangerous in runtime a",
      context: "The direct run to dangerous call caused the regression.",
      decision: "Keep run in runtime a away from dangerous.",
      related_files: ["src/runtime/a.ts"],
    }));
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.bootstrap({ history: true, publicOnly: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.compiled.length, 1);
    const policy = service.list({ publicOnly: true })[0]!;
    assert.equal(policy.assertion.kind, "not-reaches");
    assert.equal(policy.candidate.counterexamples.length, 1);
    assert.match(policy.candidate.counterexamples[0]!, /src\/runtime\/b\.ts:run is a counterexample outside the narrow scope/);
    assert.deepEqual(policy.scope.paths, ["src/runtime/a.ts"]);
    assert.equal(policy.candidate.scope_suggestion, null, "one counterexample never triggers automatic broadening");
    assert.equal(policy.authority, null);
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

test("Phase 2C local adapters normalize corrections, test failures, and incidents idempotently without minting policy", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    const correction = buildCorrectionConstraint({
      rule: "never import the unsafe transport in payments",
      scope_hint_file: "src/payments/charge.ts",
      severity: "blocking",
      rationale: "Human correction after review.",
    }, NOW);
    store.json.put("constraints", correction);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const linked: Bug = {
      id: "bug_test_failure",
      title: "payment validation test failed",
      symptom: "expected validation",
      root_cause: "unsafe transport bypassed validation",
      severity: "high",
      status: "fixed",
      affected_files: ["src/payments/charge.ts"],
      affected_symbols: ["charge"],
      lineage: {
        introduced_commit: null,
        detected: "test:payments validates session",
        fixed_commit: head,
        recurrence_of: null,
        spawned_decision: null,
        spawned_constraint: correction.id,
      },
      provenance: { source: "test_failure+human_confirmed", confidence: 1, evidence: ["test:payments validates session"], last_verified: NOW },
    };
    const incident: Bug = {
      ...linked,
      id: "bug_incident_unlinked",
      title: "unlinked payment incident",
      lineage: { ...linked.lineage, detected: null, fixed_commit: null, spawned_constraint: null },
      provenance: { source: "human_confirmed", confidence: 0.9, evidence: ["incident:431"], last_verified: NOW },
    };
    store.json.put("bugs", linked);
    store.json.put("bugs", incident);
    store.reindex();
    const service = new ConstitutionService(store, root);
    const first = service.ingest({ publicOnly: true, since: "90d", maxEvents: 100, now: "2026-07-10T12:00:00.000Z" });
    assert.equal(first.scanned, 3);
    assert.equal(first.eligible, 3);
    assert.equal(first.normalized, 3);
    assert.equal(first.covered, 2, "correction and its linked test failure already have legacy deterministic coverage");
    assert.equal(first.uncompilable, 1, "unlinked incident remains honest instead of becoming a guessed policy");
    assert.deepEqual(first.events.map((e) => e.kind).sort(), ["correction", "incident", "test_failure"]);
    assert.equal(service.list({ publicOnly: true }).length, 0, "normalization alone never mints a policy");
    const bytes = canonicalJson(service.repository.listEvidence({ publicOnly: true }));
    const second = service.ingest({ publicOnly: true, since: "90d", maxEvents: 100, now: "2026-07-10T12:00:00.000Z" });
    assert.equal(second.normalized, 0);
    assert.equal(second.existing, 3);
    assert.equal(canonicalJson(service.repository.listEvidence({ publicOnly: true })), bytes);
  } finally {
    cleanup();
  }
});

test("Phase 2C correction ingestion inherits private home and public reads reveal nothing", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-adapter/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    const correction = buildCorrectionConstraint({
      rule: "never expose the private billing transport",
      scope_hint_file: "src/private/SECRET-billing.ts",
      severity: "blocking",
    }, NOW);
    store.putPrivate("constraints", correction);
    store.reindex();
    const service = new ConstitutionService(store, root);
    const report = service.ingest({ privateOnly: true, since: "90d", now: "2026-07-10T12:00:00.000Z" });
    assert.equal(report.normalized, 1);
    assert.equal(report.events[0]?.data_class, "private");
    assert.ok(existsSync(join(privateRoot, "evidence", `${report.events[0]!.id}.json`)));
    assert.equal(service.repository.listEvidence({ publicOnly: true }).length, 0);
    assert.doesNotMatch(canonicalJson(service.repository.listEvidence({ publicOnly: true })), /SECRET-billing/);
  } finally {
    store.close();
    cleanup();
  }
});

test("Phase 2D hashes committed instruction/ADR evidence, ignores working prose, and links existing policy coverage", () => {
  const { root, store, cleanup } = layeredRepo();
  try {
    const adr = "<!-- hunch:topic orders.controller-db-boundary dec_instructionadapter -->\n# Service boundary\nCOMMITTED_ADR_RAW_TEXT must not be copied into evidence.\n";
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    const generatedV1 = "<!-- HUNCH:START — auto-generated -->\nGENERATED_GROUNDING_SECRET is derived, not evidence.\n<!-- HUNCH:END -->\n";
    const generatedV2 = "<!-- HUNCH:START — auto-generated -->\nGENERATED_GROUNDING_SECRET_V2 is still derived, not evidence.\n<!-- HUNCH:END -->\n";
    writeFileSync(join(root, "docs/adr/001-service-boundary.md"), `${adr}${generatedV1}`);
    writeFileSync(join(root, "AGENTS.md"), `# AGENTS.md\n\n${generatedV1}`);
    const authoredCommit = commitFiles(root, ["docs/adr/001-service-boundary.md", "AGENTS.md"], "docs: record service boundary ADR");
    writeFileSync(join(root, "docs/adr/001-service-boundary.md"), `${adr}${generatedV2}`);
    commitFiles(root, ["docs/adr/001-service-boundary.md"], "docs: refresh generated grounding only");
    writeFileSync(join(root, "docs/adr/001-service-boundary.md"), `${adr}${generatedV2}WORKING_ONLY_SECRET must be ignored.\n`);
    writeFileSync(join(root, "docs/adr/untracked.md"), "UNTRACKED_SECRET must be ignored.\n");
    store.json.put("decisions", { ...decision("dec_instructionadapter"), topic: "orders.controller-db-boundary" });
    store.reindex();
    const service = new ConstitutionService(store, root);
    const policy = service.compile("dec_instructionadapter", { through: "fetchOrders", now: NOW });
    const first = service.ingest({ publicOnly: true, instructions: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(first.scanned, 2);
    assert.equal(first.excluded, 1, "fully generated Hunch grounding is not recycled as independent evidence");
    assert.equal(first.normalized, 1);
    assert.equal(first.covered, 1);
    const event = first.events[0]!;
    assert.equal(event.kind, "instruction");
    assert.equal(event.compiler?.policy, policy.id);
    assert.equal(event.text_ref, "docs/adr/001-service-boundary.md");
    assert.deepEqual(event.related_records, ["dec_instructionadapter"]);
    assert.equal(event.commit, authoredCommit, "generated-only refreshes do not take authorship of stable instruction prose");
    assert.ok(event.provenance.evidence.includes(canonicalHash(adr.trim())));
    const stored = canonicalJson(event);
    assert.doesNotMatch(stored, /COMMITTED_ADR_RAW_TEXT|WORKING_ONLY_SECRET|UNTRACKED_SECRET|GENERATED_GROUNDING_SECRET/);
    assert.equal(service.list({ publicOnly: true }).length, 1, "instruction ingestion enriches evidence only and mints no extra policy");
    const second = service.ingest({ publicOnly: true, instructions: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(second.normalized, 0);
    assert.equal(second.existing, 1);
    assert.equal(second.events[0]?.id, event.id);
  } finally {
    cleanup();
  }
});

test("Phase 2D public instruction coverage never resolves through a private-only policy", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  try {
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    writeFileSync(join(root, "docs/adr/002-private-collision.md"), "<!-- hunch:topic private.boundary dec_privatepin -->\n# Public doc with a stale/private-only pin\n");
    commitFiles(root, ["docs/adr/002-private-collision.md"], "docs: add public collision fixture");
    initial.close();
    const privateRoot = join(root, "private-instruction/.hunch");
    mkdirSync(privateRoot, { recursive: true });
    writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
    const store = new HunchStore(hunchPaths(root));
    try {
      indexRepo(store, root, { churn: false });
      store.putPrivate("decisions", {
        ...decision("dec_privatepin", { private: true }),
        title: "PRIVATE_POLICY_SENTINEL",
        topic: "private.boundary",
      });
      store.reindex();
      const service = new ConstitutionService(store, root);
      const privatePolicy = service.compile("dec_privatepin", { through: "fetchOrders", now: NOW });
      const report = service.ingest({ instructions: true, since: "90d", now: "2026-07-11T12:00:00.000Z" });
      assert.equal(report.events[0]?.data_class, "public");
      assert.equal(report.events[0]?.compiler?.policy, null);
      const publicBytes = canonicalJson(service.repository.listEvidence({ publicOnly: true }));
      assert.doesNotMatch(publicBytes, new RegExp(privatePolicy.id));
      assert.doesNotMatch(publicBytes, /PRIVATE_POLICY_SENTINEL/);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test("Phase 2D review/conversation exports validate as one batch and preserve exact public/private homes without raw text", () => {
  const { root, store: initial, cleanup } = layeredRepo();
  initial.close();
  const privateRoot = join(root, "private-import/.hunch");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
  const store = new HunchStore(hunchPaths(root));
  try {
    store.putPrivate("decisions", decision("dec_privateexport", { private: true }));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const exported = {
      version: 1,
      source: "pr_export",
      items: [
        {
          id: "pr-431-review-1",
          kind: "review",
          occurred_at: "2026-07-10T10:10:00.000Z",
          actor: "maintainer:alice",
          commit: head.slice(0, 12),
          files: ["src/api/orders.ts"],
          symbols: ["listOrders"],
          text: "PUBLIC_REVIEW_RAW_TEXT must hash but never persist.",
          related_records: [],
          data_class: "public",
          maintainer_confirmed: true,
        },
        {
          id: "conversation-private-1",
          kind: "review",
          occurred_at: "2026-07-10T10:11:00.000Z",
          actor: "maintainer:bob",
          files: ["src/services/orders.ts"],
          text: "PRIVATE_EXPORT_SENTINEL must never cross the public boundary.",
          related_records: [],
          data_class: "private",
          maintainer_confirmed: false,
        },
      ],
    };
    writeFileSync(join(root, "review-export.json"), JSON.stringify(exported));
    const service = new ConstitutionService(store, root);
    const report = service.ingest({ importFiles: ["review-export.json"], since: "90d", now: "2026-07-11T12:00:00.000Z" });
    assert.equal(report.scanned, 2);
    assert.equal(report.normalized, 2);
    assert.equal(report.uncompilable, 2);
    const pub = service.repository.listEvidence({ publicOnly: true });
    const priv = service.repository.listEvidence({ privateOnly: true });
    assert.equal(pub.length, 1);
    assert.equal(priv.length, 1);
    assert.equal(pub[0]?.commit, head);
    assert.equal(pub[0]?.data_class, "public");
    assert.equal(priv[0]?.data_class, "private");
    assert.equal(pub[0]?.provenance.source, "human_confirmed+imported");
    assert.equal(priv[0]?.provenance.source, "imported");
    assert.doesNotMatch(canonicalJson(pub), /PUBLIC_REVIEW_RAW_TEXT|PRIVATE_EXPORT_SENTINEL/);
    assert.doesNotMatch(canonicalJson(priv), /PUBLIC_REVIEW_RAW_TEXT|PRIVATE_EXPORT_SENTINEL/);
    assert.doesNotMatch(canonicalJson(pub), new RegExp(priv[0]!.id));
    assert.ok(existsSync(join(root, ".hunch/evidence", `${pub[0]!.id}.json`)));
    assert.ok(existsSync(join(privateRoot, "evidence", `${priv[0]!.id}.json`)));

    const before = canonicalJson(service.repository.listEvidence());
    writeFileSync(join(root, "mixed-refused.json"), JSON.stringify({
      ...exported,
      items: exported.items.map((item, index) => ({ ...item, id: `refused-${index}` })),
    }));
    assert.throws(
      () => service.ingest({ publicOnly: true, importFiles: ["mixed-refused.json"], since: "90d", now: "2026-07-11T12:00:00.000Z" }),
      /refusing public-only ingestion/,
    );
    assert.equal(canonicalJson(service.repository.listEvidence()), before, "batch validation completes before the first write");
    writeFileSync(join(root, "private-ref-refused.json"), JSON.stringify({
      version: 1,
      source: "review_export",
      items: [{
        ...exported.items[0],
        id: "public-item-private-ref",
        related_records: ["dec_privateexport"],
      }],
    }));
    assert.throws(
      () => service.ingest({ importFiles: ["private-ref-refused.json"], since: "90d", now: "2026-07-11T12:00:00.000Z" }),
      /references private-only record dec_privateexport/,
    );
    assert.equal(canonicalJson(service.repository.listEvidence()), before);
    writeFileSync(join(root, "symbolic-ref-refused.json"), JSON.stringify({
      version: 1,
      source: "review_export",
      items: [{
        ...exported.items[0],
        id: "symbolic-ref-refused",
        commit: "--help",
      }],
    }));
    assert.throws(
      () => service.ingest({ importFiles: ["symbolic-ref-refused.json"], since: "90d", now: "2026-07-11T12:00:00.000Z" }),
      /commit must be a hexadecimal object id/,
    );
    assert.equal(canonicalJson(service.repository.listEvidence()), before, "invalid refs are rejected before any write");
    writeFileSync(join(root, "cli-review-export.json"), JSON.stringify({
      version: 1,
      source: "review_export",
      items: [{
        ...exported.items[0],
        id: "cli-review-roundtrip",
        text: "CLI_RAW_TEXT must hash but never persist.",
      }],
    }));
    const cliRun = spawnSync(process.execPath, [
      join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      join(process.cwd(), "src/cli/index.ts"),
      "constitution", "ingest", "--public-only", "--since", "90d", "--from", "cli-review-export.json",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    assert.match(cliRun.stdout, /1 normalized/);
    assert.match(cliRun.stdout, /authority: none/);
    assert.doesNotMatch(canonicalJson(service.repository.listEvidence({ publicOnly: true })), /CLI_RAW_TEXT/);
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
    const proved = service.prove(compiled.id, { now: "2026-07-10T10:01:00.000Z" });
    service.approve(compiled.id, "blocking", "human:adapter-owner", { now: "2026-07-10T10:02:00.000Z" });
    const expectedCardHash = service.card(compiled.id, { publicOnly: true }).card_hash;
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
    const cliCardRun = spawnSync(process.execPath, [tsx, cli, "policy", "card", compiled.id, "--public-only", "--json"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(cliCardRun.status, 0, cliCardRun.stderr);
    assert.equal((JSON.parse(cliCardRun.stdout) as { card_hash: string }).card_hash, expectedCardHash);

    const ciRun = spawnSync(process.execPath, [tsx, cli, "check", "--working", "--strict", "--public-only"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(ciRun.status, 1, "strict CI blocks the authorized violation");
    assert.match(ciRun.stdout, new RegExp(receipt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const shadowRecordRun = spawnSync(process.execPath, [tsx, cli, "policy", "shadow", compiled.id, "--record"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(shadowRecordRun.status, 0, shadowRecordRun.stderr);
    assert.match(shadowRecordRun.stdout, /shadow recording never warns, blocks/);
    const shadowInspectRun = spawnSync(process.execPath, [tsx, cli, "policy", "shadow", compiled.id, "--public-only"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(shadowInspectRun.status, 0, shadowInspectRun.stderr);
    assert.equal((JSON.parse(shadowInspectRun.stdout) as { counts: { total: number } }).counts.total, 1);
    const shadowCardRun = spawnSync(process.execPath, [tsx, cli, "policy", "card", compiled.id, "--public-only", "--json"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(shadowCardRun.status, 0, shadowCardRun.stderr);
    const shadowCardHash = (JSON.parse(shadowCardRun.stdout) as { card_hash: string }).card_hash;
    assert.notEqual(shadowCardHash, expectedCardHash, "the content-addressed card changes when shadow evidence is attached");
    const g2CliRun = spawnSync(process.execPath, [tsx, cli, "constitution", "g2"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(g2CliRun.status, 0, g2CliRun.stderr);
    const g2CliReport = JSON.parse(g2CliRun.stdout) as { content_hash: string; recommendation: string; authority: string; g2_passed: boolean };
    assert.equal(g2CliReport.recommendation, "not_ready");
    assert.equal(g2CliReport.authority, "none");
    assert.equal(g2CliReport.g2_passed, false);
    const g2QueueCliRun = spawnSync(process.execPath, [tsx, cli, "constitution", "g2", "--queue", "5"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(g2QueueCliRun.status, 0, g2QueueCliRun.stderr);
    const g2QueueCli = JSON.parse(g2QueueCliRun.stdout) as { content_hash: string; total_unclassified: number; authority: string };
    assert.equal(g2QueueCli.total_unclassified, 0);
    assert.equal(g2QueueCli.authority, "none");
    const g2CandidatesCliRun = spawnSync(process.execPath, [tsx, cli, "constitution", "g2", "--candidates", "5", "--candidate-since", "30d", "--candidate-commits", "10"], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
    });
    assert.equal(g2CandidatesCliRun.status, 0, g2CandidatesCliRun.stderr);
    const g2CandidatesCli = JSON.parse(g2CandidatesCliRun.stdout) as { content_hash: string; authority: string; writes: string; proof_status: string };
    assert.equal(g2CandidatesCli.authority, "none");
    assert.equal(g2CandidatesCli.writes, "none");
    assert.equal(g2CandidatesCli.proof_status, "not_run");

    const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: fixture.root, env });
    client = new Client({ name: "constitution-contract-test", version: "1.0.0" });
    await client.connect(transport);
    const planCall = await client.callTool({ name: "hunch_policy_plan", arguments: { policy_id: compiled.id, public_only: true } });
    const plan = JSON.parse((planCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string };
    assert.equal(plan.content_hash, proved.proof.plan_hash, "MCP returns the same canonical plan that the proof binds");
    const cardCall = await client.callTool({ name: "hunch_policy_card", arguments: { policy_id: compiled.id, public_only: true } });
    const card = JSON.parse((cardCall.content[0] as { type: "text"; text: string }).text) as { card_hash: string };
    assert.equal(card.card_hash, shadowCardHash, "CLI and MCP expose the same deterministic proof card for the same ledger state");
    const mcp = await client.callTool({ name: "hunch_policy_evaluate", arguments: { policy_id: compiled.id, public_only: true } });
    const text = (mcp.content[0] as { type: "text"; text: string }).text;
    const mcpReceipts = JSON.parse(text) as Array<{ deterministic_hash: string; result: string }>;
    assert.equal(mcpReceipts[0]?.result, "violated");
    assert.equal(mcpReceipts[0]?.deterministic_hash, receipt, "all three surfaces share one canonical evaluator receipt");
    const shadowCall = await client.callTool({ name: "hunch_policy_shadow", arguments: { policy_id: compiled.id, public_only: true } });
    const shadowReport = JSON.parse((shadowCall.content[0] as { type: "text"; text: string }).text) as { counts: { total: number }; recommendation: string };
    assert.equal(shadowReport.counts.total, 1);
    assert.equal(shadowReport.recommendation, "not_ready");
    const g2Call = await client.callTool({ name: "hunch_constitution_g2_readiness", arguments: {} });
    const g2McpReport = JSON.parse((g2Call.content[0] as { type: "text"; text: string }).text) as { content_hash: string; recommendation: string; authority: string; g2_passed: boolean };
    assert.equal(g2McpReport.content_hash, g2CliReport.content_hash, "CLI and read-only MCP expose the identical G2 readiness receipt");
    assert.equal(g2McpReport.recommendation, "not_ready");
    assert.equal(g2McpReport.authority, "none");
    assert.equal(g2McpReport.g2_passed, false);
    const g2QueueCall = await client.callTool({ name: "hunch_constitution_g2_shadow_queue", arguments: { limit: 5 } });
    const g2QueueMcp = JSON.parse((g2QueueCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string; total_unclassified: number; authority: string };
    assert.equal(g2QueueMcp.content_hash, g2QueueCli.content_hash, "CLI and read-only MCP expose the identical bounded G2 shadow queue");
    assert.equal(g2QueueMcp.total_unclassified, 0);
    assert.equal(g2QueueMcp.authority, "none");
    const g2CandidatesCall = await client.callTool({ name: "hunch_constitution_g2_candidates", arguments: { since: "30d", max_commits: 10, limit: 5 } });
    const g2CandidatesMcp = JSON.parse((g2CandidatesCall.content[0] as { type: "text"; text: string }).text) as { content_hash: string; authority: string; writes: string; proof_status: string };
    assert.equal(g2CandidatesMcp.content_hash, g2CandidatesCli.content_hash, "CLI and read-only MCP expose the identical G2 candidate review packet");
    assert.equal(g2CandidatesMcp.authority, "none");
    assert.equal(g2CandidatesMcp.writes, "none");
    assert.equal(g2CandidatesMcp.proof_status, "not_run");
  } finally {
    if (client) await client.close();
    fixture.cleanup();
  }
});
