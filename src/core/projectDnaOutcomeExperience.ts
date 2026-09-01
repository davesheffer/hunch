import { createHash } from "node:crypto";
import { z } from "zod";
import { findingId } from "./ids.js";
import {
  PROJECT_DNA_CATEGORIES,
  type ProjectDnaCategory,
} from "./projectDna.js";
import { FindingSchema, isCredentialFreeText, type Finding } from "./types.js";

export const PROJECT_DNA_USEFULNESS_OBSERVATION_SCHEMA_VERSION =
  "hunch.project-dna-usefulness-observation/1" as const;

export const PROJECT_DNA_USEFULNESS_SIGNALS = [
  "used",
  "prevented",
  "near_miss",
  "contradicted",
  "stale",
  "unused",
  "unknown",
] as const;

export const PROJECT_DNA_USEFULNESS_EVIDENCE_KINDS = [
  "explicit_human_observation",
  "independent_review",
] as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const RECEIPT_REF = /^hunch-memory:hmctx_[a-f0-9]{32}$/;
const REPOSITORY_ID = /^pdnar_[a-f0-9]{24}$/;
const PROFILE_ID = /^pdna_[a-f0-9]{24}$/;
const TRAIT_ID = /^pdnat_[a-f0-9]{20}$/;
const OBSERVATION_ID = /^pduo_[a-f0-9]{24}$/;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

const ProjectDnaUsefulnessEvidenceSchema = z.object({
  kind: z.enum(PROJECT_DNA_USEFULNESS_EVIDENCE_KINDS),
  ref: z.string().min(1).max(512),
  hash: z.string().regex(SHA256),
}).strict();

export const ProjectDnaUsefulnessObservationSchema = z.object({
  schema: z.literal(PROJECT_DNA_USEFULNESS_OBSERVATION_SCHEMA_VERSION),
  observationId: z.string().regex(OBSERVATION_ID),
  episode: z.object({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    schemaVersion: z.string().min(3).max(128),
    episodeId: z.string().min(3).max(256),
    episodeHash: z.string().regex(SHA256),
    terminalAt: z.string().min(1).max(64),
    result: z.enum(["pass", "fail", "uncertain", "abandoned", "rolled_back"]),
  }).strict(),
  delivery: z.object({
    receiptRef: z.string().regex(RECEIPT_REF),
    receiptHash: z.string().regex(SHA256),
    repositoryId: z.string().regex(REPOSITORY_ID),
    repositoryRevision: z.string().regex(GIT_OBJECT),
    profileId: z.string().regex(PROFILE_ID),
    profileContentHash: z.string().regex(SHA256),
    snapshotHash: z.string().regex(SHA256),
    retrievalHash: z.string().regex(SHA256),
  }).strict(),
  projection: z.object({
    role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    categories: z.array(z.enum(PROJECT_DNA_CATEGORIES)).min(1).max(PROJECT_DNA_CATEGORIES.length),
    traitIds: z.array(z.string().regex(TRAIT_ID)).min(1).max(64),
    evidenceHashes: z.array(z.string().regex(SHA256)).min(1).max(512),
  }).strict(),
  artifact: z.object({
    kind: z.enum(["commit", "pull_request", "issue", "message"]),
    ref: z.string().min(3).max(512),
    contentHash: z.string().regex(SHA256),
  }).strict(),
  assessment: z.object({
    schemaVersion: z.string().min(3).max(128),
    assessmentId: z.string().min(3).max(128),
    contentHash: z.string().regex(SHA256),
    projectMatchClassification: z.enum(["unassessable", "conformant", "mixed", "nonconformant"]),
    causalInterpretation: z.literal("project_match_is_non_causal"),
  }).strict(),
  signal: z.enum(PROJECT_DNA_USEFULNESS_SIGNALS),
  evidence: z.array(ProjectDnaUsefulnessEvidenceSchema).max(64),
  observedAt: z.string().min(1).max(64),
  retainUntil: z.string().min(1).max(64),
  privacy: z.object({
    payloadMode: z.literal("references_hashes_only"),
    rawArtifactIncluded: z.literal(false),
    rawFeedbackIncluded: z.literal(false),
    rawProfileIncluded: z.literal(false),
  }).strict(),
  authority: z.object({
    behavioralEffect: z.literal("none"),
    mayChangeRanking: z.literal(false),
    mayPromoteKnowledge: z.literal(false),
    mayGrantAuthority: z.literal(false),
  }).strict(),
  contentHash: z.string().regex(SHA256),
}).strict().superRefine((observation, ctx) => {
  for (const [path, value] of [
    [["episode", "terminalAt"], observation.episode.terminalAt],
    [["observedAt"], observation.observedAt],
    [["retainUntil"], observation.retainUntil],
  ] as const) {
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "Project DNA usefulness timestamp is invalid" });
    }
  }
  const observedAt = Date.parse(observation.observedAt);
  const terminalAt = Date.parse(observation.episode.terminalAt);
  const retainUntil = Date.parse(observation.retainUntil);
  if (Number.isFinite(observedAt) && Number.isFinite(terminalAt) && observedAt < terminalAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observedAt"], message: "Project DNA usefulness cannot precede the terminal outcome" });
  }
  if (Number.isFinite(observedAt) && Number.isFinite(retainUntil)
    && (retainUntil <= observedAt || retainUntil - observedAt > MAX_RETENTION_MS)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retainUntil"], message: "Project DNA usefulness retention is invalid" });
  }
  if (observation.signal !== "unknown" && observation.evidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "classified Project DNA usefulness requires explicit human or independent review evidence",
    });
  }
  const identities = new Set<string>();
  for (const [index, evidence] of observation.evidence.entries()) {
    const identity = `${evidence.kind}:${evidence.ref}:${evidence.hash}`;
    if (identities.has(identity)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", index], message: "Project DNA usefulness evidence is duplicated" });
    }
    identities.add(identity);
    if (!isCredentialFreeText(evidence.ref)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", index, "ref"], message: "Project DNA usefulness evidence contains credential material" });
    }
  }
  const categories = observation.projection.categories as ProjectDnaCategory[];
  if (new Set(categories).size !== categories.length
    || new Set(observation.projection.traitIds).size !== observation.projection.traitIds.length
    || new Set(observation.projection.evidenceHashes).size !== observation.projection.evidenceHashes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projection"], message: "Project DNA usefulness projection contains duplicates" });
  }
  for (const [path, value] of [
    [["episode", "schemaVersion"], observation.episode.schemaVersion],
    [["episode", "episodeId"], observation.episode.episodeId],
    [["projection", "role"], observation.projection.role],
    [["artifact", "ref"], observation.artifact.ref],
    [["assessment", "schemaVersion"], observation.assessment.schemaVersion],
    [["assessment", "assessmentId"], observation.assessment.assessmentId],
  ] as const) {
    if (!isCredentialFreeText(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "Project DNA usefulness identity contains credential material" });
    }
  }
  const unsigned = projectDnaUsefulnessUnsigned(observation);
  if (observation.contentHash !== projectDnaUsefulnessHash(unsigned)
    || observation.observationId !== projectDnaUsefulnessObservationId(observation)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Project DNA usefulness observation seal is invalid" });
  }
});

export type ProjectDnaUsefulnessObservation = z.infer<typeof ProjectDnaUsefulnessObservationSchema>;
export type CreateProjectDnaUsefulnessObservationInput = Omit<ProjectDnaUsefulnessObservation,
  "schema" | "observationId" | "authority" | "contentHash">;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function projectDnaUsefulnessHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function projectDnaUsefulnessObservationId(
  observation: Pick<ProjectDnaUsefulnessObservation, "episode" | "delivery" | "artifact">,
): string {
  const identityHash = projectDnaUsefulnessHash({
    episodeId: observation.episode.episodeId,
    receiptRef: observation.delivery.receiptRef,
    receiptHash: observation.delivery.receiptHash,
    profileId: observation.delivery.profileId,
    artifactRef: observation.artifact.ref,
    artifactContentHash: observation.artifact.contentHash,
  });
  return `pduo_${identityHash.slice(7, 31)}`;
}

function projectDnaUsefulnessUnsigned(
  observation: Omit<ProjectDnaUsefulnessObservation, "observationId" | "contentHash">,
): Omit<ProjectDnaUsefulnessObservation, "observationId" | "contentHash"> {
  return {
    schema: observation.schema,
    episode: { ...observation.episode },
    delivery: { ...observation.delivery },
    projection: {
      role: observation.projection.role,
      categories: [...observation.projection.categories],
      traitIds: [...observation.projection.traitIds],
      evidenceHashes: [...observation.projection.evidenceHashes],
    },
    artifact: { ...observation.artifact },
    assessment: { ...observation.assessment },
    signal: observation.signal,
    evidence: observation.evidence.map((item) => ({ ...item })),
    observedAt: observation.observedAt,
    retainUntil: observation.retainUntil,
    privacy: { ...observation.privacy },
    authority: { ...observation.authority },
  };
}

export function createProjectDnaUsefulnessObservation(
  input: CreateProjectDnaUsefulnessObservationInput,
): ProjectDnaUsefulnessObservation {
  const unsigned = projectDnaUsefulnessUnsigned({
    schema: PROJECT_DNA_USEFULNESS_OBSERVATION_SCHEMA_VERSION,
    episode: { ...input.episode },
    delivery: { ...input.delivery },
    projection: {
      role: input.projection.role,
      categories: [...input.projection.categories],
      traitIds: [...input.projection.traitIds],
      evidenceHashes: [...input.projection.evidenceHashes],
    },
    artifact: { ...input.artifact },
    assessment: { ...input.assessment },
    signal: input.signal,
    evidence: input.evidence.map((item) => ({ ...item })),
    observedAt: input.observedAt,
    retainUntil: input.retainUntil,
    privacy: { ...input.privacy },
    authority: {
      behavioralEffect: "none",
      mayChangeRanking: false,
      mayPromoteKnowledge: false,
      mayGrantAuthority: false,
    },
  });
  return ProjectDnaUsefulnessObservationSchema.parse({
    ...unsigned,
    observationId: projectDnaUsefulnessObservationId(unsigned),
    contentHash: projectDnaUsefulnessHash(unsigned),
  });
}

export function assertProjectDnaUsefulnessObservation(
  value: unknown,
): asserts value is ProjectDnaUsefulnessObservation {
  ProjectDnaUsefulnessObservationSchema.parse(value);
}

/** Contradiction and staleness create review work, never a profile mutation or policy. */
export function projectDnaUsefulnessObservationFinding(value: unknown): Finding | null {
  const observation = ProjectDnaUsefulnessObservationSchema.parse(value);
  if (observation.signal !== "contradicted" && observation.signal !== "stale") return null;
  const title = `Project DNA outcome ${observation.signal}: ${observation.delivery.profileId}`;
  const evidence = [
    `project-dna-usefulness:${observation.observationId}`,
    `project-dna-usefulness-content:${observation.contentHash}`,
    `episode:${observation.episode.episodeId}@${observation.episode.episodeHash}`,
    `delivery:${observation.delivery.receiptRef}@${observation.delivery.receiptHash}`,
    `profile:${observation.delivery.profileId}@${observation.delivery.profileContentHash}`,
    `artifact:${observation.artifact.ref}@${observation.artifact.contentHash}`,
    `assessment:${observation.assessment.assessmentId}@${observation.assessment.contentHash}`,
    ...observation.evidence.map((item) => `${item.kind}:${item.ref}@${item.hash}`),
  ];
  return FindingSchema.parse({
    id: findingId(title),
    title,
    observation: observation.signal === "contradicted"
      ? `Explicit outcome evidence may conflict with delivered Project DNA profile ${observation.delivery.profileId}; review the named traits and evidence before changing the profile.`
      : `Explicit outcome evidence may show that delivered Project DNA profile ${observation.delivery.profileId} was stale; review currentness before changing the profile.`,
    evidence,
    method: null,
    severity: observation.signal === "contradicted" ? "high" : "medium",
    triage: "open",
    affected_files: [],
    affected_symbols: [...observation.projection.traitIds],
    violates_constraint: null,
    spawned_decision: null,
    observed_at: observation.observedAt,
    resolved_commit: null,
    provenance: {
      source: "project_dna_outcome_experience+candidate",
      confidence: 0.75,
      evidence,
      last_verified: observation.observedAt,
    },
  });
}
