/**
 * Agent farm — a demo + measurement harness for `hunch serve` as the deterministic state layer.
 *
 * K "sofia" agents (kind agent; own user drawer + the organization drawer), one "orc" service
 * (organization only) and one "engineer" agent (organization drawer + the served repository
 * partition) run a scripted day against an in-process `hunch serve` on 127.0.0.1:0 inside a temp
 * directory. Everything is counted: write outcomes, refusals by code, reads, reuse of another
 * agent's current summary, contradictions, ledger contiguity — and the CHAIN (roadmap Gate 4):
 * a sofia raises an incident and an escalation the engineer owes; the engineer reads it, records
 * the decision in the repository partition, seals a change proof, writes a `shipped` receipt into
 * the drawer that rests on the decision + proof + escalation, and closes the escalation BY that
 * receipt; every sofia then sees the closure, the orc verifies every link, and the engineer's
 * ledger replay finds the closure caused by the receipt. Runtime imports come from `dist/` only.
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
import { HunchStore } from "../../dist/store/hunchStore.js";
import { hunchPaths } from "../../dist/core/paths.js";
import { verifyReplay } from "../../dist/store/replay.js";

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
  // The chain's first link: an incident the customer reported, and the escalation the engineer owes.
  const incident = { schema: "nuryel.entity/1", id: `incident:crm-event-${customer.event}`, kind: "incident", name: `report export fails for ${customer.name}`, scope: org, refs: [event], attributes: { customer: subject, severity: "high" }, lifecycle: "active", provenance: prov(`crm event ${customer.event}`), created_at: AT, updated_at: AT };
  const escalation = { schema: "nuryel.commitment/1", scope: org, subject, title: `fix the report export for ${customer.name}`, owner: "engineering", due: "2026-09-12", status: "open", source: event, valid_from: AT, valid_to: null, provenance: prov(`crm event ${customer.event}`) };
  return { subject, event, derived, commitment, incident, escalation };
}

/** What the engineer records for one incident: the decision (repository partition) and a change
 *  proof pointer. The proof here is a deterministic stand-in for `hunch_change_proof` — the farm
 *  has no code diff to seal — but it is what the receipt rests on in production too: a
 *  credential-free pointer by proof id + content hash, never the proof body. */
function engineeringRecords(repo, customer) {
  const decision = { id: `dec_farm${String(customer.event)}`, title: `stream the report export for ${customer.name}`, topic: `incident.crm-event-${customer.event}`, status: "accepted", context: `incident:crm-event-${customer.event}: export times out`, decision: "Stream rows to the response instead of buffering the report.", consequences: ["exports no longer time out"], alternatives_rejected: ["raise the buffer limit"], rejected_tripwires: [], related_components: [], related_files: ["src/reports/export.ts"], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov(`incident:crm-event-${customer.event}`), date: AT };
  const proofId = `hproof_${createHash("sha256").update(`proof:${customer.event}`).digest("hex").slice(0, 24)}`;
  const proof = { kind: "external", ref: { system: "hunch", object_type: "change_proof", object_key: proofId, content_hash: sha256(`change-proof:${customer.event}`), observed_at: AT } };
  const pullRequest = { system: "github", object_type: "pull_request", object_key: `${repo.id}#${customer.event}`, version: "merged", observed_at: AT };
  return { decision, proof, pullRequest };
}

async function listen(app) {
  await new Promise((r) => app.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${app.address().port}`;
}

/**
 * Run the farm. Returns the report (also written to `<outDir>/farm-report.json`).
 * @param {{ agents?: number, customers?: number, outDir?: string, org?: string }} opts
 */
export async function runFarm({ agents = 3, customers = 5, outDir, org: orgName = "acme", incidents } = {}) {
  const started = Date.now();
  const out = outDir ?? mkdtempSync(join(tmpdir(), "hunch-agent-farm-"));
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, "farm-"));
  const file = join(work, "hunch-serve.json");
  const org = { kind: "organization", id: orgName };
  const repo = { kind: "repository", id: `${orgName}-app` };
  const tally = { writes: { created: 0, updated: 0, replayed: 0, superseded: 0 }, durability: {}, refusals: {}, reads: 0, retries: 0, reuse: 0, recompute: 0 };
  const chain = { incidents: 0, escalations_seen_by_engineer: 0, decisions: 0, shipped: 0, closed: 0, closures_seen_by_sofias: 0, links_verified_by_orc: 0, denied_to_orc: 0, closure_causes: 0 };
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
  // The engineer holds the organization drawer AND the application's repository partition: the
  // decision it records lives with the code, the receipt it writes lives with the customer.
  tokens.engineer = initServeConfig({ file, scope: repo, root: join(work, "app"), principal: { id: "engineer", kind: "agent", grants: [org, repo] } }).token;
  gitInit(join(work, "app"));
  tokens.orc = initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "orc", kind: "service", grants: [org] } }).token;

  // 3. Serve in-process on loopback.
  const app = createServeApp(readServeConfig(file), { version: "agent-farm" });
  const baseUrl = await listen(app);
  const roster = Array.from({ length: customers }, (_, i) => ({ id: `c${i + 1}`, name: `Customer ${i + 1}`, event: 26900 + i, plan: i % 2 ? "pro" : "starter", renewal: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}` }));
  // Every other customer raises an incident today (at least one); `incidents` caps how many.
  const incidentCount = Math.min(incidents ?? Math.ceil(customers / 2), customers);
  const withIncident = new Set(roster.filter((_, i) => i % 2 === 0).slice(0, incidentCount).map((c) => c.id));
  for (const c of roster) if (withIncident.size < incidentCount && !withIncident.has(c.id)) withIncident.add(c.id);
  chain.incidents = withIncident.size;
  const expected = { commitments: new Map(), receipts: new Map(), escalations: new Map(), closures: new Map() }; // subject -> Set(ids) / escalation & closure records per subject
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
        // (d) the chain's first link: the incident and the escalation engineering owes, under shared keys
        //     (every sofia that notices it replays the first writer's record — one incident, one debt).
        if (withIncident.has(customer.id)) {
          const { incident, escalation } = customerRecords(org, customer);
          await me.write({ scope: org, facet: "entities", record: incident, idempotency_key: `incident:${incident.id}` });
          const e = await me.write({ scope: org, facet: "commitments", record: escalation, idempotency_key: `escalation:${subject}:${stateHash(escalation)}` });
          expected.escalations.set(subject, { id: e.record_id, record_hash: e.record_hash });
        }
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

    // 4b. Midday, the chain: the engineer reads each incident's state (union read over the drawer
    //     and the repository), records the decision with the code, seals the proof, writes the
    //     `shipped` receipt into the drawer resting on all three, and closes the escalation BY it.
    const engineer = principalClient("engineer", baseUrl, tokens.engineer, tally);
    let provoked = false;
    for (const customer of roster) {
      if (!withIncident.has(customer.id)) continue;
      const { subject, escalation } = customerRecords(org, customer);
      const { decision, proof, pullRequest } = engineeringRecords(repo, customer);
      const before = await engineer.client.read({ scope: org, scopes: [org, repo], subject });
      tally.reads++;
      const owed = expected.escalations.get(subject);
      if (owed && before.state_of_record.in_force.some((ref) => ref.facet === "commitments" && ref.id === owed.id)) chain.escalations_seen_by_engineer++;
      else problems.push(`${subject}: the engineer did not find the escalation in force before acting`);
      if (before.denied_scopes.length) problems.push(`${subject}: union read named denied scopes for the engineer: ${before.denied_scopes.map((s) => `${s.kind}/${s.id}`).join(", ")}`);
      const d = await engineer.write({ scope: repo, facet: "decisions", record: decision, idempotency_key: `engineer:decision:${decision.id}` });
      chain.decisions++;
      const decisionRef = { kind: "record", id: d.record_id, record_hash: d.record_hash, scope: repo };
      const escalationRef = { kind: "record", id: owed.id, record_hash: owed.record_hash };
      const receipt = { schema: "nuryel.receipt/1", scope: org, actor: "engineer", action_kind: "shipped", target: pullRequest, request_fingerprint: stateHash({ pr: pullRequest.object_key }), state: "verified", occurred_at: AT, verified_at: AT, invalidates: [subject], rests_on: [decisionRef, proof, escalationRef], provenance: prov(`${pullRequest.object_key} merged; proof ${proof.ref.object_key}`) };
      if (!provoked) {
        // Deliberate refusals, once: a receipt resting on a stale escalation hash (the record moved),
        // and a closure naming a receipt that never happened.
        provoked = true;
        await engineer.expectRefusal("rests_on with a stale hash", 409, "conflict", () => engineer.client.write({ scope: org, facet: "receipts", record: { ...receipt, rests_on: [decisionRef, proof, { ...escalationRef, record_hash: sha256("stale") }] }, idempotency_key: `engineer:shipped-stale:${subject}` }), "re-read it and rest on what is current");
        await engineer.expectRefusal("closed_by a receipt that never happened", 409, "conflict", () => engineer.client.write({ scope: org, facet: "commitments", record: { ...escalation, status: "done", valid_to: AT, closed_by: "nrc_000000000000000000000000" }, idempotency_key: `engineer:close-phantom:${subject}` }), "write the receipt first");
      }
      const r = await engineer.write({ scope: org, facet: "receipts", record: receipt, idempotency_key: `engineer:shipped:${subject}` });
      chain.shipped++;
      const closed = await engineer.write({ scope: org, facet: "commitments", record: { ...escalation, status: "done", valid_to: AT, closed_by: r.record_id }, idempotency_key: `engineer:close:${subject}` });
      if (closed.outcome !== "updated" || closed.record_id !== owed.id) problems.push(`${subject}: closing the escalation gave ${closed.outcome} ${closed.record_id}, expected updated ${owed.id}`);
      else chain.closed++;
      expected.closures.set(subject, { receipt: r.record_id, commitment: owed.id, decision: d.record_id, proof: proof.ref.object_key });
    }

    // 4c. Afternoon: every sofia re-reads every customer; a current summary is reused, never recomputed.
    await Promise.all(sofiaNames.map(async (name) => {
      const me = principalClient(name, baseUrl, tokens[name], tally);
      for (const customer of roster) {
        const { subject, derived } = customerRecords(org, customer);
        const seen = await me.read(org, subject);
        if (seen.state_of_record.current.some((ref) => ref.facet === "derived" && ref.id === derivedId(derived))) tally.reuse++;
        else { tally.recompute++; await me.write({ scope: org, facet: "derived", record: derived, idempotency_key: `${name}:derived-pm:${subject}` }); }
        if (!inForceSeen.has(subject)) inForceSeen.set(subject, new Map());
        inForceSeen.get(subject).set(name, seen.state_of_record.in_force.filter((ref) => ref.facet === "commitments").map((ref) => ref.id).sort());
        // Sofia sees verified completion: the escalation has left in_force, the shipped receipt and the
        // closed escalation are in done, and the receipt invalidates her subject.
        const closure = expected.closures.get(subject);
        if (closure) {
          const done = new Set(seen.state_of_record.done.map((ref) => `${ref.facet}:${ref.id}`));
          const stillOwed = seen.state_of_record.in_force.some((ref) => ref.id === closure.commitment);
          const invalidated = seen.state_of_record.invalidated_by.includes(closure.receipt);
          if (!stillOwed && done.has(`receipts:${closure.receipt}`) && done.has(`commitments:${closure.commitment}`) && invalidated) chain.closures_seen_by_sofias++;
          else problems.push(`${subject}: ${name} did not see the closure (owed=${stillOwed} receipt=${done.has(`receipts:${closure.receipt}`)} commitment=${done.has(`commitments:${closure.commitment}`)} invalidated=${invalidated})`);
        }
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
      // The chain, link by link: what the closure rests on travels with the read; the decision is
      // named by id and repository partition; the orc, granted the drawer only, is refused the
      // repository partition itself (named, never described).
      const closure = expected.closures.get(subject);
      if (closure) {
        const deps = view.state_of_record.depends_on;
        const links = [
          deps.some((dep) => dep.kind === "record" && dep.id === closure.decision && dep.scope?.kind === "repository" && dep.scope.id === repo.id),
          deps.some((dep) => dep.kind === "external" && dep.ref.object_type === "change_proof" && dep.ref.object_key === closure.proof),
          deps.some((dep) => dep.kind === "record" && dep.id === closure.commitment),
          (view.records?.[closure.commitment] ?? {}).closed_by === closure.receipt,
          view.state_of_record.done.some((ref) => ref.id === closure.receipt),
        ];
        if (links.every(Boolean)) chain.links_verified_by_orc++;
        else { contradictions++; problems.push(`${subject}: chain links missing for the orc: decision=${links[0]} proof=${links[1]} escalation=${links[2]} closed_by=${links[3]} receipt_done=${links[4]}`); }
      }
    }
    if (chain.incidents) {
      await orc.expectRefusal("orc reads the repository partition", 403, "outside-grants", () => orc.client.records({ scope: repo, ids: [...expected.closures.values()].map((c) => c.decision) }));
      chain.denied_to_orc++;
    }

    // 6. The engineer replays the organization ledger from 0 and fetches every record it names.
    const stream = await engineer.client.subscribe({ scope: org, after_seq: 0 });
    for (const closure of expected.closures.values()) {
      const event = [...stream.events].reverse().find((e) => e.record_id === closure.commitment && e.change === "updated");
      if (event?.cause?.kind === "receipt" && event.cause.receipt_id === closure.receipt) chain.closure_causes++;
      else problems.push(`${closure.commitment}: the closure event is not caused by receipt ${closure.receipt}`);
    }
    if (expected.closures.size) {
      // The pointers resolve where they point: the decisions live in the repository partition.
      const ids = [...expected.closures.values()].map((c) => c.decision);
      const page = await engineer.client.records({ scope: repo, ids });
      for (const id of ids) if (page.facets[id] !== "decisions") problems.push(`${id}: not resolvable as a decision in ${repo.kind}/${repo.id}`);
    }
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

    // 7. Replay determinism: every partition's records are exactly what its ledger implies.
    const replay = { partitions: 0, ok: true, verified: 0, divergences: [] };
    for (const partition of readServeConfig(file).partitions) {
      const store = new HunchStore(hunchPaths(partition.root));
      try {
        const r = verifyReplay(store, partition.scope);
        replay.partitions++;
        replay.verified += r.records.verified + r.records.verified_by_idempotency;
        for (const d of r.divergences.filter((d) => d.kind !== "legacy-drift")) { replay.ok = false; replay.divergences.push(`${partition.scope.kind}/${partition.scope.id} ${d.kind} ${d.record_id}`); problems.push(`replay ${partition.scope.kind}/${partition.scope.id}: ${d.detail}`); }
        if (r.replay_hash !== r.stored_hash) { replay.ok = false; problems.push(`replay ${partition.scope.kind}/${partition.scope.id}: ledger fold ${r.replay_hash} != stored ${r.stored_hash}`); }
      } finally { store.close(); }
    }

    const total = Date.now() - started;
    const report = {
      agents: { sofia: agents, orc: 1, engineer: 1 }, customers,
      writes: tally.writes, durability: tally.durability, refusals: tally.refusals, reads: tally.reads, retries: tally.retries,
      reuse: tally.reuse, recompute: tally.recompute, reuse_rate: tally.reuse / Math.max(1, tally.reuse + tally.recompute),
      contradictions, chain, ledger: { head_seq: stream.head_seq, events: stream.events.length, records_fetched: fetched, contiguous }, replay,
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
    row("agents", `${r.agents.sofia} sofia + 1 orc + 1 engineer (drawer + repository)`),
    row("customers", r.customers),
    row("writes", `created=${r.writes.created} updated=${r.writes.updated} replayed=${r.writes.replayed} superseded=${r.writes.superseded}`),
    row("durability", Object.entries(r.durability).map(([k, v]) => `${k}=${v}`).join(" ") || "none"),
    row("refusals", refusals),
    row("reads", r.reads),
    row("reuse", `${r.reuse} reused / ${r.recompute} recomputed (rate ${(r.reuse_rate * 100).toFixed(0)}%)`),
    row("contradictions", r.contradictions),
    row("chain", `incidents=${r.chain.incidents} decisions=${r.chain.decisions} shipped=${r.chain.shipped} closed=${r.chain.closed} seen_by_sofias=${r.chain.closures_seen_by_sofias} links_verified=${r.chain.links_verified_by_orc} closure_causes=${r.chain.closure_causes} denied_to_orc=${r.chain.denied_to_orc}`),
    row("ledger", `head_seq=${r.ledger.head_seq} contiguous=${r.ledger.contiguous} records_fetched=${r.ledger.records_fetched}`),
    row("replay", `partitions=${r.replay.partitions} ok=${r.replay.ok} records_verified=${r.replay.verified}${r.replay.divergences.length ? ` divergences=${r.replay.divergences.join(",")}` : ""}`),
    row("duration", `${r.durations_ms.total} ms total, ${r.durations_ms.per_agent_avg} ms per sofia`),
    row("report", r.out),
    ...(r.problems.length ? ["problems:", ...r.problems.map((p) => `  - ${p}`)] : []),
  ].join("\n");
}
