/** Plain-object shaping for `--json` output of review and why. Same data the text output shows. */
import { displayState } from "../core/lifecycle.js";
import type { Constraint, Decision } from "../core/types.js";

export function ruleJson(c: Constraint) {
  return {
    id: c.id, statement: c.statement, severity: c.severity, scope: c.scope, status: c.status,
    displayState: displayState(c), challenge: c.challenge ?? null, source_decision: c.source_decision ?? null,
  };
}

function decisionJson(d: Decision) {
  return { id: d.id, title: d.title, decision: d.decision, status: d.status, source: d.provenance.source, confidence: d.provenance.confidence };
}

interface ReviewItemLike { d: Decision; synth: { grounded?: number | null; pruned?: number; raw?: string } }

export function reviewJson(o: {
  imported: Decision[]; ready: ReviewItemLike[]; scrutiny: ReviewItemLike[]; rules: Constraint[]; minGrounded: number;
}) {
  const item = (it: ReviewItemLike) => ({ ...decisionJson(it.d), grounded: it.synth.grounded ?? null, pruned: it.synth.pruned ?? 0, critic: it.synth.raw ?? null });
  return {
    minGrounded: o.minGrounded,
    imported: o.imported.map(decisionJson),
    ready: o.ready.map(item),
    scrutiny: o.scrutiny.map(item),
    rules: o.rules.map(ruleJson),
  };
}

export function whyJson(target: string, w: any, staleIds: Set<string>) {
  const stale = (id: string) => staleIds.has(id);
  if (w.byId) {
    const r = w.byId.record;
    if (!r) return { target, record: null };
    return { target, kind: r.kind, record: r.record, ...(r.kind === "constraint" ? { displayState: displayState(r.record) } : {}) };
  }
  return {
    target,
    decisions: w.decisions.map((d: Decision) => ({ ...decisionJson(d), stale: stale(d.id) })),
    constraints: w.constraints.map((c: Constraint) => ({ ...ruleJson(c), stale: stale(c.id) })),
    bugs: w.bugs.map((b: any) => ({ id: b.id, title: b.title, status: b.status, root_cause: b.root_cause })),
    symbols: w.symbols.map((s: any) => ({ name: s.name, fan_in: s.metrics.fan_in, churn_90d: s.metrics.churn_90d })),
  };
}
