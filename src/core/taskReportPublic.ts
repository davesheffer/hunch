/** Publication is a fresh public-store projection, never redaction of a local
 * report's prose. Task titles, actions, commands and native envelope text are private. */
import { JsonStore } from "../store/jsonStore.js";
import { hunchPaths } from "./paths.js";
import { readTaskReport, reportHash, type ReportRecord } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";

export function publicTaskReport(root: string, taskId: string) {
  const report = readTaskReport(root, taskId, reportSourceSnapshot(root).hash);
  const publicStore = new JsonStore(hunchPaths(root));
  const records = new Map<string, ReportRecord>();
  const deliveries: Array<{ occurrence_id: string; receipt_id: string; envelope_hash: string; record_id: string; record_hash: string }> = [];
  for (const delivery of report.deliveries) {
    for (const snapshot of delivery.records) {
      const item = delivery.envelope.delivered.find(r => r.record_id === snapshot.record_id && r.kind === snapshot.kind);
      if (!item) continue;
      const record = publicStore.loadAll(item.kind === "relationships" ? "edges" : item.kind).find(r => r.id === item.record_id);
      if (!record || reportHash(record) !== snapshot.content_hash) continue;
      // Reconstruct human-readable content from public records, not caller-supplied snapshots.
      const raw = record as unknown as Record<string, unknown>;
      const text = (...keys: string[]) => keys.map(k => raw[k]).find(v => typeof v === "string") as string | undefined;
      const safe: ReportRecord = { record_id: record.id, kind: item.kind, content_hash: snapshot.content_hash,
        title: (text("title", "statement", "name", "reason") ?? record.id).slice(0, 500),
        lesson: (text("decision", "statement", "description", "root_cause", "reason", "title", "name") ?? record.id).slice(0, 12_000),
        recorded_at: text("date", "created_at", "observed_at", "valid_from") ?? null };
      records.set(`${item.kind}:${record.id}:${snapshot.content_hash}`, safe);
      deliveries.push({ occurrence_id: delivery.occurrence_id, receipt_id: delivery.receipt_id, envelope_hash: delivery.envelope_hash, record_id: record.id, record_hash: snapshot.content_hash });
    }
  }
  const allowed = new Set(deliveries.map(d => `${d.occurrence_id}:${d.record_id}:${d.record_hash}`));
  const applications = report.claims.filter(c => allowed.has(`${c.occurrence_id}:${c.record_id}:${c.content_hash}`)).map(c => ({ occurrence_id: c.occurrence_id, record_id: c.record_id, content_hash: c.content_hash, attribution: "agent-reported" as const, detail: "Action details withheld from public export." }));
  const unsigned = {
    schema: "hunch.public-task-report/1" as const,
    title: "Hunch contribution · public evidence", state: report.task.state,
    records: [...records.values()], deliveries, applications,
    limitations: ["Only exact record revisions currently present in the public store are included.", "Task identity, task prose, private memory, command results and native delivery payloads are omitted. Receipt hashes identify local evidence; their full payloads are not published.", "Agent-reported application does not establish causal impact."],
  };
  return { ...unsigned, content_hash: reportHash(unsigned) };
}
export type PublicTaskReport = ReturnType<typeof publicTaskReport>;

export function renderPublicTaskReportHtml(report: PublicTaskReport): string {
  const esc = (x: unknown) => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(report.title)}</title><style>body{margin:40px auto;padding:0 24px;max-width:850px;font:16px/1.6 system-ui,sans-serif;color:#193725;background:#f6f8f5}article{padding:24px;border:1px solid #b9cbbd;border-radius:12px;background:white;margin:18px 0}h1{font-size:36px}code{overflow-wrap:anywhere}pre{white-space:pre-wrap}summary{cursor:pointer;padding:8px 0}:focus-visible{outline:3px solid #276540}</style></head><body><h1>${esc(report.title)}</h1><p>${report.records.length} public lesson(s) · ${esc(report.state)}</p>${report.records.map(r => `<article><h2>${esc(r.title)}</h2><p>${esc(r.lesson)}</p><p>${esc(r.record_id)}</p><code>${esc(r.content_hash)}</code><details><summary>Inspect public delivery references</summary><pre>${esc(JSON.stringify(report.deliveries.filter(d => d.record_id === r.record_id && d.record_hash === r.content_hash), null, 2))}</pre></details></article>`).join("")}<h2>Limits of this export</h2><ul>${report.limitations.map(l => `<li>${esc(l)}</li>`).join("")}</ul><p>${report.applications.length} agent-reported application(s); action details withheld.</p><footer><code>${esc(report.content_hash)}</code></footer></body></html>`;
}
