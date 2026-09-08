/**
 * Agent farm — a demo + measurement harness for `hunch serve` as the deterministic state layer.
 *
 * K "sofia" agents (kind agent; own user drawer + the organization drawer), one "orc" service
 * (organization only) and one "engineer" agent (organization only) run a scripted day against an
 * in-process `hunch serve` on 127.0.0.1:0 inside a temp directory. Everything is counted: write
 * outcomes, refusals by code, reads, reuse of another agent's current summary, contradictions,
 * and ledger contiguity. Runtime imports come from `dist/` only — build first.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServeApp } from "../../dist/serve/app.js";
import { initServeConfig, readServeConfig } from "../../dist/serve/config.js";
import { createStateClient, StateClientError } from "../../dist/client/state.js";
import { assertChangeSequence, derivedId, stateHash } from "../../dist/core/stateContract.js";

const DAY = "2026-09-08";
const AT = `${DAY}T09:00:00Z`;
const prov = (evidence) => ({ source: "agent_recorded", confidence: 0.9, evidence: [evidence] });
const sha256 = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A served partition is its own git repository: every write becomes a commit (durability "committed"). */
function gitInit(root) {
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "farm@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "agent farm"], { stdio: "ignore" });
}

/** A counting client: one per principal. Refusals are counted by code, 503 lock timeouts are retried. */
function principalClient(name, baseUrl, token, tally) {
  const client = createStateClient({ baseUrl, token });
  const count = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  return {
    name, client,
    async read(scope, subject) { tally.reads++; return client.read({ scope, subject }); },
    async write(req) {
      for (let attempt = 0; ; attempt++) {
        try { const r = await client.write(req); count(tally.writes, r.outcome); count(tally.durability, r.durability); return r; } catch (e) {
          if (e instanceof StateClientError && e.code === "write-lock-timeout" && attempt < 3) { tally.retries++; await sleep(50); continue; }
          throw e;
        }
      }
    },
    /** Run an action that MUST be refused with the given status/code; count it, throw if it succeeded. */
    async expectRefusal(label, status, code, action, detailMatch) {
      try { await action(); } catch (e) {
        if (!(e instanceof StateClientError)) throw e;
        if (e.status !== status || e.code !== code) throw new Error(`${name}: ${label}: expected ${status} ${code}, got ${e.status} ${e.code}: ${e.message}`);
        if (detailMatch && !e.problem.detail.includes(detailMatch)) throw new Error(`${name}: ${label}: refusal detail lacks "${detailMatch}": ${e.problem.detail}`);
        count(tally.refusals, code); return e;
      }
      throw new Error(`${name}: ${label}: expected a ${status} ${code} refusal, but the call succeeded`);
    },
  };
}

/** The records a sofia would write for one customer — deterministic, so two sofias derive the same ids. */
function customerRecords(org, customer, transform = "summary/v1") {
  const subject = `customer:${customer.id}`;
  const event = { system: "crm", object_type: "event", object_key: String(customer.event), observed_at: AT, content_hash: sha256(`crm-event-${customer.event}`) };
  const content = `${customer.name}: last CRM event ${customer.event}; ${customer.plan} plan; renewal ${customer.renewal}.`;
  const derived = { schema: "nuryel.derived/1", scope: org, subject, content, content_hash: stateHash(content), dependencies: [{ kind: "external", ref: event }], transform_version: transform, computed_at: AT, valid_to: null, state: "current", provenance: prov(`crm event ${customer.event}`) };
  const commitment = { schema: "nuryel.commitment/1", scope: org, subject, title: `renewal call with ${customer.name}`, owner: "ops", due: customer.renewal, status: "open", valid_from: AT, valid_to: null, provenance: prov(`crm event ${customer.event}`) };
  return { subject, event, derived, commitment };
}

async function listen(app) {
  await new Promise((r) => app.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${app.address().port}`;
}

/**
 * Run the farm. Returns the report (also written to `<outDir>/farm-report.json`).
 * @param {{ agents?: number, customers?: number, outDir?: string, org?: string }} opts
 */
export async function runFarm({ agents = 3, customers = 5, outDir, org: orgName = "acme" } = {}) {
  const started = Date.now();
  const out = outDir ?? mkdtempSync(join(tmpdir(), "hunch-agent-farm-"));
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, "farm-"));
  const file = join(work, "hunch-serve.json");
  const org = { kind: "organization", id: orgName };
  const tally = { writes: { created: 0, updated: 0, replayed: 0, superseded: 0 }, durability: {}, refusals: {}, reads: 0, retries: 0, reuse: 0, recompute: 0 };
  const problems = [];

  // 1–2. Partitions and principals: one organization drawer, one user drawer per sofia.
  const sofiaNames = Array.from({ length: agents }, (_, i) => `sofia-${i + 1}`);
  const userScope = (name) => ({ kind: "user", id: name });
  initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "orc", kind: "service", grants: [org] } });
  gitInit(join(work, "org"));
  const tokens = {};
  for (const name of sofiaNames) {
    tokens[name] = initServeConfig({ file, scope: userScope(name), root: join(work, name), principal: { id: name, kind: "agent", grants: [userScope(name), org] } }).token;
    gitInit(join(work, name));
  }
  // The engineer needs no partition of its own: re-declaring the org partition is idempotent and only adds the principal.
  tokens.engineer = initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "engineer", kind: "agent", grants: [org] } }).token;
  tokens.orc = initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "orc", kind: "service", grants: [org] } }).token;

  // 3. Serve in-process on loopback.
  const app = createServeApp(readServeConfig(file), { version: "agent-farm" });
  const baseUrl = await listen(app);
  const roster = Array.from({ length: customers }, (_, i) => ({ id: `c${i + 1}`, name: `Customer ${i + 1}`, event: 26900 + i, plan: i % 2 ? "pro" : "starter", renewal: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}` }));
  const expected = { commitments: new Map(), receipts: new Map() }; // subject -> Set(ids), event subject -> Set(ids)
  const remember = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  const agentDurations = [];
  const inForceSeen = new Map(); // subject -> Map(agent -> sorted commitment ids)

  try {
    // 4a. Morning: every sofia works the roster, rotated so they collide on the same customers at different times.
    const sofiaDay = async (name, index) => {
      const me = principalClient(name, baseUrl, tokens[name], tally);
      const t0 = Date.now();
      const mine = userScope(name);
      const rotated = roster.map((_, i) => roster[(i + index) % roster.length]);
      for (const customer of rotated) {
        const { subject, event, derived, commitment } = customerRecords(org, customer);
        // (a) read first; reuse a current summary whose id this agent can recompute, else compute and write it.
        const seen = await me.read(org, subject);
        const wantId = derivedId(derived);
        if (seen.state_of_record.current.some((ref) => ref.facet === "derived" && ref.id === wantId)) tally.reuse++;
        else { tally.recompute++; await me.write({ scope: org, facet: "derived", record: derived, idempotency_key: `${name}:derived:${subject}:${derived.transform_version}` }); }
        // (b) the shared commitment: identical payload + shared key, so the second writer replays the first.
        const c = await me.write({ scope: org, facet: "commitments", record: commitment, idempotency_key: `commitment:${subject}:${stateHash(commitment)}` });
        remember(expected.commitments, subject, c.record_id);
        // (c) a receipt for an executed action, verified against the CRM.
        const receipt = { schema: "nuryel.receipt/1", scope: org, actor: name, action_kind: "add_comment", target: event, request_fingerprint: stateHash({ subject, actor: name, comment: "renewal call scheduled" }), state: "verified", occurred_at: AT, verified_at: AT, invalidates: [`event:${customer.event}`], provenance: prov(`${name} comment on crm event ${customer.event}`) };
        const r = await me.write({ scope: org, facet: "receipts", record: receipt, idempotency_key: `${name}:receipt:${subject}` });
        remember(expected.receipts, `event:${customer.event}`, r.record_id);
        // A personal follow-up lands in the agent's own user drawer.
        await me.write({ scope: mine, facet: "commitments", record: { ...commitment, scope: mine, title: `prep notes for ${customer.name}`, owner: name }, idempotency_key: `${name}:prep:${subject}` });
        if (customer === rotated[0]) {
          // Deliberate refusals, once per agent, on the first customer.
          const other = sofiaNames[(index + 1) % sofiaNames.length];
          if (other !== name) await me.expectRefusal("read another sofia's drawer", 403, "outside-grants", () => me.client.read({ scope: userScope(other), subject }));
          await me.expectRefusal("reused key, changed payload", 409, "idempotency", () => me.client.write({ scope: org, facet: "receipts", record: { ...receipt, state: "failed" }, idempotency_key: `${name}:receipt:${subject}` }), "differs in:");
          await me.expectRefusal("chosen receipt id", 422, "identity", () => me.client.write({ scope: org, facet: "receipts", record: { ...receipt, id: "nrc_000000000000000000000000" }, idempotency_key: `${name}:receipt-chosen-id:${subject}` }));
        }
      }
      agentDurations.push(Date.now() - t0);
    };
    await Promise.all(sofiaNames.map(sofiaDay));

    // 4b. Afternoon: every sofia re-reads every customer; a current summary is reused, never recomputed.
    await Promise.all(sofiaNames.map(async (name) => {
      const me = principalClient(name, baseUrl, tokens[name], tally);
      for (const customer of roster) {
        const { subject, derived } = customerRecords(org, customer);
        const seen = await me.read(org, subject);
        if (seen.state_of_record.current.some((ref) => ref.facet === "derived" && ref.id === derivedId(derived))) tally.reuse++;
        else { tally.recompute++; await me.write({ scope: org, facet: "derived", record: derived, idempotency_key: `${name}:derived-pm:${subject}` }); }
        if (!inForceSeen.has(subject)) inForceSeen.set(subject, new Map());
        inForceSeen.get(subject).set(name, seen.state_of_record.in_force.filter((ref) => ref.facet === "commitments").map((ref) => ref.id).sort());
      }
    }));

    // 5. The orc audits the organization drawer: one current summary per subject, commitments and receipts as written.
    const orc = principalClient("orc", baseUrl, tokens.orc, tally);
    let contradictions = 0;
    for (const customer of roster) {
      const subject = `customer:${customer.id}`;
      const view = await orc.read(org, subject);
      const current = view.state_of_record.current.filter((ref) => ref.facet === "derived");
      if (current.length !== 1) { contradictions++; problems.push(`${subject}: ${current.length} current derived summaries`); }
      const inForce = new Set(view.state_of_record.in_force.filter((ref) => ref.facet === "commitments").map((ref) => ref.id));
      const want = expected.commitments.get(subject) ?? new Set();
      if (inForce.size !== want.size || [...want].some((id) => !inForce.has(id))) problems.push(`${subject}: in-force commitments ${[...inForce]} != written ${[...want]}`);
      const eventSubject = `event:${customer.event}`;
      const done = new Set((await orc.read(org, eventSubject)).state_of_record.done.map((ref) => ref.id));
      for (const id of expected.receipts.get(eventSubject) ?? []) if (!done.has(id)) problems.push(`${eventSubject}: receipt ${id} missing from done`);
      const views = [...(inForceSeen.get(subject) ?? new Map()).values()].map((ids) => ids.join(","));
      if (new Set(views).size > 1) { contradictions++; problems.push(`${subject}: agents with the same grants saw different in-force commitments: ${views.join(" | ")}`); }
    }

    // 6. The engineer replays the organization ledger from 0 and fetches every record it names.
    const engineer = principalClient("engineer", baseUrl, tokens.engineer, tally);
    const stream = await engineer.client.subscribe({ scope: org, after_seq: 0 });
    let contiguous = true;
    try { assertChangeSequence(stream.events, 0); } catch (e) { contiguous = false; problems.push(e.message); }
    if (stream.head_seq !== stream.events.length) { contiguous = false; problems.push(`head_seq ${stream.head_seq} != ${stream.events.length} events`); }
    const facetOf = new Map(stream.events.map((e) => [e.record_id, e.facet]));
    const ids = [...facetOf.keys()];
    let fetched = 0;
    for (let i = 0; i < ids.length; i += 256) {
      const page = await engineer.client.records({ scope: org, ids: ids.slice(i, i + 256) });
      for (const id of page.missing) problems.push(`ledger names ${id} but records() reports it missing`);
      for (const id of page.denied) problems.push(`ledger names ${id} but records() denies it to the engineer`);
      for (const [id, facet] of Object.entries(page.facets)) { fetched++; if (facet !== facetOf.get(id)) problems.push(`${id}: ledger says ${facetOf.get(id)}, records() says ${facet}`); }
    }
    if (fetched !== ids.length) problems.push(`fetched ${fetched} of ${ids.length} ledger records`);

    const total = Date.now() - started;
    const report = {
      agents: { sofia: agents, orc: 1, engineer: 1 }, customers,
      writes: tally.writes, durability: tally.durability, refusals: tally.refusals, reads: tally.reads, retries: tally.retries,
      reuse: tally.reuse, recompute: tally.recompute, reuse_rate: tally.reuse / Math.max(1, tally.reuse + tally.recompute),
      contradictions, ledger: { head_seq: stream.head_seq, events: stream.events.length, records_fetched: fetched, contiguous },
      durations_ms: { total, per_agent_avg: Math.round(agentDurations.reduce((a, b) => a + b, 0) / Math.max(1, agentDurations.length)) },
      problems, out: join(out, "farm-report.json"), work,
    };
    writeFileSync(report.out, JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await new Promise((r) => app.close(() => r()));
    app.closeStores();
  }
}

/** Plain-text table of a report, for stdout. */
export function formatReport(r) {
  const row = (k, v) => `${k.padEnd(22)} ${v}`;
  const refusals = Object.entries(r.refusals).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  return [
    "agent farm — hunch serve on loopback, temp dir only",
    row("agents", `${r.agents.sofia} sofia + 1 orc + 1 engineer`),
    row("customers", r.customers),
    row("writes", `created=${r.writes.created} updated=${r.writes.updated} replayed=${r.writes.replayed} superseded=${r.writes.superseded}`),
    row("durability", Object.entries(r.durability).map(([k, v]) => `${k}=${v}`).join(" ") || "none"),
    row("refusals", refusals),
    row("reads", r.reads),
    row("reuse", `${r.reuse} reused / ${r.recompute} recomputed (rate ${(r.reuse_rate * 100).toFixed(0)}%)`),
    row("contradictions", r.contradictions),
    row("ledger", `head_seq=${r.ledger.head_seq} contiguous=${r.ledger.contiguous} records_fetched=${r.ledger.records_fetched}`),
    row("duration", `${r.durations_ms.total} ms total, ${r.durations_ms.per_agent_avg} ms per sofia`),
    row("report", r.out),
    ...(r.problems.length ? ["problems:", ...r.problems.map((p) => `  - ${p}`)] : []),
  ].join("\n");
}
