/** "Never Twice" — turn a human correction of the agent into a first-class,
 *  enforced Constraint (DESIGN: Correction Capture → Enforced Constraint).
 *
 *  Two pure, client-agnostic pieces, factored out of the MCP server and the
 *  agent hook so they are unit-testable without spinning either up:
 *   - looksLikeCorrection(): does a user prompt read like "no / that's wrong /
 *     never do X" — the cue to nudge the agent to persist it.
 *   - buildCorrectionConstraint(): mint the Constraint record (human-confirmed,
 *     scoped conservatively) that the pre-edit hook + CI guard then enforce.
 */
import { constraintId } from "./ids.js";
import { toPosixTarget } from "./paths.js";
import { deriveForbids } from "./constraintmatch.js";
import type { Constraint } from "./types.js";

/** Correction cues. Deliberately conservative — anchored to imperative/rebuke
 *  phrasing, not bare "no", so ordinary conversational negation ("no idea",
 *  "no problem") doesn't train users to ignore the nudge (research risk #5). */
const CORRECTION_PATTERNS: RegExp[] = [
  // OPENS with a rebuke — but exclude benign "no problem / no idea / no test exists…".
  // The exclusion list guards against stateful conversational negation ("no tests pass",
  // "no way to fix this") firing the nudge and training users to ignore it.
  /^\s*no\b(?!\s+(problem|worries|idea|rush|need|biggie|thanks|thank|prob|clue|luck|difference|harm|reason|point|test|tests|way|ways|chance|context|functions?|method|file|files|change|changes|diff|other|more))/i,
  /^\s*(nope|stop)\b/i,
  /\b(that'?s|that is|this is) (wrong|incorrect|not right|not what)\b/i,
  /\b(never|do not ever|don'?t ever) (do|use|call|add|write|put|import|commit|touch)\b/i,
  /\b(don'?t|do not) (do|use|call|add|write|put|commit) (that|this|it)\b/i,
  /\b(you must|must always|you should always|make sure (to|you|that you))\b/i,
  /\b(i (already )?told you|i said|as i said|like i said)\b/i,
  /\b(undo|revert) (that|this|it|your)\b/i,
  /\b(not like that|don'?t do (that|this)( again)?|stop doing (that|this))\b/i,
];

export function looksLikeCorrection(prompt: string | undefined | null): boolean {
  if (!prompt || typeof prompt !== "string") return false;
  return CORRECTION_PATTERNS.some((re) => re.test(prompt));
}

/** One-line nudge appended to the UserPromptSubmit hook context when a prompt
 *  reads like a correction — surfaces the write tool so the rule gets ENFORCED,
 *  not merely remembered. Client-agnostic (no Claude-only wording). */
export const CORRECTION_NUDGE =
  "This looks like a correction. If it's a rule the agent should never break again, " +
  "call hunch_record_correction({ rule, scope_hint_file, severity, applies_to_all }) so it " +
  "becomes an enforced, scoped constraint (held at edit-time and in CI) — not a one-off the next session forgets. " +
  "Use severity:\"blocking\" only when the human said never/must; set applies_to_all:true only if the rule is genuinely repo-wide.";

export interface CorrectionInput {
  /** The invariant in the human's words, e.g. "never call the pay-per-token API here". */
  rule: string;
  /** A file the correction was about — scopes the constraint to it (conservative default). */
  scope_hint_file?: string;
  severity?: "advisory" | "warning" | "blocking";
  /** True only when the rule is genuinely repo-wide; required to scope to "**". */
  applies_to_all?: boolean;
  type?: "security" | "performance" | "correctness" | "architecture" | "compliance";
  rationale?: string;
  /** id of the decision this correction derives from, if any. */
  source_decision?: string;
  /** The repo's real dependency names (package.json). When given, a dep matcher is
   *  auto-derived ONLY for a dep that actually exists — so a non-dependency phrasing
   *  never silently mints a never-firing rule. */
  knownDeps?: string[];
}

/**
 * Build the Constraint a correction mints. Pure (caller passes `now`), so the
 * scope/severity policy is testable in isolation. Key safety rule (research
 * risk #2 — the scope footgun): a repo-wide ("**") constraint may only be
 * BLOCKING when the caller explicitly set applies_to_all; otherwise a single
 * mis-scoped correction would deny every edit under strict firmness, so we
 * down-rank it to a warning.
 */
export function buildCorrectionConstraint(input: CorrectionInput, now: string): Constraint {
  const rule = input.rule.trim();
  if (!rule) throw new Error("rule must not be empty");
  // A blank/"." scope hint would mint a meaningless or repo-wide constraint by
  // accident, so fall back to "**" (which the severity guard below then keeps
  // non-blocking unless applies_to_all was explicitly set).
  const hinted = input.scope_hint_file ? toPosixTarget(input.scope_hint_file) : "";
  const scope = input.applies_to_all || !hinted || hinted === "." ? ["**"] : [hinted];
  const repoWide = scope.length === 1 && scope[0] === "**";

  let severity: "advisory" | "warning" | "blocking" = input.severity ?? "warning";
  if (severity === "blocking" && repoWide && !input.applies_to_all) severity = "warning";

  return {
    id: constraintId(rule),
    type: input.type ?? "correctness",
    statement: rule,
    scope,
    severity,
    enforcement: "advisory_v1",
    match: null,
    // Best-effort precise matcher from the rule text ("never import lodash" → forbids lodash),
    // so the seamless capture path mints enforcement that survives file churn, not a scope-only
    // rule that goes stale. Validated against the repo's real deps when supplied → never mints a
    // never-firing rule for a non-dependency. null when nothing derivable → falls back to scope.
    forbids: deriveForbids(rule, input.knownDeps),
    rationale: input.rationale ?? "Captured from a human correction of the agent (Never Twice).",
    source_decision: input.source_decision ?? null,
    violations: [],
    status: "active",
    valid_from: now,
    valid_to: null,
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: now },
  } as Constraint;
}
