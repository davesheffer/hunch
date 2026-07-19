import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConstitutionService } from "../src/constitution/service.js";
import { canonicalStaticGraphBaseline } from "../src/constitution/staticGraphBaseline.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { indexRepo } from "../src/extractors/indexer.js";
import { HunchStore } from "../src/store/hunchStore.js";

const NOW = "2026-07-19T12:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configure(root: string): void {
  git(root, "config", "user.email", "static-baseline@test.invalid");
  git(root, "config", "user.name", "Static Baseline Test");
}

function decision(commit: string): Decision {
  return {
    id: "dec_static_graph_baseline",
    title: "Order controllers must use OrderService for persistence",
    topic: "orders.controller-db-boundary",
    status: "accepted",
    context: "A direct controller-to-DB optimization reintroduced the N+1 incident.",
    decision: "Controllers reach persistence through the service boundary.",
    consequences: [],
    alternatives_rejected: ["Direct database access from controllers."],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/api/orders.ts", "src/services/orders.ts", "src/db/client.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: "bug_n_plus_one",
    commit,
    valid_from: NOW,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: [{ assert: "not-calls", subject: "listOrders", object: "dbQuery", transitive: false }],
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-static-baseline"] },
    date: NOW,
  };
}

function plan(root: string, store: HunchStore, policyId: string) {
  indexRepo(store, root, { churn: false });
  store.reindex();
  return new ConstitutionService(store, root).plan(policyId, {
    publicOnly: true,
    now: NOW,
  });
}

test("static plans converge across clones but code, reverts, and merges advance the canonical graph baseline", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-static-baseline-"));
  const remote = join(sandbox, "origin.git");
  const seed = join(sandbox, "seed");
  const cloneA = join(sandbox, "clone-a");
  const cloneB = join(sandbox, "clone-b");
  let storeA: HunchStore | null = null;
  let storeB: HunchStore | null = null;
  try {
    git(sandbox, "init", "--bare", "-q", "--initial-branch=main", remote);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    configure(seed);
    git(seed, "remote", "add", "origin", remote);
    mkdirSync(join(seed, "src/api"), { recursive: true });
    mkdirSync(join(seed, "src/services"), { recursive: true });
    mkdirSync(join(seed, "src/db"), { recursive: true });
    writeFileSync(join(seed, "src/db/client.ts"), "export function dbQuery(sql: string){ return sql; }\n");
    writeFileSync(join(seed, "src/services/orders.ts"), [
      'import { dbQuery } from "../db/client.js";',
      "export function fetchOrders(user: string){ return dbQuery(user); }",
      "",
    ].join("\n"));
    writeFileSync(join(seed, "src/api/orders.ts"), [
      'import { fetchOrders } from "../services/orders.js";',
      "export function listOrders(user: string){ return fetchOrders(user); }",
      "",
    ].join("\n"));
    writeFileSync(join(seed, "AGENTS.md"), "# Team grounding\n");
    writeFileSync(join(seed, ".gitignore"), ".hunch/hunch.sqlite*\n.hunch-cache/\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "feat: layered order path");
    const commonCodeCommit = git(seed, "rev-parse", "HEAD");

    const seedStore = new HunchStore(hunchPaths(seed));
    seedStore.json.ensureDirs();
    indexRepo(seedStore, seed, { churn: false });
    seedStore.json.put("decisions", decision(commonCodeCommit));
    seedStore.reindex();
    const policy = new ConstitutionService(seedStore, seed).compile("dec_static_graph_baseline", {
      through: "fetchOrders",
      now: NOW,
    });
    seedStore.close();
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "hunch: publish policy memory");
    const policyPublicationCommit = git(seed, "rev-parse", "HEAD");
    assert.equal(canonicalStaticGraphBaseline(seed, policyPublicationCommit), commonCodeCommit,
      "an explicit memory-only source ref canonicalizes independently of current HEAD");
    git(seed, "push", "-qu", "origin", "main");

    git(sandbox, "clone", "-q", remote, cloneA);
    git(sandbox, "clone", "-q", remote, cloneB);
    configure(cloneA);
    configure(cloneB);
    storeA = new HunchStore(hunchPaths(cloneA));
    storeB = new HunchStore(hunchPaths(cloneB));

    const originalA = plan(cloneA, storeA, policy.id);
    const originalB = plan(cloneB, storeB, policy.id);
    assert.equal(originalA.id, originalB.id);
    assert.equal(originalA.corpus.current_baseline.ref, commonCodeCommit);
    assert.equal(originalB.corpus.current_baseline.ref, commonCodeCommit);

    storeA.json.put("decisions", {
      ...decision(commonCodeCommit),
      id: "dec_clone_local_memory",
      title: "Clone-local memory publication",
      topic: "clone.local.memory",
    });
    writeFileSync(join(cloneA, "AGENTS.md"), "# Team grounding\n\nHunch counts refreshed.\n");
    git(cloneA, "add", "-A");
    git(cloneA, "commit", "-qm", "hunch: local graph and grounding refresh");
    assert.equal(canonicalStaticGraphBaseline(cloneA), commonCodeCommit);
    const afterMemory = plan(cloneA, storeA, policy.id);
    assert.equal(afterMemory.id, originalB.id, ".hunch and generated grounding commits cannot fork a shared plan id");
    assert.equal(git(cloneA, "cat-file", "-t", `${afterMemory.corpus.current_baseline.ref}^{commit}`), "commit");
    assert.equal(git(cloneB, "cat-file", "-t", `${afterMemory.corpus.current_baseline.ref}^{commit}`), "commit",
      "the selected plan ref must resolve in every source-equivalent clone");
    const evaluationA = new ConstitutionService(storeA, cloneA).evaluate({ id: policy.id, publicOnly: true })[0]!.evaluation;
    const evaluationB = new ConstitutionService(storeB, cloneB).evaluate({ id: policy.id, publicOnly: true })[0]!.evaluation;
    assert.equal(evaluationA.repository.head, commonCodeCommit);
    assert.equal(evaluationB.repository.head, commonCodeCommit);
    assert.equal(evaluationA.repository.graph_hash, evaluationB.repository.graph_hash);
    assert.equal(evaluationA.deterministic_hash, evaluationB.deterministic_hash,
      "clone-local public-memory commits cannot fork a static evaluation receipt");

    writeFileSync(join(cloneA, "README.md"), "# Ordinary docs-only change\n");
    git(cloneA, "add", "README.md");
    git(cloneA, "commit", "-qm", "docs: explain the fixture");
    assert.equal(canonicalStaticGraphBaseline(cloneA), commonCodeCommit);
    assert.equal(plan(cloneA, storeA, policy.id).id, originalB.id, "ordinary non-indexed docs do not churn a static plan");

    writeFileSync(join(cloneA, "src/api/orders.ts"), [
      'import { fetchOrders } from "../services/orders.js";',
      "export function listOrders(user: string){ return fetchOrders(user.trim()); }",
      "",
    ].join("\n"));
    git(cloneA, "add", "src/api/orders.ts");
    git(cloneA, "commit", "-qm", "feat: normalize order user");
    const codeCommit = git(cloneA, "rev-parse", "HEAD");
    const afterCode = plan(cloneA, storeA, policy.id);
    assert.equal(afterCode.corpus.current_baseline.ref, codeCommit);
    assert.equal(afterCode.source_commit, commonCodeCommit,
      "the canonicalized source stays anchored after a later code boundary advances HEAD");
    assert.notEqual(afterCode.id, originalB.id, "an indexed-code change creates a new plan baseline");

    git(cloneA, "revert", "--no-edit", codeCommit);
    const revertCommit = git(cloneA, "rev-parse", "HEAD");
    const afterRevert = plan(cloneA, storeA, policy.id);
    assert.equal(afterRevert.corpus.current_baseline.ref, revertCommit);
    assert.notEqual(afterRevert.id, originalB.id, "a code revert is evidence, not endpoint-tree equivalence");
    assert.notEqual(afterRevert.id, afterCode.id);

    git(cloneA, "switch", "-qc", "feature-merge", revertCommit);
    writeFileSync(join(cloneA, "src/api/orders.ts"), [
      'import { fetchOrders } from "../services/orders.js";',
      "export function listOrders(user: string){ return fetchOrders(`feature:${user}`); }",
      "",
    ].join("\n"));
    git(cloneA, "add", "src/api/orders.ts");
    git(cloneA, "commit", "-qm", "feat: feature order namespace");
    git(cloneA, "switch", "-q", "main");
    writeFileSync(join(cloneA, "src/api/orders.ts"), [
      'import { fetchOrders } from "../services/orders.js";',
      "export function listOrders(user: string){ return fetchOrders(`main:${user}`); }",
      "",
    ].join("\n"));
    git(cloneA, "add", "src/api/orders.ts");
    git(cloneA, "commit", "-qm", "feat: main order namespace");
    const merge = spawnSync("git", ["merge", "--no-ff", "--no-edit", "feature-merge"], {
      cwd: cloneA,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.notEqual(merge.status, 0, "fixture must exercise a real merge-resolution boundary");
    writeFileSync(join(cloneA, "src/api/orders.ts"), [
      'import { fetchOrders } from "../services/orders.js";',
      "export function listOrders(user: string){ return fetchOrders(`resolved:${user}`); }",
      "",
    ].join("\n"));
    git(cloneA, "add", "src/api/orders.ts");
    git(cloneA, "commit", "-qm", "merge: resolve order namespaces");
    const mergeCommit = git(cloneA, "rev-parse", "HEAD");
    assert.ok(git(cloneA, "rev-list", "--parents", "-n", "1", mergeCommit).split(/\s+/).length > 2);
    assert.equal(canonicalStaticGraphBaseline(cloneA), mergeCommit, "a merge is always a conservative graph boundary");
    assert.equal(plan(cloneA, storeA, policy.id).corpus.current_baseline.ref, mergeCommit);
  } finally {
    storeA?.close();
    storeB?.close();
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("a repository with no indexed code anchors its empty graph to the shared root commit", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-static-no-code-"));
  try {
    git(root, "init", "-q", "-b", "main");
    configure(root);
    writeFileSync(join(root, "README.md"), "# docs only\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "docs: root");
    const rootCommit = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "NOTES.md"), "still no indexed code\n");
    git(root, "add", "NOTES.md");
    git(root, "commit", "-qm", "docs: notes");
    assert.equal(canonicalStaticGraphBaseline(root), rootCommit);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("clone-local replacement refs cannot move a docs-only static baseline or proof plan", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-static-replace-ref-"));
  let store: HunchStore | null = null;
  try {
    git(root, "init", "-q", "-b", "main");
    configure(root);
    mkdirSync(join(root, "src/api"), { recursive: true });
    writeFileSync(join(root, "src/api/orders.ts"), [
      "export function dbQuery(sql: string){ return sql; }",
      "export function listOrders(user: string){ return user; }",
      "",
    ].join("\n"));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "feat: stable code boundary");
    const codeCommit = git(root, "rev-parse", "HEAD");

    store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    indexRepo(store, root, { churn: false });
    store.json.put("decisions", decision(codeCommit));
    store.reindex();
    const policy = new ConstitutionService(store, root).compile("dec_static_graph_baseline", { now: NOW });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "hunch: docs-only policy publication");
    const docsCommit = git(root, "rev-parse", "HEAD");
    const before = plan(root, store, policy.id);
    assert.equal(before.corpus.current_baseline.ref, codeCommit);

    // Build an alternate commit with the same real parent as the docs commit,
    // but a code-changing tree. A local replacement ref makes ordinary Git
    // traversal pretend docsCommit is this object without creating a parent
    // cycle or changing the checked-out source bytes.
    writeFileSync(join(root, "src/api/orders.ts"), [
      "export function dbQuery(sql: string){ return sql; }",
      "export function listOrders(user: string){ return dbQuery(user); }",
      "",
    ].join("\n"));
    git(root, "add", "src/api/orders.ts");
    const replacementTree = git(root, "write-tree");
    const replacementCommit = git(root, "commit-tree", replacementTree, "-p", codeCommit, "-m", "local replacement view");
    git(root, "reset", "--hard", docsCommit);
    git(root, "replace", docsCommit, replacementCommit);

    assert.match(git(root, "show", `${docsCommit}:src/api/orders.ts`), /return dbQuery\(user\)/,
      "fixture proves ordinary Git reads the replacement object's code-changing tree");
    assert.equal(canonicalStaticGraphBaseline(root, docsCommit), codeCommit,
      "the canonical baseline traverses the real object graph, not refs/replace");
    const after = plan(root, store, policy.id);
    assert.equal(after.corpus.current_baseline.ref, codeCommit);
    assert.equal(after.source_commit, codeCommit);
    assert.equal(after.id, before.id, "a clone-local replacement view cannot fork canonical proof-plan identity");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
