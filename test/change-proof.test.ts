import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deriveChangeProof } from "../src/core/changeProof.js";
import { ChangeProofSchema, assertChangeProof } from "../src/core/changeProofContract.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { mkConstraint } from "./helpers.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch proof test",
  GIT_AUTHOR_EMAIL: "hunch-proof@example.test",
  GIT_COMMITTER_NAME: "Hunch proof test",
  GIT_COMMITTER_EMAIL: "hunch-proof@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function decision(id: string, relatedFiles: string[], conformance: unknown[]): Decision {
  return {
    id,
    title: id,
    topic: null,
    status: "accepted",
    context: "",
    decision: "",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: relatedFiles,
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: conformance as Decision["conformance"],
    provenance: { source: "human_confirmed", confidence: 1, evidence: [] },
    date: "2024-01-01T00:00:00.000Z",
  };
}

function proofRepo(
  t: TestContext,
  baseSource: string | Buffer,
  resultSource: string | Buffer,
  options: { privateOverlay?: boolean } = {},
): { root: string; store: HunchStore; base: string; result: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-change-proof-"));
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "src/shared.ts"), baseSource);
  writeFileSync(
    join(root, "src/use.ts"),
    'import { sharedValue } from "./shared.js";\nexport function useValue(){ return sharedValue(); }\n',
  );
  git(root, "add", "src");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src/shared.ts"), resultSource);
  git(root, "add", "src/shared.ts");
  git(root, "commit", "-qm", "result");
  const result = git(root, "rev-parse", "HEAD");
  const privateDir = options.privateOverlay ? mkdtempSync(join(tmpdir(), "hunch-change-proof-private-")) : null;
  if (privateDir) {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch/local.json"), JSON.stringify({ privateDir }));
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  t.after(() => {
    store.close();
    cleanupDir(root);
    if (privateDir) cleanupDir(privateDir);
  });
  return { root, store, base, result };
}

test("published hunch.change-proof/1 transport fixture retains its structural and cryptographic seals", () => {
  const contractDir = join(import.meta.dirname, "../contracts/change-proof");
  const example = JSON.parse(readFileSync(join(contractDir, "hunch.change-proof.v1.example.json"), "utf8"));
  const schema = JSON.parse(readFileSync(join(contractDir, "hunch.change-proof.v1.schema.json"), "utf8")) as {
    $schema: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.doesNotThrow(() => ChangeProofSchema.parse(example));
  assert.doesNotThrow(() => assertChangeProof(example));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(
    [...schema.required].sort(),
    Object.keys(schema.properties).sort(),
    "every published top-level proof field is required",
  );
  assert.deepEqual(Object.keys(example).sort(), schema.required.sort());
});

test("native change proof deterministically binds exact revisions, DNA, memory, blast radius, and conformance", (t) => {
  const fixture = proofRepo(
    t,
    "export function sharedValue(){ return 1; }\n",
    "export function sharedValue(){ return 2; }\n",
  );
  fixture.store.json.put("decisions", decision(
    "dec_required_use_value",
    ["src/shared.ts"],
    [{ assert: "exists", subject: "useValue", transitive: false }],
  ));
  fixture.store.json.put("constraints", mkConstraint({
    id: "con_shared_runtime",
    statement: "Shared runtime changes require review",
    scope: ["src/shared.ts"],
    severity: "warning",
  }));

  const first = deriveChangeProof(fixture.root, fixture.store, fixture.base, fixture.result);
  const second = deriveChangeProof(fixture.root, fixture.store, fixture.base, fixture.result);
  assert.deepEqual(second, first, "the same exact inputs yield the same proof bytes");
  assert.doesNotThrow(() => assertChangeProof(first));
  assert.equal(first.schema, "hunch.change-proof/1");
  assert.equal(first.verdict, "pass");
  assert.equal(first.repository.base_revision, fixture.base);
  assert.equal(first.repository.result_revision, fixture.result);
  assert.deepEqual(first.changed_files, ["src/shared.ts"]);
  assert.ok(first.blast_radius.some((entry) => entry.dependent_path === "src/use.ts"));
  assert.deepEqual(first.decisions.map((entry) => entry.id), ["dec_required_use_value"]);
  assert.deepEqual(first.constraints.map((entry) => entry.id), ["con_shared_runtime"]);
  assert.equal(first.conformance[0]?.satisfied, true);
  assert.deepEqual(Object.values(first.authority), [false, false, false, false, false, false, false]);

  const cli = spawnSync(process.execPath, [
    join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs"),
    join(import.meta.dirname, "../src/cli/index.ts"),
    "prove",
    fixture.base,
    fixture.result,
    "--json",
  ], { cwd: fixture.root, encoding: "utf8", env: gitEnv });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), first, "CLI returns the canonical library artifact");

  writeFileSync(join(fixture.root, "src/use.ts"), "uncommitted checkout bytes must not affect a pinned proof\n");
  assert.deepEqual(
    deriveChangeProof(fixture.root, fixture.store, fixture.base, fixture.result),
    first,
    "proof derivation reads both semantic graphs from commits, not the checkout",
  );

  const tampered = structuredClone(first) as unknown as { engine: { version: string } };
  tampered.engine.version = "forged";
  assert.throws(() => assertChangeProof(tampered), /seal is invalid/);
});

test("native change proof fails when the result graph violates recorded intent", (t) => {
  const fixture = proofRepo(
    t,
    "export function sharedValue(){ return 1; }\n",
    "export function replacementValue(){ return 1; }\n",
  );
  fixture.store.json.put("decisions", decision(
    "dec_shared_value_exists",
    ["src/shared.ts"],
    [{ assert: "exists", subject: "sharedValue", transitive: false }],
  ));

  const proof = deriveChangeProof(fixture.root, fixture.store, fixture.base, fixture.result);
  assert.equal(proof.guard.verdict, "pass");
  assert.equal(proof.conformance[0]?.satisfied, false);
  assert.equal(proof.verdict, "fail");
  assert.doesNotThrow(() => assertChangeProof(proof));
});

test("public proof transport excludes private-overlay records at every proof boundary", (t) => {
  const fixture = proofRepo(
    t,
    "export function sharedValue(){ return 1; }\n",
    "export function sharedValue(){ return 2; }\n",
    { privateOverlay: true },
  );
  fixture.store.json.put("decisions", decision("dec_public_runtime", ["src/shared.ts"], []));
  fixture.store.putPrivate("decisions", decision("dec_private_strategy", ["src/shared.ts"], []));
  fixture.store.json.put("constraints", mkConstraint({
    id: "con_public_runtime",
    scope: ["src/shared.ts"],
  }));
  fixture.store.putPrivate("constraints", mkConstraint({
    id: "con_private_strategy",
    statement: "SENSITIVE private strategy",
    scope: ["src/shared.ts"],
  }));

  const local = deriveChangeProof(fixture.root, fixture.store, fixture.base, fixture.result);
  const published = deriveChangeProof(
    fixture.root,
    fixture.store,
    fixture.base,
    fixture.result,
    { publicOnly: true },
  );
  assert.equal(local.memory.scope, "union");
  assert.deepEqual(local.decisions.map((entry) => entry.id), ["dec_private_strategy", "dec_public_runtime"]);
  assert.deepEqual(local.constraints.map((entry) => entry.id), ["con_private_strategy", "con_public_runtime"]);
  assert.equal(published.memory.scope, "public");
  assert.deepEqual(published.decisions.map((entry) => entry.id), ["dec_public_runtime"]);
  assert.deepEqual(published.constraints.map((entry) => entry.id), ["con_public_runtime"]);
  assert.doesNotMatch(JSON.stringify(published), /private_strategy|SENSITIVE/);
  assert.notEqual(published.proof_id, local.proof_id);
  assert.notEqual(published.memory.records_hash, local.memory.records_hash);
});

test("native change proof reports unknown instead of passing an incomplete semantic graph", (t) => {
  const fixture = proofRepo(
    t,
    "export function sharedValue(){ return 1; }\n",
    Buffer.from([0xff, 0xfe, 0xfd]),
  );

  const proof = deriveChangeProof(fixture.root, fixture.store, fixture.base, fixture.result);
  assert.equal(proof.guard.verdict, "pass");
  assert.equal(proof.verdict, "unknown");
  assert.ok(proof.unknowns.some((gap) => gap.code === "result_graph_invalid_encoding"));
  assert.doesNotThrow(() => assertChangeProof(proof));
});
