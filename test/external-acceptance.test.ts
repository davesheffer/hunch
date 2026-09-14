import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPOSITORY_USER_SCHEMA,
  SOFIA_GATE5_SCHEMA,
  digestFile,
  evaluateEvidence,
  sealEvidence,
} from "../tooling/external-acceptance.mjs";

const commit = "a".repeat(40);
const hash = `sha256:${"b".repeat(64)}`;
const tool = fileURLToPath(new URL("../tooling/external-acceptance.mjs", import.meta.url));

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "hunch-external-acceptance-"));
  const artifact = (name: string, body = name) => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return { path: name, sha256: digestFile(file) };
  };
  return { dir, artifact, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function repositoryUserRecord(artifact: (name: string) => { path: string; sha256: string }) {
  const session = (n: number, elapsed: number) => ({
    case_id: `case-${n}`,
    participant_id: `participant-${n}`,
    repository_id: `repository-${n}`,
    repository_revision: commit,
    task_id: `htask_${String(n).repeat(24)}`,
    report_hash: hash,
    report_artifact: artifact(`report-${n}.html`),
    host: { name: "Codex CLI", version: "0.154.0", os: "Darwin arm64" },
    report_shown_at: `2026-09-14T10:0${n}:00.000Z`,
    completed_at: `2026-09-14T10:0${n}:${String(elapsed / 1000).padStart(2, "0")}.000Z`,
    elapsed_ms: elapsed,
    timer_source: "monotonic",
    coaching_after_report: false,
    answers: {
      connection_state: "Connected: the card has a recalled lesson and exact task evidence.",
      connection_state_correct: true,
      supported_contribution: "The configuration-preservation rule held on the changed file.",
      supported_contribution_correct: true,
      evidence_opened: true,
      evidence_target: "Rule-supported application detail",
    },
  });
  return {
    schema: REPOSITORY_USER_SCHEMA,
    id: null,
    content_hash: null,
    candidate: { hunch_version: "1.33.0", hunch_commit: commit, package_sha256: hash },
    recorded_at: "2026-09-14T11:00:00.000Z",
    moderation: { moderator_id: "moderator-1", questions_read_verbatim: true },
    sessions: [session(1, 10_000), session(2, 20_000)],
    disposition: { status: "pass", reason: "Both users completed the three uncoached actions within 30 seconds." },
    privacy: { contains_raw_transcript: false, contains_credentials: false, local_only: true },
  };
}

test("repository-user evidence seals only two distinct, uncoached, sub-30-second sessions", () => {
  const w = workspace();
  try {
    const sealed = sealEvidence(repositoryUserRecord(w.artifact), { checkArtifacts: true, baseDir: w.dir });
    const result = evaluateEvidence(sealed, { checkArtifacts: true, baseDir: w.dir });
    assert.equal(result.structurally_valid, true);
    assert.equal(result.acceptance_ready, true);
    assert.match(sealed.id, /^hrua_[a-f0-9]{16}$/);

    const tampered = structuredClone(sealed);
    tampered.sessions[0].answers.connection_state += " changed";
    assert.equal(evaluateEvidence(tampered).structurally_valid, false);
    assert.match(evaluateEvidence(tampered).errors.join("\n"), /content_hash does not match/);
  } finally { w.close(); }
});

test("the CLI creates a private draft and refuses to overwrite it", () => {
  const w = workspace();
  try {
    const draft = join(w.dir, "draft.json");
    execFileSync(process.execPath, [tool, "init", "repository-user", draft]);
    assert.equal(statSync(draft).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, [tool, "init", "repository-user", draft], { stdio: "pipe" }), /Command failed/);
  } finally { w.close(); }
});

test("repository-user failures remain sealable evidence but never pass the gate", () => {
  const w = workspace();
  try {
    const record = repositoryUserRecord(w.artifact);
    record.disposition = { status: "fail", reason: "The first user needed coaching and exceeded 30 seconds." };
    record.sessions[0].coaching_after_report = true;
    record.sessions[0].completed_at = "2026-09-14T10:01:31.000Z";
    record.sessions[0].elapsed_ms = 31_000;
    const sealed = sealEvidence(record, { checkArtifacts: true, baseDir: w.dir });
    const result = evaluateEvidence(sealed, { checkArtifacts: true, baseDir: w.dir });
    assert.equal(result.structurally_valid, true);
    assert.equal(result.acceptance_ready, false);
  } finally { w.close(); }
});

function sofiaRecord(artifact: (name: string) => { path: string; sha256: string }) {
  const artifacts = [
    { artifact_id: "baseline-a", kind: "baseline-export", ...artifact("user-a.json") },
    { artifact_id: "baseline-b", kind: "baseline-export", ...artifact("user-b.json") },
    { artifact_id: "comparison", kind: "cross-user-comparison", ...artifact("comparison.txt") },
    { artifact_id: "replay-final", kind: "state-replay", ...artifact("replay.json") },
  ];
  const participant = (n: number) => ({
    participant_id: `participant-${n}`,
    sofia_principal: `sofia@gate5${n}`,
    baseline_artifact_id: `baseline-${n === 1 ? "a" : "b"}`,
    host: { os: "Darwin arm64", sofia_instance: `dashboard-${n}` },
    metrics: {
      status_questions: 2,
      held_state_replies: 1,
      source_read_replies: 1,
      unsourced_replies: 0,
      repeat_reads: 0,
      resummarized: 0,
      held_state_opportunities: 1,
      rederived_despite_delivery: 0,
      contradicted_despite_delivery: 0,
      worker_failures: 0,
      pending_publications: 0,
      blocked_publications: 0,
    },
  });
  return {
    schema: SOFIA_GATE5_SCHEMA,
    id: null,
    content_hash: null,
    candidate: { hunch_version: "1.33.0", hunch_commit: commit, package_sha256: hash, sofia_commit: commit },
    recorded_at: "2026-09-08T10:01:00.000Z",
    window: { started_at: "2026-09-01T10:00:00.000Z", ended_at: "2026-09-08T10:00:00.000Z" },
    scope: { kind: "user", id: "gate5" },
    preflight: { distinct_human_operators: true, distinct_principals: true, one_shared_partition: true, separate_credentials: true, baseline_enabled_on_both: true },
    participants: [participant(1), participant(2)],
    shared_task: {
      description: "Both participants followed one customer event through the shared drawer.",
      subjects: ["event:26879"],
      record_refs: [{ record_id: "nrc_1234567890abcdef12345678", record_hash: hash, subject: "event:26879", writer_principal: "sofia@gate51" }],
      observed_by: [
        { participant_id: "participant-1", record_id: "nrc_1234567890abcdef12345678", observed_at: "2026-09-05T10:00:00.000Z" },
        { participant_id: "participant-2", record_id: "nrc_1234567890abcdef12345678", observed_at: "2026-09-05T11:00:00.000Z" },
      ],
    },
    review: { reviewer_id: "reviewer-1", pairs_reviewed: 1, unresolved_pairs: 0, material_contradictions: 0, material_rederivations: 0 },
    artifacts,
    disposition: { status: "pass", reason: "Both participants used delivered shared state without material contradiction or re-derivation." },
    privacy: { contains_raw_transcript: false, contains_credentials: false, local_only: true },
  };
}

test("Sofia Gate 5 evidence requires two people, a full week, shared observation, review, replay and clean operations", () => {
  const w = workspace();
  try {
    const sealed = sealEvidence(sofiaRecord(w.artifact), { checkArtifacts: true, baseDir: w.dir });
    const result = evaluateEvidence(sealed, { checkArtifacts: true, baseDir: w.dir });
    assert.equal(result.structurally_valid, true);
    assert.equal(result.acceptance_ready, true);
    assert.equal(result.computed.elapsed_days, 7);
    assert.match(sealed.id, /^hsg5_[a-f0-9]{16}$/);
  } finally { w.close(); }
});

test("Sofia observations must reference a declared shared record", () => {
  const w = workspace();
  try {
    const record = sofiaRecord(w.artifact);
    record.disposition = { status: "fail", reason: "One observation named a record outside the shared task." };
    record.shared_task.observed_by[1].record_id = "nrc_unrelated0000000000000000";
    assert.throws(
      () => sealEvidence(record, { checkArtifacts: true, baseDir: w.dir }),
      /record_id must reference shared_task\.record_refs/,
    );
  } finally { w.close(); }
});

test("Sofia record references must belong to the declared shared subject", () => {
  const w = workspace();
  try {
    const record = sofiaRecord(w.artifact);
    record.disposition = { status: "fail", reason: "The observed record belonged to another subject." };
    record.shared_task.record_refs[0].subject = "event:unrelated";
    assert.throws(
      () => sealEvidence(record, { checkArtifacts: true, baseDir: w.dir }),
      /subject must reference shared_task\.subjects/,
    );
  } finally { w.close(); }
});

test("Sofia pass requires every participant to observe the same exact shared record", () => {
  const w = workspace();
  try {
    const record = sofiaRecord(w.artifact);
    record.shared_task.record_refs.push({
      record_id: "nrc_abcdef1234567890abcdef12",
      record_hash: hash,
      subject: "event:26879",
      writer_principal: "sofia@gate52",
    });
    record.shared_task.observed_by[1].record_id = "nrc_abcdef1234567890abcdef12";
    assert.throws(
      () => sealEvidence(record, { checkArtifacts: true, baseDir: w.dir }),
      /disposition cannot be pass while the two-user mechanism or operational evidence is incomplete/,
    );

    record.disposition = { status: "inconclusive", reason: "The participants did not observe one common record." };
    const sealed = sealEvidence(record, { checkArtifacts: true, baseDir: w.dir });
    assert.equal(evaluateEvidence(sealed, { checkArtifacts: true, baseDir: w.dir }).acceptance_ready, false);
  } finally { w.close(); }
});

test("structure-only CLI validation cannot claim acceptance readiness", () => {
  const w = workspace();
  try {
    const sealed = sealEvidence(repositoryUserRecord(w.artifact), { checkArtifacts: true, baseDir: w.dir });
    const file = join(w.dir, "sealed.json");
    writeFileSync(file, JSON.stringify(sealed));
    const run = spawnSync(process.execPath, [tool, "validate", file, "--structure-only"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "");
    const result = JSON.parse(run.stdout);
    assert.equal(result.structurally_valid, true);
    assert.equal(result.artifacts_checked, false);
    assert.equal(result.acceptance_ready, false);
  } finally { w.close(); }
});

test("an incomplete Sofia week can be sealed as inconclusive but cannot claim pass", () => {
  const w = workspace();
  try {
    const record = sofiaRecord(w.artifact);
    record.window.ended_at = "2026-09-03T10:00:00.000Z";
    record.shared_task.observed_by[0].observed_at = "2026-09-02T10:00:00.000Z";
    record.shared_task.observed_by[1].observed_at = "2026-09-02T11:00:00.000Z";
    record.disposition = { status: "inconclusive", reason: "The second participant became unavailable after two days." };
    const sealed = sealEvidence(record, { checkArtifacts: true, baseDir: w.dir });
    assert.equal(evaluateEvidence(sealed, { checkArtifacts: true, baseDir: w.dir }).acceptance_ready, false);

    record.disposition = { status: "pass", reason: "Invalid pass attempt." };
    assert.throws(() => sealEvidence(record, { checkArtifacts: true, baseDir: w.dir }), /seven|disposition cannot be pass/);
  } finally { w.close(); }
});
