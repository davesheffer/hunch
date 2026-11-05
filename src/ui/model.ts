/**
 * `hunch ui` view model: the graph's decisions, constraints, bugs and findings as one
 * "memory" list a human can scan, with every record's connections (feature, components,
 * files, commits) spelled out and marked by HOW they were made — recorded on the record,
 * or matched by path. Pure functions over records; the UI computes nothing authoritative
 * and every write still goes through CLI verbs (human-ui-strategy).
 */
import type { Bug, Component, Constraint, Decision, Finding } from "../core/types.js";
import { isImportedAdrDecision } from "../core/importReview.js";

export type MemoryKind = "decision" | "rule" | "bug" | "finding";
export const MEMORY_KINDS: readonly MemoryKind[] = ["decision", "rule", "bug", "finding"];

/** How a connection was made: written on the record, or inferred from overlapping paths. */
export type LinkSource = "recorded" | "by-path";

export interface ComponentLink { id: string; name: string; source: LinkSource }

/** How agents receive this memory: blocking rules stop an edit, warnings are shown, the rest informs. */
export type Delivery = "block" | "warn" | "inform";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  /** Raw lifecycle value from the record (accepted, active, open, resolved...). */
  status: string;
  /** False once the record is superseded, rejected, retired, resolved or stale: agents no longer get it. */
  active: boolean;
  feature: string | null;
  components: ComponentLink[];
  files: string[];
  commits: string[];
  delivery: Delivery;
  /** ISO date used for ordering; empty when the record carries none. */
  date: string;
  /** Active, but tied to no feature, component or file: nothing routes it to an agent. */
  unconnected: boolean;
}

export interface DetailSection { label: string; text?: string; items?: string[] }

/** One text a person can change, as stored, named by the field the write route takes. */
export interface EditField { name: "title" | "text" | "context" | "rationale"; label: string; value: string; long: boolean }

/** What the page offers on this memory. The CLI still decides; this only hides moves it would refuse. */
export interface MemoryActions {
  fields: EditField[];
  /** Why the words can't be changed here; null when they can. */
  textLocked: string | null;
  /** Confirmed by a person: changing its words removes that confirmation. */
  signed: boolean;
  /** A live, unconfirmed decision or rule a person can confirm as theirs (`hunch review --confirm`). */
  confirmable: boolean;
  /** A rule's severity, for the confirm choice; null for every other kind. */
  severity: Constraint["severity"] | null;
  takesFeature: boolean;
  takesComponents: boolean;
  removable: boolean;
  restorable: boolean;
}

export interface MemoryDetail extends MemoryItem {
  sections: DetailSection[];
  replaces: string | null;
  replacedBy: string | null;
  source: string;
  confidence: number;
  actions: MemoryActions;
}

export interface MemorySource {
  decisions: readonly Decision[];
  constraints: readonly Constraint[];
  bugs: readonly Bug[];
  findings: readonly Finding[];
  components: readonly Component[];
}

/** The literal directory a glob or path names, e.g. "src/auth/**" -> "src/auth". */
function globBase(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  const literal = (cut < 0 ? pattern : pattern.slice(0, cut)).replace(/\\/g, "/");
  return literal.replace(/\/+$/, "").replace(/^\.\//, "");
}

export function overlaps(a: string, b: string): boolean {
  const x = globBase(a), y = globBase(b);
  if (x === "" || y === "" || x === "." || y === ".") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function componentLinks(recorded: readonly string[], files: readonly string[], components: readonly Component[]): ComponentLink[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out = new Map<string, ComponentLink>();
  for (const id of recorded) out.set(id, { id, name: byId.get(id)?.name ?? id, source: "recorded" });
  for (const c of components) {
    if (out.has(c.id) || c.status !== "active") continue;
    if (c.paths.some((p) => files.some((f) => overlaps(p, f)))) out.set(c.id, { id: c.id, name: c.name, source: "by-path" });
  }
  return [...out.values()];
}

function item(base: Omit<MemoryItem, "unconnected">): MemoryItem {
  return { ...base, unconnected: base.active && base.feature === null && base.components.length === 0 && base.files.length === 0 };
}

const present = (values: readonly (string | null | undefined)[]): string[] => values.filter((v): v is string => typeof v === "string" && v.length > 0);

function fromDecision(d: Decision, components: readonly Component[]): MemoryItem {
  return item({
    id: d.id, kind: "decision", title: d.title, summary: d.decision, status: d.status,
    active: (d.status === "accepted" || d.status === "proposed") && !d.valid_to,
    feature: d.topic, components: componentLinks(d.related_components, d.related_files, components),
    files: d.related_files, commits: present([d.commit]), delivery: "inform", date: d.valid_from ?? d.date,
  });
}

function fromConstraint(c: Constraint, components: readonly Component[]): MemoryItem {
  return item({
    id: c.id, kind: "rule", title: c.statement, summary: c.rationale, status: c.status,
    active: c.status === "active" && !c.valid_to, feature: null,
    components: componentLinks([], c.scope, components), files: c.scope, commits: [],
    delivery: c.severity === "blocking" ? "block" : c.severity === "warning" ? "warn" : "inform",
    date: c.valid_from ?? "",
  });
}

function fromBug(b: Bug, components: readonly Component[]): MemoryItem {
  return item({
    id: b.id, kind: "bug", title: b.title, summary: b.root_cause || b.symptom, status: b.status,
    active: true, feature: null, components: componentLinks([], b.affected_files, components),
    files: b.affected_files, commits: present([b.lineage.introduced_commit, b.lineage.fixed_commit]),
    delivery: "inform", date: "",
  });
}

function fromFinding(f: Finding, components: readonly Component[]): MemoryItem {
  return item({
    id: f.id, kind: "finding", title: f.title, summary: f.observation, status: f.triage,
    active: f.triage !== "resolved" && f.triage !== "stale", feature: null,
    components: componentLinks([], f.affected_files, components), files: f.affected_files,
    commits: present([f.resolved_commit]), delivery: "inform", date: f.observed_at,
  });
}

export function memoryItems(src: MemorySource): MemoryItem[] {
  const items = [
    ...src.decisions.map((d) => fromDecision(d, src.components)),
    ...src.constraints.map((c) => fromConstraint(c, src.components)),
    ...src.bugs.map((b) => fromBug(b, src.components)),
    ...src.findings.map((f) => fromFinding(f, src.components)),
  ];
  // Active first, then newest; undated records keep a stable id order at the end of their group.
  return items.sort((a, b) => Number(b.active) - Number(a.active) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export type MemoryView = "active" | "unconnected" | "all";

export interface MemoryQuery { kind?: MemoryKind; view?: MemoryView; q?: string }

export interface MemoryCounts { active: number; unconnected: number; all: number }

export function filterMemory(items: readonly MemoryItem[], query: MemoryQuery): MemoryItem[] {
  const view = query.view ?? "active";
  const needle = query.q?.trim().toLowerCase() ?? "";
  return items.filter((m) =>
    (!query.kind || m.kind === query.kind)
    && (view === "all" || (view === "active" ? m.active : m.unconnected))
    && (needle === "" || `${m.id}\n${m.title}\n${m.summary}\n${m.feature ?? ""}`.toLowerCase().includes(needle)));
}

/** Counts per view for the current kind and search, so the filter buttons can show what each holds. */
export function countMemory(items: readonly MemoryItem[], query: MemoryQuery): MemoryCounts {
  return {
    active: filterMemory(items, { ...query, view: "active" }).length,
    unconnected: filterMemory(items, { ...query, view: "unconnected" }).length,
    all: filterMemory(items, { ...query, view: "all" }).length,
  };
}

const field = (name: EditField["name"], label: string, value: string | null | undefined, long = true): EditField => ({ name, label, value: value ?? "", long });
const humanSigned = (source: string): boolean => source.split("+").includes("human_confirmed");

function actions(over: Partial<MemoryActions> & Pick<MemoryActions, "fields" | "removable" | "restorable">): MemoryActions {
  return { textLocked: null, signed: false, confirmable: false, severity: null, takesFeature: false, takesComponents: false, ...over };
}

export function memoryDetail(src: MemorySource, id: string): MemoryDetail | null {
  const base = memoryItems(src).find((m) => m.id === id);
  if (!base) return null;
  const decision = src.decisions.find((d) => d.id === id);
  if (decision) {
    return {
      ...base, replaces: decision.supersedes, replacedBy: decision.superseded_by,
      source: decision.provenance.source, confidence: decision.provenance.confidence,
      sections: [
        { label: "Decision", text: decision.decision },
        { label: "Why", text: decision.context },
        { label: "Rejected", items: decision.alternatives_rejected },
        { label: "Consequences", items: decision.consequences },
      ],
      actions: actions({
        fields: [field("title", "Title", decision.title, false), field("text", "Decision", decision.decision), field("context", "Why", decision.context)],
        textLocked: isImportedAdrDecision(decision) ? "Imported from an ADR file. Change the ADR, then run hunch import adrs." : null,
        signed: humanSigned(decision.provenance.source), takesFeature: true, takesComponents: true,
        // An imported ADR is signed through its own hash-bound question, never here.
        confirmable: !humanSigned(decision.provenance.source) && !isImportedAdrDecision(decision)
          && (decision.status === "accepted" || decision.status === "proposed") && !decision.valid_to,
        removable: (decision.status === "accepted" || decision.status === "proposed") && !decision.valid_to,
        restorable: (decision.status === "rejected" || decision.status === "superseded") && !decision.superseded_by,
      }),
    };
  }
  const constraint = src.constraints.find((c) => c.id === id);
  if (constraint) {
    return {
      ...base, replaces: null, replacedBy: null,
      source: constraint.provenance.source, confidence: constraint.provenance.confidence,
      sections: [
        { label: "Rule", text: constraint.statement },
        { label: "Why", text: constraint.rationale },
        { label: "From decision", text: constraint.source_decision ?? "" },
      ],
      actions: actions({
        fields: [field("text", "Rule", constraint.statement), field("rationale", "Why", constraint.rationale)],
        signed: humanSigned(constraint.provenance.source),
        confirmable: !humanSigned(constraint.provenance.source) && constraint.status !== "retired" && !constraint.valid_to,
        severity: constraint.severity,
        removable: constraint.status !== "retired" && !constraint.valid_to,
        restorable: constraint.status === "retired",
      }),
    };
  }
  const bug = src.bugs.find((b) => b.id === id);
  if (bug) {
    return {
      ...base, replaces: null, replacedBy: null,
      source: bug.provenance.source, confidence: bug.provenance.confidence,
      sections: [
        { label: "Symptom", text: bug.symptom },
        { label: "Root cause", text: bug.root_cause },
        { label: "Severity", text: bug.severity },
      ],
      actions: actions({ fields: [field("title", "Title", bug.title, false), field("text", "Symptom", bug.symptom)], removable: false, restorable: false }),
    };
  }
  const finding = src.findings.find((f) => f.id === id)!;
  return {
    ...base, replaces: null, replacedBy: null,
    source: finding.provenance.source, confidence: finding.provenance.confidence,
    sections: [
      { label: "Observation", text: finding.observation },
      { label: "Evidence", items: finding.evidence },
      { label: "Severity", text: finding.severity },
    ],
    actions: actions({
      fields: [field("title", "Title", finding.title, false), field("text", "Observation", finding.observation)],
      removable: finding.triage !== "stale" && finding.triage !== "resolved",
      restorable: finding.triage === "stale" || finding.triage === "resolved",
    }),
  };
}
