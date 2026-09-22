/**
 * Findings — observations with no diff (the anchor is a date + evidence, not a
 * commit). Covers: JSON round-trip + unified-FTS ride (no dedicated SQL table),
 * live-finding retrieval by file/glob/symbol, assembleContext + formatContext
 * grounding, deterministic finding-stale drift, git-backed staleness, id
 * idempotency, and legacy graphs that predate the findings kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempStore, prov, mkSymbol } from "./helpers.js";
import { formatContext } from "../src/core/format.js";
import { computeDrift } from "../src/core/drift.js";
import { findingId } from "../src/core/ids.js";
import { ConstraintSchema, type Finding } from "../src/core/types.js";

const finding = (over: Partial<Finding> = {}): Finding => {
  const title = over.title ?? "SPs missing tenant scoping";
  return {
    id: findingId(title),
    title,
    observation: "6 stored procedures query tenant data without a TenantId filter",
    evidence: ["SELECT p.name FROM sys.procedures p WHERE ... (6 rows)"],
    method: null,
    severity: "high",
    triage: "open",
    affected_files: [],
    affected_symbols: [],
    violates_constraint: null,
    spawned_decision: null,
    observed_at: "2026-08-04T00:00:00.000Z",
    resolved_commit: null,
    provenance: prov(),
    ...over,
  };
};

test("finding round-trips through JSON and rides the unified FTS index", () => {
  const { store, cleanup } = tempStore();
  const f = finding({ affected_files: ["db/procs/GetOrders.sql"] });
  store.json.put("findings", f);

  const loaded = store.json.loadAll("findings");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.id, f.id);
  assert.equal(loaded[0]!.triage, "open");

  store.reindex();
  const hits = store.search("tenant scoping");
  assert.ok(hits.some((h) => h.kind === "findings" && h.ref === f.id), "finding retrievable through unified search");

  const resolved = store.resolve(f.id);
  assert.equal(resolved?.kind, "findings");
  cleanup();
});

test("liveFindingsFor matches by file, glob (both directions), and symbol; closed triage stays silent", () => {
  const { store, cleanup } = tempStore();
  store.json.put("findings", finding({ title: "by exact file", affected_files: ["src/db/orders.ts"] }));
  store.json.put("findings", finding({ title: "by affected glob", affected_files: ["src/procs/**"] }));
  store.json.put("findings", finding({ title: "by symbol", affected_symbols: ["dbo.GetOrders"] }));
  store.json.put("findings", finding({ title: "already resolved", affected_files: ["src/db/orders.ts"], triage: "resolved", resolved_commit: "abc123" }));
  store.json.put("findings", finding({ title: "went stale", affected_files: ["src/db/orders.ts"], triage: "stale" }));

  assert.deepEqual(store.liveFindingsFor("src/db/orders.ts").map((f) => f.title), ["by exact file"]);
  assert.deepEqual(store.liveFindingsFor("src/procs/GetOrders.sql").map((f) => f.title), ["by affected glob"]);
  // scope-side glob: caller asks about a whole area
  assert.deepEqual(store.liveFindingsFor("src/db/**").map((f) => f.title), ["by exact file"]);
  assert.deepEqual(store.liveFindingsFor("dbo.GetOrders").map((f) => f.title), ["by symbol"]);
  cleanup();
});

test("liveFindingsFor sorts worst-severity first", () => {
  const { store, cleanup } = tempStore();
  store.json.put("findings", finding({ title: "low one", severity: "low", affected_files: ["src/x.ts"] }));
  store.json.put("findings", finding({ title: "critical one", severity: "critical", affected_files: ["src/x.ts"] }));
  assert.deepEqual(store.liveFindingsFor("src/x.ts").map((f) => f.title), ["critical one", "low one"]);
  cleanup();
});

test("liveFindingsFor rewrites an absolute target to repo-relative and never suffix-leaks an unrelated same-basename file (issue #299)", () => {
  const { store, root, cleanup } = tempStore();
  // A real indexed symbol at the target file — the same "is this path known to
  // the index" question liveFindingsFor now answers the same way why() does.
  store.json.put("symbols", mkSymbol("sym_auth", "src/auth/session.ts", "verifySession") as never);
  store.json.put("findings", finding({ title: "root-level unrelated", affected_files: ["session.ts"] }));
  store.json.put("findings", finding({ title: "the real target", affected_files: ["src/auth/session.ts"] }));
  const abs = join(root, "src", "auth", "session.ts");
  assert.deepEqual(
    store.liveFindingsFor(abs).map((f) => f.title),
    ["the real target"],
    "must resolve the absolute target's own finding, never the unrelated root-level same-basename file",
  );
  cleanup();
});

test("liveFindingsFor: a REAL working-tree file the index cannot see must not suffix-leak a nested same-basename file's findings (issue #334)", () => {
  const { store, root, cleanup } = tempStore();
  // A comment-only root file: zero tree-sitter symbols and no covering component,
  // so graph data alone calls it unreal and the suffix tier would serve
  // a/empty.ts's finding. The working tree is the last-resort answer.
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "empty.ts"), "// only a comment — no symbols at all\n");
  writeFileSync(join(root, "a", "empty.ts"), "export function nestedEmpty(){ return 1; }\n");
  store.json.put("findings", finding({ title: "the nested file's own gap", affected_files: ["a/empty.ts"] }));
  assert.deepEqual(store.liveFindingsFor("empty.ts").map((f) => f.title), [], "the real root file inherits nothing");
  assert.deepEqual(store.liveFindingsFor("a/empty.ts").map((f) => f.title), ["the nested file's own gap"], "the nested file still answers for itself");
  cleanup();
});

test("assembleContext carries live findings and formatContext renders them (pre-edit grounding)", () => {
  const { store, cleanup } = tempStore();
  store.json.put("findings", finding({
    affected_files: ["src/db/orders.ts"],
    violates_constraint: "con_tenant1234",
    method: "rb_tenant_audit_01",
  }));
  store.reindex();
  const ctx = store.assembleContext("src/db/orders.ts");
  assert.equal(ctx.findings.length, 1);
  const text = formatContext(ctx);
  assert.ok(text.includes("Known findings"), "findings section rendered");
  assert.ok(text.includes("SPs missing tenant scoping"));
  assert.ok(text.includes("violates con_tenant1234"));
  assert.ok(text.includes("re-verify via rb_tenant_audit_01"));
  cleanup();
});

test("finding-stale drift: fires on a live finding's missing file or dangling/retired constraint; closed findings are history", () => {
  const { store, root, cleanup } = tempStore();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "present.ts"), "export {};\n");

  store.json.put("findings", finding({ title: "healthy anchor", affected_files: ["src/present.ts"] }));
  store.json.put("findings", finding({ title: "anchor evaporated", affected_files: ["src/deleted.ts"] }));
  store.json.put("findings", finding({ title: "resolved with gone file", affected_files: ["src/deleted.ts"], triage: "resolved", resolved_commit: "abc123" }));
  store.json.put("findings", finding({ title: "dangling rule link", affected_files: ["src/present.ts"], violates_constraint: "con_missing000" }));
  store.json.put("findings", finding({ title: "retired rule link", affected_files: ["src/present.ts"], violates_constraint: "con_retired000" }));
  store.json.put("constraints", ConstraintSchema.parse({
    id: "con_retired000", statement: "old rule", status: "retired", provenance: prov(),
  }));

  const stale = computeDrift(store, root).findings.filter((d) => d.kind === "finding-stale");
  const byDetail = (needle: string) => stale.filter((d) => d.detail.includes(needle));
  assert.equal(byDetail("anchor evaporated").length, 1, "missing file on a live finding fires");
  assert.equal(byDetail("resolved with gone file").length, 0, "a closed finding never fires");
  assert.equal(byDetail("healthy anchor").length, 0, "an intact anchor never fires");
  assert.equal(byDetail("dangling rule link").length, 1, "violates_constraint to a missing rule fires");
  assert.equal(byDetail("retired rule link").length, 1, "violates_constraint to a retired rule fires");
  cleanup();
});

test("staleness flags a live finding whose affected file changed after it was observed", () => {
  const { store, cleanup } = tempStore();
  store.json.put("findings", finding({ affected_files: ["src/db/orders.ts"] }));
  store.json.put("findings", finding({ title: "closed already", affected_files: ["src/db/orders.ts"], triage: "resolved", resolved_commit: "abc123" }));
  const out = store.staleness(() => "2026-08-05T00:00:00.000Z"); // changed AFTER observed_at
  const fnd = out.filter((s) => s.kind === "finding");
  assert.equal(fnd.length, 1, "only the live finding is flagged");
  const none = store.staleness(() => "2026-08-01T00:00:00.000Z"); // changed BEFORE observed_at
  assert.equal(none.filter((s) => s.kind === "finding").length, 0);
  cleanup();
});

test("findingId is idempotent across whitespace/case variants of the same title", () => {
  assert.equal(findingId("SPs missing tenant scoping"), findingId("  sps MISSING tenant scoping  "));
  assert.notEqual(findingId("SPs missing tenant scoping"), findingId("reads also unscoped"));
});

test("a legacy graph without a findings directory loads empty and reindexes clean", () => {
  const { store, root, cleanup } = tempStore();
  rmSync(join(root, ".hunch", "findings"), { recursive: true, force: true });
  assert.deepEqual(store.json.loadAll("findings"), []);
  const { counts } = store.reindex();
  assert.equal(counts.findings, 0);
  assert.deepEqual(store.liveFindingsFor("src/x.ts"), []);
  cleanup();
});
