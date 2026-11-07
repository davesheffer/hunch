/**
 * New memory from a person (`hunch new decision | constraint | finding`).
 *
 * Create-only: the id derives from the title (decision, finding) or the statement
 * (constraint), exactly as the MCP capture tools derive it, and an id that already exists
 * in either home is refused — refining a record is `hunch edit` / `hunch link`, never a
 * silent overwrite here. Every new record is unsigned testimony (agent_recorded @0.75, a
 * constraint capped at warning), the same tier an un-tokened MCP write lands at: a human
 * signature is the separate `hunch review --confirm <id>` act, so no single write path
 * mints authority. Files, components and the feature go through linkRecord, so a new
 * record and a relinked one share every link refusal, including one live decision per
 * feature.
 */
import type { Constraint, Decision, Finding } from "./types.js";
import { constraintId, decisionId, findingId } from "./ids.js";
import { buildCorrectionConstraint } from "./correction.js";
import { fileLink, linkRecord, type EditResult, type LinkChange, type MemoryKind } from "./memoryEdit.js";

export const NEW_KINDS = ["decision", "constraint", "finding"] as const;
export type NewKind = (typeof NEW_KINDS)[number];

export const isNewKind = (v: string): v is NewKind => (NEW_KINDS as readonly string[]).includes(v);

export interface NewInput {
  title?: string;
  /** decision / statement / observation */
  text: string;
  context?: string;
  rationale?: string;
  rejected?: string[];
  evidence?: string[];
  feature?: string;
  files?: string[];
  components?: string[];
  severity?: string;
  status?: string;
}

export interface NewContext {
  now: string;
  root: string;
  knownDeps?: string[];
  knownComponents: ReadonlySet<string>;
  decisions: readonly Decision[];
  home: "public" | "private";
  /** The record already holding this id in either home, if any. */
  existing: (kind: NewKind, id: string) => { title?: string; statement?: string; status?: string; triage?: string } | undefined;
  /** Whether either home has a file for this id that the loader skipped (corrupt or
   *  schema-invalid): `existing` can't see it, and a create would overwrite it. */
  unreadable: (kind: NewKind, id: string) => boolean;
}

// The states `hunch remove` leaves a record in; `hunch restore` brings it back.
const REMOVED = new Set(["rejected", "superseded", "retired", "stale", "resolved"]);

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const FIELDS: Record<NewKind, ReadonlySet<keyof NewInput>> = {
  decision: new Set(["title", "text", "context", "rejected", "feature", "files", "components", "status"]),
  constraint: new Set(["text", "rationale", "files", "severity"]),
  finding: new Set(["title", "text", "evidence", "files", "severity"]),
};
const FLAG: Record<keyof NewInput, string> = {
  title: "--title", text: "--text", context: "--context", rationale: "--rationale", rejected: "--rejected",
  evidence: "--evidence", feature: "--feature", files: "--file", components: "--component", severity: "--severity", status: "--status",
};

const lines = (v?: string[]): string[] => (v ?? []).map((x) => x.trim()).filter(Boolean);

export function newRecord(kind: NewKind, input: NewInput, ctx: NewContext): EditResult<Decision | Constraint | Finding> {
  const given = (Object.keys(input) as (keyof NewInput)[]).filter((k) => {
    const v = input[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  });
  const misplaced = given.filter((k) => !FIELDS[kind].has(k));
  if (misplaced.length) return refuse(`${misplaced.map((k) => FLAG[k]).join(", ")} ${misplaced.length > 1 ? "don't" : "doesn't"} apply to a new ${kind}`);
  const text = input.text.trim();
  if (!text) return refuse("--text can't be empty");
  const title = input.title?.trim() ?? "";
  if (kind !== "constraint" && !title) return refuse(`a ${kind} needs a --title`);
  const { now } = ctx;
  const files = lines(input.files);

  let rec: Decision | Constraint | Finding;
  if (kind === "decision") {
    const status = input.status ?? "accepted";
    if (status !== "proposed" && status !== "accepted") return refuse(`--status for a new decision must be proposed or accepted, not "${status}"`);
    // Same id the MCP capture gives a manual record, so a later /capture of this title refines it.
    rec = {
      id: decisionId(`manual:${title}`),
      title,
      topic: null,
      status,
      context: input.context?.trim() ?? "",
      decision: text,
      consequences: [],
      alternatives_rejected: lines(input.rejected),
      rejected_tripwires: [],
      premises: [],
      related_components: [],
      related_files: [],
      supersedes: null,
      superseded_by: null,
      caused_by_bug: null,
      commit: null,
      valid_from: now,
      valid_to: null,
      retired: { symbols: [], deps: [] },
      provenance: { source: "agent_recorded", confidence: 0.75, evidence: [], last_verified: now },
      date: now,
    } as Decision;
  } else if (kind === "constraint") {
    const severity = input.severity ?? "warning";
    // Blocking is granted by `hunch review --confirm <id> --severity blocking`, never on create:
    // refused rather than silently lowered, so the person knows what landed.
    if (severity === "blocking") return refuse(`a new constraint can't block edits yet — add it as warning, then run hunch review --confirm ${constraintId(text)} --severity blocking`);
    if (severity !== "advisory" && severity !== "warning") return refuse(`--severity for a new constraint must be advisory or warning, not "${severity}"`);
    // vouched:false also caps it at warning.
    // The rationale is the person's own or empty: the testimony default says an agent wrote it.
    rec = buildCorrectionConstraint({
      rule: text, severity, rationale: input.rationale?.trim() ?? "", root: ctx.root, knownDeps: ctx.knownDeps,
      applies_to_all: !files.length, vouched: false,
    }, now);
  } else {
    const severity = input.severity ?? "medium";
    if (!["low", "medium", "high", "critical"].includes(severity)) return refuse(`--severity for a finding must be low, medium, high or critical, not "${severity}"`);
    const evidence = lines(input.evidence);
    rec = {
      id: findingId(title),
      title,
      observation: text,
      evidence,
      method: null,
      severity: severity as Finding["severity"],
      triage: "open",
      affected_files: [],
      affected_symbols: [],
      violates_constraint: null,
      spawned_decision: null,
      observed_at: now,
      resolved_commit: null,
      provenance: { source: "agent_recorded", confidence: 0.75, evidence, last_verified: now },
    } as Finding;
  }

  const taken = ctx.existing(kind, rec.id);
  if (taken) {
    const name = taken.title ?? taken.statement ?? rec.id;
    if (REMOVED.has(taken.status ?? "") || REMOVED.has(taken.triage ?? "")) {
      return refuse(`${rec.id} already exists ("${name}") but was removed — bring it back with hunch restore ${rec.id}`);
    }
    return refuse(`${rec.id} already exists ("${name}") — edit it instead of adding it again`);
  }
  if (ctx.unreadable(kind, rec.id)) return refuse(`a file for ${rec.id} exists but can't be read — repair it (hunch doctor) before adding this again`);

  const components = lines(input.components);
  const feature = input.feature?.trim();
  if (input.feature !== undefined && !feature) return refuse("--feature can't be empty");
  if (!files.length && !components.length && !feature) return { ok: true, record: rec, changed: true };
  const change: LinkChange = {
    feature, addFiles: files, addComponents: components,
    // A constraint scoped to files is no longer repo-wide — unless a file (as linked: ./** is **) is the whole repo.
    removeFiles: kind === "constraint" && !files.some((f) => { const l = fileLink(f, ctx.home); return l.ok && l.link === "**"; }) ? ["**"] : [],
    knownComponents: ctx.knownComponents, decisions: ctx.decisions, home: ctx.home,
  };
  const linked = linkRecord(kind as MemoryKind, rec, change, now);
  if (!linked.ok) return linked;
  const out = linked.record as Decision | Constraint | Finding;
  // A decision's evidence is its files, as the MCP capture records it.
  if (kind === "decision") out.provenance = { ...out.provenance, evidence: [...(out as Decision).related_files] };
  return { ok: true, record: out, changed: true };
}
