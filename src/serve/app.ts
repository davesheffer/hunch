import { resolve } from 'node:path';
import { StateProofError, verifyStateProof } from './stateProof.js';
import { STATE_PROOF_CAPABILITY } from '../core/stateProof.js';
/**
 * `hunch serve` — the HTTP binding of nuryel.state/1, and the served product's partition host.
 *
 * Folded in from Hunch Memory: bind 127.0.0.1 (the caller's job; never expose a port), a
 * bearer token that resolves the PRINCIPAL (the body never names one — grants come from the
 * config, never from the caller), problem+json errors, a body limit, and a cross-process
 * write lock per partition so a stdio MCP process on the same store cannot race a write.
 *
 * Every rule lives in src/store/stateBinding.ts; this file only maps HTTP to it:
 *   GET  /nuryel/v1/capabilities      → capabilities of the partition named by ?scope=kind:id (default: first granted)
 *   POST /nuryel/v1/read              → readState; with `scopes` a UNION read: readState per granted
 *                                       served partition, merged by mergeReadResponses (primary's envelope)
 *   POST /nuryel/v1/write             → writeState (under the partition's write lock)
 *   POST /nuryel/v1/subscribe         → subscribeState
 *   POST /nuryel/v1/records           → recordsState (by id, grants first)
 *   POST /nuryel/v1/mcp               → the same verbs as nuryel_* tools over MCP streamable HTTP
 *                                       (src/serve/mcpHttp.ts), through the same dispatcher
 * Request bodies are the contract's request schemas minus `schema` and `principal`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HunchStore } from "../store/hunchStore.js";
import { hunchPaths } from "../core/paths.js";
import { flushCapture } from "../integrations/sync.js";
import { StateRefusal, capabilities, mergeReadResponses, readState, recordsState, stateHomeFor, subscribeState, writeState } from "../store/stateBinding.js";
import { STATE_READ_VERSION, STATE_RECORDS_VERSION, STATE_SUBSCRIBE_VERSION, STATE_WRITE_VERSION, ReadScopesSchema, ScopeSchema, scopePath, type Principal, type Scope } from "../core/stateContract.js";
import { partitionFor, resolveCredential, readServeConfig, type ServeConfig } from "./config.js";
import { WriteLockTimeout, withWriteLock } from "./writelock.js";
import { HUNCH_VERSION } from "../core/version.js";
import { captureState, captureBatchState } from "../store/stateCapture.js";
import { STATE_CAPTURE_VERSION, STATE_CAPTURE_BATCH_VERSION } from "../core/stateContract.js";
import { operatorHtml, operatorCss, operatorJs } from "./operator.js";
import { MCP_PATH, handleMcpRequest, type ProblemShape, type StateRoute } from "./mcpHttp.js";

export const BODY_LIMIT_BYTES = 1024 * 1024;
const POST_ROUTES = new Map<string, StateRoute>([["/nuryel/v1/read", "read"], ["/nuryel/v1/write", "write"], ["/nuryel/v1/capture", "capture"], ["/nuryel/v1/capture-batch", "capture-batch"], ["/nuryel/v1/subscribe", "subscribe"], ["/nuryel/v1/records", "records"]]);
export const PROBLEM_TYPE = "https://www.hunchmemory.com/problems/nuryel.state/1/";

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpProblem";
  }
}
const problem = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpProblem => new HttpProblem(status, code, message, extra);

/** Refusal code → HTTP status. Outside-grants is 403 (the partition list is not secret to a
 *  principal that holds a token), conflicts are 409, identity/derivation errors 422. */
const REFUSAL_STATUS: Record<StateRefusal["code"], number> = {
  "outside-grants": 403, unsupported: 400, malformed: 400, identity: 422, conflict: 409, idempotency: 409, "no-partition-home": 404,
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    if (Array.isArray(declared) || !/^[0-9]+$/.test(declared)) throw problem(400, "invalid-body", "content-length is not valid");
    if (Number(declared) > BODY_LIMIT_BYTES) throw problem(413, "body-too-large", `body exceeds ${BODY_LIMIT_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT_BYTES) throw problem(413, "body-too-large", `body exceeds ${BODY_LIMIT_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw problem(400, "invalid-body", "body is not a JSON object");
  }
}

function parseScopeParam(value: string | null): Scope | undefined {
  if (!value) return undefined;
  const m = /^([a-z]+):(.+)$/.exec(value);
  const parsed = m ? ScopeSchema.safeParse({ kind: m[1], id: m[2] }) : null;
  if (!parsed?.success) throw problem(400, "invalid-scope", "scope must be kind:id");
  return parsed.data;
}

export interface ServeOptions {
  /** Required for key-bound credentials when supplying an in-memory configuration. */
  authStateDir?: string;
  version?: string;
  /** Injectable for tests: how a partition's store is opened. */
  openStore?: (root: string) => HunchStore;
  /** Server-side log line sink for 5xx specifics; defaults to stderr. */
  log?: (line: string) => void;
  /** Injectable for tests: how long a write waits for its partition's lock. */
  writeLockTimeoutMs?: number;
}

export function createServeApp(config: ServeConfig, opts: ServeOptions = {}): Server & { closeStores: () => void } {
  const version = opts.version ?? HUNCH_VERSION;
  const writeLockTimeoutMs = opts.writeLockTimeoutMs;
  const configFile = (config as ServeConfig & { file?: string }).file;
  const authStateDir = opts.authStateDir ?? (configFile ? resolve(configFile + ".auth") : undefined);
  const stores = new Map<string, HunchStore>();
  const storeFor = (scope: Scope, activeConfig: ServeConfig): { store: HunchStore; root: string } => {
    const partition = partitionFor(activeConfig, scope);
    if (!partition) throw problem(404, "no-partition", `this server does not serve ${scopePath(scope)}`);
    let store = stores.get(partition.root);
    if (!store) {
      store = opts.openStore ? opts.openStore(partition.root) : new HunchStore(hunchPaths(partition.root));
      store.json.ensureDirs();
      stores.set(partition.root, store);
    }
    return { store, root: partition.root };
  };
  /** Grants are checked here AND inside the binding — the binding's check is the contract's, this
   *  one refuses before a store is even opened. */
  const requireScope = (principal: Principal, body: Record<string, unknown>): Scope => {
    const parsed = ScopeSchema.safeParse(body.scope);
    if (!parsed.success) throw problem(400, "invalid-scope", "scope is required: { kind, id }");
    if (!principal.grants.some((g) => scopePath(g) === scopePath(parsed.data))) throw problem(403, "outside-grants", `scope ${scopePath(parsed.data)} is outside the principal's grants`);
    return parsed.data;
  };

  const send = (res: ServerResponse, status: number, payload: unknown, type = "application/json"): void => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "content-length": Buffer.byteLength(text), "cache-control": "no-store", "x-hunch-version": version });
    res.end(text);
  };
  const problemBody = (p: HttpProblem): ProblemShape => ({ type: `${PROBLEM_TYPE}${p.code}`, title: p.code, status: p.status, detail: p.message, ...p.extra });
  const sendProblem = (res: ServerResponse, p: HttpProblem): void => { send(res, p.status, problemBody(p), "application/problem+json"); };
  const log = opts.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  /** Anything thrown → problem. Shared by REST (problem+json) and MCP (tool error results).
   *  A contract refusal (4xx) explains itself to the caller. A server-side failure (5xx) does
   *  not: its message can name lock paths, PIDs, host names or store paths, so the caller gets
   *  a generic detail and the specifics go to the server log only. */
  const problemOf = (error: unknown): HttpProblem => {
    if (error instanceof HttpProblem) return error;
    if (error instanceof StateRefusal) return problem(REFUSAL_STATUS[error.code], error.code, error.message, error.conflict ? { conflict: error.conflict } : {});
    if (error instanceof WriteLockTimeout) {
      log(`hunch serve: 503 write-lock-timeout: ${error.message}`);
      return problem(503, "write-lock-timeout", "the partition is busy with another write; retry shortly", { "retry-after": 1 });
    }
    if (error && typeof error === "object" && (error as { name?: string }).name === "ZodError") {
      const issues = ((error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? []).map((i) => `${i.path.join(".") || "request"}: ${i.message}`);
      return problem(400, "malformed", `request is malformed: ${issues.join("; ")}`, { issues });
    }
    log(`hunch serve: 500 internal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return problem(500, "internal", "internal server error");
  };

  /** One authenticated state verb. The REST routes and the MCP tools both call this, so every
   *  rule — grants, the write lock, flushes, refusals — is the same whichever transport carried it. */
  const dispatch = async (route: StateRoute, principal: Principal, body: Record<string, unknown>, activeConfig: ServeConfig): Promise<{ status: number; payload: unknown }> => {
    const requestStore = (scope: Scope) => storeFor(scope, activeConfig);
    const isGranted = (s: Scope): boolean => principal.grants.some((g) => scopePath(g) === scopePath(s));
    if (route === "capabilities") {
      let scope = principal.grants[0]!;
      if (body.scope !== undefined) {
        const parsed = ScopeSchema.safeParse(body.scope);
        if (!parsed.success) throw problem(400, "invalid-scope", "scope must be { kind, id }");
        scope = parsed.data;
      }
      if (!isGranted(scope)) throw problem(403, "outside-grants", `scope ${scopePath(scope)} is outside the principal's grants`);
      const offered = capabilities(requestStore(scope).store);
      return { status: 200, payload: { ...offered, capabilities: [...offered.capabilities, STATE_PROOF_CAPABILITY], principal: { id: principal.id, kind: principal.kind, grants: principal.grants } } };
    }
    // The body never names the principal: the credential did.
    delete body.principal;
    delete body.schema;
    const scope = requireScope(principal, body);
    // Only authenticated grants select stores for cross-partition source visibility.
    const accessOptions = { additionalStores: principal.grants.map(grant => requestStore(grant).store) };
    const { store, root } = requestStore(scope);
    const flush = (isPrivate: boolean, message: string) => flushCapture(store, hunchPaths(root).hunch, isPrivate, message);

    if (route === "read") {
      if (body.observed_page !== undefined && body.scopes !== undefined) throw problem(400, 'malformed', 'observation pages require a single partition without scopes');
      if (body.scopes === undefined) {
        const { response, envelope } = readState(store, { schema: STATE_READ_VERSION, principal, ...body }, accessOptions);
        return { status: 200, payload: { ...response, envelope } };
      }
      // Union read. The primary `scope` was gated above as always; every extra scope is
      // either granted (read from ITS partition — 404 no-partition if this server lacks it)
      // or named in denied_scopes. One ungranted extra never refuses the whole call.
      const requested = ReadScopesSchema.safeParse(body.scopes);
      if (!requested.success) throw problem(400, "invalid-scope", "scopes must be 1..64 entries of { kind, id }");
      const { scopes: _scopes, ...rest } = body;
      const ungranted = requested.data.filter((s) => !isGranted(s));
      const others = new Map<string, Scope>();
      for (const s of requested.data) if (isGranted(s) && scopePath(s) !== scopePath(scope) && !others.has(scopePath(s))) others.set(scopePath(s), s);
      const primary = readState(store, { schema: STATE_READ_VERSION, principal, ...rest, scope }, accessOptions);
      const merged = mergeReadResponses(primary.response, [...others.values()].map((other) => readState(requestStore(other).store, { schema: STATE_READ_VERSION, principal, ...rest, scope: other }, accessOptions).response), ungranted);
      return { status: 200, payload: { ...merged, envelope: primary.envelope } };
    }
    if (route === "write" || route === "capture" || route === "capture-batch") {
      const { hunchDir } = stateHomeFor(store, scope);
      const opts = { ...accessOptions, flush };
      const lockOptions = { timeoutMs: writeLockTimeoutMs };
      if (route === "write") {
        const result = await withWriteLock(hunchDir, () => writeState(store, { schema: STATE_WRITE_VERSION, principal, ...body }, opts), lockOptions);
        return { status: result.outcome === "created" ? 201 : 200, payload: result };
      }
      if (route === "capture") {
        const result = await withWriteLock(hunchDir, () => captureState(store, { schema: STATE_CAPTURE_VERSION, principal, ...body }, opts), lockOptions);
        return { status: result.outcome === "created" ? 201 : 200, payload: result };
      }
      return { status: 200, payload: await withWriteLock(hunchDir, () => captureBatchState(store, { schema: STATE_CAPTURE_BATCH_VERSION, principal, ...body }, opts), lockOptions) };
    }
    if (route === "subscribe") return { status: 200, payload: subscribeState(store, { schema: STATE_SUBSCRIBE_VERSION, principal, ...body }, accessOptions) };
    return { status: 200, payload: recordsState(store, { schema: STATE_RECORDS_VERSION, principal, ...body }, accessOptions) };
  };

  /** The bearer/DPoP credential → the principal. Every authenticated route, and health when a
   *  credential is presented, goes through this one check. */
  const authenticate = async (req: IncomingMessage, res: ServerResponse, url: URL, activeConfig: ServeConfig): Promise<Principal> => {
    const authorization = /^(Bearer|DPoP) ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    const credential = resolveCredential(activeConfig, authorization?.[2]);
    if (!credential) throw problem(401, 'unauthorized', 'valid credentials are required');
    const countHeader = (name: string) => req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length;
    if (countHeader('authorization') !== 1 || countHeader('dpop') > 1) throw problem(401, 'invalid_dpop_proof', 'ambiguous authentication headers');
    if (credential.proof_key) {
      if (authorization![1]!.toLowerCase() !== 'dpop') throw problem(401, 'invalid_dpop_proof', 'this credential requires DPoP proof; bearer fallback is disabled');
      if (!activeConfig.public_origin || !authStateDir) throw problem(503, 'proof-state-unavailable', 'key-bound authentication requires a public origin and persistent proof state');
      try {
        await verifyStateProof({ proof: typeof req.headers.dpop === 'string' ? req.headers.dpop : undefined, key: credential.proof_key, method: req.method ?? '', url: activeConfig.public_origin + url.pathname, token: authorization![2]!, stateDir: authStateDir });
      } catch (error) {
        if (error instanceof StateProofError) {
          res.setHeader('WWW-Authenticate', `DPoP error="${error.code}", algs="EdDSA"`);
          if (error.nonce) res.setHeader('DPoP-Nonce', error.nonce);
          throw problem(401, error.code, error.message);
        }
        throw problem(503, 'proof-state-unavailable', 'proof replay state is unavailable; authentication is refused');
      }
    } else if (authorization![1]!.toLowerCase() !== 'bearer' || req.headers.dpop !== undefined) throw problem(401, 'invalid_dpop_proof', 'credential is not bound to a proof key');
    return { id: credential.id, kind: credential.kind, grants: credential.grants, ...(credential.display ? { display: credential.display } : {}) };
  };

  const server = createServer(async (req, res) => {
    try {
      let activeConfig: ServeConfig;
      try { activeConfig = configFile ? readServeConfig(configFile) : config; }
      catch { throw problem(503, 'configuration-unavailable', 'server configuration is unavailable; authentication is refused'); }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Public shell only: all workspace data still uses the authenticated state routes below.
      const asset = new Map<string, [string, string]>([["/operator", [operatorHtml, "text/html"]], ["/operator/", [operatorHtml, "text/html"]], ["/operator.css", [operatorCss, "text/css"]], ["/operator.js", [operatorJs, "text/javascript"]]]).get(url.pathname);
      if (asset && req.method === "GET") {
        res.writeHead(200, { "content-type": `${asset[1]}; charset=utf-8`, "content-length": Buffer.byteLength(asset[0]), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        return res.end(asset[0]);
      }
      if (url.pathname === "/nuryel/v1/health" && req.method === "GET") {
        // Liveness is public (a load balancer or proxy probe holds no token). Which
        // partitions this server hosts is not: their ids name people and organizations.
        const liveness = { ok: true, version, protocol: "nuryel.state/1" };
        if (req.headers.authorization === undefined && req.headers.dpop === undefined) return send(res, 200, liveness);
        await authenticate(req, res, url, activeConfig);
        return send(res, 200, { ...liveness, partitions: activeConfig.partitions.map((p) => scopePath(p.scope)) });
      }
      const principal = await authenticate(req, res, url, activeConfig);

      if (url.pathname === "/nuryel/v1/capabilities" && req.method === "GET") {
        const scope = parseScopeParam(url.searchParams.get("scope"));
        const { status, payload } = await dispatch("capabilities", principal, scope ? { scope } : {}, activeConfig);
        return send(res, status, payload);
      }
      if (url.pathname === MCP_PATH) {
        // Stateless MCP: no server-initiated stream to open (GET) and no session to end (DELETE).
        if (req.method !== "POST") { res.setHeader("allow", "POST"); throw problem(405, "method-not-allowed", `${req.method} is not allowed on ${url.pathname}; MCP here is stateless POST`); }
        const message = await readBody(req);
        return await handleMcpRequest(req, res, message, (route, body) => dispatch(route, principal, body, activeConfig), (error) => problemBody(problemOf(error)), version);
      }
      if (req.method !== "POST") throw problem(405, "method-not-allowed", `${req.method} is not allowed on ${url.pathname}`);
      const route = POST_ROUTES.get(url.pathname);
      if (!route) throw problem(404, "not-found", `${url.pathname} is not a nuryel.state/1 route`);
      const { status, payload } = await dispatch(route, principal, await readBody(req), activeConfig);
      return send(res, status, payload);
    } catch (error) {
      // An MCP response may already be on the wire; a second status line would corrupt it.
      if (res.headersSent) { res.end(); return; }
      return sendProblem(res, problemOf(error));
    }
  });
  const closeStores = (): void => { for (const store of stores.values()) store.close(); stores.clear(); };
  return Object.assign(server, { closeStores });
}
