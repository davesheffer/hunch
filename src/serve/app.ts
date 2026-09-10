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
 * Request bodies are the contract's request schemas minus `schema` and `principal`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HunchStore } from "../store/hunchStore.js";
import { hunchPaths } from "../core/paths.js";
import { flushCapture } from "../integrations/sync.js";
import { StateRefusal, capabilities, mergeReadResponses, readState, recordsState, subscribeState, writeState } from "../store/stateBinding.js";
import { STATE_READ_VERSION, STATE_RECORDS_VERSION, STATE_SUBSCRIBE_VERSION, STATE_WRITE_VERSION, ReadScopesSchema, ScopeSchema, scopePath, type Principal, type Scope } from "../core/stateContract.js";
import { partitionFor, resolvePrincipal, type ServeConfig } from "./config.js";
import { WriteLockTimeout, withWriteLock } from "./writelock.js";
import { HUNCH_VERSION } from "../core/version.js";
import { captureState, captureBatchState } from "../store/stateCapture.js";
import { STATE_CAPTURE_VERSION, STATE_CAPTURE_BATCH_VERSION } from "../core/stateContract.js";

export const BODY_LIMIT_BYTES = 1024 * 1024;
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

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!/^bearer /i.test(trimmed)) return undefined;
  const token = trimmed.slice("bearer ".length).trim();
  return token || undefined;
}

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
  version?: string;
  /** Injectable for tests: how a partition's store is opened. */
  openStore?: (root: string) => HunchStore;
}

export function createServeApp(config: ServeConfig, opts: ServeOptions = {}): Server & { closeStores: () => void } {
  const version = opts.version ?? HUNCH_VERSION;
  const stores = new Map<string, HunchStore>();
  const storeFor = (scope: Scope): { store: HunchStore; root: string } => {
    const partition = partitionFor(config, scope);
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
  const sendProblem = (res: ServerResponse, p: HttpProblem): void => {
    send(res, p.status, { type: `${PROBLEM_TYPE}${p.code}`, title: p.code, status: p.status, detail: p.message, ...p.extra }, "application/problem+json");
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/nuryel/v1/health" && req.method === "GET") {
        return send(res, 200, { ok: true, version, protocol: "nuryel.state/1", partitions: config.partitions.map((p) => scopePath(p.scope)) });
      }
      const principal = resolvePrincipal(config, bearerToken(req));
      if (!principal) throw problem(401, "unauthorized", "a valid bearer token is required");

      if (url.pathname === "/nuryel/v1/capabilities" && req.method === "GET") {
        const scope = parseScopeParam(url.searchParams.get("scope")) ?? principal.grants[0]!;
        if (!principal.grants.some((g) => scopePath(g) === scopePath(scope))) throw problem(403, "outside-grants", `scope ${scopePath(scope)} is outside the principal's grants`);
        const { store } = storeFor(scope);
        return send(res, 200, { ...capabilities(store), principal: { id: principal.id, kind: principal.kind, grants: principal.grants } });
      }
      if (req.method !== "POST") throw problem(405, "method-not-allowed", `${req.method} is not allowed on ${url.pathname}`);
      const body = await readBody(req);
      // The body never names the principal: the token did.
      delete body.principal;
      delete body.schema;

      if (url.pathname === "/nuryel/v1/read") {
        const scope = requireScope(principal, body);
        const { store } = storeFor(scope);
        if (body.scopes === undefined) {
          const { response, envelope } = readState(store, { schema: STATE_READ_VERSION, principal, ...body });
          return send(res, 200, { ...response, envelope });
        }
        // Union read. The primary `scope` was gated above as always; every extra scope is
        // either granted (read from ITS partition — 404 no-partition if this server lacks it)
        // or named in denied_scopes. One ungranted extra never refuses the whole call.
        const requested = ReadScopesSchema.safeParse(body.scopes);
        if (!requested.success) throw problem(400, "invalid-scope", "scopes must be 1..64 entries of { kind, id }");
        const { scopes: _scopes, ...rest } = body;
        const isGranted = (s: Scope): boolean => principal.grants.some((g) => scopePath(g) === scopePath(s));
        const ungranted = requested.data.filter((s) => !isGranted(s));
        const others = new Map<string, Scope>();
        for (const s of requested.data) if (isGranted(s) && scopePath(s) !== scopePath(scope) && !others.has(scopePath(s))) others.set(scopePath(s), s);
        const primary = readState(store, { schema: STATE_READ_VERSION, principal, ...rest, scope });
        const merged = mergeReadResponses(primary.response, [...others.values()].map((other) => readState(storeFor(other).store, { schema: STATE_READ_VERSION, principal, ...rest, scope: other }).response), ungranted);
        return send(res, 200, { ...merged, envelope: primary.envelope });
      }
      if (url.pathname === "/nuryel/v1/write") {
        const scope = requireScope(principal, body);
        const { store, root } = storeFor(scope);
        const result = await withWriteLock(hunchPaths(root).hunch, () => writeState(store, { schema: STATE_WRITE_VERSION, principal, ...body }, {
          flush: (isPrivate, message) => flushCapture(store, hunchPaths(root).hunch, isPrivate, message),
        }));
        return send(res, result.outcome === "created" ? 201 : 200, result);
      }
      if (url.pathname === "/nuryel/v1/capture") {
        const scope = requireScope(principal, body);
        const { store } = storeFor(scope);
        const result = await withWriteLock(hunchPaths(store.publicRoot).hunch, () => captureState(store, { schema: STATE_CAPTURE_VERSION, principal, ...body }, {
          flush: (isPrivate, message) => flushCapture(store, hunchPaths(store.publicRoot).hunch, isPrivate, message),
        }));
        return send(res, result.outcome === "created" ? 201 : 200, result);
      }
      if (url.pathname === "/nuryel/v1/capture-batch") {
        const scope = requireScope(principal, body);
        const { store, root } = storeFor(scope);
        const result = await withWriteLock(hunchPaths(root).hunch, () => captureBatchState(store, { schema: STATE_CAPTURE_BATCH_VERSION, principal, ...body }, {
          flush: (isPrivate, message) => flushCapture(store, hunchPaths(root).hunch, isPrivate, message),
        }));
        return send(res, 200, result);
      }
      if (url.pathname === "/nuryel/v1/subscribe") {
        const scope = requireScope(principal, body);
        const { store } = storeFor(scope);
        return send(res, 200, subscribeState(store, { schema: STATE_SUBSCRIBE_VERSION, principal, ...body }));
      }
      if (url.pathname === "/nuryel/v1/records") {
        const scope = requireScope(principal, body);
        const { store } = storeFor(scope);
        return send(res, 200, recordsState(store, { schema: STATE_RECORDS_VERSION, principal, ...body }));
      }
      throw problem(404, "not-found", `${url.pathname} is not a nuryel.state/1 route`);
    } catch (error) {
      if (error instanceof HttpProblem) return sendProblem(res, error);
      if (error instanceof StateRefusal) return sendProblem(res, problem(REFUSAL_STATUS[error.code], error.code, error.message, error.conflict ? { conflict: error.conflict } : {}));
      if (error instanceof WriteLockTimeout) return sendProblem(res, problem(503, "write-lock-timeout", error.message, { "retry-after": 1 }));
      if (error && typeof error === "object" && (error as { name?: string }).name === "ZodError") {
        const issues = ((error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? []).map((i) => `${i.path.join(".") || "request"}: ${i.message}`);
        return sendProblem(res, problem(400, "malformed", `request is malformed: ${issues.join("; ")}`, { issues }));
      }
      return sendProblem(res, problem(500, "internal", (error as Error).message));
    }
  });
  const closeStores = (): void => { for (const store of stores.values()) store.close(); stores.clear(); };
  return Object.assign(server, { closeStores });
}
