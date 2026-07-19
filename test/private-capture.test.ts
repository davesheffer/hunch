import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bugId, decisionId } from "../src/core/ids.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Bug, Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { captureTestRun, recordFailure, syncCommit } from "../src/synthesis/synthesize.js";

process.env.HUNCH_SYNTH_PROVIDER = "deterministic";

function privateStore(): { root: string; store: HunchStore; cleanup: () => void } {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-private-capture-"));
  const root = join(sandbox, "repository");
  const overlay = join(sandbox, "private-memory", ".hunch");
  mkdirSync(overlay, { recursive: true });
  execFileSync("git", ["init", "-q", join(sandbox, "private-memory")]);
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, autoCommit: false }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, store, cleanup: () => { store.close(); rmSync(sandbox, { recursive: true, force: true }); } };
}

test("private bug capture stays in the overlay and never invokes a subscription provider", async () => {
  const { root, store, cleanup } = privateStore();
  try {
    const result = await recordFailure(store, root, {
      test: "billing rejects private token",
      message: "sensitive stack detail",
    }, { private: true });
    assert.equal(result.provider, "deterministic");
    assert.ok(store.getPrivateRec("bugs", result.bug.id), "private bug was written to the overlay");
    assert.equal(store.json.get("bugs", result.bug.id), undefined, "private bug never reached public .hunch");
  } finally { cleanup(); }
});

test("private bug recurrence only consults private bug history", async () => {
  const { root, store, cleanup } = privateStore();
  try {
    const first = await recordFailure(store, root, { test: "private first", message: "billing token leaks" }, { private: true });
    const second = await recordFailure(store, root, { test: "private second", message: "billing token leaks" }, { private: true });
    assert.equal(second.bug.lineage.recurrence_of, first.bug.id);
    assert.ok(store.getPrivateRec("constraints", second.bug.lineage.spawned_constraint ?? ""), "private recurrence promoted only a private constraint");
  } finally { cleanup(); }
});

test("public failure capture and pass resolution never mutate a same-id private bug", async () => {
  const { root, store, cleanup } = privateStore();
  try {
    const symptom = "checkout transport times out while finalizing payment";
    const prior = await recordFailure(store, root, { test: "public prior", message: symptom });
    store.reindex();
    const targetId = bugId("public target");
    const privateSentinel: Bug = {
      ...prior.bug,
      id: targetId,
      title: "PRIVATE SENTINEL",
      symptom: "unrelated private failure",
      status: "open",
      lineage: { ...prior.bug.lineage, detected: "public target", recurrence_of: null, spawned_constraint: null },
    };
    store.putPrivate("bugs", privateSentinel);
    const privateBefore = JSON.stringify(store.getPrivateRec("bugs", targetId));

    const captured = await recordFailure(store, root, { test: "public target", message: symptom });
    assert.ok(captured.constraint, "public recurrence exercises the post-promotion bug rewrite");
    assert.deepEqual(captured.touchedHomes, ["public"]);
    assert.ok(store.json.get("bugs", targetId)?.lineage.spawned_constraint);
    assert.equal(JSON.stringify(store.getPrivateRec("bugs", targetId)), privateBefore,
      "public post-promotion rewrite cannot overwrite the private collision");

    const resolved = await captureTestRun(store, root, {
      report: { failures: [], passed: ["public target"], recognized: true },
      status: 0,
      cmd: "fixture",
      output: "",
    });
    assert.deepEqual(resolved.touchedHomes, ["public"]);
    assert.equal(store.json.get("bugs", targetId)?.status, "fixed");
    assert.equal(store.getPrivateRec("bugs", targetId)?.status, "open");
  } finally { cleanup(); }
});

test("private failure seeds a component shadow and raises fragility only in the private home", async () => {
  const { root, store, cleanup } = privateStore();
  try {
    store.json.replaceAll("symbols", [{
      id: "sym_private_failure", file: "src/private.ts", name: "privateFailure", kind: "function",
      signature_hash: "", calls: [], called_by: [], metrics: { loc: 5, churn_90d: 1, bug_count: 0, fan_in: 1, fan_out: 0 }, last_changed: "",
    }] as never);
    const component = {
      id: "cmp_collision", kind: "module", name: "Collision", responsibility: "", paths: ["src/**"], status: "active",
      owners: [], fragility: 0, provenance: { source: "extracted", confidence: 0.6, evidence: [] },
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    } as const;
    store.json.put("components", component as never);
    assert.equal(store.getPrivateRec("components", component.id), undefined,
      "normal overlays begin without a duplicate component graph");

    const result = await recordFailure(store, root, {
      test: "private fragility",
      message: "privateFailure exposed a sensitive failure",
    }, { private: true });
    assert.deepEqual(result.touchedHomes, ["private"]);
    assert.equal(store.json.get("components", component.id)?.fragility, 0);
    assert.ok((store.getPrivateRec("components", component.id)?.fragility ?? 0) > 0);
  } finally { cleanup(); }
});

test("private sync preserves a human-confirmed overlay decision even under --force", async () => {
  const { root, store, cleanup } = privateStore();
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "billing.ts"), "export const total = (n: number) => n * 1.2;\n");
    git("add", ".");
    git("commit", "-qm", "feat: add billing");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const now = new Date().toISOString();
    const privateDecision: Decision = {
      id: decisionId(sha), title: "Human private billing decision", topic: null, status: "accepted",
      context: "", decision: "Keep the billing workflow private.", consequences: [], alternatives_rejected: [], rejected_tripwires: [],
      related_components: [], related_files: ["src/billing.ts"], supersedes: null, superseded_by: null,
      caused_by_bug: null, commit: sha, valid_from: now, valid_to: null, retired: { symbols: [], deps: [] },
      provenance: { source: "human_confirmed", confidence: 1, evidence: [] }, date: now,
    };
    store.putPrivate("decisions", privateDecision);
    const result = await syncCommit(store, root, sha, { private: true, force: true });
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /human-confirmed/i);
    assert.equal(store.getPrivateRec("decisions", privateDecision.id)?.title, privateDecision.title);
  } finally { cleanup(); }
});
