/**
 * Typed client for nuryel.state/1 over HTTP (`hunch serve`). No dependencies beyond fetch.
 * Import from `@davesheffer/hunch/state`. The principal is the bearer token's; the request
 * shapes are the contract's minus `schema` and `principal`.
 */
import type { ReadRequest, ReadResponse, SubscribeRequest, WriteRequest, WriteResult, ChangeEvent, Scope, RecordsResponse } from "../core/stateContract.js";
import type { DeliveryEnvelope } from "../core/delivery.js";
import type { CaptureRequest, CaptureBatchRequest, CaptureBatchResult } from "../core/stateContract.js";

export type ClientReadRequest = Omit<ReadRequest, "schema" | "principal">;
export type ClientWriteRequest = Omit<WriteRequest, "schema" | "principal" | "expected_version"> & { expected_version?: string | number | null };
export type ClientSubscribeRequest = Omit<SubscribeRequest, "schema" | "principal">;
export interface ClientSubscribeResponse { schema: string; scope: Scope; head_seq: number; events: ChangeEvent[]; filtered: boolean }

export interface StateProblem { type: string; title: string; status: number; detail: string; conflict?: { incumbent_id: string; reason: string }; issues?: string[] }

/** A typed refusal from the server: the problem+json body, with `code` = its title. */
export class StateClientError extends Error {
  constructor(readonly status: number, readonly code: string, readonly problem: StateProblem) {
    super(`${code}: ${problem.detail}`);
    this.name = "StateClientError";
  }
}

export interface StateClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createStateClient(opts: StateClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (!response.ok) {
        const p = parsed as StateProblem;
        throw new StateClientError(response.status, p.title ?? String(response.status), p);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    capabilities: (scope?: Scope) => call<{ protocol: string; capabilities: string[]; repository: Scope; partitions: Scope["kind"][]; principal: { id: string; kind: string; grants: Scope[] } }>("GET", `/nuryel/v1/capabilities${scope ? `?scope=${encodeURIComponent(`${scope.kind}:${scope.id}`)}` : ""}`),
    read: (request: ClientReadRequest) => call<ReadResponse & { envelope: DeliveryEnvelope }>("POST", "/nuryel/v1/read", request),
    write: (request: ClientWriteRequest) => call<WriteResult>("POST", "/nuryel/v1/write", request),
    capture: (request: Omit<CaptureRequest, "schema" | "principal">) => call<WriteResult>("POST", "/nuryel/v1/capture", request),
    captureBatch: (request: Omit<CaptureBatchRequest, "schema" | "principal">) => call<CaptureBatchResult>("POST", "/nuryel/v1/capture-batch", request),
    subscribe: (request: ClientSubscribeRequest) => call<ClientSubscribeResponse>("POST", "/nuryel/v1/subscribe", request),
    records: (request: { scope: Scope; ids: string[] }) => call<RecordsResponse>("POST", "/nuryel/v1/records", request),
    health: () => call<{ ok: boolean; version: string; protocol: string; partitions: string[] }>("GET", "/nuryel/v1/health"),
  };
}
export type StateClient = ReturnType<typeof createStateClient>;
