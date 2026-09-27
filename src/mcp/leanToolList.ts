// Lean tools/list (#368, dec_3ca27de266). The MCP SDK serializes every tool
// with bytes that tell the host nothing: a draft-07 `$schema` marker on each
// schema, `execution: {taskSupport: "forbidden"}` (the spec default when the
// field is absent), and zod's ±Number.MAX_SAFE_INTEGER bounds on every integer.
// A host that loads every schema pays for them each session. They are dropped
// at serialization only; the registered zod schemas still validate every call.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

// Keywords whose meaning differs between draft-07 and 2020-12 — the dialect MCP
// assumes when `$schema` is absent. A schema that uses any keeps its marker.
// A property merely NAMED like one also keeps it: conservative, never wrong.
const DIALECT_SENSITIVE = new Set(["definitions", "dependencies", "additionalItems", "$ref", "$id", "$recursiveRef"]);

function dialectNeutral(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(dialectNeutral);
  if (!isObject(node)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (DIALECT_SENSITIVE.has(key) || (key === "items" && Array.isArray(value))) return false;
    if (!dialectNeutral(value)) return false;
  }
  return true;
}

/** A copy without zod's safe-integer bounds, which only restate what JSON numbers can hold. */
function withoutSafeIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSafeIntegerBounds);
  if (!isObject(node)) return node;
  const integer = node.type === "integer";
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (integer && ((key === "maximum" && value === Number.MAX_SAFE_INTEGER) || (key === "minimum" && value === Number.MIN_SAFE_INTEGER))) continue;
    out[key] = withoutSafeIntegerBounds(value);
  }
  return out;
}

function leanSchema(schema: JsonObject): JsonObject {
  const lean = withoutSafeIntegerBounds(schema) as JsonObject;
  if (dialectNeutral(schema)) delete lean.$schema;
  return lean;
}

const isDefaultExecution = (v: unknown): boolean =>
  isObject(v) && Object.entries(v).every(([key, value]) => key === "taskSupport" && (value === undefined || value === "forbidden"));

/** One tool definition as the host should see it. */
export function leanTool(tool: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(tool)) {
    if (key === "execution" && isDefaultExecution(value)) continue;
    out[key] = (key === "inputSchema" || key === "outputSchema") && isObject(value) ? leanSchema(value) : value;
  }
  return out;
}

/** Route the SDK's tools/list result through leanTool. Call right after
 *  constructing the server: McpServer installs its tools/list handler on the
 *  first registerTool, through this public setRequestHandler. */
export function installLeanToolList(server: McpServer): void {
  const protocol = server.server;
  const setRequestHandler = protocol.setRequestHandler.bind(protocol) as (schema: unknown, handler: unknown) => void;
  protocol.setRequestHandler = ((schema: unknown, handler: (...args: unknown[]) => unknown) => {
    if (schema !== ListToolsRequestSchema) return setRequestHandler(schema, handler);
    setRequestHandler(schema, async (...args: unknown[]) => {
      const result = await handler(...args);
      if (!isObject(result) || !Array.isArray(result.tools)) return result;
      return { ...result, tools: result.tools.map((t) => (isObject(t) ? leanTool(t) : t)) };
    });
  }) as typeof protocol.setRequestHandler;
}
