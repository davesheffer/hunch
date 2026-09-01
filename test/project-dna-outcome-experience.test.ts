import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectDnaUsefulnessObservationSchema,
  assertProjectDnaUsefulnessObservation,
  createProjectDnaUsefulnessObservation,
  projectDnaUsefulnessObservationFinding,
} from "../src/core/projectDnaOutcomeExperience.js";

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const input = {
  episode: {
    provider: "orc",
    schemaVersion: "orc.eval-episode/1",
    episodeId: "eep_1234567890abcdef12345678",
    episodeHash: hash("1"),
    terminalAt: "2026-09-01T10:00:00.000Z",
    result: "pass" as const,
  },
  delivery: {
    receiptRef: `hunch-memory:hmctx_${"2".repeat(32)}`,
    receiptHash: hash("3"),
    repositoryId: `pdnar_${"4".repeat(24)}`,
    repositoryRevision: "5".repeat(40),
    profileId: `pdna_${"6".repeat(24)}`,
    profileContentHash: hash("7"),
    snapshotHash: hash("8"),
    retrievalHash: hash("9"),
  },
  projection: {
    role: "implementation",
    categories: ["engineering", "review", "vocabulary"] as const,
    traitIds: [`pdnat_${"a".repeat(20)}`],
    evidenceHashes: [hash("b")],
  },
  artifact: {
    kind: "pull_request" as const,
    ref: "github:pull-request:340",
    contentHash: hash("c"),
  },
  assessment: {
    schemaVersion: "orc.project-dna-downstream-assessment/1",
    assessmentId: `pdnaa_${"d".repeat(24)}`,
    contentHash: hash("e"),
    projectMatchClassification: "conformant" as const,
    causalInterpretation: "project_match_is_non_causal" as const,
  },
  signal: "used" as const,
  evidence: [{
    kind: "explicit_human_observation" as const,
    ref: "orc:project-dna-assessment:pdua_example",
    hash: hash("f"),
  }],
  observedAt: "2026-09-01T10:05:00.000Z",
  retainUntil: "2027-08-31T10:05:00.000Z",
  privacy: {
    payloadMode: "references_hashes_only" as const,
    rawArtifactIncluded: false as const,
    rawFeedbackIncluded: false as const,
    rawProfileIncluded: false as const,
  },
};

test("Project DNA usefulness is deterministic and binds delivery, projection, artifact and assessment", () => {
  const first = createProjectDnaUsefulnessObservation(input);
  const replay = createProjectDnaUsefulnessObservation(structuredClone(input));
  assert.deepEqual(replay, first);
  assert.match(first.observationId, /^pduo_[a-f0-9]{24}$/);
  assert.match(first.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.authority.behavioralEffect, "none");
  assert.doesNotThrow(() => assertProjectDnaUsefulnessObservation(first));
});

test("Project Match alone cannot manufacture a classified usefulness signal", () => {
  assert.throws(
    () => createProjectDnaUsefulnessObservation({ ...input, evidence: [] }),
    /requires explicit human or independent review evidence/,
  );
  const unknown = createProjectDnaUsefulnessObservation({ ...input, signal: "unknown", evidence: [] });
  assert.equal(unknown.signal, "unknown");
  assert.equal(unknown.assessment.causalInterpretation, "project_match_is_non_causal");
});

test("unsafe, partial, duplicate and tampered Project DNA usefulness fails closed", () => {
  assert.throws(() => createProjectDnaUsefulnessObservation({
    ...input,
    evidence: [{ ...input.evidence[0], ref: "https://user:password@example.test/proof" }],
  }), /credential material/);
  assert.throws(() => createProjectDnaUsefulnessObservation({
    ...input,
    projection: { ...input.projection, traitIds: [input.projection.traitIds[0], input.projection.traitIds[0]] },
  }), /contains duplicates/);
  assert.equal(ProjectDnaUsefulnessObservationSchema.safeParse({
    ...createProjectDnaUsefulnessObservation(input),
    mayCreatePolicy: true,
  }).success, false);
  const tampered = createProjectDnaUsefulnessObservation(input);
  tampered.delivery.snapshotHash = hash("0");
  assert.throws(() => assertProjectDnaUsefulnessObservation(tampered), /seal is invalid/);
});

test("only contradiction or staleness creates advisory Project DNA review work", () => {
  const contradicted = createProjectDnaUsefulnessObservation({ ...input, signal: "contradicted" });
  const finding = projectDnaUsefulnessObservationFinding(contradicted);
  assert.equal(finding?.triage, "open");
  assert.equal(finding?.severity, "high");
  assert.deepEqual(finding?.affected_symbols, input.projection.traitIds);
  assert.equal(finding?.provenance.source, "project_dna_outcome_experience+candidate");
  for (const signal of ["used", "prevented", "near_miss", "unused", "unknown"] as const) {
    const observation = createProjectDnaUsefulnessObservation({
      ...input,
      signal,
      evidence: signal === "unknown" ? [] : input.evidence,
    });
    assert.equal(projectDnaUsefulnessObservationFinding(observation), null);
  }
});
