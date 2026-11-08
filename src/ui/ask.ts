/**
 * `hunch ui`: who can be asked to think a question through (the board and the grill), and the
 * memory a question is grounded in. Asking never writes memory: a person's click does that.
 *
 * Only subscription CLIs can be asked (con_2ce3f2a547), through the same guarded providers as
 * synthesis, so API keys are stripped and the prompt travels on stdin. Local-only mode still
 * wins, and a UI started from inside an agent session stays on that agent's account.
 *
 * Memory is repository text a stranger's pull request can write, so an assistant runs with its
 * tools off or isn't offered. Cursor Agent has no such mode (Hunch launches it with --trust), and
 * Codex's read-only sandbox still leaves it the shell tool, MCP servers and web search.
 */
import { claudeOnSubscription, resolveSynthesisProvider, type ProviderSelectionOptions, type ProviderStatus } from "../synthesis/provider.js";
import { detectInitiator, withInitiator } from "../synthesis/initiator.js";
import { memoryDetail, memoryItems, overlaps, type MemoryDetail, type MemorySource } from "./model.js";

export const MAX_QUESTION = 2000;
const MAX_RELATED = 7;
const MAX_FIELD = 800;
const MAX_FILES = 10;
/** Characters of memory in one prompt. The memory asked about is always sent. */
const MAX_CONTEXT = 16_000;

export interface Assistant { name: string; label: string }
/** Why nobody can be asked: local-only analysis is on, `hunch provider` names someone who can't
 *  be asked, this UI's origin can't pick an account, Claude Code isn't on a subscription, or its
 *  login check didn't answer in time (so whether it is can't be confirmed). */
export type AskBlock = "local-only" | "other-provider" | "unknown-origin" | "not-subscription" | "subscription-unknown";
/** The CLIs that can run with no tools (ProseOptions.noTools). */
const ASKABLE = new Set(["claude-cli"]);
export interface AskRunner {
  assistants(): Promise<{ assistants: Assistant[]; blocked: AskBlock | null }>;
  /** The assistant's raw reply. Throws when it can't answer. */
  ask(assistant: string, prompt: string): Promise<string>;
}

/** Who this UI may ask. A person who ran `hunch ui` picks per question; a UI started from an agent
 *  session stays on that agent's account, and an unknown or ambiguous origin asks nobody. */
export function askableAssistants(statuses: readonly ProviderStatus[], env: NodeJS.ProcessEnv): Assistant[] | null {
  const origin = detectInitiator(env);
  if (!origin.provider && (origin.source !== "unknown" || env.HUNCH_INITIATOR === "unknown")) return null;
  return statuses
    .filter((s) => s.available && s.subscription !== null && ASKABLE.has(s.name) && (!origin.provider || s.name === origin.provider))
    .map((s) => ({ name: s.name, label: s.label }));
}

export function defaultAskRunner(root: string, opts: Pick<ProviderSelectionOptions, "env" | "providers"> & { subscribed?: () => Promise<boolean | null> } = {}): AskRunner {
  const env = opts.env ?? process.env;
  const subscribed = opts.subscribed ?? (() => claudeOnSubscription(env));
  const assistants: AskRunner["assistants"] = async () => {
    const { preference, statuses } = await resolveSynthesisProvider({ root, ...opts });
    if (preference === "deterministic") return { assistants: [], blocked: "local-only" };
    const askable = askableAssistants(statuses, env);
    if (!askable) return { assistants: [], blocked: "unknown-origin" };
    // A named `hunch provider` is the person's own spending choice: the pick stays within it.
    const listed = preference === "auto" ? askable : askable.filter((a) => a.name === preference);
    if (preference !== "auto" && !listed.length) return { assistants: [], blocked: "other-provider" };
    // Only claude-cli is askable. `ask` comes through here too, so this holds at the spend.
    if (listed.length) {
      const on = await subscribed();
      if (on === null) return { assistants: [], blocked: "subscription-unknown" };
      if (!on) return { assistants: [], blocked: "not-subscription" };
    }
    return { assistants: listed, blocked: null };
  };
  return {
    assistants,
    // The person's pick is this operation's origin, so the resolver and the provider's own
    // account guard both hold it to that one assistant. That makes this the spend, so the
    // check of who may be asked lives here.
    async ask(assistant, prompt) {
      if (!(await assistants()).assistants.some((a) => a.name === assistant)) throw new Error("it is not available");
      return withInitiator({ provider: assistant, source: "explicit" }, async () => {
        const { provider, source } = await resolveSynthesisProvider({ root, ...opts });
        if (source !== "initiator" || provider.name !== assistant || !provider.draftProse) throw new Error("it is not available");
        return provider.draftProse(prompt, { noTools: true });
      });
    },
  };
}

// Asking words: they match memory without saying what it's about, and matched memory leaves the machine.
const COMMON = new Set(["about", "also", "could", "does", "from", "have", "into", "keep", "make", "more", "need", "should", "than", "that", "their", "them", "then", "there", "these", "they", "this", "want", "what", "when", "where", "which", "will", "with", "would", "your"]);
export const words = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).filter((w) => !COMMON.has(w)));

/** The memory a question is grounded in: what it's about, then active memory that shares its
 *  feature or files, or the question's words. Nothing matched means no memory, not a guess. */
export function askContext(src: MemorySource, question: string, about: string | null): MemoryDetail[] {
  const focus = about ? memoryDetail(src, about) : null;
  const asked = words(question);
  const related = memoryItems(src)
    .filter((m) => m.active && m.id !== about)
    .map((m) => {
      let score = 0;
      if (focus?.feature && m.feature === focus.feature) score += 100;
      if (focus && m.files.some((f) => focus.files.some((g) => overlaps(f, g)))) score += 10;
      const text = words(`${m.title} ${m.summary} ${m.feature ?? ""}`);
      for (const w of asked) if (text.has(w)) score += 1;
      return { id: m.id, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_RELATED);
  const details = related.map((m) => memoryDetail(src, m.id)).filter((m): m is MemoryDetail => m !== null);
  return focus ? [focus, ...details] : details;
}

function record(m: MemoryDetail): Record<string, unknown> {
  const cut = (t: string): string => t.slice(0, MAX_FIELD);
  return {
    id: m.id, kind: m.kind, title: cut(m.title), status: m.status, feature: m.feature, files: m.files.slice(0, MAX_FILES).map(cut),
    sections: m.sections
      .filter((s) => (s.items ? s.items.length : s.text))
      .map((s) => (s.items ? { label: s.label, items: s.items.slice(0, MAX_FILES).map(cut) } : { label: s.label, text: cut(s.text!) })),
  };
}

/** The memory that fits in one prompt, each as one JSON line. The first always does. */
export function fitMemory(memory: readonly MemoryDetail[]): { used: MemoryDetail[]; records: string[] } {
  const used: MemoryDetail[] = [];
  const records: string[] = [];
  let size = 0;
  for (const m of memory) {
    const json = JSON.stringify(record(m));
    if (used.length && size + json.length > MAX_CONTEXT) break;
    used.push(m); records.push(json); size += json.length;
  }
  return { used, records };
}
