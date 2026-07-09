/**
 * Pluggable synthesis provider for the WRITE path (DESIGN.md §4 / §7).
 *
 * LLM synthesis is driven by the user's chosen coding-assistant subscription
 * CLI — never a pay-per-token API. Claude Code, Codex, and Cursor use different
 * auth surfaces, but every provider returns the same shape. When more than one
 * subscription CLI is available, Hunch deliberately does NOT guess whose plan
 * to spend: the user chooses once with `hunch provider <name>` (stored locally)
 * or overrides per shell with HUNCH_SYNTH_PROVIDER. Ambiguous auto mode stays
 * deterministic and free.
 *
 * Subscription, not API: provider-specific API credentials are removed from the
 * child env wherever the CLI would otherwise prefer them. There is intentionally
 * NO direct API-key provider.
 *
 * Every provider returns the same shape so the rest of the system never knows
 * (or cares) which one ran.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../core/io.js";
import { summarizeDiff, type DiffAnalysis } from "../extractors/diff.js";
import type { Decision } from "../core/types.js";

const IS_WIN = process.platform === "win32";

/**
 * Run a command, optionally feeding `input` to its stdin, and resolve its
 * stdout. Uses spawn (not execFile) so we can:
 *   1. Pass untrusted content (the prompt/diff) via STDIN, never as an argv
 *      element — so a `shell:true` resolution can't shell-interpret it.
 *   2. Resolve Windows shims: the npm `claude` is a `.cmd`/`.ps1`, which
 *      `execFile` (CreateProcess, *.exe only) cannot launch → it threw ENOENT
 *      and made the CLI provider look unavailable on Windows. `shell:true` on
 *      win32 routes through cmd.exe so the shim resolves. Safe here because
 *      every argv we pass is a trusted, space-free flag (the prompt is stdin).
 */
export function pexecIn(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    // Windows: launch through cmd.exe so the `claude` .cmd/.ps1 shim resolves,
    // and pass the whole line as ONE shell string (args are trusted, space-free
    // flags) — avoids Node's DEP0190 warning for `args + shell:true`. The prompt
    // is never here; it goes via stdin below. POSIX: no shell, argv as-is.
    const child = IS_WIN
      ? spawn([cmd, ...args].join(" "), {
          shell: true,
          env: opts.env,
          cwd: opts.cwd,
          windowsHide: true,
        })
      : spawn(cmd, args, {
          env: opts.env,
          cwd: opts.cwd,
          windowsHide: true,
        });
    const max = opts.maxBuffer ?? 16 * 1024 * 1024;
    let out = "";
    let err = "";
    let outLen = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill();
          done(() => reject(new Error(`"${cmd}" timed out after ${opts.timeout}ms`)));
        }, opts.timeout)
      : null;
    child.on("error", (e) => done(() => reject(e)));
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > max) {
        child.kill();
        done(() => reject(new Error(`"${cmd}" exceeded maxBuffer (${max} bytes)`)));
        return;
      }
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      done(() => {
        if (code === 0) resolve({ stdout: out });
        else reject(new Error(`"${cmd}" exited ${code}: ${err.slice(0, 300)}`));
      });
    });
    // Feed stdin (the prompt) then close it; commands with no input just get EOF.
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits early
    child.stdin.end();
  });
}

export interface DecisionDraft {
  title: string;
  context: string;
  decision: string;
  consequences: string[];
  alternatives_rejected: string[];
  confidence: number;
  source: string;
  // Optional synthesis telemetry (surfaced in `hunch review`, never schema-bound):
  // how many independent drafts were reconciled, their mean agreement, and the
  // verifier's grounded-ness. Undefined on the plain single-shot path.
  samples?: number;
  agreement?: number;
  grounded?: number;
  // How many unsupported alternatives + consequences the Critic pruned (its visible value).
  pruned?: number;
  // Outcome of the Critic pass when it was REQUESTED (--verify/--deep): "applied"
  // when the audit ran, "unavailable" when no CLI could verify, "failed" when the
  // call errored after a retry. Lets telemetry distinguish "verified, nothing to
  // flag" from "verification was skipped" instead of degrading silently.
  verifyOutcome?: "applied" | "unavailable" | "failed";
}

/** A skeptical audit of a DecisionDraft against the commit it was derived from.
 *  `grounded` is 0..1 (how well decision+consequences are supported by the diff);
 *  the lists name draft entries the evidence does NOT support (likely hallucinated).
 *  Used to PRUNE unsupported alternatives/consequences and to LOWER confidence —
 *  never to raise it or arm enforcement (auto stays advisory; dec_9a2f2fe72a). */
export interface VerifyVerdict {
  grounded: number;
  unsupported_alternatives: string[];
  unsupported_claims: string[];
}

export interface BugDraft {
  title: string;
  symptom: string;
  root_cause: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;
  source: string;
}

/** A harness judgment of one auto-drafted decision, used by `hunch auto-review`
 *  to decide keep vs delete. `relevant` = does this record a real, reusable design
 *  choice worth keeping (not noise, not a mechanical restatement)? `duplicate_of`
 *  names an existing decision id this merely restates. The judge NEVER approves —
 *  approval stays gated on the Critic's grounding (dec_a466655539); this only adds
 *  the "is it worth keeping at all" signal the deterministic layers can't express. */
export interface RelevanceVerdict {
  relevant: boolean;
  /** 0..1 confidence in the relevance call. */
  confidence: number;
  /** id of an existing decision this draft duplicates, or null. */
  duplicate_of: string | null;
  /** one-line justification (for the review plan / audit trail). */
  reason: string;
}

/** A decision already in the store, reduced to what the relevance judge needs. */
export interface ExistingDecisionRef {
  id: string;
  title: string;
  decision: string;
}

export interface CommitInput {
  subject: string;
  body: string;
  files: string[];
  diff: string;
  /** structured "what changed" — lets even the no-LLM path be informative */
  analysis?: DiffAnalysis;
}

export interface FailureInput {
  test: string;
  message: string;
  recentDiff: string;
  suspects: string[];
}

export interface SynthProvider {
  readonly name: string;
  available(): Promise<boolean>;
  draftDecision(input: CommitInput): Promise<DecisionDraft>;
  draftBug(input: FailureInput): Promise<BugDraft>;
  /** Optional skeptical audit of a draft against its commit (the Critic pass).
   *  Only the LLM-backed CLI providers implement it; the deterministic provider
   *  and the bare ensemble omit it, so callers must feature-detect. */
  verifyDecision?(input: CommitInput, draft: DecisionDraft): Promise<VerifyVerdict>;
  /** Optional free-form grounded prose (the wiki's Overview section). Only the
   *  LLM-backed CLI providers implement it — same subscription-only run() path
   *  (API keys stripped) — so callers must feature-detect and degrade to a
   *  deterministic template when absent. */
  draftProse?(prompt: string): Promise<string>;
  /** Optional harness judgment of an auto-drafted decision's relevance, for
   *  `hunch auto-review`. Same subscription-only run() path (API keys stripped);
   *  only the LLM-backed CLI providers implement it, so callers feature-detect. */
  judgeDraft?(draft: Decision, existing: ExistingDecisionRef[]): Promise<RelevanceVerdict>;
}

/** Every selectable synthesis mode. `auto` is a preference value rather than a
 * provider: it uses a subscription only when exactly one usable CLI is found. */
export const SYNTH_PROVIDER_NAMES = ["claude-cli", "codex-cli", "cursor-agent", "deterministic"] as const;
export const SYNTH_PREFERENCES = ["auto", ...SYNTH_PROVIDER_NAMES] as const;
export type SynthProviderName = (typeof SYNTH_PROVIDER_NAMES)[number];
export type SynthPreference = (typeof SYNTH_PREFERENCES)[number];

export interface ProviderStatus {
  name: SynthProviderName;
  label: string;
  subscription: string | null;
  available: boolean;
}

export interface ProviderResolution {
  provider: SynthProvider;
  /** Why this provider was chosen. `ambiguous` is intentionally deterministic. */
  source: "environment" | "local" | "single-available" | "ambiguous" | "none" | "unavailable-preference";
  preference: SynthPreference;
  statuses: ProviderStatus[];
}

export interface ProviderSelectionOptions {
  /** Repo root used for the gitignored, per-user `.hunch/local.json` preference. */
  root?: string;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; normal callers use the built-in CLI registry. */
  providers?: readonly SynthProvider[];
}

const PROVIDER_INFO: Record<SynthProviderName, { label: string; subscription: string | null }> = {
  "claude-cli": { label: "Claude Code", subscription: "Claude subscription" },
  "codex-cli": { label: "Codex", subscription: "ChatGPT subscription" },
  "cursor-agent": { label: "Cursor Agent", subscription: "Cursor subscription" },
  deterministic: { label: "Deterministic local fallback", subscription: null },
};

const SYSTEM = `You are the synthesis engine of an Engineering Memory OS. You turn raw
developer activity (a git commit diff, or a test failure) into a single structured
"why" record. Be precise and evidence-grounded; never invent facts not supported by
the input. Prefer short, concrete statements. If intent is unclear, say so plainly
rather than guessing.`;

const DECISION_TOOL = {
  name: "emit_decision",
  description: "Emit the structured Decision (ADR) distilled from this commit.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Imperative, specific (<=80 chars)." },
      context: { type: "string", description: "Why this change was needed." },
      decision: { type: "string", description: "What was actually decided/changed." },
      consequences: { type: "array", items: { type: "string" } },
      alternatives_rejected: { type: "array", items: { type: "string" } },
      nontrivial: { type: "boolean", description: "Is this a real design decision worth remembering?" },
    },
    required: ["title", "context", "decision", "consequences", "alternatives_rejected", "nontrivial"],
  },
};

const BUG_TOOL = {
  name: "emit_bug",
  description: "Emit the structured Bug distilled from this test failure.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string" },
      symptom: { type: "string" },
      root_cause: { type: "string", description: "Best hypothesis; mark uncertainty." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    },
    required: ["title", "symptom", "root_cause", "severity"],
  },
};

const RELEVANCE_TOOL = {
  name: "emit_relevance",
  description: "Judge whether an auto-drafted decision is worth keeping in the memory graph.",
  input_schema: {
    type: "object" as const,
    properties: {
      relevant: { type: "boolean", description: "true if this records a REAL, reusable design choice worth keeping. false if it is noise: a mechanical restatement of the diff, a trivial/obvious change, or content unsupported by the evidence." },
      confidence: { type: "number", description: "0..1 confidence in the relevant call. Be honest; low when unsure." },
      duplicate_of: { type: ["string", "null"], description: "id (dec_...) of an existing decision this merely restates, from the EXISTING DECISIONS list. null if none." },
      reason: { type: "string", description: "one short line justifying the call." },
    },
    required: ["relevant", "confidence", "duplicate_of", "reason"],
  },
};

const VERIFY_TOOL = {
  name: "emit_verdict",
  description: "Emit a skeptical audit of a synthesized decision against its commit.",
  input_schema: {
    type: "object" as const,
    properties: {
      grounded: { type: "number", description: "0..1: how well decision+consequences are supported by the ACTUAL diff. Be strict." },
      unsupported_alternatives: {
        type: "array",
        items: { type: "string" },
        description: "VERBATIM entries from alternatives_rejected that the diff/message does NOT evidence (likely hallucinated). Copy them exactly.",
      },
      unsupported_claims: {
        type: "array",
        items: { type: "string" },
        description: "VERBATIM consequences not supported by the diff.",
      },
    },
    required: ["grounded", "unsupported_alternatives", "unsupported_claims"],
  },
};

// --------------------------------------------------------------------------
// Base for headless-CLI SUBSCRIPTION providers. Each one drives a coding-assistant
// CLI billed to the user's own subscription (never a pay-per-token API key — see
// dec_65b058de66). The prompt always goes over STDIN (never argv — keeps untrusted
// diff content out of any shell pexecIn uses on Windows), and the CLI's text output
// is handed to the SAME mappers, so the rest of the system is provider-agnostic.
// --------------------------------------------------------------------------
abstract class CliSynthProvider implements SynthProvider {
  abstract readonly name: string;
  abstract available(): Promise<boolean>;
  protected abstract run(prompt: string): Promise<string>;

  /** Run a CLI with the prompt on stdin, stripping API-key env vars so the tool
   *  falls through to its SUBSCRIPTION credentials. Shared by codex/cursor. */
  protected async runCli(bin: string, args: string[], stripEnv: string[], prompt: string, timeoutMs = 120_000): Promise<string> {
    const env = { ...process.env };
    for (const k of stripEnv) delete env[k];
    const { stdout } = await pexecIn(bin, args, {
      input: prompt,
      env,
      cwd: tmpdir(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout;
  }

  async draftDecision(input: CommitInput): Promise<DecisionDraft> {
    const text = await this.run(`${SYSTEM}\n\n${commitPrompt(input)}\n\n${jsonInstruction(DECISION_TOOL.input_schema)}`);
    const draft = decisionDraftFromText(text, input.subject);
    // No usable LLM JSON (truncation, refusal, prose-only, or a CLI whose output
    // shape we misread) → THROW so the safe wrapper falls back to the deterministic
    // provider, whose draft is honestly labeled ("inferred", low confidence).
    if (!draft) throw new Error(`${this.name}: no usable decision JSON in output`);
    // For a LARGE diff the model only saw the structured summary + a sample — haircut
    // the confidence and tag the source so provenance stays honest.
    if (input.diff.length > LARGE_DIFF_CHARS) {
      return { ...draft, confidence: Math.min(draft.confidence, 0.5), source: `${draft.source}+summary` };
    }
    return draft;
  }

  async draftBug(input: FailureInput): Promise<BugDraft> {
    const text = await this.run(`${SYSTEM}\n\n${failurePrompt(input)}\n\n${jsonInstruction(BUG_TOOL.input_schema)}`);
    const draft = bugDraftFromText(text, input.test, input.message);
    if (!draft) throw new Error(`${this.name}: no usable bug JSON in output`);
    return draft;
  }

  /** Grounded prose for the wiki. Same subscription-only run() path (API keys
   *  stripped). Throws on empty output so the caller falls back to its
   *  deterministic template page. */
  async draftProse(prompt: string): Promise<string> {
    const text = (await this.run(prompt)).trim();
    if (!text) throw new Error(`${this.name}: empty prose output`);
    return text;
  }

  /** The Critic pass: audit a draft against its commit. Same subscription-only
   *  run() path (API keys stripped), so this never bills the pay-per-token API.
   *  Throws on unusable output so verifyDecisionSafe degrades to the un-audited
   *  draft (a verifier failure must never lose the draft — dec_18a81c8291). */
  async verifyDecision(input: CommitInput, draft: DecisionDraft): Promise<VerifyVerdict> {
    const text = await this.run(`${VERIFY_SYSTEM}\n\n${verifyPrompt(input, draft)}\n\n${jsonInstruction(VERIFY_TOOL.input_schema)}`);
    const verdict = verdictFromText(text);
    if (!verdict) throw new Error(`${this.name}: no usable verdict JSON in output`);
    return verdict;
  }

  /** Judge whether an auto-drafted decision is worth keeping (for auto-review).
   *  Same subscription-only run() path (API keys stripped). Throws on unusable
   *  output so the caller can degrade to a keep-for-human verdict. */
  async judgeDraft(draft: Decision, existing: ExistingDecisionRef[]): Promise<RelevanceVerdict> {
    const text = await this.run(`${RELEVANCE_SYSTEM}\n\n${relevancePrompt(draft, existing)}\n\n${jsonInstruction(RELEVANCE_TOOL.input_schema)}`);
    const verdict = relevanceFromText(text);
    if (!verdict) throw new Error(`${this.name}: no usable relevance JSON in output`);
    return verdict;
  }
}

// A model id comes from a HUNCH_*_MODEL env var and ends up as an argv token that,
// on Windows, pexecIn joins into the cmd.exe line (shell:true, to resolve the npm
// `.cmd` shim). The untrusted prompt always travels via stdin — never argv — so the
// ONLY non-literal token reaching that shell line is this model id. Reject anything
// with whitespace or a cmd.exe metacharacter so a poisoned env var can't smuggle
// `& evil.exe` into the line; fall back to the provider default rather than crash on
// a mere typo. (pexecIn itself stays general — callers may legitimately pass a
// pre-quoted path token — so the guard lives here, at the untrusted-input source.)
const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
export function safeModel(v: string | undefined, fallback: string): string;
export function safeModel(v: string | undefined, fallback: undefined): string | undefined;
export function safeModel(v: string | undefined, fallback: string | undefined): string | undefined {
  return v && MODEL_RE.test(v) ? v : fallback;
}

// --------------------------------------------------------------------------
// Provider A: headless `claude -p` CLI — billed to the user's Claude subscription
// --------------------------------------------------------------------------
class ClaudeCliProvider extends CliSynthProvider {
  readonly name = "claude-cli";
  // Default to the `haiku` alias (cheap/fast, and survives model retirements)
  // rather than a pinned dated id; override with HUNCH_SYNTH_MODEL if needed.
  private model = safeModel(process.env.HUNCH_SYNTH_MODEL, "haiku");

  async available(): Promise<boolean> {
    try {
      await pexecIn("claude", ["--version"], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  protected async run(prompt: string): Promise<string> {
    // Force SUBSCRIPTION auth: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN outrank
    // subscription OAuth in Claude Code's precedence and are *always* used in
    // headless `-p` mode when present. Strip them so the CLI falls through to
    // CLAUDE_CODE_OAUTH_TOKEN / `/login` subscription credentials. (We never
    // bill the pay-per-token API — that's the whole point of this provider.)
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    // Single-shot text synthesis: no tools, no agentic loop. The prompt carries
    // all needed context inline, so run from a neutral cwd to avoid loading this
    // repo's own hunch MCP server / CLAUDE.md on every commit (cheaper, and no
    // risk of the synthesis call recursing through the Hunch). Auth lives in the
    // user's home config, not cwd, so this doesn't affect subscription billing.
    // Prompt goes via STDIN (-p reads piped stdin), never argv — keeps untrusted
    // diff content out of any shell the spawn helper uses on Windows.
    const args = ["-p", "--output-format", "json", "--model", this.model, "--max-turns", "1"];
    const { stdout } = await pexecIn("claude", args, {
      input: prompt,
      env: childEnv,
      cwd: tmpdir(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    // Headless JSON envelope: { result, is_error, subtype, ... }. Keep the
    // parse-failure fallback (non-JSON stdout → hand it to the mapper) SEPARATE
    // from the error signal: an error envelope (max-turns/budget/exec error, which
    // also OMITS `result`) must THROW so the safe wrapper falls back — not be
    // returned as if it were assistant text. (The old single try/catch swallowed
    // its own `throw`, making the is_error guard dead code.)
    let envelope: { result?: string; is_error?: boolean; subtype?: string };
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return stdout; // not the JSON envelope — let the mapper attempt extraction
    }
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== "success")) {
      throw new Error(`claude -p reported an error${envelope.subtype ? `: ${envelope.subtype}` : ""}`);
    }
    return envelope.result ?? stdout;
  }
}

// --------------------------------------------------------------------------
// Provider B1: OpenAI Codex CLI (`codex exec`) — billed to the ChatGPT subscription
// --------------------------------------------------------------------------
class CodexCliProvider extends CliSynthProvider {
  readonly name = "codex-cli";
  private model = safeModel(process.env.HUNCH_CODEX_MODEL, undefined); // omit → codex uses its configured default

  async available(): Promise<boolean> {
    try {
      await pexecIn("codex", ["--version"], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  protected async run(prompt: string): Promise<string> {
    // `codex exec --json -` reads the prompt from STDIN (the `-`), emits JSONL
    // events. Strip OPENAI_API_KEY so it uses ChatGPT (subscription) auth, not the
    // pay-per-token API — consistent with the subscription-only rule.
    const args = ["exec", "--json", ...(this.model ? ["-m", this.model] : []), "-"];
    const out = await this.runCli("codex", args, ["OPENAI_API_KEY"], prompt);
    return extractCodexText(out);
  }
}

// --------------------------------------------------------------------------
// Provider B2: Cursor Agent CLI (`cursor-agent -p`) — billed to the Cursor subscription
// --------------------------------------------------------------------------
class CursorCliProvider extends CliSynthProvider {
  readonly name = "cursor-agent";
  private model = safeModel(process.env.HUNCH_CURSOR_MODEL, undefined);

  async available(): Promise<boolean> {
    try {
      await pexecIn("cursor-agent", ["--version"], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  protected async run(prompt: string): Promise<string> {
    // `-p --output-format text` → final answer as plain text (no event stream to
    // parse). `--trust` so it runs non-interactively. Prompt over stdin. Cursor's
    // CLI uses the user's Cursor login (subscription) — no API key to strip.
    const args = ["-p", "--output-format", "text", "--trust", ...(this.model ? ["-m", this.model] : [])];
    // Shorter timeout than the others: cursor-agent -p is reported to hang in some
    // headless setups; cap the stall before degrading to the deterministic provider.
    return this.runCli("cursor-agent", args, [], prompt, 45_000);
  }
}

// --------------------------------------------------------------------------
// Provider C: deterministic fallback (no LLM, always available)
// --------------------------------------------------------------------------
export class DeterministicProvider implements SynthProvider {
  readonly name = "deterministic";

  async available(): Promise<boolean> {
    return true;
  }

  async draftDecision(input: CommitInput): Promise<DecisionDraft> {
    const dirs = topDirs(input.files);
    const a = input.analysis;
    const summary = a ? summarizeDiff(a) : "";
    const verb = /^(add|introduce|create|feat)/i.test(input.subject) ? "introduced"
      : /^(remove|delete|drop)/i.test(input.subject) ? "removed"
      : /^(refactor|rework|restructure)/i.test(input.subject) ? "refactored"
      : "changed";

    const consequences: string[] = [];
    if (a?.addedDeps.length) consequences.push(`Adds dependency: ${a.addedDeps.join(", ")}.`);
    if (a?.removedDeps.length) consequences.push(`Drops dependency: ${a.removedDeps.join(", ")}.`);
    if (a?.removedSymbols.length) consequences.push(`Removes ${a.removedSymbols.map((s) => s.name).join(", ")} — potential breaking change for callers.`);
    if (a?.changedSymbols.length) consequences.push(`Changes ${a.changedSymbols.map((s) => s.name).join(", ")} (signature/behavior).`);

    // We extracted real structure → a bit more trustworthy than a blind heuristic.
    const informative = !!(a && (a.addedSymbols.length || a.removedSymbols.length || a.changedSymbols.length || a.addedDeps.length || a.removedDeps.length));

    return {
      title: input.subject || "Code change",
      context: [input.body, summary && `What changed: ${summary}.`].filter(Boolean).join(" ").slice(0, 500)
        || `Touched ${input.files.length} file(s) across ${dirs.join(", ") || "the repo"}.`,
      decision: summary
        ? `${cap(verb)} ${dirs.join(", ") || "the repo"}: ${summary}.`
        : `${cap(verb)} code in ${dirs.join(", ") || "the repo"} (${input.files.length} file(s)).`,
      consequences,
      alternatives_rejected: [],
      // advisory either way, but real extraction earns a touch more confidence
      confidence: informative ? 0.45 : 0.3,
      source: "inferred",
    };
  }

  async draftBug(input: FailureInput): Promise<BugDraft> {
    return {
      title: `Test failure: ${input.test}`,
      symptom: input.message.slice(0, 300),
      root_cause: input.suspects.length ? `Suspected in: ${input.suspects.join(", ")}` : "Unknown (no LLM available).",
      severity: "medium",
      confidence: 0.25,
      source: "test_failure",
    };
  }
}

/** Extract the final assistant message from `codex exec --json` output (newline-
 *  delimited JSON events). Codex tags assistant turns as `item.type ==="agent_message"`,
 *  but it ALSO emits `item.text` for reasoning and may append trailing events — so we
 *  prefer the last AGENT message and only fall back to the last any-text when none is
 *  tagged. If nothing parses, hand the raw output to the mapper (→ it finds the JSON
 *  draft or throws → deterministic fallback). Tolerant by design: drift degrades, never crashes. */
export function extractCodexText(out: string): string {
  const texts: string[] = [];
  const agentTexts: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const item = o.item as { text?: unknown; type?: unknown } | undefined;
      const cand = (item?.text ?? o.text ?? o.message) as unknown;
      if (typeof cand === "string" && cand.trim()) {
        texts.push(cand);
        const ty = (item?.type ?? o.type) as unknown;
        if (typeof ty === "string" && /agent|assistant|message\b/.test(ty) && !/reason/.test(ty)) agentTexts.push(cand);
      }
    } catch {
      /* not a JSON event line — skip */
    }
  }
  if (agentTexts.length) return agentTexts[agentTexts.length - 1]!;
  return texts.length ? texts[texts.length - 1]! : out;
}

// This registry is deliberately NOT a priority order. Auto mode only spends a
// subscription when it can identify exactly one usable CLI; see
// resolveSynthesisProvider below.
const PROVIDERS: SynthProvider[] = [
  new ClaudeCliProvider(),
  new CodexCliProvider(),
  new CursorCliProvider(),
  new DeterministicProvider(),
];

// Availability rarely changes within a process (a CLI doesn't get installed mid-run),
// and selection runs on every sync/recordFailure. Cache by object identity rather than
// name so injected test registries never inherit a stale result from another provider.
const availCache = new WeakMap<SynthProvider, Promise<boolean>>();
function isAvailable(p: SynthProvider): Promise<boolean> {
  let v = availCache.get(p);
  if (!v) {
    v = p.available().catch(() => false);
    availCache.set(p, v);
  }
  return v;
}

function isSynthPreference(value: string | undefined): value is SynthPreference {
  return !!value && (SYNTH_PREFERENCES as readonly string[]).includes(value);
}

function fallbackProvider(providers: readonly SynthProvider[]): SynthProvider {
  return providers.find((p) => p.name === "deterministic") ?? new DeterministicProvider();
}

function localPreferencePath(root: string): string {
  return join(root, ".hunch", "local.json");
}

/** Read a per-user, gitignored choice. Invalid/missing local state is treated as auto;
 * `writeSynthesisPreference` refuses to overwrite malformed data so this forgiveness
 * never destroys someone else's local settings. */
export function readSynthesisPreference(root: string): SynthPreference {
  try {
    const file = localPreferencePath(root);
    if (!existsSync(file)) return "auto";
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { synthProvider?: unknown };
    return typeof parsed.synthProvider === "string" && isSynthPreference(parsed.synthProvider)
      ? parsed.synthProvider
      : "auto";
  } catch {
    return "auto";
  }
}

/** Persist the user's provider choice only in `.hunch/local.json`, which is never a
 * repository policy. That means each developer controls their own subscription spend. */
export function writeSynthesisPreference(root: string, preference: SynthPreference): void {
  if (!isSynthPreference(preference)) throw new Error(`unknown synthesis provider preference: ${preference}`);
  const file = localPreferencePath(root);
  let local: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not an object");
        local = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`refusing to overwrite malformed local configuration: ${file}`);
      }
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ ...local, synthProvider: preference }, null, 2)}\n`);
}

async function statusesFor(providers: readonly SynthProvider[]): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = [];
  for (const provider of providers) {
    if (!(SYNTH_PROVIDER_NAMES as readonly string[]).includes(provider.name)) continue;
    const name = provider.name as SynthProviderName;
    const info = PROVIDER_INFO[name];
    statuses.push({ name, ...info, available: await isAvailable(provider) });
  }
  return statuses;
}

/** Resolve the provider without ever inferring which of several installed products is
 * the one the user intends to spend. Precedence is deliberate: a one-shell override,
 * then a per-user local preference, then safe auto-detection. */
export async function resolveSynthesisProvider(opts: ProviderSelectionOptions = {}): Promise<ProviderResolution> {
  const providers = opts.providers ?? PROVIDERS;
  const env = opts.env ?? process.env;
  const statuses = await statusesFor(providers);
  const fallback = fallbackProvider(providers);
  const find = (name: SynthProviderName): SynthProvider | undefined => providers.find((p) => p.name === name);
  const usable = async (name: SynthProviderName): Promise<SynthProvider | undefined> => {
    const provider = find(name);
    return provider && await isAvailable(provider) ? provider : undefined;
  };
  const environment = env.HUNCH_SYNTH_PROVIDER?.trim();
  if (environment && isSynthPreference(environment) && environment !== "auto") {
    const selected = await usable(environment);
    if (selected) return { provider: selected, source: "environment", preference: environment, statuses };
    return { provider: fallback, source: "unavailable-preference", preference: environment, statuses };
  }

  // `HUNCH_SYNTH_PROVIDER=auto` is useful in CI or a shell profile: it explicitly
  // suppresses the local preference and re-enters the safe auto policy.
  const preference: SynthPreference = environment === "auto"
    ? "auto"
    : opts.root ? readSynthesisPreference(opts.root) : "auto";
  if (preference !== "auto") {
    const selected = await usable(preference);
    if (selected) return { provider: selected, source: "local", preference, statuses };
    return { provider: fallback, source: "unavailable-preference", preference, statuses };
  }

  const available = statuses.filter((status) => status.name !== "deterministic" && status.available);
  if (available.length === 1) {
    const selected = await usable(available[0]!.name);
    if (selected) return { provider: selected, source: "single-available", preference, statuses };
  }
  return {
    provider: fallback,
    source: available.length > 1 ? "ambiguous" : "none",
    preference,
    statuses,
  };
}

/** The provider used by normal synthesis. See `resolveSynthesisProvider` for a
 * diagnosable result with the selection source and every candidate's availability. */
export async function selectProvider(opts: ProviderSelectionOptions = {}): Promise<SynthProvider> {
  return (await resolveSynthesisProvider(opts)).provider;
}

// ---- Deep Synthesis: ensemble of subscription CLIs ------------------------
// Opt-in (backfill/sync --deep): fan a commit out to EVERY available subscription
// CLI, drop failures, and reconcile the drafts. Subscription-only (the workers are
// the same CLI providers, so ANTHROPIC_API_KEY stripping is inherited). NEVER used on
// the guard path; confidence is capped below the strict gate so output stays advisory.

/** All available subscription-CLI workers (claude/codex/cursor), excluding the
 *  deterministic fallback — the pool Deep Synthesis fans a commit out to. */
export async function selectWorkers(opts: Pick<ProviderSelectionOptions, "providers"> = {}): Promise<SynthProvider[]> {
  const out: SynthProvider[] = [];
  for (const p of opts.providers ?? PROVIDERS) {
    if (p.name === "deterministic") continue; // workers are real subscription CLIs only
    if (await isAvailable(p)) out.push(p);
  }
  return out;
}

const tokens = (d: DecisionDraft): Set<string> =>
  new Set(`${d.title} ${d.decision}`.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);

/** Mean pairwise Jaccard overlap of the drafts' identifying text (0..1) — how much the
 *  independent workers AGREE. Drives the merged confidence. */
function meanAgreement(drafts: DecisionDraft[]): number {
  if (drafts.length < 2) return 1;
  const sets = drafts.map(tokens);
  let sum = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const a = sets[i]!, b = sets[j]!;
    let inter = 0; for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    sum += union ? inter / union : 0; pairs++; // two empty drafts don't meaningfully "agree"
  }
  return pairs ? sum / pairs : 1;
}

const dedupLines = (xs: string[]): string[] => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];

/** Reconcile N worker drafts into one. DETERMINISTIC (no second LLM call): the richest
 *  draft is the spine; alternatives/consequences are unioned; confidence is AGREEMENT-
 *  WEIGHTED and CAPPED at 0.78 — below STRICT_MIN_CONFIDENCE (0.8) — so an ensemble
 *  auto-draft can never arm enforcement. `samples`/`agreement` ride along as advisory
 *  telemetry for `hunch review` (not schema-bound). */
export function mergeDecisionDrafts(drafts: DecisionDraft[]): DecisionDraft {
  const primary = [...drafts].sort((a, b) => b.confidence - a.confidence || b.decision.length - a.decision.length)[0]!;
  const agreement = meanAgreement(drafts);
  return {
    title: primary.title,
    context: primary.context,
    decision: primary.decision,
    consequences: dedupLines(drafts.flatMap((d) => d.consequences)),
    alternatives_rejected: dedupLines(drafts.flatMap((d) => d.alternatives_rejected)),
    confidence: Math.min(0.78, 0.55 + 0.23 * agreement),
    source: "llm_draft+ensemble",
    samples: drafts.length,
    agreement: Math.round(agreement * 100) / 100,
  };
}

// Default self-consistency depth when only ONE subscription CLI is installed (the
// common case): sample it this many times and reconcile, so single-CLI users get
// ensemble-like robustness. Tunable per-call via `--samples`.
const DEFAULT_SAMPLES = 2;

export class EnsembleProvider implements SynthProvider {
  readonly name = "ensemble";
  private readonly samples: number;
  constructor(private readonly workers: SynthProvider[], opts: { samples?: number } = {}) {
    // Default 1 (single worker → passthrough); the self-consistency policy default
    // lives at the selection layer (selectEnsemble). Coerce to a finite integer in a
    // sane 1..5 band — a NaN here would make decisionTasks build ZERO tasks and throw,
    // silently collapsing --deep to the deterministic fallback (callers also sanitize).
    const n = Math.trunc(Number(opts.samples));
    this.samples = Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 1;
  }
  async available(): Promise<boolean> { return this.workers.length > 0; }

  /** The draft tasks to fan out: one per distinct CLI when several are installed
   *  (cross-model ensemble), else N self-consistency samples of the single CLI. */
  private decisionTasks(input: CommitInput): Array<() => Promise<DecisionDraft>> {
    if (this.workers.length >= 2) return this.workers.map((w) => () => w.draftDecision(input));
    const w = this.workers[0]!;
    return Array.from({ length: this.samples }, () => () => w.draftDecision(input));
  }

  async draftDecision(input: CommitInput): Promise<DecisionDraft> {
    if (!this.workers.length) throw new Error("ensemble: no subscription CLI workers available");
    const settled = await Promise.allSettled(this.decisionTasks(input).map((t) => t()));
    const drafts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (!drafts.length) throw new Error("ensemble: all workers failed");
    return drafts.length === 1 ? drafts[0]! : mergeDecisionDrafts(drafts);
  }

  async draftBug(input: FailureInput): Promise<BugDraft> {
    // Bug ensembling is deferred — use the first worker that succeeds.
    for (const w of this.workers) {
      try { return await w.draftBug(input); } catch { /* try next */ }
    }
    throw new Error("ensemble: all workers failed for bug");
  }
}

/** Build the Deep-Synthesis provider, or null if no subscription CLI is available
 *  (the caller then falls back to the normal single-provider path). `samples` sets
 *  the self-consistency depth for the single-CLI case. */
export async function selectEnsemble(opts: { samples?: number; providers?: readonly SynthProvider[] } = {}): Promise<EnsembleProvider | null> {
  const workers = await selectWorkers(opts);
  // The self-consistency policy default (DEFAULT_SAMPLES) is applied HERE, not in the
  // provider — so a single CLI under --deep is sampled N times, while direct
  // construction stays passthrough. `--samples 1` opts back out.
  return workers.length ? new EnsembleProvider(workers, { samples: opts.samples ?? DEFAULT_SAMPLES }) : null;
}

/** Pick a CLI provider to run the Critic pass (subscription-only, like the workers).
 *  Returns null when no assistant CLI is installed — verification then no-ops and the
 *  un-audited draft stands (graceful degradation; dec_18a81c8291). */
export async function selectVerifier(opts: ProviderSelectionOptions = {}): Promise<SynthProvider | null> {
  const { provider } = await resolveSynthesisProvider(opts);
  return provider.name === "deterministic" ? null : provider;
}

// ---- Verification (the Critic pass) ---------------------------------------
// Audit a draft against the commit it came from, then PRUNE unsupported
// alternatives/consequences and LOWER confidence on weak grounding. It may only
// reduce trust, never raise it past the cap — auto-drafts stay advisory and a human
// `hunch review --accept` remains the ONLY path to enforcement (dec_9a2f2fe72a).

const VERIFY_SYSTEM = `You are a skeptical auditor for an Engineering Memory OS. You are given a
synthesized decision record and the ACTUAL commit it was derived from. Your job is to
flag everything the record asserts that the evidence does NOT support — be strict; when
in doubt, flag it. Do not invent new content; only judge what is present.`;

function verifyPrompt(input: CommitInput, draft: DecisionDraft): string {
  const alts = draft.alternatives_rejected.length
    ? draft.alternatives_rejected.map((a, i) => `  ${i + 1}. ${a}`).join("\n")
    : "  (none)";
  const cons = draft.consequences.length ? draft.consequences.map((c) => `  - ${c}`).join("\n") : "  (none)";
  return [
    `COMMIT SUBJECT: ${input.subject}`,
    input.body ? `COMMIT BODY:\n${input.body}` : "",
    input.analysis ? `STRUCTURED CHANGES: ${summarizeDiff(input.analysis)}` : "",
    renderDiff(input),
    `CANDIDATE DECISION UNDER AUDIT:`,
    `  decision: ${draft.decision}`,
    `  consequences:\n${cons}`,
    `  alternatives_rejected:\n${alts}`,
    `\nReturn grounded (0..1) and the VERBATIM alternatives_rejected / consequences the evidence does NOT support.`,
  ].filter(Boolean).join("\n\n");
}

const RELEVANCE_SYSTEM = `You are a strict curator for an Engineering Memory OS. You are given ONE auto-drafted
decision and a list of decisions ALREADY in the graph. Decide if the draft is worth keeping:
a REAL, reusable design choice (an architectural or policy decision a future engineer would
want to know). Mark it NOT relevant if it merely restates what the diff mechanically did, is
trivial/obvious, or is a near-duplicate of an existing decision (name that decision's id in
duplicate_of). When genuinely unsure, keep it (relevant=true, low confidence) — deletion is
destructive.`;

function relevancePrompt(draft: Decision, existing: ExistingDecisionRef[]): string {
  const ex = existing.length
    ? existing.map((e) => `  ${e.id}: ${e.title} — ${e.decision.slice(0, 160)}`).join("\n")
    : "  (none)";
  return [
    `DRAFT UNDER REVIEW (id ${draft.id}):`,
    `  title: ${draft.title}`,
    `  decision: ${(draft.decision ?? "").slice(0, 800)}`,
    (draft.alternatives_rejected ?? []).length ? `  alternatives_rejected:\n${(draft.alternatives_rejected ?? []).map((a) => `    - ${a}`).join("\n")}` : "",
    (draft.related_files ?? []).length ? `  related_files: ${(draft.related_files ?? []).join(", ")}` : "",
    `\nEXISTING DECISIONS (candidates for duplicate_of):\n${ex}`,
    `\nReturn relevant, confidence (0..1), duplicate_of (an existing id or null), and a one-line reason.`,
  ].filter(Boolean).join("\n\n");
}

/** Map model text → RelevanceVerdict, or null when nothing usable parses (→ the
 *  caller keeps the draft for a human). Tolerant of missing/loose fields. */
export function relevanceFromText(text: string): RelevanceVerdict | null {
  for (const obj of extractJsonObjects(text)) {
    if (typeof obj.relevant !== "boolean") continue; // the one required signal
    const dup = typeof obj.duplicate_of === "string" && obj.duplicate_of.trim() ? obj.duplicate_of.trim() : null;
    const conf = typeof obj.confidence === "number" ? clamp01(obj.confidence) : 0.5;
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    return { relevant: obj.relevant, confidence: conf, duplicate_of: dup, reason };
  }
  return null;
}

/** Map model text → VerifyVerdict, or null when nothing usable parses (→ the caller
 *  keeps the un-audited draft). Tolerant of arrays-as-strings and missing fields. */
export function verdictFromText(text: string): VerifyVerdict | null {
  for (const obj of extractJsonObjects(text)) {
    const hasGrounded = typeof obj.grounded === "number";
    const ua = asStrArr(obj.unsupported_alternatives);
    const uc = asStrArr(obj.unsupported_claims);
    if (!hasGrounded && !ua.length && !uc.length) continue; // unrelated object
    const grounded = typeof obj.grounded === "number" ? clamp01(obj.grounded) : 1;
    return { grounded, unsupported_alternatives: ua, unsupported_claims: uc };
  }
  return null;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** True if `flagged` names `entry` — exact normalized match, or a substantial
 *  (≥8 char) containment either way, to absorb minor rewording by the auditor
 *  without nuking unrelated entries. */
function flaggedMatches(entry: string, flagged: string[]): boolean {
  const e = norm(entry);
  if (!e) return false;
  return flagged.some((f) => {
    const n = norm(f);
    if (!n) return false;
    if (n === e) return true;
    return n.length >= 8 && e.length >= 8 && (e.includes(n) || n.includes(e));
  });
}

/** Apply a verdict to a draft: drop unsupported alternatives (so they never scaffold
 *  tripwires) and consequences, and scale confidence DOWN by grounding. Confidence is
 *  clamped so it can only fall — verification never arms a stronger claim than the
 *  draft already made (R2). Records `grounded` as advisory telemetry. */
export function applyVerdict(draft: DecisionDraft, v: VerifyVerdict): DecisionDraft {
  const alternatives_rejected = draft.alternatives_rejected.filter((a) => !flaggedMatches(a, v.unsupported_alternatives));
  const consequences = draft.consequences.filter((c) => !flaggedMatches(c, v.unsupported_claims));
  // The Critic's visible value: how many unsupported items it removed (alternatives
  // never become tripwires; consequences never mislead). Surfaced in `hunch review`.
  const pruned = (draft.alternatives_rejected.length - alternatives_rejected.length) + (draft.consequences.length - consequences.length);
  const grounded = clamp01(v.grounded);
  // Penalize weak grounding; (0.5 + 0.5*grounded) ∈ [0.5,1], so this only lowers.
  const confidence = Math.min(draft.confidence, Math.round(draft.confidence * (0.5 + 0.5 * grounded) * 100) / 100);
  const source = draft.source.includes("verified") ? draft.source : `${draft.source}+verified`;
  return { ...draft, alternatives_rejected, consequences, confidence, grounded, source, verifyOutcome: "applied", pruned };
}

/** Run the Critic pass and apply it, degrading to the un-audited draft when the
 *  provider can't verify (deterministic / no CLI) or the call keeps failing. Never
 *  throws. Marks the OUTCOME on the draft (applied / unavailable / failed) so the
 *  degradation is visible in telemetry instead of silent. Retries once: under --deep
 *  the Critic call stacks after sampling, and a single transient failure on that
 *  extra call shouldn't drop the audit. */
export async function verifyDecisionSafe(verifier: SynthProvider | null, input: CommitInput, draft: DecisionDraft): Promise<DecisionDraft> {
  if (!verifier?.verifyDecision) return { ...draft, verifyOutcome: "unavailable" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return applyVerdict(draft, await verifier.verifyDecision(input, draft));
    } catch {
      /* transient (network / unparseable verdict) — retry once, then give up */
    }
  }
  return { ...draft, verifyOutcome: "failed" };
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1);

// ---- prompt + parsing helpers --------------------------------------------

// Above this size we stop shipping the raw patch and lean on the deterministic
// STRUCTURED CHANGES summary + a small sample. A truncated head-slice of a giant
// diff is an arbitrary fragment; the summary describes the WHOLE change for far
// fewer tokens. (Draft confidence is haircut when this path is taken — see
// ClaudeCliProvider.draftDecision.)
const LARGE_DIFF_CHARS = 20_000;
const DIFF_SAMPLE_CHARS = 6_000;

/** The DIFF section of the commit prompt: the full patch for normal commits, or
 *  (for a large diff) a small sample with a pointer to STRUCTURED CHANGES. */
function renderDiff(input: CommitInput): string {
  if (input.diff.length <= LARGE_DIFF_CHARS) return `DIFF:\n${input.diff}`;
  return `DIFF (large patch — first ${DIFF_SAMPLE_CHARS} of ${input.diff.length} chars; rely on STRUCTURED CHANGES above for the rest):\n${input.diff.slice(0, DIFF_SAMPLE_CHARS)}`;
}

function commitPrompt(input: CommitInput): string {
  return [
    `COMMIT SUBJECT: ${input.subject}`,
    input.body ? `COMMIT BODY:\n${input.body}` : "",
    input.analysis ? `STRUCTURED CHANGES: ${summarizeDiff(input.analysis)}` : "",
    `FILES CHANGED (${input.files.length}):\n${input.files.slice(0, 40).join("\n")}`,
    renderDiff(input),
    `\nDistill the single most important design decision this commit represents.`,
  ].filter(Boolean).join("\n\n");
}

function failurePrompt(input: FailureInput): string {
  return [
    `FAILING TEST: ${input.test}`,
    `FAILURE MESSAGE:\n${input.message.slice(0, 2000)}`,
    input.suspects.length ? `SUSPECT SYMBOLS (ranked by churn×recency×fan-in):\n${input.suspects.join("\n")}` : "",
    input.recentDiff ? `RECENT DIFF:\n${input.recentDiff.slice(0, 8000)}` : "",
    `\nDraft a Bug record: symptom, best-hypothesis root cause (mark uncertainty), severity.`,
  ].filter(Boolean).join("\n\n");
}

function jsonInstruction(schema: object): string {
  return `Respond with ONLY a single JSON object matching this schema (no prose, no code fence):\n${JSON.stringify(schema)}`;
}

/** Index of the `}` that closes the balanced object opened at `start`, or -1.
 *  String-aware: braces and quotes INSIDE a JSON string literal don't count, so
 *  `{"context":"closes the } brace"}` balances whole (a naive depth counter
 *  closes early on the inner `}`). */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1; // never balanced (e.g. truncated output)
}

/** True if the `{` at `start` begins something that looks like a JSON object —
 *  the next non-space char is a `"` (a quoted key) or `}` (empty object). Lets us
 *  tell a real, possibly-truncated JSON object from a stray PROSE brace such as
 *  `interface Foo {`, `() => {`, or `{set}` (whose next char is a letter). */
function looksLikeJsonObject(text: string, start: number): boolean {
  let j = start + 1;
  while (j < text.length && /\s/.test(text[j]!)) j++;
  return j < text.length && (text[j] === '"' || text[j] === "}");
}

/** Every balanced top-level `{...}` slice in `text`, in order. A brace that does
 *  NOT look like a JSON opener (a prose brace) is SKIPPED and the scan continues,
 *  so junk before the answer never hides the object that follows. But a brace that
 *  looks like JSON yet never closes is a TRUNCATED object — we stop there rather
 *  than descend into it, which would surface a nested child as a fake top-level
 *  answer (`{"decision":"REAL","meta":{...}` must not leak the inner `meta`). */
function topLevelJsonSlices(text: string): string[] {
  const slices: string[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf("{", i);
    if (start < 0) break;
    if (!looksLikeJsonObject(text, start)) {
      i = start + 1; // prose brace (`interface Foo {`, `{set}`) — skip, keep scanning
      continue;
    }
    const end = balancedEnd(text, start);
    if (end < 0) break; // a JSON-looking object that never closes → truncated tail
    slices.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return slices;
}

/** Strip trailing commas (`,}` / `,]`) WITHOUT touching string contents — the
 *  single most common reason a model's near-valid JSON fails strict parse. A
 *  blanket regex would also eat a comma that legitimately lives inside a string
 *  value (e.g. "see {a, b, }"), silently corrupting the captured text, so this
 *  reuses the same in-string/escape state machine as the slicer. */
function stripTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let k = i + 1;
      while (k < s.length && /\s/.test(s[k]!)) k++;
      if (k < s.length && (s[k] === "}" || s[k] === "]")) continue; // drop the comma
    }
    out += ch;
  }
  return out;
}

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Strict JSON first, then one string-aware lenient pass (trailing commas). */
function parseObjectLoose(slice: string): Record<string, unknown> | null {
  return tryParseObject(slice) ?? tryParseObject(stripTrailingCommas(slice));
}

/** Every parseable top-level JSON object in arbitrary model text, in order. */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  return topLevelJsonSlices(text)
    .map(parseObjectLoose)
    .filter((o): o is Record<string, unknown> => o !== null);
}

/** Convenience: the FIRST parseable top-level object, or null. (The mappers below
 *  do their own content-based selection; this is just a generic accessor.) */
export function extractJson(text: string): Record<string, unknown> | null {
  return extractJsonObjects(text)[0] ?? null;
}

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SEV_RANK: Record<BugDraft["severity"], number> = { low: 1, medium: 2, high: 3, critical: 4 };
function asSeverity(v: unknown): BugDraft["severity"] | null {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v) ? (v as BugDraft["severity"]) : null;
}

/** Values a model emits as a fill-in TEMPLATE rather than a real answer. We can't
 *  use position (a template/recap may lead OR trail the answer), so we recognize
 *  placeholder-shaped values and treat the field as empty. Kept deliberately narrow
 *  so a terse REAL answer isn't mistaken for a template: an angle-bracket value only
 *  counts if it's a short metavariable (≤2 words, e.g. `<what>`, `<best hypothesis>`)
 *  — not a bracketed sentence — and the word list holds only unambiguous markers. */
function isPlaceholder(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^\.{2,}$/.test(t)) return true; // "..", "..."
  const meta = /^<(.+)>$/.exec(t);
  if (meta && meta[1]!.trim().split(/\s+/).length <= 2) return true; // <what>, <best hypothesis>
  return ["see above", "recap", "placeholder"].includes(t.toLowerCase());
}

/** A string field, blanked when empty OR a template placeholder. */
function realStr(v: unknown): string {
  const s = str(v, "");
  return s && !isPlaceholder(s) ? s : "";
}

/** Map model text → DecisionDraft, or null when there's nothing usable to keep.
 *  Null (not a hollow draft) is the signal for the caller to fall back to the
 *  deterministic provider — we only claim "llm_draft" when the LLM actually
 *  produced substance. The model is asked for ONE object; if it emits several (a
 *  template/example plus the answer), take the FIRST with real (non-placeholder)
 *  substance — robust whether the junk leads or trails the answer. */
export function decisionDraftFromText(text: string, fallbackTitle: string): DecisionDraft | null {
  const candidates: Array<{ obj: Record<string, unknown>; decision: string; context: string; nontrivial: boolean }> = [];
  for (const obj of extractJsonObjects(text)) {
    const decision = realStr(obj.decision);
    const context = realStr(obj.context);
    if (!decision && !context) continue; // template / placeholder / unrelated object
    // Coerce explicitly: a model may emit the boolean as the string "false",
    // which is JS-truthy — keying confidence off raw truthiness would invert it.
    const nontrivial = obj.nontrivial === true || obj.nontrivial === "true";
    candidates.push({ obj, decision, context, nontrivial });
  }
  if (!candidates.length) return null;
  // Prefer the object the model FLAGGED as a real decision over a generic worked
  // example that may precede it; else the first substantive object.
  const pick = candidates.find((c) => c.nontrivial) ?? candidates[0]!;
  return {
    title: realStr(pick.obj.title) || fallbackTitle,
    context: pick.context,
    decision: pick.decision,
    consequences: asStrArr(pick.obj.consequences),
    alternatives_rejected: asStrArr(pick.obj.alternatives_rejected),
    confidence: pick.nontrivial ? 0.65 : 0.4,
    source: "llm_draft",
  };
}

/** Map model text → BugDraft, or null. A root_cause is the LLM's full value-add;
 *  a deliberate non-"medium" severity is worth keeping on its own (it carries the
 *  LLM's classification into the bug record rather than the deterministic "medium").
 *  Pick the BEST candidate object — most substantiated (root-caused) then most
 *  severe — NOT the positionally first/last, so a trailing low-severity recap can't
 *  downgrade a real critical finding. Without a root_cause the draft is labeled
 *  honestly as partial at lower confidence; constraint promotion is gated on a real
 *  root_cause downstream (see shouldPromoteConstraint), so a bare severity label
 *  preserves its signal in the record without auto-minting an invariant. */
export function bugDraftFromText(text: string, fallbackTitle: string, fallbackSymptom: string): BugDraft | null {
  let best: { obj: Record<string, unknown>; root_cause: string; severity: BugDraft["severity"] | null } | null = null;
  let bestScore = -1;
  for (const obj of extractJsonObjects(text)) {
    const root_cause = realStr(obj.root_cause);
    const severity = asSeverity(obj.severity);
    const deliberate = severity !== null && severity !== "medium";
    if (!root_cause && !deliberate) continue; // only echoes the input → not a candidate
    const score = (root_cause ? 100 : 0) + (severity ? SEV_RANK[severity] : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { obj, root_cause, severity };
    }
  }
  if (!best) return null;
  const full = !!best.root_cause;
  return {
    title: realStr(best.obj.title) || fallbackTitle,
    symptom: realStr(best.obj.symptom) || fallbackSymptom,
    root_cause: best.root_cause,
    severity: best.severity ?? "medium",
    confidence: full ? 0.55 : 0.4,
    source: full ? "test_failure+llm" : "test_failure+llm_partial",
  };
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}
function topDirs(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    set.add(parts.length > 1 ? parts.slice(0, 2).join("/") : parts[0] ?? f);
  }
  return [...set].slice(0, 6);
}
function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
