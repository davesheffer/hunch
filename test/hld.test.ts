import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { hunchPaths, hunchPathsForDir } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { SCHEMAS } from "../src/core/types.js";
import {
  answerQuestion, reimportBlock, approvalState, approveDraft, canonicalSource, detectGaps, draftPath, exportState, exportTitle, grillingProtocol, importHld, nextQuestion,
  listDrafts, openCount, parseHld, parseMermaid, readDraft, renderHld, renderHldBody, sourceSha, writeDraft, type ExportInput,
} from "../src/core/hld.js";
import { readLocks, setLock } from "../src/core/locks.js";
import { tsxLoaderUrl } from "./helpers.js";

const cli = resolve("src/cli/index.ts");
const SRC = "docs/hld/payments.md";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const prov = { source: "human_confirmed", confidence: 0.9, evidence: [] };

const DOC = `# Payments HLD

## Overview
The payments service charges cards for orders placed in the web shop. API receives checkout requests and forwards them.

\`\`\`mermaid
flowchart LR
  api[API Gateway] -->|REST| pay(Payments)
  pay -- writes --> db[(Ledger DB)]
  pay --> psp{{Stripe}}
  pay & api --> log>Audit log]
\`\`\`
`;

const component = (name: string, paths: string[]) => SCHEMAS.components.parse({
  id: `cmp_${name.toLowerCase()}`, kind: "module", name, paths, provenance: prov, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
});

function repo(t: { after: (f: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunch-hld-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: gitEnv });
  git("init", "-q");
  mkdirSync(join(root, "docs", "hld"), { recursive: true });
  writeFileSync(join(root, SRC), DOC);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.close();
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  t.after(() => cleanupDir(root));
  return { root, git };
}

test("parses Markdown with Mermaid: title, sections, labelled and inline-labelled edges, & fan-out", () => {
  const p = parseHld(SRC, DOC);
  assert.equal(p.format, "markdown");
  assert.equal(p.title, "Payments HLD");
  assert.deepEqual(p.sections.map((s) => s.heading), ["Payments HLD", "Overview"]);
  assert.deepEqual(p.nodes.map((n) => [n.id, n.label]), [["api", "API Gateway"], ["pay", "Payments"], ["db", "Ledger DB"], ["psp", "Stripe"], ["log", "Audit log"]]);
  assert.deepEqual(p.edges.map((e) => `${e.from}>${e.to}:${e.label}`), ["api>pay:REST", "pay>db:writes", "pay>psp:", "pay>log:", "api>log:"]);
  assert.equal(p.diagrams, 1);
});

test("parses sequence diagrams and draw.io (plain and compressed, with edge labels)", () => {
  const seq = parseHld("flow.mmd", "sequenceDiagram\n  participant U as User\n  U->>API: POST /pay\n  API-->>U: 200");
  assert.equal(seq.format, "mermaid");
  assert.deepEqual(seq.nodes.map((n) => n.label), ["User", "API"]);
  assert.deepEqual(seq.edges, [{ from: "U", to: "API", label: "POST /pay" }, { from: "API", to: "U", label: "200" }]);
  const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="Web &lt;b&gt;App&lt;/b&gt;" style="rounded=1;" vertex="1" parent="1"><mxGeometry/></mxCell>
<mxCell id="b" value="Orders API" style="rounded=1;" vertex="1" parent="1"><mxGeometry/></mxCell>
<mxCell id="e1" value="" style="edgeStyle=x;" edge="1" parent="1" source="a" target="b"><mxGeometry/></mxCell>
<mxCell id="l1" value="HTTPS" style="edgeLabel;html=1;" vertex="1" parent="e1"><mxGeometry/></mxCell>
</root></mxGraphModel>`;
  const plain = `<mxfile><diagram id="p" name="Page-1">${model}</diagram></mxfile>`;
  const packed = `<mxfile><diagram id="p" name="Page-1">${deflateRawSync(Buffer.from(encodeURIComponent(model))).toString("base64")}</diagram></mxfile>`;
  for (const text of [plain, packed]) {
    const d = parseHld("arch.drawio", text);
    assert.equal(d.format, "drawio");
    assert.deepEqual(d.nodes, [{ id: "a", label: "Web App" }, { id: "b", label: "Orders API" }]);
    assert.deepEqual(d.edges, [{ from: "a", to: "b", label: "HTTPS" }]);
  }
});

test("gaps become questions: unexplained components, unlabelled connections, missing concerns, code mismatches", () => {
  const p = parseHld(SRC, DOC);
  const qs = detectGaps(p, [component("Payments", ["src/payments/**"]), component("Billing", ["src/billing/**"])]);
  const kinds = (k: string) => qs.filter((q) => q.kind === k).map((q) => q.subject);
  assert.deepEqual(kinds("missing-goals"), [], "an Overview with real prose answers the goals question");
  assert.deepEqual(kinds("component-role"), ["Ledger DB", "Stripe", "Audit log"], "components the text already names are not asked about");
  assert.deepEqual(kinds("connection"), ["Payments -> Stripe", "Payments -> Audit log", "API Gateway -> Audit log"]);
  for (const k of ["missing-data", "missing-nfr", "missing-failure", "missing-security", "missing-alternatives"]) assert.equal(kinds(k).length, 1, k);
  assert.deepEqual(kinds("unknown-component"), ["API Gateway", "Ledger DB", "Stripe", "Audit log"]);
  assert.match(qs.find((q) => q.kind === "uncovered-components")!.question, /Billing/);
  assert.deepEqual(detectGaps(p, []).map((q) => q.id), detectGaps(p, []).map((q) => q.id), "question ids are stable");
  const diagramOnly = detectGaps(parseHld("a.mmd", "flowchart LR\n  a --> b"), []);
  assert.equal(diagramOnly[0]!.kind, "missing-goals", "a bare diagram is asked what it is for first");
  assert.equal(detectGaps(parseHld("notes.md", "# Notes\n\nJust prose about goals and scope of the thing we build here for the team."), [])[0]!.kind, "no-diagram");
});

test("import, answer, re-import keeps answers; approval needs every answer and the imported bytes", t => {
  const { root } = repo(t);
  const { draft } = importHld(root, SRC, []);
  writeDraft(root, draft);
  assert.match(draftPath(SRC), /^\.hunch\/hld\/docs-hld-payments-[a-f0-9]{10}\.json$/);
  assert.match(grillingProtocol(draft), /ONE question at a time/);
  assert.match(grillingProtocol(draft), /Never answer a question yourself/);
  const first = nextQuestion(draft)!;
  const answered = answerQuestion(draft, first.id, { text: "Owns the ledger of charges", via: "agent" });
  writeDraft(root, answered);
  assert.throws(() => approveDraft(answered, sourceSha(root, SRC), "dave"), /still unanswered/);
  // Edit the source: the answered question still applies, so its answer carries over.
  writeFileSync(join(root, SRC), DOC.replace("REST", "gRPC"));
  const again = importHld(root, SRC, []);
  assert.equal(again.carried, 1);
  assert.equal(readDraft(root, SRC)!.questions.find((q) => q.id === first.id)!.answer!.text, "Owns the ledger of charges");
  let all = again.draft;
  for (const q of all.questions) if (!q.answer) all = answerQuestion(all, q.id, { skip: true, via: "cli" });
  assert.equal(openCount(all), 0);
  assert.throws(() => approveDraft(all, "sha256:" + "0".repeat(64), "dave"), /changed since it was imported/);
  const approved = approveDraft(all, sourceSha(root, SRC), "dave");
  writeDraft(root, approved);
  assert.throws(() => answerQuestion(approved, first.id, { text: "x", via: "agent" }), /approved and locked/);
  assert.throws(() => importHld(root, SRC, []), /Only a human reopens it/, "refused even before any lock exists");
  setLock(root, SRC, { kind: "hld", approvedBy: "dave" });
  setLock(root, draftPath(SRC), { kind: "hld", approvedBy: "dave" });
  assert.throws(() => importHld(root, SRC, []), /Only a human reopens it/);
  assert.ok(importHld(root, SRC, [], { reopen: true }).draft.status === "draft");
});

test("export renders one deterministic standard HLD and tells stale, hand-edited and foreign files apart", t => {
  const { root } = repo(t);
  const { draft } = importHld(root, SRC, []);
  let d = draft;
  for (const q of d.questions) d = answerQuestion(d, q.id, { text: `answer ${q.kind}`, via: "cli", at: "2026-11-17T10:00:00Z" });
  d = approveDraft(d, sourceSha(root, SRC), "dave", "2026-11-17T10:00:00Z");
  const api = component("Api", ["src/api/**"]), store = component("Store", ["src/store/**"]);
  const input: ExportInput = {
    title: "shop",
    components: [store, api],
    edges: [SCHEMAS.edges.parse({ id: "edge_1", from: api.id, to: store.id, type: "depends_on", provenance: prov })],
    decisions: [SCHEMAS.decisions.parse({ id: "dec_1", title: "Charges go through Stripe", topic: "payments.psp", status: "accepted", context: "PCI scope", decision: "Use Stripe Checkout", alternatives_rejected: ["Storing card numbers ourselves"], provenance: prov, date: "2026-01-01T00:00:00Z" }),
      SCHEMAS.decisions.parse({ id: "dec_0", title: "Old choice", status: "superseded", provenance: prov, date: "2025-01-01T00:00:00Z" })],
    constraints: [SCHEMAS.constraints.parse({ id: "con_1", statement: "Card data never touches our servers", scope: ["src/payments/**"], severity: "blocking", provenance: prov, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" })],
    drafts: [d],
  };
  const body = renderHldBody(input);
  for (const s of ["## 2. Architecture", "flowchart LR", 'n0["Api"]', "n0 --> n1", "| Store |", "Charges go through Stripe (`payments.psp`)", "**Rejected:** Storing card numbers ourselves",
    "| blocking | Card data never touches our servers |", "### Payments HLD", "approved by dave on 2026-11-17 · locked", '-->|"REST"|', "answer component-role"]) {
    assert.ok(body.includes(s), `missing: ${s}\n${body}`);
  }
  assert.ok(!body.includes("Old choice"), "superseded decisions are not part of the current design");
  const doc = renderHld(input);
  assert.equal(renderHld({ ...input, components: [api, store] }), doc, "input order does not change the output");
  assert.equal(exportState(null, doc), "absent");
  assert.equal(exportState(doc, doc), "fresh");
  assert.equal(exportState(doc, renderHld({ ...input, constraints: [] })), "stale");
  assert.equal(exportState(doc.replace("Card data", "Card info"), doc), "edited");
  assert.equal(exportState("# My own HLD\n", doc), "foreign");
});

test("cli: import-hld, hld, hld-answer, hld-approve (terminal only) and export-hld --check", t => {
  const { root } = repo(t);
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const dry = run("import-hld", SRC, "--dry-run");
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /dry run: parsed/);
  assert.ok(!existsSync(join(root, draftPath(SRC))), "--dry-run writes nothing");
  const imported = JSON.parse(run("import-hld", SRC, "--json").out) as { questions: Array<{ id: string }> };
  assert.ok(existsSync(join(root, draftPath(SRC))));
  assert.match(run("hld").out, /docs\/hld\/payments\.md\s+\[draft\]/);
  const [first, ...rest] = imported.questions.map((q) => q.id);
  assert.match(run("hld-answer", SRC, "--question", first!, "The", "ledger", "of", "charges").out, /answered/);
  for (const id of rest) run("hld-answer", SRC, "--question", id, "--skip");
  const shown = JSON.parse(run("hld", SRC, "--json").out) as { questions: Array<{ answer: { text: string; via: string } | null }> };
  assert.equal(shown.questions[0]!.answer!.text, "The ledger of charges");
  assert.equal(shown.questions[0]!.answer!.via, "agent", "an answer typed without a terminal is not stamped as the human's");
  assert.equal(shown.questions.filter((q) => !q.answer).length, 0);
  const approve = run("hld-approve", SRC, "--reviewed-by", "agent");
  assert.notEqual(approve.code, 0);
  assert.match(approve.out, /interactive terminal/);
  assert.equal(readLocks(root).locks.length, 0, "an agent's shell cannot approve");
  assert.equal(run("export-hld", "--check").code, 1, "missing export fails the check");
  const preview = run("export-hld", "--dry-run");
  assert.match(preview.out, /hunch:generated hld v1/);
  assert.ok(!existsSync(join(root, "docs/hld/HLD.md")));
  assert.equal(run("export-hld").code, 0);
  assert.equal(run("export-hld", "--check").code, 0);
  const out = join(root, "docs/hld/HLD.md");
  writeFileSync(out, readFileSync(out, "utf8").replace("High-Level Design", "HLD (edited)"));
  const edited = run("export-hld", "--check");
  assert.equal(edited.code, 1);
  assert.match(edited.out, /edited by hand/);
  assert.notEqual(run("export-hld").code, 0, "a hand-edited export is not overwritten silently");
  assert.equal(run("export-hld", "--force").code, 0);
  assert.equal(run("export-hld", "--check").code, 0);
  assert.notEqual(run("export-hld", "../outside.md").code, 0, "the export stays inside the repository");
});

test("hook: an approved draft is locked like its source", t => {
  const { root } = repo(t);
  let { draft } = importHld(root, SRC, []);
  for (const q of draft.questions) draft = answerQuestion(draft, q.id, { skip: true, via: "cli" });
  writeDraft(root, approveDraft(draft, sourceSha(root, SRC), "dave"));
  setLock(root, SRC, { kind: "hld", approvedBy: "dave" });
  setLock(root, draftPath(SRC), { kind: "hld", approvedBy: "dave" });
  const out = execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "hook", "--provider", "claude"], {
    cwd: root, env: { ...process.env, HUNCH_PIPELINE: "0", HUNCH_TASK_SELECTION: "" }, encoding: "utf8",
    input: JSON.stringify({ cwd: root, session_id: "s-hld", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(root, draftPath(SRC)), old_string: "skipped", new_string: "made up" } }),
  }).trim();
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

function runCli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["--import", tsxLoaderUrl(), cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

test("regression: one canonical source path for import, draft and lock (//, ./, case)", t => {
  const { root } = repo(t);
  assert.equal(importHld(root, "docs//hld/./payments.md", []).draft.source, SRC);
  assert.equal(canonicalSource(root, "docs/./hld//payments.md"), SRC);
  assert.equal(canonicalSource(root, ".HUNCH/hld/x.json"), null);
  if (existsSync(join(root, "DOCS/HLD/PAYMENTS.MD"))) assert.equal(canonicalSource(root, "DOCS/HLD/Payments.md"), SRC, "case variant on a case-insensitive file system");
});

test("regression: draft slugs never collide and a draft for another source is refused", t => {
  const { root } = repo(t);
  const names = ["docs/hld/payments.md", "docs/hld/payments.mmd", "docs/hld/Payments.md", "docs/hld-payments.md", "docs/日本.md", "docs/中文.md"];
  assert.equal(new Set(names.map(draftPath)).size, names.length);
  const { draft } = importHld(root, SRC, []);
  writeDraft(root, draft);
  const other = "docs/hld/other.md";
  writeFileSync(join(root, draftPath(other)), readFileSync(join(root, draftPath(SRC))));
  assert.throws(() => readDraft(root, other), /belongs to docs\/hld\/payments\.md/);
});

test("regression: approval is derived from the lock registry, not the draft's own status", t => {
  const { root } = repo(t);
  let { draft } = importHld(root, SRC, []);
  for (const q of draft.questions) draft = answerQuestion(draft, q.id, { skip: true, via: "cli" });
  const forged = approveDraft(draft, sourceSha(root, SRC), "dave", "2026-11-17T10:00:00Z");
  writeDraft(root, forged);
  assert.equal(approvalState(root, forged), "unverified", "status:approved typed into the JSON is not an approval");
  const input: ExportInput = { title: "t", components: [], edges: [], decisions: [], constraints: [], drafts: [forged], approval: (d) => approvalState(root, d) };
  assert.ok(!renderHldBody(input).includes("approved by dave"));
  assert.match(renderHldBody(input), /approval unverified/);
  assert.throws(() => setLock(root, SRC, { kind: "hld", approvedBy: "dave", expectSha: "sha256:" + "0".repeat(64) }), /changed after it was reviewed/);
  setLock(root, SRC, { kind: "hld", approvedBy: "dave" });
  setLock(root, draftPath(SRC), { kind: "hld", approvedBy: "dave" });
  assert.equal(approvalState(root, forged), "approved");
  assert.match(renderHldBody(input), /approved by dave/);
  writeFileSync(join(root, SRC), DOC + "\nmore\n");
  assert.equal(approvalState(root, forged), "unverified", "changed bytes void the approval");
});

test("regression: hld-approve checks the lock registry before anything else", t => {
  const { root } = repo(t);
  let { draft } = importHld(root, SRC, []);
  for (const q of draft.questions) draft = answerQuestion(draft, q.id, { skip: true, via: "cli" });
  writeDraft(root, draft);
  writeFileSync(join(root, ".hunch", "locks.json"), "{ not json");
  const r = runCli(root, ["hld-approve", SRC, "--reviewed-by", "dave"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not a valid lock registry/);
  assert.equal(readDraft(root, SRC)!.status, "draft");
});

test("regression: export --check ignores CRLF/BOM and the checkout directory name", t => {
  const { root } = repo(t);
  const input: ExportInput = { title: "t", components: [], edges: [], decisions: [], constraints: [], drafts: [] };
  const doc = renderHld(input);
  assert.equal(exportState(`﻿${doc.replace(/\n/g, "\r\n")}`, doc), "fresh");
  assert.equal(exportTitle(root), "Project");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shop" }));
  assert.equal(exportTitle(root), "shop");
});

test("regression: private overlay components never reach the committed draft", t => {
  const { root } = repo(t);
  const priv = realpathSync(mkdtempSync(join(tmpdir(), "hunch-hld-priv-")));
  t.after(() => cleanupDir(priv));
  const ps = new HunchStore(hunchPathsForDir(priv));
  ps.json.ensureDirs();
  ps.json.put("components", component("Secretvault", ["src/secretvault/**"]));
  ps.close();
  const r = runCli(root, ["import-hld", SRC], { HUNCH_PRIVATE_DIR: priv });
  assert.equal(r.code, 0, r.out);
  assert.ok(!readFileSync(join(root, draftPath(SRC)), "utf8").includes("Secretvault"));
});

test("regression: Mermaid links of every shape are read, and unread lines are reported", () => {
  const g = parseMermaid([
    "---", "title: x", "---", "flowchart LR",
    "A-- text -->B", "B ---> C", "C --text--> D", "D --xyz--> E", "end-user --> api", "E -..-> F", "F ===> G", "G o--o H", "H x--x I",
    "I -. later .-> J", "J -->|\"q\"| K[\"a --> b\"]", "what is this )",
  ].join("\n"));
  const edges = g.edges.map((e) => `${e.from}>${e.to}:${e.label}`);
  assert.deepEqual(edges, ["A>B:text", "B>C:", "C>D:text", "D>E:xyz", "end-user>api:", "E>F:", "F>G:", "G>H:", "H>I:", "I>J:later", "J>K:q"]);
  assert.ok(!g.nodes.some((n) => n.id === "xyz"), "an inline label is not a node");
  assert.equal(g.nodes.find((n) => n.id === "K")!.label, "a --> b");
  assert.equal(g.warnings.length, 1);
  assert.match(g.warnings[0]!, /what is this/);
  assert.match(parseHld("a.md", "# A\n```mermaid\nflowchart LR\n  a -- b\n```\n").warnings[0]!, /unread Mermaid line/);
});

test("regression: a 200KB Mermaid line parses in under a second", () => {
  const line = `A -- ${"x ".repeat(100_000)}`;
  const started = performance.now();
  const g = parseMermaid(`flowchart LR\n${line}\n`);
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started}ms`);
  assert.equal(g.warnings.length, 1);
  const many = `A -- ${"x -".repeat(600)}\n`.repeat(200);
  const t2 = performance.now();
  parseMermaid(`flowchart LR\n${many}`);
  assert.ok(performance.now() - t2 < 1000, "many long lines stay linear");
});

test("regression: export never writes into .hunch/ in any letter case", t => {
  const { root } = repo(t);
  const r = runCli(root, ["export-hld", ".HUNCH/decisions/hld.json"]);
  assert.notEqual(r.code, 0);
  assert.ok(!existsSync(join(root, ".hunch/decisions/hld.json")));
  assert.ok(!existsSync(join(root, ".HUNCH/decisions/hld.json")));
});

test("regression: import refuses an in-repo symlink to a file outside the repository", t => {
  const { root } = repo(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "hunch-hld-out-")));
  t.after(() => cleanupDir(outside));
  writeFileSync(join(outside, "secret.md"), DOC);
  try { symlinkSync(join(outside, "secret.md"), join(root, "docs/hld/link.md"), "file"); } catch { t.skip("symlinks not permitted here"); return; }
  assert.throws(() => importHld(root, "docs/hld/link.md", []), /inside the repository/);
  assert.throws(() => sourceSha(root, "docs/hld/link.md"), /inside the repository/);
});

test("regression: the uncovered-components question changes id with the component set", () => {
  const p = parseHld("a.mmd", "flowchart LR\n  x --> y");
  const id = (names: string[]) => detectGaps(p, names.map((n) => component(n, [`src/${n.toLowerCase()}/**`]))).find((q) => q.kind === "uncovered-components")!.id;
  assert.notEqual(id(["Alpha", "Beta"]), id(["Alpha", "Gamma"]));
});

function lockedApproval(root: string) {
  let { draft } = importHld(root, SRC, []);
  for (const q of draft.questions) draft = answerQuestion(draft, q.id, { text: "real answer", via: "cli" });
  const approved = approveDraft(draft, sourceSha(root, SRC), "dave", "2026-11-17T10:00:00Z");
  writeDraft(root, approved);
  setLock(root, SRC, { kind: "hld", approvedBy: "dave" });
  setLock(root, draftPath(SRC), { kind: "hld", approvedBy: "dave" });
  return approved;
}

test("regression (round 2): a second draft file copying an approved draft is not approved", t => {
  const { root } = repo(t);
  const approved = lockedApproval(root);
  const forged = { ...approved, questions: approved.questions.map((q) => ({ ...q, answer: { ...q.answer!, text: "forged answer" } })) };
  writeFileSync(join(root, ".hunch", "hld", "zzz-agent.json"), `${JSON.stringify(forged, null, 2)}\n`);
  const drafts = listDrafts(root);
  assert.equal(drafts.length, 1, "only the canonical draft file is a draft");
  assert.ok(!JSON.stringify(drafts).includes("forged answer"));
  assert.equal(approvalState(root, approved), "approved");
  assert.equal(approvalState(root, forged), "unverified", "the given draft's own bytes must be the locked ones");
});

test("regression (round 2): a bare -- inside an inline label is label text", () => {
  const edges = (s: string) => parseMermaid(`flowchart LR\n${s}`).edges.map((e) => `${e.from}>${e.to}:${e.label}`);
  assert.deepEqual(edges("A -- a--b --> C"), ["A>C:a--b"]);
  assert.deepEqual(edges("A -- text -- more --> B"), ["A>B:text -- more"]);
  assert.deepEqual(edges("A == x==y ==> B"), ["A>B:x==y"]);
  assert.deepEqual(edges("A -- t --- B"), ["A>B:t"]);
  assert.deepEqual(edges("A -- t --x B"), ["A>B:t"]);
});

test("regression (round 2): a forged approved draft without locks is not reported as locked", t => {
  const { root } = repo(t);
  let { draft } = importHld(root, SRC, []);
  for (const q of draft.questions) draft = answerQuestion(draft, q.id, { skip: true, via: "cli" });
  const forged = approveDraft(draft, sourceSha(root, SRC), "dave");
  writeDraft(root, forged);
  assert.doesNotMatch(grillingProtocol(forged, approvalState(root, forged)), /and locked\. Nothing to ask/);
  assert.match(grillingProtocol(forged, approvalState(root, forged)), /approval unverified/);
  assert.throws(() => importHld(root, SRC, []), /Only a human reopens it/, "an approved-status draft that fails verification is still not agent-reimportable");
});

test("regression (round 2): export-hld honours a lock under any spelling of the target", t => {
  const { root } = repo(t);
  assert.equal(runCli(root, ["export-hld", "docs/gen/HLD.md"]).code, 0);
  const out = join(root, "docs/gen/HLD.md");
  writeFileSync(out, readFileSync(out, "utf8").replace("High-Level Design", "HLD (edited)"));
  setLock(root, "docs/gen/HLD.md", { kind: "doc", approvedBy: "dave" });
  const before = readFileSync(out, "utf8");
  const r = runCli(root, ["export-hld", "docs//gen/./HLD.md", "--force"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /is locked/);
  assert.equal(readFileSync(out, "utf8"), before);
});

test("regression (round 3): a genuine approval whose source was edited is still not agent-reimportable", t => {
  const { root } = repo(t);
  const approved = lockedApproval(root);
  assert.equal(approvalState(root, approved), "approved");
  writeFileSync(join(root, SRC), `${DOC}
edited after approval
`);
  assert.equal(approvalState(root, approved), "unverified");
  assert.throws(() => importHld(root, SRC, []), /Only a human reopens it/);
  writeFileSync(join(root, ".hunch", "locks.json"), "<<<<<<< conflict");
  assert.throws(() => importHld(root, SRC, []), /git checkout -- \.hunch\/locks\.json/);
});

test("regression (round 3): a reformatted, re-locked draft stays approved", t => {
  const { root } = repo(t);
  const approved = lockedApproval(root);
  writeFileSync(join(root, draftPath(SRC)), JSON.stringify(approved));
  setLock(root, draftPath(SRC), { kind: "hld", approvedBy: "dave" });
  assert.equal(approvalState(root, approved), "approved");
});

test("regression (round 3): export-hld stays blocked after a case-only rename of a locked file", t => {
  const { root } = repo(t);
  assert.equal(runCli(root, ["export-hld", "docs/gen/HLD.md"]).code, 0);
  if (!existsSync(join(root, "docs/gen/hld.md"))) { t.skip("case-sensitive file system"); return; }
  const out = join(root, "docs/gen/HLD.md");
  writeFileSync(out, readFileSync(out, "utf8").replace("High-Level Design", "HLD (edited)"));
  setLock(root, "docs/gen/HLD.md", { kind: "doc", approvedBy: "dave" });
  renameSync(join(root, "docs/gen/HLD.md"), join(root, "docs/gen/hld.md"));
  const before = readFileSync(join(root, "docs/gen/hld.md"), "utf8");
  const r = runCli(root, ["export-hld", "docs/gen/HLD.md", "--force"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /is locked/);
  assert.equal(readFileSync(join(root, "docs/gen/hld.md"), "utf8"), before);
});

test("regression (round 4): a lock without an approved draft still reaches the human, never an agent", async t => {
  const { root } = repo(t);
  assert.equal(reimportBlock(root, SRC, null), null);
  setLock(root, SRC, { kind: "hld", approvedBy: "dave" });
  assert.equal(reimportBlock(root, SRC, null)?.kind, "locked", "a source-only lock with no draft");
  const r = runCli(root, ["import-hld", SRC]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /interactive terminal|hunch unlock/);
  assert.doesNotMatch(r.out, /by running `hunch import-hld/, "never tells the user to run the command they just ran");
  assert.ok(!existsSync(join(root, draftPath(SRC))), "no draft written");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildServer } = await import("../src/mcp/server.js");
  const server = buildServer(root);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "hld-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  // closed here, not in t.after: the repo cleanup registered first would run while the store is open
  let res;
  try { res = await client.callTool({ name: "hunch_hld", arguments: { action: "import", file: SRC } }); } finally { await client.close(); await server.close(); }
  assert.match((res.content as Array<{ text: string }>)[0]!.text, /^Refused:/);
  assert.ok(!existsSync(join(root, draftPath(SRC))));
});

test("regression (round 4): reimportBlock kinds", t => {
  const { root } = repo(t);
  let { draft } = importHld(root, SRC, []);
  for (const q of draft.questions) draft = answerQuestion(draft, q.id, { skip: true, via: "cli" });
  const approved = approveDraft(draft, sourceSha(root, SRC), "dave");
  assert.equal(reimportBlock(root, SRC, approved)?.kind, "approved");
  writeFileSync(join(root, ".hunch", "locks.json"), "<<<<<<< HEAD\n");
  const corrupt = reimportBlock(root, SRC, approved);
  assert.equal(corrupt?.kind, "registry-corrupt");
  assert.match(corrupt!.message, /git checkout -- \.hunch\/locks\.json/);
});
