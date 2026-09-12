/**
 * The season: a half-year emulation of one organization drawer under ten agents of different
 * styles, driven by a conductor that advances one simulated day at a time.
 *
 * Every write goes through the real `nuryel.state/1` HTTP binding of an in-process `hunch serve`
 * in a temp directory. Each persona has a routine and a declared set of refusals it EXPECTS; a
 * refusal outside that set, a success where a refusal was expected, a contradiction the auditor
 * finds, a divergent replay, or a broken invariant is a PROBLEM — the list a maintainer fixes.
 *
 * Cast (principal → kind → grants → style):
 *   sofia-careful   agent   own user + org   reads before writing; reuses current summaries
 *   sofia-hasty     agent   own user + org   writes summaries without reading; collides on purpose
 *   sofia-stale     agent   own user + org   rests on hashes it read weeks ago (409 expected)
 *   sofia-replayer  agent   own user + org   re-sends keys: identical → replayed; changed → 409
 *   observer        agent   own user + org   captures source-backed observations; reviews; pages
 *   merger          agent   own user + org   entity identity: duplicates (409), merge, split, 422s
 *   engineer        agent   org + repo       closes escalations through the chain, reads first
 *   engineer-sloppy agent   org + repo       phantom closures, stale rests_on (409 expected)
 *   david           human   org              confirms and corrects; agents may not overwrite him
 *   orc             service org              weekly audit; replay; refused the repository (403)
 *
 * Usage: node tooling/agent-farm/season.mjs [--days 180] [--customers 12] [--out DIR] [--seed S]
 * Imports from dist/ (run `npm run build` first). Loopback + temp dir only; nothing live.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServeApp } from "../../dist/serve/app.js";
import { initServeConfig, readServeConfig } from "../../dist/serve/config.js";
import { createStateClient, StateClientError } from "../../dist/client/state.js";
import { assertChangeSequence, derivedId, stateHash } from "../../dist/core/stateContract.js";
import { HunchStore } from "../../dist/store/hunchStore.js";
import { hunchPaths } from "../../dist/core/paths.js";
import { verifyReplay } from "../../dist/store/replay.js";
import { compactLedger } from "../../dist/store/changeLedger.js";

const sha256 = (s) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const prov = (evidence, source = "agent_recorded", confidence = 0.9) => ({ source, confidence, evidence: [evidence] });
const gitInit = (root) => { execFileSync("git", ["init", "-q", root], { stdio: "ignore" }); execFileSync("git", ["-C", root, "config", "user.email", "season@example.invalid"], { stdio: "ignore" }); execFileSync("git", ["-C", root, "config", "user.name", "season"], { stdio: "ignore" }); };
const listen = async (app) => { await new Promise((r) => app.listen(0, "127.0.0.1", () => r())); return `http://127.0.0.1:${app.address().port}`; };
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Deterministic PRNG so a season is reproducible from its seed. */
function rng(seed) { let x = 0; for (const ch of String(seed)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; }; }

export async function runSeason({ days = 180, customers = 12, outDir, seed = "season-1", org: orgName = "acme", start = "2026-03-02" } = {}) {
  const startedAt = Date.now();
  const random = rng(seed);
  const out = outDir ?? mkdtempSync(join(tmpdir(), "hunch-season-"));
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, "season-"));
  const file = join(work, "hunch-serve.json");
  const org = { kind: "organization", id: orgName };
  const repo = { kind: "repository", id: `${orgName}-app` };
  const userScope = (name) => ({ kind: "user", id: name });
  const problems = [];
  const problem = (s) => { problems.push(s); };
  let currentDay = "";
  const slow = [];
  const latency = {}; // verb -> ms[]
  const tally = { writes: { created: 0, updated: 0, replayed: 0, superseded: 0 }, refusals: { expected: {}, unexpected: {} }, reads: 0, captures: { saved: 0, replayed: 0, refused: 0 }, reviews: { done: 0, refused: 0 }, unexpected_successes: 0, expected_refusals_observed: 0 };
  const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

  // ---- partitions and principals ----
  const sofias = ["sofia-careful", "sofia-hasty", "sofia-stale", "sofia-replayer", "observer", "merger"];
  initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "orc", kind: "service", grants: [org] } }); gitInit(join(work, "org"));
  const tokens = { orc: readServeConfig(file).principals.find((p) => p.id === "orc") && null };
  for (const name of sofias) { tokens[name] = initServeConfig({ file, scope: userScope(name), root: join(work, name), principal: { id: name, kind: "agent", grants: [userScope(name), org] } }).token; gitInit(join(work, name)); }
  tokens.engineer = initServeConfig({ file, scope: repo, root: join(work, "app"), principal: { id: "engineer", kind: "agent", grants: [org, repo] } }).token; gitInit(join(work, "app"));
  tokens["engineer-sloppy"] = initServeConfig({ file, scope: repo, root: join(work, "app"), principal: { id: "engineer-sloppy", kind: "agent", grants: [org, repo] } }).token;
  tokens.david = initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "david", kind: "human", grants: [org] } }).token;
  tokens.orc = initServeConfig({ file, scope: org, root: join(work, "org"), principal: { id: "orc", kind: "service", grants: [org] } }).token;

  let app = createServeApp(readServeConfig(file), { version: "season" });
  let baseUrl = await listen(app);
  const clients = {};
  const bind = () => { for (const [name, token] of Object.entries(tokens)) clients[name] = createStateClient({ baseUrl, token }); };
  bind();

  /** One call with latency + outcome bookkeeping. `expect` names the refusal codes this persona expects here. */
  async function op(who, verb, fn, { expect = [], label = "", optional = false } = {}) {
    const t0 = Date.now();
    label = label || `${verb} on ${currentDay}`;
    try {
      const result = await fn(clients[who]);
      (latency[verb] ??= []).push(Date.now() - t0);
      if (Date.now() - t0 > 5000) slow.push({ who, label, ms: Date.now() - t0 });
      if (expect.length && !optional) { tally.unexpected_successes++; problem(`${who}: ${label || verb} succeeded but a ${expect.join("/")} refusal was expected`); }
      if (verb === "write" && result?.outcome) count(tally.writes, result.outcome);
      if (verb === "read") tally.reads++;
      return result;
    } catch (e) {
      (latency[verb] ??= []).push(Date.now() - t0);
      if (Date.now() - t0 > 5000) slow.push({ who, label, ms: Date.now() - t0, error: String(e.message).slice(0, 80) });
      if (!(e instanceof StateClientError)) { problem(`${who}: ${label || verb} threw ${e.message}`); return null; }
      if (e.status === 503) { await new Promise((r) => setTimeout(r, 25)); return op(who, verb, fn, { expect, label }); }
      if (expect.includes(e.code)) { count(tally.refusals.expected, e.code); tally.expected_refusals_observed++; return { refused: e.code, detail: e.problem?.detail }; }
      const merged = e.code === "identity" && /was merged into (customer:[a-z0-9]+)/.exec(e.problem?.detail || "");
      if (merged && verb === "write" && !label.startsWith("[redirected]")) { tally.merge_redirects = (tally.merge_redirects ?? 0) + 1; return { refused: "identity", merged_into: merged[1], detail: e.problem?.detail }; }
      count(tally.refusals.unexpected, e.code);
      problem(`${who}: ${label || verb} refused ${e.status} ${e.code}: ${(e.problem?.detail || e.message).slice(0, 160)}`);
      return null;
    }
  }

  // ---- the world ----
  const roster = Array.from({ length: customers }, (_, i) => ({ id: `c${i + 1}`, name: `Customer ${i + 1}`, event: 27000 + i, site: 100 + i }));
  const survivorOf = new Map(); // customer id -> survivor customer id after a merge
  const subjectOf = (c) => `customer:${survivorOf.get(c.id) ?? c.id}`;
  const eventRef = (c, day) => ({ system: "crm", object_type: "event", object_key: String(c.event), observed_at: `${day}T09:00:00Z`, content_hash: sha256(`crm-event-${c.event}-${day}`) });
  const summary = (c, day, transform = "summary/v1") => { const content = `${c.name}: state as of ${day} (event ${c.event}).`; return { schema: "nuryel.derived/1", scope: org, subject: subjectOf(c), content, content_hash: stateHash(content), dependencies: [{ kind: "external", ref: eventRef(c, day) }], transform_version: transform, computed_at: `${day}T09:00:00Z`, valid_to: null, state: "current", provenance: prov(`crm event ${c.event} ${day}`) }; };
  const commitmentFor = (c, day, owner = "ops") => ({ schema: "nuryel.commitment/1", scope: org, subject: subjectOf(c), title: `follow up with ${c.name}`, owner, due: day, status: "open", valid_from: `${day}T09:00:00Z`, valid_to: null, provenance: prov(`crm event ${c.event} ${day}`) });
  const receiptFor = (who, c, day) => ({ schema: "nuryel.receipt/1", scope: org, actor: who, action_kind: "add_comment", target: eventRef(c, day), request_fingerprint: stateHash({ subject: subjectOf(c), actor: who, day }), state: "verified", occurred_at: `${day}T10:00:00Z`, verified_at: `${day}T10:00:05Z`, invalidates: [subjectOf(c)], provenance: prov(`${who} comment on crm event ${c.event} ${day}`) });
  const dayList = []; { const d0 = new Date(`${start}T00:00:00Z`); for (let i = 0; i < days; i++) { const d = new Date(d0.getTime() + i * 86400000); dayList.push(d.toISOString().slice(0, 10)); } }
  const activeToday = (i) => roster.filter((_, k) => (k + i) % Math.max(1, Math.ceil(roster.length / 3)) === 0);

  // ---- persona memories ----
  const staleHashes = new Map(); // subject -> {id, record_hash} as sofia-stale saw it on its first day
  const replayerKeys = []; // {key, record, facet} from the previous day
  const openEscalations = []; // {subject, id, record_hash, record, incident, raisedDay, closeOn}
  const closed = []; // {subject, receipt, commitment, decision, proof}
  const lastDecisionByTopic = new Map(); // topic -> decision id the engineer must supersede on the next revision
  const humanConfirmed = new Set(); // subjects david confirmed
  const observerSubject = subjectOf(roster[0]);
  let observerCaptured = 0;
  let mergerState = { merged: null, split: false };
  const crowding = { beside_human_confirmed: 0, forged_downgraded: 0, max_current_per_subject: 0, subjects_with_many_current: 0 };
  const chain = { incidents: 0, escalations_seen_by_engineer: 0, decisions: 0, shipped: 0, closed: 0, closures_seen: 0, links_verified: 0, phantom_refused: 0, stale_rests_on_refused: 0 };
  const audits = [];
  const restarts = [];
  const compactions = [];

  try {
    for (let i = 0; i < dayList.length; i++) {
      const day = dayList[i];
      currentDay = day;
      const week = Math.floor(i / 7);
      const active = activeToday(i);

      // sofia-careful: read → reuse or write; shared commitment; receipt; personal note.
      for (const c of active) {
        const s = summary(c, day);
        const seen = await op("sofia-careful", "read", (cl) => cl.read({ scope: org, subject: subjectOf(c) }));
        const cur = seen?.state_of_record?.current?.find((r) => r.facet === "derived");
        if (!humanConfirmed.has(subjectOf(c))) {
          const mine = seen?.state_of_record?.current?.find((r) => r.facet === "derived" && r.id === derivedId(s));
          if (!mine) {
            const incumbent = seen?.state_of_record?.current?.find((r) => r.facet === "derived" && (seen.records?.[r.id]?.transform_version ?? "summary/v1") === s.transform_version);
            await op("sofia-careful", "write", (cl) => cl.write({ scope: org, facet: "derived", record: s, idempotency_key: `careful:derived:${c.id}:${day}`, ...(incumbent ? { supersedes: incumbent.id } : {}) }));
          } else tally.reuse = (tally.reuse ?? 0) + 1;
        }
        const cm = commitmentFor(c, day);
        const w = await op("sofia-careful", "write", (cl) => cl.write({ scope: org, facet: "commitments", record: cm, idempotency_key: `commitment:${c.id}:${stateHash(cm)}` }));
        const r = receiptFor("sofia-careful", c, day);
        await op("sofia-careful", "write", (cl) => cl.write({ scope: org, facet: "receipts", record: r, idempotency_key: `careful:receipt:${c.id}:${day}` }));
        if (w?.record_id) replayerKeys.push({ key: `commitment:${c.id}:${stateHash(cm)}`, record: cm, facet: "commitments", id: w.record_id });
        // Every 5th day the careful sofia raises an incident + the escalation engineering owes.
        if (i % 5 === 0 && c === active[0]) {
          const incident = { schema: "nuryel.entity/1", id: `incident:crm-event-${c.event}`, kind: "incident", name: `export fails for ${c.name} (${day})`, scope: org, refs: [eventRef(c, day)], attributes: { customer: subjectOf(c), severity: "high" }, lifecycle: "active", provenance: prov(`crm event ${c.event} ${day}`), created_at: `${day}T09:30:00Z`, updated_at: `${day}T09:30:00Z` };
          const escalation = { ...commitmentFor(c, day, "engineering"), title: `fix the export for ${c.name} (${day})`, source: eventRef(c, day) };
          const raise = await op("sofia-careful", "write", (cl) => cl.write({ scope: org, facet: "entities", record: incident, idempotency_key: `incident:${incident.id}:${day}` }));
          if (raise && !["created", "replayed", "updated"].includes(raise.outcome)) problem(`incident ${incident.id} on ${day}: ${raise.outcome}`);
          const e = await op("sofia-careful", "write", (cl) => cl.write({ scope: org, facet: "commitments", record: escalation, idempotency_key: `escalation:${incident.id}:${day}` }));
          if (e?.record_id) { chain.incidents++; openEscalations.push({ subject: subjectOf(c), id: e.record_id, record_hash: e.record_hash, record: escalation, incident, raisedDay: day, closeOn: Math.min(dayList.length - 1, i + 1 + Math.floor(random() * 3)) }); }
        }
      }

      // sofia-hasty: writes a summary WITHOUT reading. Same identity → replayed/updated; a human-confirmed
      // subject → 409; a different transform on a subject with a current summary → superseded/409 by design.
      for (const c of active) {
        const s = summary(c, day, i % 2 ? "summary/v1" : "summary/v2");
        // Since one-current-derived-per-subject-transform: a new statement beside a current one of the
        // same transform is refused unless it names it; hasty's very first statement per transform lands.
        const w = await op("sofia-hasty", "write", (cl) => cl.write({ scope: org, facet: "derived", record: s, idempotency_key: `hasty:derived:${c.id}:${day}:${s.transform_version}` }), { expect: ["conflict"], optional: true, label: `hasty summary ${c.id} ${day}` });
        if (w?.refused === "conflict") crowding.refused_without_supersedes = (crowding.refused_without_supersedes ?? 0) + 1;
        if (w?.outcome === "created" && humanConfirmed.has(subjectOf(c))) crowding.beside_human_confirmed++;
      }

      // sofia-stale: remembers what it saw on its first day and keeps resting on it.
      for (const c of active) {
        const subj = subjectOf(c);
        const seen = await op("sofia-stale", "read", (cl) => cl.read({ scope: org, subject: subj }));
        const inForce = seen?.state_of_record?.in_force?.find((r) => r.facet === "commitments");
        if (inForce && !staleHashes.has(subj)) staleHashes.set(subj, { id: inForce.id, record_hash: inForce.record_hash, day });
        const remembered = staleHashes.get(subj);
        if (remembered && remembered.day !== day && i - dayList.indexOf(remembered.day) >= 14) {
          // A receipt resting on a hash from two weeks ago: refused iff the record moved since.
          const current = seen?.state_of_record?.in_force?.find((r) => r.id === remembered.id) ?? seen?.state_of_record?.done?.find((r) => r.id === remembered.id);
          const moved = !current || current.record_hash !== remembered.record_hash;
          const receipt = { ...receiptFor("sofia-stale", c, day), rests_on: [{ kind: "record", id: remembered.id, record_hash: remembered.record_hash }] };
          const res = await op("sofia-stale", "write", (cl) => cl.write({ scope: org, facet: "receipts", record: receipt, idempotency_key: `stale:receipt:${c.id}:${day}` }), { expect: moved ? ["conflict"] : [], label: `stale rests_on ${c.id} ${day} (moved=${moved})` });
          if (res?.refused) chain.stale_rests_on_refused++;
        }
      }

      // sofia-replayer: yesterday's keys again — identical payload replays, a changed payload is refused, a chosen id is refused.
      if (replayerKeys.length) {
        const k = replayerKeys[Math.floor(random() * replayerKeys.length)];
        const same = await op("sofia-replayer", "write", (cl) => cl.write({ scope: org, facet: k.facet, record: k.record, idempotency_key: k.key }));
        if (same && same.outcome !== "replayed" && same.record_id !== k.id) problem(`sofia-replayer: identical payload under ${k.key} gave ${same.outcome} ${same.record_id}, expected replayed ${k.id}`);
        await op("sofia-replayer", "write", (cl) => cl.write({ scope: org, facet: k.facet, record: { ...k.record, title: k.record.title + " (changed)" }, idempotency_key: k.key }), { expect: ["idempotency"], label: "reused key, changed payload" });
        if (i % 9 === 0) await op("sofia-replayer", "write", (cl) => cl.write({ scope: org, facet: "receipts", record: { ...receiptFor("sofia-replayer", roster[0], day), id: "nrc_000000000000000000000000" }, idempotency_key: `replayer:chosen-id:${day}` }), { expect: ["identity"], label: "chosen receipt id" });
        if (i % 11 === 0) await op("sofia-replayer", "read", (cl) => cl.read({ scope: userScope("sofia-careful"), subject: subjectOf(roster[0]) }), { expect: ["outside-grants"], label: "another sofia's drawer" });
      }

      // observer: captures two source-backed observations a day on one subject; a replay every other day;
      // a review (stale under contradiction) weekly; a paged read monthly.
      {
        const srcText = `Office hours on ${day}: opens Friday. Contact: ops@example.invalid. Note ${i}.`;
        const src = { ref: { ...eventRef(roster[0], day), content_hash: stateHash(srcText) }, source_text: srcText };
        const observations = [
          { subject: observerSubject, statement: `On ${day} the office opens Friday.`, relevance: { use: "operational_fact", reason: "scheduling follow-ups" }, evidence: [{ source: 0, excerpt: "opens Friday" }] },
          { subject: observerSubject, statement: `Contact address on ${day} is ops@example.invalid.`, relevance: { use: "operational_fact", reason: "routing mail" }, evidence: [{ source: 0, excerpt: "ops@example.invalid" }] },
        ];
        const res = await op("observer", "capture", (cl) => cl.captureBatch({ scope: org, sources: [src], observations }));
        for (const item of res?.results ?? []) { const oc = item.result?.outcome; if (item.status === "saved" && oc === "created") { tally.captures.saved++; observerCaptured++; } else if (item.status === "saved" && oc === "replayed") tally.captures.replayed++; else { tally.captures.refused++; problem(`observer: capture refused on ${day}: ${JSON.stringify(item).slice(0, 160)}`); } }
        if (i % 2 === 1) { const again = await op("observer", "capture", (cl) => cl.captureBatch({ scope: org, sources: [src], observations })); for (const item of again?.results ?? []) { if (item.status === "saved" && item.result?.outcome === "replayed") tally.captures.replayed++; else problem(`observer: re-sent batch on ${day} gave ${item.status}/${item.result?.outcome}, expected replayed`); } }
        if (i % 7 === 6 && res?.results?.[0]?.result?.record_id) {
          const target = res.results[0].result;
          const contraText = `Correction on ${day}: the office is closed Friday.`;
          const contra = { ref: { ...eventRef(roster[0], day), content_hash: stateHash(contraText) }, source_text: contraText };
          const rv = await op("observer", "capture", (cl) => cl.captureBatch({ scope: org, sources: [contra], observations: [], reviews: [{ record_id: target.record_id, expected_hash: target.record_hash, reason: "the source explicitly replaces Friday opening with Friday closure", evidence: [{ source: 0, excerpt: "closed Friday" }] }] }));
          for (const item of rv?.reviews ?? []) { if (item.status === "saved" || item.status === "reviewed") tally.reviews.done++; else { tally.reviews.refused++; problem(`observer: review refused on ${day}: ${JSON.stringify(item).slice(0, 160)}`); } }
        }
        if (i % 28 === 27) {
          let cursor, total = 0, pages = 0, seenIds = new Set();
          for (let p = 0; p < 50; p++) {
            const page = await op("observer", "read", (cl) => cl.read({ scope: org, subject: observerSubject, facets: ["derived"], observed_page: cursor ? { cursor } : {} }));
            if (!page) break;
            pages++;
            for (const o of page.state_of_record?.observed ?? []) { if (seenIds.has(o.id)) problem(`observer: observation ${o.id} repeated across pages on ${day}`); seenIds.add(o.id); }
            total = page.state_of_record?.observed_page?.total ?? total;
            cursor = page.state_of_record?.observed_page?.next_cursor;
            if (!cursor) break;
          }
          if (seenIds.size !== total) problem(`observer: paged walk on ${day} saw ${seenIds.size} observations, page total says ${total}`);
          audits.push({ day, kind: "observation-pages", pages, total, walked: seenIds.size });
        }
      }

      // merger: entities keyed by external refs; a duplicate active entity is refused; a subject written as an
      // entity's key is refused with the entity named; a merge retires one into the other; a split reverses it.
      if (i === 0) {
        for (const c of roster) {
          const entity = { schema: "nuryel.entity/1", id: `customer:${c.id}`, kind: "customer", name: c.name, scope: org, refs: [{ system: "crm", object_type: "site", object_key: String(c.site), observed_at: `${day}T08:00:00Z` }], attributes: {}, lifecycle: "active", provenance: prov(`crm site ${c.site}`), created_at: `${day}T08:00:00Z`, updated_at: `${day}T08:00:00Z` };
          await op("merger", "write", (cl) => cl.write({ scope: org, facet: "entities", record: entity, idempotency_key: `merger:entity:${c.id}` }));
        }
      }
      if (i % 15 === 3) {
        const c = roster[1];
        const dup = { schema: "nuryel.entity/1", id: `customer:${c.id}-dup-${day}`, kind: "customer", name: `${c.name} (dup)`, scope: org, refs: [{ system: "crm", object_type: "site", object_key: String(c.site), observed_at: `${day}T08:00:00Z` }], attributes: {}, lifecycle: "active", provenance: prov(`crm site ${c.site} dup`), created_at: `${day}T08:00:00Z`, updated_at: `${day}T08:00:00Z` };
        await op("merger", "write", (cl) => cl.write({ scope: org, facet: "entities", record: dup, idempotency_key: `merger:dup:${c.id}:${day}` }), { expect: ["conflict"], label: `duplicate external ref for ${c.id}` });
        await op("merger", "write", (cl) => cl.write({ scope: org, facet: "commitments", record: { ...commitmentFor(c, day), subject: `site:${c.site}` }, idempotency_key: `merger:subject-as-key:${c.id}:${day}` }), { expect: ["identity"], label: `subject written as ${c.id}'s external key` });
      }
      if (i === 40) {
        // Merge customer c3 into c2 (one clinic under two sites), then check reads resolve c3 to c2.
        const gone = roster[2], survivor = roster[1];
        const retired = { schema: "nuryel.entity/1", id: `customer:${gone.id}`, kind: "customer", name: gone.name, scope: org, refs: [{ system: "crm", object_type: "site", object_key: String(gone.site), observed_at: `${day}T08:00:00Z` }], attributes: {}, lifecycle: "retired", merged_into: `customer:${survivor.id}`, provenance: prov(`merged into ${survivor.id} on ${day}`), created_at: `${dayList[0]}T08:00:00Z`, updated_at: `${day}T08:00:00Z` };
        const m = await op("merger", "write", (cl) => cl.write({ scope: org, facet: "entities", record: retired, idempotency_key: `merger:merge:${gone.id}:${day}` }));
        if (m) { mergerState.merged = { gone: gone.id, survivor: survivor.id, day }; survivorOf.set(gone.id, survivor.id); }
        const view = await op("merger", "read", (cl) => cl.read({ scope: org, subject: `customer:${gone.id}` }));
        const resolved = view?.state_of_record?.subject === `customer:${survivor.id}` || (view?.subject_aliases ?? view?.state_of_record?.aliases ?? []).some((a) => String(a).includes(survivor.id)) || JSON.stringify(view?.state_of_record ?? {}).includes(`customer:${survivor.id}`);
        if (!resolved) problem(`merger: after the merge, reading customer:${gone.id} did not resolve to customer:${survivor.id}`);
        await op("merger", "write", (cl) => cl.write({ scope: org, facet: "commitments", record: { ...commitmentFor(gone, day), subject: `customer:${gone.id}` }, idempotency_key: `merger:under-retired:${gone.id}:${day}` }), { expect: ["identity"], label: "[redirected] new state under a retired id" });
      }

      // engineers: close what is due; the sloppy one tries phantoms and stale hashes first.
      for (const esc of openEscalations.filter((e) => e.closeOn === i)) {
        const before = await op("engineer", "read", (cl) => cl.read({ scope: org, scopes: [org, repo], subject: esc.subject }));
        const owed = before?.state_of_record?.in_force?.find((r) => r.id === esc.id);
        if (owed) chain.escalations_seen_by_engineer++; else { problem(`engineer: escalation ${esc.id} not in force on ${day}`); continue; }
        const decision = { id: `dec_season_${esc.incident.id.replace(/[^a-z0-9]/g, "_")}_${esc.raisedDay.replace(/-/g, "")}`, title: `fix the export (${esc.raisedDay})`, topic: `incident.${esc.incident.id}`, status: "accepted", context: `${esc.incident.id}: export times out`, decision: "Stream rows instead of buffering.", consequences: [], alternatives_rejected: ["raise the buffer"], rejected_tripwires: [], related_components: [], related_files: ["src/reports/export.ts"], supersedes: null, superseded_by: null, caused_by_bug: null, commit: null, valid_to: null, retired: { symbols: [], deps: [] }, provenance: prov(esc.incident.id), date: `${day}T11:00:00Z` };
        const prevDecision = lastDecisionByTopic.get(decision.topic);
        const d = await op("engineer", "write", (cl) => cl.write({ scope: repo, facet: "decisions", record: decision, idempotency_key: `engineer:decision:${decision.id}`, ...(prevDecision ? { supersedes: prevDecision } : {}) }));
        if (d?.record_id) lastDecisionByTopic.set(decision.topic, d.record_id);
        if (!d) continue;
        chain.decisions++;
        const proof = { kind: "external", ref: { system: "hunch", object_type: "change_proof", object_key: `hproof_${createHash("sha256").update(esc.incident.id).digest("hex").slice(0, 24)}`, content_hash: sha256(`proof:${esc.incident.id}`), observed_at: `${day}T11:30:00Z` } };
        const pr = { system: "github", object_type: "pull_request", object_key: `${repo.id}#${esc.incident.id.slice(-10)}`, version: "merged", observed_at: `${day}T11:30:00Z` };
        const receipt = { schema: "nuryel.receipt/1", scope: org, actor: "engineer", action_kind: "shipped", target: pr, request_fingerprint: stateHash({ pr: pr.object_key }), state: "verified", occurred_at: `${day}T11:30:00Z`, verified_at: `${day}T11:31:00Z`, invalidates: [esc.subject], rests_on: [{ kind: "record", id: d.record_id, record_hash: d.record_hash, scope: repo }, proof, { kind: "record", id: owed.id, record_hash: owed.record_hash }], provenance: prov(`${pr.object_key} merged`) };
        // engineer-sloppy first: a phantom closure and a stale rests_on.
        const ph = await op("engineer-sloppy", "write", (cl) => cl.write({ scope: org, facet: "commitments", record: { ...esc.record, status: "done", valid_to: `${day}T11:00:00Z`, closed_by: "nrc_000000000000000000000000" }, idempotency_key: `sloppy:phantom:${esc.id}` }), { expect: ["conflict"], label: "closed_by a receipt that never happened" });
        if (ph?.refused) chain.phantom_refused++;
        const st = await op("engineer-sloppy", "write", (cl) => cl.write({ scope: org, facet: "receipts", record: { ...receipt, actor: "engineer-sloppy", rests_on: [receipt.rests_on[0], proof, { kind: "record", id: owed.id, record_hash: sha256("stale") }] }, idempotency_key: `sloppy:stale:${esc.id}` }), { expect: ["conflict"], label: "rests_on a stale hash" });
        if (st?.refused) chain.stale_rests_on_refused++;
        const r = await op("engineer", "write", (cl) => cl.write({ scope: org, facet: "receipts", record: receipt, idempotency_key: `engineer:shipped:${esc.id}` }));
        if (!r) continue;
        chain.shipped++;
        const cl = await op("engineer", "write", (cl) => cl.write({ scope: org, facet: "commitments", record: { ...esc.record, status: "done", valid_to: `${day}T12:00:00Z`, closed_by: r.record_id }, idempotency_key: `engineer:close:${esc.id}` }));
        if (cl?.outcome === "updated" && cl.record_id === esc.id) { chain.closed++; closed.push({ subject: esc.subject, receipt: r.record_id, commitment: esc.id, decision: d.record_id, proof: proof.ref.object_key, day }); }
        else problem(`engineer: closing ${esc.id} gave ${cl?.outcome} ${cl?.record_id}`);
      }
      for (let k = openEscalations.length - 1; k >= 0; k--) if (openEscalations[k].closeOn === i) openEscalations.splice(k, 1);

      // david (human): every 10th day confirms a customer's summary by writing it human-confirmed;
      // from then on an agent's different summary for that subject is refused.
      if (i % 10 === 9) {
        const c = active[0];
        const s = summary(c, day); s.provenance = prov(`david confirmed ${day}`, "human_confirmed", 1);
        // A human reads first too: his confirmation names the current statement it replaces.
        const held = await op("david", "read", (cl) => cl.read({ scope: org, subject: subjectOf(c) }));
        const inc = held?.state_of_record?.current?.find((r) => r.facet === "derived" && r.id !== derivedId(s) && (held.records?.[r.id]?.transform_version ?? "summary/v1") === s.transform_version);
        const w = await op("david", "write", (cl) => cl.write({ scope: org, facet: "derived", record: s, idempotency_key: `david:confirm:${c.id}:${day}`, ...(inc ? { supersedes: inc.id } : {}) }));
        if (w) humanConfirmed.add(subjectOf(c));
        // An agent claiming human_confirmed is downgraded, never trusted: it must not overwrite david.
        const s2 = summary(c, day, "summary/v3"); s2.provenance = prov("forged", "human_confirmed", 1);
        const forged = await op("sofia-hasty", "write", (cl) => cl.write({ scope: org, facet: "derived", record: s2, idempotency_key: `hasty:forge:${c.id}:${day}` }), { expect: ["conflict"], optional: true, label: `forged provenance ${c.id} ${day}` });
        if (forged?.record_id) {
          const page = await op("orc", "records", (cl) => cl.records({ scope: org, ids: [forged.record_id] }));
          const src = page?.records?.[forged.record_id]?.provenance?.source ?? "";
          if (src.split("+").includes("human_confirmed")) problem(`david day ${day}: an agent's forged human_confirmed provenance was stored as-is on ${forged.record_id}`); else crowding.forged_downgraded++;
          // Overwriting david's own record in place must still be refused.
          await op("sofia-hasty", "write", (cl) => cl.write({ scope: org, facet: "derived", record: { ...s, content: s.content + " (agent edit)", content_hash: stateHash(s.content + " (agent edit)"), provenance: prov("agent edit") }, idempotency_key: `hasty:overwrite:${c.id}:${day}` }), { expect: ["conflict"], label: "agent overwrites a human-confirmed summary in place" });
        }
      }

      // weekly audit by the orc: one current summary per subject; closures seen; chain links; consistent in-force views.
      if (i % 7 === 6) {
        let contradictions = 0;
        for (const c of roster) {
          const subj = subjectOf(c);
          const view = await op("orc", "read", (cl) => cl.read({ scope: org, subject: subj }));
          if (!view) continue;
          const current = view.state_of_record.current.filter((r) => r.facet === "derived");
          crowding.max_current_per_subject = Math.max(crowding.max_current_per_subject, current.length);
          if (current.length > 1) { contradictions++; crowding.subjects_with_many_current++; }
          const a = await op("sofia-careful", "read", (cl) => cl.read({ scope: org, subject: subj }));
          const b = await op("sofia-hasty", "read", (cl) => cl.read({ scope: org, subject: subj }));
          const ia = a?.state_of_record?.in_force?.map((r) => r.id).sort().join(","), ib = b?.state_of_record?.in_force?.map((r) => r.id).sort().join(",");
          if (ia !== undefined && ib !== undefined && ia !== ib) { contradictions++; problem(`orc week ${week}: ${subj} in-force differs between careful and hasty`); }
        }
        for (const cz of closed.filter((x) => dayList.indexOf(x.day) > i - 7)) {
          const view = await op("orc", "read", (cl) => cl.read({ scope: org, subject: cz.subject }));
          const sor = view?.state_of_record; if (!sor) continue;
          const links = [sor.in_force.every((r) => r.id !== cz.commitment), sor.done.some((r) => r.id === cz.receipt), sor.done.some((r) => r.id === cz.commitment), (view.records?.[cz.commitment] ?? {}).closed_by === cz.receipt, (sor.depends_on ?? []).some((d) => d.kind === "record" && d.id === cz.decision), (sor.depends_on ?? []).some((d) => d.kind === "external" && d.ref?.object_key === cz.proof)];
          if (links.every(Boolean)) { chain.links_verified++; chain.closures_seen++; } else problem(`orc week ${week}: closure ${cz.commitment} links ${links.map(Number).join("")}`);
        }
        await op("orc", "records", (cl) => cl.records({ scope: repo, ids: closed.slice(-1).map((x) => x.decision) }), { expect: closed.length ? ["outside-grants"] : [], label: "orc reads the repository partition" });
        audits.push({ day, kind: "weekly", contradictions, max_current_per_subject: crowding.max_current_per_subject });
      }

      // monthly: compact the org ledger, then restart the server; subscribers below the floor must resync.
      if (i % 30 === 29) {
        const stream = await op("engineer", "subscribe", (cl) => cl.subscribe({ scope: org, after_seq: 0 }));
        const before = stream?.head_seq ?? 0;
        const store = new HunchStore(hunchPaths(join(work, "org")));
        let res; try { res = compactLedger(hunchPaths(join(work, "org")).hunchDir ?? join(work, "org", ".hunch"), org, { keep: 200 }); } catch (e) { problem(`compact on ${day}: ${e.message}`); } finally { store.close(); }
        compactions.push({ day, head_before: before, ...(res ?? {}) });
        await new Promise((r) => app.close(() => r())); app.closeStores();
        app = createServeApp(readServeConfig(file), { version: "season" }); baseUrl = await listen(app); bind();
        restarts.push(day);
        const old = await op("engineer", "subscribe", (cl) => cl.subscribe({ scope: org, after_seq: 0 }));
        if (res?.dropped > 0 && !(old?.resync || old?.floor_seq > 0 || (old?.events?.length ?? 0) < before)) problem(`subscribe after compaction on ${day} did not signal a resync (floor ${res?.floor_seq})`);
        const head = await op("engineer", "subscribe", (cl) => cl.subscribe({ scope: org, after_seq: res?.floor_seq ?? 0 }));
        if (head && head.events?.length) { try { assertChangeSequence(head.events, res?.floor_seq ?? 0); } catch (e) { problem(`ledger after compaction on ${day}: ${e.message}`); } }
      }
    }

    // ---- season end: replay every partition; fetch every ledger record; latency ----
    const replay = { partitions: 0, ok: true, verified: 0, divergences: [] };
    for (const partition of readServeConfig(file).partitions) {
      const store = new HunchStore(hunchPaths(partition.root));
      try { const r = verifyReplay(store, partition.scope); replay.partitions++; replay.verified += r.records.verified + r.records.verified_by_idempotency; for (const d of r.divergences.filter((d) => d.kind !== "legacy-drift")) { replay.ok = false; replay.divergences.push(`${partition.scope.kind}/${partition.scope.id} ${d.kind} ${d.record_id}`); problem(`replay ${partition.scope.kind}/${partition.scope.id}: ${d.kind} ${d.record_id}`); } if (r.replay_hash !== r.stored_hash) { replay.ok = false; problem(`replay ${partition.scope.kind}/${partition.scope.id}: fold != stored`); } }
      catch (e) { problem(`replay ${partition.scope.kind}/${partition.scope.id}: ${e.message}`); }
      finally { store.close(); }
    }
    const lat = Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, { n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), max: Math.max(...v) }]));
    const report = { season: { days, customers, seed, start, end: dayList.at(-1) }, cast: Object.keys(tokens), writes: tally.writes, reads: tally.reads, captures: tally.captures, reviews: tally.reviews, refusals: tally.refusals, expected_refusals_observed: tally.expected_refusals_observed, unexpected_successes: tally.unexpected_successes, chain, crowding, merge_redirects: tally.merge_redirects ?? 0, slow_ops: slow, merger: mergerState, human_confirmed_subjects: [...humanConfirmed], observations_captured: observerCaptured, audits, compactions, restarts, replay, latency_ms: lat, durations_ms: { total: Date.now() - startedAt }, problems, out: join(out, "season-report.json"), work };
    writeFileSync(report.out, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(out, "season-report.md"), formatSeason(report));
    return report;
  } finally {
    await new Promise((r) => app.close(() => r())); app.closeStores();
  }
}

export function formatSeason(r) {
  const lines = [`# Season report — ${r.season.days} days, ${r.season.customers} customers, ${r.cast.length} principals (seed ${r.season.seed})`, "",
    `writes: ${JSON.stringify(r.writes)}  reads: ${r.reads}  captures: ${JSON.stringify(r.captures)}  reviews: ${JSON.stringify(r.reviews)}`,
    `refusals expected: ${JSON.stringify(r.refusals.expected)}  unexpected: ${JSON.stringify(r.refusals.unexpected)}  unexpected successes: ${r.unexpected_successes}`,
    `chain: ${JSON.stringify(r.chain)}`, `crowding (current summaries per subject when a writer omits supersedes): ${JSON.stringify(r.crowding)}`, `human-confirmed subjects: ${r.human_confirmed_subjects.length}  observations captured: ${r.observations_captured}  merge: ${JSON.stringify(r.merger)}`,
    `compactions: ${r.compactions.length}  restarts: ${r.restarts.length}  replay: ${r.replay.ok ? "OK" : "DIVERGED"} (${r.replay.partitions} partitions, ${r.replay.verified} records)`,
    `latency ms: ${Object.entries(r.latency_ms).map(([k, v]) => `${k} n=${v.n} p50=${v.p50} p95=${v.p95} max=${v.max}`).join(" | ")}`,
    `wall clock: ${Math.round(r.durations_ms.total / 1000)} s  slow ops (>5 s): ${JSON.stringify(r.slow_ops)}`, "", `## Problems (${r.problems.length})`, ...(r.problems.length ? r.problems.map((p) => `- ${p}`) : ["- none"])];
  return lines.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const report = await runSeason({ days: Number(flag("days", 180)), customers: Number(flag("customers", 12)), outDir: flag("out", undefined), seed: flag("seed", "season-1") });
  console.log(formatSeason(report));
  process.exit(report.problems.length ? 1 : 0);
}
