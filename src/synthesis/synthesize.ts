/**
 * The learning loop's write step (DESIGN.md §4, §5 "write_back").
 *   - syncCommit:   commit diff -> Claude/heuristic -> Decision draft -> Hunch
 *   - recordFailure: failing test -> suspect ranking -> Bug draft -> Hunch
 *
 * Idempotent: a Decision id is derived from (commit, title) so re-running sync on
 * the same commit updates rather than duplicates. New records are LOW-confidence
 * and `proposed` until confirmed — advisory and cheap to discard.
 */
import type { HunchStore } from "../store/hunchStore.js";
import { commitMeta, commitDiff, headSha, currentBranch } from "../extractors/git.js";
import { analyzeDiff, type DiffAnalysis } from "../extractors/diff.js";
import { selectProvider, selectEnsemble, selectVerifier, verifyDecisionSafe, DeterministicProvider, type SynthProvider, type DecisionDraft, type BugDraft, type CommitInput, type FailureInput } from "./provider.js";
import { decisionId, bugId, constraintId } from "../core/ids.js";
import { commitCoveredBy } from "../core/dupdetect.js";
import { pathMatchesGlob } from "../core/glob.js";
import { draftTripwires, knownRepoDeps } from "./tripwires.js";
import type { Decision, Bug, Constraint, Component, Symbol } from "../core/types.js";
import type { TestReport } from "../extractors/testreport.js";

const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_SUBJECT = /^(merge|revert|bump|chore\(deps\)|format|lint|wip)\b/i;

export interface SyncResult {
  status: "written" | "skipped";
  reason?: string;
  decision?: Decision;
  provider?: string;
}

// Below this many changed code lines, a commit with no structural change and no
// explanatory body isn't worth a paid LLM call. Tunable via HUNCH_SIG_MIN_LINES.
const SIG_MIN_LINES = Number(process.env.HUNCH_SIG_MIN_LINES) || 12;
const SIG_MIN_BODY = 40;

/** Is a commit substantive enough to spend a paid LLM synthesis call on? Pure and
 *  deterministic. Any structural change (symbol/dependency delta), non-trivial
 *  churn, several files, OR an explanatory commit body signals a real decision
 *  worth the model. Everything below (typo/tweak/one-liner with no message) falls
 *  to the free deterministic draft — shallower but honestly low-confidence. */
export function isSignificant(meta: { body: string }, a: DiffAnalysis, codeFiles: string[]): boolean {
  const structural =
    a.addedSymbols.length + a.removedSymbols.length + a.changedSymbols.length + a.addedDeps.length + a.removedDeps.length;
  if (structural > 0) return true;
  if (a.addedLines + a.removedLines >= SIG_MIN_LINES) return true;
  if (codeFiles.length >= 3) return true;
  if (meta.body.trim().length >= SIG_MIN_BODY) return true;
  return false;
}

/** Capture a Decision from a commit. Defaults to HEAD. Pass `{ force: true }` to
 *  re-synthesize a commit that already has an (auto-drafted) decision. */
export async function syncCommit(
  store: HunchStore,
  root: string,
  sha?: string,
  opts: { force?: boolean; private?: boolean; localOnly?: boolean; deep?: boolean; verify?: boolean; samples?: number } = {},
): Promise<SyncResult> {
  const target = sha || headSha(root);
  if (!target) return { status: "skipped", reason: "no HEAD commit" };
  const meta = commitMeta(target, root);
  if (!meta) return { status: "skipped", reason: "commit not found" };

  if (SKIP_SUBJECT.test(meta.subject)) return { status: "skipped", reason: `trivial subject: ${meta.subject}` };
  const codeFiles = meta.files.filter((f) => CODE_RE.test(f));
  if (codeFiles.length === 0) return { status: "skipped", reason: "no code files changed" };

  // Seed the id from the COMMIT (stable across runs), not the LLM-generated title
  // (which varies) — so re-syncing a commit updates rather than dupes.
  const id = decisionId(meta.sha);
  // Check the store this capture WILL write to. Looking only in the public store
  // made private/shared re-syncs re-draft the same commit and let `--force`
  // overwrite a human-confirmed overlay decision.
  const home = store.captureHome(!!opts.private);
  const existing = home === "private" ? store.getPrivateRec("decisions", id) : store.json.get("decisions", id);
  // Never clobber a human-confirmed decision with a low-confidence auto-draft —
  // even under --force. Skip BEFORE synthesizing so we never pay for a draft we'd
  // throw away (the old order drafted first, then discarded it here).
  if (existing && existing.provenance.source.includes("human_confirmed")) {
    return { status: "skipped", reason: "human-confirmed decision exists for this commit", decision: existing };
  }
  // Token-thrift idempotency: a decision is already captured for this commit, so
  // don't re-pay the LLM on a re-run (hook double-fire, overlapping backfill, or
  // a manual replay). Re-synthesize only when explicitly forced.
  if (existing && !opts.force) {
    return {
      status: "skipped",
      reason: "decision already captured for this commit (use --force to re-synthesize)",
      decision: existing,
    };
  }

  // Duplicate-factory gate (deterministic, pre-LLM): the human recorded this
  // choice via MCP minutes-to-days ago (commit: null, different id), and now the
  // post-commit hook would re-draft the same content under a commit-keyed id —
  // review triage measured 7 of 14 queued drafts as exactly this. A recent
  // human-confirmed decision claiming this commit's files → skip the draft (and
  // the subscription call). Recency-windowed; --force overrides.
  const covered = commitCoveredBy(codeFiles, meta.subject, store.recs("decisions"), Date.now());
  if (covered && !opts.force) {
    return {
      status: "skipped",
      reason: `already covered by ${covered.id} — "${covered.title}" (recorded ${covered.hoursAgo}h ago, claims ${covered.fileOverlapPct}% of this commit's files; --force to draft anyway)`,
    };
  }

  const diff = commitDiff(target, root);
  const analysis = analyzeDiff(diff);
  // Significance gate: reserve the paid LLM for substantive commits; trivial ones
  // get the FREE deterministic draft (honestly labeled "inferred"/low-confidence,
  // so the Hunch stays accurate-by-provenance). --force always uses the provider.
  // Deep Synthesis (--deep): ensemble every available subscription CLI and reconcile
  // their drafts (agreement-weighted, confidence capped below the strict gate). Falls
  // back to the normal single-provider path when no CLI is available. Opt-in only.
  // --verify forces the LLM provider (auditing a deterministic draft is pointless) and,
  // like --deep, runs the Critic pass below. Subscription-only throughout (con_2ce3f2a547).
  // An explicit private capture is storage-private AND local-only by default:
  // never send a sensitive diff to a subscription CLI just to create a draft.
  // Shared mode remains an explicit team policy and keeps its existing provider
  // behavior unless the caller asked for a private capture.
  const localOnly = opts.localOnly ?? !!opts.private;
  const wantVerify = !localOnly && !!(opts.verify || opts.deep);
  const provider = localOnly
    ? new DeterministicProvider()
    : opts.deep
    ? (await selectEnsemble({ samples: opts.samples })) ?? await selectProvider({ root })
    : opts.force || opts.verify || isSignificant(meta, analysis, codeFiles)
      ? await selectProvider({ root })
      : new DeterministicProvider();
  const input: CommitInput = { subject: meta.subject, body: meta.body, files: codeFiles, diff, analysis };
  let draft = await draftDecisionSafe(provider, input);
  // The Critic pass: audit the draft against the commit, PRUNE unsupported alternatives
  // (BEFORE they scaffold tripwires below) and consequences, and lower confidence on weak
  // grounding. No-ops when no assistant CLI is available; never raises trust (dec_9a2f2fe72a).
  if (wantVerify) draft = await verifyDecisionSafe(await selectVerifier({ root }), input, draft);

  // Advisory synthesis telemetry for `hunch review` — which provider ran, how many drafts
  // were reconciled, their agreement, and the verifier's grounding. Rides in `evidence`
  // (no schema change → respects forward-migration invariant con_947c578b2c).
  const synthBits = [`provider=${provider.name}`];
  if (draft.samples) synthBits.push(`samples=${draft.samples}`);
  if (draft.agreement != null) synthBits.push(`agreement=${draft.agreement}`);
  if (draft.grounded != null) synthBits.push(`grounded=${draft.grounded}`);
  // The Critic was requested (--verify/--deep) but didn't apply — surface WHY
  // (unavailable / failed) so a skipped audit is never mistaken for a clean one.
  else if (draft.verifyOutcome && draft.verifyOutcome !== "applied") synthBits.push(`verify=${draft.verifyOutcome}`);
  if (draft.pruned) synthBits.push(`pruned=${draft.pruned}`); // the Critic's visible value
  const synthEvidence = `synth:${synthBits.join(" ")}`;
  // Tag the capturing branch so branch-scoped work stays FILTERABLE in the one shared store
  // (every worktree/branch writes to the same overlay — this keeps "what was decided on
  // feature-x?" answerable without fragmenting memory per branch). Empty in detached HEAD.
  const branch = currentBranch(root);
  const branchTag = branch ? [`branch:${branch}`] : [];

  const components = store.json.loadAll("components");
  const relatedComponents = components
    .filter((c: Component) => codeFiles.some((f) => c.paths.some((g) => pathMatchesGlob(f, g))))
    .map((c) => c.id);

  // Surface any do-not-break constraints this commit's files touch (DESIGN §4
  // "constraint touched" flag) right in the decision context, with evidence.
  const touchedConstraints = store.json
    .loadAll("constraints")
    .filter((c) => codeFiles.some((f) => c.scope.some((g) => pathMatchesGlob(f, g))));
  const constraintNote = touchedConstraints.length
    ? ` Touches invariant(s): ${touchedConstraints.map((c) => `${c.id} (${c.statement})`).join("; ")}.`
    : "";

  const decision: Decision = {
    id,
    title: draft.title,
    // Auto-synthesized decisions are un-anchored (topic null) — a topic is a human
    // act, never a machine guess. Preserve one an earlier human capture attached.
    topic: existing?.topic ?? null,
    status: existing?.status === "accepted" ? "accepted" : "proposed",
    context: draft.context + constraintNote,
    decision: draft.decision,
    consequences: draft.consequences,
    alternatives_rejected: draft.alternatives_rejected,
    // Capture-time drafting: scaffold ADVISORY tripwires from the rejected
    // alternatives (preserve any already-curated ones across re-sync). All llm_draft
    // → never block until confirmed via `hunch review --accept` (dec_a466655539).
    rejected_tripwires: existing?.rejected_tripwires?.length
      ? existing.rejected_tripwires
      : draftTripwires(draft.alternatives_rejected, codeFiles, knownRepoDeps(root)),
    related_components: relatedComponents,
    related_files: codeFiles,
    supersedes: existing?.supersedes ?? null,
    superseded_by: existing?.superseded_by ?? null,
    caused_by_bug: existing?.caused_by_bug ?? null,
    commit: meta.shortSha,
    // Valid-time window is git-anchored: the decision takes effect at its commit
    // date and stays in force until a later decision supersedes it (preserve any
    // window an earlier sync/supersession already set on this same commit's record).
    valid_from: existing?.valid_from ?? meta.date,
    valid_to: existing?.valid_to ?? null,
    // What this commit DELETED — the Regression Guard later matches a re-adding
    // diff against this (recompute from the fresh analysis, even on --force).
    retired: { symbols: analysis.removedSymbols.map((s) => s.name), deps: analysis.removedDeps },
    provenance: {
      source: draft.source,
      confidence: draft.confidence,
      evidence: [`commit:${meta.shortSha}`, synthEvidence, ...branchTag, ...codeFiles.slice(0, 8)],
      last_verified: new Date().toISOString(), // when the Hunch last re-derived this
    },
    date: meta.date, // the commit date
  };
  // Route to the record's ONE home: the overlay when asked (--private) or in unified
  // ("shared") mode; else the public store. Same contract as every other capture path.
  store.putCapture("decisions", decision, opts.private);
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
  store: HunchStore,
  root: string,
  failure: { test: string; message: string; recentDiff?: string },
  opts: { private?: boolean } = {},
): Promise<FailureResult> {
  const symbols = store.json.loadAll("symbols");
  const ranked = rankSuspects(symbols, failure.message);
  // Prefer symbols actually named in the failure — so unrelated failures don't
  // get the same boilerplate suspect list (which would fake a recurrence).
  const msg = failure.message.toLowerCase();
  const mentioned = ranked.filter((s) => msg.includes(s.name.toLowerCase()));
  const suspects = (mentioned.length ? mentioned : ranked).slice(0, 6);

  // A private bug may contain a stack trace, customer data, or secrets. Keep the
  // whole capture local unless the caller deliberately routes it through a shared
  // (non-private) workflow.
  const provider: SynthProvider = opts.private ? new DeterministicProvider() : await selectProvider({ root });
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
  const home = store.captureHome(!!opts.private);
  const prior = findRecurrence(store, `${draft.title} ${draft.symptom} ${draft.root_cause}`, id, home);

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
  store.putCapture("bugs", bug, opts.private);

  // Promotion (DESIGN §4): a recurrence or a SUBSTANTIATED high-severity bug raises
  // a regression Constraint to stop it coming back, and bumps fragility.
  let constraint: Constraint | undefined;
  if (shouldPromoteConstraint(draft.severity, bug.root_cause, !!prior)) {
    constraint = promoteConstraint(store, bug, opts.private);
    bug.lineage.spawned_constraint = constraint.id;
    store.putWhereItLives("bugs", bug); // re-persist with the link, in the same home
  }
  raiseFragility(store, affectedFiles);

  return { status: "written", bug, constraint, provider: provider.name };
}

export interface CapturedFailure {
  bug: Bug;
  constraint?: Constraint;
}
export interface TestRunCapture {
  results: CapturedFailure[];
  /** Bugs resolved because their test now passes. */
  fixed: Bug[];
  /** True when the output wasn't recognized TAP/spec and we captured one coarse bug. */
  fallback: boolean;
}

/** Orchestrate one `hunch test` run into graph writes: capture each failing test
 *  as a Bug (recordFailure → suspects / recurrence / Constraint promotion), and
 *  resolve any open Bug whose test now passes. Kept free of console I/O so the
 *  whole capture→resolve→promote loop is unit-testable. Does NOT reindex — the
 *  caller does, once. `status` is the runner's exit code (null if unknown). */
export async function captureTestRun(
  store: HunchStore,
  root: string,
  input: { report: TestReport; status: number | null; cmd: string; output: string; private?: boolean },
): Promise<TestRunCapture> {
  const { report, status } = input;
  // Unrecognized output that still failed → one coarse bug from the tail, rather
  // than silently reporting success (the worst failure mode for a learning loop).
  let failures = report.failures;
  let fallback = false;
  if (!report.recognized && status !== 0) {
    const tail = input.output.trim().split(/\r?\n/).slice(-40).join("\n");
    failures = [{ test: input.cmd, message: `Test run failed (exit ${status}); output not TAP/spec.\n${tail}` }];
    fallback = true;
  }

  const results: CapturedFailure[] = [];
  for (const f of failures) {
    const r = await recordFailure(store, root, f, { private: input.private });
    results.push({ bug: r.bug, constraint: r.constraint });
  }

  let sha: string | null = null;
  try { sha = headSha(root); } catch { /* not a git repo / no HEAD — leave null */ }
  const fixed: Bug[] = [];
  for (const name of report.passed) {
    const b = store.getRec("bugs", bugId(name)); // a unified-mode bug lives in the overlay
    if (b && b.status === "open") {
      const resolved: Bug = { ...b, status: "fixed", lineage: { ...b.lineage, fixed_commit: sha } };
      store.putWhereItLives("bugs", resolved);
      fixed.push(resolved);
    }
  }

  return { results, fixed, fallback };
}

/** Whether a bug should auto-promote a regression Constraint (a do-not-break
 *  invariant). A recurrence always does. Otherwise it must be high/critical AND
 *  substantiated by a real root cause — a bare severity label with no analysis
 *  (e.g. an LLM "test_failure+llm_partial" draft) keeps its severity on the bug
 *  record for human review but must not silently mint an invariant from thin air. */
export function shouldPromoteConstraint(severity: Bug["severity"], rootCause: string, isRecurrence: boolean): boolean {
  if (isRecurrence) return true;
  const severe = severity === "high" || severity === "critical";
  return severe && rootCause.trim().length > 0;
}

/** Turn a bug into an advisory regression constraint scoped to its files. */
function promoteConstraint(store: HunchStore, bug: Bug, isPrivate = false): Constraint {
  const scope = bug.affected_files.length ? bug.affected_files : ["**"];
  const statement = `Regression guard: "${bug.title}" must not recur.`;
  const con: Constraint = {
    id: constraintId(statement),
    type: bug.severity === "critical" ? "security" : "correctness",
    statement,
    scope,
    severity: bug.severity === "critical" ? "blocking" : "warning",
    enforcement: "advisory_v1",
    match: null,
    forbids: null,
    rationale: `Derived from ${bug.id}: ${bug.root_cause || bug.symptom}`,
    source_decision: null,
    violations: [],
    status: "active",
    valid_from: new Date().toISOString(),
    valid_to: null,
    provenance: { source: "derived", confidence: Math.min(0.9, bug.provenance.confidence + 0.2), evidence: [`bug:${bug.id}`] },
  };
  return store.putCapture("constraints", con, isPrivate);
}

/** Bump fragility on components owning the affected files. */
function raiseFragility(store: HunchStore, files: string[]): void {
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
function findRecurrence(store: HunchStore, text: string, excludeId: string, home: "public" | "private"): Bug | undefined {
  const want = salientTerms(text);
  if (want.size === 0) return undefined;
  let best: Bug | undefined;
  let bestScore = 0;
  for (const b of store.recsInHome("bugs", home)) {
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

export async function draftDecisionSafe(provider: SynthProvider, input: CommitInput): Promise<DecisionDraft> {
  try {
    return await provider.draftDecision(input);
  } catch {
    // A provider failure (network, bad creds, CLI crash, unparseable output) must
    // never abort the learning loop — fall back to the deterministic heuristic
    // draft, which is honestly labeled ("inferred") rather than a hollow llm_draft.
    return new DeterministicProvider().draftDecision(input);
  }
}

export async function draftBugSafe(provider: SynthProvider, input: FailureInput): Promise<BugDraft> {
  try {
    return await provider.draftBug(input);
  } catch {
    return new DeterministicProvider().draftBug(input);
  }
}
