import { createHash } from "node:crypto";
import { z } from "zod";
import { findingId } from "./ids.js";
import { FindingSchema, isCredentialFreeText, type Finding } from "./types.js";
import {
  assertChangeIdentity,
  CHANGE_IDENTITY_ALGORITHM,
  CHANGE_IDENTITY_SCHEMA_VERSION,
} from "./changeIdentity.js";

export const USEFULNESS_OBSERVATION_SCHEMA_VERSION = "hunch.usefulness-observation/1" as const;
export const USEFULNESS_SIGNALS = [
  "used",
  "prevented",
  "near_miss",
  "contradicted",
  "stale",
  "unused",
  "unknown",
] as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const RECEIPT_REF = /^hunch-memory:hmctx_[a-f0-9]{32}$/;
const OBSERVATION_ID = /^huo_[a-f0-9]{24}$/;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

const EvidenceReferenceSchema = z.object({
  kind: z.enum(["artifact", "event", "verification", "receipt", "observation"]),
  ref: z.string().min(1).max(512),
  hash: z.string().regex(SHA256),
}).strict();

const OutcomeChangeIdentitySchema = z.object({
  schema: z.literal(CHANGE_IDENTITY_SCHEMA_VERSION),
  algorithm: z.literal(CHANGE_IDENTITY_ALGORITHM),
  change_id: z.string().regex(/^hchg_[a-f0-9]{24}$/),
  base_revision: z.string().regex(GIT_OBJECT),
  head_revision: z.string().regex(GIT_OBJECT),
  base_tree: z.string().regex(GIT_OBJECT),
  head_tree: z.string().regex(GIT_OBJECT),
  delta_hash: z.string().regex(SHA256),
  patch_id: z.string().regex(GIT_OBJECT).nullable(),
  file_count: z.number().int().positive().max(16_384),
  paths_hash: z.string().regex(SHA256),
  content_hash: z.string().regex(SHA256),
}).strict().superRefine((identity, ctx) => {
  try {
    assertChangeIdentity(identity);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
  }
});

export const UsefulnessObservationSchema = z.object({
  schema: z.literal(USEFULNESS_OBSERVATION_SCHEMA_VERSION),
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
    graphRevision: z.string().regex(GIT_OBJECT),
    sourceRevision: z.string().regex(GIT_OBJECT),
    sourceContentHash: z.string().regex(SHA256),
  }).strict(),
  record: z.object({
    recordId: z.string().min(3).max(512),
    recordKind: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    recordRevision: z.string().regex(SHA256),
    contentHash: z.string().regex(SHA256),
  }).strict(),
  /** Optional until hosts can produce it; when present it survives squash metadata. */
  change: OutcomeChangeIdentitySchema.optional(),
  signal: z.enum(USEFULNESS_SIGNALS),
  evidence: z.array(EvidenceReferenceSchema).max(64),
  observedAt: z.string().min(1).max(64),
  retainUntil: z.string().min(1).max(64),
  privacy: z.object({
    payloadMode: z.literal("references_hashes_only"),
    rawTranscriptIncluded: z.literal(false),
    rawProviderOutputIncluded: z.literal(false),
  }).strict(),
  authority: z.object({
    behavioralEffect: z.literal("none"),
    mayChangeRanking: z.literal(false),
    mayPromoteKnowledge: z.literal(false),
    mayGrantAuthority: z.literal(false),
  }).strict(),
  contentHash: z.string().regex(SHA256),
}).strict().superRefine((observation, ctx) => {
  const timestamps = [
    ["episode", "terminalAt", observation.episode.terminalAt],
    ["observedAt", observation.observedAt],
    ["retainUntil", observation.retainUntil],
  ] as const;
  for (const path of timestamps) {
    const value = path.at(-1)!;
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: path.slice(0, -1), message: "usefulness timestamp is invalid" });
    }
  }
  const observedAt = Date.parse(observation.observedAt);
  const terminalAt = Date.parse(observation.episode.terminalAt);
  const retainUntil = Date.parse(observation.retainUntil);
  if (Number.isFinite(observedAt) && Number.isFinite(terminalAt) && observedAt < terminalAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observedAt"], message: "usefulness cannot precede the terminal outcome" });
  }
  if (Number.isFinite(observedAt) && Number.isFinite(retainUntil)
    && (retainUntil <= observedAt || retainUntil - observedAt > MAX_RETENTION_MS)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retainUntil"], message: "usefulness retention is invalid" });
  }
  if (observation.delivery.sourceRevision !== observation.delivery.graphRevision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["delivery", "sourceRevision"], message: "usefulness source revision is inconsistent" });
  }
  if (observation.signal !== "unknown" && observation.evidence.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "supported usefulness requires evidence" });
  }
  const evidenceIdentities = new Set<string>();
  for (const [index, evidence] of observation.evidence.entries()) {
    const identity = `${evidence.kind}:${evidence.ref}:${evidence.hash}`;
    if (evidenceIdentities.has(identity)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", index], message: "usefulness evidence is duplicated" });
    }
    evidenceIdentities.add(identity);
    if (!isCredentialFreeText(evidence.ref)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", index, "ref"], message: "usefulness evidence contains credential material" });
    }
  }
  for (const [path, value] of [
    [["episode", "schemaVersion"], observation.episode.schemaVersion],
    [["episode", "episodeId"], observation.episode.episodeId],
    [["record", "recordId"], observation.record.recordId],
  ] as const) {
    if (!isCredentialFreeText(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: "usefulness identity contains credential material" });
    }
  }
  const unsigned = usefulnessObservationUnsigned(observation);
  const contentHash = usefulnessHash(unsigned);
  if (observation.contentHash !== contentHash
    || observation.observationId !== usefulnessObservationId(observation)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "usefulness observation seal is invalid" });
  }
});

export type UsefulnessObservation = z.infer<typeof UsefulnessObservationSchema>;
export type CreateUsefulnessObservationInput = Omit<UsefulnessObservation,
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

function usefulnessHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function usefulnessObservationId(observation: Pick<UsefulnessObservation, "episode" | "delivery" | "record">): string {
  const identityHash = usefulnessHash({
    episodeId: observation.episode.episodeId,
    receiptRef: observation.delivery.receiptRef,
    receiptHash: observation.delivery.receiptHash,
    recordId: observation.record.recordId,
  });
  return `huo_${identityHash.slice(7, 31)}`;
}

function usefulnessObservationUnsigned(observation: Omit<UsefulnessObservation, "observationId" | "contentHash">): Omit<UsefulnessObservation, "observationId" | "contentHash"> {
  return {
    schema: observation.schema,
    episode: { ...observation.episode },
    delivery: { ...observation.delivery },
    record: { ...observation.record },
    ...(observation.change ? { change: { ...observation.change } } : {}),
    signal: observation.signal,
    evidence: observation.evidence.map((item) => ({ ...item })),
    observedAt: observation.observedAt,
    retainUntil: observation.retainUntil,
    privacy: { ...observation.privacy },
    authority: { ...observation.authority },
  };
}

export function createUsefulnessObservation(input: CreateUsefulnessObservationInput): UsefulnessObservation {
  const unsigned = usefulnessObservationUnsigned({
    schema: USEFULNESS_OBSERVATION_SCHEMA_VERSION,
    episode: { ...input.episode },
    delivery: { ...input.delivery },
    record: { ...input.record },
    ...(input.change ? { change: { ...input.change } } : {}),
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
  const observationId = usefulnessObservationId(unsigned);
  return UsefulnessObservationSchema.parse({
    ...unsigned,
    observationId,
    contentHash: usefulnessHash(unsigned),
  });
}

export function assertUsefulnessObservation(value: unknown): asserts value is UsefulnessObservation {
  UsefulnessObservationSchema.parse(value);
}

/** Contradiction and staleness become open advisory review work, never truth. */
export function usefulnessObservationFinding(value: unknown): Finding | null {
  const observation = UsefulnessObservationSchema.parse(value);
  if (observation.signal !== "contradicted" && observation.signal !== "stale") return null;
  const title = `Outcome ${observation.signal}: ${observation.record.recordId} (${observation.observationId})`;
  const evidence = [
    `usefulness:${observation.observationId}`,
    `usefulness-content:${observation.contentHash}`,
    `episode:${observation.episode.episodeId}@${observation.episode.episodeHash}`,
    `delivery:${observation.delivery.receiptRef}@${observation.delivery.receiptHash}`,
    `record:${observation.record.recordId}@${observation.record.recordRevision}`,
    ...(observation.change ? [`change:${observation.change.change_id}@${observation.change.content_hash}`] : []),
    ...observation.evidence.map((item) => `${item.kind}:${item.ref}@${item.hash}`),
  ];
  return FindingSchema.parse({
    id: findingId(title),
    title,
    observation: observation.signal === "contradicted"
      ? `Outcome evidence may conflict with delivered Hunch record ${observation.record.recordId}; review the record and its applicability before changing trusted knowledge.`
      : `Outcome evidence may show that delivered Hunch record ${observation.record.recordId} was stale; review currentness before changing trusted knowledge.`,
    evidence,
    method: null,
    severity: observation.signal === "contradicted" ? "high" : "medium",
    triage: "open",
    affected_files: [],
    affected_symbols: [observation.record.recordId],
    violates_constraint: null,
    spawned_decision: null,
    observed_at: observation.observedAt,
    resolved_commit: null,
    provenance: {
      source: "outcome_experience+candidate",
      confidence: 0.75,
      evidence,
      last_verified: observation.observedAt,
    },
  });
}
