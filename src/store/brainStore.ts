/**
 * BrainStore — the read/write query layer over the JSON source of truth and the
 * SQLite derived index. Everything the CLI and MCP server need flows through here.
 *
 *   - reindex():        JSON  -> SQLite (rebuild the derived index + FTS)
 *   - search():         FTS5 ranked query (brain_query)
 *   - why():            decisions/bugs/constraints explaining a path/symbol
 *   - getDependents():  recursive-CTE blast radius over the call/dep graph
 *   - checkConstraints(): constraints whose scope matches a glob/path
 *   - bugLineage():     bugs matching a symptom/symbol + their lineage
 *   - fragility():      ranked fragility report with evidence
 */
import type { BrainPaths } from "../core/paths.js";
import { ENTITY_KINDS, type Component, type Constraint, type Bug, type Decision, type Symbol, type Edge } from "../core/types.js";
import { openDb, type DB } from "./db.js";
import { RESET_SQL } from "./schema.js";
import { JsonStore } from "./jsonStore.js";
import { pathMatchesGlob } from "../core/glob.js";

export interface SearchHit {
  ref: string;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

export interface WhyResult {
  target: string;
  decisions: Decision[];
  bugs: Bug[];
  constraints: Constraint[];
  symbols: Symbol[];
  components: Component[];
}

export interface FragileNode {
  id: string;
  file: string;
  name: string;
  score: number;
  churn_90d: number;
  bug_count: number;
  fan_in: number;
  evidence: string[];
}

export class BrainStore {
  readonly json: JsonStore;
  private _db: DB | null = null;

  constructor(private readonly paths: BrainPaths) {
    this.json = new JsonStore(paths);
  }

  get db(): DB {
    if (!this._db) this._db = openDb(this.paths.sqlite);
    return this._db;
  }

  close(): void {
    this._db?.close();
    this._db = null;
  }

  // ---- write path ---------------------------------------------------------

  /** Rebuild the entire SQLite index + FTS from the JSON source of truth. */
  reindex(): { counts: Record<string, number> } {
    const db = this.db;
    const counts: Record<string, number> = {};
    const tx = db.transaction(() => {
      db.exec(RESET_SQL);
      const j = (s: string) => s; // readability marker for JSON-encoded columns

      const comps = this.json.loadAll("components");
      const insComp = db.prepare(
        `INSERT INTO components VALUES (@id,@kind,@name,@responsibility,@paths,@status,@owners,@fragility,@ps,@pc,@pe,@created_at,@updated_at)`,
      );
      for (const c of comps) {
        insComp.run({
          id: c.id, kind: c.kind, name: c.name, responsibility: c.responsibility,
          paths: JSON.stringify(c.paths), status: c.status, owners: JSON.stringify(c.owners),
          fragility: c.fragility, ps: c.provenance.source, pc: c.provenance.confidence,
          pe: JSON.stringify(c.provenance.evidence), created_at: c.created_at, updated_at: c.updated_at,
        });
        this.fts(db, c.id, "components", c.name, `${c.responsibility} ${c.paths.join(" ")}`);
      }
      counts.components = comps.length;

      const edges = this.json.loadAll("edges");
      const insEdge = db.prepare(`INSERT INTO edges VALUES (@id,@from,@to,@type,@reason,@strength,@ps,@pc,@pe)`);
      for (const e of edges) {
        insEdge.run({ id: e.id, from: e.from, to: e.to, type: e.type, reason: e.reason, strength: e.strength,
          ps: e.provenance.source, pc: e.provenance.confidence, pe: JSON.stringify(e.provenance.evidence) });
      }
      counts.edges = edges.length;

      const syms = this.json.loadAll("symbols");
      const insSym = db.prepare(
        `INSERT INTO symbols VALUES (@id,@file,@name,@kind,@sh,@calls,@called_by,@loc,@churn,@bug,@fanin,@fanout,@last)`,
      );
      for (const s of syms) {
        insSym.run({ id: s.id, file: s.file, name: s.name, kind: s.kind, sh: s.signature_hash,
          calls: JSON.stringify(s.calls), called_by: JSON.stringify(s.called_by),
          loc: s.metrics.loc, churn: s.metrics.churn_90d, bug: s.metrics.bug_count,
          fanin: s.metrics.fan_in, fanout: s.metrics.fan_out, last: s.last_changed });
        this.fts(db, s.id, "symbols", `${s.name} (${s.kind})`, s.file);
      }
      counts.symbols = syms.length;

      const decs = this.json.loadAll("decisions");
      const insDec = db.prepare(
        `INSERT INTO decisions VALUES (@id,@title,@status,@context,@decision,@cons,@alts,@rc,@rf,@sup,@cbb,@commit,@ps,@pc,@pe,@date)`,
      );
      for (const d of decs) {
        insDec.run({ id: d.id, title: d.title, status: d.status, context: d.context, decision: d.decision,
          cons: JSON.stringify(d.consequences), alts: JSON.stringify(d.alternatives_rejected),
          rc: JSON.stringify(d.related_components), rf: JSON.stringify(d.related_files),
          sup: d.supersedes, cbb: d.caused_by_bug, commit: d.commit,
          ps: d.provenance.source, pc: d.provenance.confidence, pe: JSON.stringify(d.provenance.evidence), date: d.date });
        this.fts(db, d.id, "decisions", d.title, `${d.context} ${d.decision} ${d.consequences.join(" ")}`);
      }
      counts.decisions = decs.length;

      const bugs = this.json.loadAll("bugs");
      const insBug = db.prepare(
        `INSERT INTO bugs VALUES (@id,@title,@symptom,@rc,@sev,@status,@af,@as,@lin,@ps,@pc,@pe)`,
      );
      for (const b of bugs) {
        insBug.run({ id: b.id, title: b.title, symptom: b.symptom, rc: b.root_cause, sev: b.severity, status: b.status,
          af: JSON.stringify(b.affected_files), as: JSON.stringify(b.affected_symbols), lin: JSON.stringify(b.lineage),
          ps: b.provenance.source, pc: b.provenance.confidence, pe: JSON.stringify(b.provenance.evidence) });
        this.fts(db, b.id, "bugs", b.title, `${b.symptom} ${b.root_cause}`);
      }
      counts.bugs = bugs.length;

      const cons = this.json.loadAll("constraints");
      const insCon = db.prepare(
        `INSERT INTO constraints VALUES (@id,@type,@statement,@scope,@sev,@enf,@rat,@sd,@viol,@ps,@pc,@pe)`,
      );
      for (const c of cons) {
        insCon.run({ id: c.id, type: c.type, statement: c.statement, scope: JSON.stringify(c.scope),
          sev: c.severity, enf: c.enforcement, rat: c.rationale, sd: c.source_decision, viol: JSON.stringify(c.violations),
          ps: c.provenance.source, pc: c.provenance.confidence, pe: JSON.stringify(c.provenance.evidence) });
        this.fts(db, c.id, "constraints", c.statement, `${c.rationale} ${c.scope.join(" ")}`);
      }
      counts.constraints = cons.length;
      void j;
    });
    tx();
    return { counts };
  }

  private fts(db: DB, ref: string, kind: string, title: string, body: string): void {
    db.prepare(`INSERT INTO search (ref, kind, title, body) VALUES (?,?,?,?)`).run(ref, kind, title, body ?? "");
  }

  // ---- read path ----------------------------------------------------------

  /** FTS5 ranked search (brain_query). Falls back to LIKE if the query has no
   *  FTS-tokenizable terms. */
  search(query: string, limit = 12): SearchHit[] {
    const match = toFtsQuery(query);
    // No FTS-tokenizable terms (e.g. a CJK-only query) — degrade to LIKE rather
    // than silently returning nothing (the documented fallback).
    if (!match) return this.likeSearch(query, limit);
    try {
      const rows = this.db.prepare(
        `SELECT ref, kind, title, snippet(search, 3, '[', ']', '…', 12) AS snip, bm25(search) AS score
         FROM search WHERE search MATCH ? ORDER BY score LIMIT ?`,
      ).all(match, limit) as Array<{ ref: string; kind: string; title: string; snip: string; score: number }>;
      return rows.map((r) => ({ ref: r.ref, kind: r.kind, title: r.title, snippet: r.snip, score: r.score }));
    } catch {
      // Malformed FTS expression — degrade to a LIKE scan over titles/bodies.
      return this.likeSearch(query, limit);
    }
  }

  /** Substring fallback over titles/bodies (handles non-ASCII / malformed FTS). */
  private likeSearch(query: string, limit: number): SearchHit[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const rows = this.db.prepare(
      `SELECT ref, kind, title, substr(body,1,120) AS snip FROM search
       WHERE title LIKE ? OR body LIKE ? LIMIT ?`,
    ).all(like, like, limit) as Array<{ ref: string; kind: string; title: string; snip: string }>;
    return rows.map((r) => ({ ref: r.ref, kind: r.kind, title: r.title, snippet: r.snip, score: 0 }));
  }

  /** All decisions/bugs/constraints/symbols/components touching a file path or
   *  symbol name (brain_why). */
  why(target: string): WhyResult {
    const decisions = this.json.loadAll("decisions");
    const bugs = this.json.loadAll("bugs");
    const constraints = this.json.loadAll("constraints");
    const symbols = this.json.loadAll("symbols");
    const components = this.json.loadAll("components");

    const matchedSymbols = symbols.filter((s) => s.file === target || s.name === target || s.id === target || s.file.endsWith(target));
    const symIds = new Set(matchedSymbols.map((s) => s.id));
    const fileSet = new Set(matchedSymbols.map((s) => s.file));
    const isPath = target.includes("/") || target.includes(".");

    const fileMatch = (files: string[]) =>
      files.some((f) => f === target || (isPath && (f.endsWith(target) || target.endsWith(f))) || fileSet.has(f));

    return {
      target,
      decisions: decisions.filter(
        (d) => fileMatch(d.related_files) || d.related_components.some((c) => components.find((x) => x.id === c && fileMatch(x.paths)))),
      bugs: bugs.filter((b) => fileMatch(b.affected_files) || b.affected_symbols.some((s) => symIds.has(s))),
      constraints: constraints.filter((c) => c.scope.some((g) => pathMatchesGlob(target, g) || [...fileSet].some((f) => pathMatchesGlob(f, g)))),
      symbols: matchedSymbols,
      components: components.filter((c) => c.paths.some((g) => pathMatchesGlob(target, g) || [...fileSet].some((f) => pathMatchesGlob(f, g)))),
    };
  }

  /** Transitive blast radius: every symbol/component that (in)directly depends on
   *  `id`, via a recursive CTE over the edges graph (brain_get_dependents). We
   *  walk edges BACKWARD (edges.to = current) following call/dep/import/contains. */
  getDependents(id: string, maxDepth = 6): Array<{ id: string; depth: number; via: string }> {
    const rows = this.db.prepare(
      /* sql */ `
      WITH RECURSIVE up(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e."from", up.depth + 1
        FROM edges e JOIN up ON e."to" = up.node
        WHERE e.type IN ('calls','depends_on','imports','contains') AND up.depth < ?
      )
      SELECT DISTINCT up.node AS id, MIN(up.depth) AS depth FROM up
      WHERE up.node <> ? GROUP BY up.node ORDER BY depth, id`,
    ).all(id, maxDepth, id) as Array<{ id: string; depth: number }>;
    return rows.map((r) => ({ id: r.id, depth: r.depth, via: this.labelFor(r.id) }));
  }

  /** Symbols/components this id depends ON (forward walk) — used for refactor blast radius. */
  getDependencies(id: string, maxDepth = 6): Array<{ id: string; depth: number; via: string }> {
    const rows = this.db.prepare(
      /* sql */ `
      WITH RECURSIVE down(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e."to", down.depth + 1
        FROM edges e JOIN down ON e."from" = down.node
        WHERE e.type IN ('calls','depends_on','imports','contains') AND down.depth < ?
      )
      SELECT DISTINCT down.node AS id, MIN(down.depth) AS depth FROM down
      WHERE down.node <> ? GROUP BY down.node ORDER BY depth, id`,
    ).all(id, maxDepth, id) as Array<{ id: string; depth: number }>;
    return rows.map((r) => ({ id: r.id, depth: r.depth, via: this.labelFor(r.id) }));
  }

  private labelFor(id: string): string {
    if (id.startsWith("sym_")) {
      const r = this.db.prepare(`SELECT name, file FROM symbols WHERE id=?`).get(id) as { name: string; file: string } | undefined;
      return r ? `${r.name} @ ${r.file}` : id;
    }
    if (id.startsWith("cmp_")) {
      const r = this.db.prepare(`SELECT name FROM components WHERE id=?`).get(id) as { name: string } | undefined;
      return r ? r.name : id;
    }
    return id;
  }

  /** Constraints whose scope glob matches a path/glob (brain_check_constraints). */
  checkConstraints(scope: string): Constraint[] {
    const all = this.json.loadAll("constraints");
    return all
      .filter((c) => c.scope.some((g) => pathMatchesGlob(scope, g) || pathMatchesGlob(g, scope) || g === scope))
      .sort((a, b) => sev(b.severity) - sev(a.severity));
  }

  /** Bugs matching a symptom (FTS over bugs) or a symbol, with lineage (brain_bug_lineage). */
  bugLineage(symptomOrSymbol: string): Bug[] {
    const bugs = this.json.loadAll("bugs");
    const direct = bugs.filter(
      (b) => b.affected_symbols.includes(symptomOrSymbol) || b.affected_files.includes(symptomOrSymbol),
    );
    if (direct.length) return direct;
    // fall back to fts over bug titles/symptoms
    const hits = this.search(symptomOrSymbol).filter((h) => h.kind === "bugs").map((h) => h.ref);
    const byHit = bugs.filter((b) => hits.includes(b.id));
    if (byHit.length) return byHit;
    // last resort: naive substring over symptom/root_cause
    const q = symptomOrSymbol.toLowerCase();
    return bugs.filter((b) => `${b.title} ${b.symptom} ${b.root_cause}`.toLowerCase().includes(q));
  }

  /** Ranked fragility report (brain fragile). fragility = weighted churn + bugs + fan-in. */
  fragility(limit = 15): FragileNode[] {
    const syms = this.json.loadAll("symbols");
    const bugs = this.json.loadAll("bugs");
    // bug counts per symbol from actual bug records (authoritative over stale metric)
    const bugBySym = new Map<string, number>();
    for (const b of bugs) for (const s of b.affected_symbols) bugBySym.set(s, (bugBySym.get(s) ?? 0) + 1);

    const maxChurn = Math.max(1, ...syms.map((s) => s.metrics.churn_90d));
    const maxFanIn = Math.max(1, ...syms.map((s) => s.metrics.fan_in));

    const scored = syms.map((s) => {
      const bugCount = Math.max(s.metrics.bug_count, bugBySym.get(s.id) ?? 0);
      const churnN = s.metrics.churn_90d / maxChurn;
      const fanInN = s.metrics.fan_in / maxFanIn;
      // weighted: bugs dominate, then churn, then centrality
      const score = 0.5 * Math.min(1, bugCount / 3) + 0.3 * churnN + 0.2 * fanInN;
      const evidence: string[] = [];
      if (bugCount) evidence.push(`${bugCount} bug(s)`);
      if (s.metrics.churn_90d) evidence.push(`churn ${s.metrics.churn_90d}/90d`);
      if (s.metrics.fan_in) evidence.push(`fan-in ${s.metrics.fan_in}`);
      return { id: s.id, file: s.file, name: s.name, score: round(score), churn_90d: s.metrics.churn_90d,
        bug_count: bugCount, fan_in: s.metrics.fan_in, evidence };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Convenience: load a single entity from JSON by id (any kind). */
  resolve(id: string): { kind: string; record: unknown } | undefined {
    for (const kind of ENTITY_KINDS) {
      const rec = this.json.get(kind, id);
      if (rec) return { kind, record: rec };
    }
    return undefined;
  }

  /** All edges (for graph export). */
  allEdges(): Edge[] {
    return this.json.loadAll("edges");
  }
}

function sev(s: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1 } as Record<string, number>)[s] ?? 0;
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Turn a free-text question into a tolerant FTS5 MATCH expression: split on
 *  non-word chars, OR the terms with prefix matching. Returns null if empty. */
function toFtsQuery(q: string): string | null {
  // Unicode word chars so accented/non-Latin terms still tokenize for FTS.
  const terms = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return null;
  // quote each term and add prefix '*' for partial matches; OR them so recall is high
  return terms.map((t) => `"${t}"*`).join(" OR ");
}
