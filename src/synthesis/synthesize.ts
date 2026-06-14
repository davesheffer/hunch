/**
 * The learning loop's write step (DESIGN.md §4, §5 "write_back").
 *   - syncCommit:   commit diff -> Claude/heuristic -> Decision draft -> Brain
 *   - recordFailure: failing test -> suspect ranking -> Bug draft -> Brain
 *
 * Idempotent: a Decision id is derived from (commit, title) so re-running sync on
 * the same commit updates rather than duplicates. New records are LOW-confidence
 * and `proposed` until confirmed — advisory and cheap to discard.
 */
import type { BrainStore } from "../store/brainStore.js";
import { commitMeta, commitDiff, headSha } from "../extractors/git.js";
import { selectProvider, DeterministicProvider, type SynthProvider, type DecisionDraft, type BugDraft, type CommitInput, type FailureInput } from "./provider.js";
import { decisionId, bugId, constraintId } from "../core/ids.js";
import { pathMatchesGlob } from "../core/glob.js";
import type { Decision, Bug, Constraint, Component, Symbol } from "../core/types.js";

const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_SUBJECT = /^(merge|revert|bump|chore\(deps\)|format|lint|wip)\b/i;

export interface SyncResult {
  status: "written" | "skipped";
  reason?: string;
  decision?: Decision;
  provider?: string;
}

/** Capture a Decision from a commit. Defaults to HEAD. */
export async function syncCommit(store: BrainStore, root: string, sha?: string): Promise<SyncResult> {
  const target = sha || headSha(root);
  if (!target) return { status: "skipped", reason: "no HEAD commit" };
  const meta = commitMeta(target, root);
  if (!meta) return { status: "skipped", reason: "commit not found" };

  if (SKIP_SUBJECT.test(meta.subject)) return { status: "skipped", reason: `trivial subject: ${meta.subject}` };
  const codeFiles = meta.files.filter((f) => CODE_RE.test(f));
  if (codeFiles.length === 0) return { status: "skipped", reason: "no code files changed" };

  const provider = await selectProvider();
  const diff = commitDiff(target, root);
  const input: CommitInput = { subject: meta.subject, body: meta.body, files: codeFiles, diff };
  const draft = await draftDecisionSafe(provider, input);

  const components = store.json.loadAll("components");
  const relatedComponents = components
    .filter((c: Component) => codeFiles.some((f) => c.paths.some((g) => pathMatchesGlob(f, g))))
    .map((c) => c.id);

  // Seed the id from the COMMIT (stable across runs), not the LLM-generated
  // title (which varies) — so re-syncing a commit updates rather than dupes.
  const id = decisionId(meta.sha);
  const existing = store.json.get("decisions", id);
  // Never clobber a human-confirmed decision with a low-confidence auto-draft.
  if (existing && existing.provenance.source.includes("human_confirmed")) {
    return { status: "skipped", reason: "human-confirmed decision exists for this commit", provider: provider.name };
  }
  const decision: Decision = {
    id,
    title: draft.title,
    status: existing?.status === "accepted" ? "accepted" : "proposed",
    context: draft.context,
    decision: draft.decision,
    consequences: draft.consequences,
    alternatives_rejected: draft.alternatives_rejected,
    related_components: relatedComponents,
    related_files: codeFiles,
    supersedes: existing?.supersedes ?? null,
    caused_by_bug: existing?.caused_by_bug ?? null,
    commit: meta.shortSha,
    provenance: {
      source: draft.source,
      confidence: draft.confidence,
      evidence: [`commit:${meta.shortSha}`, ...codeFiles.slice(0, 8)],
      last_verified: new Date().toISOString(), // when the Brain last re-derived this
    },
    date: meta.date, // the commit date
  };
  store.json.put("decisions", decision);
  return { status: "written", decision, provider: provider.name };
}

export interface FailureResult {
  status: "written";
  bug: Bug;
  constraint?: Constraint;
  provider: string;
}

/** Capture a Bug from a test failure. Suspects are ranked churn×recency×fan-in. */
export async function recordFailure(
  store: BrainStore,
  root: string,
  failure: { test: string; message: string; recentDiff?: string },
): Promise<FailureResult> {
  const symbols = store.json.loadAll("symbols");
  const ranked = rankSuspects(symbols, failure.message);
  // Prefer symbols actually named in the failure — so unrelated failures don't
  // get the same boilerplate suspect list (which would fake a recurrence).
  const msg = failure.message.toLowerCase();
  const mentioned = ranked.filter((s) => msg.includes(s.name.toLowerCase()));
  const suspects = (mentioned.length ? mentioned : ranked).slice(0, 6);

  const provider: SynthProvider = await selectProvider();
  const input: FailureInput = {
    test: failure.test,
    message: failure.message,
    // recent commit diff gives the synthesizer context for the root-cause guess
    recentDiff: failure.recentDiff ?? recentDiffFor(root),
    suspects: suspects.map((s) => `${s.name} @ ${s.file}`),
  };
  const draft = await draftBugSafe(provider, input);

  // Seed the id from the test id (stable), not the LLM title — one bug per test.
  const id = bugId(failure.test);
  // recurrence = a DIFFERENT prior bug with a similar symptom (not this same one).
  // Query text mirrors the corpus side (title+symptom+root_cause) for symmetry.
  const prior = findRecurrence(store, `${draft.title} ${draft.symptom} ${draft.root_cause}`, id);

  const affectedFiles = [...new Set(suspects.map((s) => s.file))];
  const bug: Bug = {
    id,
    title: draft.title,
    symptom: draft.symptom,
    root_cause: draft.root_cause,
    severity: draft.severity,
    status: "open",
    affected_files: affectedFiles,
    affected_symbols: suspects.map((s) => s.id),
    lineage: {
      introduced_commit: null,
      detected: failure.test,
      fixed_commit: null,
      recurrence_of: prior?.id ?? null,
      spawned_decision: null,
      spawned_constraint: null,
    },
    provenance: {
      source: draft.source,
      confidence: draft.confidence,
      evidence: [`test:${failure.test}`, ...affectedFiles.slice(0, 6)],
    },
  };
  store.json.put("bugs", bug);

  // Promotion (DESIGN §4): a recurrence or a high-severity bug raises a regression
  // Constraint to stop it coming back, and bumps the affected component's fragility.
  let constraint: Constraint | undefined;
  if (prior || draft.severity === "high" || draft.severity === "critical") {
    constraint = promoteConstraint(store, bug);
    bug.lineage.spawned_constraint = constraint.id;
    store.json.put("bugs", bug); // re-persist with the link
  }
  raiseFragility(store, affectedFiles);

  return { status: "written", bug, constraint, provider: provider.name };
}

/** Turn a bug into an advisory regression constraint scoped to its files. */
function promoteConstraint(store: BrainStore, bug: Bug): Constraint {
  const scope = bug.affected_files.length ? bug.affected_files : ["**"];
  const statement = `Regression guard: "${bug.title}" must not recur.`;
  const con: Constraint = {
    id: constraintId(statement),
    type: bug.severity === "critical" ? "security" : "correctness",
    statement,
    scope,
    severity: bug.severity === "critical" ? "blocking" : "warning",
    enforcement: "advisory_v1",
    rationale: `Derived from ${bug.id}: ${bug.root_cause || bug.symptom}`,
    source_decision: null,
    violations: [],
    provenance: { source: "derived", confidence: Math.min(0.9, bug.provenance.confidence + 0.2), evidence: [`bug:${bug.id}`] },
  };
  return store.json.put("constraints", con);
}

/** Bump fragility on components owning the affected files. */
function raiseFragility(store: BrainStore, files: string[]): void {
  const comps = store.json.loadAll("components");
  for (const c of comps) {
    if (files.some((f) => c.paths.some((g) => pathMatchesGlob(f, g)))) {
      const next = Math.min(1, Math.round((c.fragility + 0.1) * 100) / 100);
      if (next !== c.fragility) store.json.put("components", { ...c, fragility: next, updated_at: new Date().toISOString() });
    }
  }
}

/** churn × recency × fan_in, boosted if the symbol name appears in the message. */
function rankSuspects(symbols: Symbol[], message: string): Symbol[] {
  const msg = message.toLowerCase();
  return symbols
    .map((s) => {
      const mentioned = msg.includes(s.name.toLowerCase()) || msg.includes(s.file.toLowerCase());
      const score = (s.metrics.churn_90d + 1) * (s.metrics.fan_in + 1) * (mentioned ? 5 : 1);
      return { s, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

// Boilerplate/stopwords that must not drive recurrence matching — includes the
// deterministic provider's structural tokens (spec/suspected/src/...) and common
// test/JS filler, so two unrelated failures can't "match" on boilerplate alone.
const STOPWORDS = new Set([
  "test", "failure", "error", "the", "a", "an", "and", "or", "of", "to", "in", "on", "for",
  "with", "is", "was", "after", "before", "returned", "return", "valid", "expected", "actual",
  // deterministic-provider / path boilerplate
  "spec", "suspected", "src", "lib", "index", "unknown", "available", "llm",
  // generic JS/test filler
  "threw", "throws", "thrown", "null", "undefined", "property", "object", "cannot",
  "read", "value", "failed", "assert", "assertion", "function", "type", "string", "number",
]);

/** Neutralize boilerplate that would otherwise drive recurrence matching:
 *   - the deterministic provider's synthetic "Suspected in: a @ p, b @ q" list
 *     (the SAME churn-ranked suspects get injected into every no-mention failure,
 *     so two unrelated bugs would falsely share those identifier names), and
 *   - file-path tails ("... @ src/x.ts"). */
function stripPaths(text: string): string {
  return text
    // Anchored to the deterministic provider's structural shape
    // ("Suspected in: <ident> @ <path>, ...") so we strip the synthetic suspect
    // list but NOT legitimate prose that merely contains the phrase.
    .replace(/suspected in:\s*[\w$]+\s*@[^\n]*/gi, " ")
    .replace(/@\s*\S+/g, " ")
    .replace(/[\w./-]+\.(ts|tsx|js|jsx|mts|cts)\b/g, " ");
}

export function salientTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of stripPaths(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (t.length > 2 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Recurrence = a DIFFERENT prior bug whose salient terms overlap strongly with
 *  this one (in-memory, no FTS/reindex dependency, threshold-gated to avoid the
 *  over-broad OR false positives). Returns the best match above threshold. */
function findRecurrence(store: BrainStore, text: string, excludeId: string): Bug | undefined {
  const want = salientTerms(text);
  if (want.size === 0) return undefined;
  let best: Bug | undefined;
  let bestScore = 0;
  for (const b of store.json.loadAll("bugs")) {
    if (b.id === excludeId) continue;
    // symmetric with the query side (which now also includes root_cause)
    const have = salientTerms(`${b.title} ${b.symptom} ${b.root_cause}`);
    if (have.size === 0) continue;
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const jaccard = shared / (want.size + have.size - shared);
    // Scale-aware gate: small term sets need MORE shared terms so coincidental
    // overlap (a couple of common words) can't masquerade as a recurrence —
    // EXCEPT when the overlap is near-total (jaccard >= 0.8), which means the two
    // texts are nearly identical and a terse 2-term match is a real recurrence.
    const minSize = Math.min(want.size, have.size);
    const minShared = jaccard >= 0.8 ? 2 : Math.max(3, Math.ceil(0.5 * minSize));
    if (shared >= minShared && jaccard >= 0.4 && jaccard > bestScore) {
      best = b;
      bestScore = jaccard;
    }
  }
  return best;
}

/** Best-effort recent commit diff for failure context (empty if not a git repo). */
function recentDiffFor(root: string): string {
  const head = headSha(root);
  return head ? commitDiff(head, root, 12_000) : "";
}

async function draftDecisionSafe(provider: SynthProvider, input: CommitInput): Promise<DecisionDraft> {
  try {
    return await provider.draftDecision(input);
  } catch {
    // A provider failure (network, bad creds, CLI crash) must never abort the
    // learning loop — fall back to the deterministic heuristic draft.
    return new DeterministicProvider().draftDecision(input);
  }
}

async function draftBugSafe(provider: SynthProvider, input: FailureInput): Promise<BugDraft> {
  try {
    return await provider.draftBug(input);
  } catch {
    return new DeterministicProvider().draftBug(input);
  }
}
