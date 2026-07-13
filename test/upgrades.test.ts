import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff, summarizeDiff } from "../src/extractors/diff.js";
import { formatContext } from "../src/core/format.js";
import { tempStore, prov } from "./helpers.js";

test("analyzeDiff extracts added/removed/changed symbols and deps", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,3 +1,4 @@",
    '+import Redis from "redis";',
    "-export function login(){}",
    "+export function verifySession(t){ return t; }",
    "+export function revokeSession(id){}",
    "-import old from \"legacy\";",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.addedSymbols.map((s) => s.name).sort(), ["revokeSession", "verifySession"]);
  assert.deepEqual(a.removedSymbols.map((s) => s.name), ["login"]);
  assert.deepEqual(a.addedDeps, ["redis"]);
  assert.deepEqual(a.removedDeps, ["legacy"]);
  const sum = summarizeDiff(a);
  assert.ok(sum.includes("verifySession") && sum.includes("redis"));
});

test("analyzeDiff recognizes Python def/class declarations and import/from-import deps", () => {
  const diff = [
    "diff --git a/src/auth.py b/src/auth.py",
    "--- a/src/auth.py",
    "+++ b/src/auth.py",
    "@@ -1,3 +1,5 @@",
    "+import redis",
    "+from .jwt import decode_token",
    "-def login():",
    "+def verify_session(t):",
    "+    return decode_token(t)",
    "+class SessionError(Exception):",
    "-from legacy import old_helper",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.addedSymbols.map((s) => s.name).sort(), ["SessionError", "verify_session"]);
  assert.deepEqual(a.removedSymbols.map((s) => s.name), ["login"]);
  assert.deepEqual(a.addedDeps, ["redis"]);
  assert.deepEqual(a.removedDeps, ["legacy"]);
  // relative import (leading '.') is NOT counted as an external dep, same convention as JS
  assert.ok(!a.addedDeps.includes(".jwt") && !a.addedDeps.includes("jwt"));
  const sum = summarizeDiff(a);
  assert.ok(sum.includes("verify_session") && sum.includes("redis"));
});

test("analyzeDiff does not treat TS import-equals syntax as a Python import (PY_IMPORT_RE false-positive fix)", () => {
  const diff = [
    "diff --git a/src/ns.ts b/src/ns.ts",
    "--- a/src/ns.ts",
    "+++ b/src/ns.ts",
    "@@ -1 +1 @@",
    "+import Foo = Bar.Baz;",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.addedDeps, [], "import-equals is not a Python import and not a JS module-string import");
});

test("analyzeDiff ignores .py files just like other code files pre-registry (sanity: extension gate wired)", () => {
  const diff = [
    "diff --git a/notes.txt b/notes.txt",
    "--- a/notes.txt",
    "+++ b/notes.txt",
    "@@ -1 +1 @@",
    "+def not_code():",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.addedSymbols, [], "non-code extension is still ignored");
});

test("analyzeDiff detects a changed (both-sides) symbol as 'changed', and ignores non-code files", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "+# new heading",
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1 +1 @@",
    "-export function f(a){ return a; }",
    "+export function f(a, b){ return a + b; }",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.changedSymbols.map((s) => s.name), ["f"]);
  assert.equal(a.addedSymbols.length, 0);
  assert.equal(a.filesAdded.length, 0); // README.md not counted
});

test("content lines starting with ++/-- are NOT mistaken for file headers (regression: header collision)", () => {
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,2 +1,2 @@",
    " const a = 1;",
    "+++count;", // source "++count;" — added content, not a header
    "---flag;", // source "--flag;" — removed content, not a header
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.equal(a.addedLines, 1, "the ++count line is counted");
  assert.equal(a.removedLines, 1, "the --flag line is counted");
});

test("analyzeDiff records a pure rename (regression: renames were invisible)", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 100%",
    "rename from src/old.ts",
    "rename to src/new.ts",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.deepEqual(a.filesRenamed, [{ from: "src/old.ts", to: "src/new.ts" }]);
});

test("analyzeDiff captures added line bodies per file (veto: call sites, not just decls)", () => {
  const diff = [
    "diff --git a/vscode-extension/src/extension.ts b/vscode-extension/src/extension.ts",
    "--- a/vscode-extension/src/extension.ts",
    "+++ b/vscode-extension/src/extension.ts",
    "@@ -1,2 +1,4 @@",
    '+import axios from "axios";',
    "+const data = await axios.get('/api/memory');",
    " const unchanged = 1;",
    "-const gone = 2;",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    "+docs only, not a code file",
  ].join("\n");
  const a = analyzeDiff(diff);
  const lines = a.addedLinesByFile.get("vscode-extension/src/extension.ts");
  assert.deepEqual(lines, ['import axios from "axios";', "const data = await axios.get('/api/memory');"]);
  // the call site is in the added-line text even though it is not a declaration
  assert.ok(lines!.some((l) => l.includes("axios.get")), "call site captured");
  assert.ok(!a.addedSymbols.some((s) => s.name === "data"), "await-call const is not classified as an added symbol");
  // non-code files are excluded, same as the rest of the analyzer
  assert.equal(a.addedLinesByFile.has("README.md"), false);
});

test("moving a symbol between files is added+removed, not 'changed' (regression: per-file classification)", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +0,0 @@",
    "-export function moved(){}",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+export function moved(){}",
  ].join("\n");
  const a = analyzeDiff(diff);
  assert.ok(a.addedSymbols.some((s) => s.name === "moved"), "added in b.ts");
  assert.ok(a.removedSymbols.some((s) => s.name === "moved"), "removed from a.ts");
  assert.ok(!a.changedSymbols.some((s) => s.name === "moved"), "NOT a same-file change");
});

test("staleness flags a record whose file changed after last_verified", () => {
  const { store, cleanup } = tempStore();
  store.json.put("constraints", { id: "con_1", type: "security", statement: "x", scope: ["src/auth.ts"], severity: "blocking", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: { source: "derived", confidence: 0.9, evidence: [], last_verified: "2026-01-01T00:00:00Z" } } as never);
  store.json.put("constraints", { id: "con_2", type: "security", statement: "y", scope: ["src/other.ts"], severity: "warning", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: { source: "derived", confidence: 0.9, evidence: [], last_verified: "2026-06-01T00:00:00Z" } } as never);
  // src/auth.ts changed 2026-03-01 (after con_1 verified, before con_2's later date / different file)
  const lastChange = (f: string) => (f === "src/auth.ts" ? "2026-03-01T00:00:00Z" : "");
  const stale = store.staleness(lastChange);
  assert.deepEqual(stale.map((s) => s.id), ["con_1"]);
  cleanup();
});

test("assembleContext orders invariants first, then decisions/bugs/blast radius", () => {
  const { store, cleanup } = tempStore();
  store.json.replaceAll("symbols", [
    { id: "sym_v", file: "src/auth.ts", name: "verify", kind: "function", signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 1, bug_count: 0, fan_in: 1, fan_out: 0 }, last_changed: "" },
    { id: "sym_c", file: "src/bill.ts", name: "charge", kind: "function", signature_hash: "", calls: ["sym_v"], called_by: [], metrics: { loc: 5, churn_90d: 0, bug_count: 0, fan_in: 0, fan_out: 1 }, last_changed: "" },
  ] as never);
  store.json.replaceAll("edges", [{ id: "e1", from: "sym_c", to: "sym_v", type: "calls", reason: "", strength: 1, provenance: prov() }] as never);
  store.json.put("constraints", { id: "con_1", type: "security", statement: "server-side revocation", scope: ["src/auth.ts"], severity: "blocking", enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [], provenance: prov(0.9) } as never);
  store.json.put("decisions", { id: "dec_1", title: "Redis sessions", status: "accepted", context: "", decision: "server-side", consequences: [], alternatives_rejected: [], related_components: [], related_files: ["src/auth.ts"], supersedes: null, caused_by_bug: null, commit: null, provenance: prov(0.95), date: "2026-01-01T00:00:00Z" } as never);
  store.reindex();

  const ctx = store.assembleContext("src/auth.ts");
  assert.equal(ctx.constraints[0]?.id, "con_1");
  assert.equal(ctx.decisions[0]?.id, "dec_1");
  assert.ok(ctx.blast_radius.some((d) => d.via.includes("charge")), "blast radius includes the dependent");
  const text = formatContext(ctx);
  assert.ok(text.indexOf("Invariants") < text.indexOf("Decisions"), "invariants rendered before decisions");
  cleanup();
});

test("formatContext degrades gracefully and respects the budget", () => {
  const { store, cleanup } = tempStore();
  store.reindex();
  const text = formatContext(store.assembleContext("nope.ts", 1500));
  assert.ok(text.includes("still learning"), "graceful empty message");
  const tiny = formatContext({ target: "x", constraints: [], decisions: [], bugs: [], blast_radius: [], components: [], budget_tokens: 1 });
  assert.ok(tiny.length <= 60, "budget trims output");
  cleanup();
});
