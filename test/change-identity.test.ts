import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertChangeIdentity,
  changesAreEquivalent,
  deriveChangeIdentity,
} from "../src/core/changeIdentity.js";
import { createUsefulnessObservation } from "../src/core/outcomeExperience.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch test",
  GIT_AUTHOR_EMAIL: "hunch@example.test",
  GIT_COMMITTER_NAME: "Hunch test",
  GIT_COMMITTER_EMAIL: "hunch@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("an exact branch delta and its squash commit share one change identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-change-id-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const source = join(root, "value.ts");
  writeFileSync(source, "export const value = 0;\n");
  git(root, "add", "value.ts");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "switch", "-qc", "feature");
  writeFileSync(source, "export const value = 1;\n");
  git(root, "add", "value.ts");
  git(root, "commit", "-qm", "first feature commit");
  writeFileSync(source, "export const value = 1;\nexport const enabled = true;\n");
  git(root, "add", "value.ts");
  git(root, "commit", "-qm", "second feature commit");
  const feature = git(root, "rev-parse", "HEAD");

  git(root, "switch", "-qc", "squash", base);
  git(root, "merge", "--squash", feature);
  git(root, "commit", "-qm", "one squashed change with unrelated metadata");
  const squash = git(root, "rev-parse", "HEAD");

  const branchIdentity = deriveChangeIdentity(root, base, feature);
  const squashIdentity = deriveChangeIdentity(root, base, squash);
  assert.notEqual(branchIdentity.head_revision, squashIdentity.head_revision);
  assert.equal(branchIdentity.change_id, squashIdentity.change_id);
  assert.equal(branchIdentity.delta_hash, squashIdentity.delta_hash);
  assert.equal(branchIdentity.paths_hash, squashIdentity.paths_hash);
  assert.equal(branchIdentity.file_count, 1);
  assert.equal(changesAreEquivalent(branchIdentity, squashIdentity), true);
  assert.doesNotThrow(() => assertChangeIdentity(branchIdentity));

  const observation = createUsefulnessObservation({
    episode: {
      provider: "orc",
      schemaVersion: "orc.eval-episode/1",
      episodeId: "eep_change_identity_1234567890",
      episodeHash: `sha256:${"1".repeat(64)}`,
      terminalAt: "2026-08-28T00:00:00.000Z",
      result: "pass",
    },
    delivery: {
      receiptRef: `hunch-memory:hmctx_${"2".repeat(32)}`,
      receiptHash: `sha256:${"3".repeat(64)}`,
      graphRevision: base,
      sourceRevision: base,
      sourceContentHash: `sha256:${"4".repeat(64)}`,
    },
    record: {
      recordId: "dec_change_identity",
      recordKind: "decision",
      recordRevision: `sha256:${"5".repeat(64)}`,
      contentHash: `sha256:${"6".repeat(64)}`,
    },
    change: squashIdentity,
    signal: "used",
    evidence: [{ kind: "verification", ref: "verification:change-id", hash: `sha256:${"7".repeat(64)}` }],
    observedAt: "2026-08-28T00:01:00.000Z",
    retainUntil: "2027-08-27T00:01:00.000Z",
    privacy: { payloadMode: "references_hashes_only", rawTranscriptIncluded: false, rawProviderOutputIncluded: false },
  });
  assert.equal(observation.change?.change_id, branchIdentity.change_id, "outcome attribution carries the squash-stable identity");

  const cli = spawnSync(process.execPath, [
    join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs"),
    join(import.meta.dirname, "../src/cli/index.ts"),
    "change-id",
    base,
    squash,
    "--json",
  ], { cwd: root, encoding: "utf8", env: gitEnv });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), squashIdentity, "CLI returns the same sealed contract as the library");
});

test("exact change identity distinguishes whitespace/blob changes even when Git patch identity is looser", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-change-id-exact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const source = join(root, "value.ts");
  writeFileSync(source, "export const value = 0;\n");
  git(root, "add", "value.ts");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "switch", "-qc", "compact");
  writeFileSync(source, "export const value=1;\n");
  git(root, "add", "value.ts");
  git(root, "commit", "-qm", "compact form");
  const compact = deriveChangeIdentity(root, base, "HEAD");

  git(root, "switch", "-qc", "spaced", base);
  writeFileSync(source, "export const value = 1;\n");
  git(root, "add", "value.ts");
  git(root, "commit", "-qm", "spaced form");
  const spaced = deriveChangeIdentity(root, base, "HEAD");

  assert.notEqual(compact.delta_hash, spaced.delta_hash);
  assert.notEqual(compact.change_id, spaced.change_id);
  assert.equal(changesAreEquivalent(compact, spaced), false);

  const tampered = structuredClone(compact);
  tampered.paths_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => assertChangeIdentity(tampered), /seal is invalid/);
  assert.throws(() => deriveChangeIdentity(root, base, base), /empty/);
  assert.throws(() => deriveChangeIdentity(root, "does-not-exist"), /derive exact Git change identity/);
});
