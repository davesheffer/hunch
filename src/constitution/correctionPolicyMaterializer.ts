import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { toPosixTarget } from "../core/paths.js";
import { isHumanConfirmed } from "../core/strictgate.js";
import type { Constraint } from "../core/types.js";
import { isGitCleanPath, stableRepositoryName } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { correctionEvidenceEvent } from "./adapters.js";
import { canonicalHash, canonicalJson } from "./canonical.js";
import { compileCorrectionPolicy } from "./compiler.js";
import { policyProofHash } from "./composition.js";
import { blockingEvidenceError, proposeProvedPolicy } from "./lifecycle.js";
import { createProofPlan } from "./plan.js";
import { evaluatorForPolicy, mutationEngineForPolicy } from "./policyRuntime.js";
import { provePolicy } from "./proof.js";
import type { PolicyRepository } from "./repository.js";
import { canonicalStaticGraphBaseline } from "./staticGraphBaseline.js";
import { replacementFreeGitEnvironment } from "./replacementFreeGit.js";
import {
  EvidenceEventSchema,
  type CandidateContext,
  type DataClass,
  type EvidenceEvent,
  type PolicyProof,
  type PolicySpec,
  type ProofPlan,
} from "./schema.js";
import {
  directConflict,
  inspectExternalImportBoundary,
  structuralKey,
  type ExternalImportBoundaryCandidate,
} from "./structural.js";

export interface CorrectionUpgradeOptions {
  publicOnly?: boolean;
  privateOnly?: boolean;
  now?: string;
}

export interface CorrectionReview {
  status: "ready_for_review";
  rule: string;
  meaning: string;
  why: string;
  catches: string;
  does_not_catch: string;
  authority: "none" | "existing_human";
  next_action: string;
}

export interface CorrectionPolicyUpgrade {
  status: "proved" | "already_proved" | "legacy_only" | "pending" | "conflicted";
  correction_id: string;
  reason: string;
  evidence: EvidenceEvent;
  policy: PolicySpec | null;
  plan: ProofPlan | null;
  proof: PolicyProof | null;
  review: CorrectionReview | null;
  authority: "none";
  effects: "proposal_only";
  activation: "not_available_in_this_operation";
}

export interface CorrectionPolicySweep {
  scanned: number;
  proved: number;
  already_proved: number;
  legacy_only: number;
  pending: number;
  conflicted: number;
  failed: Array<{ correction_id: string; home: Home; error: string }>;
  upgrades: CorrectionPolicyUpgrade[];
  authority: "none";
}

type Home = "public" | "private";
type HomeView = { publicOnly: true } | { privateOnly: true };

const LIVE_CONFLICT_STATES = new Set<PolicySpec["state"]>([
  "compiled",
  "validating",
  "proposed",
  "active_advisory",
  "active_blocking",
  "stale",
  "repaired",
]);

function exactCorrection(
  store: HunchStore,
  id: string,
  opts: CorrectionUpgradeOptions,
): { correction: Constraint; home: Home; dataClass: DataClass } {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly && !store.hasPrivate) throw new Error("private correction upgrade needs a configured Hunch private overlay");
  if (opts.publicOnly) {
    const correction = store.json.get("constraints", id);
    if (!correction) throw new Error(`public correction ${id} not found`);
    return { correction, home: "public", dataClass: "public" };
  }
  if (opts.privateOnly) {
    const correction = store.getPrivateRec("constraints", id);
    if (!correction) throw new Error(`private correction ${id} not found`);
    return { correction, home: "private", dataClass: "private" };
  }
  const privateCorrection = store.getPrivateRec("constraints", id);
  if (privateCorrection) return { correction: privateCorrection, home: "private", dataClass: "private" };
  const correction = store.json.get("constraints", id);
  if (!correction) throw new Error(`correction ${id} not found`);
  return { correction, home: "public", dataClass: "public" };
}

function concreteScope(correction: Constraint): { file: string; reason: null } | { file: null; reason: string } {
  if (correction.scope.length !== 1) {
    return { file: null, reason: `Correction has ${correction.scope.length} scopes; exactly one concrete file is required.` };
  }
  const file = toPosixTarget(correction.scope[0]!.trim());
  const parts = file.split("/");
  if (!file || file === "." || file === "**" || file.startsWith("/") || /^[A-Za-z]:\//.test(file)
    || parts.some((part) => !part || part === "." || part === "..") || /[*?\[\]{}!\x00-\x1f\x7f]/.test(file)) {
    return { file: null, reason: "Correction scope is not one safe, concrete repository-relative file." };
  }
  return { file, reason: null };
}

function unsafeSourceScopeReason(root: string, file: string): string | null {
  const target = join(root, file);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      return `${file} is a symbolic link; MD-1a only proves regular committed source files`;
    }
    if (!stat.isFile()) return `${file} is not a regular source file`;

    const canonicalRoot = realpathSync(root);
    const canonicalTarget = realpathSync(target);
    const fromRoot = relative(canonicalRoot, canonicalTarget);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
      || canonicalTarget !== resolve(canonicalRoot, file)) {
      return `${file} resolves through or outside the repository; MD-1a only proves regular committed source files`;
    }

    const entry = execFileSync("git", ["-C", root, "ls-tree", "-z", "HEAD", "--", file], {
      encoding: "utf8",
      env: replacementFreeGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!/^(?:100644|100755) blob [a-f0-9]{40,64}\t/.test(entry) || !entry.endsWith(`\t${file}\0`)) {
      return `${file} is not a regular source blob at committed HEAD; symbolic links and special entries are unsupported`;
    }
  } catch {
    return `${file} could not be verified as a regular committed source file`;
  }
  return null;
}

function exactForbiddenDependency(correction: Constraint): { dependency: string; reason: null } | { dependency: null; reason: string } {
  if (correction.match || !correction.forbids) {
    return { dependency: null, reason: "Correction has no exact structured forbidden-package meaning." };
  }
  if (correction.forbids.deps.length !== 1 || correction.forbids.symbols.length || correction.forbids.patterns.length) {
    return { dependency: null, reason: "Correction must contain exactly one forbidden package and no symbol, pattern, or regex fallback." };
  }
  return { dependency: correction.forbids.deps[0]!, reason: null };
}

function candidateContext(candidate: ExternalImportBoundaryCandidate, conflicts: string[] = []): CandidateContext {
  return {
    alternatives: [{
      id: candidate.id,
      basis: candidate.basis,
      reason: candidate.reason,
      assertion_hash: canonicalHash(candidate.assertion),
    }],
    uncertainty: [],
    conflicts,
    incumbent: null,
    scope_suggestion: null,
    counterexamples: [],
  };
}

function classifiedEvidence(
  base: EvidenceEvent,
  status: NonNullable<EvidenceEvent["compiler"]>["status"],
  reason: string,
  policy: string | null,
  context?: CandidateContext,
): EvidenceEvent {
  return EvidenceEventSchema.parse({
    ...base,
    related_records: [...new Set([...base.related_records, ...(policy ? [policy] : [])])].sort(),
    compiler: {
      status,
      policy,
      reason,
      ...(context ?? {}),
    },
  });
}

function putEvidenceIfChanged(
  repository: PolicyRepository,
  event: EvidenceEvent,
  home: Home,
): EvidenceEvent {
  const view = home === "public" ? { publicOnly: true } : { privateOnly: true };
  const existing = repository.getEvidence(event.id, view);
  return existing && canonicalJson(existing) === canonicalJson(event)
    ? existing
    : repository.putEvidence(event, { private: home === "private", public: home === "public" });
}

function reviewFor(correction: Constraint, candidate: ExternalImportBoundaryCandidate, policy?: PolicySpec): CorrectionReview {
  const file = candidate.scope.paths[0]!;
  const assertion = candidate.assertion;
  const dependency = assertion.kind === "not-reaches"
    ? assertion.object.selector.slice("external:".length)
    : "the selected package";
  return {
    status: "ready_for_review",
    rule: correction.statement,
    meaning: `${file} must not directly import ${dependency} through a supported static ESM import declaration.`,
    why: correction.rationale,
    catches: `A static TypeScript/JavaScript import of ${dependency} in ${file}.`,
    does_not_catch: "re-exports, require(), dynamic import(), aliases, runtime loading, or anchor-symbol rename/removal until the proposal is repaired.",
    authority: policy?.authority ? "existing_human" : "none",
    next_action: policy?.authority
      ? "This policy is already human-activated; the correction upgrade changed no authority."
      : "Review this proposal; keep it non-active until source-currentness safety is in place.",
  };
}

function result(
  status: CorrectionPolicyUpgrade["status"],
  correction: Constraint,
  reason: string,
  evidence: EvidenceEvent,
  policy: PolicySpec | null = null,
  plan: ProofPlan | null = null,
  proof: PolicyProof | null = null,
  review: CorrectionReview | null = null,
): CorrectionPolicyUpgrade {
  return {
    status,
    correction_id: correction.id,
    reason,
    evidence,
    policy,
    plan,
    proof,
    review,
    authority: "none",
    effects: "proposal_only",
    activation: "not_available_in_this_operation",
  };
}

function proofPayloadHash(proof: PolicyProof): string {
  const { generated_at: _generatedAt, ...payload } = proof;
  return canonicalHash(payload);
}

function reusableProofPacket(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  policy: PolicySpec,
  homeView: HomeView,
): { plan: ProofPlan; proof: PolicyProof } | { reason: string } {
  if (!["proposed", "active_advisory", "active_blocking"].includes(policy.state)) {
    return { reason: `policy lifecycle is ${policy.state}, not a reusable proved state` };
  }
  const policies = repository.listPolicies(homeView);
  if (policy.exception_of || policies.some((candidate) => candidate.exception_of === policy.id)) {
    return { reason: "policy participates in an exception composition that this correction bridge cannot reuse" };
  }
  if (!policy.proof) return { reason: "policy has no linked proof" };
  const proof = repository.getProof(policy.proof, homeView);
  if (!proof) return { reason: `linked proof ${policy.proof} is missing` };
  const plan = repository.listPlans(homeView).find((candidate) => candidate.policy_id === policy.id && candidate.content_hash === proof.plan_hash);
  if (!plan) return { reason: `proof ${proof.id} has no exact bound plan` };
  const expectedPolicyHash = policyProofHash(policy);
  if (plan.policy_candidate_hash !== expectedPolicyHash || proof.policy_hash !== expectedPolicyHash) {
    return { reason: "proof or plan does not bind the current policy semantics" };
  }
  const evaluator = evaluatorForPolicy(policy);
  const mutation = mutationEngineForPolicy(policy);
  if (plan.policy_id !== policy.id || plan.repository !== stableRepositoryName(root)
    || plan.data_class !== policy.data_class || proof.data_class !== policy.data_class) {
    return { reason: "proof packet does not match the policy repository or data class" };
  }
  if (plan.evaluator.name !== evaluator.name || plan.evaluator.version !== evaluator.version) {
    return { reason: "proof plan evaluator version is stale" };
  }
  if (plan.budgets.max_commits !== 0 || plan.corpus.accepted_history.max_commits !== 0
    || plan.budgets.max_mutations > 3 || plan.mutations.length > 3 || plan.budgets.max_minutes > 1
    || plan.corpus.known_bad.length !== 0 || plan.corpus.known_good.length !== 1
    || plan.corpus.known_good[0]?.ref !== plan.corpus.current_baseline.ref) {
    return { reason: "proof plan exceeds the MD-1a automatic replay budget" };
  }
  if (plan.mutation_engine?.name !== mutation.name || plan.mutation_engine.version !== mutation.version) {
    return { reason: "proof plan mutation engine version is stale" };
  }
  if (proof.evaluator.name !== evaluator.name || proof.evaluator.version !== evaluator.version) {
    return { reason: "proof evaluator version is stale" };
  }
  if (proof.mutation_engine?.name !== mutation.name || proof.mutation_engine.version !== mutation.version) {
    return { reason: "proof mutation engine version is stale" };
  }
  if (!["P3", "P4", "P5"].includes(proof.proof_class)) return { reason: `proof class ${proof.proof_class} is below P3` };
  if (proof.current.total !== 1 || proof.current.satisfied !== 1 || proof.current.violated
    || proof.current.not_applicable || proof.current.unknown || proof.current.error) {
    return { reason: "proof has no exact clean current baseline" };
  }
  const baselineHead = plan.corpus.current_baseline.ref;
  if (plan.corpus.accepted_history.to !== baselineHead || baselineHead !== canonicalStaticGraphBaseline(root)) {
    return { reason: "proof baseline is not the current source-equivalent HEAD" };
  }
  const dispositions = repository.listDispositions(homeView).filter((record) => record.policy_id === policy.id && record.proof_id === proof.id);
  const evidenceError = blockingEvidenceError(proof, dispositions);
  if (evidenceError) return { reason: evidenceError };
  try {
    const regenerated = provePolicy(store, root, policy, {
      publicOnly: "publicOnly" in homeView,
      plan,
      now: proof.generated_at,
    });
    if (proofPayloadHash(regenerated) !== proofPayloadHash(proof)) {
      return { reason: "proof receipts do not reproduce from the bound plan and current evaluator" };
    }
  } catch (error) {
    return { reason: `proof receipts could not be reproduced: ${(error as Error).message}` };
  }
  return { plan, proof };
}

function privateOnlySourceDecisionError(store: HunchStore, correction: Constraint, home: Home): string | null {
  const source = correction.source_decision;
  if (home === "public" && source && !store.json.get("decisions", source)) {
    const location = store.getPrivateRec("decisions", source) ? "private-only" : "missing from the public home";
    return `public correction ${correction.id} references decision ${source}, which is ${location}; refusing to write any public correction-policy artifact`;
  }
  return null;
}

function publicationInputError(
  store: HunchStore,
  root: string,
  correction: Constraint,
  home: Home,
  expectedHead: string,
  sourceFile: string,
): { status: "pending" | "conflicted"; reason: string } | null {
  if (canonicalStaticGraphBaseline(root) !== expectedHead) {
    return { status: "pending", reason: `Repository HEAD changed while proving correction ${correction.id}; the stale packet was not published.` };
  }
  const current = home === "public"
    ? store.json.get("constraints", correction.id)
    : store.getPrivateRec("constraints", correction.id);
  if (!current || canonicalJson(current) !== canonicalJson(correction)) {
    return { status: "conflicted", reason: `Correction ${correction.id} changed or left its ${home} home while proof was running; the old meaning was not published.` };
  }
  if (!isGitCleanPath(root, sourceFile)) {
    return { status: "pending", reason: `${sourceFile} changed while proving correction ${correction.id}; only a clean committed source baseline can be published.` };
  }
  const sourceError = privateOnlySourceDecisionError(store, current, home);
  return sourceError ? { status: "conflicted", reason: sourceError } : null;
}

function liveConflicts(
  repository: PolicyRepository,
  candidate: PolicySpec,
  home: Home,
): string[] {
  const visible = home === "private"
    ? [...repository.listPolicies({ publicOnly: true }), ...repository.listPolicies({ privateOnly: true })]
    : repository.listPolicies({ publicOnly: true });
  return [...new Set(visible
    .filter((policy) => LIVE_CONFLICT_STATES.has(policy.state) && directConflict(candidate, policy))
    .map((policy) => policy.id))]
    .sort();
}

/** Upgrade one safe correction projection into a proved proposal. This operation
 * cannot activate, warn, or block; unsupported corrections retain only their
 * immediate legacy Constraint. */
export function materializeCorrectionPolicy(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  correctionId: string,
  opts: CorrectionUpgradeOptions = {},
): CorrectionPolicyUpgrade {
  const { correction, home, dataClass } = exactCorrection(store, correctionId, opts);
  const now = opts.now ?? new Date().toISOString();
  const homeView: HomeView = home === "public" ? { publicOnly: true } : { privateOnly: true };
  const sourceError = privateOnlySourceDecisionError(store, correction, home);
  if (sourceError) throw new Error(sourceError);
  const base = correctionEvidenceEvent(root, correction, dataClass);
  if (!base) throw new Error(`correction ${correction.id} has no valid occurrence time`);
  const prior = repository.getEvidence(base.id, homeView);
  const evidence = prior ?? repository.putEvidence(base, { private: home === "private", public: home === "public" });

  if (correction.status !== "active" || correction.valid_to || !isHumanConfirmed(correction.provenance.source)) {
    return result("legacy_only", correction, "Only an active human-confirmed correction can be upgraded.", evidence);
  }
  const scope = concreteScope(correction);
  if (scope.file === null) {
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, "uncompilable", `${scope.reason} The legacy Constraint remains active.`, null), home);
    return result("legacy_only", correction, scope.reason, classified);
  }
  const unsafeScope = unsafeSourceScopeReason(root, scope.file);
  if (unsafeScope) {
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, "uncompilable", `${unsafeScope}. The legacy Constraint remains active.`, null), home);
    return result("legacy_only", correction, unsafeScope, classified);
  }
  if (!isGitCleanPath(root, scope.file)) {
    const reason = `${scope.file} is not a clean committed source baseline; commit the fix before Hunch builds a proof packet`;
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, "eligible", `${reason}. The legacy Constraint remains active.`, null), home);
    return result("pending", correction, reason, classified);
  }
  const forbidden = exactForbiddenDependency(correction);
  if (forbidden.dependency === null) {
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, "uncompilable", `${forbidden.reason} The legacy Constraint remains active.`, null), home);
    return result("legacy_only", correction, forbidden.reason, classified);
  }

  const inspection = inspectExternalImportBoundary(store, scope.file, forbidden.dependency, { publicOnly: home === "public" });
  if (!inspection.candidate) {
    const pending = inspection.code === "baseline_violated";
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(
      base,
      pending ? "eligible" : "uncompilable",
      `${inspection.reason}. The legacy Constraint remains active.`,
      null,
    ), home);
    return result(pending ? "pending" : "legacy_only", correction, inspection.reason, classified);
  }
  const candidate = inspection.candidate;
  let context = candidateContext(candidate);
  const compiled = compileCorrectionPolicy(store, {
    source: correction,
    evidenceId: base.id,
    assertion: candidate.assertion,
    scope: candidate.scope,
    dataClass,
    candidate: context,
    now,
  });
  const conflicts = liveConflicts(repository, compiled.policy, home);
  if (conflicts.length) {
    context = candidateContext(candidate, conflicts);
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(
      base,
      "conflicted",
      `The exact supported correction projection conflicts with ${conflicts.join(", ")}; no policy or authority changed.`,
      null,
      context,
    ), home);
    return result("conflicted", correction, classified.compiler!.reason, classified);
  }

  const key = structuralKey(compiled.policy);
  const handleIncumbent = (policy: PolicySpec): CorrectionPolicyUpgrade => {
    if (structuralKey(policy) !== key) {
      const reason = `Policy id ${policy.id} is occupied by different semantics; no lifecycle or authority changed.`;
      const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, "conflicted", reason, null, context), home);
      return result("conflicted", correction, reason, classified);
    }
    const packet = reusableProofPacket(store, root, repository, policy, homeView);
    if (!("reason" in packet)) {
      const compiledHere = policy.audit.some((event) => event.action === "compiled"
        && event.actor === "hunch:correction-policy-materializer");
      const status = prior?.compiler?.status === "compiled" || compiledHere ? "compiled" : "covered";
      const classified = putEvidenceIfChanged(repository, classifiedEvidence(
        base,
        status,
        status === "compiled"
          ? `One exact supported correction projection was proved without granting authority: ${candidate.reason}.`
          : "An equivalent proved policy already covers this supported projection; lifecycle and authority were preserved.",
        policy.id,
        context,
      ), home);
      return result(
        "already_proved",
        correction,
        classified.compiler!.reason,
        classified,
        policy,
        packet.plan,
        packet.proof,
        reviewFor(correction, candidate, policy),
      );
    }
    const retryable = ["compiled", "validating", "proposed"].includes(policy.state);
    const status = retryable ? "eligible" : "conflicted";
    const reason = retryable
      ? `Equivalent policy ${policy.id} is preserved, but its proof packet is not reusable (${packet.reason}); automatic retry will not rewrite the incumbent.`
      : `Equivalent policy ${policy.id} is ${policy.state} without a reusable proof packet (${packet.reason}); lifecycle and authority were preserved.`;
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, status, reason, null, context), home);
    return result(retryable ? "pending" : "conflicted", correction, reason, classified);
  };

  const incumbent = repository.getPolicy(compiled.policy.id, homeView)
    ?? repository.listPolicies(homeView).find((policy) => structuralKey(policy) === key);
  if (incumbent) return handleIncumbent(incumbent);

  const generatedPlan = createProofPlan(store, root, repository, compiled.policy, {
    ...homeView,
    maxCommits: 0,
    maxMutations: 3,
    maxMinutes: 1,
    repositoryName: stableRepositoryName(root),
    now,
  });
  const generatedProof = provePolicy(store, root, compiled.policy, {
    publicOnly: home === "public",
    plan: generatedPlan,
    now,
  });
  if (generatedProof.proof_class !== "P3") {
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(
      base,
      "eligible",
      `The supported projection is exact, but the bounded proof reached ${generatedProof.proof_class}; no policy was written and the legacy Constraint remains active.`,
      null,
      context,
    ), home);
    return result("pending", correction, classified.compiler!.reason, classified);
  }

  // Proof execution is deliberately outside the publication critical section.
  // Re-read every mutable lifecycle input before writing deterministic artifacts.
  const expectedHead = generatedPlan.corpus.current_baseline.ref;
  const inputError = publicationInputError(store, root, correction, home, expectedHead, scope.file);
  if (inputError) {
    const compilerStatus = inputError.status === "pending" ? "eligible" : "conflicted";
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, compilerStatus, inputError.reason, null, context), home);
    return result(inputError.status, correction, inputError.reason, classified);
  }
  const postProofConflicts = liveConflicts(repository, compiled.policy, home);
  if (postProofConflicts.length) {
    context = candidateContext(candidate, postProofConflicts);
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(
      base,
      "conflicted",
      `A live conflicting policy appeared during proof (${postProofConflicts.join(", ")}); no policy or authority changed.`,
      null,
      context,
    ), home);
    return result("conflicted", correction, classified.compiler!.reason, classified);
  }
  const postProofIncumbent = repository.getPolicy(compiled.policy.id, homeView)
    ?? repository.listPolicies(homeView).find((policy) => structuralKey(policy) === key);
  if (postProofIncumbent) return handleIncumbent(postProofIncumbent);

  const planClaim = repository.putPlanIfAbsent(generatedPlan, compiled.policy.id, {
    private: home === "private",
    public: home === "public",
  });
  if (planClaim.plan.content_hash !== generatedPlan.content_hash) {
    throw new Error(`proof plan ${generatedPlan.id} already exists with different canonical content`);
  }
  const plan = planClaim.plan;
  const proofClaim = repository.putProofIfAbsent(generatedProof, compiled.policy.id, {
    private: home === "private",
    public: home === "public",
  });
  if (proofPayloadHash(proofClaim.proof) !== proofPayloadHash(generatedProof)) {
    throw new Error(`proof ${generatedProof.id} already exists with different deterministic content`);
  }
  const proof = proofClaim.proof;
  const prePublishError = publicationInputError(store, root, correction, home, expectedHead, scope.file);
  if (prePublishError) {
    const compilerStatus = prePublishError.status === "pending" ? "eligible" : "conflicted";
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, compilerStatus, prePublishError.reason, null, context), home);
    return result(prePublishError.status, correction, prePublishError.reason, classified);
  }
  const proposed = proposeProvedPolicy(compiled.policy, proof, now);
  const published = repository.putPolicyIfAbsent(proposed, { private: home === "private", public: home === "public" });
  if (!published.created) return handleIncumbent(published.policy);
  const policy = published.policy;
  const finalInputError = publicationInputError(store, root, correction, home, expectedHead, scope.file);
  const finalConflicts = liveConflicts(repository, compiled.policy, home);
  if (finalInputError || finalConflicts.length) {
    const reason = finalInputError?.reason
      ?? `A live conflicting policy appeared during publication (${finalConflicts.join(", ")}); the persisted proposal remains non-authoritative and activation-blocked.`;
    context = candidateContext(candidate, finalConflicts);
    const classified = putEvidenceIfChanged(repository, classifiedEvidence(base, "conflicted", reason, policy.id, context), home);
    return result("conflicted", correction, reason, classified, policy, plan, proof);
  }
  const classified = putEvidenceIfChanged(repository, classifiedEvidence(
    base,
    "compiled",
    `One exact supported correction projection was proved without granting authority: ${candidate.reason}.`,
    policy.id,
    context,
  ), home);
  return result("proved", correction, classified.compiler!.reason, classified, policy, plan, proof, reviewFor(correction, candidate));
}

/** Durable retry queue: the captured Constraints are the source of truth, so a
 * crashed process needs no in-memory job record. Normal indexing and post-commit
 * sync can safely rescan both exact homes; every artifact is deterministic and
 * no result grants authority. */
export function materializeCorrectionPolicies(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  opts: CorrectionUpgradeOptions = {},
): CorrectionPolicySweep {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly && !store.hasPrivate) throw new Error("private correction upgrade needs a configured Hunch private overlay");
  const homes: Home[] = opts.publicOnly
    ? ["public"]
    : opts.privateOnly
      ? ["private"]
      : store.hasPrivate ? ["public", "private"] : ["public"];
  const now = opts.now ?? new Date().toISOString();
  const upgrades: CorrectionPolicyUpgrade[] = [];
  const failed: CorrectionPolicySweep["failed"] = [];
  for (const home of homes) {
    const corrections = store.recsInHome("constraints", home)
      .filter((correction) => correction.status === "active"
        && !correction.valid_to
        && isHumanConfirmed(correction.provenance.source))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const correction of corrections) {
      try {
        upgrades.push(materializeCorrectionPolicy(store, root, repository, correction.id, {
          publicOnly: home === "public",
          privateOnly: home === "private",
          now,
        }));
      } catch (error) {
        failed.push({ correction_id: correction.id, home, error: (error as Error).message });
      }
    }
  }
  const count = (status: CorrectionPolicyUpgrade["status"]): number =>
    upgrades.filter((upgrade) => upgrade.status === status).length;
  return {
    scanned: upgrades.length + failed.length,
    proved: count("proved"),
    already_proved: count("already_proved"),
    legacy_only: count("legacy_only"),
    pending: count("pending"),
    conflicted: count("conflicted"),
    failed,
    upgrades,
    authority: "none",
  };
}
