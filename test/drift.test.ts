import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempStore, prov } from "./helpers.js";
import { computeDrift } from "../src/core/drift.js";

const DEC = (over: Record<string, unknown> = {}) => ({
  id: "dec_x", title: "t", status: "accepted", context: "", decision: "",
  consequences: [], alternatives_rejected: [], rejected_tripwires: [],
  related_components: [], related_files: [], supersedes: null, superseded_by: null,
  caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
  retired: { symbols: [], deps: [] }, provenance: prov(0.9), date: "2026-01-01T00:00:00Z",
  ...over,
});

test("drift dead-ref: in-force decision referencing a missing file is flagged (existing file is not)", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "export const x = 1;\n");
  store.json.put("decisions", DEC({ id: "dec_live", related_files: ["src/real.ts", "src/ghost.ts", "src/**"] }) as never);

  const dead = computeDrift(store, root).findings.filter((f) => f.kind === "dead-ref");
  assert.equal(dead.length, 1, "only the missing non-glob file is flagged");
  assert.equal(dead[0]!.id, "dec_live");
  assert.match(dead[0]!.detail, /ghost\.ts/);
});

test("drift dead-ref: a SUPERSEDED decision's missing file is history, not drift (skipped)", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  store.json.put("decisions", DEC({ id: "dec_old", status: "superseded", superseded_by: "dec_new", related_files: ["src/ghost.ts"] }) as never);
  assert.equal(computeDrift(store, root).findings.filter((f) => f.kind === "dead-ref").length, 0);
});

test("drift supersede: a dangling/incomplete supersede is flagged; a clean one is not", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  // A supersedes B, but B is still in force (the private-supersede bug shape).
  store.json.put("decisions", DEC({ id: "dec_b", status: "accepted" }) as never);
  store.json.put("decisions", DEC({ id: "dec_a", supersedes: "dec_b" }) as never);
  // C supersedes a missing record.
  store.json.put("decisions", DEC({ id: "dec_c", supersedes: "dec_ghost" }) as never);
  // D supersedes E, properly closed → no finding.
  store.json.put("decisions", DEC({ id: "dec_e", status: "superseded", superseded_by: "dec_d" }) as never);
  store.json.put("decisions", DEC({ id: "dec_d", supersedes: "dec_e" }) as never);

  const sup = computeDrift(store, root).findings.filter((f) => f.kind === "supersede");
  const ids = sup.map((f) => f.id).sort();
  assert.deepEqual(ids, ["dec_a", "dec_c"], "only the in-force-target and missing-target supersedes flag");
  assert.match(sup.find((f) => f.id === "dec_a")!.detail, /still in force/);
  assert.match(sup.find((f) => f.id === "dec_c")!.detail, /does not exist/);
});

test("drift doc-stale: a 'proposed' doc that references shipped code is flagged; a clean doc is not", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "export const x = 1;\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "stale.md"), "# Thing\n> Status: **proposed** (not yet implemented)\n\nSee src/real.ts for the impl.\n");
  writeFileSync(join(root, "docs", "fine.md"), "# Other\nShipped and stable. See src/real.ts.\n");

  const stale = computeDrift(store, root).findings.filter((f) => f.kind === "doc-stale");
  assert.equal(stale.length, 1, "only the proposed-but-references-shipped-code doc flags");
  assert.equal(stale[0]!.id, "docs/stale.md");
});

test("drift: a healthy graph + repo yields no findings", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "export const x = 1;\n");
  store.json.put("decisions", DEC({ id: "dec_ok", related_files: ["src/real.ts"] }) as never);
  assert.equal(computeDrift(store, root).findings.length, 0);
});
