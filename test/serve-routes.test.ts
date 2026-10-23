import { cleanupDir } from "./fixtures.js";
/**
 * Route × status gate for `hunch serve`.
 *
 * The routes and problem codes are DISCOVERED from src/serve/** at test time and compared with
 * the explicit lists below, so a new route or problem code fails here until it is listed — and a
 * listed one fails the coverage test at the bottom until some request in this file has actually
 * produced it over real HTTP (or it is named unreachable, with the reason).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { BODY_LIMIT_BYTES, PROBLEM_TYPE, createServeApp } from "../src/serve/app.js";
import { MCP_PATH } from "../src/serve/mcpHttp.js";
import { ServeConfigSchema, hashToken, initServeConfig, readServeConfig } from "../src/serve/config.js";
import { withWriteLock } from "../src/serve/writelock.js";
import { stateHash } from "../src/core/stateContract.js";
import { tokenProofHash } from "../src/core/stateProof.js";

const SERVE_SRC = new URL("../src/serve/", import.meta.url);
const src = (name: string): string => readFileSync(new URL(name, SERVE_SRC), "utf8");

// ---- the explicit lists ---------------------------------------------------------------------

const EXPECTED_ROUTES = [
  "GET /operator", "GET /operator/", "GET /operator.css", "GET /operator.js",
  "GET /nuryel/v1/health", "GET /nuryel/v1/capabilities",
  "POST /nuryel/v1/read", "POST /nuryel/v1/write", "POST /nuryel/v1/capture", "POST /nuryel/v1/capture-batch",
  "POST /nuryel/v1/subscribe", "POST /nuryel/v1/records", "POST /nuryel/v1/mcp",
].sort();

const EXPECTED_PROBLEMS = [
  "400 invalid-body", "400 invalid-scope", "400 malformed", "400 unsupported",
  "401 unauthorized", "401 invalid_dpop_proof", "401 use_dpop_nonce",
  "403 outside-grants", "404 no-partition", "404 no-partition-home", "404 not-found",
  "405 method-not-allowed", "409 conflict", "409 idempotency", "413 body-too-large", "422 identity",
  "500 internal", "503 configuration-unavailable", "503 proof-state-unavailable", "503 write-lock-timeout",
].sort();

/** Listed problem codes no HTTP request can produce today, with the reason. */
const UNREACHABLE: Record<string, string> = {
  "400 unsupported": "every served store IS the partition its scope selects, and facet is a Zod enum — the binding's unsupported paths (foreign repository scope, legacy facet under another scope, non-store facet, visibility in a private overlay) cannot be entered through serve",
  "404 no-partition-home": "a served partition is always the store's own partition, so stateHomeFor never falls through to the overlay-home check",
};

// ---- discovery ------------------------------------------------------------------------------

function discoverRoutes(): string[] {
  const app = src("app.ts");
  const routes = new Set<string>();
  const postTable = /const POST_ROUTES = new Map<[^>]+>\(\[(.*)\]\);/.exec(app);
  assert.ok(postTable, "POST_ROUTES table not found in src/serve/app.ts");
  for (const m of postTable[1]!.matchAll(/\["(\/[^"]+)", "[a-z-]+"\]/g)) routes.add(`POST ${m[1]}`);
  const assets = /const asset = new Map<[^>]+>\(\[(.*)\]\)\.get/.exec(app);
  assert.ok(assets, "operator asset table not found in src/serve/app.ts");
  for (const m of assets[1]!.matchAll(/\["(\/[^"]+)", \[/g)) routes.add(`GET ${m[1]}`);
  const literal = [...app.matchAll(/url\.pathname === "(\/[^"]+)" && req\.method === "([A-Z]+)"/g)];
  for (const m of literal) routes.add(`${m[2]} ${m[1]}`);
  const mcpPath = /export const MCP_PATH = "([^"]+)"/.exec(src("mcpHttp.ts"));
  assert.ok(mcpPath, "MCP_PATH not found");
  assert.match(app, /url\.pathname === MCP_PATH/);
  routes.add(`POST ${mcpPath[1]}`);
  // Every pathname comparison must be one of the shapes parsed above.
  assert.equal([...app.matchAll(/url\.pathname ===/g)].length, literal.length + 1, "an unparsed url.pathname comparison was added to app.ts");
  return [...routes].sort();
}

function discoverProblems(): string[] {
  const codes = new Set<string>();
  let literalSites = 0, callSites = 0;
  for (const file of readdirSync(SERVE_SRC).filter((f) => f.endsWith(".ts"))) {
    const text = src(file);
    callSites += [...text.matchAll(/\bproblem\(/g)].length;
    for (const m of text.matchAll(/\bproblem\((\d{3}), ["']([a-z_-]+)["']/g)) { codes.add(`${m[1]} ${m[2]}`); literalSites++; }
  }
  const app = src("app.ts");
  const refusals = /const REFUSAL_STATUS[^{]*\{([^}]*)\}/.exec(app);
  assert.ok(refusals, "REFUSAL_STATUS not found");
  for (const m of refusals[1]!.matchAll(/"?([a-z-]+)"?:\s*(\d{3})/g)) codes.add(`${m[2]} ${m[1]}`);
  const proofCodes = /readonly code: ((?:'[a-z_]+'\s*\|?\s*)+)/.exec(src("stateProof.ts"));
  assert.ok(proofCodes, "StateProofError codes not found");
  for (const m of proofCodes[1]!.matchAll(/'([a-z_]+)'/g)) codes.add(`401 ${m[1]}`);
  // The two dynamic sites: problem(REFUSAL_STATUS[code], code, ...) and problem(401, error.code, ...).
  assert.match(app, /problem\(REFUSAL_STATUS\[error\.code\], error\.code/);
  assert.match(app, /problem\(401, error\.code, error\.message\)/);
  assert.equal(callSites, literalSites + 2, "a problem(...) call with a non-literal code was added under src/serve/");
  return [...codes].sort();
}

test("discovered routes and problem codes equal the explicit lists", () => {
  assert.deepEqual(discoverRoutes(), EXPECTED_ROUTES);
  assert.deepEqual(discoverProblems(), EXPECTED_PROBLEMS);
  for (const code of Object.keys(UNREACHABLE)) assert.ok(EXPECTED_PROBLEMS.includes(code), `${code} is not a listed problem`);
});

// ---- fixtures -------------------------------------------------------------------------------

const seenProblems = new Set<string>();
const seenRoutes = new Set<string>();
const secrets: string[] = [];
const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServeApp>> = [];

after(async () => {
  for (const app of servers) { await new Promise<void>((r) => app.close(() => r())); app.closeStores(); }
  for (const dir of dirs) cleanupDir(dir);
});

function sandbox(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  secrets.push(dir, dir.replace(/\\/g, "/"), dir.replace(/\\/g, "\\\\"));
  return dir;
}

async function listen(app: ReturnType<typeof createServeApp>): Promise<string> {
  servers.push(app);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  const address = app.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const david = { kind: "user" as const, id: "david" };
const acme = { kind: "organization" as const, id: "acme" };
const ghost = { kind: "team" as const, id: "ghost" };
const prov = { source: "imported:sofia", confidence: 0.9, evidence: ["sofia approvals row a1"] };
const crmEvent = { system: "crm", object_type: "event", object_key: "10042", observed_at: "2026-09-08T10:00:00Z" };
const receipt = { schema: "nuryel.receipt/1", scope: david, actor: "sofia@david", action_kind: "add_comment", target: crmEvent, request_fingerprint: stateHash({ c: 1 }), state: "verified", occurred_at: "2026-09-08T10:00:00Z", provenance: prov, invalidates: ["customer:c1"] };
const source = { ref: { system: "crm", object_type: "note", object_key: "route-note", observed_at: "2026-09-10T12:00:00Z" }, source_text: "Use the west entrance. Call Dana on Thursday." };
const observation = { subject: "customer:route", statement: "Use the west entrance.", relevance: { use: "operational_fact" as const, reason: "Choose the correct entrance for visits." } };

const main = (() => {
  const dir = sandbox("hunch-serve-routes-");
  const file = join(dir, "hunch-serve.json");
  const sofia = initServeConfig({ file, scope: david, root: join(dir, "david"), principal: { id: "sofia@david", kind: "agent" } }).token!;
  const orc = initServeConfig({ file, scope: acme, root: join(dir, "acme"), principal: { id: "orc", kind: "service", grants: [acme, david] } }).token!;
  secrets.push(sofia, orc, hashToken(sofia), hashToken(orc));
  const app = createServeApp(readServeConfig(file), { version: "test", writeLockTimeoutMs: 30, log: () => {} });
  return { dir, file, sofia, orc, app, base: listen(app) };
})();

// ---- request helper (records coverage, validates every problem body) ------------------------

type Res = { status: number; headers: Headers; text: string; json: Record<string, unknown> };
const PROBLEM_KEYS = new Set(["type", "title", "status", "detail", "issues", "conflict", "retry-after"]);

function checkProblem(status: number, contentType: string | null, text: string): Record<string, unknown> {
  assert.match(contentType ?? "", /^application\/problem\+json/, `status ${status} must be problem+json: ${text}`);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(typeof body.title, "string");
  assert.equal(body.type, `${PROBLEM_TYPE}${String(body.title)}`);
  assert.equal(body.status, status);
  assert.equal(typeof body.detail, "string");
  for (const key of Object.keys(body)) assert.ok(PROBLEM_KEYS.has(key), `unexpected problem field ${key}`);
  for (const secret of secrets) assert.ok(!text.includes(secret), `problem body leaks server internals: ${text}`);
  assert.doesNotMatch(text, /node_modules|\.ts:\d|\bat [\w.<>]+ \(|EACCES|ENOENT|[A-Za-z]:\\\\/, `problem body leaks server internals: ${text}`);
  seenProblems.add(`${status} ${String(body.title)}`);
  return body;
}

async function call(base: string, method: string, path: string, o: { token?: string; scheme?: string; body?: unknown; raw?: string | Buffer; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.body !== undefined || o.raw !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `${o.scheme ?? "Bearer"} ${o.token}` } : {}), ...o.headers };
  const res = await fetch(base + path, { method, headers, ...(o.raw !== undefined ? { body: o.raw as unknown as BodyInit } : o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const text = await res.text();
  const contentType = res.headers.get("content-type");
  let json: Record<string, unknown> = {};
  if (res.status >= 400 && !contentType?.includes("event-stream")) json = checkProblem(res.status, contentType, text);
  else {
    if (/json/.test(contentType ?? "")) json = JSON.parse(text) as Record<string, unknown>;
    seenRoutes.add(`${method} ${path.split("?")[0]}`);
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Raw request for header shapes fetch cannot send (duplicate headers). */
function rawCall(base: string, method: string, path: string, rawHeaders: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: rawHeaders as unknown as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: checkProblem(res.statusCode!, res.headers["content-type"] ?? null, Buffer.concat(chunks).toString("utf8")) }); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const code = (r: Res) => `${r.status} ${String(r.json.title)}`;

// ---- generic per-route matrix ---------------------------------------------------------------

const POST_BODIES: Record<string, unknown> = {
  "/nuryel/v1/read": { scope: david, subject: "customer:c1" },
  "/nuryel/v1/write": { scope: david, facet: "receipts", record: receipt, idempotency_key: "generic-write-1" },
  "/nuryel/v1/capture": { scope: david, ...observation, evidence: [{ ...source, excerpt: "Use the west entrance." }] },
  "/nuryel/v1/capture-batch": { scope: david, sources: [source], observations: [{ ...observation, statement: "Call Dana on Thursday.", evidence: [{ source: 0, excerpt: "Call Dana on Thursday." }] }] },
  "/nuryel/v1/subscribe": { scope: david, after_seq: 0 },
  "/nuryel/v1/records": { scope: david, ids: ["nrc_000000000000000000000000"] },
};

for (const path of Object.keys(POST_BODIES)) {
  test(`${path}: auth, method, body-size, JSON and content-type gates`, async () => {
    const base = await main.base;
    const body = POST_BODIES[path];
    assert.equal(code(await call(base, "POST", path, { body })), "401 unauthorized");
    assert.equal(code(await call(base, "POST", path, { body, token: "nyt_wrong_token" })), "401 unauthorized");
    assert.equal(code(await call(base, "POST", path, { body, token: main.sofia, scheme: "Basic" })), "401 unauthorized");
    assert.equal(code(await call(base, "GET", path, { token: main.sofia })), "405 method-not-allowed");
    assert.equal(code(await call(base, "PUT", path, { token: main.sofia, body })), "405 method-not-allowed");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, raw: Buffer.alloc(BODY_LIMIT_BYTES + 1, 32) })), "413 body-too-large");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, raw: "{" })), "400 invalid-body");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, raw: "[1]" })), "400 invalid-body");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, raw: "" })), "400 invalid-scope", "an empty body is {} and names no scope");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, body: { ...(body as object), scope: { kind: "planet", id: "x" } } })), "400 invalid-scope");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, body: { ...(body as object), scope: acme } })), "403 outside-grants");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia, body: { ...(body as object), unexpected_field: 1 } })), "400 malformed");
    // Content-type is not negotiated on REST: the bearer header already forces a CORS preflight,
    // so a text/plain JSON body is accepted as designed.
    const plain = await call(base, "POST", path, { token: main.sofia, raw: JSON.stringify(body), headers: { "content-type": "text/plain" } });
    assert.ok(plain.status < 300, `${path} with text/plain: ${plain.text}`);
    const ok = await call(base, "POST", path, { token: main.sofia, body });
    assert.ok(ok.status < 300, ok.text);
    assert.match(ok.headers.get("content-type")!, /^application\/json/);
    assert.equal(ok.headers.get("cache-control"), "no-store");
  });
}

test("REST 405 names the allowed method (RFC 9110 §15.5.6)", async () => {
  const base = await main.base;
  const res = await call(base, "GET", "/nuryel/v1/read", { token: main.sofia });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("a wrong method on a GET-only route is 405, not 404", async () => {
  const base = await main.base;
  assert.equal(code(await call(base, "POST", "/nuryel/v1/capabilities", { token: main.sofia, body: {} })), "405 method-not-allowed");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/health", { token: main.sofia, body: {} })), "405 method-not-allowed");
});

// ---- per-route success + domain codes -------------------------------------------------------

test("public routes: operator assets and health", async () => {
  const base = await main.base;
  for (const [path, type] of [["/operator", "text/html"], ["/operator/", "text/html"], ["/operator.css", "text/css"], ["/operator.js", "text/javascript"]] as const) {
    const res = await call(base, "GET", path);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")!.startsWith(type));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    for (const secret of secrets) assert.ok(!res.text.includes(secret));
    // Any other method on an asset is not public: it falls to the authenticated router.
    assert.equal(code(await call(base, "POST", path)), "401 unauthorized");
    assert.equal(code(await call(base, "POST", path, { token: main.sofia })), "404 not-found");
  }
  const anon = await call(base, "GET", "/nuryel/v1/health");
  assert.deepEqual(anon.json, { ok: true, version: "test", protocol: "nuryel.state/1" });
  const authed = await call(base, "GET", "/nuryel/v1/health", { token: main.orc });
  assert.deepEqual(authed.json.partitions, ["user/david", "organization/acme"]);
  assert.equal(code(await call(base, "GET", "/nuryel/v1/health", { token: "nyt_wrong_token" })), "401 unauthorized");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/health", { headers: { dpop: "x.y.z" } })), "401 unauthorized");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/health", { token: main.sofia, headers: { dpop: "x.y.z" } })), "401 invalid_dpop_proof", "a bearer credential never carries a proof");
});

test("unknown routes: 401 before auth, 404 not-found / 405 after", async () => {
  const base = await main.base;
  assert.equal(code(await call(base, "POST", "/nuryel/v1/nope", { body: {} })), "401 unauthorized");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/nope", { token: main.sofia, body: {} })), "404 not-found");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/nope", { token: main.sofia })), "405 method-not-allowed");
  const dup = await rawCall(base, "GET", "/nuryel/v1/capabilities", ["Host", new URL(base).host, "Authorization", `Bearer ${main.sofia}`, "Authorization", `Bearer ${main.sofia}`]);
  assert.equal(`${dup.status} ${String(dup.body.title)}`, "401 invalid_dpop_proof", "two Authorization headers are ambiguous");
});

test("GET /nuryel/v1/capabilities", async () => {
  const base = await main.base;
  const ok = await call(base, "GET", "/nuryel/v1/capabilities", { token: main.orc });
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.json.principal as { id: string }).id, "orc");
  assert.ok((ok.json.capabilities as string[]).includes("nuryel.auth.dpop/1"));
  assert.equal((await call(base, "GET", "/nuryel/v1/capabilities?scope=user:david", { token: main.orc })).status, 200);
  assert.equal(code(await call(base, "GET", "/nuryel/v1/capabilities")), "401 unauthorized");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/capabilities", { token: "nyt_wrong_token" })), "401 unauthorized");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/capabilities?scope=bad", { token: main.sofia })), "400 invalid-scope");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/capabilities?scope=planet:x", { token: main.sofia })), "400 invalid-scope");
  assert.equal(code(await call(base, "GET", "/nuryel/v1/capabilities?scope=organization:acme", { token: main.sofia })), "403 outside-grants");
  assert.equal(code(await call(base, "DELETE", "/nuryel/v1/capabilities", { token: main.sofia })), "405 method-not-allowed");
});

test("POST /nuryel/v1/read domain codes", async () => {
  const base = await main.base;
  const t = { token: main.orc };
  const ok = await call(base, "POST", "/nuryel/v1/read", { ...t, body: { scope: david, subject: "customer:c1" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.envelope);
  const union = await call(base, "POST", "/nuryel/v1/read", { token: main.sofia, body: { scope: david, scopes: [david, acme], subject: "customer:c1" } });
  assert.equal(union.status, 200);
  assert.deepEqual(union.json.denied_scopes, [acme]);
  assert.equal(code(await call(base, "POST", "/nuryel/v1/read", { ...t, body: { scope: david, scopes: [] } })), "400 invalid-scope");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/read", { ...t, body: { scope: david, scopes: [david], observed_page: { snapshot_hash: stateHash(1), offset: 0 } } })), "400 malformed");
  const zod = await call(base, "POST", "/nuryel/v1/read", { ...t, body: { scope: david, subject: 5 } });
  assert.equal(code(zod), "400 malformed");
  assert.ok(Array.isArray(zod.json.issues));
});

test("POST /nuryel/v1/write domain codes", async () => {
  const base = await main.base;
  const t = { token: main.sofia };
  const write = (body: Record<string, unknown>) => call(base, "POST", "/nuryel/v1/write", { ...t, body: { scope: david, facet: "receipts", ...body } });
  const created = await write({ record: receipt, idempotency_key: "route-write-1" });
  assert.ok(created.status === 201 || created.status === 200, created.text);
  assert.ok(created.json.outcome === "created" || created.json.outcome === "replayed");
  const replay = await write({ record: receipt, idempotency_key: "route-write-1" });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.outcome, "replayed");
  assert.equal(code(await write({ record: { ...receipt, state: "failed" }, idempotency_key: "route-write-1" })), "409 idempotency");
  assert.equal(code(await write({ record: { ...receipt, id: "nrc_000000000000000000000000" }, idempotency_key: "route-write-identity" })), "422 identity");
  const conflict = await write({ record: { ...receipt, request_fingerprint: stateHash({ c: 2 }) }, idempotency_key: "route-write-conflict", supersedes: "nrc_ffffffffffffffffffffffff" });
  assert.equal(code(conflict), "409 conflict");
  assert.ok(conflict.json.conflict, "a conflict names the incumbent");
  assert.equal(code(await write({ record: { schema: "nuryel.receipt/1", scope: david }, idempotency_key: "route-write-malformed" })), "400 malformed");
  assert.equal(code(await write({ facet: "nonsense", record: receipt, idempotency_key: "route-write-facet" })), "400 malformed");
  // The partition's write lock held by another writer: 503, generic detail, retry hint.
  const held = withWriteLock(join(main.dir, "david", ".hunch"), () => new Promise<void>((r) => setTimeout(r, 400)));
  try {
    const busy = await write({ record: { ...receipt, request_fingerprint: stateHash({ c: 3 }) }, idempotency_key: "route-write-busy" });
    assert.equal(code(busy), "503 write-lock-timeout");
    assert.equal(busy.json["retry-after"], 1);
    assert.doesNotMatch(busy.text, /write\.lock|pid/i);
  } finally { await held; }
});

test("POST /nuryel/v1/capture domain codes", async () => {
  const base = await main.base;
  const body = { scope: david, ...observation, statement: "Call Dana on Thursday.", evidence: [{ ...source, excerpt: "Call Dana on Thursday." }] };
  const first = await call(base, "POST", "/nuryel/v1/capture", { token: main.sofia, body: { ...body, subject: "customer:capture-direct" } });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.outcome, "created");
  const again = await call(base, "POST", "/nuryel/v1/capture", { token: main.sofia, body: { ...body, subject: "customer:capture-direct" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.outcome, "replayed");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/capture", { token: main.sofia, body: { ...body, evidence: [{ ...source, excerpt: "Not in the source." }] } })), "400 malformed");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/capture", { token: main.sofia, body: { ...body, evidence: [{ ...source, ref: { ...source.ref, content_hash: stateHash("other") }, excerpt: "Call Dana on Thursday." }] } })), "400 malformed");
});

test("POST /nuryel/v1/capture-batch domain codes", async () => {
  const base = await main.base;
  const ok = await call(base, "POST", "/nuryel/v1/capture-batch", { token: main.sofia, body: { scope: david, sources: [source], observations: [
    { ...observation, subject: "customer:batch", evidence: [{ source: 0, excerpt: "Use the west entrance." }] },
    { ...observation, subject: "customer:batch", evidence: [{ source: 0, excerpt: "Not in source." }] },
  ] } });
  assert.equal(ok.status, 200);
  const results = ok.json.results as Array<{ status: string }>;
  assert.deepEqual(results.map((r) => r.status), ["saved", "refused"], "per-item refusals ride a 200");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/capture-batch", { token: main.sofia, body: { scope: david, sources: [source], observations: [] } })), "400 malformed");
});

test("POST /nuryel/v1/subscribe and /nuryel/v1/records domain codes", async () => {
  const base = await main.base;
  const sub = await call(base, "POST", "/nuryel/v1/subscribe", { token: main.sofia, body: { scope: david, after_seq: 0 } });
  assert.equal(sub.status, 200);
  const events = sub.json.events as Array<{ seq: number; record_id: string }>;
  assert.ok(events.length >= 1, "earlier writes and captures are on the change stream");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  const tail = await call(base, "POST", "/nuryel/v1/subscribe", { token: main.sofia, body: { scope: david, after_seq: events.at(-1)!.seq } });
  assert.deepEqual(tail.json.events, []);
  assert.equal(code(await call(base, "POST", "/nuryel/v1/subscribe", { token: main.sofia, body: { scope: david } })), "400 malformed");
  assert.equal(code(await call(base, "POST", "/nuryel/v1/subscribe", { token: main.sofia, body: { scope: david, after_seq: -1 } })), "400 malformed");
  const missing = "nrc_ffffffffffffffffffffffff";
  const recs = await call(base, "POST", "/nuryel/v1/records", { token: main.sofia, body: { scope: david, ids: [events[0]!.record_id, missing] } });
  assert.equal(recs.status, 200);
  assert.ok((recs.json.records as Record<string, unknown>)[events[0]!.record_id]);
  assert.deepEqual(recs.json.missing, [missing]);
  assert.equal(code(await call(base, "POST", "/nuryel/v1/records", { token: main.sofia, body: { scope: david, ids: [] } })), "400 malformed");
});

test("POST /nuryel/v1/mcp", async () => {
  const base = await main.base;
  const mcpHeaders = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const list = await call(base, "POST", MCP_PATH, { token: main.sofia, headers: mcpHeaders, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(list.status, 200, list.text);
  const tools = ((list.json.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
  assert.deepEqual(tools, ["nuryel_capabilities", "nuryel_capture", "nuryel_capture_batch", "nuryel_read", "nuryel_records", "nuryel_subscribe", "nuryel_write"]);
  const refused = await call(base, "POST", MCP_PATH, { token: main.sofia, headers: mcpHeaders, body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nuryel_read", arguments: { scope: acme } } } });
  assert.equal(refused.status, 200);
  const result = refused.json.result as { isError: boolean; structuredContent: Record<string, unknown> };
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.title, "outside-grants");
  checkProblem(403, "application/problem+json", JSON.stringify(result.structuredContent));
  assert.equal(code(await call(base, "POST", MCP_PATH, { headers: mcpHeaders, body: { jsonrpc: "2.0", id: 3, method: "tools/list" } })), "401 unauthorized");
  assert.equal(code(await call(base, "POST", MCP_PATH, { token: "nyt_wrong_token", headers: mcpHeaders, body: {} })), "401 unauthorized");
  for (const method of ["GET", "DELETE"]) {
    const res = await call(base, method, MCP_PATH, { token: main.sofia });
    assert.equal(code(res), "405 method-not-allowed");
    assert.equal(res.headers.get("allow"), "POST");
  }
  assert.equal(code(await call(base, "POST", MCP_PATH, { token: main.sofia, headers: mcpHeaders, raw: Buffer.alloc(BODY_LIMIT_BYTES + 1, 32) })), "413 body-too-large");
  assert.equal(code(await call(base, "POST", MCP_PATH, { token: main.sofia, headers: mcpHeaders, raw: "{" })), "400 invalid-body");
  // Content-type IS negotiated by the MCP transport (JSON-RPC error, not problem+json).
  const wrongType = await fetch(base + MCP_PATH, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${main.sofia}`, "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) });
  assert.equal(wrongType.status, 415);
  const wrongTypeText = await wrongType.text();
  for (const secret of secrets) assert.ok(!wrongTypeText.includes(secret));
});

// ---- server-side states: unknown partition, 500, config and lock -----------------------------

test("a granted scope this server does not host is 404 no-partition", async () => {
  const dir = sandbox("hunch-serve-routes-ghost-");
  initServeConfig({ file: join(dir, "init.json"), scope: david, root: join(dir, "david") });
  const token = "nyt_ghost_route_token";
  secrets.push(token);
  const config = ServeConfigSchema.parse({ schema: "nuryel.serve-config/1", partitions: [{ scope: david, root: join(dir, "david") }], principals: [{ id: "ghost", kind: "agent", token_sha256: hashToken(token), grants: [david, ghost] }] });
  const base = await listen(createServeApp(config, { version: "test", log: () => {} }));
  assert.equal(code(await call(base, "GET", "/nuryel/v1/capabilities?scope=team:ghost", { token })), "404 no-partition");
  for (const path of Object.keys(POST_BODIES)) assert.equal(code(await call(base, "POST", path, { token, body: { ...(POST_BODIES[path] as object), scope: ghost } })), "404 no-partition", path);
});

test("a server-side failure is 500 internal with a generic detail", async () => {
  const dir = sandbox("hunch-serve-routes-500-");
  const file = join(dir, "serve.json");
  const token = initServeConfig({ file, scope: david, root: join(dir, "david"), principal: { id: "sofia@david", kind: "agent" } }).token!;
  secrets.push(token);
  const logged: string[] = [];
  const secretPath = join(dir, "secret", "store.sqlite");
  const base = await listen(createServeApp(readServeConfig(file), { version: "test", log: (l) => logged.push(l), openStore: () => { throw new Error(`EACCES: permission denied, open '${secretPath}'`); } }));
  const res = await call(base, "POST", "/nuryel/v1/read", { token, body: { scope: david } });
  assert.equal(code(res), "500 internal");
  assert.equal(res.json.detail, "internal server error");
  assert.ok(logged.some((l) => l.includes(secretPath)), "the specifics reach the server log");
});

test("an unreadable config refuses every authenticated route with 503 configuration-unavailable", async () => {
  const dir = sandbox("hunch-serve-routes-config-");
  const file = join(dir, "serve.json");
  const token = initServeConfig({ file, scope: david, root: join(dir, "david"), principal: { id: "sofia@david", kind: "agent" } }).token!;
  secrets.push(token);
  const base = await listen(createServeApp(readServeConfig(file), { version: "test", log: () => {} }));
  assert.equal((await call(base, "GET", "/nuryel/v1/capabilities", { token })).status, 200);
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{ not json");
  try {
    for (const [method, path] of [["GET", "/nuryel/v1/health"], ["GET", "/nuryel/v1/capabilities"], ["POST", "/nuryel/v1/read"], ["POST", MCP_PATH], ["GET", "/operator"]]) {
      assert.equal(code(await call(base, method!, path!, { token, body: method === "POST" ? { scope: david } : undefined })), "503 configuration-unavailable", path);
    }
  } finally { writeFileSync(file, good); }
});

// ---- DPoP / Ed25519 request proof ----------------------------------------------------------

const ORIGIN = "https://state.example.test";

function prove(key: KeyObject, o: { method: string; path: string; token: string; nonce?: string; iat?: number; jti?: string }): string {
  const { kty, crv, x } = createPublicKey(key).export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const message = `${enc({ typ: "dpop+jwt", alg: "EdDSA", jwk: { kty, crv, x } })}.${enc({ jti: o.jti ?? randomUUID(), htm: o.method, htu: ORIGIN + o.path, iat: o.iat ?? Math.floor(Date.now() / 1000), ath: tokenProofHash(o.token), ...(o.nonce ? { nonce: o.nonce } : {}) })}`;
  return `${message}.${sign(null, Buffer.from(message), key).toString("base64url")}`;
}

test("DPoP: nonce challenge, valid proof, replay, wrong key, stale timestamp, scheme and binding", async () => {
  const dir = sandbox("hunch-serve-routes-dpop-");
  const file = join(dir, "serve.json");
  const keys = generateKeyPairSync("ed25519");
  const token = initServeConfig({ file, scope: david, root: join(dir, "david"), publicOrigin: ORIGIN, principal: { id: "writer", kind: "agent", proofKey: keys.publicKey.export({ format: "jwk" }) as never } }).token!;
  secrets.push(token);
  const config = readServeConfig(file);
  const base = await listen(createServeApp(config, { version: "test", log: () => {} }));
  const path = "/nuryel/v1/capabilities";
  const dpop = (proof?: string) => call(base, "GET", path, { token, scheme: "DPoP", headers: proof ? { dpop: proof } : {} });

  const challenge = await dpop();
  assert.equal(code(challenge), "401 use_dpop_nonce");
  const nonce = challenge.headers.get("dpop-nonce");
  assert.ok(nonce);
  assert.match(challenge.headers.get("www-authenticate")!, /^DPoP error="use_dpop_nonce", algs="EdDSA"$/);

  const proof = prove(keys.privateKey, { method: "GET", path, token, nonce });
  const ok = await dpop(proof);
  assert.equal(ok.status, 200, ok.text);
  assert.equal((ok.json.principal as { id: string }).id, "writer");
  assert.equal(code(await dpop(proof)), "401 invalid_dpop_proof", "a replayed proof (same jti) is refused");
  assert.equal(code(await dpop(prove(generateKeyPairSync("ed25519").privateKey, { method: "GET", path, token, nonce }))), "401 invalid_dpop_proof", "wrong key");
  assert.equal(code(await dpop(prove(keys.privateKey, { method: "GET", path, token, nonce, iat: Math.floor(Date.now() / 1000) - 120 }))), "401 invalid_dpop_proof", "stale iat");
  assert.equal(code(await dpop(prove(keys.privateKey, { method: "POST", path, token, nonce }))), "401 invalid_dpop_proof", "method not bound");
  assert.equal(code(await dpop(prove(keys.privateKey, { method: "GET", path: "/nuryel/v1/read", token, nonce }))), "401 invalid_dpop_proof", "target not bound");
  assert.equal(code(await dpop(prove(keys.privateKey, { method: "GET", path, token, nonce: "0.invented" }))), "401 use_dpop_nonce", "an invented nonce is re-challenged");
  assert.equal(code(await dpop("not-a-jwt")), "401 invalid_dpop_proof");
  assert.equal(code(await call(base, "GET", path, { token })), "401 invalid_dpop_proof", "bearer fallback is disabled for a key-bound credential");
  // A POST route through the proof path: body is only read after the proof is accepted.
  const write = await call(base, "POST", "/nuryel/v1/subscribe", { token, scheme: "DPoP", headers: { dpop: prove(keys.privateKey, { method: "POST", path: "/nuryel/v1/subscribe", token, nonce }) }, body: { scope: david, after_seq: 0 } });
  assert.equal(write.status, 200, write.text);

  // Same key-bound credential with no persistent proof state (in-memory config, no authStateDir).
  const { file: _file, ...inMemory } = config;
  const stateless = await listen(createServeApp(inMemory, { version: "test", log: () => {} }));
  assert.equal(code(await call(stateless, "GET", path, { token, scheme: "DPoP", headers: { dpop: proof } })), "503 proof-state-unavailable");
});

// ---- coverage gate --------------------------------------------------------------------------

test("every listed route answered 2xx and every reachable problem code was produced", () => {
  for (const route of EXPECTED_ROUTES) assert.ok(seenRoutes.has(route), `no success case for ${route}`);
  const missing = EXPECTED_PROBLEMS.filter((p) => !UNREACHABLE[p] && !seenProblems.has(p));
  assert.deepEqual(missing, [], "listed problem codes no test produced");
  const unlisted = [...seenProblems].filter((p) => !EXPECTED_PROBLEMS.includes(p));
  assert.deepEqual(unlisted, [], "problem codes produced over HTTP that the source scan did not find");
  for (const p of Object.keys(UNREACHABLE)) assert.ok(!seenProblems.has(p), `${p} is reachable after all — remove it from UNREACHABLE`);
});
