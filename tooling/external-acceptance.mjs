import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY_USER_SCHEMA = "hunch.repository-user-acceptance/1";
export const SOFIA_GATE5_SCHEMA = "hunch.sofia-gate5-week/1";
const HASH = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TASK = /^htask_[a-f0-9]{16,}$/;
const OPAQUE_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

function bodyOf(record) {
  const { id: _id, content_hash: _hash, ...body } = record;
  return body;
}

export function evidenceHash(record) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(bodyOf(record)))).digest("hex")}`;
}

export function digestFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact must be a regular, non-symlink file");
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function text(errors, value, path, max = 1000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) errors.push(`${path} must be 1..${max} characters`);
}

function bool(errors, value, path) {
  if (typeof value !== "boolean") errors.push(`${path} must be boolean`);
}

function integer(errors, value, path) {
  if (!Number.isSafeInteger(value) || value < 0) errors.push(`${path} must be a non-negative integer`);
}

function time(errors, value, path) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) errors.push(`${path} must be an ISO timestamp`);
}

function opaque(errors, value, path) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) errors.push(`${path} must be an opaque lowercase identifier without an email address`);
}

function artifact(errors, value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${path} must be an artifact object`); return; }
  text(errors, value.path, `${path}.path`, 2048);
  if (typeof value.sha256 !== "string" || !HASH.test(value.sha256)) errors.push(`${path}.sha256 must be sha256:<64 lowercase hex>`);
}

function candidate(errors, value, path, includeSofia = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${path} must be an object`); return; }
  text(errors, value.hunch_version, `${path}.hunch_version`, 64);
  if (typeof value.hunch_commit !== "string" || !COMMIT.test(value.hunch_commit)) errors.push(`${path}.hunch_commit must be a 40-character lowercase Git commit`);
  if (typeof value.package_sha256 !== "string" || !HASH.test(value.package_sha256)) errors.push(`${path}.package_sha256 must be sha256:<64 lowercase hex>`);
  if (includeSofia && (typeof value.sofia_commit !== "string" || !COMMIT.test(value.sofia_commit))) errors.push(`${path}.sofia_commit must be a 40-character lowercase Git commit`);
}

function disposition(errors, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("disposition must be an object"); return; }
  if (!["pass", "fail", "inconclusive"].includes(value.status)) errors.push("disposition.status must be pass, fail, or inconclusive");
  text(errors, value.reason, "disposition.reason", 2000);
}

function privacy(errors, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("privacy must be an object"); return; }
  if (value.contains_raw_transcript !== false) errors.push("privacy.contains_raw_transcript must be false");
  if (value.contains_credentials !== false) errors.push("privacy.contains_credentials must be false");
  if (value.local_only !== true) errors.push("privacy.local_only must be true");
}

function validateSeal(errors, record) {
  if (typeof record.content_hash !== "string" || !HASH.test(record.content_hash)) errors.push("content_hash must seal the record");
  else if (record.content_hash !== evidenceHash(record)) errors.push("content_hash does not match the record body");
  const prefix = record.schema === REPOSITORY_USER_SCHEMA ? "hrua_" : "hsg5_";
  if (record.id !== `${prefix}${evidenceHash(record).slice(7, 23)}`) errors.push(`id must be derived from content_hash with prefix ${prefix}`);
}

function verifyArtifacts(errors, entries, baseDir) {
  for (const [path, item] of entries) {
    if (!item || typeof item.path !== "string" || !HASH.test(item.sha256 ?? "")) continue;
    try {
      const actual = digestFile(resolve(baseDir, item.path));
      if (actual !== item.sha256) errors.push(`${path} hash does not match ${item.path}`);
    } catch (error) {
      errors.push(`${path} is unavailable: ${error.message}`);
    }
  }
}

function repositoryUser(record, options) {
  const errors = [], artifacts = [];
  candidate(errors, record.candidate, "candidate");
  time(errors, record.recorded_at, "recorded_at");
  disposition(errors, record.disposition);
  privacy(errors, record.privacy);
  if (!record.moderation || typeof record.moderation !== "object" || Array.isArray(record.moderation)) errors.push("moderation must be an object");
  else {
    opaque(errors, record.moderation.moderator_id, "moderation.moderator_id");
    if (record.moderation.questions_read_verbatim !== true) errors.push("moderation.questions_read_verbatim must be true");
  }
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  if (!Array.isArray(record.sessions)) errors.push("sessions must be an array");
  const participants = new Set(), cases = new Set();
  let observedPass = sessions.length >= 2;
  for (const [index, session] of sessions.entries()) {
    const path = `sessions[${index}]`;
    if (!session || typeof session !== "object") { errors.push(`${path} must be an object`); observedPass = false; continue; }
    opaque(errors, session.case_id, `${path}.case_id`);
    opaque(errors, session.participant_id, `${path}.participant_id`);
    if (cases.has(session.case_id)) errors.push(`${path}.case_id must be unique`);
    if (participants.has(session.participant_id)) errors.push(`${path}.participant_id must be unique`);
    cases.add(session.case_id); participants.add(session.participant_id);
    if (typeof session.task_id !== "string" || !TASK.test(session.task_id)) errors.push(`${path}.task_id must be an htask_ identity`);
    if (typeof session.report_hash !== "string" || !HASH.test(session.report_hash)) errors.push(`${path}.report_hash must be sha256:<64 lowercase hex>`);
    opaque(errors, session.repository_id, `${path}.repository_id`);
    if (typeof session.repository_revision !== "string" || !COMMIT.test(session.repository_revision)) errors.push(`${path}.repository_revision must be a 40-character lowercase Git commit`);
    if (!session.host || typeof session.host !== "object") errors.push(`${path}.host must identify the real host`);
    else {
      text(errors, session.host.name, `${path}.host.name`, 120);
      text(errors, session.host.version, `${path}.host.version`, 120);
      text(errors, session.host.os, `${path}.host.os`, 200);
    }
    time(errors, session.report_shown_at, `${path}.report_shown_at`);
    time(errors, session.completed_at, `${path}.completed_at`);
    integer(errors, session.elapsed_ms, `${path}.elapsed_ms`);
    if (Number.isSafeInteger(session.elapsed_ms) && session.elapsed_ms > 30_000) observedPass = false;
    const elapsed = Date.parse(session.completed_at) - Date.parse(session.report_shown_at);
    if (Number.isFinite(elapsed) && elapsed < 0) errors.push(`${path}.completed_at must not precede report_shown_at`);
    if (Number.isFinite(elapsed) && Number.isSafeInteger(session.elapsed_ms) && Math.abs(elapsed - session.elapsed_ms) > 1000) errors.push(`${path}.elapsed_ms must match the timestamps within one second`);
    if (session.timer_source !== "monotonic" && session.timer_source !== "screen-recording" && session.timer_source !== "moderator-stopwatch") errors.push(`${path}.timer_source is invalid`);
    bool(errors, session.coaching_after_report, `${path}.coaching_after_report`);
    if (session.coaching_after_report !== false) observedPass = false;
    if (!session.answers || typeof session.answers !== "object" || Array.isArray(session.answers)) { errors.push(`${path}.answers must be an object`); observedPass = false; }
    else {
      text(errors, session.answers.connection_state, `${path}.answers.connection_state`);
      text(errors, session.answers.supported_contribution, `${path}.answers.supported_contribution`);
      if (session.answers.connection_state_correct !== true) observedPass = false;
      if (session.answers.supported_contribution_correct !== true) observedPass = false;
      if (session.answers.evidence_opened !== true) observedPass = false;
      bool(errors, session.answers.connection_state_correct, `${path}.answers.connection_state_correct`);
      bool(errors, session.answers.supported_contribution_correct, `${path}.answers.supported_contribution_correct`);
      bool(errors, session.answers.evidence_opened, `${path}.answers.evidence_opened`);
      text(errors, session.answers.evidence_target, `${path}.answers.evidence_target`, 500);
    }
    artifact(errors, session.report_artifact, `${path}.report_artifact`);
    artifacts.push([`${path}.report_artifact`, session.report_artifact]);
  }
  if (record.disposition?.status === "pass" && !observedPass) errors.push("disposition cannot be pass unless every user completes all three tasks without coaching in 30 seconds");
  if (options.checkArtifacts) verifyArtifacts(errors, artifacts, options.baseDir);
  return { errors, observedPass, computed: { participants: participants.size, all_users_within_30_seconds: observedPass } };
}

function sofiaGate5(record, options) {
  const errors = [], artifacts = [];
  candidate(errors, record.candidate, "candidate", true);
  time(errors, record.recorded_at, "recorded_at");
  disposition(errors, record.disposition);
  privacy(errors, record.privacy);
  if (!record.window || typeof record.window !== "object" || Array.isArray(record.window)) errors.push("window must be an object");
  else { time(errors, record.window.started_at, "window.started_at"); time(errors, record.window.ended_at, "window.ended_at"); }
  const duration = Date.parse(record.window?.ended_at) - Date.parse(record.window?.started_at);
  const fullWeek = Number.isFinite(duration) && duration >= WEEK_MS;
  if (Number.isFinite(duration) && duration < 0) errors.push("window.ended_at must not precede window.started_at");
  if (Number.isFinite(Date.parse(record.recorded_at)) && Number.isFinite(Date.parse(record.window?.ended_at)) && Date.parse(record.recorded_at) < Date.parse(record.window.ended_at)) errors.push("recorded_at must not precede window.ended_at");
  if (!record.scope || typeof record.scope !== "object" || Array.isArray(record.scope) || record.scope.kind !== "user") errors.push("scope.kind must be user");
  text(errors, record.scope?.id, "scope.id", 128);
  if (!record.preflight || typeof record.preflight !== "object" || Array.isArray(record.preflight)) errors.push("preflight must be an object");
  const preflightFields = ["distinct_human_operators", "distinct_principals", "one_shared_partition", "separate_credentials", "baseline_enabled_on_both"];
  let preflightPass = true;
  for (const field of preflightFields) {
    bool(errors, record.preflight?.[field], `preflight.${field}`);
    if (record.preflight?.[field] !== true) preflightPass = false;
  }
  const participantRows = Array.isArray(record.participants) ? record.participants : [];
  if (!Array.isArray(record.participants)) errors.push("participants must be an array");
  const participantIds = new Set(), principals = new Set();
  let opportunities = 0, rederived = 0, contradicted = 0, statusQuestions = 0, operationalFailures = 0;
  for (const [index, participant] of participantRows.entries()) {
    const path = `participants[${index}]`;
    opaque(errors, participant?.participant_id, `${path}.participant_id`);
    text(errors, participant?.sofia_principal, `${path}.sofia_principal`, 128);
    if (participantIds.has(participant?.participant_id)) errors.push(`${path}.participant_id must be unique`);
    if (principals.has(participant?.sofia_principal)) errors.push(`${path}.sofia_principal must be unique`);
    participantIds.add(participant?.participant_id); principals.add(participant?.sofia_principal);
    if (!participant?.host || typeof participant.host !== "object") errors.push(`${path}.host must identify the real machine`);
    else { text(errors, participant.host.os, `${path}.host.os`, 200); text(errors, participant.host.sofia_instance, `${path}.host.sofia_instance`, 120); }
    const metrics = participant?.metrics;
    if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) errors.push(`${path}.metrics must be an object`);
    for (const field of ["status_questions", "held_state_replies", "source_read_replies", "unsourced_replies", "repeat_reads", "resummarized", "held_state_opportunities", "rederived_despite_delivery", "contradicted_despite_delivery", "worker_failures", "pending_publications", "blocked_publications"]) integer(errors, metrics?.[field], `${path}.metrics.${field}`);
    const classified = (metrics?.held_state_replies ?? 0) + (metrics?.source_read_replies ?? 0) + (metrics?.unsourced_replies ?? 0);
    if (Number.isSafeInteger(metrics?.status_questions) && classified !== metrics.status_questions) errors.push(`${path}.metrics status reply classes must sum to status_questions`);
    statusQuestions += metrics?.status_questions ?? 0;
    opportunities += metrics?.held_state_opportunities ?? 0;
    rederived += metrics?.rederived_despite_delivery ?? 0;
    contradicted += metrics?.contradicted_despite_delivery ?? 0;
    operationalFailures += (metrics?.worker_failures ?? 0) + (metrics?.pending_publications ?? 0) + (metrics?.blocked_publications ?? 0);
    text(errors, participant?.baseline_artifact_id, `${path}.baseline_artifact_id`, 64);
  }
  const sharedSubjects = new Set();
  const sharedRecordIds = new Set();
  const sharedRecordObservers = new Map();
  if (!record.shared_task || typeof record.shared_task !== "object" || Array.isArray(record.shared_task)) errors.push("shared_task must be an object");
  else {
    text(errors, record.shared_task.description, "shared_task.description", 1000);
    if (!Array.isArray(record.shared_task.subjects)) errors.push("shared_task.subjects must be an array");
    else record.shared_task.subjects.forEach((subject, index) => {
      text(errors, subject, `shared_task.subjects[${index}]`, 512);
      if (sharedSubjects.has(subject)) errors.push(`shared_task.subjects[${index}] must be unique`);
      sharedSubjects.add(subject);
    });
    const recordRefs = Array.isArray(record.shared_task.record_refs) ? record.shared_task.record_refs : [];
    if (!Array.isArray(record.shared_task.record_refs)) errors.push("shared_task.record_refs must be an array");
    for (const [index, ref] of recordRefs.entries()) {
      const path = `shared_task.record_refs[${index}]`;
      text(errors, ref?.record_id, `${path}.record_id`, 128);
      if (sharedRecordIds.has(ref?.record_id)) errors.push(`${path}.record_id must be unique`);
      sharedRecordIds.add(ref?.record_id);
      if (typeof ref?.record_hash !== "string" || !HASH.test(ref.record_hash)) errors.push(`${path}.record_hash must be sha256:<64 lowercase hex>`);
      text(errors, ref?.subject, `${path}.subject`, 512);
      if (!sharedSubjects.has(ref?.subject)) errors.push(`${path}.subject must reference shared_task.subjects`);
      text(errors, ref?.writer_principal, `${path}.writer_principal`, 128);
    }
    const observedBy = Array.isArray(record.shared_task.observed_by) ? record.shared_task.observed_by : [];
    if (!Array.isArray(record.shared_task.observed_by)) errors.push("shared_task.observed_by must be an array");
    for (const [index, observation] of observedBy.entries()) {
      const path = `shared_task.observed_by[${index}]`;
      opaque(errors, observation?.participant_id, `${path}.participant_id`);
      text(errors, observation?.record_id, `${path}.record_id`, 128);
      if (!participantIds.has(observation?.participant_id)) errors.push(`${path}.participant_id must reference participants`);
      if (!sharedRecordIds.has(observation?.record_id)) errors.push(`${path}.record_id must reference shared_task.record_refs`);
      if (participantIds.has(observation?.participant_id) && sharedRecordIds.has(observation?.record_id)) {
        const observers = sharedRecordObservers.get(observation.record_id) ?? new Set();
        observers.add(observation.participant_id);
        sharedRecordObservers.set(observation.record_id, observers);
      }
      time(errors, observation?.observed_at, `${path}.observed_at`);
      const observedAt = Date.parse(observation?.observed_at);
      if (Number.isFinite(observedAt) && Number.isFinite(Date.parse(record.window?.started_at)) && Number.isFinite(Date.parse(record.window?.ended_at))
          && (observedAt < Date.parse(record.window.started_at) || observedAt > Date.parse(record.window.ended_at))) errors.push(`${path}.observed_at must fall inside the pilot window`);
    }
  }
  if (!record.review || typeof record.review !== "object" || Array.isArray(record.review)) errors.push("review must be an object");
  else {
    opaque(errors, record.review.reviewer_id, "review.reviewer_id");
    for (const field of ["pairs_reviewed", "unresolved_pairs", "material_contradictions", "material_rederivations"]) integer(errors, record.review[field], `review.${field}`);
    contradicted += record.review.material_contradictions ?? 0;
    rederived += record.review.material_rederivations ?? 0;
  }
  const artifactRows = Array.isArray(record.artifacts) ? record.artifacts : [];
  if (!Array.isArray(record.artifacts)) errors.push("artifacts must be an array");
  const artifactIds = new Set(), artifactKinds = new Map(), kinds = new Map();
  for (const [index, item] of artifactRows.entries()) {
    const path = `artifacts[${index}]`;
    opaque(errors, item?.artifact_id, `${path}.artifact_id`);
    if (artifactIds.has(item?.artifact_id)) errors.push(`${path}.artifact_id must be unique`);
    artifactIds.add(item?.artifact_id);
    if (!["baseline-export", "cross-user-comparison", "state-replay"].includes(item?.kind)) errors.push(`${path}.kind is invalid`);
    kinds.set(item?.kind, (kinds.get(item?.kind) ?? 0) + 1);
    artifactKinds.set(item?.artifact_id, item?.kind);
    artifact(errors, item, path);
    artifacts.push([path, item]);
  }
  const artifactPass = (kinds.get("baseline-export") ?? 0) >= 2 && (kinds.get("cross-user-comparison") ?? 0) >= 1 && (kinds.get("state-replay") ?? 0) >= 1;
  const reviewPass = (record.review?.pairs_reviewed ?? 0) >= 1 && (record.review?.unresolved_pairs ?? 0) === 0;
  const everyParticipantObservedSameRecord = participantIds.size > 0
    && [...sharedRecordObservers.values()].some(observers => [...participantIds].every(participant => observers.has(participant)));
  const sharedTaskPass = sharedSubjects.size >= 1
    && sharedRecordIds.size >= 1
    && everyParticipantObservedSameRecord;
  const baselineReferenceIds = participantRows.map(participant => participant?.baseline_artifact_id);
  const baselineRefsPass = new Set(baselineReferenceIds).size === participantRows.length
    && participantRows.every(participant => artifactKinds.get(participant?.baseline_artifact_id) === "baseline-export");
  const perParticipantPass = participantRows.every(participant => (participant?.metrics?.status_questions ?? 0) >= 1 && (participant?.metrics?.held_state_opportunities ?? 0) >= 1);
  const observedPass = fullWeek && preflightPass && participantIds.size >= 2 && principals.size >= 2 && perParticipantPass && statusQuestions >= 2 && opportunities >= participantIds.size && rederived === 0 && contradicted === 0 && operationalFailures === 0 && reviewPass && sharedTaskPass && artifactPass && baselineRefsPass;
  if (record.disposition?.status === "pass" && !observedPass) errors.push("disposition cannot be pass while the two-user mechanism or operational evidence is incomplete");
  if (options.checkArtifacts) verifyArtifacts(errors, artifacts, options.baseDir);
  return { errors, observedPass, computed: { participants: participantIds.size, elapsed_days: Number.isFinite(duration) ? duration / 86_400_000 : null, status_questions: statusQuestions, held_state_opportunities: opportunities, shared_records_observed_by_all: [...sharedRecordObservers.values()].filter(observers => [...participantIds].every(participant => observers.has(participant))).length, rederived_despite_delivery: rederived, contradicted_despite_delivery: contradicted, operational_failures: operationalFailures } };
}

export function evaluateEvidence(record, options = {}) {
  const settings = { requireSeal: options.requireSeal ?? true, checkArtifacts: options.checkArtifacts ?? false, baseDir: options.baseDir ?? process.cwd() };
  if (!record || typeof record !== "object" || Array.isArray(record)) return { structurally_valid: false, acceptance_ready: false, errors: ["record must be a JSON object"], computed: {} };
  let result;
  if (record.schema === REPOSITORY_USER_SCHEMA) result = repositoryUser(record, settings);
  else if (record.schema === SOFIA_GATE5_SCHEMA) result = sofiaGate5(record, settings);
  else return { structurally_valid: false, acceptance_ready: false, errors: [`unsupported schema ${String(record.schema)}`], computed: {} };
  if (settings.requireSeal) validateSeal(result.errors, record);
  const structurallyValid = result.errors.length === 0;
  return { schema: record.schema, id: record.id ?? null, structurally_valid: structurallyValid, artifacts_checked: settings.checkArtifacts, acceptance_ready: settings.checkArtifacts && structurallyValid && result.observedPass && record.disposition?.status === "pass", disposition: record.disposition?.status ?? null, errors: result.errors, computed: result.computed };
}

export function sealEvidence(record, options = {}) {
  const preliminary = evaluateEvidence(record, { ...options, requireSeal: false });
  if (!preliminary.structurally_valid) throw new Error(preliminary.errors.join("\n"));
  const contentHash = evidenceHash(record);
  const prefix = record.schema === REPOSITORY_USER_SCHEMA ? "hrua_" : "hsg5_";
  const sealed = { ...record, id: `${prefix}${contentHash.slice(7, 23)}`, content_hash: contentHash };
  const final = evaluateEvidence(sealed, { ...options, requireSeal: true });
  if (!final.structurally_valid) throw new Error(final.errors.join("\n"));
  return sealed;
}

export function template(kind, now = new Date().toISOString()) {
  if (kind === "repository-user") return {
    schema: REPOSITORY_USER_SCHEMA, id: null, content_hash: null,
    candidate: { hunch_version: "", hunch_commit: "", package_sha256: "" }, recorded_at: now,
    moderation: { moderator_id: "", questions_read_verbatim: true },
    sessions: [], disposition: { status: "inconclusive", reason: "Complete after both observed sessions." },
    privacy: { contains_raw_transcript: false, contains_credentials: false, local_only: true },
  };
  if (kind === "sofia-gate5") return {
    schema: SOFIA_GATE5_SCHEMA, id: null, content_hash: null,
    candidate: { hunch_version: "", hunch_commit: "", package_sha256: "", sofia_commit: "" }, recorded_at: now,
    window: { started_at: "", ended_at: "" }, scope: { kind: "user", id: "" },
    preflight: { distinct_human_operators: true, distinct_principals: true, one_shared_partition: true, separate_credentials: true, baseline_enabled_on_both: true },
    participants: [], shared_task: { description: "", subjects: [], record_refs: [], observed_by: [] },
    review: { reviewer_id: "", pairs_reviewed: 0, unresolved_pairs: 0, material_contradictions: 0, material_rederivations: 0 },
    artifacts: [], disposition: { status: "inconclusive", reason: "Complete after the observed two-user week." },
    privacy: { contains_raw_transcript: false, contains_credentials: false, local_only: true },
  };
  throw new Error("kind must be repository-user or sofia-gate5");
}

function readRecord(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("record must be a regular, non-symlink file");
  if (stat.size > MAX_RECORD_BYTES) throw new Error("record exceeds 1 MiB");
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeExclusive(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.structurally_valid ? result.acceptance_ready ? 0 : 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "init") {
      const [kind, output] = args;
      if (!output) throw new Error("usage: external-acceptance init repository-user|sofia-gate5 <draft.json>");
      writeExclusive(resolve(output), template(kind));
      process.stdout.write(resolve(output) + "\n");
    } else if (command === "digest") {
      if (args.length !== 1) throw new Error("usage: external-acceptance digest <artifact>");
      process.stdout.write(digestFile(resolve(args[0])) + "\n");
    } else if (command === "seal") {
      if (args.length !== 2) throw new Error("usage: external-acceptance seal <draft.json> <sealed.json>");
      const input = resolve(args[0]), output = resolve(args[1]);
      const sealed = sealEvidence(readRecord(input), { checkArtifacts: true, baseDir: dirname(input) });
      writeExclusive(output, sealed);
      printResult(evaluateEvidence(sealed, { checkArtifacts: true, baseDir: dirname(input) }));
    } else if (command === "validate") {
      if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== "--structure-only")) throw new Error("usage: external-acceptance validate <sealed.json> [--structure-only]");
      const file = resolve(args[0]), record = readRecord(file);
      printResult(evaluateEvidence(record, { checkArtifacts: args[1] !== "--structure-only", baseDir: dirname(file) }));
    } else throw new Error("commands: init, digest, seal, validate");
  } catch (error) {
    process.stderr.write(`external-acceptance: ${error.message}\n`);
    process.exitCode = 2;
  }
}
