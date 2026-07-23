import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { writeFileAtomic, writeFileAtomicIfAbsent } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import { canonicalHash, policySemanticHash, proofPlanContentHash } from "./canonical.js";
import { proofCorpusContentHash } from "./corpus.js";
import { currentHistoryDispositions, historyDispositionContentHash, historyDispositionJudgmentHash } from "./disposition.js";
import { assertCompositionBinding, compositionDescendants, policyProofHash } from "./composition.js";
import {
  currentShadowDispositions,
  policyEvaluationContentHash,
  shadowDispositionContentHash,
  shadowDispositionJudgmentHash,
  shadowEvaluationContentHash,
  shadowEvaluationIdentityHash,
} from "./shadow.js";
import {
  HistoryDispositionSchema,
  ProofCorpusSchema,
  PolicyProofSchema,
  ProofPlanSchema,
  PolicySpecSchema,
  ShadowRecordSchema,
  EvidenceEventSchema,
  type EvidenceEvent,
  type HistoryDisposition,
  type ProofCorpus,
  type PolicyProof,
  type ProofPlan,
  type PolicySpec,
  type ShadowDisposition,
  type ShadowEvaluationRecord,
  type ShadowRecord,
} from "./schema.js";

const encode = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

function loadRecords<T>(dir: string, parse: (raw: unknown) => T, label: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      out.push(parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    } catch (e) {
      // A policy store can control CI. Skipping a corrupt record would turn an
      // enforcement failure into a false pass, so fail visibly instead.
      throw new Error(`invalid ${label}/${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Git-native policy/proof source of truth. Kept separate from the legacy entity
 * registry for the first slice so existing schema-v2 repositories and SQLite
 * compatibility remain unchanged. */
export class PolicyRepository {
  private readonly publicHome: string;
  private readonly privateHome?: string;

  constructor(root: string, private readonly store: HunchStore) {
    this.publicHome = join(root, ".hunch");
    this.privateHome = store.privateDir;
  }

  private dir(home: "public" | "private", kind: "policies" | "proofs" | "plans" | "evidence" | "corpora" | "dispositions" | "shadow"): string {
    const base = home === "private" ? this.privateHome : this.publicHome;
    if (!base) throw new Error("No private Hunch overlay is configured; refusing to write a private policy.");
    return join(base, kind);
  }

  private policiesIn(home: "public" | "private"): PolicySpec[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "policies"), (v) => PolicySpecSchema.parse(v), "policies");
  }

  private proofsIn(home: "public" | "private"): PolicyProof[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "proofs"), (v) => PolicyProofSchema.parse(v), "proofs");
  }

  private evidenceIn(home: "public" | "private"): EvidenceEvent[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "evidence"), (v) => EvidenceEventSchema.parse(v), "evidence");
  }

  private plansIn(home: "public" | "private"): ProofPlan[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "plans"), validatePlan, "plans");
  }

  private corporaIn(home: "public" | "private"): ProofCorpus[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "corpora"), validateCorpus, "corpora");
  }

  private dispositionsIn(home: "public" | "private"): HistoryDisposition[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "dispositions"), validateDisposition, "dispositions");
  }

  private shadowIn(home: "public" | "private"): ShadowRecord[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "shadow"), validateShadowRecord, "shadow");
  }

  listPolicies(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicySpec[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.policiesIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.policiesIn("public").map((p) => [p.id, p]));
    if (!opts.publicOnly) for (const p of this.policiesIn("private")) byId.set(p.id, p);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getPolicy(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicySpec | undefined {
    return this.listPolicies(opts).find((p) => p.id === id);
  }

  getProof(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicyProof | undefined {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.proofsIn("private").find((proof) => proof.id === id);
    const byId = new Map(this.proofsIn("public").map((p) => [p.id, p]));
    if (!opts.publicOnly) for (const p of this.proofsIn("private")) byId.set(p.id, p);
    return byId.get(id);
  }

  listProofs(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicyProof[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.proofsIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.proofsIn("public").map((proof) => [proof.id, proof]));
    if (!opts.publicOnly) for (const proof of this.proofsIn("private")) byId.set(proof.id, proof);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  listPlans(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofPlan[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.plansIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.plansIn("public").map((p) => [p.id, p]));
    if (!opts.publicOnly) for (const p of this.plansIn("private")) byId.set(p.id, p);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getPlan(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofPlan | undefined {
    return this.listPlans(opts).find((p) => p.id === id);
  }

  getCorpus(policyId: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofCorpus | undefined {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.corporaIn("private").find((corpus) => corpus.policy_id === policyId);
    const publicCorpus = this.corporaIn("public").find((corpus) => corpus.policy_id === policyId);
    if (opts.publicOnly) return publicCorpus;
    return this.corporaIn("private").find((corpus) => corpus.policy_id === policyId) ?? publicCorpus;
  }

  listCorpora(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofCorpus[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.corporaIn("private").sort((a, b) => a.policy_id.localeCompare(b.policy_id));
    const byPolicy = new Map(this.corporaIn("public").map((corpus) => [corpus.policy_id, corpus]));
    if (!opts.publicOnly) for (const corpus of this.corporaIn("private")) byPolicy.set(corpus.policy_id, corpus);
    return [...byPolicy.values()].sort((a, b) => a.policy_id.localeCompare(b.policy_id));
  }

  listEvidence(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): EvidenceEvent[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.evidenceIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.evidenceIn("public").map((e) => [e.id, e]));
    if (!opts.publicOnly) for (const e of this.evidenceIn("private")) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getEvidence(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): EvidenceEvent | undefined {
    return this.listEvidence(opts).find((e) => e.id === id);
  }

  listDispositions(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): HistoryDisposition[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) {
      const records = this.dispositionsIn("private");
      currentHistoryDispositions(records);
      return records.sort((left, right) => left.id.localeCompare(right.id));
    }
    const byId = new Map(this.dispositionsIn("public").map((record) => [record.id, record]));
    if (!opts.publicOnly) for (const record of this.dispositionsIn("private")) byId.set(record.id, record);
    const records = [...byId.values()];
    currentHistoryDispositions(records);
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  listShadowEvaluations(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ShadowEvaluationRecord[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    const records = opts.privateOnly
      ? this.shadowIn("private")
      : [...this.shadowIn("public"), ...(opts.publicOnly ? [] : this.shadowIn("private"))];
    const byId = new Map(records.filter((record): record is ShadowEvaluationRecord => record.record_type === "evaluation").map((record) => [record.id, record]));
    return [...byId.values()].sort((left, right) => left.observed_at.localeCompare(right.observed_at) || left.id.localeCompare(right.id));
  }

  listShadowDispositions(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ShadowDisposition[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    const records = opts.privateOnly
      ? this.shadowIn("private")
      : [...this.shadowIn("public"), ...(opts.publicOnly ? [] : this.shadowIn("private"))];
    const byId = new Map(records.filter((record): record is ShadowDisposition => record.record_type === "disposition").map((record) => [record.id, record]));
    const dispositions = [...byId.values()];
    currentShadowDispositions(dispositions);
    return dispositions.sort((left, right) => left.id.localeCompare(right.id));
  }

  homeOfPolicy(id: string): "public" | "private" | undefined {
    if (this.privateHome && existsSync(join(this.dir("private", "policies"), `${id}.json`))) return "private";
    if (existsSync(join(this.dir("public", "policies"), `${id}.json`))) return "public";
    return undefined;
  }

  putPolicy(policy: PolicySpec, opts: { private?: boolean } = {}): PolicySpec {
    const parsed = PolicySpecSchema.parse(policy);
    const existing = this.homeOfPolicy(parsed.id);
    if (existing === "public" && parsed.data_class !== "public" && !opts.private) {
      throw new Error(`refusing to write ${parsed.data_class} policy ${parsed.id} into its existing public home; migrate it to the private overlay first`);
    }
    const home = opts.private ? "private" : existing ?? (parsed.data_class !== "public" || this.store.unified ? "private" : "public");
    const dir = this.dir(home, "policies");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  /** Publish a new policy lifecycle record without overwriting a concurrent
   * writer. Used by automated proposal materializers so human authority always
   * wins a race. */
  putPolicyIfAbsent(policy: PolicySpec, opts: { private?: boolean; public?: boolean } = {}): { policy: PolicySpec; created: boolean } {
    const parsed = PolicySpecSchema.parse(policy);
    if (opts.private && opts.public) throw new Error("choose only one policy home");
    const home = opts.private ? "private" : opts.public ? "public" : parsed.data_class !== "public" || this.store.unified ? "private" : "public";
    if (home === "public" && parsed.data_class !== "public") {
      throw new Error(`refusing to write ${parsed.data_class} policy ${parsed.id} into the public home`);
    }
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const existing = this.getPolicy(parsed.id, homeOpts);
    const otherHome = this.getPolicy(parsed.id, home === "public" ? { privateOnly: true } : { publicOnly: true });
    if (existing && otherHome) throw new Error(`policy ${parsed.id} exists in both public and private homes`);
    if (existing) return { policy: existing, created: false };
    if (otherHome) throw new Error(`policy ${parsed.id} already exists in the ${home === "public" ? "private" : "public"} home`);
    const dir = this.dir(home, "policies");
    mkdirSync(dir, { recursive: true });
    if (writeFileAtomicIfAbsent(join(dir, `${parsed.id}.json`), encode(parsed))) {
      const racedOtherHome = this.getPolicy(parsed.id, home === "public" ? { privateOnly: true } : { publicOnly: true });
      if (racedOtherHome) throw new Error(`policy ${parsed.id} was published concurrently in both public and private homes`);
      return { policy: parsed, created: true };
    }
    const winner = this.getPolicy(parsed.id, homeOpts);
    if (!winner) throw new Error(`policy ${parsed.id} appeared concurrently but could not be read`);
    return { policy: winner, created: false };
  }

  putProof(proof: PolicyProof, policyId: string, opts: { private?: boolean; public?: boolean } = {}): PolicyProof {
    const parsed = PolicyProofSchema.parse(proof);
    if (opts.private && opts.public) throw new Error("choose only one proof home");
    const home = opts.private
      ? "private"
      : opts.public
        ? "public"
        : this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
    if (home === "public" && parsed.data_class !== "public") {
      throw new Error(`refusing to write ${parsed.data_class} proof ${parsed.id} into the public home`);
    }
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const policy = this.getPolicy(policyId, homeOpts);
    if (policy) {
      const composition = compositionDescendants(policy, this.listPolicies(homeOpts));
      assertCompositionBinding(policy, composition, parsed.composition);
      if (parsed.policy_hash !== policyProofHash(policy, composition)) throw new Error(`composite proof ${parsed.id} policy hash mismatch`);
      if (composition.length) {
        const plan = this.listPlans(homeOpts).find((candidate) => candidate.content_hash === parsed.plan_hash);
        if (!plan || plan.policy_candidate_hash !== parsed.policy_hash) throw new Error(`composite proof ${parsed.id} has no exact bound proof plan`);
        assertCompositionBinding(policy, composition, plan.composition);
      }
    }
    const dir = this.dir(home, "proofs");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  /** Publish an immutable proof without replacing a concurrent writer. */
  putProofIfAbsent(proof: PolicyProof, policyId: string, opts: { private?: boolean; public?: boolean } = {}): { proof: PolicyProof; created: boolean } {
    const parsed = PolicyProofSchema.parse(proof);
    if (opts.private && opts.public) throw new Error("choose only one proof home");
    const home = opts.private
      ? "private"
      : opts.public
        ? "public"
        : this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
    if (home === "public" && parsed.data_class !== "public") {
      throw new Error(`refusing to write ${parsed.data_class} proof ${parsed.id} into the public home`);
    }
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const policy = this.getPolicy(policyId, homeOpts);
    if (policy) {
      const composition = compositionDescendants(policy, this.listPolicies(homeOpts));
      assertCompositionBinding(policy, composition, parsed.composition);
      if (parsed.policy_hash !== policyProofHash(policy, composition)) throw new Error(`composite proof ${parsed.id} policy hash mismatch`);
      if (composition.length) {
        const plan = this.listPlans(homeOpts).find((candidate) => candidate.content_hash === parsed.plan_hash);
        if (!plan || plan.policy_candidate_hash !== parsed.policy_hash) throw new Error(`composite proof ${parsed.id} has no exact bound proof plan`);
        assertCompositionBinding(policy, composition, plan.composition);
      }
    }
    const existing = this.getProof(parsed.id, homeOpts);
    if (existing) {
      if (immutableProofHash(existing) !== immutableProofHash(parsed)) throw new Error(`proof ${parsed.id} already exists with different immutable content`);
      return { proof: existing, created: false };
    }
    const dir = this.dir(home, "proofs");
    mkdirSync(dir, { recursive: true });
    if (writeFileAtomicIfAbsent(join(dir, `${parsed.id}.json`), encode(parsed))) return { proof: parsed, created: true };
    const winner = this.getProof(parsed.id, homeOpts);
    if (!winner) throw new Error(`proof ${parsed.id} appeared concurrently but could not be read`);
    if (immutableProofHash(winner) !== immutableProofHash(parsed)) throw new Error(`proof ${parsed.id} appeared concurrently with different immutable content`);
    return { proof: winner, created: false };
  }

  putPlan(plan: ProofPlan, policyId: string, opts: { private?: boolean; public?: boolean } = {}): ProofPlan {
    const parsed = validatePlan(plan);
    if (opts.private && opts.public) throw new Error("choose only one proof-plan home");
    const home = opts.private
      ? "private"
      : opts.public
        ? "public"
        : this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
    if (home === "public" && parsed.data_class !== "public") {
      throw new Error(`refusing to write ${parsed.data_class} proof plan ${parsed.id} into the public home`);
    }
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const policy = this.getPolicy(policyId, homeOpts);
    if (policy) {
      const composition = compositionDescendants(policy, this.listPolicies(homeOpts));
      assertCompositionBinding(policy, composition, parsed.composition);
      if (parsed.policy_candidate_hash !== policyProofHash(policy, composition)) throw new Error(`composite plan ${parsed.id} policy hash mismatch`);
    }
    const dir = this.dir(home, "plans");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  /** Publish an immutable proof plan without replacing a concurrent writer. */
  putPlanIfAbsent(plan: ProofPlan, policyId: string, opts: { private?: boolean; public?: boolean } = {}): { plan: ProofPlan; created: boolean } {
    const parsed = validatePlan(plan);
    if (opts.private && opts.public) throw new Error("choose only one proof-plan home");
    const home = opts.private
      ? "private"
      : opts.public
        ? "public"
        : this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
    if (home === "public" && parsed.data_class !== "public") {
      throw new Error(`refusing to write ${parsed.data_class} proof plan ${parsed.id} into the public home`);
    }
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const policy = this.getPolicy(policyId, homeOpts);
    if (policy) {
      const composition = compositionDescendants(policy, this.listPolicies(homeOpts));
      assertCompositionBinding(policy, composition, parsed.composition);
      if (parsed.policy_candidate_hash !== policyProofHash(policy, composition)) throw new Error(`composite plan ${parsed.id} policy hash mismatch`);
    }
    const existing = this.getPlan(parsed.id, homeOpts);
    if (existing) {
      if (existing.content_hash !== parsed.content_hash) throw new Error(`proof plan ${parsed.id} already exists with different immutable content`);
      return { plan: existing, created: false };
    }
    const dir = this.dir(home, "plans");
    mkdirSync(dir, { recursive: true });
    if (writeFileAtomicIfAbsent(join(dir, `${parsed.id}.json`), encode(parsed))) return { plan: parsed, created: true };
    const winner = this.getPlan(parsed.id, homeOpts);
    if (!winner) throw new Error(`proof plan ${parsed.id} appeared concurrently but could not be read`);
    if (winner.content_hash !== parsed.content_hash) throw new Error(`proof plan ${parsed.id} appeared concurrently with different immutable content`);
    return { plan: winner, created: false };
  }

  putCorpus(corpus: ProofCorpus, policyId: string): ProofCorpus {
    const parsed = validateCorpus(corpus);
    if (parsed.policy_id !== policyId) throw new Error(`corpus ${parsed.id} does not belong to policy ${policyId}`);
    const home = this.homeOfPolicy(policyId);
    if (!home) throw new Error(`cannot write corpus ${parsed.id}: policy ${policyId} has no exact storage home`);
    const policy = this.getPolicy(policyId, home === "public" ? { publicOnly: true } : { privateOnly: true });
    if (!policy || parsed.data_class !== policy.data_class || parsed.policy_hash !== policySemanticHash(policy)) {
      throw new Error(`corpus ${parsed.id} does not match policy ${policyId} semantics/data class`);
    }
    const dir = this.dir(home, "corpora");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${policyId}.json`), encode(parsed));
    return parsed;
  }

  putEvidence(event: EvidenceEvent, opts: { private?: boolean; public?: boolean } = {}): EvidenceEvent {
    const parsed = EvidenceEventSchema.parse(event);
    if (opts.private && opts.public) throw new Error("choose only one evidence home");
    const home = opts.private ? "private" : opts.public ? "public" : parsed.data_class !== "public" || this.store.unified ? "private" : "public";
    if (home === "public" && parsed.data_class !== "public") {
      throw new Error(`refusing to write ${parsed.data_class} evidence ${parsed.id} into the public home`);
    }
    const dir = this.dir(home, "evidence");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  putDisposition(disposition: HistoryDisposition, policyId: string): HistoryDisposition {
    const parsed = validateDisposition(disposition);
    if (parsed.policy_id !== policyId) throw new Error(`history disposition ${parsed.id} does not belong to policy ${policyId}`);
    const home = this.homeOfPolicy(policyId);
    if (!home) throw new Error(`cannot write history disposition ${parsed.id}: policy ${policyId} has no exact storage home`);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const policy = this.getPolicy(policyId, homeOpts);
    const composition = policy ? compositionDescendants(policy, this.listPolicies(homeOpts)) : [];
    if (!policy || policy.data_class !== parsed.data_class || policy.proof !== parsed.proof_id || policyProofHash(policy, composition) !== parsed.policy_hash) {
      throw new Error(`history disposition ${parsed.id} does not match policy ${policyId} semantics/proof/data class`);
    }
    const proof = this.getProof(parsed.proof_id, homeOpts);
    const receipt = proof?.replay_receipts.find((candidate) => candidate.leg === "accepted_history" && candidate.result === "violated" && candidate.commit === parsed.commit && candidate.deterministic_hash === parsed.receipt_hash);
    if (!proof || proof.policy_hash !== parsed.policy_hash || proof.plan_hash !== parsed.plan_hash || proof.data_class !== parsed.data_class || !receipt) {
      throw new Error(`history disposition ${parsed.id} does not match an exact violated accepted-history receipt in proof ${parsed.proof_id}`);
    }
    const records = this.listDispositions(homeOpts);
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const sameJudgment = records.find((record) => historyDispositionJudgmentHash(record) === historyDispositionJudgmentHash(parsed));
    if (sameJudgment) return sameJudgment;
    const hitRecords = records.filter((record) => record.policy_id === policyId && record.proof_id === parsed.proof_id && record.commit === parsed.commit);
    const current = currentHistoryDispositions(hitRecords)[0];
    if (current && parsed.supersedes !== current.id) {
      throw new Error(`history hit ${parsed.commit} already has current disposition ${current.id}; pass --supersedes ${current.id} to append a correction`);
    }
    if (!current && parsed.supersedes) throw new Error(`history disposition ${parsed.id} supersedes no current disposition for this proof hit`);
    currentHistoryDispositions([...records, parsed]);
    const dir = this.dir(home, "dispositions");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  putShadowEvaluation(evaluation: ShadowEvaluationRecord, policyId: string): ShadowEvaluationRecord {
    const parsed = validateShadowEvaluation(evaluation);
    if (parsed.policy_id !== policyId) throw new Error(`shadow evaluation ${parsed.id} does not belong to policy ${policyId}`);
    const home = this.homeOfPolicy(policyId);
    if (!home) throw new Error(`cannot write shadow evaluation ${parsed.id}: policy ${policyId} has no exact storage home`);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const policy = this.getPolicy(policyId, homeOpts);
    const proof = policy?.proof ? this.getProof(policy.proof, homeOpts) : undefined;
    const composition = policy ? compositionDescendants(policy, this.listPolicies(homeOpts)) : [];
    if (!policy || !proof
      || policy.proof !== parsed.proof_id
      || proof.id !== parsed.proof_id
      || proof.plan_hash !== parsed.plan_hash
      || policyProofHash(policy, composition) !== parsed.policy_hash
      || proof.policy_hash !== parsed.policy_hash
      || policy.data_class !== parsed.data_class
      || parsed.evaluation.policy_id !== policyId
      || parsed.evaluation.evaluator.name !== proof.evaluator.name
      || parsed.evaluation.evaluator.version !== proof.evaluator.version
      || parsed.evaluation.deterministic_hash !== policyEvaluationContentHash(parsed.evaluation)) {
      throw new Error(`shadow evaluation ${parsed.id} does not match the current policy/proof/evaluation binding`);
    }
    const existing = this.listShadowEvaluations(homeOpts).find((record) => shadowEvaluationIdentityHash(record) === shadowEvaluationIdentityHash(parsed));
    if (existing) return existing;
    const dir = this.dir(home, "shadow");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  putShadowDisposition(disposition: ShadowDisposition, policyId: string): ShadowDisposition {
    const parsed = validateShadowDisposition(disposition);
    if (parsed.policy_id !== policyId) throw new Error(`shadow disposition ${parsed.id} does not belong to policy ${policyId}`);
    const home = this.homeOfPolicy(policyId);
    if (!home) throw new Error(`cannot write shadow disposition ${parsed.id}: policy ${policyId} has no exact storage home`);
    const homeOpts = home === "public" ? { publicOnly: true } : { privateOnly: true };
    const evaluation = this.listShadowEvaluations(homeOpts).find((record) => record.id === parsed.shadow_id);
    if (!evaluation
      || evaluation.evaluation.result !== "violated"
      || evaluation.policy_id !== parsed.policy_id
      || evaluation.proof_id !== parsed.proof_id
      || evaluation.policy_hash !== parsed.policy_hash
      || evaluation.evaluation.deterministic_hash !== parsed.evaluation_hash
      || evaluation.data_class !== parsed.data_class) {
      throw new Error(`shadow disposition ${parsed.id} does not match an exact violated shadow evaluation`);
    }
    const records = this.listShadowDispositions(homeOpts);
    const existing = records.find((record) => record.id === parsed.id);
    if (existing) return existing;
    const sameJudgment = records.find((record) => shadowDispositionJudgmentHash(record) === shadowDispositionJudgmentHash(parsed));
    if (sameJudgment) return sameJudgment;
    const evaluationRecords = records.filter((record) => record.shadow_id === parsed.shadow_id);
    const current = currentShadowDispositions(evaluationRecords)[0];
    if (current && parsed.supersedes !== current.id) {
      throw new Error(`shadow evaluation ${parsed.shadow_id} already has current disposition ${current.id}; pass --supersedes ${current.id} to append a correction`);
    }
    if (!current && parsed.supersedes) throw new Error(`shadow disposition ${parsed.id} supersedes no current disposition for this evaluation`);
    currentShadowDispositions([...records, parsed]);
    const dir = this.dir(home, "shadow");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }
}

function immutableProofHash(proof: PolicyProof): string {
  const { generated_at: _generatedAt, ...payload } = proof;
  return canonicalHash(payload);
}

function validatePlan(raw: unknown): ProofPlan {
  const plan = ProofPlanSchema.parse(raw);
  const hash = proofPlanContentHash(plan);
  if (plan.content_hash !== hash) throw new Error(`proof plan ${plan.id} content hash mismatch`);
  if (plan.id !== `plan_${shortHash(hash)}`) throw new Error(`proof plan ${plan.id} id does not match its canonical content`);
  return plan;
}

function validateCorpus(raw: unknown): ProofCorpus {
  const corpus = ProofCorpusSchema.parse(raw);
  const hash = proofCorpusContentHash(corpus);
  if (corpus.content_hash !== hash) throw new Error(`proof corpus ${corpus.id} content hash mismatch`);
  if (corpus.id !== `corpus_${shortHash(hash)}`) throw new Error(`proof corpus ${corpus.id} id does not match its canonical content`);
  return corpus;
}

function validateDisposition(raw: unknown): HistoryDisposition {
  const disposition = HistoryDispositionSchema.parse(raw);
  const hash = historyDispositionContentHash(disposition);
  if (disposition.content_hash !== hash) throw new Error(`history disposition ${disposition.id} content hash mismatch`);
  if (disposition.id !== `disp_${shortHash(hash)}`) throw new Error(`history disposition ${disposition.id} id does not match its canonical content`);
  return disposition;
}

function validateShadowRecord(raw: unknown): ShadowRecord {
  const record = ShadowRecordSchema.parse(raw);
  return record.record_type === "evaluation" ? validateShadowEvaluation(record) : validateShadowDisposition(record);
}

function validateShadowEvaluation(raw: unknown): ShadowEvaluationRecord {
  const record = ShadowRecordSchema.parse(raw);
  if (record.record_type !== "evaluation") throw new Error("expected a shadow evaluation record");
  const hash = shadowEvaluationContentHash(record);
  if (record.content_hash !== hash) throw new Error(`shadow evaluation ${record.id} content hash mismatch`);
  if (record.id !== `shadow_${shortHash(hash)}`) throw new Error(`shadow evaluation ${record.id} id does not match its canonical content`);
  if (record.evaluation.deterministic_hash !== policyEvaluationContentHash(record.evaluation)) throw new Error(`shadow evaluation ${record.id} receipt hash mismatch`);
  return record;
}

function validateShadowDisposition(raw: unknown): ShadowDisposition {
  const record = ShadowRecordSchema.parse(raw);
  if (record.record_type !== "disposition") throw new Error("expected a shadow disposition record");
  const hash = shadowDispositionContentHash(record);
  if (record.content_hash !== hash) throw new Error(`shadow disposition ${record.id} content hash mismatch`);
  if (record.id !== `sdisp_${shortHash(hash)}`) throw new Error(`shadow disposition ${record.id} id does not match its canonical content`);
  return record;
}

/** One-time private migration for the Constitution's standalone Git-native
 * records. Copy/validate everything before deleting the public directories;
 * private records win on an id collision. */
export function movePolicyArtifactsToPrivate(publicHunchDir: string, privateHunchDir: string): { policies: number; proofs: number; plans: number; evidence: number; corpora: number; dispositions: number; shadow: number } {
  const counts = { policies: 0, proofs: 0, plans: 0, evidence: 0, corpora: 0, dispositions: 0, shadow: 0 };
  type Kind = keyof typeof counts;
  type Artifact = { id: string; policy_id?: string };
  const specs: Array<{ kind: Kind; parse: (raw: unknown) => Artifact }> = [
    { kind: "policies", parse: (value) => PolicySpecSchema.parse(value) },
    { kind: "proofs", parse: (value) => PolicyProofSchema.parse(value) },
    { kind: "plans", parse: validatePlan },
    { kind: "evidence", parse: (value) => EvidenceEventSchema.parse(value) },
    { kind: "corpora", parse: validateCorpus },
    { kind: "dispositions", parse: validateDisposition },
    { kind: "shadow", parse: validateShadowRecord },
  ];
  const staged = specs.map(({ kind, parse }) => {
    const from = join(publicHunchDir, kind);
    const to = join(privateHunchDir, kind);
    const pub = existsSync(from) ? loadRecords(from, parse, kind) : [];
    const keyFor = (record: Artifact): string => kind === "corpora" ? record.policy_id! : record.id;
    const priv = new Map(loadRecords(to, parse, kind).map((r) => [keyFor(r), r]));
    return { kind, from, to, pub, priv, keyFor };
  });
  // All public and private records are parsed before the first write or delete.
  // A corrupt late category therefore cannot partially migrate earlier ones.
  const dispositions = staged.find((entry) => entry.kind === "dispositions");
  if (dispositions) {
    const union = new Map([...dispositions.pub, ...dispositions.priv.values()].map((record) => [record.id, record as HistoryDisposition]));
    currentHistoryDispositions([...union.values()]);
  }
  const shadow = staged.find((entry) => entry.kind === "shadow");
  if (shadow) {
    const union = new Map([...shadow.pub, ...shadow.priv.values()].map((record) => [record.id, record as ShadowRecord]));
    const shadowRecords = [...union.values()];
    const shadowEvaluations = shadowRecords.filter((record): record is ShadowEvaluationRecord => record.record_type === "evaluation");
    const shadowDispositions = shadowRecords.filter((record): record is ShadowDisposition => record.record_type === "disposition");
    currentShadowDispositions(shadowDispositions);
    const policyStage = staged.find((entry) => entry.kind === "policies")!;
    const proofStage = staged.find((entry) => entry.kind === "proofs")!;
    const policies = [...new Map([...policyStage.pub, ...policyStage.priv.values()].map((record) => [record.id, record as PolicySpec])).values()];
    const proofs = new Map([...proofStage.pub, ...proofStage.priv.values()].map((record) => [record.id, record as PolicyProof]));
    for (const evaluation of shadowEvaluations) {
      const policy = policies.find((record) => record.id === evaluation.policy_id);
      const proof = proofs.get(evaluation.proof_id);
      const composition = policy ? compositionDescendants(policy, policies) : [];
      if (!policy || !proof
        || policy.proof !== proof.id
        || proof.policy_hash !== evaluation.policy_hash
        || proof.plan_hash !== evaluation.plan_hash
        || policyProofHash(policy, composition) !== evaluation.policy_hash
        || evaluation.evaluation.policy_id !== policy.id
        || evaluation.evaluation.deterministic_hash !== policyEvaluationContentHash(evaluation.evaluation)) {
        throw new Error(`shadow evaluation ${evaluation.id} does not match migrated policy/proof semantics`);
      }
    }
    for (const disposition of shadowDispositions) {
      const evaluation = shadowEvaluations.find((record) => record.id === disposition.shadow_id);
      if (!evaluation
        || evaluation.evaluation.result !== "violated"
        || evaluation.policy_id !== disposition.policy_id
        || evaluation.proof_id !== disposition.proof_id
        || evaluation.policy_hash !== disposition.policy_hash
        || evaluation.evaluation.deterministic_hash !== disposition.evaluation_hash) {
        throw new Error(`shadow disposition ${disposition.id} does not match migrated evaluation`);
      }
    }
  }
  for (const { kind, from, to, pub, priv, keyFor } of staged) {
    if (!pub.length && !existsSync(from)) continue;
    mkdirSync(to, { recursive: true });
    for (const rec of pub) {
      const key = keyFor(rec);
      if (!priv.has(key)) writeFileAtomic(join(to, `${key}.json`), encode(rec));
    }
    rmSync(from, { recursive: true, force: true });
    counts[kind] = pub.length;
  }
  return counts;
}
