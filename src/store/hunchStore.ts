/**
 * HunchStore — the read/write query layer over the JSON source of truth and the
 * SQLite derived index. Everything the CLI and MCP server need flows through here.
 *
 *   - reindex():        JSON  -> SQLite (rebuild the derived index + FTS)
 *   - search():         FTS5 ranked query (hunch_query)
 *   - why():            decisions/bugs/constraints explaining a path/symbol
 *   - getDependents():  recursive-CTE blast radius over the call/dep graph
 *   - checkConstraints(): constraints whose scope matches a glob/path
 *   - bugLineage():     bugs matching a symptom/symbol + their lineage
 *   - fragility():      ranked fragility report with evidence
 */
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { toPosixTarget, hunchPathsForDir, type HunchPaths } from "../core/paths.js";
import { ENTITY_KINDS, type Component, type Constraint, type Bug, type Decision, type Symbol, type Edge, type RejectedTripwire, type EntityKind, type EntityFor } from "../core/types.js";
import { openDb, withTx, type DB } from "./db.js";
import { RESET_SQL, embedHash } from "./schema.js";
import { selectEmbedder, type Embedder } from "./embedder.js";
import { JsonStore } from "./jsonStore.js";
import { gitCommonDir } from "../extractors/git.js";
import { pathMatchesGlob } from "../core/glob.js";
import { edgeId } from "../core/ids.js";
import { isStrictBlocker, isVetoBlocker, type VetoTier } from "../core/strictgate.js";
import { effectiveForbids, matchForbids, type ForbidMatch } from "../core/constraintmatch.js";
import { analyzeDiff, type DiffAnalysis } from "../extractors/diff.js";
import type { CheckReport, CheckDirect, CausalWhy } from "../core/checkreport.js";

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

export class HunchStore {
  readonly json: JsonStore;
  /** Optional PRIVATE overlay (HUNCH_PRIVATE_DIR) — a second store in a repo the
   *  user controls. Unioned into reads via recs(); never written by public paths. */
  private readonly privateJson?: JsonStore;
  /** The resolved private-overlay hunch dir (from env or .hunch/local.json), or undefined
   *  when no overlay is configured. Surfaced so `hunch doctor` reflects the true state. */
  readonly privateDir?: string;
  /** Whether captures auto-commit the store they land in — ON by default in EVERY mode;
   *  `--no-auto-commit` (hunch init/private/shared) persists `autoCommit: false` in
   *  local.json to opt out. Read by the MCP write tools and `hunch sync`. */
  readonly autoCommit: boolean;
  /** How memory is homed: "public" (no overlay — the repo-tracked .hunch/ is the one store),
   *  "private" (overlay holds ONLY private:true records; public records stay committed here),
   *  or "shared" (the overlay IS the store — every capture routes there, one source of truth
   *  across branches, worktrees, teammates, and agents). Absent `mode` in an existing
   *  config reads as "private" — no behavior change on upgrade. */
  readonly mode: "public" | "private" | "shared";
  /** mode === "shared" with a configured overlay: ALL captures route to the overlay. */
  readonly unified: boolean;
  /** autoCommit AND a private overlay is configured: private writes auto commit+push the
   *  overlay repo. (Public writes auto-commit the repo-tracked .hunch/ WITHOUT pushing —
   *  see commitAndPushHunch push:false / bug_overlay_clobber.) */
  readonly privateAutoCommit: boolean;
  /** When true, recs() ignores the private overlay (public-only). Set transiently by
   *  buildCheckReport({publicOnly}) so any PUBLICLY-POSTED report (the CI PR comment)
   *  can never render a private record — a publicly-posted output is a leak surface
   *  equal to a committed file (dec_d7bad4ccb7). */
  private suppressPrivate = false;
  private _db: DB | null = null;

  constructor(private readonly paths: HunchPaths) {
    this.json = new JsonStore(paths);
    // Private overlay location: env (override, for CI / portability) → else a gitignored
    // local config (.hunch/local.json) so `hunch private` enables it with NO env var, and
    // the MCP server / hook pick it up automatically. Relative paths resolve from root.
    const local = this.localConfig();
    const priv = process.env.HUNCH_PRIVATE_DIR?.trim() || local.privateDir;
    if (priv) {
      this.privateDir = resolve(this.paths.root, priv);
      this.privateJson = new JsonStore(hunchPathsForDir(this.privateDir));
    }
    // Auto-commit is ON unless explicitly opted out (`autoCommit: false` in local.json).
    // An absent local.json (plain `hunch init`, or an env-configured overlay) defaults ON.
    this.autoCommit = local.autoCommit !== false;
    this.privateAutoCommit = !!(priv && this.autoCommit);
    // Mode: no overlay → "public". With an overlay, an absent `mode` reads as "private"
    // (the pre-mode behavior — split routing), so existing setups are unchanged on upgrade;
    // only an explicit `hunch shared` opts a repo into unified routing.
    this.mode = priv ? (local.mode ?? "private") : "public";
    this.unified = this.mode === "shared" && !!this.privateJson;
  }

  /** Where a capture belongs: an explicit private:true always goes to the overlay
   *  (putPrivate throws rather than silently landing public when none is configured);
   *  otherwise the overlay in unified ("shared") mode, else the public store. ONE home
   *  per record — the single-source-of-truth contract. */
  captureHome(isPrivate = false): "private" | "public" {
    if (isPrivate) return "private";
    return this.unified ? "private" : "public";
  }

  /** Write a capture to its ONE home (see captureHome). Every capture path — MCP tools,
   *  post-commit synthesis, inline intents, record-constraint/conform, runbooks — funnels
   *  through here so all modes, branches, worktrees, teams, and agents agree on where
   *  memory lives. */
  putCapture<K extends EntityKind>(kind: K, record: EntityFor[K], isPrivate = false): EntityFor[K] {
    return this.captureHome(isPrivate) === "private" ? this.putPrivate(kind, record) : this.json.put(kind, record);
  }

  /** Read a record by id from wherever it lives (private overlay wins on collision). */
  getRec<K extends EntityKind>(kind: K, id: string): EntityFor[K] | undefined {
    return this.privateJson?.get(kind, id) ?? this.json.get(kind, id);
  }

  /** Update an EXISTING record in the store that holds it — an overlay record must never
   *  fork a public copy on update (and vice versa). Falls back to captureHome routing for
   *  a record that exists nowhere yet. */
  putWhereItLives<K extends EntityKind>(kind: K, record: EntityFor[K]): EntityFor[K] {
    const id = (record as { id: string }).id;
    if (this.privateJson?.get(kind, id)) return this.putPrivate(kind, record);
    if (this.json.get(kind, id)) return this.json.put(kind, record);
    return this.putCapture(kind, record);
  }

  /** The private-overlay config from the gitignored `.hunch/local.json` (per-machine,
   *  never committed). Tolerant: returns {} on missing/invalid so reads never crash.
   *  `autoCommit` is tri-state: true/false when the file says so, undefined when unset.
   *  `mode` records HOW the overlay was set up ("private" split vs "shared" unified). */
  private localConfig(): { privateDir?: string; autoCommit?: boolean; mode?: "private" | "shared" } {
    const read = (file: string): { privateDir?: string; autoCommit?: boolean; mode?: "private" | "shared" } => {
      try {
        if (!existsSync(file)) return {};
        const v = JSON.parse(readFileSync(file, "utf8")) as { privateDir?: unknown; autoCommit?: unknown; mode?: unknown };
        const privateDir = typeof v.privateDir === "string" && v.privateDir.trim() ? v.privateDir.trim() : undefined;
        const mode = v.mode === "private" || v.mode === "shared" ? v.mode : undefined;
        return { privateDir, autoCommit: typeof v.autoCommit === "boolean" ? v.autoCommit : undefined, mode };
      } catch {
        return {};
      }
    };
    // Per-worktree pointer first (explicit / back-compat). If it names no overlay, fall back to
    // the SHARED pointer in the git common dir — identical across ALL worktrees, so a freshly
    // added worktree (whose gitignored .hunch/local.json doesn't exist yet) still auto-discovers
    // the same memory. The git lookup runs ONLY when the cheap per-worktree read is empty, keeping
    // it off the hot path for already-configured checkouts.
    const perWorktree = read(join(this.paths.hunch, "local.json"));
    if (perWorktree.privateDir) return perWorktree;
    const common = gitCommonDir(this.paths.root);
    if (common) {
      const shared = read(join(common, "hunch", "local.json"));
      // A per-worktree `autoCommit: false` (hunch init --no-auto-commit) is an explicit
      // local opt-out — it must survive the fall-through to the shared overlay pointer.
      if (shared.privateDir) return { ...shared, autoCommit: perWorktree.autoCommit ?? shared.autoCommit };
    }
    return perWorktree;
  }

  /** Merged read: public ∪ private overlay (private wins on id collision). Every
   *  QUERY / REINDEX path uses this so MCP + the guards see private memory. Public-
   *  artifact writers keep using this.json.loadAll (public-only) so a private record
   *  can never reach a committed file — see dec_d7bad4ccb7. */
  recs<K extends EntityKind>(kind: K): EntityFor[K][] {
    const pub = this.json.loadAll(kind);
    const priv = this.suppressPrivate ? undefined : this.privateJson?.loadAll(kind);
    if (!priv?.length) return pub;
    const byId = new Map<string, EntityFor[K]>();
    for (const r of pub) byId.set((r as { id: string }).id, r);
    for (const r of priv) byId.set((r as { id: string }).id, r);
    return [...byId.values()];
  }

  /** Whether a private overlay store is configured (HUNCH_PRIVATE_DIR is set). */
  get hasPrivate(): boolean {
    return !!this.privateJson;
  }

  /** Write a record into the PRIVATE overlay (never the public repo). Throws if no
   *  HUNCH_PRIVATE_DIR is configured, so a "private" write can never silently land
   *  in the public `.hunch/`. */
  putPrivate<K extends EntityKind>(kind: K, record: EntityFor[K]): EntityFor[K] {
    if (!this.privateJson) {
      throw new Error("No private store configured — set HUNCH_PRIVATE_DIR to a directory Hunch can write sensitive records into.");
    }
    this.privateJson.ensureDirs();
    return this.privateJson.put(kind, record);
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
    withTx(db, () => {
      db.exec(RESET_SQL);
      const j = (s: string) => s; // readability marker for JSON-encoded columns
      // Prepare the FTS insert ONCE (after RESET created the table), not per row.
      const insFts = db.prepare(`INSERT INTO search (ref, kind, title, body) VALUES (?,?,?,?)`);
      const fts = (ref: string, kind: string, title: string, body: string): void => {
        insFts.run(ref, kind, title, body ?? "");
      };

      const comps = this.recs("components");
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
        fts(c.id, "components", c.name, `${c.responsibility} ${c.paths.join(" ")}`);
      }
      counts.components = comps.length;

      const edges = this.recs("edges");
      const insEdge = db.prepare(`INSERT INTO edges VALUES (@id,@from,@to,@type,@reason,@strength,@ps,@pc,@pe)`);
      for (const e of edges) {
        insEdge.run({ id: e.id, from: e.from, to: e.to, type: e.type, reason: e.reason, strength: e.strength,
          ps: e.provenance.source, pc: e.provenance.confidence, pe: JSON.stringify(e.provenance.evidence) });
      }
      counts.edges = edges.length;

      const syms = this.recs("symbols");
      const insSym = db.prepare(
        `INSERT INTO symbols VALUES (@id,@file,@name,@kind,@sh,@calls,@called_by,@loc,@churn,@bug,@fanin,@fanout,@last)`,
      );
      for (const s of syms) {
        insSym.run({ id: s.id, file: s.file, name: s.name, kind: s.kind, sh: s.signature_hash,
          calls: JSON.stringify(s.calls), called_by: JSON.stringify(s.called_by),
          loc: s.metrics.loc, churn: s.metrics.churn_90d, bug: s.metrics.bug_count,
          fanin: s.metrics.fan_in, fanout: s.metrics.fan_out, last: s.last_changed });
        fts(s.id, "symbols", `${s.name} (${s.kind})`, s.file);
      }
      counts.symbols = syms.length;

      const decs = this.recs("decisions");
      const insDec = db.prepare(
        `INSERT INTO decisions VALUES (@id,@title,@status,@context,@decision,@cons,@alts,@rc,@rf,@sup,@cbb,@commit,@ps,@pc,@pe,@date)`,
      );
      for (const d of decs) {
        insDec.run({ id: d.id, title: d.title, status: d.status, context: d.context, decision: d.decision,
          cons: JSON.stringify(d.consequences), alts: JSON.stringify(d.alternatives_rejected),
          rc: JSON.stringify(d.related_components), rf: JSON.stringify(d.related_files),
          sup: d.supersedes, cbb: d.caused_by_bug, commit: d.commit,
          ps: d.provenance.source, pc: d.provenance.confidence, pe: JSON.stringify(d.provenance.evidence), date: d.date });
        fts(d.id, "decisions", d.title, `${d.context} ${d.decision} ${d.consequences.join(" ")}`);
      }
      counts.decisions = decs.length;

      const bugs = this.recs("bugs");
      const insBug = db.prepare(
        `INSERT INTO bugs VALUES (@id,@title,@symptom,@rc,@sev,@status,@af,@as,@lin,@ps,@pc,@pe)`,
      );
      for (const b of bugs) {
        insBug.run({ id: b.id, title: b.title, symptom: b.symptom, rc: b.root_cause, sev: b.severity, status: b.status,
          af: JSON.stringify(b.affected_files), as: JSON.stringify(b.affected_symbols), lin: JSON.stringify(b.lineage),
          ps: b.provenance.source, pc: b.provenance.confidence, pe: JSON.stringify(b.provenance.evidence) });
        fts(b.id, "bugs", b.title, `${b.symptom} ${b.root_cause}`);
      }
      counts.bugs = bugs.length;

      const cons = this.recs("constraints");
      const insCon = db.prepare(
        `INSERT INTO constraints VALUES (@id,@type,@statement,@scope,@sev,@enf,@rat,@sd,@viol,@ps,@pc,@pe)`,
      );
      for (const c of cons) {
        insCon.run({ id: c.id, type: c.type, statement: c.statement, scope: JSON.stringify(c.scope),
          sev: c.severity, enf: c.enforcement, rat: c.rationale, sd: c.source_decision, viol: JSON.stringify(c.violations),
          ps: c.provenance.source, pc: c.provenance.confidence, pe: JSON.stringify(c.provenance.evidence) });
        fts(c.id, "constraints", c.statement, `${c.rationale} ${c.scope.join(" ")}`);
      }
      counts.constraints = cons.length;

      // Runbooks (roadmap #5): advisory "how" records — no dedicated SQL table, they
      // ride the unified `search` FTS so they retrieve through the same FTS+graph path.
      const runbooks = this.recs("runbooks");
      for (const r of runbooks) {
        fts(r.id, "runbooks", r.task, `${r.trigger.join(" ")} ${r.steps.join(" ")} ${r.gotchas.join(" ")} ${r.outcome} ${r.files.join(" ")}`);
      }
      counts.runbooks = runbooks.length;
      void j;
    });
    // Reconcile embeddings AFTER the FTS rebuild (model-free): drop vectors whose
    // source doc vanished or whose text changed. Embeddings are NOT in RESET_SQL,
    // so this is what keeps them coherent across the many reindex() call sites.
    this.pruneStaleEmbeddings();
    return { counts };
  }

  // ---- read path ----------------------------------------------------------

  /** FTS5 ranked search (hunch_query). Falls back to LIKE if the query has no
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

  // ---- semantic search (opt-in embeddings) --------------------------------

  /** The exact (ref, kind, title, body) docs that feed FTS — and thus embeddings.
   *  A single source so FTS, the doc_hash, and the stored vectors never disagree. */
  private searchDocs(): Array<{ ref: string; kind: string; title: string; body: string }> {
    return this.db.prepare(`SELECT ref, kind, title, body FROM search`).all() as Array<{
      ref: string; kind: string; title: string; body: string;
    }>;
  }

  /** Delete embedding rows whose source doc was removed or whose text changed
   *  (doc_hash mismatch). Model-free and cheap; run at the end of every reindex()
   *  so vectors track the JSON truth without ever being reset. Returns the count. */
  pruneStaleEmbeddings(): number {
    // Lean-install fast path: no vectors → nothing to reconcile. This runs at the
    // end of EVERY reindex() (a hot path), so skip the full doc scan + per-doc hash
    // unless embeddings actually exist.
    if ((this.db.prepare(`SELECT count(*) c FROM embeddings`).get() as { c: number }).c === 0) return 0;
    const live = new Map<string, string>(); // ref -> current doc_hash
    for (const d of this.searchDocs()) live.set(d.ref, embedHash(d.title, d.body));
    const rows = this.db.prepare(`SELECT ref, doc_hash FROM embeddings`).all() as Array<{ ref: string; doc_hash: string }>;
    const del = this.db.prepare(`DELETE FROM embeddings WHERE ref = ?`);
    let pruned = 0;
    withTx(this.db, () => {
      for (const r of rows) if (live.get(r.ref) !== r.doc_hash) { del.run(r.ref); pruned++; }
    });
    return pruned;
  }

  /** Embedding coverage for a model: up-to-date vectors vs total docs (doctor). */
  embeddingStats(model: string): { embedded: number; total: number } {
    const total = (this.db.prepare(`SELECT count(*) c FROM search`).get() as { c: number }).c;
    const embedded = (this.db.prepare(`SELECT count(*) c FROM embeddings WHERE model = ?`).get(model) as { c: number }).c;
    return { embedded, total };
  }

  /** The SINGLE gate for "can semantic search run right now": an embedder exists and
   *  it has at least one stored vector. Used by both hybridSearch and the CLI so the
   *  definition can't drift between them. */
  semanticReady(embedder: Embedder | null): embedder is Embedder {
    return !!embedder && (this.db.prepare(`SELECT count(*) c FROM embeddings WHERE model = ?`).get(embedder.id) as { c: number }).c > 0;
  }

  /** Generate/refresh embeddings for every doc missing an up-to-date vector for
   *  this embedder's model. Batched + flushed per batch so a Ctrl-C leaves a
   *  coherent partial index that a re-run resumes. Assumes reindex() ran first. */
  async embedAll(
    embedder: Embedder,
    opts: { batch?: number; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<{ embedded: number; skipped: number; total: number }> {
    const model = embedder.id;
    const current = new Map<string, string>(); // ref -> stored doc_hash for this model
    for (const r of this.db.prepare(`SELECT ref, doc_hash FROM embeddings WHERE model = ?`).all(model) as Array<{ ref: string; doc_hash: string }>) {
      current.set(r.ref, r.doc_hash);
    }
    const docs = this.searchDocs().map((d) => ({ ...d, hash: embedHash(d.title, d.body) }));
    const todo = docs.filter((d) => current.get(d.ref) !== d.hash);
    const ins = this.db.prepare(`INSERT OR REPLACE INTO embeddings (ref, kind, model, dim, doc_hash, vec) VALUES (?,?,?,?,?,?)`);
    const batchSize = opts.batch ?? 32;
    let embedded = 0; // ACTUAL rows written (a batch may yield fewer vectors than docs)
    let attempted = 0;
    for (let i = 0; i < todo.length; i += batchSize) {
      const slice = todo.slice(i, i + batchSize);
      const vecs = await embedder.embed(slice.map((d) => `${d.title}\n${d.body}`));
      withTx(this.db, () => {
        slice.forEach((d, j) => {
          const v = vecs[j];
          if (v) { ins.run(d.ref, d.kind, model, embedder.dim, d.hash, vecToBlob(v)); embedded++; }
        });
      });
      attempted += slice.length;
      opts.onProgress?.(attempted, todo.length);
    }
    return { embedded, skipped: docs.length - todo.length, total: docs.length };
  }

  /** Hybrid search (hunch_query / `hunch query --semantic`): FTS bm25 fused with
   *  cosine over stored embeddings via Reciprocal Rank Fusion. Degrades to pure
   *  sync FTS (zero added latency) when there's no embedder or no vectors yet, so
   *  the lean install and fallback regressions are unaffected. Pass
   *  `embedder: null` to FORCE FTS-only without auto-selecting. */
  async hybridSearch(query: string, limit = 12, opts: { embedder?: Embedder | null; graphWeight?: number } = {}): Promise<SearchHit[]> {
    // Explicit `embedder: null` forces pure FTS-only (no semantic, no graph) — the
    // documented escape hatch and the lean-fallback regression guard.
    if (opts.embedder === null) return this.search(query, limit);
    const embedder = opts.embedder !== undefined ? opts.embedder : await selectEmbedder();
    // graphWeight override lets the eval harness A/B the graph stream (0 = off) on one
    // store without re-loading the module const; defaults to the configured weight.
    const gw = opts.graphWeight ?? RRF_W_GRAPH;

    const fts = this.search(query, Math.max(limit, 50));
    let sem: SearchHit[] = [];
    if (embedder && this.semanticReady(embedder)) {
      try {
        // The semantic leg (query embedding + decode + cosine) is guarded: any failure —
        // model load, a corrupt/dim-mismatched vector — degrades to lexical + graph.
        const [qvec] = await embedder.embed([query]);
        if (qvec) sem = this.cosineRank(qvec, embedder.id, 50);
      } catch { sem = []; }
    }
    // The graph stream is model-free, so it contributes even on a lean (no-embeddings)
    // install. With neither semantic nor graph signal, return pure FTS so the
    // zero-fusion-overhead fast path is preserved.
    const graph = this.graphExpand([...fts, ...sem], 50, gw);
    if (!sem.length && !graph.length) return fts.slice(0, limit);
    return this.rrfFuse(fts, sem, graph, limit, gw);
  }

  /** Runbook-scoped retrieval (roadmap #5): the same FTS+graph(+semantic) fusion,
   *  restricted to the `runbooks` kind — so a "what's the procedure for X" query
   *  competes only with other runbooks, not the whole graph. Measurement showed
   *  whole-corpus retrieval buries terse runbooks (33% recall); scoping + semantic
   *  lifted recall@5 to 83% (dec_1239efae54 follow-up). Pass an embedder for the
   *  semantic leg; omit for keyword+graph. */
  async searchRunbooks(query: string, limit = 5, opts: { embedder?: Embedder | null } = {}): Promise<SearchHit[]> {
    return this.searchScoped(query, "runbooks", limit, opts);
  }

  /** Kind-SCOPED retrieval: FTS + (optional) semantic fused, but the candidate pool is
   *  restricted to one record kind from the START — not over-fetched from a whole-corpus
   *  ranking (whose top-50 cap can bury a terse record before any filter). This is what
   *  lifted runbook recall@5 from 33% → 83% in the measurement (dec_1239efae54 follow-up). */
  async searchScoped(query: string, kind: string, limit = 5, opts: { embedder?: Embedder | null } = {}): Promise<SearchHit[]> {
    const fts = this.scopedFts(query, kind, Math.max(limit, 20));
    const embedder = opts.embedder !== undefined ? opts.embedder : await selectEmbedder();
    let sem: SearchHit[] = [];
    if (embedder && this.semanticReady(embedder)) {
      try {
        const [qvec] = await embedder.embed([query]);
        if (qvec) sem = this.cosineRank(qvec, embedder.id, Math.max(limit, 20), kind);
      } catch { sem = []; }
    }
    if (!sem.length) return fts.slice(0, limit);
    return this.rrfFuse(fts, sem, [], limit);
  }

  /** FTS bm25 over a single kind (the `kind` column is UNINDEXED, so a plain `=`
   *  constraint composes with MATCH). Empty when the query has no FTS-able terms. */
  private scopedFts(query: string, kind: string, limit: number): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    try {
      const rows = this.db.prepare(
        `SELECT ref, kind, title, snippet(search, 3, '[', ']', '…', 12) AS snip, bm25(search) AS score
         FROM search WHERE search MATCH ? AND kind = ? ORDER BY score LIMIT ?`,
      ).all(match, kind, limit) as Array<{ ref: string; kind: string; title: string; snip: string; score: number }>;
      return rows.map((r) => ({ ref: r.ref, kind: r.kind, title: r.title, snippet: r.snip, score: r.score }));
    } catch {
      return [];
    }
  }

  /** Brute-force exact cosine top-n over stored vectors for one model. Vectors are
   *  pre-normalized, so cosine == dot product. Scoped to `dim = qvec.length` so a
   *  row stored at a different dimension (model id reused at a new dim) can never
   *  drive an out-of-bounds BLOB read; any with an unexpected byte length are
   *  skipped defensively rather than crashing the query. */
  private cosineRank(qvec: Float32Array, model: string, n: number, kind?: string): SearchHit[] {
    const dim = qvec.length;
    const rows = this.db.prepare(
      `SELECT ref, kind, vec FROM embeddings WHERE model = ? AND dim = ?${kind ? " AND kind = ?" : ""}`,
    ).all(...(kind ? [model, dim, kind] : [model, dim])) as Array<{ ref: string; kind: string; vec: Uint8Array }>;
    const scored: Array<{ ref: string; kind: string; score: number }> = [];
    for (const r of rows) {
      if (r.vec.byteLength !== dim * 4) continue; // corrupt/legacy row — skip, don't read past it
      const v = blobToVec(r.vec, dim);
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += qvec[i]! * v[i]!;
      scored.push({ ref: r.ref, kind: r.kind, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, n);
    // Hydrate title/snippet for the top-n in ONE query (not a per-row SELECT).
    const meta = new Map<string, { title: string; body: string }>();
    if (top.length) {
      const placeholders = top.map(() => "?").join(",");
      for (const row of this.db.prepare(`SELECT ref, title, body FROM search WHERE ref IN (${placeholders})`).all(...top.map((s) => s.ref)) as Array<{ ref: string; title: string; body: string }>) {
        meta.set(row.ref, { title: row.title, body: row.body });
      }
    }
    return top.map((s) => {
      const m = meta.get(s.ref);
      return { ref: s.ref, kind: s.kind, title: m?.title ?? s.ref, snippet: (m?.body ?? "").slice(0, 120), score: s.score };
    });
  }

  /** Rank-based Reciprocal Rank Fusion of the FTS, semantic, and graph lists. Ranks
   *  (not raw scores) erase the bm25-vs-cosine-vs-graph scale mismatch; a small lexical
   *  weight keeps exact symbol/path matches from being displaced by paraphrase or
   *  neighbor hits. An empty list contributes nothing, so 2-stream behavior is exactly
   *  preserved when graph (or sem) is absent. */
  private rrfFuse(fts: SearchHit[], sem: SearchHit[], graph: SearchHit[], limit: number, graphWeight = RRF_W_GRAPH): SearchHit[] {
    const acc = new Map<string, { hit: SearchHit; score: number }>();
    const add = (list: SearchHit[], weight: number) =>
      list.forEach((hit, i) => {
        const e = acc.get(hit.ref) ?? { hit, score: 0 };
        e.score += weight / (RRF_K + i + 1);
        acc.set(hit.ref, e);
      });
    add(fts, RRF_W_FTS);
    add(sem, RRF_W_SEM);
    add(graph, graphWeight);
    return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((e) => ({ ...e.hit, score: e.score }));
  }

  /** Graph retrieval stream (roadmap #1): 1-hop expansion over the dependency graph
   *  from the lexical/semantic seed hits. For each seed SYMBOL, surface its direct
   *  neighbors (callers/callees, importers/imported, container) — the cross-file
   *  evidence a "why" question needs but that neither bm25 nor cosine reaches. Each
   *  neighbor accrues GAMMA-decayed support per linking seed (one pulled in by several
   *  top seeds ranks higher); seeds themselves are excluded, so this only ADDS context.
   *  Deterministic, model-free (runs on a lean install too), one indexed query per seed. */
  private graphExpand(seeds: SearchHit[], n: number, weight = RRF_W_GRAPH): SearchHit[] {
    if (weight <= 0) return [];
    const symSeeds = seeds.filter((h) => h.ref.startsWith("sym_"));
    if (!symSeeds.length) return [];
    const seen = new Set(seeds.map((h) => h.ref)); // never re-surface a seed
    const nbStmt = this.db.prepare(
      /* sql */ `
      SELECT e."to"   AS nb FROM edges e WHERE e."from" = ? AND e.type IN ('calls','depends_on','imports','contains')
      UNION
      SELECT e."from" AS nb FROM edges e WHERE e."to"   = ? AND e.type IN ('calls','depends_on','imports','contains')`,
    );
    const score = new Map<string, number>();
    symSeeds.forEach((h, i) => {
      const contrib = GRAPH_GAMMA / (RRF_K + i + 1);
      for (const r of nbStmt.all(h.ref, h.ref) as Array<{ nb: string }>) {
        if (seen.has(r.nb)) continue;
        score.set(r.nb, (score.get(r.nb) ?? 0) + contrib);
      }
    });
    if (!score.size) return [];
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    // Hydrate title/snippet from the FTS table in ONE query (mirrors cosineRank).
    const placeholders = top.map(() => "?").join(",");
    const meta = new Map<string, { title: string; body: string }>();
    for (const row of this.db.prepare(`SELECT ref, title, body FROM search WHERE ref IN (${placeholders})`).all(...top.map(([ref]) => ref)) as Array<{ ref: string; title: string; body: string }>) {
      meta.set(row.ref, { title: row.title, body: row.body });
    }
    return top.map(([ref, s]) => {
      const m = meta.get(ref);
      return { ref, kind: ref.startsWith("cmp_") ? "component" : "symbol", title: m?.title ?? ref, snippet: (m?.body ?? "").slice(0, 120), score: s };
    });
  }

  /** All decisions/bugs/constraints/symbols/components touching a file path or
   *  symbol name (hunch_why). Pass `{ asOf }` (an ISO instant) to TIME-TRAVEL:
   *  return only decisions/constraints whose valid-time window contained that
   *  instant — "what did we believe as of commit X?". Omit `asOf` for the full,
   *  history-inclusive view (backward-compatible default). */
  why(target: string, opts: { asOf?: string } = {}): WhyResult {
    target = toPosixTarget(target);
    const decisions = this.recs("decisions");
    const bugs = this.recs("bugs");
    const constraints = this.recs("constraints");
    const symbols = this.recs("symbols");
    const components = this.recs("components");
    const asOf = opts.asOf;

    const matchedSymbols = symbols.filter((s) => s.file === target || s.name === target || s.id === target || s.file.endsWith(target));
    const symIds = new Set(matchedSymbols.map((s) => s.id));
    const fileSet = new Set(matchedSymbols.map((s) => s.file));
    const isPath = target.includes("/") || target.includes(".");

    const fileMatch = (files: string[]) =>
      files.some((f) => f === target || (isPath && (f.endsWith(target) || target.endsWith(f))) || fileSet.has(f));

    return {
      target,
      decisions: decisions.filter(
        (d) => (fileMatch(d.related_files) || d.related_components.some((c) => components.find((x) => x.id === c && fileMatch(x.paths))))
          && inWindow(d.valid_from, d.valid_to, asOf)),
      bugs: bugs.filter((b) => fileMatch(b.affected_files) || b.affected_symbols.some((s) => symIds.has(s))),
      constraints: constraints.filter((c) => c.scope.some((g) => pathMatchesGlob(target, g) || [...fileSet].some((f) => pathMatchesGlob(f, g)))
        && inWindow(c.valid_from, c.valid_to, asOf)),
      symbols: matchedSymbols,
      components: components.filter((c) => c.paths.some((g) => pathMatchesGlob(target, g) || [...fileSet].some((f) => pathMatchesGlob(f, g)))),
    };
  }

  /** Transitive blast radius: every symbol/component that (in)directly depends on
   *  `id`, via a recursive CTE over the edges graph (hunch_get_dependents). We
   *  walk edges BACKWARD (edges.to = current) following call/dep/import/contains. */
  getDependents(id: string, maxDepth = 6): Array<{ id: string; depth: number; via: string }> {
    return this.db.prepare(
      /* sql */ `
      WITH RECURSIVE up(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e."from", up.depth + 1
        FROM edges e JOIN up ON e."to" = up.node
        WHERE e.type IN ('calls','depends_on','imports','contains') AND up.depth < ?
      )
      SELECT up.node AS id, MIN(up.depth) AS depth,
             COALESCE(s.name || ' @ ' || s.file, c.name, up.node) AS via
      FROM up
      LEFT JOIN symbols s ON s.id = up.node
      LEFT JOIN components c ON c.id = up.node
      WHERE up.node <> ? GROUP BY up.node ORDER BY depth, id`,
    ).all(id, maxDepth, id) as Array<{ id: string; depth: number; via: string }>;
  }

  /** Symbols/components this id depends ON (forward walk) — used for refactor blast radius. */
  getDependencies(id: string, maxDepth = 6): Array<{ id: string; depth: number; via: string }> {
    return this.db.prepare(
      /* sql */ `
      WITH RECURSIVE down(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT e."to", down.depth + 1
        FROM edges e JOIN down ON e."from" = down.node
        WHERE e.type IN ('calls','depends_on','imports','contains') AND down.depth < ?
      )
      SELECT down.node AS id, MIN(down.depth) AS depth,
             COALESCE(s.name || ' @ ' || s.file, c.name, down.node) AS via
      FROM down
      LEFT JOIN symbols s ON s.id = down.node
      LEFT JOIN components c ON c.id = down.node
      WHERE down.node <> ? GROUP BY down.node ORDER BY depth, id`,
    ).all(id, maxDepth, id) as Array<{ id: string; depth: number; via: string }>;
  }

  /** Files whose symbols (in)directly DEPEND ON a symbol defined in `file` — the
   *  blast radius of editing `file`, collapsed to file granularity (nearest depth
   *  wins per file). Powers `hunch check` near-violation detection and `--blast`. */
  blastRadiusFiles(file: string, maxDepth = 4): Array<{ file: string; via: string; depth: number }> {
    // ONE backward CTE seeded by every symbol in `file`, joined to symbols for the
    // dependent file/name. GROUP BY file + MIN(depth): SQLite's single-min rule makes
    // the bare `via` take the name from the nearest-depth row. The inner JOIN drops
    // non-symbol nodes; `s.file <> ?` drops self-file dependents.
    return this.db.prepare(
      /* sql */ `
      WITH RECURSIVE up(node, depth) AS (
        SELECT id, 0 FROM symbols WHERE file = ?
        UNION
        SELECT e."from", up.depth + 1
        FROM edges e JOIN up ON e."to" = up.node
        WHERE e.type IN ('calls','depends_on','imports','contains') AND up.depth < ?
      )
      SELECT s.file AS file, s.name AS via, MIN(up.depth) AS depth
      FROM up JOIN symbols s ON s.id = up.node
      WHERE up.depth > 0 AND s.file <> ?
      GROUP BY s.file ORDER BY depth, file`,
    ).all(file, maxDepth, file) as Array<{ file: string; via: string; depth: number }>;
  }

  /** Constraints whose scope glob matches a path/glob (hunch_check_constraints).
   *  By default only ACTIVE invariants are returned — a retired constraint is no
   *  longer enforced. Pass `{ asOf }` to instead return the invariants in force at
   *  that instant (time-travel: "what must I not have broken as of commit X?"). */
  checkConstraints(scope: string, opts: { asOf?: string } = {}): Constraint[] {
    const all = this.recs("constraints");
    const asOf = opts.asOf;
    return all
      .filter((c) => c.scope.some((g) => pathMatchesGlob(scope, g) || pathMatchesGlob(g, scope) || g === scope))
      .filter((c) => (asOf ? inWindow(c.valid_from, c.valid_to, asOf) : c.status !== "retired"))
      .sort((a, b) => sev(b.severity) - sev(a.severity));
  }

  /** The causal chain behind a constraint — the WHY a diff-only reviewer can't see.
   *  Deterministic graph join: constraint → source_decision (the decision that
   *  motivated the guard) → the bug whose root cause spawned it (via
   *  lineage.spawned_constraint, else the source decision's caused_by_bug). Read-only. */
  causalChain(constraintId: string): CausalWhy {
    const out: CausalWhy = { constraint_id: constraintId };
    const c = this.json.get("constraints", constraintId);
    if (!c) return out;
    const dec = c.source_decision ? this.json.get("decisions", c.source_decision) : null;
    if (dec) out.decision = { id: dec.id, title: dec.title, decision: dec.decision };
    const bugs = this.recs("bugs");
    // Deterministic when several bugs link one constraint (the verdict claims to be
    // deterministic): highest severity first, then lowest id — never filesystem order.
    const SEV: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
    const linked = bugs
      .filter((b) => b.lineage?.spawned_constraint === constraintId)
      .sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0) || a.id.localeCompare(b.id));
    const bug = linked[0] ?? (dec?.caused_by_bug ? bugs.find((b) => b.id === dec.caused_by_bug) : undefined);
    if (bug) out.bug = { id: bug.id, title: bug.title, root_cause: bug.root_cause };
    return out;
  }

  /** Assemble a CheckReport from a diff: direct invariant hits, near hits (blast
   *  radius), and regressions (re-added retired code), with the hardened strict
   *  gate and a causal `why` citation per direct hit. Read-only — shared by
   *  `hunch check`, the CI guard, and hunch_merge_verdict so they never drift. */
  buildCheckReport(files: string[], diff: string, opts: { strict: boolean; lastChange?: (f: string) => string; publicOnly?: boolean }): CheckReport {
    // publicOnly excludes the private overlay from THIS report — required for any output
    // that may be posted publicly (the CI PR comment), since a posted comment is a leak
    // surface equal to a committed file. Local `hunch check` / the pre-edit hook omit it
    // and so still enforce private constraints. See dec_d7bad4ccb7.
    const prevSuppress = this.suppressPrivate;
    this.suppressPrivate = opts.publicOnly ?? false;
    try {
    const direct = new Map<string, { c: Constraint; files: string[] }>();
    for (const f of files) for (const c of this.checkConstraints(f)) {
      const e = direct.get(c.id) ?? { c, files: [] };
      e.files.push(f);
      direct.set(c.id, e);
    }
    const near = new Map<string, { c: Constraint; via: string[] }>();
    for (const f of files) for (const b of this.blastRadiusFiles(f)) for (const c of this.checkConstraints(b.file)) {
      if (direct.has(c.id)) continue;
      const e = near.get(c.id) ?? { c, via: [] };
      e.via.push(`${f} → ${b.file} (${b.via}, depth ${b.depth})`);
      near.set(c.id, e);
    }
    const an = analyzeDiff(diff);
    const regHits = this.regressionHits({ symbols: an.addedSymbols.map((s) => s.name), deps: an.addedDeps }, files);
    const staleRecords = opts.strict && opts.lastChange ? this.staleness(opts.lastChange) : [];
    const staleIds = new Set(staleRecords.filter((s) => s.kind === "constraint").map((s) => s.id));
    const staleDecisionIds = new Set(staleRecords.filter((s) => s.kind === "decision").map((s) => s.id));
    const vetoes = this.vetoHits(an, files, staleDecisionIds);
    const redundant = this.redundantSymbols(an.addedSymbols, files, {
      movedFrom: [...an.filesRenamed.map((r) => r.from), ...an.filesDeleted],
      removedNames: new Set(an.removedSymbols.map((s) => s.name)),
    });
    const directReport: CheckDirect[] = [];
    const addedDepSet = new Set(an.addedDeps);
    for (const { c, files: fs } of direct.values()) {
      const forbids = effectiveForbids(c);
      if (forbids) {
        // CONTENT-MATCHED: decide by whether the diff actually breaks the rule (a forbidden
        // dep imported / symbol added / pattern matched in scoped code) — not by bare
        // scope-touch. A commit that touches the scope but doesn't trip it COMPLIES → drop it
        // (no noise). A real hit blocks WITHOUT the staleness gate: content is verified per
        // commit, so file churn can't retract the teeth (dec_e0a36efbf5). Empty diff ⇒ can't
        // prove a violation ⇒ treat as clean.
        const scopedAdded = fs.flatMap((f) => an.addedLinesByFile.get(f) ?? []);
        if (!matchForbids(forbids, addedDepSet, scopedAdded)) continue;
        const strictBlocks = isStrictBlocker(c, false);
        directReport.push({
          id: c.id, severity: c.severity ?? "advisory", statement: c.statement, rationale: c.rationale ?? "",
          files: fs, strictBlocks,
          downgrade: c.severity === "blocking" && !strictBlocks ? "low-confidence" : undefined,
          why: this.causalChain(c.id),
        });
        continue;
      }
      const stale = staleIds.has(c.id);
      const strictBlocks = isStrictBlocker(c, stale);
      directReport.push({
        id: c.id, severity: c.severity ?? "advisory", statement: c.statement, rationale: c.rationale ?? "",
        files: fs, strictBlocks,
        downgrade: c.severity === "blocking" && !strictBlocks ? (stale ? "stale" : "low-confidence") : undefined,
        why: this.causalChain(c.id),
      });
    }
    return {
      fileCount: files.length,
      strict: opts.strict,
      direct: directReport,
      near: [...near.values()].map(({ c, via }) => ({ id: c.id, severity: c.severity ?? "advisory", statement: c.statement, via })),
      regressions: regHits.map((h) => ({ kind: h.kind, name: h.name, decision: h.decision, title: h.title, reason: h.reason, blocking: h.blocking })),
      vetoes: vetoes.map((v) => ({ decision: v.decision, title: v.title, alternative: v.alternative, chosen: v.chosen, tier: v.tier, evidence: v.evidence, blocking: v.blocks })),
      redundant,
      strictBlockers: directReport.filter((d) => d.strictBlocks).length,
      regBlocking: regHits.filter((h) => h.blocking).length,
      vetoBlocking: vetoes.filter((v) => v.blocks).length,
    };
    } finally {
      this.suppressPrivate = prevSuppress;
    }
  }

  /** Sprawl/"this already exists" guard (ADVISORY, never blocks). A symbol the diff
   *  ADDS whose name already exists in the indexed graph in a file NOT touched by the
   *  diff is a likely re-implementation the agent's local context window couldn't see.
   *  Read-only. Heuristic, so noise is controlled: top-level function/class/const only,
   *  name length ≥ 4, a stopword list of generic names, deduped, and capped. */
  redundantSymbols(
    added: Array<{ name: string; kind: string }>,
    files: string[],
    opts: { movedFrom?: string[]; removedNames?: Set<string> } = {},
  ): Array<{ name: string; kind: string; existingFile: string }> {
    if (!added.length) return [];
    const KINDS = new Set(["function", "class", "const"]);
    const STOP = new Set([
      "index", "handler", "handlers", "default", "main", "run", "start", "stop", "setup", "init",
      "constructor", "render", "create", "update", "build", "parse", "load", "save", "next", "data",
      "value", "item", "items", "props", "state", "config", "options", "result", "route", "routes",
      "app", "server", "client", "test", "tests", "mock", "stub", "helper", "helpers", "util", "utils",
      "types", "schema", "constants", "common", "shared", "base", "model", "models", "view", "store",
    ]);
    // Match only against top-level VALUE declarations already in the graph. A method
    // (`obj.close()`) or the file node itself sharing a name is not a re-implementation.
    // ("variable" is kept for forward-compat; the current indexer emits arrow-fn consts
    // as "function", so const re-implementations are still matched.)
    const EXISTING_KINDS = new Set(["function", "class", "variable"]);
    // A symbol carried into a moved/deleted file is being relocated, not duplicated. The
    // changed-file list uses --diff-filter=ACMR, so a sub-threshold move (Add new + Delete
    // old) drops the old path — add the move-from / deleted paths back so their lingering
    // graph entries are not mistaken for a separate "existing" implementation.
    const changed = new Set(files);
    for (const p of opts.movedFrom ?? []) changed.add(p);
    const removedNames = opts.removedNames ?? new Set<string>();
    // Only compare within the diff's own top-level root(s). A name that also exists in a
    // test fixture or a separate sub-project (test/, vscode-extension/, site/) is not
    // sprawl in the source under change — different roots, different ownership.
    const roots = new Set(files.map((f) => f.split("/")[0]));
    const symbols = this.recs("symbols");
    const out: Array<{ name: string; kind: string; existingFile: string }> = [];
    const seen = new Set<string>();
    for (const sc of added) {
      const name = sc.name;
      if (seen.has(name) || name.length < 4 || !KINDS.has(sc.kind) || STOP.has(name.toLowerCase())) continue;
      if (removedNames.has(name)) continue; // the same name was removed in this diff → moved, not duplicated
      const hit = symbols.find((s) => s.name === name && !changed.has(s.file) && EXISTING_KINDS.has(s.kind) && roots.has(s.file.split("/")[0]));
      if (hit) {
        seen.add(name);
        out.push({ name, kind: sc.kind, existingFile: hit.file });
        if (out.length >= 10) break;
      }
    }
    return out;
  }

  /** Time-travel: the decision history for a target — every decision touching it,
   *  newest-first, with its valid-time window and supersession links. Answers
   *  "what did we believe, and when/why did it change?" (hunch_timeline). */
  timeline(target: string): Decision[] {
    return this.why(target).decisions.sort((a, b) => (b.valid_from ?? b.date).localeCompare(a.valid_from ?? a.date));
  }

  /** Invalidate, don't delete (Zep edge-invalidation): close `oldId`'s valid-time
   *  window at the superseding decision's `valid_from`, mark it superseded + linked,
   *  and write a `supersedes` edge. Returns the updated old decision, or null if it
   *  doesn't exist. All writes are atomic via json.put (con_902759b3dc). */
  supersede(oldId: string, by: Decision): Decision | null {
    return this.supersedeIn(this.json, oldId, by);
  }

  /** Look up a decision by id in a SPECIFIC store — the public store, or the private
   *  overlay when `priv` is true — NOT the union. The capture guard uses this to know
   *  whether a supersede will actually close its target: `supersede`/`supersedePrivate`
   *  each look in only one store, so a cross-store supersede silently no-ops and would
   *  leave two live decisions on one topic. Returns undefined if absent (or no overlay). */
  decisionInStore(id: string, priv: boolean): Decision | undefined {
    const store = priv ? this.privateJson : this.json;
    return store?.get("decisions", id);
  }

  /** Private-overlay counterpart of `supersede`: close + link the old decision inside
   *  the HUNCH_PRIVATE_DIR store, so a PRIVATE decision can supersede another private
   *  one (the MCP record path is private→private). A private write never mutates the
   *  committed public store. Returns null if no private store is configured or the old
   *  record isn't in it. */
  supersedePrivate(oldId: string, by: Decision): Decision | null {
    if (!this.privateJson) return null;
    this.privateJson.ensureDirs();
    return this.supersedeIn(this.privateJson, oldId, by);
  }

  /** Shared body for supersede / supersedePrivate against a specific store. */
  private supersedeIn(json: JsonStore, oldId: string, by: Decision): Decision | null {
    const old = json.get("decisions", oldId);
    if (!old || old.id === by.id) return null;
    const closed: Decision = {
      ...old,
      status: "superseded",
      superseded_by: by.id,
      valid_to: old.valid_to ?? by.valid_from ?? null,
    };
    json.put("decisions", closed);
    const edge: Edge = {
      id: edgeId(by.id, oldId, "supersedes"),
      from: by.id,
      to: oldId,
      type: "supersedes",
      reason: `${by.id} supersedes ${oldId}`,
      strength: 1,
      provenance: { source: "derived", confidence: 1, evidence: [by.id, oldId] },
    };
    json.put("edges", edge);
    return closed;
  }

  /** Regression Guard: detect a change RE-INTRODUCING something an in-force
   *  decision deliberately removed. Matches the added symbols/deps of a diff
   *  against the `retired` signal of decisions concerning the touched files. A hit
   *  is `blocking` when the retiring decision is tied to an ACTIVE blocking
   *  constraint (via source_decision) — that's the only case the strict guard
   *  fails the commit on; everything else is an advisory warning. */
  regressionHits(added: { symbols: string[]; deps: string[] }, files: string[]): RegressionHit[] {
    const addedSyms = new Set(added.symbols);
    const addedDeps = new Set(added.deps);
    if (!addedSyms.size && !addedDeps.size) return [];
    const fileRelevant = (related: string[]) =>
      related.some((f) => files.some((x) => pathRelated(x, f)));
    const decisions = this.recs("decisions");
    // decisions tied to an active blocking constraint via source_decision
    const blockingDec = new Set(
      this.recs("constraints")
        .filter((c) => c.severity === "blocking" && c.status !== "retired" && c.source_decision)
        .map((c) => c.source_decision as string),
    );
    const out: RegressionHit[] = [];
    const seen = new Set<string>(); // dedup by kind+name: report each resurrected item once
    const add = (d: Decision, kind: RegressionHit["kind"], name: string) => {
      const key = `${kind}:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ decision: d.id, title: d.title, kind, name, blocking: blockingDec.has(d.id), reason: d.decision || d.title });
    };
    // Blocking-linked decisions first, so a deduped hit keeps the higher-severity
    // attribution (the strict guard fails on `blocking`).
    const ordered = [...decisions].sort((a, b) => Number(blockingDec.has(b.id)) - Number(blockingDec.has(a.id)));
    for (const d of ordered) {
      // Only IN-FORCE decisions: re-adding what an OUTDATED (superseded) decision
      // removed is not a regression against the current design.
      if (d.superseded_by || d.status === "superseded") continue;
      if (!d.retired.symbols.length && !d.retired.deps.length) continue;
      if (!fileRelevant(d.related_files)) continue;
      for (const s of d.retired.symbols) if (addedSyms.has(s)) add(d, "symbol", s);
      for (const dep of d.retired.deps) if (addedDeps.has(dep)) add(d, "dep", dep);
    }
    return out;
  }

  /** Veto Guard: detect a change RE-INTRODUCING an approach an in-force decision
   *  deliberately REJECTED (`decision.rejected_tripwires`). The counterpart to
   *  regressionHits, which only sees code that once existed — a rejected alternative
   *  never did. Precision-first ladder (dep > symbol > pattern); the semantic tier is
   *  advisory and lives elsewhere. A hit `blocks` only when isVetoBlocker passes (a
   *  human-confirmed tripwire on an in-force, non-stale decision — dec_a466655539).
   *  Read-only; shared by buildCheckReport. */
  vetoHits(an: DiffAnalysis, files: string[], staleDecisions: Set<string> = new Set()): VetoHit[] {
    const addedDeps = new Set(an.addedDeps);
    const out: VetoHit[] = [];
    const seen = new Set<string>(); // dedup: one hit per decision+alternative
    for (const d of this.recs("decisions")) {
      if (d.superseded_by || d.status === "superseded") continue; // in-force only
      const tripwires = d.rejected_tripwires ?? [];
      if (!tripwires.length) continue;
      const stale = staleDecisions.has(d.id);
      for (const tw of tripwires) {
        // scope: a tripwire with globs must intersect the touched files; scopeless = any
        const scopedFiles = tw.scope.length
          ? files.filter((f) => tw.scope.some((g) => pathMatchesGlob(f, g)))
          : files;
        if (tw.scope.length && !scopedFiles.length) continue;
        // added line bodies within the scoped files (call sites, not just decls)
        const scopedAdded: string[] = [];
        for (const f of scopedFiles) {
          const lines = an.addedLinesByFile.get(f);
          if (lines) scopedAdded.push(...lines);
        }
        const match = matchTripwire(tw, addedDeps, scopedAdded);
        if (!match) continue;
        const key = `${d.id}::${tw.alternative}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          decision: d.id,
          title: d.title,
          alternative: tw.alternative,
          chosen: d.decision || d.title,
          tier: match.tier,
          evidence: [...match.evidence, ...scopedFiles.slice(0, 3)],
          blocks: isVetoBlocker(d, tw, match.tier, stale),
          why: d.caused_by_bug ? this.vetoWhy(d.caused_by_bug) : undefined,
        });
      }
    }
    return out;
  }

  /** Resolve a veto's causal citation: the bug whose root cause spawned the decision
   *  (decision → caused_by_bug). Distinct from causalChain, which is constraint-keyed. */
  private vetoWhy(bugId: string): VetoHit["why"] {
    const bug = this.json.get("bugs", bugId);
    return bug ? { bug: { id: bug.id, title: bug.title, root_cause: bug.root_cause } } : undefined;
  }

  /** Veto check for a LIVE edit (the agent pre-edit hook): no diff exists yet, so
   *  synthesize a minimal added-only diff from the proposed new lines and run the
   *  same vetoHits ladder. Freshness needs git lastChange (unavailable at edit time),
   *  so the staleness gate is skipped here — the commit/CI path applies it. */
  vetoForFileEdit(file: string, addedLines: string[]): VetoHit[] {
    if (!addedLines.length) return [];
    const f = toPosixTarget(file);
    const synthetic = [
      `diff --git a/${f} b/${f}`,
      `--- a/${f}`,
      `+++ b/${f}`,
      `@@ -0,0 +1,${addedLines.length} @@`,
      ...addedLines.map((l) => `+${l}`),
    ].join("\n");
    return this.vetoHits(analyzeDiff(synthetic), [f]);
  }

  /** The symbols/deps an in-force decision deliberately RETIRED from a file — the
   *  agent-hook grounding ("don't re-add X here; dec_Y removed it"). No diff is
   *  available at edit time, so this surfaces the risk as context, not a block. */
  retiredForFile(file: string): RetiredNote[] {
    const out: RetiredNote[] = [];
    for (const d of this.recs("decisions")) {
      if (d.superseded_by || d.status === "superseded") continue;
      if (!d.retired.symbols.length && !d.retired.deps.length) continue;
      if (!d.related_files.some((f) => pathRelated(f, file))) continue;
      out.push({ decision: d.id, title: d.title, symbols: d.retired.symbols, deps: d.retired.deps });
    }
    return out;
  }

  /** Bugs matching a symptom (FTS over bugs) or a symbol, with lineage (hunch_bug_lineage). */
  bugLineage(symptomOrSymbol: string): Bug[] {
    const bugs = this.recs("bugs");
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

  /** Ranked fragility report (hunch fragile). fragility = weighted churn + bugs + fan-in. */
  fragility(limit = 15): FragileNode[] {
    const syms = this.recs("symbols");
    const bugs = this.recs("bugs");
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
    return this.recs("edges");
  }

  /** Drift detection (DESIGN §9 "staleness kills trust"): a decision/constraint
   *  is STALE when a file in its scope changed AFTER it was last verified. The
   *  caller supplies `lastChange(file) -> ISO date | ""` (git-backed). */
  staleness(lastChange: (file: string) => string): StaleRecord[] {
    const out: StaleRecord[] = [];
    const check = (kind: string, id: string, files: string[], verified: string | undefined) => {
      if (!verified) return; // never verified → not flagged as drift (it's just new)
      const vt = Date.parse(verified);
      if (Number.isNaN(vt)) return;
      let newest = "";
      for (const f of files) {
        const d = lastChange(f);
        if (d && Date.parse(d) > vt && d > newest) newest = d;
      }
      if (newest) out.push({ kind, id, last_verified: verified, changed_at: newest, files: files.slice(0, 8) });
    };
    for (const d of this.recs("decisions")) check("decision", d.id, d.related_files, d.provenance.last_verified);
    for (const c of this.recs("constraints")) check("constraint", c.id, c.scope, c.provenance.last_verified);
    return out.sort((a, b) => b.changed_at.localeCompare(a.changed_at));
  }

  /** The Context Assembler (DESIGN §2.1/§6): the MINIMAL relevant Hunch slice for
   *  a task on `target`, ordered by what matters most — invariants first, then the
   *  why, then blast radius and bug history — trimmed to a rough token budget. */
  assembleContext(target: string, budget = 1500, opts: { asOf?: string } = {}): AssembledContext {
    target = toPosixTarget(target);
    const w = this.why(target, opts);
    const symIds = w.symbols.map((s) => s.id);
    const blast = new Map<string, { id: string; depth: number; via: string }>();
    for (const id of symIds) {
      for (const d of this.getDependents(id)) {
        const prev = blast.get(d.id);
        if (!prev || d.depth < prev.depth) blast.set(d.id, d); // keep the MIN depth across start symbols
      }
    }
    const bugs = w.bugs.length ? w.bugs : this.bugLineage(target);

    const ctx: AssembledContext = {
      target,
      constraints: w.constraints.sort((a, b) => sev(b.severity) - sev(a.severity)),
      decisions: w.decisions.sort((a, b) => (b.provenance.confidence ?? 0) - (a.provenance.confidence ?? 0)),
      bugs,
      blast_radius: [...blast.values()].sort((a, b) => a.depth - b.depth).slice(0, 12),
      components: w.components,
      budget_tokens: budget,
    };
    return ctx;
  }
}

export interface StaleRecord {
  kind: string;
  id: string;
  last_verified: string;
  changed_at: string;
  files: string[];
}

/** A diff re-introducing something a decision deliberately removed. */
export interface RegressionHit {
  decision: string;
  title: string;
  kind: "symbol" | "dep";
  name: string;
  /** True only when the retiring decision is tied to an active blocking invariant. */
  blocking: boolean;
  reason: string;
}

/** A diff re-introducing an approach an in-force decision deliberately REJECTED. */
export interface VetoHit {
  decision: string;
  title: string;
  /** The rejected approach's text — the receipt headline. */
  alternative: string;
  /** What was chosen instead (decision.decision). */
  chosen: string;
  tier: VetoTier;
  evidence: string[];
  /** True only when the matched tripwire is human-confirmed, in-force, non-stale. */
  blocks: boolean;
  why?: { bug?: { id: string; title: string; root_cause: string } };
}

/** A tripwire matches via the shared precision ladder (dep > symbol > pattern). One
 *  matcher backs both the Veto Guard and content-matched constraints (constraintmatch.ts),
 *  so the parse-the-import precision is audited in exactly one place. */
function matchTripwire(tw: RejectedTripwire, addedDeps: Set<string>, scopedAdded: string[]): ForbidMatch | null {
  return matchForbids(tw.forbids, addedDeps, scopedAdded);
}

/** What an in-force decision retired from a file (agent-hook grounding). */
export interface RetiredNote {
  decision: string;
  title: string;
  symbols: string[];
  deps: string[];
}

export interface AssembledContext {
  target: string;
  constraints: Constraint[];
  decisions: Decision[];
  bugs: Bug[];
  blast_radius: Array<{ id: string; depth: number; via: string }>;
  components: Component[];
  budget_tokens: number;
}

function sev(s: string): number {
  return ({ blocking: 3, warning: 2, advisory: 1 } as Record<string, number>)[s] ?? 0;
}

/** Is a valid-time window open at `asOf`? `valid_from` undefined = always-started
 *  (legacy records). `valid_to` null = still in force. `asOf` undefined disables
 *  filtering (the history-inclusive default). Half-open [from, to) so a record and
 *  the one that supersedes it never both match at the supersession instant. */
/** Do two repo paths refer to the same file? Exact match, or one is a trailing
 *  path-SEGMENT suffix of the other (e.g. "x.ts" vs "src/x.ts") — anchored at a
 *  "/" boundary so "re.ts" never matches "store.ts" (the bare-endsWith hazard). */
function pathRelated(a: string, b: string): boolean {
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

function inWindow(valid_from: string | undefined, valid_to: string | null | undefined, asOf: string | undefined): boolean {
  if (!asOf) return true;
  if (valid_from && valid_from > asOf) return false;
  if (valid_to != null && asOf >= valid_to) return false;
  return true;
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- semantic-search helpers ---------------------------------------------

/** RRF tuning (env-overridable). Lexical weight ≥ semantic ≥ graph: exact matches
 *  win ties, semantic adds paraphrase recall, and the graph stream adds the
 *  dependency-neighbor evidence a "why" question needs across files. The graph
 *  weight is conservative + measurement-gated (set HUNCH_RRF_W_GRAPH=0 to disable);
 *  GAMMA only decays a neighbor's cross-seed support, so its absolute value is
 *  normalized away by the rank-based fusion. */
const RRF_K = numEnv("HUNCH_RRF_K", 60);
const RRF_W_FTS = numEnv("HUNCH_RRF_W_FTS", 1);
const RRF_W_SEM = numEnv("HUNCH_RRF_W_SEM", 0.7);
const RRF_W_GRAPH = numEnv("HUNCH_RRF_W_GRAPH", 0.5);
const GRAPH_GAMMA = numEnv("HUNCH_GRAPH_GAMMA", 0.25);
function numEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Pack a vector's exact bytes for SQLite. Explicit offset+length so a SUBARRAY
 *  view (byteOffset != 0) writes only its slice, not the whole backing buffer.
 *  node:sqlite copies on bind, so the returned view never aliases the row. */
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Decode a stored BLOB into an ALIGNED Float32Array — copy bytes into a fresh
 *  ArrayBuffer rather than viewing the (possibly mis-aligned, pooled) Buffer,
 *  which would throw RangeError on a non-4-multiple byteOffset. */
function blobToVec(buf: Uint8Array, dim: number): Float32Array {
  const ab = new ArrayBuffer(dim * 4);
  new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, dim * 4));
  return new Float32Array(ab);
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
