import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { writeFileAtomic } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import { policySemanticHash, proofPlanContentHash } from "./canonical.js";
import { proofCorpusContentHash } from "./corpus.js";
import { currentHistoryDispositions, historyDispositionContentHash, historyDispositionJudgmentHash } from "./disposition.js";
import { assertCompositionBinding, compositionDescendants, policyProofHash } from "./composition.js";
import {
  HistoryDispositionSchema,
  ProofCorpusSchema,
  PolicyProofSchema,
  ProofPlanSchema,
  PolicySpecSchema,
  EvidenceEventSchema,
  type EvidenceEvent,
  type HistoryDisposition,
  type ProofCorpus,
  type PolicyProof,
  type ProofPlan,
  type PolicySpec,
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

  private dir(home: "public" | "private", kind: "policies" | "proofs" | "plans" | "evidence" | "corpora" | "dispositions"): string {
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

  putProof(proof: PolicyProof, policyId: string): PolicyProof {
    const parsed = PolicyProofSchema.parse(proof);
    const home = this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
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

  putPlan(plan: ProofPlan, policyId: string, opts: { private?: boolean; public?: boolean } = {}): ProofPlan {
    const parsed = validatePlan(plan);
    if (opts.private && opts.public) throw new Error("choose only one proof-plan home");
    const home = opts.private
      ? "private"
      : opts.public
        ? "public"
        : this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
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

  putEvidence(event: EvidenceEvent, opts: { private?: boolean } = {}): EvidenceEvent {
    const parsed = EvidenceEventSchema.parse(event);
    const home = opts.private || parsed.data_class !== "public" || this.store.unified ? "private" : "public";
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

/** One-time private migration for the Constitution's standalone Git-native
 * records. Copy/validate everything before deleting the public directories;
 * private records win on an id collision. */
export function movePolicyArtifactsToPrivate(publicHunchDir: string, privateHunchDir: string): { policies: number; proofs: number; plans: number; evidence: number; corpora: number; dispositions: number } {
  const counts = { policies: 0, proofs: 0, plans: 0, evidence: 0, corpora: 0, dispositions: 0 };
  type Kind = keyof typeof counts;
  type Artifact = { id: string; policy_id?: string };
  const specs: Array<{ kind: Kind; parse: (raw: unknown) => Artifact }> = [
    { kind: "policies", parse: (value) => PolicySpecSchema.parse(value) },
    { kind: "proofs", parse: (value) => PolicyProofSchema.parse(value) },
    { kind: "plans", parse: validatePlan },
    { kind: "evidence", parse: (value) => EvidenceEventSchema.parse(value) },
    { kind: "corpora", parse: validateCorpus },
    { kind: "dispositions", parse: validateDisposition },
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
