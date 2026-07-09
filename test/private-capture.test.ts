import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decisionId } from "../src/core/ids.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { recordFailure, syncCommit } from "../src/synthesis/synthesize.js";

function privateStore(): { root: string; store: HunchStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-private-capture-"));
  const overlay = join(root, "private-memory", ".hunch");
  mkdirSync(join(root, ".hunch"), { recursive: true });
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ privateDir: overlay, autoCommit: false }) + "\n");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
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
