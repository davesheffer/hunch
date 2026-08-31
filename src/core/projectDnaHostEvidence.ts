import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonicalOrder.js";

export const PROJECT_DNA_HOST_EVIDENCE_SCHEMA_VERSION = "hunch.project-dna-host-evidence/1" as const;

const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ITEM_ID = /^pdnahi_[a-f0-9]{20}$/;
const SET_ID = /^pdnah_[a-f0-9]{24}$/;
const SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
const MAX_ITEMS = 64;
const MAX_TITLE = 500;
const MAX_BODY = 8_000;

export const PROJECT_DNA_HOST_EVIDENCE_KINDS = ["pull_request", "review_comment"] as const;
export const PROJECT_DNA_HOST_EVIDENCE_DISPOSITIONS = [
  "merged", "approved", "changes_requested", "commented",
] as const;
export const PROJECT_DNA_HOST_EVIDENCE_AUTHOR_ROLES = ["maintainer", "contributor", "unknown"] as const;

export type ProjectDnaHostEvidenceKind = (typeof PROJECT_DNA_HOST_EVIDENCE_KINDS)[number];
export type ProjectDnaHostEvidenceDisposition = (typeof PROJECT_DNA_HOST_EVIDENCE_DISPOSITIONS)[number];
export type ProjectDnaHostEvidenceAuthorRole = (typeof PROJECT_DNA_HOST_EVIDENCE_AUTHOR_ROLES)[number];

export interface ProjectDnaHostEvidenceCandidate {
  kind: ProjectDnaHostEvidenceKind;
  /** Credential-free, repository-local source identity such as github:pull-request:42. */
  ref: string;
  disposition: ProjectDnaHostEvidenceDisposition;
  author_role: ProjectDnaHostEvidenceAuthorRole;
  title: string | null;
  body: string | null;
}

export interface ProjectDnaHostEvidenceItem extends ProjectDnaHostEvidenceCandidate {
  item_id: string;
  content_hash: string;
}

export interface ProjectDnaHostEvidence {
  schema: typeof PROJECT_DNA_HOST_EVIDENCE_SCHEMA_VERSION;
  repository_revision: string;
  items: ProjectDnaHostEvidenceItem[];
  evidence_set_id: string;
  content_hash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).sort(compareCodeUnits).join("\0") === [...fields].sort(compareCodeUnits).join("\0");
}

function boundedText(value: string | null, maximum: number, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Project DNA host evidence ${label} is invalid`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) {
    throw new Error(`Project DNA host evidence ${label} is invalid`);
  }
  return normalized;
}

function dispositionMatchesKind(
  kind: ProjectDnaHostEvidenceKind,
  disposition: ProjectDnaHostEvidenceDisposition,
): boolean {
  return kind === "pull_request"
    ? disposition === "merged"
    : disposition === "approved" || disposition === "changes_requested" || disposition === "commented";
}

function sealItem(candidate: ProjectDnaHostEvidenceCandidate): ProjectDnaHostEvidenceItem {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || !exactFields(candidate as unknown as Record<string, unknown>, [
      "kind", "ref", "disposition", "author_role", "title", "body",
    ])
    || !PROJECT_DNA_HOST_EVIDENCE_KINDS.includes(candidate.kind)
    || !SOURCE_REF.test(candidate.ref)
    || !PROJECT_DNA_HOST_EVIDENCE_DISPOSITIONS.includes(candidate.disposition)
    || !PROJECT_DNA_HOST_EVIDENCE_AUTHOR_ROLES.includes(candidate.author_role)
    || !dispositionMatchesKind(candidate.kind, candidate.disposition)) {
    throw new Error("Project DNA host evidence candidate fields are invalid");
  }
  const unsigned = {
    kind: candidate.kind,
    ref: candidate.ref,
    disposition: candidate.disposition,
    author_role: candidate.author_role,
    title: boundedText(candidate.title, MAX_TITLE, "title"),
    body: boundedText(candidate.body, MAX_BODY, "body"),
  } as const;
  if (unsigned.title === null && unsigned.body === null) {
    throw new Error("Project DNA host evidence candidate has no observable content");
  }
  if (unsigned.kind === "pull_request" && unsigned.title === null) {
    throw new Error("Project DNA pull-request evidence requires a title");
  }
  if (unsigned.kind === "review_comment" && (unsigned.title !== null || unsigned.body === null)) {
    throw new Error("Project DNA review-comment evidence requires only a body");
  }
  const itemId = `pdnahi_${sha256(canonical(unsigned)).slice("sha256:".length, "sha256:".length + 20)}`;
  const sealed = { ...unsigned, item_id: itemId };
  return { ...sealed, content_hash: sha256(canonical(sealed)) };
}

/**
 * Seal an explicitly authorized, repository-visible host evidence batch.
 *
 * This function never fetches a provider and never grants the host evidence
 * policy authority. The caller owns source authorization and may pass only
 * credential-free refs plus bounded repository-visible text.
 */
export function sealProjectDnaHostEvidence(
  repositoryRevision: string,
  candidates: readonly ProjectDnaHostEvidenceCandidate[],
): ProjectDnaHostEvidence {
  if (!GIT_OBJECT.test(repositoryRevision) || !Array.isArray(candidates)
    || candidates.length < 1 || candidates.length > MAX_ITEMS) {
    throw new Error("Project DNA host evidence set fields are invalid");
  }
  const items = candidates.map(sealItem)
    .sort((left, right) => compareCodeUnits(left.item_id, right.item_id));
  if (new Set(items.map((item) => item.item_id)).size !== items.length
    || new Set(items.map((item) => item.ref)).size !== items.length) {
    throw new Error("Project DNA host evidence items must have unique source identities");
  }
  const unsigned = {
    schema: PROJECT_DNA_HOST_EVIDENCE_SCHEMA_VERSION,
    repository_revision: repositoryRevision,
    items,
  } as const;
  const evidenceSetId = `pdnah_${sha256(canonical(unsigned)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...unsigned, evidence_set_id: evidenceSetId };
  const result: ProjectDnaHostEvidence = { ...sealed, content_hash: sha256(canonical(sealed)) };
  assertProjectDnaHostEvidence(result);
  return result;
}

export function assertProjectDnaHostEvidence(value: unknown): asserts value is ProjectDnaHostEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project DNA host evidence set is invalid");
  }
  const evidence = value as ProjectDnaHostEvidence;
  if (!exactFields(value as Record<string, unknown>, [
    "schema", "repository_revision", "items", "evidence_set_id", "content_hash",
  ])
    || evidence.schema !== PROJECT_DNA_HOST_EVIDENCE_SCHEMA_VERSION
    || !GIT_OBJECT.test(evidence.repository_revision)
    || !Array.isArray(evidence.items) || evidence.items.length < 1 || evidence.items.length > MAX_ITEMS
    || !SET_ID.test(evidence.evidence_set_id) || !SHA256.test(evidence.content_hash)) {
    throw new Error("Project DNA host evidence set fields are invalid");
  }
  const refs = new Set<string>();
  const ids = new Set<string>();
  let previous = "";
  for (const item of evidence.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !exactFields(item as unknown as Record<string, unknown>, [
        "kind", "ref", "disposition", "author_role", "title", "body", "item_id", "content_hash",
      ])
      || !PROJECT_DNA_HOST_EVIDENCE_KINDS.includes(item.kind)
      || !SOURCE_REF.test(item.ref)
      || !PROJECT_DNA_HOST_EVIDENCE_DISPOSITIONS.includes(item.disposition)
      || !PROJECT_DNA_HOST_EVIDENCE_AUTHOR_ROLES.includes(item.author_role)
      || !dispositionMatchesKind(item.kind, item.disposition)
      || !ITEM_ID.test(item.item_id) || !SHA256.test(item.content_hash)
      || refs.has(item.ref) || ids.has(item.item_id) || (previous && compareCodeUnits(previous, item.item_id) >= 0)) {
      throw new Error("Project DNA host evidence item fields are invalid");
    }
    const unsigned = {
      kind: item.kind,
      ref: item.ref,
      disposition: item.disposition,
      author_role: item.author_role,
      title: boundedText(item.title, MAX_TITLE, "title"),
      body: boundedText(item.body, MAX_BODY, "body"),
    } as const;
    if (item.title !== unsigned.title || item.body !== unsigned.body
      || (unsigned.title === null && unsigned.body === null)
      || (unsigned.kind === "pull_request" && unsigned.title === null)
      || (unsigned.kind === "review_comment" && (unsigned.title !== null || unsigned.body === null))) {
      throw new Error("Project DNA host evidence item content is invalid");
    }
    const expectedId = `pdnahi_${sha256(canonical(unsigned)).slice("sha256:".length, "sha256:".length + 20)}`;
    const sealed = { ...unsigned, item_id: item.item_id };
    if (item.item_id !== expectedId || item.content_hash !== sha256(canonical(sealed))) {
      throw new Error("Project DNA host evidence item seal is invalid");
    }
    refs.add(item.ref);
    ids.add(item.item_id);
    previous = item.item_id;
  }
  const { evidence_set_id: _setId, content_hash: _hash, ...base } = evidence;
  const expectedSetId = `pdnah_${sha256(canonical(base)).slice("sha256:".length, "sha256:".length + 24)}`;
  const sealed = { ...base, evidence_set_id: evidence.evidence_set_id };
  if (evidence.evidence_set_id !== expectedSetId || evidence.content_hash !== sha256(canonical(sealed))) {
    throw new Error("Project DNA host evidence set seal is invalid");
  }
}
