/**
 * LLM-drafted rule PROPOSALS from unmarked doc prose (`hunch derive-rules --propose`).
 *
 * The model only drafts; nothing it says becomes a constraint on its own. Every
 * draft is checked deterministically before it is even queued — its `quote` must
 * appear verbatim in the doc (a rule the doc does not state is dropped, not
 * trusted), its scope must be repo-relative globs, and its severity is capped at
 * `warning` (a human raises it). Survivors land in a clone-local, gitignored
 * queue; a human accepts one exact draft by its hash, and acceptance re-checks
 * that the doc still says what the draft quoted.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Constraint } from "./types.js";
import { constraintId } from "./ids.js";
import { writeFileAtomic } from "./io.js";
import { isCredentialFreeText } from "./types.js";

export const PROPOSAL_QUEUE = "pending-doc-rules.json";
/** Provenance token for an accepted proposal. Distinct from marker-derived rules
 *  (`imported:doc-rule`): a proposal has no marker, so it can never be "orphaned". */
export const DOC_PROPOSAL_SOURCE = "human_confirmed+imported:doc-proposal";
const TYPES = ["security", "performance", "correctness", "architecture", "compliance"] as const;
const MAX_DOC_CHARS = 24_000;
const MAX_PROPOSALS_PER_DOC = 12;

export interface DocRuleProposal {
  id: string;
  file: string;
  statement: string;
  quote: string;
  scope: string[];
  severity: "advisory" | "warning";
  type: Constraint["type"];
  provider: string;
  proposedAt: string;
  hash: string;
}

interface QueueFile { pending: DocRuleProposal[]; dropped: string[] }

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

export function proposalHash(p: Pick<DocRuleProposal, "id" | "file" | "statement" | "quote" | "scope" | "severity" | "type" | "provider" | "proposedAt">): string {
  const canonical = JSON.stringify({ id: p.id, file: p.file, statement: p.statement, quote: p.quote, scope: p.scope, severity: p.severity, type: p.type, provider: p.provider, proposedAt: p.proposedAt });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function proposalId(file: string, statement: string): string {
  return constraintId(`doc-proposal:${file}:${statement}`);
}

export function proposalPrompt(file: string, text: string): string {
  return [
    `You are reading the project document ${file}. List the enforceable engineering rules it STATES — invariants a code change could violate (e.g. "UI code must not import the billing client").`,
    "Only rules the document explicitly states; no inferred best practices, no rules about the document itself, no process steps that no code change can break.",
    'Reply with ONE JSON object and nothing else: {"rules":[{"statement":"<one-sentence rule>","quote":"<exact sentence copied verbatim from the document>","scope":["<repo-relative glob>"],"severity":"advisory|warning","type":"security|performance|correctness|architecture|compliance"}]}',
    'Use {"rules":[]} when the document states no such rule. Scope globs must name the code the rule governs (e.g. "src/ui/**"); never "**" unless the document says the rule is repo-wide.',
    "",
    "<document>",
    text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text,
    "</document>",
  ].join("\n");
}

const SAFE_GLOB = /^(?![/\\])(?![A-Za-z]:)(?!.*\.\.(?:\/|$))[^\s<>|"]{1,200}$/;

/** Validate model output against the doc. Pure; returns survivors + why the rest were dropped. */
export function validateProposals(
  raw: Record<string, unknown> | null,
  doc: { file: string; text: string },
  meta: { provider: string; now: string },
): { proposals: DocRuleProposal[]; rejected: string[] } {
  const proposals: DocRuleProposal[] = [];
  const rejected: string[] = [];
  const rules = raw && Array.isArray(raw.rules) ? raw.rules : null;
  if (!rules) return { proposals, rejected: ["model reply had no {\"rules\": [...]} object"] };
  const haystack = squash(doc.text);
  for (const r of rules.slice(0, MAX_PROPOSALS_PER_DOC)) {
    if (!r || typeof r !== "object") { rejected.push("non-object entry"); continue; }
    const o = r as Record<string, unknown>;
    const statement = typeof o.statement === "string" ? squash(o.statement) : "";
    const quote = typeof o.quote === "string" ? squash(o.quote) : "";
    if (!statement || statement.length > 400) { rejected.push(`bad statement: ${statement.slice(0, 60)}`); continue; }
    // A short quote ("Be careful.") can match anywhere, so it grounds nothing.
    if (quote && (quote.length < 20 || quote.split(" ").length < 4)) { rejected.push(`quote too short to ground: ${statement.slice(0, 80)}`); continue; }
    if (!quote || !haystack.includes(quote)) { rejected.push(`quote not found verbatim in ${doc.file}: ${statement.slice(0, 80)}`); continue; }
    if (!isCredentialFreeText(statement) || !isCredentialFreeText(quote)) { rejected.push("credential-like text"); continue; }
    const scope = Array.isArray(o.scope) ? o.scope.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter(Boolean) : [];
    if (!scope.length || !scope.every((g) => SAFE_GLOB.test(g))) { rejected.push(`bad scope for: ${statement.slice(0, 80)}`); continue; }
    const severity = o.severity === "advisory" ? "advisory" : "warning";
    const type = (TYPES as readonly unknown[]).includes(o.type) ? (o.type as Constraint["type"]) : "correctness";
    const id = proposalId(doc.file, statement);
    const base = { id, file: doc.file, statement, quote, scope, severity, type, provider: meta.provider, proposedAt: meta.now } as const;
    proposals.push({ ...base, scope: [...scope], hash: proposalHash(base) });
  }
  return { proposals, rejected };
}

const queuePath = (hunchDir: string): string => join(hunchDir, PROPOSAL_QUEUE);

function isProposal(v: unknown): v is DocRuleProposal {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return ["id", "file", "statement", "quote", "provider", "proposedAt", "hash"].every((k) => typeof p[k] === "string")
    && Array.isArray(p.scope) && (p.severity === "advisory" || p.severity === "warning") && typeof p.type === "string";
}

/** Missing or corrupt files read as an empty queue; never throws. */
export function readProposalQueue(hunchDir: string): QueueFile {
  const file = queuePath(hunchDir);
  if (!existsSync(file)) return { pending: [], dropped: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      pending: Array.isArray(raw.pending) ? raw.pending.filter(isProposal) : [],
      dropped: Array.isArray(raw.dropped) ? raw.dropped.filter((d): d is string => typeof d === "string") : [],
    };
  } catch {
    return { pending: [], dropped: [] };
  }
}

export function writeProposalQueue(hunchDir: string, q: QueueFile): void {
  writeFileAtomic(queuePath(hunchDir), JSON.stringify(q, null, 2) + "\n");
}

/** Merge fresh proposals into the queue, skipping anything already pending,
 *  dropped, or already a constraint (by id or identical statement). */
export function enqueueProposals(q: QueueFile, fresh: readonly DocRuleProposal[], existing: readonly Constraint[]): { queue: QueueFile; added: DocRuleProposal[] } {
  const known = new Set([...q.pending.map((p) => p.id), ...q.dropped, ...existing.map((c) => c.id)]);
  const statements = new Set(existing.filter((c) => c.status === "active").map((c) => squash(c.statement).toLowerCase()));
  const added = fresh.filter((p) => {
    if (known.has(p.id) || statements.has(p.statement.toLowerCase())) return false;
    known.add(p.id);
    return true;
  });
  return { queue: { ...q, pending: [...q.pending, ...added] }, added };
}

/** Turn one exact, still-grounded proposal into a constraint. Throws on a stale hash
 *  or a doc that no longer contains the quoted sentence. */
export function acceptProposal(p: DocRuleProposal, expectedHash: string, docText: string | null, now: string): Constraint {
  if (p.hash !== expectedHash || proposalHash(p) !== p.hash) throw new Error(`proposal ${p.id} does not match --expect ${expectedHash}; re-read it with \`hunch derive-rules --proposals\``);
  if (docText === null) throw new Error(`${p.file} is gone; re-propose from the current docs`);
  if (!squash(docText).includes(p.quote)) throw new Error(`${p.file} no longer says "${p.quote.slice(0, 80)}"; re-propose from the current doc`);
  return {
    id: p.id, type: p.type, statement: p.statement, scope: p.scope, severity: p.severity,
    enforcement: "advisory_v1", match: null, forbids: null,
    rationale: `Proposed by ${p.provider} from ${p.file} and accepted by a human. Source sentence: "${p.quote}"`,
    source_decision: null, violations: [], status: "active", valid_from: now, valid_to: null,
    provenance: { source: DOC_PROPOSAL_SOURCE, confidence: 0.85, evidence: [p.file, `doc-rule-source:${p.file}`, p.hash], last_verified: now },
  };
}
