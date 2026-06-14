/**
 * Pluggable synthesis provider for the WRITE path (DESIGN.md §4 / §7).
 *
 * The runtime may have an Anthropic API key, the `claude` CLI, or neither. We
 * try, in order: anthropic-sdk → claude-cli → deterministic-fallback. The
 * fallback always works (no creds) and emits a LOW-confidence draft, honoring
 * the design rule that auto-captured memory is advisory and cheap to discard.
 *
 * Every provider returns the same shape so the rest of the system never knows
 * (or cares) which one ran.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

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
// Provider A: Anthropic SDK (structured output via forced tool use)
// --------------------------------------------------------------------------
class AnthropicProvider implements SynthProvider {
  readonly name = "anthropic-sdk";
  private model = process.env.BRAIN_SYNTH_MODEL || "claude-haiku-4-5-20251001";

  async available(): Promise<boolean> {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  private async call(system: string, prompt: string, tool: typeof DECISION_TOOL): Promise<Record<string, unknown>> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const res = await client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    });
    for (const block of res.content) {
      if (block.type === "tool_use") return block.input as Record<string, unknown>;
    }
    throw new Error("anthropic: no tool_use block in response");
  }

  async draftDecision(input: CommitInput): Promise<DecisionDraft> {
    const out = await this.call(SYSTEM, commitPrompt(input), DECISION_TOOL);
    return {
      title: String(out.title ?? input.subject),
      context: String(out.context ?? ""),
      decision: String(out.decision ?? ""),
      consequences: asStrArr(out.consequences),
      alternatives_rejected: asStrArr(out.alternatives_rejected),
      confidence: out.nontrivial ? 0.7 : 0.45,
      source: "llm_draft",
    };
  }

  async draftBug(input: FailureInput): Promise<BugDraft> {
    const out = await this.call(SYSTEM, failurePrompt(input), BUG_TOOL as never);
    return {
      title: String(out.title ?? input.test),
      symptom: String(out.symptom ?? input.message),
      root_cause: String(out.root_cause ?? ""),
      severity: (["low", "medium", "high", "critical"].includes(String(out.severity)) ? out.severity : "medium") as BugDraft["severity"],
      confidence: 0.6,
      source: "test_failure+llm",
    };
  }
}

// --------------------------------------------------------------------------
// Provider B: headless `claude -p` CLI
// --------------------------------------------------------------------------
class ClaudeCliProvider implements SynthProvider {
  readonly name = "claude-cli";
  private model = process.env.BRAIN_SYNTH_MODEL;

  async available(): Promise<boolean> {
    try {
      await pexec("claude", ["--version"], { timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  private async run(prompt: string): Promise<string> {
    const args = ["-p", prompt, "--output-format", "json"];
    if (this.model) args.push("--model", this.model);
    const { stdout } = await pexec("claude", args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    // headless JSON envelope: { result: "<assistant text>", ... }
    try {
      const env = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (env.is_error) throw new Error("claude -p reported an error");
      return env.result ?? stdout;
    } catch {
      return stdout;
    }
  }

  async draftDecision(input: CommitInput): Promise<DecisionDraft> {
    const text = await this.run(`${SYSTEM}\n\n${commitPrompt(input)}\n\n${jsonInstruction(DECISION_TOOL.input_schema)}`);
    const obj = extractJson(text);
    return {
      title: str(obj.title, input.subject),
      context: str(obj.context, ""),
      decision: str(obj.decision, ""),
      consequences: asStrArr(obj.consequences),
      alternatives_rejected: asStrArr(obj.alternatives_rejected),
      confidence: obj.nontrivial ? 0.65 : 0.4,
      source: "llm_draft",
    };
  }

  async draftBug(input: FailureInput): Promise<BugDraft> {
    const text = await this.run(`${SYSTEM}\n\n${failurePrompt(input)}\n\n${jsonInstruction(BUG_TOOL.input_schema)}`);
    const obj = extractJson(text);
    return {
      title: str(obj.title, input.test),
      symptom: str(obj.symptom, input.message),
      root_cause: str(obj.root_cause, ""),
      severity: (["low", "medium", "high", "critical"].includes(String(obj.severity)) ? obj.severity : "medium") as BugDraft["severity"],
      confidence: 0.55,
      source: "test_failure+llm",
    };
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
    const verb = /^(add|introduce|create)/i.test(input.subject) ? "introduced"
      : /^(remove|delete|drop)/i.test(input.subject) ? "removed"
      : /^(refactor|rework|restructure)/i.test(input.subject) ? "refactored"
      : "changed";
    return {
      title: input.subject || "Code change",
      context: input.body
        ? input.body.slice(0, 400)
        : `Touched ${input.files.length} file(s) across ${dirs.join(", ") || "the repo"}.`,
      decision: `${cap(verb)} code in ${dirs.join(", ") || "the repo"} (${input.files.length} file(s)).`,
      consequences: [],
      alternatives_rejected: [],
      // low confidence: heuristic only, advisory + cheap to discard / confirm later
      confidence: 0.3,
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

const PROVIDERS: SynthProvider[] = [new AnthropicProvider(), new ClaudeCliProvider(), new DeterministicProvider()];

/** Choose the first available provider, honoring BRAIN_SYNTH_PROVIDER override. */
export async function selectProvider(): Promise<SynthProvider> {
  const forced = process.env.BRAIN_SYNTH_PROVIDER;
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

function commitPrompt(input: CommitInput): string {
  return [
    `COMMIT SUBJECT: ${input.subject}`,
    input.body ? `COMMIT BODY:\n${input.body}` : "",
    `FILES CHANGED (${input.files.length}):\n${input.files.slice(0, 40).join("\n")}`,
    `DIFF:\n${input.diff.slice(0, 20000)}`,
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

/** Pull the first balanced JSON object out of arbitrary model text. */
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start < 0) return {};
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return {};
        }
      }
    }
  }
  return {};
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
