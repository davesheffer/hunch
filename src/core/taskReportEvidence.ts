import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { analyzeDiff } from "../extractors/diff.js";
import { workingDiff, workingFiles } from "../extractors/git.js";
import { assertCompleteRepoScan, scanRepo } from "../extractors/indexer.js";
import { checkConformance, type ConformanceGraph } from "./conformance.js";
import { effectiveForbids, matchForbids } from "./constraintmatch.js";
import type { DeliveryEnvelope } from "./delivery.js";
import { ReportCheckSchema, ReportRecordSchema, beginReportCheck, readTaskReport, recordReportCheck, recordReportConformance, reportHash, type ReportCheck, type ReportConformance, type ReportRecord } from "./taskReport.js";

export function snapshotDeliveredRecords(store: HunchStore, envelope: DeliveryEnvelope): ReportRecord[] {
  const records: ReportRecord[] = [];
  for (const item of envelope.delivered) {
    const record = store.recs(item.kind === "relationships" ? "edges" : item.kind).find(r => r.id === item.record_id);
    if (!record) continue;
    const raw = record as unknown as Record<string, unknown>;
    const text = (...keys: string[]) => keys.map(k => raw[k]).find(v => typeof v === "string") as string | undefined;
    const candidate = ReportRecordSchema.safeParse({
      record_id: item.record_id, kind: item.kind, content_hash: reportHash(record),
      title: (text("title", "statement", "name", "reason") ?? item.record_id).slice(0, 500),
      lesson: (text("decision", "statement", "description", "root_cause", "reason", "title", "name") ?? item.record_id).slice(0, 12_000),
      recorded_at: text("date", "created_at", "observed_at", "valid_from") ?? null,
    });
    if (candidate.success) records.push(candidate.data);
  }
  return records;
}

export interface ReportSnapshot { hash: string | null; limitations: string[] }
/** Bounded source snapshot, not a committed change proof. Ignored files and
 * Hunch's own memory/cache are excluded and explicitly disclosed. */
export function reportSourceSnapshot(root: string): ReportSnapshot {
  const limitations = ["Git-ignored files, Hunch memory/cache, and external dependencies are outside this source snapshot."];
  try {
    const base = realpathSync(root);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") delete env[key];
    const paths = execFileSync("git", ["-C", base, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { env, timeout: 5_000, maxBuffer: 4_000_000 }).toString("utf8").split("\0").filter(Boolean);
    const sorted = [...new Set(paths)].sort();
    if (sorted.length > 20_000) throw new Error("source file count exceeds snapshot limit");
    const entries: Array<[string, string | null, number]> = [];
    let bytes = 0;
    for (const path of sorted) {
      if (path.split("/").some(p => p === ".hunch" || p === ".hunch-cache" || p === ".git")) continue;
      const file = resolve(base, path);
      const rel = relative(base, file);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new Error("source path escapes repository");
      let stat;
      try { stat = lstatSync(file); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { entries.push([path, null, 0]); continue; } throw e; }
      const parent = relative(base, realpathSync(dirname(file)));
      if (isAbsolute(parent) || parent === ".." || parent.startsWith("../") || parent.startsWith("..\\")) throw new Error("source parent escapes repository");
      if (stat.isSymbolicLink()) { entries.push([path, reportHash(readlinkSync(file)), 0o120000]); continue; }
      if (!stat.isFile()) throw new Error("submodules or non-file sources require separate verification");
      bytes += stat.size;
      if (bytes > 64_000_000 || stat.size > 8_000_000) throw new Error("source bytes exceed snapshot limit");
      const content = readFileSync(file);
      const after = lstatSync(file);
      if (stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.size !== after.size || content.length !== stat.size) throw new Error("source changed during snapshot");
      entries.push([path, `sha256:${createHash("sha256").update(content).digest("hex")}`, stat.mode & 0o111]);
    }
    return { hash: reportHash(entries), limitations };
  } catch {
    return { hash: null, limitations: [...limitations, "A complete bounded source snapshot was unavailable; no current-change verification is claimed."] };
  }
}

/** Evaluate every delivered lesson's DECLARED rule against the files this task
 * changed (working tree vs HEAD). Deterministic and Hunch-owned: the agent
 * neither chooses the rule nor submits the verdict. A constraint is judged by its
 * forbids matcher over the added lines of its scoped changed files; a decision by
 * its conformance predicates over the current working graph, and only when a
 * predicate's subject lives in a changed file. Everything else stays
 * `not-exercised` or `unavailable` — never "satisfied" by file overlap. */
export function runReportConformance(root: string, store: HunchStore, taskId: string): ReportConformance[] {
  const report = readTaskReport(root, taskId);
  if (report.task.state !== "open") throw new Error("cannot evaluate rules for a closed task");
  const delivered = [...new Map(report.deliveries.flatMap(d => d.records).filter(r => r.kind === "constraints" || r.kind === "decisions").map(r => [`${r.kind}:${r.record_id}:${r.content_hash}`, r])).values()];
  if (!delivered.length) return [];
  const before = reportSourceSnapshot(root).hash;
  const files = workingFiles(root);
  const changed = new Set(files);
  const diff = workingDiff(root);
  const analysis = analyzeDiff(diff);
  const truncated = diff.endsWith("…(diff truncated)…");
  let graph: ConformanceGraph | null | undefined;
  const workingGraph = (): ConformanceGraph | null => {
    if (graph !== undefined) return graph;
    try { const scan = scanRepo(store, root, { churn: false, source: { kind: "working" } }); assertCompleteRepoScan(scan); graph = { symbols: scan.symbols, edges: scan.edges }; }
    catch { graph = null; }
    return graph;
  };
  const results: ReportConformance[] = [];
  for (const record of delivered) {
    const base = { source: "local-rule-check" as const, record_id: record.record_id, kind: record.kind as "constraints" | "decisions", content_hash: record.content_hash, snapshot: null };
    const note = (rule: ReportConformance["rule"], outcome: ReportConformance["outcome"], detail: string, scoped: string[] = []) =>
      results.push({ ...base, rule, outcome, files: scoped.slice(0, 64), detail: detail.slice(0, 1000) });
    if (record.kind === "constraints") {
      const constraint = store.recs("constraints").find(c => c.id === record.record_id);
      if (!constraint || reportHash(constraint) !== record.content_hash) { note("constraint-forbids", "unavailable", "The delivered record revision is no longer the stored revision; the rule of a different revision is not evaluated."); continue; }
      const forbids = effectiveForbids(constraint);
      if (!forbids) { note("constraint-forbids", "unavailable", "This constraint declares no forbids matcher; a scope-only rule cannot be verified deterministically."); continue; }
      const scoped = files.filter(f => store.checkConstraints(f).some(c => c.id === constraint.id));
      if (!scoped.length) { note("constraint-forbids", "not-exercised", "No changed file falls in this constraint's scope."); continue; }
      if (truncated) { note("constraint-forbids", "unavailable", "The working diff exceeds the bounded analysis budget; added lines were not fully inspected.", scoped); continue; }
      const match = matchForbids(forbids, new Set(analysis.addedDeps), scoped.flatMap(f => analysis.addedLinesByFile.get(f) ?? []));
      if (match) note("constraint-forbids", "violated", `Added code trips the ${match.tier} rule: ${match.evidence.slice(0, 3).join("; ")}`, scoped);
      else note("constraint-forbids", "satisfied", `Added lines in ${scoped.length} scoped file(s) trip none of the forbidden ${[forbids.deps.length && "dependencies", forbids.symbols.length && "symbols", forbids.patterns.length && "patterns"].filter(Boolean).join("/")}.`, scoped);
      continue;
    }
    const decision = store.recs("decisions").find(d => d.id === record.record_id);
    if (!decision || reportHash(decision) !== record.content_hash) { note("decision-conformance", "unavailable", "The delivered record revision is no longer the stored revision; the predicates of a different revision are not evaluated."); continue; }
    if (!decision.conformance?.length) { note("decision-conformance", "unavailable", "This decision declares no conformance predicate; its intent cannot be verified deterministically."); continue; }
    const current = workingGraph();
    if (!current) { note("decision-conformance", "unavailable", "The working source graph could not be scanned completely; no predicate result is claimed."); continue; }
    const subjects = decision.conformance.map(p => p.subject);
    const exercised = current.symbols.filter(s => changed.has(s.file) && subjects.some(ref => ref === s.id || ref === s.name || (ref.includes(":") && s.name === ref.slice(ref.lastIndexOf(":") + 1) && (s.file === ref.slice(0, ref.lastIndexOf(":")) || s.file.endsWith("/" + ref.slice(0, ref.lastIndexOf(":")))))));
    if (!exercised.length) { note("decision-conformance", "not-exercised", "No predicate subject is defined in a changed file."); continue; }
    const verdicts = checkConformance(store, { graph: current }).filter(r => r.decision === decision.id);
    if (!verdicts.length) { note("decision-conformance", "unavailable", "The decision is not in force; its predicates are not evaluated."); continue; }
    const scoped = [...new Set(exercised.map(s => s.file))].sort();
    const failed = verdicts.filter(v => !v.satisfied);
    if (failed.length) note("decision-conformance", "violated", failed.map(v => v.detail).join("; "), scoped);
    else note("decision-conformance", "satisfied", verdicts.map(v => v.detail).join("; "), scoped);
  }
  const after = reportSourceSnapshot(root).hash;
  const snapshot = before !== null && before === after ? before : null;
  return results.map(result => {
    const value: ReportConformance = { ...result, snapshot, ...(snapshot === null ? { detail: `${result.detail} Source changed during evaluation, so this result is not bound to a current snapshot.`.slice(0, 1000) } : {}) };
    recordReportConformance(root, taskId, value);
    return value;
  });
}

/** A deliberately explicit command wrapper. The caller chooses the command;
 * reports never execute commands automatically to validate submitted claims. */
export async function runReportCheck(root: string, taskId: string, command: string[], label: string, timeoutMs = 120_000, options: {
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
} = {}): Promise<ReportCheck> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("verification timeout must be between 1 and 600000 ms");
  options.signal?.throwIfAborted();
  const task = readTaskReport(root, taskId).task;
  if (task.state !== "open") throw new Error("cannot verify a closed task");
  const before = reportSourceSnapshot(root);
  // Validate sensitive arguments before executing or writing anything.
  ReportCheckSchema.parse({ label, command, exit_code: null, output_hash: reportHash(""), before_snapshot: before.hash, after_snapshot: null, snapshot_limitations: before.limitations, timed_out: false, source: "local-command-runner" });
  const checkId = beginReportCheck(root, taskId, label);
  const result = await new Promise<{ code: number | null; timedOut: boolean; cancelled: boolean; hash: string }>((resolveResult) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const stdout = createHash("sha256"), stderr = createHash("sha256");
    let timedOut = false, cancelled = false, settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      child.stdout.destroy(); child.stderr.destroy();
      resolveResult({ code, timedOut, cancelled, hash: reportHash({ stdout: stdout.digest("hex"), stderr: stderr.digest("hex") }) });
    };
    const stopTree = () => {
      if (settled || cleanupTimer) return;
      if (child.pid) {
        if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 1_000, windowsHide: true }, () => {});
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }
      // A descendant can detach or inherit pipes. Always bound settlement even
      // if the OS cannot confirm process-tree cleanup; timed-out is never pass.
      cleanupTimer = setTimeout(() => settle(null), 1_200);
    };
    const cancel = () => { cancelled = true; stopTree(); };
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, timeoutMs);
    // Separate streaming digests are stable across stdout/stderr chunk ordering.
    child.stdout.on("data", chunk => { if (!settled) { stdout.update(chunk); options.onStdout?.(chunk); } });
    child.stderr.on("data", chunk => { if (!settled) { stderr.update(chunk); options.onStderr?.(chunk); } });
    child.once("error", () => settle(null));
    child.once("close", code => settle(code));
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
  const after = reportSourceSnapshot(root);
  const check: ReportCheck = { check_id: checkId, label, command, exit_code: result.code, output_hash: result.hash, before_snapshot: before.hash, after_snapshot: after.hash,
    snapshot_limitations: [...new Set([...before.limitations, ...after.limitations])], timed_out: result.timedOut, cancelled: result.cancelled, source: "local-command-runner" };
  recordReportCheck(root, taskId, check);
  return check;
}
