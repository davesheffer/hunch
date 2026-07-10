import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { shortHash } from "../core/ids.js";
import { parseDocAnchors } from "../core/docanchors.js";
import { toPosixTarget } from "../core/paths.js";
import type { Bug, Constraint } from "../core/types.js";
import { commitMeta, revExists, revParse } from "../extractors/git.js";
import type { HunchStore } from "../store/hunchStore.js";
import { durationCutoff } from "./bootstrap.js";
import { canonicalHash } from "./canonical.js";
import type { PolicyRepository } from "./repository.js";
import {
  EvidenceEventSchema,
  EvidenceImportSchema,
  type DataClass,
  type EvidenceEvent,
  type PolicySpec,
} from "./schema.js";

export interface LocalEvidenceOptions {
  since?: string;
  maxEvents?: number;
  publicOnly?: boolean;
  privateOnly?: boolean;
  instructions?: boolean;
  importFiles?: string[];
  now?: string;
}

export interface LocalEvidenceReport {
  scanned: number;
  eligible: number;
  normalized: number;
  existing: number;
  covered: number;
  uncompilable: number;
  excluded: number;
  events: EvidenceEvent[];
}

interface PendingEvent {
  occurredAt: string;
  event: EvidenceEvent;
  private: boolean;
}

const MAX_INSTRUCTION_FILES = 64;
const MAX_INSTRUCTION_FILE_BYTES = 512 * 1024;
const MAX_INSTRUCTION_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_INSTRUCTION_HISTORY_COMMITS = 128;
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

function homeView(opts: LocalEvidenceOptions): { publicOnly?: boolean; privateOnly?: boolean } {
  return { publicOnly: opts.publicOnly, privateOnly: opts.privateOnly };
}

function normalizeRepoFile(file: string): string {
  const normalized = toPosixTarget(file.trim());
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`evidence file path must be repository-relative: ${file}`);
  }
  return normalized;
}

function coverageCompiler(
  related: string[],
  policies: PolicySpec[],
  constraints: Constraint[],
  unsupportedReason: string,
): EvidenceEvent["compiler"] {
  const refs = new Set(related);
  const policy = policies.find((candidate) => refs.has(candidate.id)
    || candidate.legacy_refs.some((ref) => refs.has(ref))
    || candidate.evidence.some((ref) => refs.has(ref)));
  if (policy) return { status: "covered", policy: policy.id, reason: "Imported evidence explicitly relates to an existing deterministic Policy IR record." };
  const constraint = constraints.find((candidate) => candidate.status === "active" && refs.has(candidate.id));
  if (constraint) return { status: "covered", policy: null, reason: "Imported evidence explicitly relates to an active deterministic legacy Constraint." };
  return { status: "uncompilable", policy: null, reason: unsupportedReason };
}

function privateOnlyRelatedRef(store: HunchStore, repository: PolicyRepository, ref: string): boolean {
  if (ref.startsWith("pol_")) {
    return !!repository.getPolicy(ref, { privateOnly: true }) && !repository.getPolicy(ref, { publicOnly: true });
  }
  const kind = ref.startsWith("dec_") ? "decisions"
    : ref.startsWith("bug_") ? "bugs"
      : ref.startsWith("con_") ? "constraints"
        : null;
  return !!kind && !!store.getPrivateRec(kind, ref) && !store.json.get(kind, ref);
}

function instructionFile(file: string): boolean {
  return /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/i.test(file)
    || /^\.github\/copilot-instructions\.md$/i.test(file)
    || /^\.(cursor|windsurf)\/rules\/.+\.(md|mdc)$/i.test(file)
    || /^(docs\/)?(adr|adrs|decisions)\/.+\.md$/i.test(file);
}

function committedInstructionFiles(root: string): string[] {
  try {
    const raw = execFileSync("git", ["-C", root, "ls-tree", "-r", "-z", "--name-only", "HEAD"], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.toString("utf8").split("\0").filter(instructionFile).sort();
  } catch {
    throw new Error("instruction ingestion could not enumerate committed repository files");
  }
}

function committedFileAt(root: string, revision: string, file: string, maxBytes: number): string | null {
  try {
    const object = `${revision}:${file}`;
    const size = Number(execFileSync("git", ["-C", root, "cat-file", "-s", object], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
    if (!Number.isFinite(size) || size < 0 || size > maxBytes) return null;
    return execFileSync("git", ["-C", root, "cat-file", "blob", object], {
      encoding: "utf8",
      maxBuffer: maxBytes + 1,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function authoredInstructionContent(source: string): string | null {
  let authored = source.replace(/<!-- HUNCH:START[^]*?<!-- HUNCH:END -->/g, "");
  authored = authored.replace(/^---\r?\n[^]*?\r?\n---\r?\n?/, "");
  authored = authored.replace(/^# Copilot instructions\s*/i, "");
  const substantive = authored.replace(/^\s{0,3}#{1,6}\s+.*$/gm, "").trim();
  return substantive ? authored.trim() : null;
}

function authoredInstructionCommit(root: string, file: string, sourceHash: string): string | null {
  let commits: string[];
  try {
    commits = execFileSync("git", [
      "-C", root,
      "log",
      `--max-count=${MAX_INSTRUCTION_HISTORY_COMMITS}`,
      "--format=%H",
      "--",
      file,
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
  let introducedAt: string | null = null;
  for (const commit of commits) {
    const blob = committedFileAt(root, commit, file, MAX_INSTRUCTION_FILE_BYTES);
    const authored = blob == null ? null : authoredInstructionContent(blob);
    if (authored == null || canonicalHash(authored) !== sourceHash) break;
    introducedAt = commit;
  }
  return introducedAt;
}

function instructionEvents(
  root: string,
  dataClass: "public" | "private",
  policies: PolicySpec[],
  constraints: Constraint[],
): { scanned: number; excluded: number; pending: PendingEvent[] } {
  const files = committedInstructionFiles(root);
  const selected = files.slice(0, MAX_INSTRUCTION_FILES);
  let excluded = files.length - selected.length;
  let totalBytes = 0;
  const pending: PendingEvent[] = [];
  for (const file of selected) {
    const committed = committedFileAt(root, "HEAD", file, MAX_INSTRUCTION_FILE_BYTES);
    const source = committed == null ? null : authoredInstructionContent(committed);
    if (source == null || totalBytes + Buffer.byteLength(source, "utf8") > MAX_INSTRUCTION_TOTAL_BYTES) {
      excluded++;
      continue;
    }
    totalBytes += Buffer.byteLength(source, "utf8");
    const sourceHash = canonicalHash(source);
    const introducedAt = authoredInstructionCommit(root, file, sourceHash);
    if (!introducedAt || !revExists(introducedAt, root)) {
      excluded++;
      continue;
    }
    const commit = revParse(`${introducedAt}^{commit}`, root);
    const meta = commitMeta(commit, root);
    if (!meta || !Number.isFinite(Date.parse(meta.date))) {
      excluded++;
      continue;
    }
    const anchors = parseDocAnchors(source);
    const related = [...new Set(anchors.map((anchor) => anchor.pin).filter((pin): pin is string => !!pin))].sort();
    const contentHash = canonicalHash({
      kind: "instruction",
      file,
      commit,
      source_hash: sourceHash,
      anchors,
      data_class: dataClass,
    });
    const event = EvidenceEventSchema.parse({
      id: `ev_${shortHash(`instruction:${contentHash}`)}`,
      kind: "instruction",
      occurred_at: meta.date,
      actor: meta.author,
      repository: basename(root),
      commit,
      files: [file],
      symbols: [],
      text_ref: file,
      diff_ref: `git:${commit}:${file}`,
      related_records: related,
      data_class: dataClass,
      content_hash: contentHash,
      compiler: coverageCompiler(
        related,
        policies,
        constraints,
        "Committed instruction/ADR content was hash-normalized, but it declares no exact supported structural assertion tied to an existing guard.",
      ),
      provenance: {
        source: "extracted",
        confidence: 0.7,
        evidence: [file, commit, sourceHash],
        last_verified: meta.date,
      },
    });
    pending.push({ occurredAt: meta.date, event, private: dataClass !== "public" });
  }
  return { scanned: files.length, excluded, pending };
}

function importEvents(
  root: string,
  file: string,
  store: HunchStore,
  repository: PolicyRepository,
  opts: LocalEvidenceOptions,
  policies: PolicySpec[],
  constraints: Constraint[],
  publicPolicies: PolicySpec[],
  publicConstraints: Constraint[],
): { scanned: number; pending: PendingEvent[] } {
  const target = resolve(root, file);
  let raw: string;
  try {
    const size = statSync(target).size;
    if (size > MAX_IMPORT_FILE_BYTES) throw new Error("too large");
    raw = readFileSync(target, "utf8");
  } catch {
    throw new Error(`evidence import ${basename(file)} is unreadable or exceeds ${MAX_IMPORT_FILE_BYTES} bytes`);
  }
  let parsed: ReturnType<typeof EvidenceImportSchema.parse>;
  try {
    parsed = EvidenceImportSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`invalid evidence import ${basename(file)}: ${(error as Error).message}`);
  }
  const pending: PendingEvent[] = [];
  for (const item of parsed.items) {
    let dataClass: DataClass = item.data_class;
    if (opts.privateOnly && dataClass === "public") dataClass = "private";
    if (opts.publicOnly && dataClass !== "public") {
      throw new Error(`evidence import ${basename(file)} contains ${dataClass} item ${item.id}; refusing public-only ingestion`);
    }
    if (dataClass !== "public" && !store.hasPrivate) {
      throw new Error(`evidence import ${basename(file)} needs a configured private overlay for ${dataClass} item ${item.id}`);
    }
    let commit: string | undefined;
    if (item.commit) {
      if (!revExists(item.commit, root)) throw new Error(`evidence import item ${item.id} commit ${item.commit} does not resolve`);
      commit = revParse(`${item.commit}^{commit}`, root);
    }
    const files = [...new Set(item.files.map(normalizeRepoFile))].sort();
    const symbols = [...new Set(item.symbols)].sort();
    const related = [...new Set(item.related_records)].sort();
    if (dataClass === "public") {
      const privateRef = related.find((ref) => privateOnlyRelatedRef(store, repository, ref));
      if (privateRef) throw new Error(`public evidence import item ${item.id} references private-only record ${privateRef}`);
    }
    const textHash = item.text ? canonicalHash(item.text) : undefined;
    const textRef = item.text_ref ?? `export:${parsed.source}:${item.id}`;
    const body = {
      source: parsed.source,
      external_id: item.id,
      kind: item.kind,
      occurred_at: item.occurred_at,
      actor: item.actor,
      commit,
      files,
      symbols,
      text_ref: textRef,
      text_hash: textHash,
      related_records: related,
      data_class: dataClass,
      maintainer_confirmed: item.maintainer_confirmed,
    };
    const contentHash = canonicalHash(body);
    const event = EvidenceEventSchema.parse({
      id: `ev_${shortHash(`${parsed.source}:${contentHash}`)}`,
      kind: item.kind,
      occurred_at: item.occurred_at,
      ...(item.actor ? { actor: item.actor } : {}),
      repository: basename(root),
      ...(commit ? { commit, diff_ref: `git:${commit}` } : {}),
      files,
      symbols,
      text_ref: textRef,
      related_records: related,
      data_class: dataClass,
      content_hash: contentHash,
      compiler: coverageCompiler(
        related,
        dataClass === "public" ? publicPolicies : policies,
        dataClass === "public" ? publicConstraints : constraints,
        item.maintainer_confirmed
          ? "Maintainer-confirmed review/instruction evidence was normalized, but no exact supported structural assertion or existing deterministic guard is linked."
          : "External review/conversation evidence is not maintainer-confirmed and cannot become a policy candidate.",
      ),
      provenance: {
        source: item.maintainer_confirmed ? "human_confirmed+imported" : "imported",
        confidence: item.maintainer_confirmed ? 1 : 0.5,
        evidence: [parsed.source, basename(file), item.id, ...(commit ? [commit] : []), ...(textHash ? [textHash] : [])],
        last_verified: item.occurred_at,
      },
    });
    pending.push({ occurredAt: item.occurred_at, event, private: dataClass !== "public" });
  }
  return { scanned: parsed.items.length, pending };
}

function limit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

function exactRecords(store: HunchStore, opts: LocalEvidenceOptions): { constraints: Constraint[]; bugs: Bug[] } {
  if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
  if (opts.privateOnly) {
    if (!store.hasPrivate) throw new Error("private evidence ingestion needs a configured Hunch private overlay");
    return { constraints: store.recsInHome("constraints", "private"), bugs: store.recsInHome("bugs", "private") };
  }
  if (opts.publicOnly) return { constraints: store.json.loadAll("constraints"), bugs: store.json.loadAll("bugs") };
  return { constraints: store.recs("constraints"), bugs: store.recs("bugs") };
}

function isPrivateRecord(store: HunchStore, kind: "constraints" | "bugs", id: string, opts: LocalEvidenceOptions): boolean {
  if (opts.privateOnly) return true;
  if (opts.publicOnly) return false;
  return !!store.getPrivateRec(kind, id);
}

function correctionEvent(root: string, constraint: Constraint, isPrivate: boolean): PendingEvent | null {
  const occurredAt = constraint.valid_from ?? constraint.provenance.last_verified;
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const contentHash = canonicalHash({
    constraint: constraint.id,
    statement: constraint.statement,
    scope: constraint.scope,
    forbids: constraint.forbids,
    match: constraint.match,
    source_decision: constraint.source_decision,
  });
  const event = EvidenceEventSchema.parse({
    id: `ev_${shortHash(`correction:${contentHash}`)}`,
    kind: "correction",
    occurred_at: occurredAt,
    repository: basename(root),
    files: constraint.scope.filter((scope) => scope !== "**"),
    symbols: constraint.forbids?.symbols ?? [],
    text_ref: constraint.id,
    related_records: [constraint.id, ...(constraint.source_decision ? [constraint.source_decision] : [])],
    data_class: isPrivate ? "private" : "public",
    content_hash: contentHash,
    compiler: {
      status: "covered",
      policy: null,
      reason: "Active human-confirmed legacy Constraint already delivers deterministic correction enforcement; Policy IR bridge remains explicit follow-on work.",
    },
    provenance: {
      source: "derived",
      confidence: 1,
      evidence: [constraint.id, ...constraint.provenance.evidence],
      last_verified: constraint.provenance.last_verified,
    },
  });
  return { occurredAt, event, private: isPrivate };
}

function bugEvent(
  root: string,
  store: HunchStore,
  repository: PolicyRepository,
  bug: Bug,
  isPrivate: boolean,
  opts: LocalEvidenceOptions,
): PendingEvent | null {
  const commit = bug.lineage.fixed_commit ?? bug.lineage.introduced_commit;
  const meta = commit ? commitMeta(commit, root) : null;
  const occurredAt = meta?.date ?? bug.provenance.last_verified;
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  const kind = bug.lineage.detected ? "test_failure" : "incident";
  const related = [
    bug.id,
    bug.lineage.recurrence_of,
    bug.lineage.spawned_decision,
    bug.lineage.spawned_constraint,
  ].filter((value): value is string => !!value);
  const contentHash = canonicalHash({
    bug: bug.id,
    root_cause: bug.root_cause,
    files: bug.affected_files,
    symbols: bug.affected_symbols,
    lineage: bug.lineage,
  });
  const homeView = { publicOnly: opts.publicOnly, privateOnly: opts.privateOnly };
  const policy = bug.lineage.spawned_decision
    ? repository.listPolicies(homeView).find((candidate) => candidate.legacy_refs.includes(bug.lineage.spawned_decision!))
    : undefined;
  const constraint = bug.lineage.spawned_constraint
    ? opts.publicOnly
      ? store.json.get("constraints", bug.lineage.spawned_constraint)
      : opts.privateOnly
        ? store.getPrivateRec("constraints", bug.lineage.spawned_constraint)
        : store.getRec("constraints", bug.lineage.spawned_constraint)
    : undefined;
  const covered = !!policy || constraint?.status === "active";
  const event = EvidenceEventSchema.parse({
    id: `ev_${shortHash(`${kind}:${contentHash}`)}`,
    kind,
    occurred_at: occurredAt,
    repository: basename(root),
    ...(meta ? { actor: meta.author, commit: meta.sha, diff_ref: `git:${meta.sha}` } : {}),
    files: bug.affected_files,
    symbols: bug.affected_symbols,
    text_ref: bug.id,
    related_records: [...related, ...(policy ? [policy.id] : [])],
    data_class: isPrivate ? "private" : "public",
    content_hash: contentHash,
    compiler: covered
      ? {
          status: "covered",
          policy: policy?.id ?? null,
          reason: policy
            ? "Spawned decision already has equivalent Policy IR coverage."
            : "Spawned active legacy Constraint already covers this failure; Policy IR bridge remains pending.",
        }
      : {
          status: "uncompilable",
          policy: null,
          reason: "Incident/test evidence normalized, but no attributable supported assertion or existing deterministic guard is linked.",
        },
    provenance: {
      source: "derived",
      confidence: bug.provenance.confidence,
      evidence: [bug.id, ...bug.provenance.evidence],
      last_verified: bug.provenance.last_verified,
    },
  });
  return { occurredAt, event, private: isPrivate };
}

/** Normalize existing local Hunch truth into Constitution EvidenceEvents. This
 * adapter never synthesizes intent and never creates or activates a policy. */
export function ingestLocalEvidence(
  store: HunchStore,
  root: string,
  repository: PolicyRepository,
  opts: LocalEvidenceOptions = {},
): LocalEvidenceReport {
  const now = opts.now ?? new Date().toISOString();
  const minDate = durationCutoff(opts.since ?? "90d", now);
  const records = exactRecords(store, opts);
  const view = homeView(opts);
  const policies = repository.listPolicies(view);
  const publicPolicies = repository.listPolicies({ publicOnly: true });
  const publicConstraints = store.json.loadAll("constraints");
  const pending: PendingEvent[] = [];
  let scanned = records.constraints.length + records.bugs.length;
  let excluded = 0;
  for (const constraint of records.constraints) {
    if (constraint.status !== "active" || !constraint.provenance.source.includes("human_confirmed")) {
      excluded++;
      continue;
    }
    const item = correctionEvent(root, constraint, isPrivateRecord(store, "constraints", constraint.id, opts));
    if (!item || Date.parse(item.occurredAt) < minDate) excluded++;
    else pending.push(item);
  }
  for (const bug of records.bugs) {
    const attributable = !!bug.lineage.detected || (!!bug.root_cause.trim() && bug.provenance.confidence >= 0.7);
    if (!attributable) {
      excluded++;
      continue;
    }
    const item = bugEvent(root, store, repository, bug, isPrivateRecord(store, "bugs", bug.id, opts), opts);
    if (!item || Date.parse(item.occurredAt) < minDate) excluded++;
    else pending.push(item);
  }
  if (opts.instructions) {
    const instructions = instructionEvents(
      root,
      opts.privateOnly ? "private" : "public",
      opts.privateOnly ? policies : publicPolicies,
      opts.privateOnly ? records.constraints : publicConstraints,
    );
    scanned += instructions.scanned;
    excluded += instructions.excluded;
    for (const item of instructions.pending) {
      if (Date.parse(item.occurredAt) < minDate) excluded++;
      else pending.push(item);
    }
  }
  for (const file of opts.importFiles ?? []) {
    const imported = importEvents(root, file, store, repository, opts, policies, records.constraints, publicPolicies, publicConstraints);
    scanned += imported.scanned;
    for (const item of imported.pending) {
      if (Date.parse(item.occurredAt) < minDate) excluded++;
      else pending.push(item);
    }
  }
  pending.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.event.id.localeCompare(b.event.id));
  const unique = [...new Map(pending.map((item) => [item.event.id, item])).values()];
  excluded += pending.length - unique.length;
  const selected = unique.slice(0, limit(opts.maxEvents));
  excluded += Math.max(0, unique.length - selected.length);
  const report: LocalEvidenceReport = {
    scanned,
    eligible: unique.length,
    normalized: 0,
    existing: 0,
    covered: 0,
    uncompilable: 0,
    excluded,
    events: [],
  };
  for (const item of selected) {
    const existing = repository.getEvidence(item.event.id, view);
    const event = existing ?? repository.putEvidence(item.event, { private: item.private });
    if (existing) report.existing++;
    else report.normalized++;
    if (event.compiler?.status === "covered") report.covered++;
    if (event.compiler?.status === "uncompilable") report.uncompilable++;
    report.events.push(event);
  }
  return report;
}
