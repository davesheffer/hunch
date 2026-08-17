/**
 * MCP server — the structured two-way API into the Hunch (DESIGN.md §7 / App. A).
 * Exposes read tools (query/why/bug_lineage/check_constraints/get_dependents) and
 * a write tool (record_decision). Registered with Claude Code via .mcp.json.
 *
 * STDIO PROTOCOL RULE: stdout carries JSON-RPC — never console.log here. All
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hunchPaths, findRoot, toPosixTarget } from "../core/paths.js";
import { canonicalRootPath, resolveActiveRoot } from "./roots.js";
import { HunchStore } from "../store/hunchStore.js";
import { selectEmbedder } from "../store/embedder.js";
import { decisionId, findingId } from "../core/ids.js";
import { buildCorrectionConstraint } from "../core/correction.js";
import { knownRepoDeps } from "../synthesis/tripwires.js";
import { refreshExistingGrounding } from "../integrations/providers.js";
import { revParse, asOfDate, revExists, lastChangeDate, rangeFiles, rangeDiff, commitFiles, commitDiff, stagedFiles, stagedDiff, workingFiles, workingDiff, pullHunchStatus, sameRemoteUrl, currentBranch, type HunchPullStatus } from "../extractors/git.js";
import { flushCapture, flushMemoryHome, pinSharedRemote } from "../integrations/sync.js";
import { advertisedTeamRemoteContract, ensureTeamOverlay, overlayMatchesTeamRemote, readTeamConfig, teamRemoteContract, teamSharedRef } from "../integrations/team.js";
import { formatStructure } from "../core/format.js";
import { buildDeliveryEnvelope, type DeliveryEnvelope } from "../core/delivery.js";
import { recordServed } from "../core/served.js";
import type { Runbook } from "../core/types.js";
import { compareCandidates } from "../core/compare.js";
import { checkConformance } from "../core/conformance.js";
import { ConstitutionService, policyEvaluationEnvelope } from "../constitution/service.js";
import { sourceGraphSnapshot } from "../constitution/evaluator.js";
import { G2_RUNBOOK_CATEGORIES } from "../constitution/g2.js";
import { renderMarkdown, renderImpact, verdict } from "../core/checkreport.js";
import { nowData, wikiStatus, publicHome, readWikiManifestAt } from "../wiki/wiki.js";
import { HUNCH_VERSION } from "../core/version.js";
import { assertCompleteRepoScan, indexRepo, scanRepo } from "../extractors/indexer.js";
import type { Decision, Finding, Symbol } from "../core/types.js";
import { liveForTopic, historyForTopic, rejectedForTopic, captureConflicts } from "../core/topics.js";
import { pendingEscalations, policyEscalations, type Escalation } from "../core/escalations.js";
import { scanRecord, publicationWarning, loadVocabulary } from "../core/publication.js";
import { premiseEscalations } from "../core/premises.js";
import { issueCaptureToken as issueToken, consumeCaptureToken as consumeToken } from "../core/capturetoken.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Shared by every auto-committing write tool (issue #20): the MCP `roots` protocol
 *  cannot see an agent-driven `cd`/EnterWorktree, so a stdio server's cached root
 *  never moves on its own — this is the client-agnostic fallback, resolved fresh on
 *  every call by the generic tool wrapper below (see extractCwdHint). */
const cwdHintField = z.string().optional().describe(
  "Your ACTUAL current working directory for THIS call. Pass it whenever it differs from where this MCP " +
  "session started — most commonly after entering a git worktree (EnterWorktree) or `cd`-ing to a different " +
  "checkout — so the write commits to that repo/branch instead of silently landing on the server's original " +
  "root. Omit only when you are still in the session's starting directory.",
);

/** Pull `cwd` out of a tool call's already-parsed input without assuming any one
 *  tool's exact input shape — every write tool spreads the same cwdHintField in,
 *  but the wrapper below runs for every tool, read or write. */
function extractCwdHint(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const cwd = (input as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

/** Honest auto-commit suffix: reports only what flushCapture ACTUALLY did. A skipped
 *  commit (backstop/lock/nothing staged) says nothing — the record is on disk and the
 *  next flush sweeps it up; claiming "auto-committed" there would be a lie. */
const flushNote = (flush: "pushed" | "committed" | null, home: "public" | "private", mode: string): string =>
  flush === "pushed" ? ` (committed + pushed to the ${mode === "shared" ? "shared team store" : "private repo"})`
    : flush === "committed"
      ? home === "private"
        ? " (committed to the overlay repo — push deferred: offline, no upstream, or merge conflict; the next capture or `hunch private --sync` retries)"
        : " (auto-committed to .hunch/ — rides your next push)"
      : "";

/** When an overlay exists, a PUBLIC write deserves one visible line: a record that
 *  lands in the committed store publishes on the next push, and an agent writing
 *  strategy/competitive content there is a leak nobody notices until it ships
 *  (2026-08-09: 15 roadmap records caught pre-push only by a release sweep). */
/** Repo-local term list, read once per server process. The package ships none;
 *  `.hunch/publication.json` is how a repo opts in (see src/core/publication.ts). */
let vocabularyCache: RegExp[] | null = null;
const publicationVocabulary = (hunchDir: string): RegExp[] =>
  (vocabularyCache ??= loadVocabulary(hunchDir));

const publicHomeNote = (
  home: "public" | "private",
  hasPrivate: boolean,
  record?: unknown,
  hunchDir?: string,
): string => {
  if (home !== "public") return "";
  // The generic nudge below was already present during BOTH leaks and was ignored,
  // because a warning that cannot quote the offending text reads as boilerplate.
  // scanRecord adds the specific line: what matched, in which field.
  const risk = record === undefined
    ? ""
    : publicationWarning(scanRecord(record, { vocabulary: hunchDir ? publicationVocabulary(hunchDir) : [] }));
  if (!hasPrivate) return risk;
  return "\nℹ Landed in the COMMITTED PUBLIC store (publishes with the repo). For sensitive/strategy content, re-record with private:true — the overlay store." + risk;
};

/** Self-diagnosing destination report (issue #17/#20): the exact failure mode this
 *  guards against is silent — a capture landing in the wrong repo/branch with no
 *  sign of it short of a manual `git log` audit. Every auto-committing write tool
 *  appends this so the destination is always visible in the response, whether or
 *  not a cwd hint was involved in choosing it. */
const destinationNote = (destRoot: string): string => {
  const branch = currentBranch(destRoot);
  return ` [captured${branch ? ` on branch ${branch}` : ""} in ${destRoot}]`;
};

/** Where a capture keyed to `home` actually lands: the private overlay directory when
 *  one is configured, else the public repo root. Centralizes the branch used at every
 *  destination-reporting call site below — `hunch_policy_upgrade_correction` once
 *  diverged from this (computing its own `artifactHome` but reporting the public root
 *  regardless), silently misreporting the destination for a private-homed proof. */
const resolveDestRoot = (home: "public" | "private", store: HunchStore, root: string): string =>
  home === "private" && store.privateDir ? store.privateDir : root;

// Read-side token budgets: every tool result is injected into a Claude Code
// session, so an uncapped list pollutes the context window. Cap each list to its
// highest-signal head (records are pre-sorted by severity/confidence) and tell the
// caller what was withheld rather than truncating silently.
const WHY_CAP = 6; // per record-type in hunch_why
const DEP_CAP = 25; // dependents in hunch_get_dependents
const QUERY_HITS = 8; // hunch_query matches (was 12)
const FINDINGS_CAP = 12; // hunch_findings listing
const SEV_CONSTRAINT: Record<string, number> = { blocking: 3, warning: 2, advisory: 1 };
const SEV_BUG: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const more = (total: number, cap: number, hint = ""): string =>
  total > cap ? `\n  …(+${total - cap} more${hint ? ` — ${hint}` : ""})` : "";

/** Public MCP shape for the canonical delivery envelope. Keeping the schema on
 *  the tool means orchestrators can consume receipt facts without scraping the
 *  backward-compatible text block. */
const DELIVERY_OUTPUT_SCHEMA = z.object({
  text: z.string(),
  delivered: z.array(z.object({
    kind: z.enum(["constraints", "decisions", "bugs", "findings"]),
    record_id: z.string(),
    rank: z.number().int().positive(),
    delivery_reason: z.enum(["ranked", "blocking-reserved"]),
    provenance_status: z.enum(["current", "unverified", "stale"]),
    token_cost: z.number().int().nonnegative(),
  })),
  supplements: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    delivered: z.boolean(),
    reason: z.enum(["supplemental", "budget", "empty"]),
    rank: z.number().int().positive(),
    token_cost: z.number().int().nonnegative(),
  })),
  omitted: z.array(z.object({
    kind: z.enum(["constraints", "decisions", "bugs", "findings"]),
    record_id: z.string(),
    reason: z.enum(["budget", "stale-provenance", "retired"]),
    detail: z.string(),
  })),
  budget_tokens: z.number().int().nonnegative(),
  used_chars: z.number().int().nonnegative(),
  blocking_overflow: z.boolean(),
});

/** Return the same human-readable brief older clients consume plus the exact
 *  machine-readable envelope. Receipt recording is deliberately best-effort:
 *  recordServed never throws, so telemetry can never cost a delivery. */
function deliveredContext(
  root: string,
  target: string,
  envelope: DeliveryEnvelope,
  sessionId?: string,
): ToolResult {
  // Validate before recording: if a future envelope change drifts from the
  // advertised MCP contract, the SDK will reject the call and the local ledger
  // must not claim that response was served.
  const structuredContent = DELIVERY_OUTPUT_SCHEMA.parse(envelope);
  recordServed(root, structuredContent.delivered.map((item) => ({
    event: "served",
    kind: item.kind,
    record_id: item.record_id,
    target,
    session_id: sessionId,
    rank: item.rank,
    delivery_reason: item.delivery_reason,
    provenance_status: item.provenance_status,
    token_cost: item.token_cost,
  })));
  return {
    content: [{ type: "text", text: structuredContent.text }],
    structuredContent,
  };
}

// Capture-session tokens live in src/core/capturetoken.ts (pure + testable). These
// thin wrappers bind the process clock and id source at the call site (§5 Stage 1).
const issueCaptureToken = (): string => issueToken(randomUUID, Date.now());
const consumeCaptureToken = (token: string | undefined): boolean => consumeToken(token, Date.now());

/** The interrogation protocol returned by hunch_capture_decision. With `deciding`,
 *  the choice is NOT yet made: the verdict loop runs first so the record's
 *  alternatives_rejected are attacks that actually ran — not post-hoc fiction. */
function grillingProtocol(topic: string | undefined, token: string, deciding = false): string {
  const verdict = [
    "The decision is NOT yet made — run the VERDICT LOOP first (one question at a time), then the grilling rules below.",
    "",
    "VERDICT LOOP:",
    "A. SPLIT — one separable call per verdict, one topic per call. If the ask bundles several decisions, split and run each.",
    "B. CANDIDATES — elicit at least TWO real options (include do-nothing when sane). One candidate = anchoring; keep asking.",
    "C. ATTACK — attack each candidate from INDEPENDENT lenses: product, technical, strategy, economics, and self-consistency (does it contradict a recorded decision or constraint? cite dec_/con_ ids). Every attack cites evidence observed this session; no evidence → mark it plausible and weigh it less.",
    "D. CONVERGE — two or more independent landing attacks kill a candidate. Keep the FAILED attacks too — they are the tested-safe surface; fold them into context. No convergence → prefer the candidate whose failure is REVERSIBLE.",
    "E. TRIPWIRES — for each rejected candidate, ask what future evidence would make it right after all; embed it in the rejected alternative ('rejected X — revisit if Y').",
    "",
    "",
  ].join("\n");
  return (deciding ? verdict : "") + [
    "You are capturing an engineering decision into Hunch's graph. Run the GRILLING LOOP, then commit.",
    "",
    "RULES:",
    "1. Grill ONE focused question at a time. Push back on hand-wavy answers. Resolve every branch of the decision tree before committing — an unexamined decision poisons the graph.",
    `2. Confirm the TOPIC anchor with the human before committing${topic ? ` (proposed: "${topic}")` : ""}. Exactly one topic per decision; if it spans two, split into two captures.`,
    "3. Capture REJECTED alternatives explicitly — for each, what it was and why not. This is what makes the decision enforceable (Veto/drift check against it).",
    `4. Commit with hunch_record_decision, passing capture_token:"${token}" and the confirmed topic. The artifact is the graph write, not prose.`,
    "5. On CONFLICT with an existing live decision for the topic, do NOT auto-supersede — Hunch refuses and presents both; let the human choose to supersede (link), split the topic, or discard.",
    "",
    "Required before commit: topic, title, decision, context (the rationale/why), alternatives_rejected. Missing any → keep grilling.",
  ].join("\n");
}

/** Deterministic quality nudge for a freshly recorded ACCEPTED decision: an
 *  unattacked record (no rejected alternatives) or rejections without a
 *  "revisit if" flip condition get ONE advisory line — never a gate. */
function qualityNudge(rec: Decision): string {
  if (rec.status !== "accepted") return "";
  if (!rec.alternatives_rejected.length) {
    return `\n\n△ Unattacked record: no alternatives_rejected. The graph can only veto what was explicitly rejected — next time run hunch_capture_decision(deciding:true) so rejections come from attacks that actually ran.`;
  }
  if (!rec.alternatives_rejected.some((a) => /revisit if/i.test(a))) {
    return `\n\n△ Tip: none of the ${rec.alternatives_rejected.length} rejected alternative(s) carries a "revisit if …" flip condition — embed one per rejection so a future session knows when the call expires.`;
  }
  return "";
}

/** Resolve a free-form target (symbol id / name / file path) to symbol records. */
function resolveSymbols(store: HunchStore, target: string): Symbol[] {
  target = toPosixTarget(target);
  const syms = store.json.loadAll("symbols");
  const byId = syms.find((s) => s.id === target);
  if (byId) return [byId];
  const byName = syms.filter((s) => s.name === target);
  if (byName.length) return byName;
  return syms.filter((s) => s.file === target || s.file.endsWith(target));
}

/** Resolve a target to canonical indexed file path(s) (for file-granular blast
 *  radius). Falls back to the literal target so direct-scope checks still run. */
function resolveFiles(store: HunchStore, target: string): string[] {
  const files = new Set(resolveSymbols(store, target).map((s) => s.file));
  return files.size ? [...files] : [toPosixTarget(target)];
}

type PreparedRoot = {
  root: string;
  teamFile: string;
  teamAdvertised: boolean;
  startupTeamConfig: ReturnType<typeof readTeamConfig>;
  startupTeamRoute: ReturnType<typeof teamRemoteContract>;
  store: HunchStore;
  nextRemotePullAt: number;
  consecutivePullFailures: number;
  indexedSourceStamp: string | undefined;
};

function pullBackoff(status: HunchPullStatus, finishedAt: number, failures: number): {
  nextRemotePullAt: number;
  consecutivePullFailures: number;
} {
  if (status === "updated" || status === "current") {
    return { consecutivePullFailures: 0, nextRemotePullAt: finishedAt + 1_000 };
  }
  if (status === "busy") {
    return { consecutivePullFailures: failures, nextRemotePullAt: finishedAt + 100 };
  }
  if (status === "unconfigured") {
    return { consecutivePullFailures: 0, nextRemotePullAt: finishedAt + 30_000 };
  }
  const consecutivePullFailures = Math.min(failures + 1, 6);
  return {
    consecutivePullFailures,
    nextRemotePullAt: finishedAt + Math.min(30_000, 1_000 * (2 ** (consecutivePullFailures - 1))),
  };
}

function rebuildFreshIndex(store: HunchStore): string | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = store.sourceStamp();
    store.reindexFresh();
    const after = store.sourceStamp();
    if (before === after) return after;
  }
  return undefined;
}

/** Prepare and validate a complete root context before publishing it to handlers.
 *  A failed re-home therefore leaves the previous graph fully active. */
function prepareRoot(root: string, explicitOverlay: boolean, requireIndex: boolean): PreparedRoot {
  // Team auto-discovery: a committed .hunch/team.json advertises the shared store — a
  // fresh clone (a new teammate, a headless agent, a CI workflow) wires itself BEFORE the
  // store is constructed, so every consumer resolves the same single source of truth.
  // Once that declaration is present it is fail-closed: starting against the public
  // graph after an invalid config, failed first clone, or dead pointer would let both
  // reads and writes silently escape the team's memory spine.
  const teamFile = join(hunchPaths(root).hunch, "team.json");
  const teamAdvertised = !explicitOverlay && existsSync(teamFile);
  const startupTeamConfig = teamAdvertised ? readTeamConfig(root) : null;
  if (teamAdvertised && !startupTeamConfig) {
    throw new Error(".hunch/team.json is invalid or unsafe; refusing to start MCP on public memory");
  }
  ensureTeamOverlay(root);
  const store = new HunchStore(hunchPaths(root));
  try {
    if (teamAdvertised && (store.mode !== "shared"
      || !store.privateDir
      || !existsSync(store.privateDir)
      || !overlayMatchesTeamRemote(root, join(store.privateDir, "..")))) {
      throw new Error("the advertised team memory store is unavailable or tracks a different remote; refusing to start MCP on another graph");
    }
    const startupTeamRoute = teamAdvertised && store.privateDir
      ? teamRemoteContract(root, join(store.privateDir, ".."))
      : null;
    if (startupTeamRoute) pinSharedRemote(store, startupTeamRoute);

    let nextRemotePullAt = 0;
    let consecutivePullFailures = 0;
    if (store.privateDir) {
      try {
        const status = pullHunchStatus(store.privateDir, {
          timeoutMs: 5_000,
          remote: startupTeamRoute ?? advertisedTeamRemoteContract(root, join(store.privateDir, "..")),
        });
        ({ nextRemotePullAt, consecutivePullFailures } = pullBackoff(status, Date.now(), 0));
      } catch {
        // Offline / no remote — proceed with the validated local store.
      }
    }

    let indexedSourceStamp: string | undefined;
    try {
      indexedSourceStamp = rebuildFreshIndex(store);
    } catch (error) {
      if (requireIndex) throw error;
      console.error("[hunch-mcp] reindex on startup failed:", (error as Error).message);
    }

    return {
      root,
      teamFile,
      teamAdvertised,
      startupTeamConfig,
      startupTeamRoute,
      store,
      nextRemotePullAt,
      consecutivePullFailures,
      indexedSourceStamp,
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

export type RootControlledServer = {
  server: McpServer;
  getRoot: () => string;
  setRoot: (next: string) => void;
  /** Drop a swap parked by `setRoot` while a request was in flight. The roots
   *  wiring calls this when a LATER resolution is ambiguous, so a stale parked
   *  swap can never apply after the client stopped unambiguously advertising it. */
  cancelPendingRoot: () => void;
};

export function buildServerWithRootControl(initialRoot: string): RootControlledServer {
  const explicitOverlay = !!process.env.HUNCH_PRIVATE_DIR?.trim();
  const initial = prepareRoot(initialRoot, explicitOverlay, false);
  let root = initial.root;
  let teamFile = initial.teamFile;
  let teamAdvertised = initial.teamAdvertised;
  let startupTeamConfig = initial.startupTeamConfig;
  let startupTeamRoute = initial.startupTeamRoute;
  let store = initial.store;
  let nextRemotePullAt = initial.nextRemotePullAt;
  let consecutivePullFailures = initial.consecutivePullFailures;
  let indexedSourceStamp = initial.indexedSourceStamp;

  const matchesStartupTeamRoute = (): boolean => {
    if (!teamAdvertised || !store.privateDir || !startupTeamConfig || !startupTeamRoute) return !teamAdvertised;
    const currentTeamConfig = readTeamConfig(root);
    const currentTeamRoute = teamRemoteContract(root, join(store.privateDir, ".."));
    return !!currentTeamConfig && !!currentTeamRoute
      && sameRemoteUrl(startupTeamConfig.shared_repo, root, currentTeamConfig.shared_repo, root)
      && teamSharedRef(startupTeamConfig) === teamSharedRef(currentTeamConfig)
      && startupTeamRoute.ref === currentTeamRoute.ref
      && sameRemoteUrl(startupTeamRoute.fetchUrl, startupTeamRoute.urlCwd, currentTeamRoute.fetchUrl, currentTeamRoute.urlCwd)
      && sameRemoteUrl(startupTeamRoute.pushUrl, startupTeamRoute.urlCwd, currentTeamRoute.pushUrl, currentTeamRoute.urlCwd);
  };
  // Two-way sync (read side): pull the private overlay's remote on startup, so THIS machine's
  // session sees memory captured on other machines/worktrees before we index — making the
  // overlay genuinely one source of truth. Remote calls are bounded; request-time failures
  // back off exponentially instead of freezing every tool on the same unavailable remote.
  const notePull = (status: HunchPullStatus, finishedAt: number): void => {
    ({ nextRemotePullAt, consecutivePullFailures } =
      pullBackoff(status, finishedAt, consecutivePullFailures));
  };
  const pullTeamMemory = (force = false): void => {
    if (!store.privateDir) return;
    const now = Date.now();
    if (!force && now < nextRemotePullAt) return;
    notePull(pullHunchStatus(store.privateDir, {
      timeoutMs: 5_000,
      remote: startupTeamRoute ?? advertisedTeamRemoteContract(root, join(store.privateDir, "..")),
    }), Date.now());
  };
  // A source stamp is acknowledged ONLY after a stable, successful rebuild. If
  // another process changes the atomic JSON tree during the rebuild, retry once;
  // continued churn leaves the marker unset so the next request tries again.
  const refreshIndex = (): void => {
    indexedSourceStamp = rebuildFreshIndex(store);
  };
  // Resolve the embedder ONCE for this long-lived process (never throws; null when
  // the optional model isn't installed). The model then loads lazily on the first
  // hunch_query and stays warm — and hybridSearch degrades to FTS until then.
  const embedderReady = selectEmbedder();

  const server = new McpServer({ name: "hunch", version: HUNCH_VERSION });
  let activeRequests = 0;
  let pendingRoot: string | null = null;
  let pendingScheduled = false;
  let closed = false;

  const activateRoot = (next: string): void => {
    // canonicalRootPath: a case/8.3 spelling difference must not read as a
    // DIFFERENT repo — that closed the live store and re-prepared everything
    // on every same-repo client connect (issue #54).
    const canonical = canonicalRootPath(findRoot(next));
    if (canonical === canonicalRootPath(root)) return;
    const prepared = prepareRoot(canonical, explicitOverlay, true);
    const previous = store;
    root = prepared.root;
    teamFile = prepared.teamFile;
    teamAdvertised = prepared.teamAdvertised;
    startupTeamConfig = prepared.startupTeamConfig;
    startupTeamRoute = prepared.startupTeamRoute;
    store = prepared.store;
    nextRemotePullAt = prepared.nextRemotePullAt;
    consecutivePullFailures = prepared.consecutivePullFailures;
    indexedSourceStamp = prepared.indexedSourceStamp;
    previous.close();
    console.error(`[hunch-mcp] serving Hunch at ${root} (client root)`);
  };

  const applyPendingRoot = (): void => {
    pendingScheduled = false;
    if (closed || activeRequests || !pendingRoot) return;
    const next = pendingRoot;
    pendingRoot = null;
    try {
      activateRoot(next);
    } catch (error) {
      console.error(`[hunch-mcp] client root change refused: ${(error as Error).message}`);
    }
  };

  const schedulePendingRoot = (): void => {
    if (closed || activeRequests || !pendingRoot || pendingScheduled) return;
    pendingScheduled = true;
    queueMicrotask(applyPendingRoot);
  };

  const setRoot = (next: string): void => {
    if (closed) throw new Error("MCP server is closed");
    const canonical = findRoot(next);
    if (canonical === root) {
      pendingRoot = null;
      return;
    }
    if (activeRequests) {
      pendingRoot = canonical;
      return;
    }
    pendingRoot = null;
    activateRoot(canonical);
  };

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    pendingRoot = null;
    store.close();
  };
  const underlyingClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    try {
      await underlyingClose();
    } finally {
      dispose();
    }
  };
  const priorOnClose = server.server.onclose;
  server.server.onclose = () => {
    dispose();
    priorOnClose?.();
  };

  // A long-lived MCP process is the team's ambient memory connection. Another clone may
  // capture and push a decision minutes after this process starts, so startup-only sync
  // leaves the assistant with a silently frozen graph until restart. Refresh at the tool
  // request boundary instead: Git serializes with capture flushes, and SQLite is rebuilt
  // only when the shared JSON source stamp changed. Unlike tracking only the HEAD returned
  // by this request's pull, the stamp also catches a sibling worktree that advanced the
  // overlay first and uncommitted atomic writes from another local Hunch process. This is
  // deterministic (unlike a timer/polling loop), client-agnostic, and remains best-effort
  // when the remote is offline. A one-second success cooldown coalesces bursty tool traffic;
  // failures back off to 30 seconds, while the local source stamp is still checked EVERY time.
  // Patch registration once so every present and future MCP tool gets the same boundary;
  // individual handlers cannot accidentally opt out and create split-brain behavior.
  type UntypedToolHandler = (...args: unknown[]) => unknown;
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    callback: UntypedToolHandler,
  ) => unknown;
  server.registerTool = ((name: string, config: unknown, callback: UntypedToolHandler) =>
    registerTool(name, config, async (...args: unknown[]) => {
      // Claude Code CLI never advertises `roots`/`roots/list_changed` for an agent-driven
      // `cd` or EnterWorktree (issue #20) — the cached `root` above just never moves, so a
      // write silently lands wherever the process was spawned. Write tools accept an
      // optional `cwd` argument (see cwdHintField) as a client-agnostic fallback: resolved
      // fresh on EVERY call instead of trusted from a cache, and re-homing this stdio
      // process the same way a `roots` notification would. Only safe when this is the
      // sole in-flight request — re-homing under a concurrent request would tear its
      // root/store out from under it, so that case is refused rather than risked.
      const cwdHint = extractCwdHint(args[0]);
      if (cwdHint !== undefined) {
        const target = canonicalRootPath(findRoot(cwdHint));
        if (target !== canonicalRootPath(root)) {
          if (activeRequests) {
            return err(
              `Hunch is mid-request against ${root} and cannot safely switch to the working directory you passed ` +
              `(resolves to ${target}) while another call is in flight. Retry this call once the other one completes.`,
            );
          }
          try {
            setRoot(cwdHint);
          } catch (error) {
            return err(`Failed to switch Hunch to your working directory (${cwdHint}): ${(error as Error).message}`);
          }
        }
      }
      activeRequests++;
      try {
        // Routing is live state, not a startup constant. A branch switch or
        // `hunch shared` can add/remove team.json while this stdio process remains
        // alive; serving the old store after that boundary would write the wrong
        // graph. Protocol-driven root swaps are prepared atomically and deferred
        // until this request count reaches zero, so every handler sees one stable
        // root/store/route epoch for its complete execution.
        const teamFileNow = !explicitOverlay && existsSync(teamFile);
        if (teamFileNow !== teamAdvertised) {
          return err("The committed team-memory routing changed after this MCP process started. Reconnect Hunch before reading or writing memory.");
        }
        const currentTeamConfig = teamFileNow ? readTeamConfig(root) : null;
        if (teamAdvertised && !matchesStartupTeamRoute()) {
          return err("The team-memory URL or branch changed after this MCP process started. Refusing the old graph; reconnect Hunch first.");
        }
        if (teamFileNow && (!currentTeamConfig
          || store.mode !== "shared"
          || !store.privateDir
          || !overlayMatchesTeamRemote(root, join(store.privateDir, "..")))) {
          return err("The committed team memory destination is invalid or no longer matches this process. Refusing the stale graph; reconnect Hunch first.");
        }
        if (store.mode === "shared" && store.privateDir) {
          try { pullTeamMemory(); } catch { /* offline / lock held / invalid remote — use local */ }
          // Recompute the full semantic + physical snapshot after the synchronous
          // network seam. A paired team.json/origin change can occur while fetch is
          // blocked; serving after that race would attach the old checkout to a new
          // destination even though the pull itself correctly refused.
          if (teamAdvertised && !matchesStartupTeamRoute()) {
            return err("The team-memory route changed during refresh. Refusing to serve a stale or redirected graph; reconnect Hunch first.");
          }
        }
        // Stamp check in EVERY mode, not only shared: a CLI capture or post-commit
        // hook in another terminal writes JSON that mtime-invalidated loadAll sees
        // immediately, while the SQLite FTS/graph index this long-lived process
        // serves would stay frozen at startup — split-brain answers within one
        // session (JSON-backed tools fresh, query/structure/dependents stale)
        // until restart (issue #49).
        try {
          if (store.sourceStamp() !== indexedSourceStamp) refreshIndex();
        } catch { /* corrupt/churning local source — serve the last durable indexed view */ }
        const result = await callback(...args);
        if (teamAdvertised && !matchesStartupTeamRoute()) {
          return err("The team-memory route changed while the tool was running. Its startup destination was not published; reconnect Hunch before retrying.");
        }
        return result;
      } finally {
        activeRequests--;
        schedulePendingRoot();
      }
    })) as typeof server.registerTool;

  // -- hunch_query ----------------------------------------------------------
  server.registerTool(
    "hunch_query",
    {
      title: "Query Hunch",
      description:
        "Full-text + graph search across the engineering memory (decisions, bugs, constraints, components, symbols). Returns ranked records with provenance. Use this to ask 'why' questions about the codebase.",
      inputSchema: { query: z.string().describe("A natural-language question or keywords.") },
    },
    async ({ query }): Promise<ToolResult> => {
      const hits = await store.hybridSearch(query, QUERY_HITS, { embedder: await embedderReady });
      if (!hits.length) return ok(`No matches for "${query}".`);
      const lines = hits.map((h) => {
        const r = store.resolve(h.ref);
        return `• [${h.kind}] ${h.ref} — ${h.title}\n    ${h.snippet}${provLine(r?.record)}`;
      });
      return ok(`Top matches for "${query}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_runbook --------------------------------------------------------
  server.registerTool(
    "hunch_runbook",
    {
      title: "Find a runbook for a task",
      description:
        "Look up the proven 'how-to' (ordered steps + files) for a recurring task — runbook-SCOPED retrieval (searches within runbooks, not the whole graph). Use at the START of a task to reuse a known procedure instead of re-deriving it. Advisory.",
      inputSchema: { task: z.string().describe("The task/intent, e.g. 'add an MCP tool' or 'cut a release'.") },
    },
    async ({ task }): Promise<ToolResult> => {
      const hits = await store.searchRunbooks(task, 5, { embedder: await embedderReady });
      if (!hits.length) return ok(`No runbook for "${task}" yet. Capture one with: hunch runbook <base>..<head> --task "${task}"`);
      const lines = hits.map((h) => {
        const r = store.resolve(h.ref)?.record as Runbook | undefined;
        if (!r) return `• ${h.ref} — ${h.title}`;
        const steps = r.steps.length ? `\n    steps: ${r.steps.map((s, i) => `${i + 1}. ${s}`).join("  ")}` : "";
        const files = r.files.length ? `\n    files: ${r.files.slice(0, 8).join(", ")}` : "";
        return `• ${r.id} — ${r.task}${steps}${files}${provLine(r)}`;
      });
      return ok(`Runbooks for "${task}" (advisory — a proven 'how', refine to fit):\n\n${lines.join("\n\n")}`);
    },
  );

  // -- hunch_why ------------------------------------------------------------
  server.registerTool(
    "hunch_why",
    {
      title: "Explain why a file/symbol is the way it is",
      description:
        "Return the decisions, bugs, and constraints that explain a file path or symbol — the 'why' and the 'what must not break', with evidence. Pass `as_of` (a commit/tag/branch) to time-travel: see what was believed at that point in history.",
      inputSchema: {
        target: z.string().describe("A file path (e.g. src/auth/session.ts) or symbol name."),
        as_of: z.string().optional().describe("Time-travel ref: a commit sha, tag, or branch (e.g. v0.7.0). Omit for the current view."),
      },
    },
    async ({ target, as_of }): Promise<ToolResult> => {
      const asOf = as_of ? asOfDate(as_of, root) : undefined;
      if (as_of && !asOf) return err(`Could not resolve as_of "${as_of}" to a commit.`);
      const w = store.why(target, { asOf });
      // Highest-signal first, then cap: invariants by severity, decisions by
      // confidence, bugs by severity — so a hot file's trim drops the tail, not
      // the records that matter most.
      const decisions = [...w.decisions].sort((a, b) => (b.provenance.confidence ?? 0) - (a.provenance.confidence ?? 0));
      const constraints = [...w.constraints].sort((a, b) => (SEV_CONSTRAINT[b.severity] ?? 0) - (SEV_CONSTRAINT[a.severity] ?? 0));
      const bugs = [...w.bugs].sort((a, b) => (SEV_BUG[b.severity] ?? 0) - (SEV_BUG[a.severity] ?? 0));
      const parts: string[] = [`Why for "${target}":`];
      if (decisions.length)
        parts.push(`\nDECISIONS:\n${decisions.slice(0, WHY_CAP).map((d) => `  • ${d.id} [${d.status}] ${d.title}\n      ${d.decision}${provLine(d)}`).join("\n")}${more(decisions.length, WHY_CAP, "narrow the target")}`);
      if (constraints.length)
        parts.push(`\nCONSTRAINTS (must not break):\n${constraints.slice(0, WHY_CAP).map((c) => `  • ${c.id} [${c.severity}] ${c.statement}${provLine(c)}`).join("\n")}${more(constraints.length, WHY_CAP)}`);
      if (bugs.length)
        parts.push(`\nBUG HISTORY:\n${bugs.slice(0, WHY_CAP).map((b) => `  • ${b.id} [${b.status}/${b.severity}] ${b.title}\n      root cause: ${b.root_cause}${provLine(b)}`).join("\n")}${more(bugs.length, WHY_CAP)}`);
      if (w.components.length) parts.push(`\nCOMPONENTS: ${w.components.map((c) => `${c.name} (${c.id})`).join(", ")}`);
      if (w.symbols.length) parts.push(`\nSYMBOLS: ${w.symbols.slice(0, WHY_CAP * 2).map((s) => `${s.name} [fan-in ${s.metrics.fan_in}, churn ${s.metrics.churn_90d}]`).join(", ")}${more(w.symbols.length, WHY_CAP * 2)}`);
      if (parts.length === 1) parts.push("\n(No recorded decisions/bugs/constraints yet for this target.)");
      return ok(parts.join("\n"));
    },
  );

  // -- hunch_bug_lineage ----------------------------------------------------
  server.registerTool(
    "hunch_bug_lineage",
    {
      title: "Find related bugs and their lineage",
      description:
        "Given a symptom description or a symbol, return matching bugs with their lineage (introduced → fixed → recurrence) so the agent doesn't re-discover past root causes.",
      inputSchema: { symptom_or_symbol: z.string().describe("A symptom description or a symbol/file.") },
    },
    async ({ symptom_or_symbol }): Promise<ToolResult> => {
      const bugs = store.bugLineage(symptom_or_symbol);
      if (!bugs.length) return ok(`No matching bugs for "${symptom_or_symbol}".`);
      const lines = bugs.map((b) => {
        const l = b.lineage;
        return `• ${b.id} [${b.status}/${b.severity}] ${b.title}\n    symptom: ${b.symptom}\n    root cause: ${b.root_cause}\n    lineage: introduced=${l.introduced_commit ?? "?"} fixed=${l.fixed_commit ?? "?"} recurrence_of=${l.recurrence_of ?? "—"} → decision=${l.spawned_decision ?? "—"} constraint=${l.spawned_constraint ?? "—"}${provLine(b)}`;
      });
      return ok(`Bugs related to "${symptom_or_symbol}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_check_constraints ---------------------------------------------
  server.registerTool(
    "hunch_check_constraints",
    {
      title: "Check invariants in scope",
      description:
        "Return constraints whose scope matches a glob/path, sorted by severity. Call this BEFORE editing code to avoid breaking intentional invariants.",
      inputSchema: { scope: z.string().describe("A path or glob, e.g. src/auth/** or src/auth/session.ts") },
    },
    async ({ scope }): Promise<ToolResult> => {
      const cons = store.checkConstraints(scope);
      if (!cons.length) return ok(`No constraints in scope "${scope}".`);
      const lines = cons.map((c) => `• ${c.id} [${c.severity}/${c.enforcement}] ${c.statement}\n    rationale: ${c.rationale}${provLine(c)}`);
      return ok(`Constraints affecting "${scope}":\n\n${lines.join("\n")}`);
    },
  );

  // -- hunch_get_dependents -------------------------------------------------
  server.registerTool(
    "hunch_get_dependents",
    {
      title: "Blast radius (transitive dependents)",
      description:
        "Return everything that transitively depends on a symbol/component (callers + dependent components) so a change's blast radius is known before editing.",
      inputSchema: { symbol: z.string().describe("A symbol id, symbol name, or file path.") },
    },
    async ({ symbol }): Promise<ToolResult> => {
      const matches = resolveSymbols(store, symbol);
      const ids = matches.length ? matches.map((s) => s.id) : [symbol];
      const all = new Map<string, { id: string; depth: number; via: string }>();
      for (const id of ids) for (const d of store.getDependents(id)) if (!all.has(d.id)) all.set(d.id, d);
      const deps = [...all.values()].sort((a, b) => a.depth - b.depth);
      if (!deps.length) return ok(`Nothing depends on "${symbol}" (leaf node, or not indexed).`);
      // Nearest dependents first (sorted by depth); cap the tail so a high-fan-in
      // symbol can't flood the session context.
      const lines = deps.slice(0, DEP_CAP).map((d) => `  • [depth ${d.depth}] ${d.via} (${d.id})`);
      return ok(`Blast radius of "${symbol}" — ${deps.length} dependent(s):\n${lines.join("\n")}${more(deps.length, DEP_CAP, "closest shown first")}`);
    },
  );

  // -- hunch_blast_radius (dependents + near-violations) --------------------
  server.registerTool(
    "hunch_blast_radius",
    {
      title: "Blast radius + near-violations for a file",
      description:
        "Given a file you're about to change, return its dependency blast radius (files whose code depends on it) AND any invariants reached THROUGH that radius — 'near-violations' you could break indirectly without touching their own scope. Call before editing a widely-depended-on file. Mirrors `hunch check --blast`.",
      inputSchema: { target: z.string().describe("A file path (e.g. src/auth/jwt.ts) or symbol.") },
    },
    async ({ target }): Promise<ToolResult> => {
      type Inv = ReturnType<HunchStore["checkConstraints"]>[number];
      const parts: string[] = [];
      for (const file of resolveFiles(store, target)) {
        const blast = store.blastRadiusFiles(file);
        const directIds = new Set(store.checkConstraints(file).map((c) => c.id));
        const near = new Map<string, { c: Inv; via: string }>();
        for (const b of blast) {
          for (const c of store.checkConstraints(b.file)) {
            if (directIds.has(c.id) || near.has(c.id)) continue;
            near.set(c.id, { c, via: `${b.file} (${b.via}, depth ${b.depth})` });
          }
        }
        const blastBody = blast.length
          ? `:\n${blast.slice(0, DEP_CAP).map((b) => `  • [depth ${b.depth}] ${b.file} (via ${b.via})`).join("\n")}${more(blast.length, DEP_CAP, "closest first")}`
          : "";
        const nearArr = [...near.values()];
        const nearBody = nearArr.length
          ? `\n  NEAR-VIOLATIONS (invariants reachable via this radius — review before editing):\n${nearArr.map((n) => `    ⚠ ${n.c.id} [${n.c.severity}] ${n.c.statement}\n        via ${n.via}`).join("\n")}`
          : "\n  No invariants in the blast radius.";
        parts.push(`${file} → ${blast.length} dependent file(s)${blastBody}${nearBody}`);
      }
      return ok(`Blast radius for "${target}":\n\n${parts.join("\n\n")}`);
    },
  );

  // -- hunch_context (surgical retrieval) -----------------------------------
  server.registerTool(
    "hunch_context",
    {
      title: "Assemble the minimal relevant Hunch slice for a task",
      description:
        "Given a file, symbol, or task phrase you're about to work on, return the MINIMAL relevant memory — invariants to preserve, decisions explaining the design, bug history not to reintroduce, and the blast radius — as a compact brief. Call this FIRST when starting work on something. A task phrase that resolves to no file/symbol falls back to the closest graph matches.",
      inputSchema: {
        target: z.string().describe("A file path, symbol, or task phrase you're about to work on."),
        budget_tokens: z.number().optional().describe("Rough token budget for the brief (default 1500)."),
        as_of: z.string().optional().describe("Time-travel ref (commit/tag/branch): assemble the slice as it stood then."),
      },
      outputSchema: DELIVERY_OUTPUT_SCHEMA,
    },
    async ({ target, budget_tokens, as_of }, extra): Promise<ToolResult> => {
      const asOf = as_of ? asOfDate(as_of, root) : undefined;
      if (as_of && !asOf) return err(`Could not resolve as_of "${as_of}" to a commit.`);
      const ctx = store.assembleContext(target, budget_tokens ?? 1500, { asOf });
      const options = {
        root,
        symbols: store.recs("symbols"),
        components: store.recs("components"),
        decisionCorpus: store.recs("decisions"),
        historical: !!asOf,
      };
      // Task-phrase input ("improve retrieval ranking") resolves no file/symbol and
      // used to return an empty brief while the graph held the answer — fall back to
      // FTS so the assistant always leaves with the closest matches, not a shrug.
      const empty = !ctx.constraints.length && !ctx.decisions.length && !ctx.bugs.length && !ctx.blast_radius.length;
      if (empty && !asOf) {
        const hits = store.search(target, 8);
        if (hits.length) {
          const resolved = hits.map((hit) => ({ hit, record: store.resolve(hit.ref)?.record }));
          const fallback = {
            ...ctx,
            constraints: resolved.filter(({ hit, record }) => hit.kind === "constraints" && !!record).map(({ record }) => record) as typeof ctx.constraints,
            decisions: resolved.filter(({ hit, record }) => hit.kind === "decisions" && !!record).map(({ record }) => record) as typeof ctx.decisions,
            bugs: resolved.filter(({ hit, record }) => hit.kind === "bugs" && !!record).map(({ record }) => record) as typeof ctx.bugs,
            findings: resolved.filter(({ hit, record }) => hit.kind === "findings" && !!record).map(({ record }) => record) as typeof ctx.findings,
          };
          const envelope = buildDeliveryEnvelope(fallback, {
            ...options,
            supplements: hits
              .filter((hit) => !["constraints", "decisions", "bugs", "findings"].includes(hit.kind))
              .map((hit, index) => ({
                id: hit.ref,
                kind: `search-${hit.kind}`,
                text: `${hit.ref} — ${hit.title}: ${hit.snippet}`,
                priority: 100 - index,
              })),
          });
          return deliveredContext(root, target, envelope, extra.sessionId);
        }
      }
      const envelope = buildDeliveryEnvelope(ctx, options);
      return deliveredContext(root, as_of ? `${target} (as_of:${as_of})` : target, envelope, extra.sessionId);
    },
  );

  // -- hunch_now (the hot view: recent activity + roadmap) --------------------
  // PUBLIC store only, per dec_29eff08c69's jurisdiction rule: an assistant may
  // paste this anywhere, so it must be publishable by construction. Union view
  // stays behind `hunch now --private` on the local terminal.
  server.registerTool(
    "hunch_now",
    {
      title: "Recent activity + the roadmap (the hot view)",
      description:
        "What just happened and what's next, straight from the graph: the last N decisions (any status — a supersession IS activity) and the ROADMAP (every live human-vouched PROPOSED decision). Call at session start to orient, or before planning what to work on. Same data as the wiki's now.md. Public store only.",
      inputSchema: {
        recent_limit: z.number().optional().describe("How many recent decisions to include (default 10)."),
      },
    },
    async ({ recent_limit }): Promise<ToolResult> => {
      const { recent, roadmap, pendingReview } = nowData(store.json.loadAll("decisions"), recent_limit ?? 10);
      const L: string[] = [`🔥 Recent (${recent.length}):`];
      for (const r of recent) L.push(`  ${r.date} [${r.status}] ${r.title} (${r.id}${r.topic ? `, ${r.topic}` : ""})`);
      L.push("", `🗺 Roadmap — live proposed decisions (${roadmap.length}):`);
      if (!roadmap.length) L.push("  (empty — record intent as a PROPOSED decision and it appears here)");
      for (const r of roadmap) L.push(`  • ${r.title} (${r.id}${r.topic ? `, ${r.topic}` : ""}, since ${r.date})\n      ${r.note}`);
      if (pendingReview > 0) L.push("", `${pendingReview} legacy un-vouched draft(s) — \`hunch adopt-drafts\` auto-trusts them as advisory (new captures land trusted automatically).`);
      const escalations = pendingEscalations(store.advisoryRecs("decisions"));
      escalations.push(...premiseEscalations(store.advisoryRecs("decisions"), { now: new Date().toISOString(), exists: (p) => existsSync(join(root, p)) }));
      if (escalations.length) {
        L.push("", `⚖ ${escalations.length} decision(s) need the human's call — ASK inline (never queue): ${escalations.map((e) => e.question).join(" · ")}`);
      }
      return ok(L.join("\n"));
    },
  );

  // -- hunch_escalations (the inline "ask the human" surface) -----------------
  // Captured memory auto-trusts; this returns ONLY what the graph can't resolve
  // itself, framed as questions to raise in conversation: topic conflicts, plus the
  // Constitution's human moments (a candidate awaiting review, a proposed policy
  // whose activation is a human call — §59.5.3). Public store only — same
  // jurisdiction rule as hunch_now (an assistant may paste it). Client-agnostic
  // (con_e04226bd05): no Claude-specific behavior.
  server.registerTool(
    "hunch_escalations",
    {
      title: "Decisions the human must make now (ask inline, not a queue)",
      description:
        "The rare decisions the graph cannot resolve on its own — surfaced so you ASK THE USER in the prompt at the moment, then act. Auto-captured memory is trusted automatically and never appears here; this returns topic conflicts (>1 live decision for one topic), premise-stale decisions (a live decision whose recorded REASON no longer holds — its authority is unchanged until the human re-attests, supersedes, or retires), and Constitution human moments (candidate policies awaiting review, proposed policies awaiting an activation decision). Normally empty. Raise each question with the user; do NOT decide it for them — an entry is a question, never an approval. Reads the public store, or the unified overlay when the repo is in shared mode (where the overlay IS the store) — never private-mode overlay records.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const items: Escalation[] = pendingEscalations(store.advisoryRecs("decisions"));
      // Premise decay: a live decision whose recorded reason died. Question-framed
      // like every entry here — authority never changes until the human answers.
      items.push(...premiseEscalations(store.advisoryRecs("decisions"), { now: new Date().toISOString(), exists: (p) => existsSync(join(root, p)) }));
      try {
        items.push(...policyEscalations(new ConstitutionService(store, root).list({ publicOnly: true }).map((p) => ({ ...p, last_action: p.audit.at(-1)?.action ?? null }))));
      } catch { /* constitution unavailable — memory escalations still surface */ }
      if (!items.length) return ok("✓ Nothing needs a human decision — memory is auto-trusted and self-consistent.");
      const L = [`${items.length} decision(s) need the human's call — ask each inline, don't decide it for them:`, ""];
      for (const e of items) {
        L.push(`⚖ ${e.question}`);
        L.push(`   ${e.detail}`);
        L.push(`   → ${e.resolution}`, "");
      }
      return ok(L.join("\n"));
    },
  );

  // -- hunch_wiki_status (generated-wiki freshness) ---------------------------
  server.registerTool(
    "hunch_wiki_status",
    {
      title: "Freshness of the generated wiki (public home)",
      description:
        "Which generated wiki pages are fresh vs stale (graph moved, source doc changed, hand-edited), plus the specs ledger's doc grades. Call before trusting wiki pages or when deciding whether `hunch wiki --heal` is needed. Public home only — the private overlay wiki is a local concern.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const home = publicHome(root);
      if (!readWikiManifestAt(home.manifestPath)) return ok("No wiki adopted in this repo (no wiki manifest). Generate one with `hunch wiki`.");
      const s = wikiStatus(store, home, root);
      const stale = [...s.entries.filter((e) => e.state !== "fresh").map((e) => `${e.page} — ${e.reason || e.state}`),
        ...(s.specs.state !== "fresh" ? [`${s.specs.page} — doc grade snapshot moved`] : []),
        ...(s.now.state !== "fresh" ? [`${s.now.page} — activity/roadmap moved`] : []),
        ...(s.index.state !== "fresh" ? [`${s.index.page} — index inputs moved`] : []),
        ...s.adoptions.filter((a) => a.state !== "fresh").map((a) => `${a.page} — adopted copy of ${a.doc.rel} (${a.state})`)];
      const grades = { grounded: s.docs.filter((d) => d.status === "grounded").length, stale: s.docs.filter((d) => d.status === "stale").length, unverified: s.docs.filter((d) => d.status === "unverified").length };
      const head = `Wiki "${home.dir}/": ${s.entries.length} component page(s), ${s.adoptions.length} adopted doc(s). Docs graded: ${grades.grounded} grounded / ${grades.stale} stale / ${grades.unverified} unverified.`;
      if (!stale.length && !s.orphans.length && !s.adoptionOrphans.length) return ok(`${head}\n✓ Everything fresh.`);
      const orphans = [...s.orphans, ...s.adoptionOrphans].map((p) => `${p} — orphaned (heal removes it)`);
      return ok(`${head}\n${[...stale, ...orphans].map((l) => `· ${l}`).join("\n")}\nHeal: \`hunch wiki --heal\`.`);
    },
  );

  // -- hunch_timeline (decision history) ------------------------------------
  server.registerTool(
    "hunch_timeline",
    {
      title: "The decision history for a file/symbol",
      description:
        "Time-travel: the decisions touching a file/symbol over time — what was believed, its valid-time window, and what superseded it. Use to understand how (and why) the design changed, and to avoid re-introducing a deliberately-retired approach.",
      inputSchema: { target: z.string().describe("A file path or symbol name.") },
    },
    async ({ target }): Promise<ToolResult> => {
      const tl = store.timeline(target);
      if (!tl.length) return ok(`No decision history for "${target}" yet.`);
      const lines = tl.map((d) => {
        const from = (d.valid_from ?? d.date).slice(0, 10);
        const window = d.valid_to ? `${from} → ${d.valid_to.slice(0, 10)}` : `${from} → now`;
        const sup = d.superseded_by ? ` (superseded by ${d.superseded_by})` : "";
        return `  • ${d.id} [${d.status}] (${window})${sup}\n      ${d.title}`;
      });
      return ok(`Decision timeline for "${target}" (newest first):\n${lines.join("\n")}`);
    },
  );

  // -- hunch_capture_decision (decision-grounding: the grilling front door) --
  server.registerTool(
    "hunch_capture_decision",
    {
      title: "Capture a decision (grilling interview)",
      description:
        "Start a decision-capture interview: returns the grilling protocol (interrogate ONE question at a time until the decision tree is resolved) plus a capture-session token. Grill the human, then commit via hunch_record_decision with the token + confirmed topic. Use for '/capture', 'record this decision', 'grill me on this'. The token proves the write is the tail of an interview, not a silent guess.",
      inputSchema: {
        topic: z.string().optional().describe("proposed topic anchor (confirm with the human before committing)"),
        seed: z.string().optional().describe("what the decision is about, to focus the first question"),
        deciding: z.boolean().optional().describe("the choice is NOT yet made — prepend the verdict loop (candidates → evidenced attacks → convergence → tripwires) so alternatives_rejected come from attacks that actually ran, then grill and record as usual"),
      },
    },
    async ({ topic, seed, deciding }): Promise<ToolResult> => {
      const token = issueCaptureToken();
      return ok(`${grillingProtocol(topic, token, !!deciding)}${seed ? `\n\nSeed: ${seed}` : ""}`);
    },
  );

  // -- hunch_current_decision (decision-grounding: current(topic)) ----------
  server.registerTool(
    "hunch_current_decision",
    {
      title: "Current decision for a topic",
      description:
        "Decision-grounding: return the single CURRENT (accepted, non-superseded) decision anchored to a topic — the authoritative answer a doc or diff is checked against, plus what it rejected. If a topic has NO current decision, or an unresolved collision (>1 live), it says so and injects nothing (fail-safe).",
      inputSchema: { topic: z.string().describe("the decision anchor, e.g. 'auth-transport'") },
    },
    async ({ topic }): Promise<ToolResult> => {
      const decs = store.recs("decisions");
      const live = liveForTopic(decs, topic);
      if (live.length === 0) return ok(`No current decision for topic "${topic}". (Un-anchored, or never captured.)`);
      if (live.length > 1) {
        const list = live.map((d) => `${d.id} ("${d.title}")`).join(", ");
        return ok(`Topic "${topic}" has an UNRESOLVED collision (${live.length} live decisions): ${list}.\nGrounding injects nothing until this is resolved — supersede one, or split the topic.`);
      }
      const d = live[0]!;
      const rejected = rejectedForTopic(decs, topic);
      const rej = rejected.length ? `\n    rejected: ${rejected.join("; ")}` : "";
      const hist = historyForTopic(decs, topic);
      const chain = hist.length > 1 ? `\n    history: ${hist.length} decisions on this topic (current is newest)` : "";
      return ok(`Current decision for "${topic}": ${d.id} — "${d.title}" (${d.status}).\n    ${d.decision}${rej}${chain}${provLine(d)}`);
    },
  );

  // -- hunch_record_decision (write-back) -----------------------------------
  server.registerTool(
    "hunch_record_decision",
    {
      title: "Record a decision (write-back)",
      description:
        "Persist a new Decision (ADR) into Hunch with provenance. Use after making a non-trivial design choice so future sessions are grounded in it. Set private:true to keep a SENSITIVE decision out of a (possibly public) repo — it is written to the HUNCH_PRIVATE_DIR overlay store and stays queryable locally, never committed here.",
      inputSchema: {
        decision: z.object({
          title: z.string(),
          context: z.string().optional(),
          decision: z.string().optional(),
          consequences: z.array(z.string()).optional(),
          alternatives_rejected: z.array(z.string()).optional(),
          related_files: z.array(z.string()).optional(),
          related_components: z.array(z.string()).optional(),
          topic: z.string().optional().describe("decision-grounding anchor — one topic per decision; enables doc≠graph drift detection for it. Omit to leave un-anchored."),
          // FLAT, matching PremiseSchema exactly. A nested { check: {...} } shape is
          // silently STRIPPED by Zod, leaving a claim-only premise — and a claim-only
          // premise is "documented only (no check attached)", which ALWAYS HOLDS. An
          // agent following a wrong schema would record a premise that can never fire:
          // the exact fail-open this feature exists to prevent. Keep in lockstep with
          // PremiseSchema in src/core/types.ts.
          premises: z.array(z.object({
            claim: z.string().min(1).describe("the human-readable reason this decision rests on"),
            path_absent: z.string().optional().describe("premise holds while this repo-relative path does NOT exist. REQUIRES `under`. Prefer path_exists where you can — a negative probe fails OPEN, a positive one fails closed."),
            under: z.string().optional().describe("required with path_absent: an EXISTING repo-relative ANCESTOR of it (path_absent 'src/gateway' -> under 'src'). When the anchor disappears the premise reads unevaluable instead of silently 'still absent'."),
            path_exists: z.string().optional().describe("premise holds while this repo-relative path exists"),
            review_by: z.string().optional().describe("dated attestation: premise holds until this ISO date, then needs re-attesting"),
            attested: z.string().optional().describe("ISO date a human last attested the claim (informational)"),
          })).optional().describe("the checkable reasons this decision rests on — at most ONE check per premise (path_absent | path_exists | review_by). A dead premise NEVER changes authority; it raises an escalation for the human. Omit on re-record to keep the incumbent's premises."),
          status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
          commit: z.string().optional(),
          supersedes: z.string().optional().describe("id of a decision this one replaces — closes its valid-time window (invalidate, don't delete)"),
          private: z.boolean().optional().describe("write into the PRIVATE overlay store (HUNCH_PRIVATE_DIR) instead of the committed repo — for sensitive decisions kept out of a public repo. Errors if no private store is configured."),
        }),
        capture_token: z.string().optional().describe("token from hunch_capture_decision — proves this write is the tail of a grilling interview. Omit only for a quick manual record (a deprecation nudge is returned)."),
        cwd: cwdHintField,
      },
    },
    async ({ decision, capture_token }): Promise<ToolResult> => {
      try {
        // Commit-keyed on the CANONICAL full sha (resolved via git rev-parse), so a
        // human passing the short sha they see in `commit` produces the SAME id as
        // the auto-sync path (which keys on the full sha) — UPGRADING the auto-draft
        // instead of duplicating it. If the ref can't be resolved to a real full
        // sha, fall back to the title/manual namespace so we never key on a raw,
        // unverified string that could collide with (or orphan) a real commit id.
        const resolved = decision.commit ? revParse(decision.commit, root) : null;
        const fullSha = resolved && /^[0-9a-f]{40}$/.test(resolved) ? resolved : null;
        const id = fullSha ? decisionId(fullSha) : decisionId(`manual:${decision.title}`);

        // Preserve the ADR lineage from the SAME home this write will use. A private
        // re-record must retain its own optional fields, but must never inherit a
        // same-id public record (and vice versa).
        const home = store.captureHome(!!decision.private);
        const existing = home === "private" ? store.getPrivateRec("decisions", id) : store.json.get("decisions", id);
        // A commit-keyed id intentionally lets a human capture upgrade the machine draft
        // for that commit. Once the slot is human-confirmed, however, a differently
        // identified decision must never reuse it: that would silently replace the first
        // ADR while reporting success (issue #23). Topic is the canonical identity when
        // both sides have one; otherwise a matching title permits anchoring/refining the
        // same record without blocking the existing draft-upgrade contract.
        const sameHumanIdentity = existing?.topic && decision.topic
          ? decision.topic === existing.topic
          : existing?.title === decision.title;
        // CURATED slots are overwrite-protected, not just human-confirmed ones:
        // agent_recorded testimony carries session content a silent replace would
        // destroy (issue #23's harm, one tier down). Only regenerable machine
        // drafts (llm_draft/inferred synthesis, deterministically re-derivable
        // from the commit) stay upgradeable by a different identity. Same-identity
        // re-record remains the countersign/refine path for every tier.
        const curated = ["human_confirmed", "agent_recorded"].some((t) => existing?.provenance.source.split("+").includes(t));
        // AUTHORSHIP STAMP (memory supply chain): only a consumed capture token — proof a
        // grilling interview preceded this write — mints human_confirmed. Any agent can
        // CALL this tool mid-session, possibly steered by untrusted content it read;
        // "the human probably asked me to" is testimony, not a signature.
        //
        // Resolved HERE, before the overwrite guard, because the guard's answer depends on
        // it: testimony must yield to a signature. (Consuming before a possible refusal
        // burns the token, which is the safe direction — a re-run of /capture mints another.)
        const gated = consumeCaptureToken(capture_token);
        const existingTiers = existing?.provenance.source.split("+") ?? [];
        const existingIsHuman = existingTiers.includes("human_confirmed");
        // A slot held only by AGENT TESTIMONY must not block a later human capture — the
        // stamp's own contract says so ("never lock the id slot against a later human
        // capture"), but including agent_recorded in `curated` did exactly that. A
        // human_confirmed slot stays protected as before (issue #23): a signature is never
        // displaced by a differently-identified record, vouched or not.
        const conflictsWithHuman = curated && !sameHumanIdentity && !(gated && !existingIsHuman);
        if (conflictsWithHuman) {
          return err(
            `Decision id ${id} already identifies a different curated decision: ` +
            `"${existing!.title}"${existing!.topic ? ` (topic "${existing!.topic}")` : ""}. ` +
            `Refusing to overwrite it with "${decision.title}"${decision.topic ? ` (topic "${decision.topic}")` : ""}. ` +
            "Record the additional decision without commit, or reuse the incumbent topic/title when refining the same decision.",
          );
        }
        // Un-token'd writes land as agent_recorded: fully functional advisory memory that
        // never carries human authority (strict/veto gates key on human_confirmed) and
        // surfaces with a testimony marker. Re-record through /capture to countersign.
        //
        // A signature already on this slot is INHERITED, never erased. The un-token'd path
        // is exactly what the nudge below tells an agent to do ("re-record… supersedes"),
        // and the tier expression preserved `llm_draft` while dropping `human_confirmed` —
        // so an un-vouched agent write silently stripped human authority from a decision a
        // human had vouched for. That inverts the whole point of the stamp: it exists to
        // stop an agent CLAIMING human authority, not to let one DESTROY it. Downgrading a
        // signature is a human act (`hunch review --reject`, or supersede via /capture).
        const tier = gated || existingIsHuman ? "human_confirmed" : "agent_recorded";
        const source = existing && existing.provenance.source.includes("llm_draft")
          ? `llm_draft+${tier}`
          : tier;
        const now = new Date().toISOString();

        const rec: Decision = {
          id,
          title: decision.title,
          topic: decision.topic ?? existing?.topic ?? null,
          status: decision.status ?? "accepted",
          context: decision.context ?? existing?.context ?? "",
          decision: decision.decision ?? existing?.decision ?? "",
          consequences: decision.consequences ?? [],
          alternatives_rejected: decision.alternatives_rejected ?? [],
          rejected_tripwires: existing?.rejected_tripwires ?? [], // preserve confirmed tripwires across re-record
          // Premises survive a re-record for the same reason tripwires do. Rebuilding the
          // record field-by-field WITHOUT them silently deleted the decision's recorded
          // reasons — so the escalation for a dead premise stopped firing while the
          // decision kept full authority, and nothing reported the loss. That is the exact
          // fail-open premise decay exists to prevent, relocated from the evaluator to the
          // writer — and the escalation's own advice ("re-attest… or re-record") walked
          // straight into it. Caller-supplied premises win; otherwise the incumbent's carry.
          premises: decision.premises ?? existing?.premises ?? [],
          related_components: decision.related_components ?? existing?.related_components ?? [],
          related_files: (decision.related_files ?? existing?.related_files ?? []).map(toPosixTarget),
          supersedes: decision.supersedes ?? existing?.supersedes ?? null,
          superseded_by: existing?.superseded_by ?? null,
          caused_by_bug: existing?.caused_by_bug ?? null,
          commit: decision.commit ?? existing?.commit ?? null,
          valid_from: existing?.valid_from ?? now,
          valid_to: existing?.valid_to ?? null,
          retired: existing?.retired ?? { symbols: [], deps: [] },
          provenance: { source, confidence: gated ? 0.95 : 0.75, evidence: (decision.related_files ?? existing?.provenance.evidence ?? []).map(toPosixTarget) },
          date: now,
        };
        // Where this write will actually land (see captureHome). Resolved BEFORE the
        // uniqueness guard: in unified ("shared") mode home is the overlay even when
        // private:false, so the guard must key its incumbent lookup on HOME, not on
        // the flag — keying on the flag let a shared-mode supersede of a public
        // incumbent pass the guard and then no-op the close (two live decisions).
        // Decision-grounding uniqueness guard (§4 Enforcement): never create a SECOND
        // live decision for one topic. Exclude ONLY the incumbent this write will
        // actually close — one resolvable in the SAME store the write lands in. A
        // cross-store supersede (the incumbent lives where this write can't close it)
        // would no-op and leave two live decisions, so it is treated as unresolved
        // (willClose=null) → the guard fires and refuses. Same-id re-record is allowed.
        if (rec.topic && rec.status === "accepted") {
          const willClose = decision.supersedes && store.decisionInStore(decision.supersedes, home === "private")
            ? decision.supersedes
            : null;
          const others = captureConflicts(store.recs("decisions"), rec.topic, id, willClose);
          if (others.length) {
            const list = others.map((d) => `${d.id} ("${d.title}")`).join(", ");
            const crossStore = decision.supersedes && !willClose
              ? ` (note: supersedes:"${decision.supersedes}" is not in the ${home} store this write lands in, so it can't be closed from here)`
              : "";
            return err(
              `Topic "${rec.topic}" already has a live decision: ${list}.${crossStore} ` +
                `Hunch will not create a second current decision for one topic. Resolve it: ` +
                `re-record with supersedes:<id> to replace it (linked, same store), pick a distinct topic to split, or discard this capture.`,
            );
          }
        }
        // Route the write to its ONE home: an explicit private:true goes to the overlay
        // (putPrivate throws rather than silently falling public); in unified ("shared")
        // mode EVERY capture goes to the overlay; else the public store.
        // Through putCapture, NOT the raw per-home writers: it carries the cross-home
        // twin guard. Branching on `home` here bypassed that guard, so one id could
        // exist in BOTH stores — after which the merged/private-first read makes the
        // topic-uniqueness check see one record while a later public `supersedes:`
        // closes the other, leaving two live decisions on one topic and grounding
        // silently injecting nothing for it. The guard throws; the surrounding catch
        // turns that into a clean tool error instead of a silent twin.
        store.putCapture("decisions", rec, !!decision.private);
        // Invalidate, don't delete: closing the superseded decision's valid-time window
        // (+ a supersedes edge) preserves the why-it-changed trail. Route the close to the
        // same store the new record landed in — a private decision supersedes within the
        // private overlay; a public one in the committed store. A private write never
        // mutates the public store.
        const superseded = decision.supersedes
          ? (home === "private" ? store.supersedePrivate(decision.supersedes, rec) : store.supersede(decision.supersedes, rec))
          : null;
        store.reindex();
        // Auto-flush the store the record landed in (on by default in every mode): a private
        // record commits+pushes its overlay repo; a public one commits .hunch/ in THIS repo
        // (commit only — it rides the user's next push, never auto-pushing their code branch).
        const flush = flushCapture(store, hunchPaths(root).hunch, !!decision.private, `hunch: capture ${id}`, startupTeamRoute ?? undefined);
        const flushed = flushNote(flush, home, store.mode) + publicHomeNote(home, store.hasPrivate, rec, hunchPaths(root).hunch);
        // Capture-session gate (staged deprecation, §9.3): the token was consumed
        // above (it also decides the provenance tier). No token still writes
        // (non-breaking) but lands as agent_recorded with a nudge toward /capture.
        // A token presented but unknown to THIS process (server restart/expiry) is
        // not shamed — but it also cannot be VERIFIED, so the record still lands
        // agent_recorded with a note saying how to countersign.
        const captureNote = gated
          ? " [via capture front door]"
          : capture_token
            ? `\n\nℹ The capture token could not be verified (server restart or expiry), so this record is stamped agent_recorded. Re-record through hunch_capture_decision → hunch_record_decision to countersign it as human_confirmed.`
            : `\n\n⚠ Recorded WITHOUT a capture interview — the record stands as agent_recorded TESTIMONY (advisory: it never carries human authority; a /capture interview on the same topic/title countersigns it). Harden it NOW in one exchange instead of switching flows: answer the first grilling question directly — "What alternative did you seriously consider and reject for '${rec.title.slice(0, 60)}', and what breaks if a future session re-introduces it?" — then fold the answer into alternatives_rejected via a /capture interview (hunch_capture_decision → hunch_record_decision(supersedes: ${id})), which countersigns the record as human_confirmed. (A future major version will require a capture token here.)`;
        // Quality nudge only when the untokened deprecation nudge isn't already
        // grilling — one advisory voice per response, never two.
        const quality = gated || capture_token ? qualityNudge(rec) : "";
        const supNote = superseded ? ` Superseded ${superseded.id} (window closed at ${rec.valid_from}).` : "";
        const note = decision.commit && !fullSha ? ` (note: commit "${decision.commit}" could not be resolved — recorded as a standalone decision, not linked to a commit)` : "";
        const where = decision.private
          ? ` [PRIVATE overlay — not committed to this repo]${flushed}`
          : home === "private" ? ` [SHARED store — one source of truth for the whole team]${flushed}` : flushed;
        const dest = destinationNote(resolveDestRoot(home, store, root));
        return ok(`Recorded decision ${id}: "${rec.title}" (status ${rec.status}, ${source}).${where}${dest}${supNote}${note}${captureNote}${quality}`);
      } catch (e) {
        return err(`Failed to record decision: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_record_correction (write-back: "Never Twice") ------------------
  server.registerTool(
    "hunch_record_correction",
    {
      title: "Capture a correction as an enforced constraint (Never Twice)",
      description:
        "When a human corrects the agent ('no, do it this way' / 'never call X here'), persist that correction as a first-class, SCOPED Constraint with provenance — so the pre-edit hook and the CI Constraint Guard hold EVERY assistant to it from now on, instead of it being forgotten next session. Writes to the shared .hunch/ graph (client-agnostic). Set severity:'blocking' only when the human said never/must; set applies_to_all:true only when the rule is genuinely repo-wide (otherwise it is scoped to scope_hint_file).",
      inputSchema: {
        rule: z.string().describe("The invariant in the human's words, e.g. \"never call the pay-per-token API here\"."),
        scope_hint_file: z.string().optional().describe("A file the correction was about; scopes the constraint to it (the conservative default). Prefer a REPO-RELATIVE path (src/foo.ts); an absolute path is relativized against the repo root, and one outside the repo is discarded rather than scoped to a path that could never match."),
        severity: z.enum(["advisory", "warning", "blocking"]).optional().describe("Default 'warning'. Use 'blocking' only for a hard never/must rule."),
        applies_to_all: z.boolean().optional().describe("True ONLY if the rule is genuinely repo-wide (scopes to **); required to make a repo-wide rule blocking."),
        type: z.enum(["security", "performance", "correctness", "architecture", "compliance"]).optional(),
        rationale: z.string().optional().describe("Why it must hold."),
        source_decision: z.string().optional().describe("id of a decision this correction derives from."),
        private: z.boolean().optional().describe("write into the PRIVATE overlay store (HUNCH_PRIVATE_DIR) instead of the committed repo — a sensitive rule enforced locally (pre-edit hook + local check) but never exposed in a public PR comment. Errors if no private store is configured."),
        capture_token: z.string().optional().describe("token from hunch_capture_decision. The rule is recorded and enforced either way — the token only decides whether it may DENY: without one it lands as advisory testimony capped at severity 'warning'."),
        cwd: cwdHintField,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        if (!input.rule || !input.rule.trim()) return err("rule is required — state the invariant in plain words.");
        // root: relativizes an ABSOLUTE scope_hint_file. Agents naturally send absolute
        // paths (edit-tool payloads and MCP roots are absolute) and every consumer matches
        // repo-relative — without this the rule would be blocking-but-inert and would leak
        // the local filesystem path into the committed graph.
        // Same authorship tier as hunch_record_decision: a consumed token mints the
        // signature, an un-token'd write is testimony. Here the stakes are HIGHER — a
        // blocking constraint DENIES edits, so an un-vouched write is capped at
        // "warning" rather than being refused. Never Twice still lands immediately.
        const vouched = consumeCaptureToken(input.capture_token);
        const rec = buildCorrectionConstraint({ ...input, knownDeps: knownRepoDeps(root), root, vouched }, new Date().toISOString());
        // Private corrections go to the overlay (enforced locally via the merged read,
        // never rendered into the public CI comment, which is public-only by construction).
        const home = store.captureHome(!!input.private);
        if (home === "public" && rec.source_decision && !store.json.get("decisions", rec.source_decision)) {
          const location = store.getPrivateRec("decisions", rec.source_decision) ? "exists only in the private overlay" : "does not exist in the public home";
          return err(`Refusing to record public correction ${rec.id}: source decision ${rec.source_decision} ${location}.`);
        }
        const existing = home === "private" ? store.getPrivateRec("constraints", rec.id) : store.json.get("constraints", rec.id);
        // Same cross-home twin guard as the decision path above.
        store.putCapture("constraints", rec, !!input.private);
        store.reindex();
        // Propagate the new rule to EVERY assistant's ambient grounding (Cursor/Copilot/
        // Windsurf/AGENTS.md/CLAUDE.md), so a correction captured in one assistant is held
        // by all of them. Public only — a private rule must never render into committed
        // grounding. Refresh-only: it never scaffolds a doc the project opted out of.
        // Auto-commit refreshes and stages git-clean grounding inside flushCapture.
        // Pre-refreshing would make those paths dirty first, causing the clean-path
        // selector to skip them and leave successful captures with stale HEAD plus
        // dirty AGENTS/assistant docs. Manual mode still refreshes in place.
        if (home === "public" && !store.autoCommit) refreshExistingGrounding(root, store); // overlay rules never render into committed grounding
        const flush = flushCapture(store, hunchPaths(root).hunch, !!input.private, `hunch: capture ${rec.id}`, startupTeamRoute ?? undefined);
        const flushed = flushNote(flush, home, store.mode) + publicHomeNote(home, store.hasPrivate, rec, hunchPaths(root).hunch);
        const enforce = rec.severity === "blocking"
          ? "blocks a DIRECT edit to its scope at strict firmness, and fails a PR whose diff touches that scope (CI guard); blast-radius hits and lower firmness stay advisory"
          : "flags violating edits and PRs (advisory)";
        const where = input.private
          ? ` [PRIVATE overlay — not committed to this repo]${flushed}`
          : home === "private" ? ` [SHARED store — one source of truth for the whole team]${flushed}` : flushed;
        // The Constraint itself is the durable retry queue. Normal `hunch index`
        // and post-commit sync rescan it; no in-process timer can be lost on exit.
        const reviewNote = "\n\nREVIEW PENDING: After the fix is committed, run hunch index; an installed post-commit hook retries this automatically on the fixing commit. Only the supported static ESM import-declaration package projection is eligible, and it remains activation-blocked; the immediate guard is already durable.";
        // Say plainly which tier this landed in. A silent downgrade would be its own
        // dishonesty: the caller asked for "blocking" and must be told it is not.
        const tierNote = vouched
          ? ""
          : `

⚠ Recorded WITHOUT a capture interview — this rule is agent_recorded TESTIMONY${input.severity === "blocking" ? ' and was capped from "blocking" to "warning"' : ""}. It IS enforced: the pre-edit hook and CI surface it on every matching edit from now on. What it cannot do is DENY an edit — only a rule a human countersigned may block. Countersign it by re-recording through hunch_capture_decision → hunch_record_correction(capture_token).`;
        const dest = destinationNote(resolveDestRoot(home, store, root));
        return ok(`${existing ? "Updated" : "Recorded"} ${rec.severity} constraint ${rec.id}: "${rec.statement}" (scope: ${rec.scope.join(", ")}).${where}${dest} It now ${enforce}.${reviewNote}${tierNote}`);
      } catch (e) {
        return err(`Failed to record correction: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_record_finding (write-back: observations, no diff) ---------------
  server.registerTool(
    "hunch_record_finding",
    {
      title: "Record a finding (an observation with no code change)",
      description:
        "Persist an OBSERVATION into Hunch — audited knowledge with no diff: an audit that surfaced a gap (e.g. queries missing tenant scoping), a measured number, a vendor/platform fact, an incident with no code fix. The anchor is a date + evidence, not a commit. Advisory: it grounds future edits to the affected files/symbols (pre-edit hook + hunch_context) and is listed by hunch_findings; it never blocks. Re-record the SAME title to update triage (e.g. triage:'resolved' + resolved_commit once fixed). If the finding is a violation of a rule that ISN'T recorded yet, record the rule first (hunch_record_correction) and link it via violates_constraint.",
      inputSchema: {
        finding: z.object({
          title: z.string().describe("stable one-line name — re-recording the same title updates the finding"),
          observation: z.string().describe("what was observed, in plain words"),
          evidence: z.array(z.string()).optional().describe("the query/command run + representative output — a finding without evidence is an opinion"),
          method: z.string().optional().describe("rb_* runbook that re-runs the audit (makes it re-verifiable)"),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
          triage: z.enum(["open", "accepted-risk", "scheduled", "resolved", "stale"]).optional().describe("default 'open'. 'resolved' should carry resolved_commit."),
          affected_files: z.array(z.string()).optional().describe("paths or globs the observation concerns"),
          affected_symbols: z.array(z.string()).optional().describe("symbols/objects concerned (e.g. dbo.GetOrders)"),
          violates_constraint: z.string().optional().describe("con_* this finding is a known violation of"),
          spawned_decision: z.string().optional().describe("dec_* recorded in response"),
          resolved_commit: z.string().optional().describe("the commit that fixed it (with triage:'resolved')"),
          private: z.boolean().optional().describe("write into the PRIVATE overlay store instead of the committed repo. Errors if no private store is configured."),
        }),
        cwd: cwdHintField,
      },
    },
    async ({ finding }): Promise<ToolResult> => {
      try {
        if (!finding.title.trim()) return err("title is required.");
        if (!finding.observation.trim()) return err("observation is required — state what you saw.");
        const id = findingId(finding.title);
        const home = store.captureHome(!!finding.private);
        const existing = home === "private" ? store.getPrivateRec("findings", id) : store.json.get("findings", id);
        const now = new Date().toISOString();
        const triage = finding.triage ?? existing?.triage ?? "open";
        if (triage === "resolved" && !(finding.resolved_commit ?? existing?.resolved_commit)) {
          return err(`Refusing to mark ${id} resolved without resolved_commit — a resolution claim needs the fixing commit (or use triage:'stale' if it no longer applies).`);
        }
        const rec: Finding = {
          id,
          title: finding.title,
          observation: finding.observation,
          evidence: finding.evidence ?? existing?.evidence ?? [],
          method: finding.method ?? existing?.method ?? null,
          severity: finding.severity ?? existing?.severity ?? "medium",
          triage,
          affected_files: (finding.affected_files ?? existing?.affected_files ?? []).map(toPosixTarget),
          affected_symbols: finding.affected_symbols ?? existing?.affected_symbols ?? [],
          violates_constraint: finding.violates_constraint ?? existing?.violates_constraint ?? null,
          spawned_decision: finding.spawned_decision ?? existing?.spawned_decision ?? null,
          observed_at: existing?.observed_at ?? now, // first observation wins — updates re-verify, not re-date
          resolved_commit: finding.resolved_commit ?? existing?.resolved_commit ?? null,
          provenance: { source: "human_confirmed", confidence: 0.95, evidence: finding.evidence ?? existing?.provenance.evidence ?? [], last_verified: now },
        };
        store.putCapture("findings", rec, !!finding.private);
        store.reindex();
        const flush = flushCapture(store, hunchPaths(root).hunch, !!finding.private, `hunch: capture ${id}`, startupTeamRoute ?? undefined);
        const flushed = flushNote(flush, home, store.mode) + publicHomeNote(home, store.hasPrivate, rec, hunchPaths(root).hunch);
        const where = finding.private
          ? ` [PRIVATE overlay — not committed to this repo]${flushed}`
          : home === "private" ? ` [SHARED store — one source of truth for the whole team]${flushed}` : flushed;
        // Advisory nudges, never gates: an unresolvable constraint link and missing
        // evidence both record fine, but say so.
        const danglingCon = rec.violates_constraint && !store.getRec("constraints", rec.violates_constraint)
          ? `\n\n△ violates_constraint ${rec.violates_constraint} resolves to no known constraint — if the rule isn't recorded yet, hunch_record_correction it and re-record this finding with the real id.`
          : "";
        const noEvidence = rec.evidence.length ? "" : "\n\n△ No evidence attached — a finding without the query/output that produced it is an opinion. Re-record with evidence when you have it.";
        const dest = destinationNote(resolveDestRoot(home, store, root));
        return ok(`${existing ? "Updated" : "Recorded"} finding ${id}: "${rec.title}" (${rec.triage}/${rec.severity}, observed ${rec.observed_at.slice(0, 10)}).${where}${dest} It now grounds edits to: ${[...rec.affected_files, ...rec.affected_symbols].join(", ") || "(nothing — add affected_files/symbols so it surfaces at edit time)"}.${danglingCon}${noEvidence}`);
      } catch (e) {
        return err(`Failed to record finding: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_findings (read: the open-observations ledger) --------------------
  server.registerTool(
    "hunch_findings",
    {
      title: "Open findings for a scope",
      description:
        "List LIVE findings (observed gaps/debt with no fix yet — triage open/accepted-risk/scheduled) concerning a file, glob, or symbol; omit scope for the whole ledger. Call before planning work in an area to inherit past audits instead of re-discovering them. Advisory; resolved/stale findings are excluded unless all:true.",
      inputSchema: {
        scope: z.string().optional().describe("a path, glob, or symbol (e.g. src/procs/** or dbo.GetOrders); omit for all"),
        all: z.boolean().optional().describe("include resolved/stale findings (the full history)"),
      },
    },
    async ({ scope, all }): Promise<ToolResult> => {
      const live = (f: Finding): boolean => f.triage === "open" || f.triage === "accepted-risk" || f.triage === "scheduled";
      const list = (scope ? store.liveFindingsFor(scope) : store.recs("findings").filter(all ? () => true : live))
        .filter(all ? () => true : live)
        .sort((a, b) => (SEV_BUG[b.severity] ?? 0) - (SEV_BUG[a.severity] ?? 0) || a.id.localeCompare(b.id));
      if (!list.length) return ok(`No ${all ? "" : "live "}findings${scope ? ` for "${scope}"` : ""}. (Record one after an audit with hunch_record_finding.)`);
      const L = list.slice(0, FINDINGS_CAP).map((f) => {
        const links = [f.violates_constraint ? `violates ${f.violates_constraint}` : "", f.method ? `re-verify via ${f.method}` : "", f.resolved_commit ? `fixed in ${f.resolved_commit.slice(0, 9)}` : ""].filter(Boolean).join("; ");
        return `• [${f.triage}/${f.severity}] ${f.title} (${f.id}, observed ${f.observed_at.slice(0, 10)})\n    ${f.observation}\n    concerns: ${[...f.affected_files, ...f.affected_symbols].join(", ") || "(unscoped)"}${links ? `\n    ${links}` : ""}`;
      });
      return ok(`${list.length} finding(s)${scope ? ` for "${scope}"` : ""}:\n${L.join("\n")}${more(list.length, FINDINGS_CAP)}`);
    },
  );

  server.registerTool(
    "hunch_policy_upgrade_correction",
    {
      title: "Build a proved review proposal from one exact correction",
      description:
        "Upgrade the exact supported static ESM import-declaration package projection of one captured correction into a deterministic review packet when the baseline is clean. Writes proposal, plan, proof, and evidence artifacts only; never activates, warns, blocks, or grants authority. Unsupported corrections keep their immediate legacy guard and create no policy.",
      inputSchema: {
        constraint_id: z.string().describe("Captured correction constraint id (con_*)."),
        public_only: z.boolean().optional().describe("Read and write only the public correction home."),
        private_only: z.boolean().optional().describe("Keep correction-derived evidence/policy/proof artifacts in the configured private overlay; the public source-code graph is refreshed before proof."),
        include_artifacts: z.boolean().optional().describe("Include the complete Policy IR, proof plan, proof receipts, and evidence object. Default output is a concise review envelope."),
        cwd: cwdHintField,
      },
    },
    async ({ constraint_id, public_only, private_only, include_artifacts }): Promise<ToolResult> => {
      try {
        if (public_only && private_only) return err("Choose only one of public_only or private_only.");
        // Resolve the correction's exact home before any writes. Overlay-first is
        // the same selection contract as ConstitutionService.upgradeCorrection;
        // deriving this later from a policy id is unsafe when legacy public and
        // private homes contain the same id, and `store.unified` routes captures,
        // not pre-existing public records.
        const artifactHome = public_only ? "public"
          : private_only ? "private"
            : store.getPrivateRec("constraints", constraint_id) ? "private" : "public";
        // Keep parity with the CLI: publish only immutable HEAD-derived graph
        // data, while allowing upgradeCorrection to classify its exact dirty
        // correction scope as pending evidence.
        indexRepo(store, root, { churn: false, source: { kind: "commit", ref: "HEAD" } });
        store.reindex();
        const service = new ConstitutionService(store, root);
        const upgrade = service.upgradeCorrection(constraint_id, {
          publicOnly: public_only,
          privateOnly: private_only,
        });
        // Build commit-bound artifacts against the common source HEAD, then pump
        // both actual homes before replying. Publishing the public index first
        // would make a shared plan reference an architect-only memory commit that
        // teammates cannot resolve. A public artifact naturally deduplicates to
        // one completion commit containing both index and policy JSON.
        // Public Git history is itself a public output surface. A private/team
        // correction id must not leak through the message of the public derived-
        // graph commit, even though its policy packet is correctly stored only in
        // the overlay. Pump public first with a content-neutral message, then pump
        // the exact private artifact home with its internal identifier.
        flushMemoryHome(
          store,
          hunchPaths(root).hunch,
          "public",
          "hunch: refresh derived graph and correction reviews",
          startupTeamRoute ?? undefined,
        );
        if (artifactHome === "private") {
          flushMemoryHome(
            store,
            hunchPaths(root).hunch,
            "private",
            `hunch: prove correction ${constraint_id}`,
            startupTeamRoute ?? undefined,
          );
        }
        const destRoot = resolveDestRoot(artifactHome, store, root);
        const destination = { root: destRoot, branch: currentBranch(destRoot) };
        if (include_artifacts) return ok(JSON.stringify({ ...upgrade, destination }, null, 2));
        return ok(JSON.stringify({
          status: upgrade.status,
          correction_id: upgrade.correction_id,
          reason: upgrade.reason,
          evidence_id: upgrade.evidence.id,
          policy_id: upgrade.policy?.id ?? null,
          plan_id: upgrade.plan?.id ?? null,
          proof_id: upgrade.proof?.id ?? null,
          review: upgrade.review,
          authority: upgrade.authority,
          effects: upgrade.effects,
          activation: upgrade.activation,
          destination,
        }, null, 2));
      } catch (e) {
        return err(`Failed to upgrade correction: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_merge_verdict (Causal Merge Verdict — read-only, client-agnostic) --
  server.registerTool(
    "hunch_merge_verdict",
    {
      title: "Causal merge verdict: is this change safe against the recorded WHY?",
      description:
        "Before opening or merging a PR, replay a diff against engineering memory and return ONE verdict — BLOCK / WARN / PASS. For each invariant DIRECTLY in scope it cites WHY the guard exists (the decision that motivated it + the bug whose root cause spawned it); it also lists invariants reached via blast radius (near, advisory), any deliberately-retired code the diff re-introduces, and symbols the diff adds that are already defined elsewhere in the graph (possible re-implementation/sprawl, advisory). Deterministic, no LLM. Omit base, commit, and working to check STAGED changes; pass working:true for all local changes, base (e.g. origin/main) for a PR range, or commit for a single commit. Call this before merging a widely-scoped change.",
      inputSchema: {
        base: z.string().optional().describe("Diff against this base ref (e.g. origin/main) — for a PR/branch."),
        commit: z.string().optional().describe("Diff a single commit (sha/ref). Omit base AND commit to check staged changes."),
        working: z.boolean().optional().describe("Include all working-tree changes vs HEAD (staged, unstaged, and untracked files)."),
      },
    },
    async ({ base, commit, working }): Promise<ToolResult> => {
      try {
        if ([base, commit, working].filter(Boolean).length > 1) return err("Pass at most one of base/commit/working (omit all to check staged changes).");
        if (base && !revExists(base, root)) return err(`base ref "${base}" does not resolve (in CI, fetch the base branch first).`);
        if (commit && !revExists(commit, root)) return err(`commit "${commit}" does not resolve.`);
        const files = commit ? commitFiles(commit, root) : base ? rangeFiles(base, root) : working ? workingFiles(root) : stagedFiles(root);
        const scope = commit ? `commit ${commit}` : base ? `${base}..HEAD` : working ? "working changes" : "staged changes";
        if (!files.length) return ok(`VERDICT: ✅ PASS — no changed files in ${scope}.`);
        const diff = commit ? commitDiff(commit, root) : base ? rangeDiff(base, root) : working ? workingDiff(root) : stagedDiff(root);
        const report = store.buildCheckReport(files, diff, { strict: true, lastChange: (f) => lastChangeDate(f, root) });
        const v = verdict(report);
        const head = v === "block"
          ? "VERDICT: ⛔ BLOCK — this change breaks a recorded invariant or re-opens a known bug."
          : v === "warn"
            ? "VERDICT: ⚠ WARN — this change touches engineering memory; review the cited why below before merge."
            : "VERDICT: ✅ PASS — touches no recorded invariants and re-introduces nothing deliberately retired.";
        return ok(`${head}\n(scope: ${scope}, ${files.length} file(s))\n\n${renderMarkdown(report)}`);
      } catch (e) {
        return err(`Failed to compute merge verdict: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_structure (graph-served orientation — the anti-grep) ------------
  server.registerTool(
    "hunch_structure",
    {
      title: "The indexed shape of the repo / a dir / a file / a symbol",
      description:
        "Orient WITHOUT grep/glob rounds: the graph already holds the repo's structure. No target → repo map (components + directories by symbol weight). A directory → its files with their symbols. A file → its outline (symbols, fan-in/out, callers). An exact symbol name → its definition site(s) with one-hop neighbors. Call this FIRST when exploring unfamiliar code — it tells you exactly which file to read, instead of searching for it.",
      inputSchema: {
        target: z.string().optional().describe("A directory, file path, or exact symbol name. Omit for the repo map."),
      },
    },
    async ({ target }): Promise<ToolResult> => ok(formatStructure(store.structure(target))),
  );

  // -- hunch_pr_impact (read-only impact surface — advisory, never gates) ----
  server.registerTool(
    "hunch_pr_impact",
    {
      title: "PR impact: the dependency + memory surface of a change",
      description:
        "Given a change (staged, working tree, a branch vs base, or a single commit), return its IMPACT SURFACE: the files whose code transitively depends on the changed files, the invariants directly in scope and those reached via blast radius, and the recorded decisions concerning the touched files. Read-only and advisory — use hunch_merge_verdict for the gate. Call before review to know what a PR can break and which recorded intent it touches. Omit base, commit, and working for staged changes.",
      inputSchema: {
        base: z.string().optional().describe("Diff against this base ref (e.g. origin/main) — for a PR/branch."),
        commit: z.string().optional().describe("Impact of a single commit (sha/ref). Omit base AND commit for staged changes."),
        working: z.boolean().optional().describe("Include all working-tree changes vs HEAD (staged, unstaged, and untracked files)."),
      },
    },
    async ({ base, commit, working }): Promise<ToolResult> => {
      try {
        if ([base, commit, working].filter(Boolean).length > 1) return err("Pass at most one of base/commit/working (omit all for staged changes).");
        if (base && !revExists(base, root)) return err(`base ref "${base}" does not resolve (in CI, fetch the base branch first).`);
        if (commit && !revExists(commit, root)) return err(`commit "${commit}" does not resolve.`);
        const files = commit ? commitFiles(commit, root) : base ? rangeFiles(base, root) : working ? workingFiles(root) : stagedFiles(root);
        const scope = commit ? `commit ${commit}` : base ? `${base}..HEAD` : working ? "working changes" : "staged changes";
        if (!files.length) return ok(`No changed files in ${scope}.`);
        const diff = commit ? commitDiff(commit, root) : base ? rangeDiff(base, root) : working ? workingDiff(root) : stagedDiff(root);
        return ok(renderImpact(store.prImpact(files, diff), scope));
      } catch (e) {
        return err(`Failed to compute impact: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_path (shortest dependency chain) --------------------------------
  server.registerTool(
    "hunch_path",
    {
      title: "Shortest dependency path between two nodes",
      description:
        "How does A reach B? Returns the shortest chain of call/import/dependency/contains edges connecting two symbols, files, or components — walked in either direction. Use to understand coupling before a refactor, to verify the actual route behind a must-reach invariant, or to explain why editing A shows up in B's blast radius. Deterministic, read-only.",
      inputSchema: {
        from: z.string().describe("Start: a symbol id/name or file path."),
        to: z.string().describe("End: a symbol id/name or file path."),
        max_depth: z.number().optional().describe("Maximum hops to search (default 8)."),
      },
    },
    async ({ from, to, max_depth }): Promise<ToolResult> => {
      const A = store.resolveNodeIds(from);
      const B = store.resolveNodeIds(to);
      if (!A.length) return err(`"${from}" resolves to no indexed symbol/component (is the repo indexed?).`);
      if (!B.length) return err(`"${to}" resolves to no indexed symbol/component.`);
      let best: Array<{ id: string; via: string }> | null = null;
      for (const a of A.slice(0, 4)) {
        for (const b of B.slice(0, 4)) {
          const p = store.shortestPath(a, b, max_depth ?? 8);
          if (p && (!best || p.length < best.length)) best = p;
        }
      }
      if (!best) return ok(`No path between "${from}" and "${to}" within ${max_depth ?? 8} hop(s) — they are not connected in the indexed graph.`);
      const chain = best.map((n, i) => `  ${i === 0 ? "┌" : i === best!.length - 1 ? "└" : "├"} ${n.via}`).join("\n");
      return ok(`${best.length - 1} hop(s) from "${from}" to "${to}":\n${chain}`);
    },
  );

  // -- hunch_compare --------------------------------------------------------
  server.registerTool(
    "hunch_compare",
    {
      title: "Rank candidate solutions by architectural fit",
      description:
        "Given several candidate branches/commits (e.g. N solutions to one task), replay each against engineering memory and RANK them best-fit first — the candidate that trips the fewest in-force invariants, reverses no decisions, and adds the least sprawl wins. Deterministic (the same merge-verdict per candidate, no LLM). Use to choose among multiple solutions before committing to one.",
      inputSchema: {
        candidates: z.array(z.string()).describe("Refs to compare — branches or commits, e.g. ['feat-a','feat-b','feat-c']."),
        base: z.string().optional().describe("Base to diff each candidate against (3-dot; default: main)."),
      },
    },
    async ({ candidates, base }): Promise<ToolResult> => {
      try {
        const b = base ?? "main";
        if (!candidates.length) return err("Pass at least one candidate ref.");
        if (!revExists(b, root)) return err(`base ref "${b}" does not resolve (in CI, fetch it first).`);
        const ranked = compareCandidates(store, root, b, candidates);
        const icon = (v: string) => (v === "pass" ? "✅" : v === "warn" ? "⚠" : "⛔");
        const lines = ranked.map((c, i) =>
          c.error
            ? `${i + 1}. ${c.ref} — ${c.error}`
            : `${i + 1}. ${icon(c.verdict)} ${c.ref} [${c.verdict}] — ${c.blocking} blocking · ${c.direct} direct · ${c.near} near · ${c.vetoes} veto · ${c.redundant} redundant (${c.files} files)`,
        );
        const best = ranked.find((c) => !c.error);
        return ok(`Candidates vs ${b}, best architectural fit first:\n\n${lines.join("\n")}${best ? `\n\nBest fit: ${best.ref}` : ""}`);
      } catch (e) {
        return err(`Failed to compare candidates: ${(e as Error).message}`);
      }
    },
  );

  // -- Hunch Constitution (read-first, agent-neutral Policy IR) ------------
  server.registerTool(
    "hunch_policy_candidates",
    {
      title: "List Constitution policy candidates",
      description:
        "List compiled/proposed deterministic Policy IR candidates. Read-only; candidates carry no authority and cannot block. Uses the same Git-native policy store for every MCP client.",
      inputSchema: {
        public_only: z.boolean().optional().describe("Exclude the private overlay from this response."),
      },
    },
    async ({ public_only }): Promise<ToolResult> => {
      try {
        const service = new ConstitutionService(store, root);
        const candidates = service.list({ publicOnly: public_only }).filter((p) => p.state === "compiled" || p.state === "validating" || p.state === "proposed");
        if (!candidates.length) return ok("No Constitution policy candidates.");
        return ok(JSON.stringify(candidates.map((p) => ({ id: p.id, state: p.state, statement: p.statement, proof: p.proof, data_class: p.data_class })), null, 2));
      } catch (e) {
        return err(`Failed to list policy candidates: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_plan",
    {
      title: "Generate or inspect a Constitution proof plan",
      description:
        "Return the canonical Git-native ProofPlan for a policy candidate: immutable source/current commits, known-good/bad corpus, mutation operators, expectations, and budgets. Planning executes no replay, model, test, or authority transition.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude private-overlay policy and evidence records."),
        cwd: cwdHintField,
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        const service = new ConstitutionService(store, root);
        const plan = service.plan(policy_id, { publicOnly: public_only });
        const home = public_only ? "public" : service.repository.homeOfPolicy(policy_id);
        if (!home) throw new Error(`policy ${policy_id} has no exact storage home`);
        flushMemoryHome(store, hunchPaths(root).hunch, home, `hunch: plan policy ${policy_id}`, startupTeamRoute ?? undefined);
        const destRoot = resolveDestRoot(home, store, root);
        return ok(JSON.stringify({ ...plan, destination: { root: destRoot, branch: currentBranch(destRoot) } }, null, 2));
      } catch (e) {
        return err(`Failed to generate policy proof plan: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_card",
    {
      title: "Inspect a Constitution proof card",
      description:
        "Return the deterministic proof-card view for a policy: exact assertion/scope, raw evidence vector, uncertainty, blocking readiness, authority, limitations, and next actions. Read-only and grants no authority.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude private-overlay policy and proof records."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).card(policy_id, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to build policy proof card: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_shadow",
    {
      title: "Inspect Constitution shadow precision",
      description:
        "Return the append-only shadow evaluation ledger, current human dispositions, raw precision counts, unknown/error rate, thresholds, and P4-review recommendation for one policy. Read-only: it never records a sample, changes lifecycle, activates, warns, or blocks.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude private-overlay shadow records."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).shadowReport(policy_id, {}, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to inspect policy shadow precision: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_proof",
    {
      title: "Inspect a Constitution policy proof",
      description:
        "Return the full content-addressed proof artifact for a policy. Read-only; exposes baseline, mutations, proof class, artifact hashes, and limitations without changing authority.",
      inputSchema: {
        policy_id: z.string().describe("Policy id (pol_*)."),
        public_only: z.boolean().optional().describe("Exclude the private overlay from this response."),
      },
    },
    async ({ policy_id, public_only }): Promise<ToolResult> => {
      try {
        const service = new ConstitutionService(store, root);
        const policy = service.get(policy_id, { publicOnly: public_only });
        if (!policy.proof) return ok(`Policy ${policy_id} has no proof yet.`);
        return ok(JSON.stringify(service.proof(policy.proof, { publicOnly: public_only }), null, 2));
      } catch (e) {
        return err(`Failed to read policy proof: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_policy_evaluate",
    {
      title: "Evaluate Constitution policy",
      description:
        "Evaluate one or all deterministic Policy IR records and return canonical neutral receipts (satisfied, violated, not_applicable, unknown, error). This is the same evaluator used by CLI and strict CI; models never decide the verdict.",
      inputSchema: {
        policy_id: z.string().optional().describe("Optional policy id; omit for all policies."),
        active_only: z.boolean().optional().describe("Evaluate only active advisory/blocking policies."),
        public_only: z.boolean().optional().describe("Exclude private-overlay policies and graph records."),
        workspace: z.enum(["staged", "working"]).optional().describe("Evaluate static and executable policies against the staged index or complete working source snapshot; omit for working."),
        commit: z.string().optional().describe("Evaluate static and executable policies at an exact commit ref."),
      },
    },
    async ({ policy_id, active_only, public_only, workspace, commit }): Promise<ToolResult> => {
      try {
        if (workspace && commit) throw new Error("choose either workspace or commit for executable-behavior evaluation");
        if (commit && !revExists(commit, root)) throw new Error(`commit ref ${JSON.stringify(commit)} does not resolve`);
        const exactCommit = commit ? revParse(`${commit}^{commit}`, root) : undefined;
        const behavior = workspace ? { workspace }
          : exactCommit ? { commit: exactCommit }
            : { workspace: "working" as const };
        // A neutral evaluation is read-only. Static and executable policy legs
        // select the same source surface, and the receipt binds raw bytes as
        // well as topology. Default to the complete working view so a long-lived
        // MCP sees new safe untracked code without persisting derived JSON.
        const semanticSource = exactCommit ? { kind: "commit" as const, ref: exactCommit }
          : workspace === "staged" ? { kind: "staged" as const }
            : { kind: "working" as const };
        const graphScan = scanRepo(store, root, { churn: false, source: semanticSource });
        assertCompleteRepoScan(graphScan);
        const snapshot = sourceGraphSnapshot(root, graphScan.source, graphScan.symbols, graphScan.edges, graphScan.components);
        const receipts = new ConstitutionService(store, root)
          .evaluate({ id: policy_id, activeOnly: active_only, publicOnly: public_only, behavior, snapshot })
          .map(policyEvaluationEnvelope);
        return ok(JSON.stringify(receipts, null, 2));
      } catch (e) {
        return err(`Failed to evaluate policy: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_readiness",
    {
      title: "Inspect Constitution G2 readiness",
      description:
        "Return the exact private G2 dogfood evidence packet: human-selected policies, bound proof/corpus/shadow evidence, operational runbook rehearsals, and blockers. Read-only; it never creates evidence, signs off G2, activates policy, warns, or blocks.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2Readiness(), null, 2));
      } catch (e) {
        return err(`Failed to inspect G2 readiness: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g3_readiness",
    {
      title: "Inspect Constitution G3 readiness",
      description:
        "Return the exact private G3 advisory packet: human-selected policies and clients, immutable experiment preregistrations, proof-card comprehension/review measurements, executable adapter conformance, scorecard, and blockers. Read-only; it never records evidence, activates policy, or signs off G3.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g3Readiness(), null, 2));
      } catch (e) {
        return err(`Failed to inspect G3 readiness: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_shadow_queue",
    {
      title: "Review unclassified G2 shadow violations",
      description:
        "Return a bounded private queue of exact-current-proof G2 shadow violations that still require human classification. Read-only; it never records an observation or disposition, changes lifecycle, grants authority, warns, or blocks.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum queue items to return (default 20)."),
      },
    },
    async ({ limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2ShadowQueue(limit ?? 20), null, 2));
      } catch (e) {
        return err(`Failed to inspect the G2 shadow queue: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_operational_drill",
    {
      title: "Execute one exact G2 operational drill",
      description:
        "Execute the selected private G2 runbook's exact safety regression and return a content-addressed hash-only receipt. Diagnostic only: it writes no rehearsal or shadow evidence, grants no authority, and never signs off G2.",
      inputSchema: {
        category: z.enum(G2_RUNBOOK_CATEGORIES).describe("Exact operational category selected by the current private G2 plan."),
      },
    },
    async ({ category }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2OperationalDrill(category), null, 2));
      } catch (e) {
        return err(`Failed to execute the G2 operational drill: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_candidates",
    {
      title: "Review potential G2 dogfood candidates",
      description:
        "Return a bounded private review packet of exact structural candidates from fix-labeled git history, including the current append-only human selection/rejection when present. Read-only: proposed before/after corpus refs are not replayed evidence, and the tool creates no attestation, policy, proof, corpus, authority, warning, or block.",
      inputSchema: {
        since: z.string().min(1).max(100).optional().describe("Git history window (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Maximum fix-labeled commits to inspect (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum ranked candidates to return (default 30)."),
      },
    },
    async ({ since, max_commits, limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2CandidateReview({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
        }), null, 2));
      } catch (e) {
        return err(`Failed to inspect G2 candidates: ${(e as Error).message}`);
      }
    },
  );

  // -- hunch_conformance ----------------------------------------------------
  server.registerTool(
    "hunch_conformance",
    {
      title: "Does the code still satisfy the recorded intent?",
      description:
        "Intent-conformance (the inversion of a normal guard): for every in-force decision carrying a conformance predicate, deterministically verify the CODE still satisfies its intent over the dependency graph — e.g. 'pay still reaches verifySession'. Returns the violations: intent the code has silently drifted away from, with NO diff required. Run before a refactor or merge to catch intent erosion a diff-only check can't see.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const scan = scanRepo(store, root, { churn: false, source: { kind: "working" } });
        assertCompleteRepoScan(scan);
        const results = checkConformance(store, { graph: scan });
        if (!results.length) return ok("No conformance predicates recorded. Add a `conformance` predicate to a decision (e.g. {assert:'calls', subject:'pay', object:'verifySession'}) to prove the code honors its intent.");
        const violations = results.filter((r) => !r.satisfied);
        const lines = results.map((r) => `${r.satisfied ? "✅" : "⛔"} ${r.decision} "${r.title}" — ${r.assert} ${r.subject}${r.object ? ` → ${r.object}` : ""}: ${r.detail}`);
        const head = violations.length ? `⛔ ${violations.length} intent(s) the code no longer satisfies` : "✅ the code satisfies every recorded intent";
        return ok(`Intent-conformance (${results.length - violations.length}/${results.length} satisfied):\n\n${lines.join("\n")}\n\n${head}`);
      } catch (error) {
        return err(`Conformance refused an incomplete working graph: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_candidates",
    {
      title: "Review executable G2 behavior candidates",
      description:
        "Derive a bounded private review packet from human-grounded rejected structural proxies and newly added literal node:test cases in their exact fixing commits. Read-only: candidates remain unselected and create no policy, corpus, proof, authority, warning, or block.",
      inputSchema: {
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact current human-confirmed decision to use as the direct behavior grounding batch."),
        since: z.string().min(1).max(100).optional().describe("Git history window (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Maximum fix-labeled commits to inspect (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum behavior candidates to return (default 30)."),
      },
    },
    async ({ decision_id, since, max_commits, limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorCandidateReview({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
        }), null, 2));
      } catch (e) {
        return err(`Failed to inspect G2 behavior candidates: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_replay",
    {
      title: "Replay one G2 behavior candidate",
      description:
        "Execute one exact behavior candidate without a shell in disposable known-bad and known-good worktrees, transplanting the hash-bound known-good test file into both. Diagnostic only: writes no Constitution artifact and grants no policy or G2 authority.",
      inputSchema: {
        candidate_id: z.string().regex(/^g2behavior_[a-f0-9]{10}$/),
        review_hash: z.string().regex(/^sha1:[a-f0-9]{40}$/),
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact decision batch used by the reviewed candidate."),
        since: z.string().min(1).max(100).optional().describe("Git history window used by the exact review packet (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Fix-commit bound used by the exact review packet (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Item limit used by the exact review packet (default 30)."),
        timeout_ms: z.number().int().min(1).max(120000).optional().describe("Per-leg execution timeout (default 30000ms)."),
      },
    },
    async ({ candidate_id, review_hash, decision_id, since, max_commits, limit, timeout_ms }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorCandidateReplay(candidate_id, review_hash, {
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
          timeoutMs: timeout_ms ?? 30_000,
        }), null, 2));
      } catch (e) {
        return err(`Failed to replay G2 behavior candidate: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_materialization",
    {
      title: "Assess selected G2 behavior materialization",
      description:
        "Bind the complete current private behavior review and exact selected attestations, then report whether their durable meanings are expressible by the supported Policy IR. Read-only and fail-closed: unsupported behavior creates no policy, corpus, plan, proof, authority, warning, or block.",
      inputSchema: {
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact decision batch to assess."),
        since: z.string().min(1).max(100).optional().describe("Git history window used by the exact review packet (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Fix-commit bound used by the exact review packet (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Item limit used by the exact review packet (default 30)."),
      },
    },
    async ({ decision_id, since, max_commits, limit }): Promise<ToolResult> => {
      try {
        return ok(JSON.stringify(new ConstitutionService(store, root).g2BehaviorMaterializationAssessment({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
        }), null, 2));
      } catch (e) {
        return err(`Failed to assess G2 behavior materialization: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "hunch_constitution_g2_behavior_policy_materialize",
    {
      title: "Materialize selected G2 behavior policies",
      description:
        "Materialize every current exact selected behavior attestation into a separate private Policy IR v2 proposal, exact corpus and plan, and P3 executable proof. Writes private non-authoritative artifacts only; activation remains a separate explicit human action.",
      inputSchema: {
        decision_id: z.string().regex(/^dec_[A-Za-z0-9_-]+$/).optional().describe("Exact decision batch to materialize."),
        since: z.string().min(1).max(100).optional().describe("Git history window used by the complete exact review packet (default 180d)."),
        max_commits: z.number().int().min(1).max(200).optional().describe("Fix-commit bound used by the exact review packet (default 100)."),
        limit: z.number().int().min(1).max(100).optional().describe("Item limit used by the exact review packet (default 30)."),
        allow_install_scripts: z.array(z.string().min(1).max(214)).max(20).optional().describe("Exact dependency package names allowed to run lifecycle scripts while provisioning snapshots."),
        dependency_timeout_ms: z.number().int().min(1).max(900000).optional().describe("Timeout for each exact dependency snapshot operation (default 300000ms)."),
        cwd: cwdHintField,
      },
    },
    async ({ decision_id, since, max_commits, limit, allow_install_scripts, dependency_timeout_ms }): Promise<ToolResult> => {
      try {
        const materialized = new ConstitutionService(store, root).g2BehaviorPolicyMaterialize({
          since: since ?? "180d",
          maxCommits: max_commits ?? 100,
          limit: limit ?? 30,
          decisionId: decision_id,
          allowInstallScripts: allow_install_scripts ?? [],
          dependencyTimeoutMs: dependency_timeout_ms ?? 300_000,
        });
        flushMemoryHome(store, hunchPaths(root).hunch, "private", "hunch: materialize G2 behavior policies", startupTeamRoute ?? undefined);
        const destRoot = resolveDestRoot("private", store, root);
        return ok(JSON.stringify({ ...materialized, destination: { root: destRoot, branch: currentBranch(destRoot) } }, null, 2));
      } catch (e) {
        return err(`Failed to materialize G2 behavior policies: ${(e as Error).message}`);
      }
    },
  );

  return {
    server,
    getRoot: () => root,
    setRoot,
    cancelPendingRoot: () => { pendingRoot = null; },
  };
}

/** Back-compatible server construction for tests and callers that do not need
 *  to drive roots directly. The server still owns and closes its active store. */
export function buildServer(root: string): McpServer {
  return buildServerWithRootControl(root).server;
}

function provLine(record: unknown): string {
  const p = (record as { provenance?: { source?: string; confidence?: number; last_verified?: string } } | undefined)?.provenance;
  if (!p) return "";
  const v = p.last_verified ? `, verified ${p.last_verified.slice(0, 10)}` : "";
  return `\n      ⟨${p.source ?? "?"}, confidence ${p.confidence ?? "?"}${v}⟩`;
}

/** Query client roots after initialization and follow later list changes.
 *  Generation ordering prevents a slow stale roots/list response from winning. */
export function wireClientRoots(control: RootControlledServer, fallback: string): void {
  let generation = 0;
  const syncRoots = async (): Promise<void> => {
    const mine = ++generation;
    try {
      if (!control.server.server.getClientCapabilities()?.roots) return;
      const response = await control.server.server.listRoots();
      if (mine !== generation) return;
      const next = resolveActiveRoot((response?.roots ?? []).map((root) => root.uri), fallback);
      if (!next) {
        // Cancel a swap parked by an EARLIER generation. setRoot defers when a tool
        // request is in flight; if the client's advertised set has since become
        // ambiguous, applying that stale swap once the request drains would re-home
        // to a repo the client no longer unambiguously advertises — writing (and
        // auto-committing) a capture into the wrong repository, which is precisely
        // what this refusal exists to prevent. Without this the message below was
        // also a lie: the root did NOT stay put.
        control.cancelPendingRoot();
        console.error("[hunch-mcp] multiple client roots are equally plausible; keeping the current Hunch root");
        return;
      }
      control.setRoot(next);
    } catch (error) {
      // A client without roots support keeps the spawn root. A client-provided
      // root that fails fail-closed validation is also refused without taking
      // down the existing, already-validated graph.
      if (mine === generation) {
        console.error(`[hunch-mcp] could not apply client roots: ${(error as Error).message}`);
      }
    }
  };
  control.server.server.oninitialized = () => { void syncRoots(); };
  control.server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => { await syncRoots(); },
  );
}

/** Start the stdio server (called by `hunch mcp`). */
export async function startServer(cwd: string = process.cwd()): Promise<void> {
  const fallback = findRoot(cwd);
  const control = buildServerWithRootControl(fallback);
  wireClientRoots(control, fallback);
  const transport = new StdioServerTransport();
  await control.server.connect(transport);
  console.error(`[hunch-mcp] serving Hunch over stdio (spawn root ${control.getRoot()}; resolving client roots…)`);
}
