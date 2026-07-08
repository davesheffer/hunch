/**
 * Verification pipeline (the "enforcement spine"): hooks that guarantee the
 * operating loop — evidence → change → verify → attack → report — instead of
 * hoping the agent reads a skill. Measured motivation (2026-07-08 zod bench):
 * skills-as-files were read in 0/20 sessions; when the same content was
 * guaranteed-delivered, FAIL→PASS flipped on every discriminating cell.
 * Delivery, not content, was the bottleneck — so delivery is enforced here.
 *
 * Gates evaluate OBSERVABLE FACTS recorded from PostToolUse events (which
 * files were edited, which verify-shaped commands ran afterwards) — never the
 * agent's claims. The Stop gate refuses to end a turn with unverified product
 * edits, at most twice per turn: a broken gate degrades to advisory, never a
 * lockout.
 *
 * Firmness mapping (no new knob):
 *   off      → pipeline inert
 *   advisory → inject the loop at SessionStart + nag on unverified edits; no blocks
 *   firm     → + Stop gate (max 2 blocks per turn)
 *   strict   → same as firm (strict's extra bite lives in the pre-edit deny gate)
 *
 * State is per-session scratch in the OS tmpdir (NOT .hunch/ — it is derived,
 * disposable, and single-writer), mirroring hookcache.ts. Failure posture is
 * con_03a0b94b2e: any error → do nothing, exit clean. Kill switch: HUNCH_PIPELINE=0.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Firmness = "off" | "advisory" | "firm" | "strict";

export interface PipelineState {
  turn: number;
  soulInjected: boolean;
  /** Stop blocks issued THIS turn (reset on every user prompt). */
  blocks: number;
  /** Domains activated by edited paths, e.g. { backend: true }. */
  domains: Record<string, boolean>;
  editedFiles: string[];
  /** True until a product edit happens, then true only after a verify command. */
  verifyAfterEdit: boolean;
}

export const emptyState = (): PipelineState => ({
  turn: 0,
  soulInjected: false,
  blocks: 0,
  domains: {},
  editedFiles: [],
  verifyAfterEdit: true,
});

// ------------------------------------------------------------------ profiles
/** What counts as verification, per domain. Paths activate a domain; verify
 *  patterns are matched against Bash/PowerShell commands run AFTER an edit. */
export interface DomainProfile {
  paths: RegExp;
  verify: RegExp;
}

export const DEFAULT_PROFILES: Record<string, DomainProfile> = {
  backend: {
    paths: /(^|\/)(src|lib|server|api|core|store|services?)\/|\.(ts|mts|cts|js|mjs|cjs|py|go|rs|java|rb|php)$/i,
    verify: /vitest|jest|pytest|go test|cargo test|tsx --test|npm (run )?test|pnpm (run )?test|tsc|typecheck/i,
  },
  frontend: {
    paths: /\.(tsx|jsx|css|scss|html|vue|svelte)$|(^|\/)(components|pages|site|app|ui)\//i,
    verify: /vite|next (build|dev)|npm run (build|dev)|pnpm (run )?(build|dev)|playwright|storybook|tsc/i,
  },
  tests: {
    paths: /(^|\/)(test|tests|__tests__|e2e|spec)\/|\.(test|spec)\./i,
    verify: /vitest|jest|pytest|tsx --test|npm (run )?test|pnpm (run )?test|playwright/i,
  },
  infra: {
    paths: /Dockerfile|docker-compose|\.tf$|\.tfvars$|(^|\/)(\.github|k8s|helm|terraform|infra|deploy)\/|\.ya?ml$/i,
    verify: /terraform (plan|validate)|docker (build|compose)|kubectl .*--dry-run|helm (lint|template)|actionlint|npm run build/i,
  },
};

/** Product code = behavior that ships. Docs, hunch's own graph, and .claude
 *  config are not gated — editing THIS machinery must never trip it. */
export function isProductPath(p: string): boolean {
  const norm = String(p).replace(/\\/g, "/");
  if (/\.(md|mdx|txt)$/i.test(norm)) return false;
  if (/(^|\/)\.(claude|hunch)(\/|$)/.test(norm)) return false;
  return true;
}

export function classifyDomains(path: string, profiles = DEFAULT_PROFILES): string[] {
  const norm = path.replace(/\\/g, "/");
  return Object.entries(profiles)
    .filter(([, d]) => d.paths.test(norm))
    .map(([name]) => name);
}

function verifyPattern(state: PipelineState, profiles = DEFAULT_PROFILES): RegExp {
  const active = Object.keys(state.domains).filter((d) => profiles[d]);
  const src = (active.length ? active : Object.keys(profiles)).map((d) => profiles[d]!.verify.source).join("|");
  return new RegExp(src, "i");
}

// ------------------------------------------------------- state transitions
/** New user prompt: fresh block budget. */
export function onPrompt(state: PipelineState): PipelineState {
  return { ...state, turn: state.turn + 1, blocks: 0 };
}

/** Edit/Write/MultiEdit landed on `path`. */
export function onEdit(state: PipelineState, path: string, profiles = DEFAULT_PROFILES): PipelineState {
  if (!path || !isProductPath(path)) return state;
  const domains = { ...state.domains };
  for (const d of classifyDomains(path, profiles)) domains[d] = true;
  return {
    ...state,
    domains,
    verifyAfterEdit: false,
    editedFiles: state.editedFiles.includes(path) ? state.editedFiles : [...state.editedFiles, path],
  };
}

/** A shell command ran. After an edit, it counts as verification when it is
 *  verify-shaped for an active domain, a generic runner (`node --test`,
 *  `node -e` assertions), or names an edited file — a bespoke check on the
 *  thing you changed is verification, and uncredited real checks are how a
 *  gate gets disabled out of annoyance (first live false-negative: an HTML
 *  structure assertion via `node -e` was blocked on 2026-07-08). */
export function onCommand(state: PipelineState, command: string, profiles = DEFAULT_PROFILES): PipelineState {
  if (!state.editedFiles.length) return state;
  const editedFileNamed = state.editedFiles.some((f) => {
    const base = f.replace(/\\/g, "/").split("/").pop();
    return !!base && command.includes(base);
  });
  const verifyShaped = verifyPattern(state, profiles).test(command) || /node (--test|-e\b)/.test(command);
  if (verifyShaped || editedFileNamed) return { ...state, verifyAfterEdit: true };
  return state;
}

/** A verification-class skill ran (/verify, /code-review) — counts as coverage. */
export function onSkill(state: PipelineState, skill: string): PipelineState {
  if (/code-review|verify|review/i.test(skill)) return { ...state, verifyAfterEdit: true };
  return state;
}

// ------------------------------------------------------------------- gates
export const PIPELINE_LOOP = [
  "Hunch pipeline — operating loop (enforced on observable facts, not claims):",
  "1. SCOPE — restate the task; define done as something observable (a passing test, a rendered page, a number).",
  "2. EVIDENCE — observe current behavior before editing: run the failing thing, read the real code path, quote the real error.",
  "3. CHANGE — smallest edit that fixes the root cause, not the symptom.",
  "4. VERIFY — after the last edit, RUN the relevant check (test/build/typecheck/plan). A claim without an exit code is not a result.",
  "5. ATTACK — one honest paragraph: what would make this conclusion wrong?",
  "6. REPORT — what ran, what passed, what stays unverified. Failures verbatim.",
].join("\n");

export const UNVERIFIED_NAG =
  "Hunch pipeline: earlier product edits are still UNVERIFIED — run the relevant test/build/typecheck before claiming anything about them.";

/** Stop-gate verdict. Blocks only at firm/strict, only with unverified product
 *  edits, and at most twice per turn. */
export function stopVerdict(state: PipelineState, firmness: Firmness): { block: false } | { block: true; reason: string; state: PipelineState } {
  const gated = firmness === "firm" || firmness === "strict";
  if (!gated || state.verifyAfterEdit || state.editedFiles.length === 0 || state.blocks >= 2) return { block: false };
  const domains = Object.keys(state.domains).join(", ") || "generic";
  return {
    block: true,
    state: { ...state, blocks: state.blocks + 1 },
    reason:
      `Hunch pipeline gate — VERIFY unsatisfied. Product files were edited (${state.editedFiles.slice(-5).join(", ")}) ` +
      `but no verifying command ran afterwards (domain: ${domains}). Do now, in order: ` +
      `(1) run the relevant test/build/typecheck for those files; ` +
      `(2) one honest paragraph attacking your own conclusion — what would make it wrong; ` +
      `(3) report what ran, what passed, what stays unverified. ` +
      `If verification is truly impossible here, say so explicitly and why.`,
  };
}

// ------------------------------------------------------------------ storage
const STATE_DIR = join(tmpdir(), "hunch-pipeline");
const SWEEP_AGE_MS = 48 * 3600 * 1000;

export function pipelineEnabled(): boolean {
  return process.env.HUNCH_PIPELINE !== "0";
}

/** Load session state; on ANY problem return a fresh state (never throw). */
export function loadPipelineState(sessionId: string): PipelineState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(sessionId), "utf8")) as Partial<PipelineState>;
    return { ...emptyState(), ...raw };
  } catch {
    return emptyState();
  }
}

/** Persist session state (best effort — scratch data, single writer). */
export function savePipelineState(sessionId: string, state: PipelineState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    sweep();
    writeFileSync(stateFile(sessionId), JSON.stringify(state));
  } catch {
    /* losing scratch state beats breaking the hook */
  }
}

function stateFile(sessionId: string): string {
  return join(STATE_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`);
}

function sweep(): void {
  try {
    for (const f of readdirSync(STATE_DIR)) {
      try {
        if (Date.now() - statSync(join(STATE_DIR, f)).mtimeMs > SWEEP_AGE_MS) rmSync(join(STATE_DIR, f), { force: true });
      } catch {
        /* raced — skip */
      }
    }
  } catch {
    /* dir unreadable — skip */
  }
}
