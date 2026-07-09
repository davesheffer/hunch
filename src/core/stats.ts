/** `hunch stats` — the ONE data contract (dec_6253f7e6d6). A pure aggregation over
 *  the graph Hunch already builds plus the append-only catch-log (core/events.ts):
 *  STOCK (what's accumulated) → RETURN (what that stock caught) → COMPOUNDING (the
 *  ratio that should climb). Every surface — CLI receipt, VS Code extension, the
 *  public proof-curve — is a read-only pane of glass over this object; if a number
 *  can't come from here it doesn't exist.
 *
 *  HONESTY (the red-team baked into the decision): nothing here fabricates a number
 *  the live graph can't produce. `coverage.pct` is 0 until decisions actually carry
 *  `related_components`; `bugs_reprevented` is 0 until a bug reaches `regressed`;
 *  catches come only from real gate events, never a hypothetical. A skeptic running
 *  this on a young graph SHOULD see zeros — that's the honest state, not a bug. */
import type { Bug, Constraint, Decision } from "./types.js";
import type { HunchEvent } from "./events.js";

export interface StatsInput {
  decisions: Decision[];
  constraints: Constraint[];
  bugs: Bug[];
  /** Component ids in the graph (for coverage = decisions-touching ÷ total). */
  componentIds: string[];
  runbooksCount: number;
  events: HunchEvent[];
  /** Count of constraints whose guarded code moved since last verified (from the
   *  store's staleness walk — passed in so this module stays pure). */
  staleConstraints: number;
  /** ms epoch "now" and the start of the recent window (now − since). */
  now: number;
  windowStart: number;
  windowLabel: string;
}

export interface StatsReturn {
  violations_caught: number;
  drifts_flagged: number;
  bugs_reprevented: number;
  vetoes_fired: number;
}

export interface Stats {
  schema: "hunch.stats/1";
  generated_at: string;
  window: { since: string; from: string; to: string };
  stock: {
    decisions: { total: number; accepted: number; superseded: number; proposed: number; rejected: number };
    invariants: { total: number; locked: number; advisory: number; stale: number };
    components: number;
    bugs: { total: number; open: number; investigating: number; fixed: number; regressed: number };
    runbooks: number;
    coverage: { components_with_decision: number; components_total: number; pct: number };
  };
  return: { window: StatsReturn; lifetime: StatsReturn };
  compounding: { rules_recorded: number; catches_lifetime: number; payback_ratio: number };
}

/** A constraint that actually has teeth: active, blocking, and human-vouched — the
 *  same "ARMED" definition `hunch status` uses. Draft/advisory rules don't count as
 *  locked stock. */
function isLocked(c: Constraint): boolean {
  const src = c.provenance?.source;
  const vouched = !!src && (src.includes("human_confirmed") || src === "derived");
  return c.status === "active" && c.severity === "blocking" && vouched;
}

function eventMs(e: HunchEvent): number {
  const t = Date.parse(e.at);
  return Number.isNaN(t) ? 0 : t;
}

/** Tally the four return metrics over a set of events. `bugs_reprevented` is the
 *  strict, deterministic claim: a blocked edit whose enforcing decision was caused
 *  by a bug that has DEMONSTRABLY regressed (came back once already). No event ever
 *  fabricates that shape — it's a real join over the graph. */
function tallyReturn(events: HunchEvent[], decById: Map<string, Decision>, bugById: Map<string, Bug>): StatsReturn {
  let caught = 0, drifts = 0, reprevented = 0, vetoes = 0;
  for (const e of events) {
    if (e.kind === "constraint" || e.kind === "veto" || e.kind === "conformance") caught++;
    if (e.kind === "veto") vetoes++;
    if (e.kind === "drift") drifts++;
    if (e.decision) {
      const d = decById.get(e.decision);
      const bug = d?.caused_by_bug ? bugById.get(d.caused_by_bug) : undefined;
      if (bug && bug.status === "regressed") reprevented++;
    }
  }
  return { violations_caught: caught, drifts_flagged: drifts, bugs_reprevented: reprevented, vetoes_fired: vetoes };
}

export function computeStats(input: StatsInput): Stats {
  const { decisions, constraints, bugs, componentIds, events } = input;

  const byStatus = <T extends { status: string }>(recs: T[], s: string) => recs.filter((r) => r.status === s).length;

  const activeConstraints = constraints.filter((c) => c.status === "active");
  const locked = activeConstraints.filter(isLocked).length;

  // Coverage: distinct components named by at least one decision, over total. Only
  // component ids that actually EXIST count (a dangling ref isn't coverage).
  const compSet = new Set(componentIds);
  const touched = new Set<string>();
  for (const d of decisions) for (const c of d.related_components) if (compSet.has(c)) touched.add(c);
  const componentsTotal = componentIds.length;
  const pct = componentsTotal ? touched.size / componentsTotal : 0;

  const decById = new Map(decisions.map((d) => [d.id, d]));
  const bugById = new Map(bugs.map((b) => [b.id, b]));

  const inWindow = events.filter((e) => eventMs(e) >= input.windowStart);
  const lifetime = tallyReturn(events, decById, bugById);
  const windowReturn = tallyReturn(inWindow, decById, bugById);

  const rulesRecorded = locked;
  const catchesLifetime = lifetime.violations_caught;

  return {
    schema: "hunch.stats/1",
    generated_at: new Date(input.now).toISOString(),
    window: { since: input.windowLabel, from: new Date(input.windowStart).toISOString(), to: new Date(input.now).toISOString() },
    stock: {
      decisions: {
        total: decisions.length,
        accepted: byStatus(decisions, "accepted"),
        superseded: byStatus(decisions, "superseded"),
        proposed: byStatus(decisions, "proposed"),
        rejected: byStatus(decisions, "rejected"),
      },
      invariants: { total: activeConstraints.length, locked, advisory: activeConstraints.length - locked, stale: input.staleConstraints },
      components: componentsTotal,
      bugs: {
        total: bugs.length,
        open: byStatus(bugs, "open"),
        investigating: byStatus(bugs, "investigating"),
        fixed: byStatus(bugs, "fixed"),
        regressed: byStatus(bugs, "regressed"),
      },
      runbooks: input.runbooksCount,
      coverage: { components_with_decision: touched.size, components_total: componentsTotal, pct: Math.round(pct * 100) / 100 },
    },
    return: { window: windowReturn, lifetime },
    compounding: {
      rules_recorded: rulesRecorded,
      catches_lifetime: catchesLifetime,
      payback_ratio: rulesRecorded ? Math.round((catchesLifetime / rulesRecorded) * 10) / 10 : 0,
    },
  };
}

/** Human-readable receipt for the terminal (the CLI's default, non-`--json` output).
 *  Same three blocks as the JSON: stock → return → compounding. Honest zeros are
 *  shown plainly, never hidden — a young graph reads as young, not as broken. */
export function formatStats(s: Stats): string {
  const L: string[] = [];
  const pct = Math.round(s.stock.coverage.pct * 100);
  L.push(`\n🧠 Hunch — engineering-memory stats\n`);
  L.push(`  STOCK (accumulated)`);
  L.push(`    decisions:  ${s.stock.decisions.total}  (${s.stock.decisions.accepted} accepted · ${s.stock.decisions.proposed} proposed · ${s.stock.decisions.superseded} superseded)`);
  L.push(`    invariants: ${s.stock.invariants.total}  (${s.stock.invariants.locked} locked · ${s.stock.invariants.advisory} advisory${s.stock.invariants.stale ? ` · ${s.stock.invariants.stale} stale` : ""})`);
  L.push(`    components: ${s.stock.components}   ·   bugs: ${s.stock.bugs.total}   ·   runbooks: ${s.stock.runbooks}`);
  L.push(`    coverage:   ${pct}% of components explained by ≥1 decision  (${s.stock.coverage.components_with_decision}/${s.stock.coverage.components_total})`);
  L.push(`\n  RETURN (what the stock caught)`);
  const r = s.return.lifetime, w = s.return.window;
  L.push(`    this ${s.window.since}:  ${w.violations_caught} caught · ${w.drifts_flagged} drift · ${w.bugs_reprevented} re-prevented`);
  L.push(`    lifetime:    ${r.violations_caught} caught · ${r.bugs_reprevented} re-prevented`);
  L.push(`\n  COMPOUNDING`);
  if (s.compounding.rules_recorded && s.compounding.catches_lifetime) {
    L.push(`    ${s.compounding.rules_recorded} locked rule(s) → ${s.compounding.catches_lifetime} catch(es)  ·  each rule pays back ${s.compounding.payback_ratio}×`);
  } else {
    L.push(`    ${s.compounding.rules_recorded} locked rule(s), ${s.compounding.catches_lifetime} catch(es) so far — the catch-log grows as the gate fires (nothing to inflate).`);
  }
  L.push("");
  return L.join("\n");
}
