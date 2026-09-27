/**
 * MCP over streamable HTTP for `hunch serve` — the nuryel.state/1 tools behind the same
 * authenticated server, so an HTTP MCP client (an agent gateway, a remote orchestrator) can
 * add the state layer as a tool target without a stdio process or a wrapper.
 *
 * A binding of the served routes, never a second implementation: every tool call goes through
 * the dispatcher `createServeApp` uses for REST, so grants, the write lock, flushes and refusals
 * are identical. The credential already resolved the principal before this runs; no tool
 * accepts one. Stateless (a fresh server and transport per request, no session id) with JSON
 * responses, because every verb is a single request/response.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installLeanToolList } from "../mcp/leanToolList.js";
// The web-standard transport, not the Node one: the Node wrapper imports @hono/node-server,
// which the production dependency audit keeps unreachable (tooling/production-dependency-audit.mjs).
// Bridging IncomingMessage → Request → ServerResponse here is a few lines and keeps that boundary.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ZodRawShape } from "zod";
import { CaptureBatchRequestSchema, CaptureRequestSchema, ReadRequestSchema, RecordsRequestSchema, ScopeSchema, SubscribeRequestSchema, WriteRequestSchema } from "../core/stateContract.js";

export const MCP_PATH = "/nuryel/v1/mcp";

export type StateRoute = "capabilities" | "read" | "write" | "capture" | "capture-batch" | "subscribe" | "records";
export type StateDispatch = (route: StateRoute, body: Record<string, unknown>) => Promise<{ status: number; payload: unknown }>;
export interface ProblemShape { type: string; title: string; status: number; detail: string; [extra: string]: unknown }

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const TOOLS: Array<{ name: string; route: StateRoute; title: string; description: string; input: ZodRawShape }> = [
  {
    name: "nuryel_capabilities", route: "capabilities",
    title: "nuryel.state/1 — what this state server supports",
    description: "Negotiate before depending on anything: the contract version, capability list (verbs + record schemas) and your principal's grants. Optional scope {kind, id} selects a granted partition; default is your first grant.",
    input: { scope: ScopeSchema.optional() },
  },
  {
    name: "nuryel_read", route: "read",
    title: "nuryel.state/1 read — the system-of-record answer for a subject",
    description: "Read current state for a scope under a delivery receipt. Pass a subject (an entity id, a decision topic, or an external object_type:object_key such as transaction:TX-1) to get state_of_record — what is current, in force, done, what it depends on and what invalidates it — with the referenced records. Read before redoing work: if a current record already answers the subject and nothing it depends on changed, reuse it. Your identity comes from your credential; scopes outside your grants are named in denied_scopes.",
    input: ReadRequestSchema.omit({ schema: true, principal: true }).shape,
  },
  {
    name: "nuryel_write", route: "write",
    title: "nuryel.state/1 write — provenance + idempotency in, durability out",
    description: "Write one record into a facet (receipts, commitments, derived, entities, relationships, decisions, constraints, bugs, findings). The record must carry provenance and the request an idempotency_key: replaying the same request returns the original; the same key with a different payload is refused and the refusal names what differs. Ids are derived from the record's facts. A second live decision on a topic is refused with the incumbent named; pass supersedes to replace it explicitly. The result reports durability (local, committed or pushed).",
    input: WriteRequestSchema.omit({ schema: true, principal: true }).shape,
  },
  {
    name: "nuryel_capture", route: "capture",
    title: "nuryel.state/1 capture — one relevant assertion with exact source excerpts",
    description: "Save ONE relevant atomic assertion learned during the task, with a concrete future-use reason and exact excerpts from the source text. Whole source text is never stored. Saved observations are not verified current summaries or receipts.",
    input: CaptureRequestSchema.omit({ schema: true, principal: true }).shape,
  },
  {
    name: "nuryel_capture_batch", route: "capture-batch",
    title: "nuryel.state/1 capture batch — save relevant atomic observations",
    description: "Save up to 32 independent assertions from up to 8 sources in one call, each with exact supporting excerpts and a future-use reason. Results preserve input indexes; inspect every refusal.",
    input: CaptureBatchRequestSchema.omit({ schema: true, principal: true }).shape,
  },
  {
    name: "nuryel_subscribe", route: "subscribe",
    title: "nuryel.state/1 subscribe — the scope's ordered change stream after a cursor",
    description: "Return change events for a scope with seq > after_seq, strictly ordered. Keep head_seq as your next cursor; if resync is true, rebuild held state with reads.",
    input: SubscribeRequestSchema.omit({ schema: true, principal: true }).shape,
  },
  {
    name: "nuryel_records", route: "records",
    title: "nuryel.state/1 records — fetch records by id, grants first",
    description: "Fetch state records by id (from a subscribe event, a read ref or a write result). Every id is accounted for: found, denied (outside your grants) or missing.",
    input: RecordsRequestSchema.omit({ schema: true, principal: true }).shape,
  },
];

function buildServer(dispatch: StateDispatch, problemOf: (error: unknown) => ProblemShape, version: string): McpServer {
  const server = new McpServer({ name: "hunch-serve", version });
  installLeanToolList(server);
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input }, async (input): Promise<ToolResult> => {
      try {
        const { payload } = await dispatch(tool.route, { ...(input as Record<string, unknown>) });
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown> };
      } catch (error) {
        const p = problemOf(error);
        return { isError: true, content: [{ type: "text", text: `nuryel.state/1 refused [${p.title}] (${p.status}): ${p.detail}` }], structuredContent: p };
      }
    });
  }
  return server;
}

/** Serve one authenticated MCP POST. The caller has already authenticated and parsed the body. */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, body: unknown, dispatch: StateDispatch, problemOf: (error: unknown) => ProblemShape, version: string): Promise<void> {
  const server = buildServer(dispatch, problemOf, version);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    // Only the headers the transport negotiates on travel; the body was already read and bounded.
    const headers = new Headers();
    for (const name of ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const request = new Request(new URL(req.url ?? MCP_PATH, "http://127.0.0.1"), { method: "POST", headers, body: JSON.stringify(body) });
    const response = await transport.handleRequest(request, { parsedBody: body });
    const text = await response.text();
    const out: Record<string, string> = { "cache-control": "no-store", "x-hunch-version": version, "content-length": String(Buffer.byteLength(text)) };
    response.headers.forEach((value, name) => { if (name !== "content-length") out[name] = value; });
    res.writeHead(response.status, out);
    res.end(text);
  } finally {
    await transport.close();
    await server.close();
  }
}
