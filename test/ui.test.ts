/**
 * `hunch ui` — the local memory control surface. The model test pins how records become one
 * scannable memory list with explicit connections; the server tests pin the three guards
 * (loopback Host, per-launch bearer key, static data-free shell) and the read-only API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { BugSchema, ComponentSchema, DecisionSchema, EdgeSchema, FindingSchema } from "../src/core/types.js";
import { componentDetail, componentMap, countMemory, filterMemory, memoryDetail, memoryItems, needsAttention, type MemorySource } from "../src/ui/model.js";
import { createPulse } from "../src/ui/pulse.js";
import { createUiServer, githubWebUrl, type UiProbes } from "../src/ui/server.js";
import { actionArgs, cliError, newArgs, undoFor, type MoveResult } from "../src/ui/actions.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { writeFileSync } from "node:fs";
import { mkConstraint, prov, tempStore, tsxLoaderUrl } from "./helpers.js";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { Script } from "node:vm";
import { uiHtml, uiJs } from "../src/ui/page.js";
import { memoryHistory } from "../src/ui/history.js";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { askContext, askableAssistants, defaultAskRunner, type AskRunner } from "../src/ui/ask.js";
import { CommandTimeoutError, DeterministicProvider, OpenAICompatProvider, claudeChildEnv, claudeOnSubscription, claudePrintArgs, codexExecArgs, isSubscriptionAuth, type ProviderStatus, type SynthProvider } from "../src/synthesis/provider.js";
import { currentInitiator, withInitiator } from "../src/synthesis/initiator.js";

const now = "2026-11-04T00:00:00Z";
const auth = ComponentSchema.parse({ id: "cmp_auth", kind: "module", name: "Auth", paths: ["src/auth/**"], provenance: prov(), created_at: now, updated_at: now });
const billing = ComponentSchema.parse({ id: "cmp_bill", kind: "module", name: "Billing", paths: ["src/billing/**"], provenance: prov(), created_at: now, updated_at: now });

function source(): MemorySource {
  return {
    components: [auth, billing],
    decisions: [
      DecisionSchema.parse({ id: "dec_live", title: "Sessions use signed cookies", topic: "auth-session", status: "accepted", decision: "Signed cookies", context: "Stateless", alternatives_rejected: ["JWT in localStorage"], related_components: ["cmp_bill"], related_files: ["src/auth/session.ts"], commit: "abc1234def", supersedes: "dec_old", provenance: { source: "human_confirmed", confidence: 0.9, evidence: [] }, date: "2026-10-01", valid_from: "2026-10-01T00:00:00Z" }),
      DecisionSchema.parse({ id: "dec_old", title: "Sessions in Redis", status: "superseded", superseded_by: "dec_live", valid_to: "2026-10-01T00:00:00Z", provenance: prov(), date: "2026-01-01" }),
      DecisionSchema.parse({ id: "dec_loose", title: "Prefer small PRs", status: "accepted", provenance: prov(), date: "2026-09-01" }),
    ],
    constraints: [
      mkConstraint({ id: "con_block", statement: "Never log tokens", scope: ["src/auth/**"], severity: "blocking" }),
      mkConstraint({ id: "con_gone", statement: "Old rule", status: "retired", valid_to: now }),
    ],
    bugs: [BugSchema.parse({ id: "bug_1", title: "Double charge", root_cause: "retry without idempotency key", affected_files: ["src/billing/charge.ts"], lineage: { fixed_commit: "fff0001" }, provenance: prov() })],
    findings: [FindingSchema.parse({ id: "fnd_1", title: "Unscoped queries", observation: "3 queries skip tenant", triage: "resolved", observed_at: "2026-08-01T00:00:00Z", provenance: prov() })],
  };
}

test("memory list: every kind, active state, recorded vs by-path components, unconnected", () => {
  const items = memoryItems(source());
  const by = Object.fromEntries(items.map((m) => [m.id, m]));
  assert.deepEqual(items.map((m) => m.id).sort(), ["bug_1", "con_block", "con_gone", "dec_live", "dec_loose", "dec_old", "fnd_1"]);
  assert.equal(by.dec_live!.kind, "decision");
  assert.equal(by.dec_live!.feature, "auth-session");
  assert.deepEqual(by.dec_live!.components, [{ id: "cmp_bill", name: "Billing", source: "recorded" }, { id: "cmp_auth", name: "Auth", source: "by-path" }]);
  assert.deepEqual(by.dec_live!.commits, ["abc1234def"]);
  assert.equal(by.dec_old!.active, false);
  assert.equal(by.con_block!.kind, "rule");
  assert.equal(by.con_block!.delivery, "block");
  assert.equal(by.con_gone!.active, false);
  assert.equal(by.fnd_1!.active, false, "resolved finding is no longer delivered");
  assert.deepEqual(by.bug_1!.components.map((c) => c.name), ["Billing"]);
  assert.equal(by.dec_loose!.unconnected, true);
  assert.equal(by.dec_old!.unconnected, false, "inactive records are not flagged as needing a connection");
  assert.ok(items.findIndex((m) => !m.active) > items.findLastIndex((m) => m.active), "active memories sort first");
});

test("memory filters: kind, view and search, with per-view counts", () => {
  const items = memoryItems(source());
  assert.deepEqual(filterMemory(items, { view: "unconnected" }).map((m) => m.id), ["dec_loose"]);
  assert.deepEqual(filterMemory(items, { kind: "rule", view: "all" }).map((m) => m.id).sort(), ["con_block", "con_gone"]);
  assert.deepEqual(filterMemory(items, { q: "COOKIES" }).map((m) => m.id), ["dec_live"]);
  assert.deepEqual(filterMemory(items, { q: "auth-session" }).map((m) => m.id), ["dec_live"], "search covers the feature");
  assert.deepEqual(countMemory(items, { kind: "decision" }), { active: 2, unconnected: 1, all: 3 });
});

const dependsOn = (id: string, from: string, to: string, type = "depends_on") => EdgeSchema.parse({ id, from, to, type, provenance: prov() });

test("needs attention: open findings by severity, unconnected, unconfirmed with blocking first", () => {
  const finding = (id: string, severity: string, triage: string, observed_at: string) => FindingSchema.parse({ id, title: id, observation: "seen", severity, triage, observed_at, affected_files: ["src/auth/session.ts"], provenance: prov() });
  const s = source();
  const src: MemorySource = {
    ...s,
    findings: [...s.findings, finding("fnd_low", "low", "open", "2026-10-02T00:00:00Z"), finding("fnd_high", "high", "open", "2026-10-01T00:00:00Z"), finding("fnd_risk", "high", "accepted-risk", "2026-10-03T00:00:00Z")],
    constraints: [...s.constraints,
      mkConstraint({ id: "con_warn", statement: "Warn me", scope: ["src/**"], severity: "warning", provenance: prov() }),
      mkConstraint({ id: "con_would_block", statement: "Would block", scope: ["src/**"], severity: "blocking", provenance: prov() }),
    ],
    decisions: [...s.decisions, DecisionSchema.parse({ id: "dec_adr", title: "From an ADR", status: "accepted", related_files: ["docs/adr/1.md"], provenance: { source: "imported:madr", confidence: 0.9, evidence: ["docs/adr/1.md"] }, date: "2026-09-02" })],
  };
  const { total, groups } = needsAttention(src, memoryItems(src));
  const ids = Object.fromEntries(groups.map((g) => [g.key, g.items.map((m) => m.id)]));
  assert.deepEqual(ids["open-findings"], ["fnd_high", "fnd_low"], "worst first; triaged and resolved findings don't wait");
  assert.deepEqual(ids["not-connected"], ["dec_loose"]);
  assert.deepEqual(ids["not-confirmed"]!.slice(0, 2), ["con_would_block", "con_warn"], "the rule that would block comes first");
  assert.ok(ids["not-confirmed"]!.includes("dec_loose"));
  assert.ok(!ids["not-confirmed"]!.includes("dec_live"), "a person already confirmed it");
  assert.ok(!ids["not-confirmed"]!.includes("con_block"), "a person already confirmed it");
  assert.ok(!ids["not-confirmed"]!.includes("con_gone"), "retired");
  assert.ok(!ids["not-confirmed"]!.includes("dec_adr"), "an imported ADR is signed through its own question");
  for (const id of ids["not-confirmed"]!) assert.equal(memoryDetail(src, id)!.actions.confirmable, true, `${id} is offered Confirm`);
  assert.equal(total, new Set(Object.values(ids).flat()).size, "dec_loose is in two groups and counts once");
  const quiet: MemorySource = { components: [], decisions: [], constraints: [], bugs: [], findings: [] };
  assert.deepEqual(needsAttention(quiet, []), { total: 0, groups: [] });
});

test("map: components with memory counts, uses and used by; only live components and depends_on edges", () => {
  const s = source();
  const gone = ComponentSchema.parse({ id: "cmp_gone", kind: "module", name: "Gone", status: "deprecated", paths: ["src/gone/**"], provenance: prov(), created_at: now, updated_at: now });
  const empty = ComponentSchema.parse({ id: "cmp_empty", kind: "module", name: "Empty", paths: ["src/empty/**"], provenance: prov(), created_at: now, updated_at: now });
  const open = FindingSchema.parse({ id: "fnd_open", title: "Open one", observation: "seen", severity: "high", triage: "open", observed_at: now, affected_files: ["src/auth/x.ts"], provenance: prov() });
  const src: MemorySource = { ...s, components: [...s.components, gone, empty], findings: [...s.findings, open] };
  const edges = [
    dependsOn("e1", "cmp_bill", "cmp_auth"), dependsOn("e2", "cmp_bill", "cmp_auth"), dependsOn("e3", "cmp_auth", "cmp_auth"),
    dependsOn("e4", "cmp_bill", "cmp_gone"), dependsOn("e5", "sym_a", "sym_b", "calls"), dependsOn("e6", "cmp_auth", "cmp_empty", "calls"),
  ];
  const map = componentMap(src, edges);
  assert.deepEqual(map.components.map((c) => c.name), ["Auth", "Billing", "Empty"], "most memory first; deprecated left out");
  const auth = map.components[0]!;
  assert.deepEqual(auth.counts, { decision: 1, rule: 1, bug: 0, finding: 1 }, "retired and superseded memory is not counted");
  assert.deepEqual(auth.usedBy, [{ id: "cmp_bill", name: "Billing" }], "duplicates collapse; self-edges, calls and dead components don't count");
  assert.deepEqual(auth.uses, []);
  assert.equal(map.components[2]!.total, 0);
  assert.equal(map.outside, 1, "dec_loose touches no component");
  assert.deepEqual(map.components.map((c) => [c.name, c.needsYou]), [["Auth", 1], ["Billing", 0], ["Empty", 0]], "only the open finding waits on a person: dec_live and con_block are confirmed, dec_loose is on no component");
  assert.ok(!("memory" in auth), "the list stays small");
  const billing = componentDetail(src, edges, "cmp_bill")!;
  assert.deepEqual(billing.memory.map((m) => m.id).sort(), ["bug_1", "dec_live"], "recorded and by-path both count");
  assert.deepEqual(billing.uses, [{ id: "cmp_auth", name: "Auth" }]);
  assert.equal(componentDetail(src, edges, "cmp_gone"), null);
  assert.equal(componentDetail(src, edges, "cmp_none"), null);
});

test("memory detail: sections, history links, provenance; unknown id is null", () => {
  const d = memoryDetail(source(), "dec_live")!;
  assert.equal(d.replaces, "dec_old");
  assert.equal(d.source, "human_confirmed");
  assert.deepEqual(d.sections.find((s) => s.label === "Rejected")?.items, ["JWT in localStorage"]);
  assert.equal(memoryDetail(source(), "dec_old")!.replacedBy, "dec_live");
  assert.equal(memoryDetail(source(), "con_block")!.sections[0]!.text, "Never log tokens");
  assert.equal(memoryDetail(source(), "nope"), null);
});

test("memory detail: actions offer only the moves the CLI takes for that record", () => {
  const actions = (id: string) => memoryDetail(source(), id)!.actions;
  const live = actions("dec_live");
  assert.deepEqual(live.fields.map((f) => [f.name, f.value]), [["title", "Sessions use signed cookies"], ["text", "Signed cookies"], ["context", "Stateless"]]);
  assert.deepEqual([live.signed, live.textLocked, live.takesFeature, live.takesComponents, live.removable, live.restorable], [true, null, true, true, true, false]);
  assert.deepEqual([actions("dec_old").removable, actions("dec_old").restorable], [false, false], "a replaced decision can't be restored: it would fork history");
  const rule = actions("con_block");
  assert.deepEqual(rule.fields.map((f) => f.name), ["text", "rationale"]);
  assert.deepEqual([rule.takesFeature, rule.takesComponents, rule.removable, rule.restorable], [false, false, true, false]);
  assert.deepEqual([actions("con_gone").removable, actions("con_gone").restorable], [false, true]);
  assert.deepEqual(actions("bug_1").fields.map((f) => f.name), ["title", "text"]);
  assert.deepEqual([actions("bug_1").removable, actions("bug_1").restorable], [false, false], "a bug can't be removed");
  assert.deepEqual([actions("fnd_1").removable, actions("fnd_1").restorable], [false, true]);
  // Confirm as mine: live and not yet signed, decisions and rules only.
  assert.deepEqual([live.confirmable, actions("dec_loose").confirmable, actions("dec_old").confirmable], [false, true, false]);
  assert.deepEqual([rule.signed, rule.confirmable, rule.severity, live.severity], [true, false, "blocking", null]);
  const draftRule = memoryDetail({ ...source(), constraints: [mkConstraint({ id: "con_draft", provenance: { source: "agent_recorded", confidence: 0.75, evidence: [] } })] }, "con_draft")!.actions;
  assert.deepEqual([draftRule.confirmable, draftRule.severity], [true, "warning"]);
  assert.deepEqual([actions("con_gone").confirmable, actions("bug_1").confirmable, actions("fnd_1").confirmable], [false, false, false]);

  const src = source();
  const imported = DecisionSchema.parse({ id: "dec_adr", title: "Use Postgres", status: "accepted", provenance: { source: "imported:madr", confidence: 0.8, evidence: [] }, date: "2026-01-01" });
  const adr = memoryDetail({ ...src, decisions: [...src.decisions, imported] }, "dec_adr")!.actions;
  assert.match(adr.textLocked ?? "", /ADR/, "imported ADR words are changed in the ADR file");
  assert.equal(adr.removable, true);
  assert.equal(adr.confirmable, false, "an imported ADR is signed through its own hash-bound question");
});

test("page script parses; the shell uses one vocabulary and redirects the old map route", () => {
  assert.doesNotThrow(() => new Script(uiJs));
  for (const word of ["Brain", "Memory", "Deliberate", "History", "Setup"]) assert.ok(uiHtml.includes(word), word);
  assert.ok(!uiHtml.includes("#/ask") && !uiJs.includes("#/ask"), "Ask is folded into the board: no page of its own");
  assert.match(uiJs, /Think this through/, "a memory opens the board about itself");
  for (const old of ["Needs attention", "Connections", "Not connected", "Edit connections", "Save connections", "Connections saved."]) assert.ok(!uiHtml.includes(old) && !uiJs.includes(old), `${old} is renamed`);
  assert.match(uiJs, /location\.replace\('#\/brain'/, "#/map and #/map/:id go to the Brain");
  assert.match(uiJs, /Edit links/);
  assert.ok(!uiHtml.includes('href="#/attention"') && !uiHtml.includes("Needs you <span"), "Needs you is no page of its own");
  assert.match(uiHtml, /data-nav="deliberate">Deliberate <span id="attention-count"/, "Deliberate carries the waiting count");
  assert.ok(uiJs.includes("if (page === 'attention') { if (!m[2]) { D.tab = 'finding'; D.key = ''; D.picked = ''; } location.replace(m[2] ? '#/memory/' + m[2] : '#/deliberate'); return; }"), "#/attention goes to Deliberate, or to the memory it named");
  // A clicked tab stays even when empty; only arriving moves on from an empty tab.
  assert.ok(uiJs.includes("D.tab = D.picked = b.dataset.tab;"), "a tab click is remembered as the person's pick");
  assert.ok(uiJs.includes("(!count(D.tab) && !D.key && D.picked !== D.tab)"), "an empty tab the person picked is not left for another");
  assert.ok(uiJs.includes("if (entering) D.picked = '';"), "arriving on Deliberate forgets the last pick");
  assert.ok(uiJs.includes("if (!after) D.picked = '';"), "settling the last card on a picked tab still moves on");
  // A Deliberate write can take a minute (commit + overlay sync): decisions queue and run in the
  // background, so the person keeps deciding instead of waiting on locked buttons.
  assert.ok(!/D\.busy|b\.disabled = D\./.test(uiJs), "no Deliberate button waits on a write");
  assert.match(uiHtml, /<div id="dlb-queue"[^>]*role="status"/, "the queue strip is announced");
  assert.match(uiJs, /D\.queue\.push\(\{ n: \+\+D\.seq, key: c\.key/, "a decision joins the queue");
  assert.match(uiJs, /dNext\(c, true\);\s*drawQueue\(\);\s*dPump\(\);/, "a decision settles its card at once");
  assert.match(uiJs, /if \(D\.running\) return;/, "one worker: writes run one at a time, in order");
  assert.match(uiJs, /!c\.records\.some\(\(r\) => held\.has\(r\.id\)\)/, "a card on a record with a queued move stays hidden until it lands");
  assert.match(uiJs, /beforeunload[\s\S]{0,80}dPending\(\)\.length/, "leaving with moves waiting asks first");
  assert.match(uiJs, /item\.of\.undone = false/, "a failed Undo can be tried again");
  assert.match(uiJs, /Links saved\./);
});

test("pulse: the first read is the baseline; then added, changed and removed memory, with a rising seq", () => {
  const pulse = createPulse();
  const s = source();
  const items = memoryItems(s);
  const first = pulse.read(items, 0, 3);
  assert.deepEqual([first.seq, first.changes, first.attention], [0, [], 3], "baseline reports nothing");
  assert.deepEqual(pulse.read(items, 0, 3).changes, [], "no change, no news");
  const added = memoryItems({ ...s, decisions: [...s.decisions, DecisionSchema.parse({ id: "dec_new", title: "Queue emails", status: "accepted", related_files: ["src/billing/q.ts"], provenance: prov(), date: "2026-11-01" })] });
  const a = pulse.read(added, 0, 4);
  assert.deepEqual(a.changes.map((c) => [c.seq, c.id, c.change, c.components]), [[1, "dec_new", "added", ["cmp_bill"]]]);
  const edited = added.map((m) => (m.id === "dec_loose" ? { ...m, title: "Prefer tiny PRs" } : m));
  const c = pulse.read(edited, 1, 4);
  assert.deepEqual(c.changes.map((x) => [x.seq, x.id, x.change, x.title]), [[2, "dec_loose", "changed", "Prefer tiny PRs"]], "since skips what the page already saw");
  const gone = pulse.read(edited.filter((m) => m.id !== "bug_1"), 2, 4);
  assert.deepEqual(gone.changes.map((x) => [x.seq, x.id, x.change, x.components]), [[3, "bug_1", "removed", ["cmp_bill"]]], "a removed memory keeps the components it was on");
  assert.equal(pulse.read(edited.filter((m) => m.id !== "bug_1"), 3, 4).changes.length, 0);
});

test("pulse: confirming a memory or changing a rule's severity is a change", () => {
  const pulse = createPulse();
  const s = source();
  pulse.read(memoryItems(s), 0, 0);
  const signed = memoryItems({ ...s, decisions: s.decisions.map((d) => (d.id === "dec_loose" ? { ...d, provenance: { ...d.provenance, source: "llm_draft+human_confirmed" as const } } : d)) });
  assert.equal(signed.find((m) => m.id === "dec_loose")!.signed, true);
  assert.deepEqual(pulse.read(signed, 0, 0).changes.map((c) => [c.id, c.change]), [["dec_loose", "changed"]]);
  const rule = signed.find((m) => m.kind === "rule")!;
  const louder = signed.map((m) => (m.id === rule.id ? { ...m, delivery: m.delivery === "block" ? "warn" as const : "block" as const } : m));
  assert.deepEqual(pulse.read(louder, 1, 0).changes.map((c) => [c.id, c.change]), [[rule.id, "changed"]]);
});

test("ui page: the first poll only places the page in the ring, and a backfill lands as one feed line", () => {
  assert.match(uiJs, /!P\.started \|\| r\.seq < P\.seq\) \{ P\.started = true; P\.seq = r\.seq; return; \}/);
  assert.match(uiJs, /document\.hidden && P\.started/, "a tab opened hidden still gets its baseline");
  assert.match(uiJs, /B\.fq\.length > 5/);
  assert.match(uiJs, /B\.hist = null/, "Replay reads git again after a change");
  assert.match(uiJs, /want\.id === d\.id/, "a queued form opens only on the memory it was queued for");
  assert.match(uiJs, /go\.disabled = B\.busy/, "Next up offers no second write during a request");
});

test("ui server: /api/pulse needs the key, sets a baseline, then reports added, changed and removed memory", async () => {
  const { store, root, cleanup } = tempStore();
  const s = source();
  for (const c of s.components) store.json.put("components", c);
  for (const d of s.decisions) store.json.put("decisions", d);
  const token = "k".repeat(32);
  const server = createUiServer({ root, token, version: "test", probes: fakeProbes });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => { let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode!, body })); });
    req.on("error", reject); req.end();
  });
  const settle = () => new Promise((r) => setTimeout(r, 40));
  try {
    assert.equal((await get("/api/pulse?since=0", {})).status, 401);
    const base = JSON.parse((await get("/api/pulse?since=0")).body);
    assert.deepEqual([base.seq, base.changes], [0, []]);
    assert.equal(typeof base.attention, "number");
    await settle();
    store.json.put("decisions", DecisionSchema.parse({ id: "dec_new", title: "Queue emails", status: "accepted", related_files: ["src/billing/q.ts"], provenance: prov(), date: "2026-11-01" }));
    const added = JSON.parse((await get("/api/pulse?since=0")).body);
    assert.deepEqual(added.changes.map((c: { id: string; change: string; components: string[] }) => [c.id, c.change, c.components]), [["dec_new", "added", ["cmp_bill"]]]);
    await settle();
    store.json.put("decisions", DecisionSchema.parse({ id: "dec_new", title: "Queue all emails", status: "accepted", related_files: ["src/billing/q.ts"], provenance: prov(), date: "2026-11-01" }));
    const changed = JSON.parse((await get(`/api/pulse?since=${added.seq}`)).body);
    assert.deepEqual(changed.changes.map((c: { id: string; change: string }) => [c.id, c.change]), [["dec_new", "changed"]]);
    await settle();
    store.json.delete("decisions", "dec_new");
    const removed = JSON.parse((await get(`/api/pulse?since=${changed.seq}`)).body);
    assert.deepEqual(removed.changes.map((c: { id: string; change: string }) => [c.id, c.change]), [["dec_new", "removed"]]);
  } finally { await new Promise<void>((r) => server.close(() => r())); server.closeStore(); cleanup(); }
});

test("githubWebUrl: ssh and https remotes map to the web URL; other hosts do not", () => {
  assert.equal(githubWebUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(githubWebUrl("https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(githubWebUrl("https://gitlab.com/o/r.git"), null);
  assert.equal(githubWebUrl(null), null);
});

const fakeProbes: UiProbes = {
  repo: async () => ({ root: "/r/demo", branch: "main", remote: "git@github.com:o/demo.git", webUrl: "https://github.com/o/demo" }),
  github: async () => ({ installed: true, authenticated: true, user: "octo", repo: "o/demo" }),
  assistants: async () => [{ name: "claude", label: "Claude Code", subscription: "Claude subscription", available: true }],
};

type Get = (path: string, headers?: Record<string, string>, method?: string) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>;

async function withServer(fn: (get: Get) => Promise<void>): Promise<void> {
  const { store, root, cleanup } = tempStore();
  const s = source();
  for (const c of s.components) store.json.put("components", c);
  for (const d of s.decisions) store.json.put("decisions", d);
  for (const c of s.constraints) store.json.put("constraints", c);
  store.json.put("edges", dependsOn("edge_bill_auth", "cmp_bill", "cmp_auth"));
  const token = "k".repeat(32);
  const server = createUiServer({ root, token, version: "test", probes: fakeProbes });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const get: Get = (path, headers = { authorization: `Bearer ${token}` }, method = "GET") => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
  try { await fn(get); }
  finally { await new Promise<void>((r) => server.close(() => r())); server.closeStore(); cleanup(); }
}

test("ui server: static shell is public, data-free and CSP-locked", async () => {
  await withServer(async (get) => {
    const page = await get("/", {});
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.doesNotMatch(page.body, /Sessions use signed cookies/);
    assert.equal((await get("/ui.js", {})).status, 200);
  });
});

test("ui server: /api needs the launch key and a loopback Host", async () => {
  await withServer(async (get) => {
    assert.equal((await get("/api/memory", {})).status, 401);
    assert.equal((await get("/api/memory", { authorization: `Bearer ${"x".repeat(32)}` })).status, 401);
    assert.equal((await get("/api/memory", { authorization: `Bearer ${"k".repeat(32)}`, host: "evil.example:80" })).status, 421, "DNS-rebound Host is refused");
  });
});

test("ui server: memory list, detail, repo and connections", async () => {
  await withServer(async (get) => {
    const list = JSON.parse((await get("/api/memory?view=all&kind=decision")).body);
    assert.deepEqual(list.items.map((m: { id: string }) => m.id).sort(), ["dec_live", "dec_loose", "dec_old"]);
    assert.deepEqual(list.counts, { active: 2, unconnected: 1, all: 3 });
    assert.equal(list.total, 3);
    const detail = JSON.parse((await get("/api/memory/dec_live")).body);
    assert.equal(detail.feature, "auth-session");
    assert.equal((await get("/api/memory/dec_missing")).status, 404);
    assert.deepEqual(JSON.parse((await get("/api/repo")).body), { name: "demo", branch: "main", webUrl: "https://github.com/o/demo" });
    const conn = JSON.parse((await get("/api/connections")).body);
    assert.equal(conn.github.user, "octo");
    assert.equal(conn.assistants[0].available, true);
  });
});

test("ui server: needs attention and map need the key, and answer from the store", async () => {
  await withServer(async (get) => {
    for (const path of ["/api/attention", "/api/map", "/api/map/cmp_auth"]) assert.equal((await get(path, {})).status, 401, path);
    const attention = JSON.parse((await get("/api/attention")).body);
    assert.deepEqual(attention.groups.map((g: { key: string }) => g.key), ["not-connected", "not-confirmed"]);
    assert.equal(attention.groups[0].total, 1);
    assert.equal(attention.groups[0].items[0].id, "dec_loose");
    assert.equal(JSON.parse((await get("/api/memory")).body).attention, attention.total, "the page's nav count");
    const map = JSON.parse((await get("/api/map")).body);
    assert.deepEqual(map.components.map((c: { name: string }) => c.name), ["Auth", "Billing"]);
    assert.deepEqual(map.components[0].usedBy, [{ id: "cmp_bill", name: "Billing" }]);
    assert.deepEqual(map.components.map((c: { name: string; needsYou: number }) => [c.name, c.needsYou]), [["Auth", 0], ["Billing", 0]], "needsYou counts only memory that waits on a person");
    const auth = JSON.parse((await get("/api/map/cmp_auth")).body);
    assert.deepEqual(auth.memory.map((m: { id: string }) => m.id).sort(), ["con_block", "dec_live"]);
    assert.equal((await get("/api/map/cmp_missing")).status, 404);
  });
});

test("ui server: refuses a short key and non-GET methods", async () => {
  assert.throws(() => createUiServer({ root: ".", token: "short", version: "t", probes: fakeProbes }), /at least 16/);
  await withServer(async (get) => {
    const res = await get("/api/components", undefined, "POST");
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET, POST");
    assert.equal((await get("/api/memory", undefined, "PUT")).status, 405);
    assert.equal((await get("/api/memory/dec_live/edit", undefined, "PUT")).status, 405);
    assert.equal((await get("/api/memory/dec_live/edit", undefined, "OPTIONS")).status, 405, "no CORS preflight is ever answered");
  });
});

test("ui server: /api/components lists active components by name", async () => {
  await withServer(async (get) => {
    assert.deepEqual(JSON.parse((await get("/api/components")).body).items, [{ id: "cmp_auth", name: "Auth" }, { id: "cmp_bill", name: "Billing" }]);
  });
});

// ---- writes ------------------------------------------------------------------

test("actionArgs: allowlists each action's fields into --flag=value argv", () => {
  assert.deepEqual(actionArgs("edit", "dec_1", { title: "--json", text: "a\nb" }), { ok: true, args: ["edit", "dec_1", "--title=--json", "--text=a\nb", "--json"] });
  assert.deepEqual(actionArgs("link", "con_1", { addFiles: ["a.ts", "b.ts"], removeFiles: ["c.ts"] }), { ok: true, args: ["link", "con_1", "--add-file=a.ts", "--add-file=b.ts", "--remove-file=c.ts", "--json"] });
  assert.deepEqual(actionArgs("link", "dec_1", { clearFeature: true, addComponents: ["cmp_a"] }), { ok: true, args: ["link", "dec_1", "--add-component=cmp_a", "--clear-feature", "--json"] });
  assert.deepEqual(actionArgs("remove", "fnd_1", { reason: "dup" }), { ok: true, args: ["remove", "fnd_1", "--reason=dup", "--json"] });
  assert.deepEqual(actionArgs("restore", "dec_1", {}), { ok: true, args: ["restore", "dec_1", "--json"] });
  assert.deepEqual(actionArgs("remove", "dec_1", { supersededBy: "dec_2" }), { ok: true, args: ["remove", "dec_1", "--superseded-by=dec_2", "--json"] });
  assert.deepEqual(actionArgs("restore", "dec_1", { clearSupersededBy: true }), { ok: true, args: ["restore", "dec_1", "--clear-superseded-by", "--json"] });
  assert.equal(actionArgs("restore", "dec_1", { clearSupersededBy: "yes" }).ok, false);
  assert.equal(actionArgs("edit", "dec_1", { clearSupersededBy: true }).ok, false);
  assert.equal(actionArgs("edit", "dec_1", { supersededBy: "dec_2" }).ok, false);
  // Signing is `hunch review`; with an overlay it must look there too.
  assert.deepEqual(actionArgs("confirm", "con_1", { severity: "blocking" }), { ok: true, args: ["review", "--confirm=con_1", "--severity=blocking", "--json"] });
  assert.deepEqual(actionArgs("unconfirm", "dec_1", {}, { private: true }), { ok: true, args: ["review", "--unconfirm=dec_1", "--private", "--json"] });
  assert.deepEqual(actionArgs("edit", "dec_1", { title: "t" }, { private: true }), { ok: true, args: ["edit", "dec_1", "--title=t", "--json"] }, "memory moves find the overlay themselves");
  const refused: Array<[Parameters<typeof actionArgs>, RegExp]> = [
    [["confirm", "dec_1", { reason: "x" }], /Unknown field for confirm: reason/],
    [["confirm", "dec_1", { private: true }], /Unknown field/],
    [["confirm", "--accept-verified", {}], /not a memory id/],
    [["edit", "dec_1", { title: "x", json: true }], /Unknown field for edit: json/],
    [["edit", "dec_1", { reason: "x" }], /Unknown field/],
    [["edit", "dec_1", { title: 5 }], /must be text/],
    [["edit", "dec_1", { title: "a\0b" }], /must be text/],
    [["edit", "dec_1", { title: "x".repeat(20_001) }], /must be text/],
    [["link", "dec_1", { addFiles: "a.ts" }], /must be a list/],
    [["link", "dec_1", { addFiles: [1] }], /must be a list/],
    [["link", "dec_1", { clearFeature: "yes" }], /must be true/],
    [["edit", "--json", {}], /not a memory id/],
    [["edit", "rb_1", {}], /not a memory id/],
    [["edit", "dec_1", null], /JSON object/],
    [["edit", "dec_1", ["x"]], /JSON object/],
    [["edit", "dec_1", { text: "x".repeat(16_000), context: "y".repeat(16_000) }], /too large to save at once/],
  ];
  for (const [args, pattern] of refused) {
    const r = actionArgs(...args);
    assert.equal(r.ok, false, JSON.stringify(args).slice(0, 80));
    assert.match((r as { error: string }).error, pattern);
  }
});

const move = (kind: MoveResult["kind"], before: Record<string, unknown>, after: Record<string, unknown>, id = "dec_1"): MoveResult =>
  ({ changed: true, id, kind, home: "public", before, after, flush: "committed" });

test("undoFor: each move's inverse, built from before/after", () => {
  assert.deepEqual(undoFor("edit", move("decision", { title: "A", decision: "x", context: "c" }, { title: "B", decision: "y", context: "c" })), { action: "edit", body: { title: "A", text: "x" } });
  assert.deepEqual(undoFor("remove", move("decision", { status: "accepted", superseded_by: null }, { status: "superseded", superseded_by: "dec_2" })), { action: "restore", body: { status: "accepted", clearSupersededBy: true } }, "undoing a recorded replacement forgets it");
  assert.deepEqual(undoFor("remove", move("decision", { status: "accepted", superseded_by: null }, { status: "superseded", superseded_by: null })), { action: "restore", body: { status: "accepted" } });
  assert.deepEqual(undoFor("edit", move("constraint", { statement: "s", rationale: "r" }, { statement: "t", rationale: "r" }, "con_1")), { action: "edit", body: { text: "s" } });
  const signed = undoFor("edit", move("decision", { title: "A", provenance: { source: "human_confirmed" } }, { title: "B", provenance: { source: "agent_recorded" } }));
  assert.match(signed!.note!, /not your confirmation.*Confirm as mine/);
  const testimony = { source: "agent_recorded", confidence: 0.75 };
  assert.deepEqual(undoFor("confirm", move("decision", { provenance: testimony }, { provenance: { source: "human_confirmed", confidence: 0.95 } })), { action: "unconfirm", body: {} });
  assert.deepEqual(undoFor("confirm", move("constraint", { severity: "warning", provenance: testimony }, { severity: "blocking" }, "con_1")), { action: "unconfirm", body: { severity: "warning" } });
  assert.deepEqual(undoFor("unconfirm", move("constraint", { severity: "blocking" }, { severity: "warning" }, "con_1")), { action: "confirm", body: { severity: "blocking" } });
  assert.deepEqual(undoFor("unconfirm", move("decision", {}, {})), { action: "confirm", body: {} });
  // --unconfirm never grants blocking or raises trust, so those can't come back; Undo says so.
  const lowered = undoFor("confirm", move("constraint", { severity: "blocking", provenance: testimony }, { severity: "warning" }, "con_1"))!;
  assert.deepEqual([lowered.action, lowered.body], ["unconfirm", {}]);
  assert.match(lowered.note!, /sets it to warn/);
  const kept = undoFor("confirm", move("constraint", { severity: "blocking", provenance: testimony }, { severity: "blocking" }, "con_1"))!;
  assert.deepEqual([kept.body, /sets it to warn/.test(kept.note!)], [{}, true], "unconfirm lowers a blocking rule, so Undo says so even when confirm kept it");
  assert.match(undoFor("confirm", move("constraint", { severity: "blocking", provenance: { source: "extracted", confidence: 0.9 } }, { severity: "blocking" }, "con_1"))!.note!, /75%, not 90%/);
  assert.deepEqual(undoFor("link", move("decision",
    { related_files: ["a", "b"], related_components: ["cmp_x"], topic: null },
    { related_files: ["a", "c"], related_components: [], topic: "auth" })),
  { action: "link", body: { removeFiles: ["c"], addFiles: ["b"], addComponents: ["cmp_x"], clearFeature: true } });
  assert.deepEqual(undoFor("link", move("decision", { related_files: [], related_components: [], topic: "a" }, { related_files: [], related_components: [], topic: "b" })), { action: "link", body: { feature: "a" } });
  assert.deepEqual(undoFor("link", move("constraint", { scope: ["src/**"] }, { scope: ["lib/**"] }, "con_1")), { action: "link", body: { removeFiles: ["lib/**"], addFiles: ["src/**"] } });
  assert.deepEqual(undoFor("remove", move("decision", { status: "proposed" }, { status: "rejected" })), { action: "restore", body: { status: "proposed" } });
  assert.deepEqual(undoFor("remove", move("finding", { triage: "scheduled" }, { triage: "stale" }, "fnd_1")), { action: "restore", body: { status: "scheduled" } });
  assert.deepEqual(undoFor("remove", move("constraint", { status: "active" }, { status: "retired" }, "con_1")), { action: "restore", body: {} });
  assert.deepEqual(undoFor("restore", move("decision", { status: "rejected" }, { status: "proposed" })), { action: "remove", body: {} });
  assert.deepEqual(undoFor("restore", move("constraint", { status: "retired" }, { status: "active" }, "con_1")), { action: "remove", body: {} });
  // remove picks its closed state, so an Undo that can't land where restore started says so.
  assert.match(undoFor("restore", move("decision", { status: "rejected" }, { status: "accepted" }))!.note!, /marked superseded rather than rejected/);
  assert.match(undoFor("restore", move("finding", { triage: "resolved" }, { triage: "open" }, "fnd_1"))!.note!, /marked stale rather than resolved/);
  assert.equal(undoFor("edit", { ...move("decision", {}, {}), changed: false }), null);
});

test("cliError: the CLI's error: lines, else its last lines", () => {
  assert.equal(cliError("noise\nerror: a bug can't be removed\n", ""), "a bug can't be removed");
  assert.equal(cliError("", "one\ntwo"), "one two");
  assert.equal(cliError("", ""), "The change was refused.");
});

test("newArgs: page kinds map to hunch new, fields are allowlisted into --flag=value argv", () => {
  assert.deepEqual(newArgs({ kind: "rule", text: "-x never", rationale: "--json", files: ["src/a.ts"], severity: "warning" }),
    { ok: true, args: ["new", "constraint", "--text=-x never", "--rationale=--json", "--severity=warning", "--file=src/a.ts", "--json"] });
  assert.deepEqual(newArgs({ kind: "decision", title: "T", text: "D", feature: "f", rejected: ["a", "b"], status: "proposed" }),
    { ok: true, args: ["new", "decision", "--title=T", "--text=D", "--feature=f", "--status=proposed", "--rejected=a", "--rejected=b", "--json"] });
  assert.deepEqual(newArgs({ kind: "finding", title: "T", text: "saw", evidence: ["log"] }),
    { ok: true, args: ["new", "finding", "--title=T", "--text=saw", "--evidence=log", "--json"] });
  const refused: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [["x"], /JSON object/],
    [{ text: "x" }, /decision, rule or finding/],
    [{ kind: "constraint", text: "x" }, /decision, rule or finding/],
    [{ kind: "__proto__", text: "x" }, /decision, rule or finding/],
    [{ kind: "constructor", text: "x" }, /decision, rule or finding/],
    [{ kind: "toString", text: "x" }, /decision, rule or finding/],
    [{ kind: "rule" }, /text is required/],
    [{ kind: "rule", text: 5 }, /text is required/],
    [{ kind: "rule", text: "x", json: true }, /Unknown field for new memory: json/],
    [{ kind: "rule", text: "x", supersedes: "dec_1" }, /Unknown field/],
    [{ kind: "rule", text: "x", private: true }, /Unknown field/],
    [{ kind: "rule", text: "a\0b" }, /must be text/],
    [{ kind: "rule", text: "x".repeat(20_001) }, /must be text/],
    [{ kind: "rule", text: "x", files: "a.ts" }, /must be a list/],
    [{ kind: "rule", text: "x", files: [1] }, /must be a list/],
    [{ kind: "rule", text: "x", files: Array(201).fill("a") }, /must be a list/],
    [{ kind: "rule", text: "x".repeat(16_000), rationale: "y".repeat(16_000) }, /too large to save at once/],
  ];
  for (const [body, pattern] of refused) {
    const r = newArgs(body);
    assert.equal(r.ok, false, JSON.stringify(body).slice(0, 80));
    assert.match((r as { error: string }).error, pattern);
  }
});

test("undoFor new: a new record's Undo retires it; an unchanged result has none", () => {
  const created: MoveResult = { changed: true, id: "con_1", kind: "constraint", home: "public", before: null, after: { status: "active" }, flush: "committed" };
  assert.deepEqual(undoFor("new", created), { action: "remove", body: {} });
  assert.equal(undoFor("new", { ...created, changed: false }), null);
});

type Post = (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;

/** A committed git fixture on a feature branch, served with a real CLI behind the write routes. */
/** cli: the real CLI (true), none (false), or a stand-in command to probe how the server reads its result. */
async function withWriteServer(fn: (post: Post, get: Get, origin: string, root: string) => Promise<void>, cli: boolean | { file: string; args: string[] } = true, asker?: AskRunner): Promise<void> {
  const root = tempDir("hunch-ui-write-");
  const env = isolatedCliEnv({ HOME: root, USERPROFILE: root, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, env, stdio: "ignore" }); };
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "Test"); git("config", "commit.gpgsign", "false");
  const json = new JsonStore(hunchPaths(root));
  json.ensureDirs();
  const s = source();
  for (const c of s.components) json.put("components", c);
  for (const d of s.decisions) json.put("decisions", d);
  for (const c of s.constraints) json.put("constraints", c);
  for (const b of s.bugs) json.put("bugs", b);
  writeFileSync(join(root, ".gitignore"), [".hunch/local.json", ".hunch/hunch.sqlite*", ".hunch-cache/", ""].join("\n"));
  git("add", "-A"); git("commit", "-qm", "fixture"); git("checkout", "-q", "-b", "feat/ui");
  const token = "w".repeat(32);
  const server = createUiServer({ root, token, version: "test", probes: fakeProbes, asker,
    cli: cli === true ? { file: process.execPath, args: hunchCliArgs(), env } : cli === false ? undefined : { ...cli, env } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body: string | null, headers: Record<string, string>) => new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject); if (body !== null) req.write(body); req.end();
  });
  const post: Post = async (path, body, headers = {}) => {
    const r = await call("POST", path, typeof body === "string" ? body : JSON.stringify(body), { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers });
    return { status: r.status, body: JSON.parse(r.body || "{}") };
  };
  const get: Get = (path, headers = { authorization: `Bearer ${token}` }) => call("GET", path, null, headers);
  try { await fn(post, get, `http://127.0.0.1:${port}`, root); }
  finally { await new Promise<void>((r) => server.close(() => r())); server.closeStore(); cleanupDir(root); }
}

test("ui server: /api/review says when git couldn't answer, shows nothing stale, and asks again", async () => {
  await withWriteServer(async (post, get, _origin, root) => {
    const read = async () => JSON.parse((await get("/api/review")).body) as { gitFailed?: boolean; groups: { kind: string; cards: { key: string }[] }[] };
    const stale = (r: Awaited<ReturnType<typeof read>>) => r.groups.find((g) => g.kind === "stale")!.cards.map((c) => c.key);
    assert.equal((await post("/api/memory/dec_loose/link", { addFiles: ["src/vanished.ts"] })).status, 200);
    renameSync(join(root, ".git"), join(root, ".git-off"));
    let failed: Awaited<ReturnType<typeof read>>;
    try { failed = await read(); } finally { renameSync(join(root, ".git-off"), join(root, ".git")); }
    assert.equal(failed.gitFailed, true);
    assert.ok(!stale(failed).includes("stale:dec_loose"), "git couldn't say, so nothing is called gone");
    assert.equal((await post("/api/memory/dec_loose/edit", { context: "Small PRs review faster." })).status, 200);
    const back = await read();
    assert.equal(back.gitFailed, false);
    assert.ok(stale(back).includes("stale:dec_loose"));
  });
});

test("ui server: /api/review needs the key, writes nothing, and reflects a change to any record", async () => {
  await withWriteServer(async (post, get, _origin, root) => {
    assert.equal((await get("/api/review", {})).status, 401);
    const weak = async (): Promise<string[]> => {
      const r = await get("/api/review");
      assert.equal(r.status, 200);
      const review = JSON.parse(r.body) as { total: number; groups: { kind: string; total: number; cards: { key: string }[] }[] };
      assert.deepEqual(review.groups.map((g) => g.kind), ["conflict", "stale", "duplicate", "weak", "finding", "unlinked", "unconfirmed"]);
      return review.groups.find((g) => g.kind === "weak")!.cards.map((c) => c.key);
    };
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    assert.ok((await weak()).includes("weak:dec_loose"), "no why, and nobody confirmed it");
    assert.ok((await weak()).includes("weak:dec_loose"), "a second read answers the same");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), before, "reading the review changes nothing");
    assert.equal((await post("/api/memory/dec_loose/edit", { context: "Small PRs review faster." })).status, 200);
    assert.ok(!(await weak()).includes("weak:dec_loose"), "a new why alone clears it, though the pulse can't see that edit");
  });
});

test("ui server: a confirmed record keeps its confirmation when its dead links are dropped", async () => {
  await withWriteServer(async (post, get) => {
    assert.equal((await post("/api/memory/dec_live/confirm", {})).status, 200);
    const before = JSON.parse((await get("/api/memory/dec_live")).body) as { files: string[]; actions: { signed: boolean } };
    assert.equal(before.actions.signed, true);
    assert.ok(before.files.length > 0);
    const dropped = await post("/api/memory/dec_live/link", { removeFiles: [before.files[0]] });
    assert.equal(dropped.status, 200);
    const after = JSON.parse((await get("/api/memory/dec_live")).body) as { files: string[]; actions: { signed: boolean } };
    assert.deepEqual(after.files, before.files.slice(1));
    assert.equal(after.actions.signed, true);
  });
});

test("ui server writes: key, Origin, JSON body and a CLI are all required; malformed requests never reach the CLI", async () => {
  await withWriteServer(async (post, get) => {
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { authorization: "" })).status, 401);
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { origin: "null" })).status, 403);
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" }, { "content-type": "text/plain" })).status, 415, "a simple cross-site form POST is refused");
    assert.equal((await post("/api/memory/dec_live/edit", "{not json")).status, 400);
    assert.equal((await post("/api/memory/dec_live/edit", "x".repeat(70 * 1024))).status, 413);
    assert.equal((await post("/api/memory/dec_live/delete", {})).status, 404);
    assert.match((await post("/api/memory/dec_live/edit", { json: true })).body.error, /Unknown field/);
    assert.equal(JSON.parse((await get("/api/memory/dec_live")).body).title, "Sessions use signed cookies", "no refused request changed the record");
  });
  await withWriteServer(async (post) => {
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" })).status, 503);
  }, false);
});

test("ui server writes: a CLI that fails to start, refuses, or prints no result each get their own answer", async () => {
  const script = (code: string) => ({ file: process.execPath, args: ["-e", code] });
  await withWriteServer(async (post) => {
    const r = await post("/api/memory/dec_live/edit", { title: "x" });
    assert.deepEqual([r.status, r.body.error], [422, "nope"]);
  }, script("console.error('error: nope'); process.exit(3)"));
  await withWriteServer(async (post) => {
    assert.equal((await post("/api/memory/dec_live/edit", { title: "x" })).status, 500);
  }, script("console.log('not json')"));
  await withWriteServer(async (post) => {
    const r = await post("/api/memory/dec_live/edit", { title: "x" });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /could not run/, "a CLI that never started is not reported as a refusal");
  }, { file: join(process.cwd(), "no-such-node-binary"), args: [] });
});

test("memoryHistory: record commits from both homes, newest first, with pushed state, links and titles", () => {
  const base = tempDir("hunch-ui-history-");
  const env = isolatedCliEnv({ HOME: base, USERPROFILE: base });
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const repo = (dir: string): void => { mkdirSync(dir, { recursive: true }); git(dir, "init", "-q"); git(dir, "config", "user.email", "t@example.com"); git(dir, "config", "user.name", "Test"); git(dir, "config", "commit.gpgsign", "false"); };
  let clock = 0;
  const commit = (dir: string, file: string, body: string | null, subject: string): void => {
    const path = join(dir, file);
    if (body === null) rmSync(path); else { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body); }
    git(dir, "add", "-A");
    const at = `2026-11-0${1 + Math.floor(clock / 10)}T10:${String(clock++ % 10).padStart(2, "0")}:00Z`;
    execFileSync("git", ["commit", "-qm", subject], { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } });
  };
  try {
    const code = join(base, "code"), overlay = join(base, "overlay"), remote = join(base, "remote.git");
    repo(code); repo(overlay);
    execFileSync("git", ["init", "-q", "--bare", remote], { env });
    commit(code, ".hunch/decisions/dec_aa01.json", "{}", "hunch: capture dec_aa01");
    commit(code, ".hunch/tasks/htask_1.json", "{}", "hunch: task htask_1");
    git(code, "remote", "add", "origin", remote); git(code, "push", "-q", "origin", "HEAD:main");
    commit(code, ".hunch/constraints/con_bb02.json", "{}", "hunch: capture con_bb02");
    commit(overlay, "mem/findings/fnd_cc03.json", "{}", "hunch: capture fnd_cc03");
    commit(code, ".hunch/decisions/dec_aa01.json", "{\"v\":2}", "hunch: edit dec_aa01");
    commit(code, ".hunch/constraints/con_bb02.json", null, "drop con_bb02");

    const sources = [
      { home: "public" as const, hunchDir: join(code, ".hunch"), webUrl: "https://github.com/o/demo" },
      { home: "private" as const, hunchDir: join(overlay, "mem"), webUrl: null },
    ];
    const titles = new Map([["dec_aa01", "Use cookies"], ["fnd_cc03", "Slow query"]]);
    const all = memoryHistory(sources, { limit: 100 }, titles);
    assert.deepEqual(all.map((h) => h.subject), ["drop con_bb02", "hunch: edit dec_aa01", "hunch: capture fnd_cc03", "hunch: capture con_bb02", "hunch: capture dec_aa01"], "task commits are not memory moves");
    const [drop, edit, finding, , first] = all;
    assert.equal(drop!.kind, "prune");
    assert.deepEqual(drop!.memories, [{ id: "con_bb02", title: null, components: [] }], "a record gone from the store keeps its id");
    assert.deepEqual([edit!.kind, edit!.pushed, edit!.url], ["edit", false, null], "not on any remote: no link");
    assert.deepEqual([finding!.home, finding!.memories], ["private", [{ id: "fnd_cc03", title: "Slow query", components: [] }]]);
    assert.equal(first!.pushed, true);
    assert.equal(first!.url, `https://github.com/o/demo/commit/${first!.sha}`);

    assert.deepEqual(memoryHistory(sources, { limit: 100, id: "dec_aa01" }, titles).map((h) => h.subject), ["hunch: edit dec_aa01", "hunch: capture dec_aa01"]);
    assert.equal(memoryHistory(sources, { limit: 2 }, titles).length, 2);
    const placed = memoryHistory(sources, { limit: 100 }, titles, new Map([["dec_aa01", ["cmp_auth"]]]));
    assert.deepEqual(placed.find((h) => h.subject === "hunch: edit dec_aa01")!.memories, [{ id: "dec_aa01", title: "Use cookies", components: ["cmp_auth"] }], "each memory names its components for the Brain replay");
    assert.deepEqual(memoryHistory([{ home: "public", hunchDir: join(base, "nowhere", ".hunch"), webUrl: null }], { limit: 100 }, titles), [], "no repo: no history");
  } finally { cleanupDir(base); }
});

test("ui server writes: edit, link and remove run the CLI, the list reloads, and each Undo puts it back", async () => {
  await withWriteServer(async (post, get, origin) => {
    const detail = async (id: string) => JSON.parse((await get(`/api/memory/${id}`)).body);

    // As the page sends it: with this server's own Origin.
    const edit = await post("/api/memory/dec_loose/edit", { title: "Prefer small pull requests" }, { origin });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.changed, true);
    assert.equal(edit.body.flush, "committed");
    assert.deepEqual(edit.body.undo, { action: "edit", body: { title: "Prefer small PRs" } });
    assert.equal((await detail("dec_loose")).title, "Prefer small pull requests", "the server reopened its store after the write");
    const undoEdit = await post(`/api/memory/dec_loose/${edit.body.undo.action}`, edit.body.undo.body);
    assert.equal(undoEdit.status, 200, JSON.stringify(undoEdit.body));
    assert.equal((await detail("dec_loose")).title, "Prefer small PRs");

    const link = await post("/api/memory/dec_loose/link", { addFiles: ["src/billing/charge.ts"], feature: "review-size" });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    const linked = await detail("dec_loose");
    assert.deepEqual([linked.feature, linked.files], ["review-size", ["src/billing/charge.ts"]]);
    const undoLink = await post(`/api/memory/dec_loose/${link.body.undo.action}`, link.body.undo.body);
    assert.equal(undoLink.status, 200, JSON.stringify(undoLink.body));
    const unlinked = await detail("dec_loose");
    assert.deepEqual([unlinked.feature, unlinked.files], [null, []]);

    const remove = await post("/api/memory/con_block/remove", { reason: "obsolete" });
    assert.equal(remove.status, 200, JSON.stringify(remove.body));
    assert.equal((await detail("con_block")).active, false);
    const undoRemove = await post(`/api/memory/con_block/${remove.body.undo.action}`, remove.body.undo.body);
    assert.equal(undoRemove.status, 200, JSON.stringify(undoRemove.body));
    assert.equal((await detail("con_block")).active, true);

    const refused = await post("/api/memory/bug_1/remove", {});
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /record of what broke/);

    // Every move above is a commit; History names them, newest first.
    const history = JSON.parse((await get("/api/history")).body);
    assert.equal(history.private, false);
    assert.deepEqual(history.items.slice(0, 2).map((h: { memories: { id: string; title: string }[] }) => h.memories), [
      [{ id: "con_block", title: "Never log tokens", components: ["cmp_auth"] }], [{ id: "con_block", title: "Never log tokens", components: ["cmp_auth"] }],
    ]);
    assert.ok(history.items.every((h: { pushed: boolean; url: string | null }) => !h.pushed && h.url === null), "nothing pushed: no GitHub links");
    const own = JSON.parse((await get("/api/history?id=dec_loose")).body);
    assert.equal(own.items.length, 5, "the fixture commit, then edit, its undo, link and its undo");
    assert.ok(own.items.every((h: { memories: { id: string }[] }) => h.memories.every((m) => m.id === "dec_loose")));
    assert.equal((await get("/api/history?id=dec_*")).status, 400);
  });
});

test("ui server new memory: guarded like every write; the CLI adds it unconfirmed, refuses duplicates and a second live decision, and Undo retires it", async () => {
  await withWriteServer(async (post, get, origin) => {
    const rule = { kind: "rule", text: "Never charge twice", rationale: "Refunds are manual", files: ["src/billing/**"], severity: "warning" };
    const total = async (): Promise<number> => JSON.parse((await get("/api/memory?view=all")).body).counts.all;
    const baseline = await total();
    assert.equal((await post("/api/memory", rule, { authorization: "" })).status, 401);
    assert.equal((await post("/api/memory", rule, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/memory", rule, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("/api/memory", { ...rule, kind: "constraint" })).status, 400);
    assert.equal((await post("/api/memory/", rule)).status, 405, "only the exact path creates");
    assert.equal(await total(), baseline, "no refused request added a record");

    const created = await post("/api/memory", rule, { origin });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.changed, true);
    assert.equal(created.body.flush, "committed");
    assert.deepEqual(created.body.undo, { action: "remove", body: {} });
    const id: string = created.body.id;
    assert.match(id, /^con_/);
    const detail = JSON.parse((await get(`/api/memory/${id}`)).body);
    assert.equal(detail.active, true);
    assert.equal(detail.actions.signed, false, "adding never mints a person's confirmation; only Confirm as mine does");
    assert.equal(detail.source, "agent_recorded");
    assert.equal(await total(), baseline + 1, "the list reloads with it");

    const again = await post("/api/memory", rule);
    assert.equal(again.status, 422);
    assert.match(again.body.error, /already exists/);

    const second = await post("/api/memory", { kind: "decision", title: "Sessions in JWTs", text: "JWT", feature: "auth-session" });
    assert.equal(second.status, 422, JSON.stringify(second.body));
    assert.equal(JSON.parse((await get("/api/memory/dec_live")).body).active, true, "the live decision for the feature is untouched");

    const undo = await post(`/api/memory/${id}/${created.body.undo.action}`, created.body.undo.body);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal(JSON.parse((await get(`/api/memory/${id}`)).body).active, false);
  });
});

test("ui server confirm: Confirm as mine signs a decision or a rule (with the severity chosen) through hunch review, and Undo takes it back", async () => {
  await withWriteServer(async (post, get, origin) => {
    const detail = async (id: string) => JSON.parse((await get(`/api/memory/${id}`)).body);
    const never = await post("/api/memory/dec_loose/unconfirm", {}, { origin });
    assert.equal(never.status, 422);
    assert.match(never.body.error, /not confirmed/);

    const signed = await post("/api/memory/dec_loose/confirm", {}, { origin });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.flush, "committed");
    const d = await detail("dec_loose");
    assert.deepEqual([d.actions.signed, d.actions.confirmable, d.source], [true, false, "extracted+human_confirmed"]);
    assert.equal(signed.body.undo.action, "unconfirm");
    assert.match(signed.body.undo.note, /75%, not 90%/, "an extracted record can't get its old trust back");
    const undo = await post(`/api/memory/dec_loose/${signed.body.undo.action}`, signed.body.undo.body);
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.deepEqual([(await detail("dec_loose")).actions.signed, (await detail("dec_loose")).actions.confirmable], [false, true]);

    const created = await post("/api/memory", { kind: "rule", text: "Never charge twice", rationale: "Refunds are manual", files: ["src/billing/**"], severity: "warning" });
    const id: string = created.body.id;
    assert.equal((await post(`/api/memory/${id}/confirm`, { severity: "forever" })).status, 422);
    const block = await post(`/api/memory/${id}/confirm`, { severity: "blocking" }, { origin });
    assert.equal(block.status, 200, JSON.stringify(block.body));
    assert.deepEqual(block.body.undo, { action: "unconfirm", body: { severity: "warning" } });
    const blocking = await detail(id);
    assert.deepEqual([blocking.actions.signed, blocking.actions.severity, blocking.delivery], [true, "blocking", "block"]);
    const back = await post(`/api/memory/${id}/${block.body.undo.action}`, block.body.undo.body);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const warned = await detail(id);
    assert.deepEqual([warned.actions.signed, warned.actions.severity, warned.source], [false, "warning", "agent_recorded"]);
  });
});

/** One process (tsx as a loader, not tsx's CLI wrapper), so kill() stops the server itself. */
function directCliArgs(...args: string[]): string[] {
  if (process.env.HUNCH_TEST_COMPILED_CLI === "1") return hunchCliArgs(...args);
  return ["--import", tsxLoaderUrl(), join(process.cwd(), "src/cli/index.ts"), ...args];
}

test("askContext: what it's about first, then memory sharing its feature or files, or the question's words; inactive memory stays out", () => {
  const src = source();
  src.decisions.push(DecisionSchema.parse({ id: "dec_same", title: "Rotate session keys", topic: "auth-session", status: "proposed", provenance: prov(), date: "2026-09-02" }));
  assert.deepEqual(askContext(src, "unrelated words here", "dec_live").map((m) => m.id), ["dec_live", "dec_same", "con_block"]);
  assert.deepEqual(askContext(src, "should we keep signed cookies", null).map((m) => m.id), ["dec_live"]);
  assert.deepEqual(askContext(src, "should this have that", null), [], "asking words alone match nothing");
  assert.deepEqual(askContext(src, "redis", null).map((m) => m.id), [], "a superseded decision isn't advice");
  assert.deepEqual(askContext(src, "nothing like it", "dec_old").map((m) => m.id), ["dec_old"], "unless a person asks about it");
  assert.deepEqual(askContext(src, "q", "dec_missing"), []);
});

test("askableAssistants: only ready subscription CLIs; a person picks, an agent session stays on its own account, an unknown origin asks nobody", () => {
  const status = (name: ProviderStatus["name"], subscription: string | null, available = true): ProviderStatus => ({ name, label: name, subscription, available });
  const statuses = [status("claude-cli", "Claude subscription"), status("codex-cli", "ChatGPT subscription"), status("cursor-agent", "Cursor subscription"), status("kimi-cli", null), status("openai-compat", null), status("deterministic", null)];
  const names = (env: NodeJS.ProcessEnv) => askableAssistants(statuses, env)?.map((a) => a.name) ?? null;
  assert.deepEqual(names({}), ["claude-cli"], "not metered or local HTTP providers, not a CLI that can't run without tools");
  assert.deepEqual(askableAssistants([status("claude-cli", "Claude subscription", false)], {}), [], "not one that isn't ready");
  assert.deepEqual(names({ CLAUDECODE: "1" }), ["claude-cli"]);
  assert.deepEqual(names({ HUNCH_INITIATOR: "codex" }), [], "bound to an assistant that can't run without tools");
  assert.deepEqual(names({ HUNCH_INITIATOR: "cursor" }), [], "bound to an assistant that can't run without tools");
  assert.equal(names({ CLAUDECODE: "1", CODEX_THREAD_ID: "t" }), null);
  assert.equal(names({ HUNCH_INITIATOR: "unknown" }), null);
});

test("defaultAskRunner: runs the picked CLI under its own account; local-only mode wins and nothing else runs", async () => {
  const seen: string[] = [];
  const fake = (name: string, available = true): SynthProvider => ({
    name, available: async () => available,
    draftDecision: () => { throw new Error("not for asking"); }, draftBug: () => { throw new Error("not for asking"); },
    draftProse: async (prompt, opts) => { seen.push(`${name}:${currentInitiator().provider}:${opts?.noTools}:${prompt}`); return "reply"; },
  });
  const providers = [fake("claude-cli"), fake("codex-cli"), fake("cursor-agent"), new DeterministicProvider()];
  const root = tempDir("hunch-ui-ask-");
  try {
    const person = defaultAskRunner(root, { providers, subscribed: async () => true, env: {} });
    const list = await person.assistants();
    assert.equal(list.blocked, null);
    assert.deepEqual(list.assistants.map((a) => a.name), ["claude-cli"], "Codex and Cursor stay off: neither can run with no tools");
    assert.equal(await person.ask("claude-cli", "p"), "reply");
    assert.deepEqual(seen, ["claude-cli:claude-cli:true:p"], "the pick is the operation's origin, and it runs with no tools");
    await assert.rejects(person.ask("codex-cli", "p"), /not available/);
    await assert.rejects(person.ask("cursor-agent", "p"), /not available/);
    await assert.rejects(person.ask("deterministic", "p"), /not available/);
    await assert.rejects(defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_INITIATOR: "codex" } }).ask("claude-cli", "p"), /not available/, "the spend itself holds an agent session to its own account");
    await assert.rejects(defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_INITIATOR: "unknown" } }).ask("claude-cli", "p"), /not available/);
    assert.equal(seen.length, 1, "none of those reached a model");

    const named = defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_SYNTH_PROVIDER: "claude-cli" } });
    assert.deepEqual((await named.assistants()).assistants.map((a) => a.name), ["claude-cli"], "a named provider is the person's spending choice");
    await assert.rejects(named.ask("codex-cli", "p"), /not available/);
    assert.deepEqual(await defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_SYNTH_PROVIDER: "codex-cli" } }).assistants(), { assistants: [], blocked: "other-provider" });
    assert.deepEqual(await defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_SYNTH_PROVIDER: "cursor-agent" } }).assistants(), { assistants: [], blocked: "other-provider" });

    seen.length = 0;
    const offline = defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_SYNTH_PROVIDER: "deterministic" } });
    assert.deepEqual(await offline.assistants(), { assistants: [], blocked: "local-only" });
    await assert.rejects(offline.ask("claude-cli", "p"), /not available/);
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ synthProvider: "deterministic" }));
    assert.deepEqual(await person.assistants(), { assistants: [], blocked: "local-only" }, "the per-user setting counts too");
    await assert.rejects(person.ask("claude-cli", "p"), /not available/);
    assert.deepEqual(seen, [], "local-only mode never reaches a model");
    assert.equal((await defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_INITIATOR: "unknown" } }).assistants()).blocked, "local-only");
    rmSync(join(root, ".hunch", "local.json"));
    assert.equal((await defaultAskRunner(root, { providers, subscribed: async () => true, env: { HUNCH_INITIATOR: "unknown" } }).assistants()).blocked, "unknown-origin");
  } finally { cleanupDir(root); }
});

test("claudeChildEnv strips every switch that would route headless Claude to metered billing, and nothing else", () => {
  const metered = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"];
  const env = Object.fromEntries(metered.map((k) => [k, "1"]));
  assert.deepEqual(claudeChildEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "p", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }), { CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "p", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" });
});

test("Ask needs a subscription login: anything else blocks it before the spend", async () => {
  const signed = (over: Record<string, unknown>): string => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", ...over });
  assert.equal(isSubscriptionAuth(signed({})), true);
  assert.equal(isSubscriptionAuth(signed({ authMethod: "oauth_token" })), true);
  for (const bad of [signed({ loggedIn: false }), signed({ authMethod: "console" }), signed({ authMethod: "api_key" }), signed({ apiProvider: "bedrock" }), "{}", "not json", ""]) assert.equal(isSubscriptionAuth(bad), false, bad);

  // The probe: a login check that runs past its timeout is unknown, not a "no"; any other failure is a "no".
  const probe = (run: () => Promise<{ stdout: string }>) => claudeOnSubscription({}, run);
  assert.equal(await probe(async () => ({ stdout: signed({}) })), true);
  assert.equal(await probe(async () => ({ stdout: signed({ authMethod: "console" }) })), false);
  assert.equal(await probe(async () => { throw new CommandTimeoutError("\"claude\" timed out after 15000ms"); }), null);
  assert.equal(await probe(async () => { throw new Error("\"claude\" exited 1: not logged in"); }), false);
  assert.equal(await probe(async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); }), false);

  const seen: string[] = [];
  const claude: SynthProvider = { ...new DeterministicProvider(), name: "claude-cli", available: async () => true, draftProse: async () => { seen.push("ran"); return "reply"; } };
  const root = tempDir("hunch-ui-ask-sub-");
  try {
    let asked = 0;
    const runner = defaultAskRunner(root, { providers: [claude, new DeterministicProvider()], env: {}, subscribed: async () => { asked++; return false; } });
    assert.deepEqual(await runner.assistants(), { assistants: [], blocked: "not-subscription" });
    await assert.rejects(runner.ask("claude-cli", "p"), /not available/);
    assert.deepEqual(seen, [], "a Console login never reaches the model");
    assert.equal(asked, 2, "checked at the listing and again at the spend");
    let slow = 0;
    const unsure = defaultAskRunner(root, { providers: [claude, new DeterministicProvider()], env: {}, subscribed: async () => { slow++; return null; } });
    assert.deepEqual(await unsure.assistants(), { assistants: [], blocked: "subscription-unknown" }, "a check that didn't answer says so, not 'not a subscription'");
    await assert.rejects(unsure.ask("claude-cli", "p"), /not available/);
    assert.deepEqual(seen, [], "an unconfirmed login never reaches the model either");
    assert.equal(slow, 2);
    const off = defaultAskRunner(root, { providers: [claude, new DeterministicProvider()], env: { HUNCH_SYNTH_PROVIDER: "deterministic" }, subscribed: async () => { throw new Error("must not run"); } });
    assert.equal((await off.assistants()).blocked, "local-only", "local-only mode runs nothing, not even the check");
  } finally { cleanupDir(root); }
});

test("noTools: Claude takes it as flags, off otherwise; a provider that can't hold it refuses before running", async () => {
  assert.deepEqual(claudePrintArgs("haiku"), ["-p", "--output-format", "json", "--model", "haiku", "--max-turns", "1", "--restricted"], "unattended synthesis reads no hooks or apiKeyHelper either");
  assert.deepEqual(claudePrintArgs("haiku", { noTools: true }).slice(-3), ["--restricted", "--tools=", "--strict-mcp-config"]);
  assert.ok(claudePrintArgs("haiku", { noTools: true }).every((a) => a !== "" && !/\s/.test(a)), "every token survives the cmd.exe line");
  assert.deepEqual(codexExecArgs("m"), ["exec", "--json", "--skip-git-repo-check", "-m", "m", "-"], "synthesis is unchanged");
  class Plain extends OpenAICompatProvider {
    ran = false;
    protected override async run(): Promise<string> { this.ran = true; return "x"; }
  }
  const plain = new Plain();
  assert.equal(await withInitiator({ provider: plain.name, source: "explicit" }, () => plain.draftProse("p")), "x");
  plain.ran = false;
  await assert.rejects(withInitiator({ provider: plain.name, source: "explicit" }, () => plain.draftProse("p", { noTools: true })), /cannot run without tools/);
  assert.equal(plain.ran, false);
});

test("ui server ask: GET /api/ask says who can be asked; asking itself goes through the board or the grill", async () => {
  const claude = { name: "claude-cli", label: "Claude Code" };
  const asker: AskRunner = { assistants: async () => ({ assistants: [claude], blocked: null }), ask: async () => { throw new Error("must not run"); } };
  await withWriteServer(async (post, get) => {
    assert.equal((await get("/api/ask", {})).status, 401);
    assert.deepEqual(JSON.parse((await get("/api/ask")).body), { assistants: [claude], blocked: null });
    assert.equal((await post("/api/ask", { question: "q", assistant: "claude-cli" })).status, 405, "the separate Ask is gone");
  }, false, asker);
  const blocked: AskRunner = { assistants: async () => ({ assistants: [], blocked: "local-only" }), ask: async () => { throw new Error("must not run"); } };
  await withWriteServer(async (_post, get) => {
    assert.equal(JSON.parse((await get("/api/ask")).body).blocked, "local-only");
  }, false, blocked);
});

test("cli:ui: hunch ui --port --no-open prints a keyed loopback link and serves the API with that key only", async () => {
  const root = tempDir("hunch-ui-cli-");
  const env = isolatedCliEnv({ HOME: root, USERPROFILE: root, HUNCH_PRIVATE_DIR: "", NO_COLOR: "1", CI: "1" });
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  const child = spawn(process.execPath, directCliArgs("ui", "--port", "0", "--no-open"), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => { log += d; });
  child.stderr!.on("data", (d) => { log += d; });
  try {
    const deadline = Date.now() + 60_000;
    let link: RegExpExecArray | null = null;
    while (!(link = /(http:\/\/127\.0\.0\.1:\d+)\/#t=([A-Za-z0-9_-]{16,})/.exec(log))) {
      assert.ok(child.exitCode === null, `hunch ui exited ${child.exitCode}:\n${log}`);
      assert.ok(Date.now() < deadline, `hunch ui never printed its link:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const [, base, key] = link;
    assert.equal((await fetch(`${base}/api/memory`)).status, 401);
    const res = await fetch(`${base}/api/memory`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { counts: unknown }).counts, { active: 0, unconnected: 0, all: 0 });
  } finally {
    child.kill();
    await new Promise((r) => child.exitCode !== null ? r(null) : child.once("exit", r));
    cleanupDir(root);
  }
});
