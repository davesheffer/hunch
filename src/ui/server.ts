/**
 * `hunch ui` — the local web control surface for this repository's memory (human-ui-strategy).
 *
 * Bound to 127.0.0.1 by the caller. Three guards keep other local pages and other sites out:
 *   - Host must be a loopback name, so a DNS-rebinding page cannot reach the API;
 *   - every /api route needs the per-launch bearer token, which the launch URL carries in its
 *     #fragment (never sent to a server, never in a Referer), and a cross-site page cannot set
 *     an Authorization header without a CORS preflight this server never answers;
 *   - the page shell is static and holds no data, under the same strict CSP as /operator.
 *
 * Reads: GET /api/memory, /api/memory/:id, /api/components, /api/repo, /api/connections,
 * /api/attention, /api/review (what in memory deserves a person's judgment), /api/map, /api/map/:id, /api/pulse?since= (what changed since the page last asked), and /api/history[?id=] (the memory commits in git,
 * from each home).
 * Writes: POST /api/memory/:id/(edit|link|remove|restore) runs that CLI verb,
 * /api/memory/:id/(confirm|unconfirm) runs `hunch review --confirm|--unconfirm`, and POST
 * /api/memory runs `hunch new` (the CLI owns validation, git and the store), one at a time,
 * and answers with the move plus its Undo.
 * A write also needs a JSON body and, when the browser sends an Origin, this server's own.
 * GET /api/ask lists who can be asked, and why nobody can when nobody can. Asking spends the
 * person's subscription, so each POST that asks is guarded like a write, writes nothing, and
 * waits for the last question to be answered.
 * Grill: GET /api/grill/:id says what a grill of that memory would send, before anything is sent;
 * POST /api/grill runs one turn of it.
 * Board: GET /api/board/:id lays a recorded decision or rule out as a board, asking nobody;
 * POST /api/board/preview says what a question would send, sending nothing; POST /api/board,
 * guarded like Grill and sharing its one-at-a-time, asks it and returns the checked board.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HunchStore } from "../store/hunchStore.js";
import { hunchPaths } from "../core/paths.js";
import { computeDrift } from "../core/drift.js";
import { boundedSpawn } from "../core/boundedSpawn.js";
import { pathsAliveInRepo } from "../extractors/git.js";
import { kindOfId } from "../core/memoryEdit.js";
import { resolveSynthesisProvider } from "../synthesis/provider.js";
import { MEMORY_KINDS, componentDetail, componentMap, countMemory, filterMemory, memoryDetail, memoryItems, needsAttention, type MemoryKind, type MemorySource, type MemoryView } from "./model.js";
import { uiCss, uiHtml, uiJs } from "./page.js";
import { createPulse } from "./pulse.js";
import { memoryHistory, type HistorySource } from "./history.js";
import { actionArgs, cliError, isUiAction, newArgs, undoFor, type MoveResult, type UiAction } from "./actions.js";
import { defaultAskRunner, type AskRunner } from "./ask.js";
import { canGrill, evidenceView, gatherEvidence, grillPrompt, grillRequest, readTurn, type GrillFlag } from "./grill.js";
import { reviewCards, type Review } from "./review.js";
import { boardEvidenceView, boardPrompt, boardRequest, canThink, explainBoard, gatherBoardEvidence, readBoard } from "./board.js";

export interface RepoInfo { root: string; branch: string | null; remote: string | null; webUrl: string | null }
export interface GithubInfo { installed: boolean; authenticated: boolean; user: string | null; repo: string | null }
export interface AssistantInfo { name: string; label: string; subscription: string | null; available: boolean }

export interface UiProbes {
  repo(): Promise<RepoInfo>;
  github(): Promise<GithubInfo>;
  assistants(): Promise<AssistantInfo[]>;
}

export interface UiServerOptions {
  root: string;
  token: string;
  version: string;
  /** Test seam; defaults to git, gh and provider detection. */
  probes?: UiProbes;
  /** How to run this CLI: the node binary plus the args before the verb (execArgv + entry).
   *  Without it every write answers 503. */
  cli?: { file: string; args: string[]; env?: NodeJS.ProcessEnv };
  /** Test seam; defaults to the installed subscription CLIs. */
  asker?: AskRunner;
}

const PROBE_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 300_000;
const MAX_BODY = 64 * 1024;
/** Rows per list response; search narrows the rest. */
export const LIST_LIMIT = 200;
/** Commits per history response. */
export const HISTORY_LIMIT = 100;
/** How long the review trusts what it saw in git and the working tree; the records it re-reads every time. */
const REVIEW_TTL_MS = 5 * 60_000;
/** When git couldn't say: the answer is partial, so ask again soon, but not on every click. */
const REVIEW_RETRY_MS = 30_000;

async function run(file: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const r = await boundedSpawn(file, args, { cwd, timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return { ok: !r.error && !r.timedOut && r.status === 0, out: r.stdout.trim() };
}

/** "git@github.com:o/r.git" or "https://github.com/o/r" -> "https://github.com/o/r"; null for other hosts. */
export function githubWebUrl(remote: string | null): string | null {
  const m = remote ? /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export function defaultProbes(root: string): UiProbes {
  return {
    async repo() {
      const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
      const remote = await run("git", ["remote", "get-url", "origin"], root);
      const url = remote.ok && remote.out ? remote.out : null;
      return { root, branch: branch.ok ? branch.out : null, remote: url, webUrl: githubWebUrl(url) };
    },
    async github() {
      const version = await run("gh", ["--version"], root);
      if (!version.ok) return { installed: false, authenticated: false, user: null, repo: null };
      const user = await run("gh", ["api", "user", "--jq", ".login"], root);
      if (!user.ok) return { installed: true, authenticated: false, user: null, repo: null };
      const repo = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root);
      return { installed: true, authenticated: true, user: user.out || null, repo: repo.ok && repo.out ? repo.out : null };
    },
    async assistants() {
      const { statuses } = await resolveSynthesisProvider();
      // The deterministic fallback is built in, not something a person connects.
      return statuses.filter((s) => s.name !== "deterministic").map((s) => ({ name: s.name, label: s.label, subscription: s.subscription, available: s.available }));
    },
  };
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ASSETS = new Map<string, [string, string]>([["/", [uiHtml, "text/html"]], ["/ui.css", [uiCss, "text/css"]], ["/ui.js", [uiJs, "text/javascript"]]]);

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = header ? /^Bearer (.+)$/.exec(header) : null;
  if (!m) return false;
  const given = Buffer.from(m[1]!), want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const isKind = (v: string | null): v is MemoryKind => v !== null && (MEMORY_KINDS as readonly string[]).includes(v);
const isView = (v: string | null): v is MemoryView => v === "active" || v === "unconnected" || v === "all";

const WRITE_ROUTE = /^\/api\/memory\/([A-Za-z0-9_-]{1,128})\/([a-z]+)$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The request body as parsed JSON; null when it is too big or not JSON. */
async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return { ok: false, status: 413, error: "That change is too large." };
    chunks.push(chunk as Buffer);
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }; }
  catch { return { ok: false, status: 400, error: "Send a JSON object." }; }
}

export function createUiServer(opts: UiServerOptions): Server & { closeStore(): void } {
  if (opts.token.length < 16) throw new Error("ui token must be at least 16 characters");
  // Reopened after every write: the store caches what it loaded, and the CLI wrote behind it.
  let store = new HunchStore(hunchPaths(opts.root));
  const probes = opts.probes ?? defaultProbes(opts.root);
  const source = (): MemorySource => ({
    decisions: store.recs("decisions"), constraints: store.recs("constraints"), bugs: store.recs("bugs"),
    findings: store.recs("findings"), components: store.recs("components"),
  });
  const pulse = createPulse();
  // One CLI write at a time: each one commits, and two commits must not race.
  let writing: Promise<unknown> = Promise.resolve();
  const asker = opts.asker ?? defaultAskRunner(opts.root);
  // One question at a time: each one spends the person's subscription.
  let asking = false;
  // The pass costs seconds and the page asks on every open, so it reruns only when a record's
  // content changed. Git's answer about branches outlives a run: a write shouldn't re-ask it.
  let reviewed: { key: string; until: number; value: Review } | null = null;
  let gitFailed = false;
  let branches: { at: number; alive: Map<string, boolean> } = { at: 0, alive: new Map() };
  const alive = (paths: readonly string[]): ReadonlySet<string> => {
    if (Date.now() - branches.at >= REVIEW_TTL_MS) branches = { at: Date.now(), alive: new Map() };
    const known = branches.alive;
    const onDisk = new Set(paths.filter((p) => existsSync(join(opts.root, p))));
    const ask = paths.filter((p) => !onDisk.has(p) && !known.has(p));
    const answer = pathsAliveInRepo(ask, opts.root);
    // Git couldn't say: show nothing rather than call a live file gone, and ask again next time.
    if (answer === null) { gitFailed = true; return new Set(paths); }
    for (const p of ask) known.set(p, answer.has(p));
    return new Set(paths.filter((p) => onDisk.has(p) || known.get(p)));
  };
  const review = (): Review => {
    const src = source(), edges = store.recs("edges");
    const key = createHash("sha1").update(JSON.stringify([src, edges])).digest("hex");
    if (reviewed?.key === key && Date.now() < reviewed.until) return reviewed.value;
    gitFailed = false;
    const inOverlay = (id: string): boolean => { const target = kindOfId(id); return !!target && !!store.getPrivateRec(target.collection, id); };
    const value: Review = { ...reviewCards(src, edges, { drift: computeDrift(store, opts.root, { recordsOnly: true }).findings, alive, inOverlay, limit: LIST_LIMIT }), gitFailed };
    reviewed = { key, until: Date.now() + (gitFailed ? REVIEW_RETRY_MS : REVIEW_TTL_MS), value };
    return value;
  };

  // Sends the refusal and answers true unless this POST came from this page, as JSON.
  const refused = (req: IncomingMessage, res: ServerResponse): boolean => {
    // A browser always sends Origin on a cross-site POST; it must be this page's own.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) { send(res, 403, { error: "Changes are only accepted from this page." }); return true; }
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) { send(res, 415, { error: "Send the change as JSON." }); return true; }
    return false;
  };

  // What the review already holds against this record, and the records it compared it with.
  const flagged = (id: string): { flags: GrillFlag[]; partners: string[] } => {
    try {
      const cards = review().groups.flatMap((g) => g.cards).filter((c) => c.records.some((r) => r.id === id));
      return { flags: cards.map((c) => ({ claim: c.claim, evidence: c.evidence })), partners: cards.flatMap((c) => c.records.map((r) => r.id)) };
    } catch { return { flags: [], partners: [] }; }
  };

  const grill = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (refused(req, res)) return;
    const body = await readJson(req);
    if (!body.ok) return send(res, body.status, { error: body.error });
    const parsed = grillRequest(body.value);
    if (!parsed.ok) return send(res, 400, { error: parsed.error });
    if (asking) return send(res, 409, { error: "Still waiting on your last question." });
    asking = true;
    try {
      const { assistants, blocked } = await asker.assistants();
      const assistant = assistants.find((a) => a.name === parsed.assistant);
      if (blocked || !assistant) return send(res, 409, { error: "That assistant can't be asked right now." });
      const evidence = await gatherEvidence(source(), parsed.about, opts.root, flagged(parsed.about));
      if (!evidence) return send(res, 404, { error: `No memory with id ${parsed.about}.` });
      if (!canGrill(evidence)) return send(res, 409, { error: "This memory links to no committed code and nothing relates to it, so there is nothing to challenge it with." });
      let reply: string;
      try { reply = await asker.ask(assistant.name, grillPrompt(evidence, parsed.turns, parsed.finish)); }
      catch (error) { return send(res, 502, { error: `${assistant.label} did not answer: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }); }
      return send(res, 200, { assistant: { name: assistant.name, label: assistant.label }, ...readTurn(reply, evidence, parsed.turns.length, parsed.finish, parsed.turns.map((t) => t.question)), evidence: evidenceView(evidence) });
    } finally { asking = false; }
  };

  // spend false: what the question would send; nothing is sent or spent.
  const board = async (req: IncomingMessage, res: ServerResponse, spend: boolean): Promise<void> => {
    if (refused(req, res)) return;
    const body = await readJson(req);
    if (!body.ok) return send(res, body.status, { error: body.error });
    const parsed = boardRequest(body.value, spend);
    if (!parsed.ok) return send(res, 400, { error: parsed.error });
    const gather = () => gatherBoardEvidence(source(), store.recs("edges"), parsed.question, parsed.about, opts.root, parsed.turns);
    if (!spend) {
      const evidence = await gather();
      if (!evidence) return send(res, 404, { error: `No memory with id ${parsed.about}.` });
      return send(res, 200, { evidence: boardEvidenceView(evidence), ...(await asker.assistants()) });
    }
    if (asking) return send(res, 409, { error: "Still waiting on your last question." });
    asking = true;
    try {
      const { assistants, blocked } = await asker.assistants();
      const assistant = assistants.find((a) => a.name === parsed.assistant);
      if (blocked || !assistant) return send(res, 409, { error: "That assistant can't be asked right now." });
      const evidence = await gather();
      if (!evidence) return send(res, 404, { error: `No memory with id ${parsed.about}.` });
      if (!canThink(evidence)) return send(res, 409, { error: "No memory matched and no code could be read, so the options would rest on nothing." });
      let reply: string;
      try { reply = await asker.ask(assistant.name, boardPrompt(evidence)); }
      catch (error) { return send(res, 502, { error: `${assistant.label} did not answer: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }); }
      return send(res, 200, { assistant: { name: assistant.name, label: assistant.label }, ...readBoard(reply, evidence), evidence: boardEvidenceView(evidence) });
    } finally { asking = false; }
  };

  // id null: POST /api/memory, a new record (`hunch new`).
  const write = async (req: IncomingMessage, res: ServerResponse, id: string | null, action: string): Promise<void> => {
    if (id !== null && !isUiAction(action)) return send(res, 404, { error: "Not found." });
    const move = id === null ? "new" : (action as UiAction);
    if (refused(req, res)) return;
    if (!opts.cli) return send(res, 503, { error: "Editing needs hunch ui started from the command line." });
    const body = await readJson(req);
    if (!body.ok) return send(res, body.status, { error: body.error });
    const parsed = id === null ? newArgs(body.value) : actionArgs(move as UiAction, id, body.value, { private: store.hasPrivate });
    if (!parsed.ok) return send(res, 400, { error: parsed.error });
    const cli = opts.cli;
    const job = writing.then(() => boundedSpawn(cli.file, [...cli.args, ...parsed.args], {
      cwd: opts.root, env: { ...(cli.env ?? process.env), NO_COLOR: "1" }, timeoutMs: WRITE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    }));
    writing = job.catch(() => undefined);
    const r = await job;
    if (r.timedOut) return send(res, 504, { error: "The change took too long and was stopped." });
    // The CLI didn't start or was cut off: that's not a refusal, so say what went wrong.
    if (r.error || r.overflowed) return send(res, 500, { error: `The change could not run: ${r.error?.message ?? "its output was too large"}.` });
    if (r.status !== 0) return send(res, 422, { error: cliError(r.stderr, r.stdout) });
    const last = r.stdout.trim().split(/\r?\n/).pop() ?? "";
    let result: MoveResult;
    try { result = JSON.parse(last) as MoveResult; } catch { return send(res, 500, { error: "The change ran but its result could not be read." }); }
    if (result.changed) { store.close(); store = new HunchStore(hunchPaths(opts.root)); }
    return send(res, 200, { changed: result.changed, id: result.id, home: result.home, flush: result.flush, uncommitted: result.uncommitted === true, undo: undoFor(move, result) });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!LOOPBACK_HOST.test(req.headers.host ?? "")) return send(res, 421, { error: "This server only answers on 127.0.0.1." });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const writeRoute = req.method === "POST" ? WRITE_ROUTE.exec(url.pathname) : null;
    const createRoute = req.method === "POST" && url.pathname === "/api/memory";
    const grillRoute = req.method === "POST" && url.pathname === "/api/grill";
    const boardRoute = req.method === "POST" && (url.pathname === "/api/board" || url.pathname === "/api/board/preview");
    if (req.method !== "GET" && !writeRoute && !createRoute && !grillRoute && !boardRoute) { res.setHeader("allow", "GET, POST"); return send(res, 405, { error: `${req.method} is not allowed.` }); }
    if (writeRoute || createRoute || grillRoute || boardRoute) {
      if (!tokenMatches(req.headers.authorization, opts.token)) return send(res, 401, { error: "Access key missing or expired." });
      if (grillRoute) return grill(req, res);
      if (boardRoute) return board(req, res, url.pathname === "/api/board");
      return writeRoute ? write(req, res, writeRoute[1]!, writeRoute[2]!) : write(req, res, null, "new");
    }
    const asset = ASSETS.get(url.pathname);
    if (asset) {
      res.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "content-length": Buffer.byteLength(asset[0]), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": CSP });
      return void res.end(asset[0]);
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });
    if (!tokenMatches(req.headers.authorization, opts.token)) return send(res, 401, { error: "Access key missing or expired." });

    if (url.pathname === "/api/memory") {
      const kind = url.searchParams.get("kind"), view = url.searchParams.get("view");
      const query = { kind: isKind(kind) ? kind : undefined, q: url.searchParams.get("q") ?? undefined };
      const src = source();
      const items = memoryItems(src);
      const matched = filterMemory(items, { ...query, view: isView(view) ? view : "active" });
      return send(res, 200, { version: opts.version, counts: countMemory(items, query), attention: needsAttention(src, items).total, total: matched.length, items: matched.slice(0, LIST_LIMIT) });
    }
    if (url.pathname === "/api/attention") {
      const src = source();
      const { total, groups } = needsAttention(src, memoryItems(src));
      return send(res, 200, { total, groups: groups.map((g) => ({ key: g.key, total: g.items.length, items: g.items.slice(0, LIST_LIMIT) })) });
    }
    if (url.pathname === "/api/review") return send(res, 200, review());
    if (url.pathname === "/api/pulse") {
      const since = Number(url.searchParams.get("since"));
      const src = source();
      const items = memoryItems(src);
      return send(res, 200, pulse.read(items, Number.isInteger(since) && since > 0 ? since : 0, needsAttention(src, items).total));
    }
    if (url.pathname === "/api/map") return send(res, 200, componentMap(source(), store.recs("edges")));
    const component = /^\/api\/map\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (component) {
      const found = componentDetail(source(), store.recs("edges"), component[1]!);
      return found ? send(res, 200, found) : send(res, 404, { error: `No component with id ${component[1]}.` });
    }
    const detail = /^\/api\/memory\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (detail) {
      const found = memoryDetail(source(), detail[1]!);
      return found ? send(res, 200, found) : send(res, 404, { error: `No memory with id ${detail[1]}.` });
    }
    if (url.pathname === "/api/components") {
      return send(res, 200, { items: store.recs("components").filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) });
    }
    if (url.pathname === "/api/repo") {
      const repo = await probes.repo();
      return send(res, 200, { name: basename(repo.root), branch: repo.branch, webUrl: repo.webUrl });
    }
    if (url.pathname === "/api/history") {
      const id = url.searchParams.get("id") ?? undefined;
      if (id !== undefined && !RECORD_ID.test(id)) return send(res, 400, { error: "That is not a memory id." });
      const sources: HistorySource[] = [{ home: "public", hunchDir: hunchPaths(opts.root).hunch, webUrl: (await probes.repo()).webUrl }];
      if (store.privateDir) {
        let dir = store.privateDir;
        try { dir = realpathSync(dir); } catch { /* not there yet: git finds nothing */ }
        const remote = await run("git", ["remote", "get-url", "origin"], dirname(dir));
        sources.push({ home: "private", hunchDir: dir, webUrl: remote.ok ? githubWebUrl(remote.out) : null });
      }
      const all = memoryItems(source());
      const titles = new Map(all.map((m) => [m.id, m.title]));
      const where = new Map(all.map((m) => [m.id, m.components.map((c) => c.id)]));
      return send(res, 200, { items: memoryHistory(sources, { limit: HISTORY_LIMIT, id }, titles, where), private: !!store.privateDir });
    }
    if (url.pathname === "/api/ask") return send(res, 200, await asker.assistants());
    const grilled = /^\/api\/grill\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (grilled) {
      const evidence = await gatherEvidence(source(), grilled[1]!, opts.root, flagged(grilled[1]!));
      if (!evidence) return send(res, 404, { error: `No memory with id ${grilled[1]}.` });
      return send(res, 200, { record: evidence.focus, evidence: evidenceView(evidence), ...(await asker.assistants()) });
    }
    const explained = /^\/api\/board\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (explained) {
      const found = explainBoard(source(), explained[1]!);
      if (!found) return send(res, 404, { error: memoryDetail(source(), explained[1]!) ? "Only a decision or a rule can be explained." : `No memory with id ${explained[1]}.` });
      return send(res, 200, { board: found, ...(await asker.assistants()) });
    }
    if (url.pathname === "/api/connections") {
      const [repo, github, assistants] = await Promise.all([probes.repo(), probes.github(), probes.assistants()]);
      return send(res, 200, { repo, github, assistants });
    }
    return send(res, 404, { error: "Not found." });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.end();
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  return Object.assign(server, { closeStore: () => store.close() });
}
