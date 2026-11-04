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
 * Phase 1 is read-only: GET /api/memory, /api/memory/:id, /api/repo, /api/connections. Writes will go
 * through CLI verbs (the CLI owns git), never by editing .hunch/ from here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { HunchStore } from "../store/hunchStore.js";
import { hunchPaths } from "../core/paths.js";
import { boundedSpawn } from "../core/boundedSpawn.js";
import { resolveSynthesisProvider } from "../synthesis/provider.js";
import { MEMORY_KINDS, countMemory, filterMemory, memoryDetail, memoryItems, type MemoryKind, type MemorySource, type MemoryView } from "./model.js";
import { uiCss, uiHtml, uiJs } from "./page.js";

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
}

const PROBE_TIMEOUT_MS = 8000;
/** Rows per list response; search narrows the rest. */
export const LIST_LIMIT = 200;

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

export function createUiServer(opts: UiServerOptions): Server & { closeStore(): void } {
  if (opts.token.length < 16) throw new Error("ui token must be at least 16 characters");
  const store = new HunchStore(hunchPaths(opts.root));
  const probes = opts.probes ?? defaultProbes(opts.root);
  const source = (): MemorySource => ({
    decisions: store.recs("decisions"), constraints: store.recs("constraints"), bugs: store.recs("bugs"),
    findings: store.recs("findings"), components: store.recs("components"),
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!LOOPBACK_HOST.test(req.headers.host ?? "")) return send(res, 421, { error: "This server only answers on 127.0.0.1." });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") { res.setHeader("allow", "GET"); return send(res, 405, { error: `${req.method} is not allowed.` }); }
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
      const items = memoryItems(source());
      const matched = filterMemory(items, { ...query, view: isView(view) ? view : "active" });
      return send(res, 200, { version: opts.version, counts: countMemory(items, query), total: matched.length, items: matched.slice(0, LIST_LIMIT) });
    }
    const detail = /^\/api\/memory\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (detail) {
      const found = memoryDetail(source(), detail[1]!);
      return found ? send(res, 200, found) : send(res, 404, { error: `No memory with id ${detail[1]}.` });
    }
    if (url.pathname === "/api/repo") {
      const repo = await probes.repo();
      return send(res, 200, { name: basename(repo.root), branch: repo.branch, webUrl: repo.webUrl });
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
