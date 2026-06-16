/**
 * Pluggable synthesis provider for the WRITE path (DESIGN.md §4 / §7).
 *
 * LLM synthesis is driven by the user's Claude **subscription** via the `claude`
 * CLI — never the pay-per-token Anthropic API. We try, in order:
 * claude-cli → deterministic-fallback. The fallback always works (no creds, no
 * network) and emits a LOW-confidence draft, honoring the design rule that
 * auto-captured memory is advisory and cheap to discard.
 *
 * Subscription, not API: Claude Code's auth precedence puts `ANTHROPIC_API_KEY`
 * (and `ANTHROPIC_AUTH_TOKEN`) ABOVE subscription OAuth, and in headless `-p`
 * mode the API key is *always* used when present. So we strip those vars from
 * the child env (see ClaudeCliProvider.run) to force the CLI down to subscription
 * OAuth / CLAUDE_CODE_OAUTH_TOKEN. There is intentionally NO API-key provider.
 *
 * Every provider returns the same shape so the rest of the system never knows
 * (or cares) which one ran.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { summarizeDiff, type DiffAnalysis } from "../extractors/diff.js";

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
}

export interface BugDraft {
  title: string;
  symptom: string;
  root_cause: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;
  source: string;
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
}

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

// --------------------------------------------------------------------------
// Base for headless-CLI SUBSCRIPTION providers. Each one drives a coding-assistant
// CLI billed to the user's own subscription (never a pay-per-token API key — see
// dec_5a7c0733f7). The prompt always goes over STDIN (never argv — keeps untrusted
// diff content out of any shell pexecIn uses on Windows), and the CLI's text output
// is handed to the SAME mappers, so the rest of the system is provider-agnostic.
// --------------------------------------------------------------------------
abstract class CliSynthProvider implements SynthProvider {
  abstract readonly name: string;
  abstract available(): Promise<boolean>;
  protected abstract run(prompt: string): Promise<string>;

  /** Run a CLI with the prompt on stdin, stripping API-key env vars so the tool
   *  falls through to its SUBSCRIPTION credentials. Shared by codex/cursor. */
  protected async runCli(bin: string, args: string[], stripEnv: string[], prompt: string): Promise<string> {
    const env = { ...process.env };
    for (const k of stripEnv) delete env[k];
    const { stdout } = await pexecIn(bin, args, {
      input: prompt,
      env,
      cwd: tmpdir(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
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
}

// --------------------------------------------------------------------------
// Provider A: headless `claude -p` CLI — billed to the user's Claude subscription
// --------------------------------------------------------------------------
class ClaudeCliProvider extends CliSynthProvider {
  readonly name = "claude-cli";
  // Default to the `haiku` alias (cheap/fast, and survives model retirements)
  // rather than a pinned dated id; override with HUNCH_SYNTH_MODEL if needed.
  private model = process.env.HUNCH_SYNTH_MODEL || "haiku";

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
  private model = process.env.HUNCH_CODEX_MODEL; // omit → codex uses its configured default

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
  private model = process.env.HUNCH_CURSOR_MODEL;

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
    return this.runCli("cursor-agent", args, [], prompt);
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
 *  delimited JSON events). We take the LAST non-empty text we can find at the
 *  shapes codex uses (item.text / text / message); if none parse, hand the raw
 *  output to the mapper — which then either finds the JSON draft or throws (→
 *  deterministic fallback). Tolerant by design: a schema drift degrades, never crashes. */
export function extractCodexText(out: string): string {
  const texts: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const item = o.item as { text?: unknown } | undefined;
      const cand = (item?.text ?? o.text ?? o.message) as unknown;
      if (typeof cand === "string" && cand.trim()) texts.push(cand);
    } catch {
      /* not a JSON event line — skip */
    }
  }
  return texts.length ? texts[texts.length - 1]! : out;
}

// Priority order: try each subscription CLI, then the always-available heuristic.
// HUNCH_SYNTH_PROVIDER forces one by name (claude-cli / codex-cli / cursor-agent /
// deterministic).
const PROVIDERS: SynthProvider[] = [
  new ClaudeCliProvider(),
  new CodexCliProvider(),
  new CursorCliProvider(),
  new DeterministicProvider(),
];

/** Choose the first available provider, honoring HUNCH_SYNTH_PROVIDER override. */
export async function selectProvider(): Promise<SynthProvider> {
  const forced = process.env.HUNCH_SYNTH_PROVIDER;
  if (forced) {
    const p = PROVIDERS.find((x) => x.name === forced);
    if (p && (await p.available())) return p;
  }
  for (const p of PROVIDERS) {
    try {
      if (await p.available()) return p;
    } catch {
      /* try next */
    }
  }
  return new DeterministicProvider();
}

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
