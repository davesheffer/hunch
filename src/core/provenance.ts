/**
 * Provenance and credential-free text — a LEAF module (zod only) so that record
 * schemas registered in the store can import it without pulling in types.ts,
 * which itself imports the store's kind registry. types.ts re-exports everything
 * here, so existing imports keep working unchanged.
 */
import { z } from "zod";

/** Where a fact came from and how much to trust it. Confidence tiers (DESIGN §4):
 *  inferred < extracted < llm_draft < llm_draft+human_confirmed/derived. */
export const ProvenanceSchema = z.object({
  source: z.string().describe("e.g. extracted | inferred | llm_draft | human_confirmed | test_failure+llm | derived"),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]).describe("file paths, commit ids, test ids backing the claim"),
  last_verified: z.string().optional().describe("ISO timestamp of last re-validation"),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SENSITIVE_METADATA_KEY = /(^|[_-])(authorization|bearer|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key)($|[_-])/i;
const SENSITIVE_ASSIGNMENT = /\b(authorization|password|passwd|private[_-]?key|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[:=]\s*[^\s,;]{4,}/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i;

/** Reject credential material while allowing ordinary architecture prose such as
 * "authentication service" or "secrets are managed externally". */
export function isCredentialFreeText(value: string): boolean {
  if (PRIVATE_KEY_BLOCK.test(value) || BEARER_VALUE.test(value) || SENSITIVE_ASSIGNMENT.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    for (const [key] of url.searchParams) if (SENSITIVE_METADATA_KEY.test(key)) return false;
  } catch { /* credential-free canonical locators need not be absolute URLs */ }
  return true;
}

/** Bare secret shapes the general detector does not cover: it looks for assignments, bearer
 *  values, private-key blocks and URL userinfo; a token pasted on its own into an object key or
 *  locator would pass. These prefixes are the common ones. */
const BARE_SECRET = /(?:^|[^A-Za-z0-9])(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
export function isCredentialFreeValue(value: string): boolean {
  return isCredentialFreeText(value) && !BARE_SECRET.test(value);
}
