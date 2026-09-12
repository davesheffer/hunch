import { mkdirSync } from "node:fs";
import { writeFileAtomic } from "./io.js";
import { readTaskReport, readLessonHistory, type LessonHistory, type TaskReport } from "./taskReport.js";
import { reportSourceSnapshot } from "./taskReportEvidence.js";
import { assertReportPath } from "./taskReportPaths.js";
import { publicTaskReport, renderPublicTaskReportHtml } from "./taskReportPublic.js";

export function writeTaskReportHtml(root: string, taskId: string, publicOnly = false): string {
  const report = readTaskReport(root, taskId, reportSourceSnapshot(root).hash);
  const directory = assertReportPath(root, ".hunch-cache", "reports");
  mkdirSync(directory, { recursive: true });
  const file = assertReportPath(root, ".hunch-cache", "reports", `${report.task.task_id}${publicOnly ? ".public" : ""}.html`);
  let histories: LessonHistory[] | null = [];
  if (!publicOnly) {
    try { histories = historyRecords(report).slice(0, 3).map(record => readLessonHistory(root, { kind: record.kind, record_id: record.record_id, content_hash: record.content_hash }, { limit: 8 })); }
    catch { histories = null; } // History is optional; retain the primary task evidence if unavailable.
  }
  writeFileAtomic(file, publicOnly ? renderPublicTaskReportHtml(publicTaskReport(root, taskId)) : renderTaskReportHtml(report, undefined, histories));
  return file;
}

function plain(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim(); }
function clip(value: string, size = 66): string { const chars = [...plain(value)]; return chars.length > size ? chars.slice(0, size - 1).join("") + "…" : chars.join(""); }
function uniqueRecords(report: TaskReport) {
  return [...new Map(report.deliveries.flatMap(d => d.records).map(r => [`${r.kind}:${r.record_id}:${r.content_hash}`, r])).values()];
}
function historyRecords(report: TaskReport) {
  return [...new Map([...uniqueRecords(report), ...report.saves.map(s => s.record)].map(r => [`${r.kind}:${r.record_id}:${r.content_hash}`, r])).values()];
}
/** The last evaluation of each delivered record revision is its standing. */
function ruleStanding(report: TaskReport) {
  return [...new Map(report.conformance.map(r => [`${r.kind}:${r.record_id}:${r.content_hash}`, r])).values()];
}
function recordTitle(report: TaskReport, rule: { kind: string; record_id: string; content_hash: string }): string {
  return uniqueRecords(report).find(r => r.kind === rule.kind && r.record_id === rule.record_id && r.content_hash === rule.content_hash)?.title ?? rule.record_id;
}
/** One short line for the first time a lesson reaches a task; null when every
 * delivered revision was already seen in this task. Never a banner per delivery. */
export function renderRecalledLine(fresh: readonly { title: string }[]): string | null {
  if (!fresh.length) return null;
  const rest = fresh.length - 1;
  return `Hunch recalled: ${clip(fresh[0]!.title, 90)}${rest ? ` (+${rest} more lesson${rest === 1 ? "" : "s"})` : ""}`;
}
export function renderTaskReport(report: TaskReport): string {
  const records = uniqueRecords(report);
  const lines = [`Hunch · ${clip(report.task.title)}`, `Task ${report.task.task_id} · ${report.task.state}`];
  if (!report.deliveries.length) lines.push("No task-linked delivery observed; connection/use is unverified.");
  else if (!records.length) lines.push(report.coverage === "no-relevant-memory" ? "No relevant memory returned for this task." : "Memory delivered; exact record snapshots unavailable.");
  else {
    lines.push(`Recalled  ${clip(records[0]!.title, 65)}`);
    if (records.length > 1) lines.push(`          ${records.length - 1} more lesson(s) in the evidence view`);
  }
  const standing = ruleStanding(report);
  const violated = standing.find(r => r.outcome === "violated");
  const held = standing.find(r => r.outcome === "satisfied" && r.current);
  if (report.claims.length) {
    const claim = report.claims.find(c => c.supported_by) ?? report.claims[0]!;
    lines.push(`Applied   ${clip(claim.action, 42)} · ${claim.supported_by ? "rule-supported" : "agent-reported"}`);
  } else if (held) lines.push(`Conformed ${clip(recordTitle(report, held), 34)} · rule held on ${held.files.length} changed file(s)`);
  else if (records.length) lines.push("Impact    Memory delivered; contribution unverified.");
  if (violated) lines.push(`Violated  ${clip(recordTitle(report, violated), 34)} · rule broken on changed files`);
  if (report.saves.length) lines.push(`Saved     ${clip(report.saves[0]!.record.title, 38)} · ${report.saves[0]!.durability}`);
  if (report.refusals.length) lines.push(`Guarded   Denial emitted · ${clip(report.refusals[0]!.record_id, 40)}`);
  const check = report.checks.at(-1);
  if (check) {
    const state = check.cancelled ? "cancelled" : check.timed_out ? "timed out" : check.exit_code === 0 ? "passed" : "failed";
    lines.push(`Checked   ${clip(check.label, 28)} · ${state}${check.current ? " · current source snapshot" : " · current source unverified"}`);
  } else lines.push("Checked   No independent command result recorded.");
  lines.push(`Evidence  hunch report ${report.task.task_id} --html`);
  return lines.join("\n");
}

function esc(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
/** Standalone, local-only projection. No active content, external assets or
 * untrusted outbound URLs; evidence references are internal anchors. */
export function renderTaskReportHtml(report: TaskReport, generatedAt = new Date().toISOString(), histories: LessonHistory[] | null = []): string {
  const records = uniqueRecords(report);
  const section = (title: string, body: string) => `<section><h2>${title}</h2>${body}</section>`;
  const empty = (message: string) => `<p class="muted">${esc(message)}</p>`;
  const deliveries = report.deliveries.map((d, index) => `<article id="delivery-${index}"><div class="eyebrow">DELIVERED · ${esc(d.at)}</div><h3>${d.records.length ? esc(d.records.map(r => r.title).join(" · ")) : "No retained lesson snapshot"}</h3><p>${d.envelope.delivered.length} record(s) returned. ${d.envelope.abstention.active ? "Some memory withheld for insufficient relevance or confidence." : ""}</p><details><summary>Inspect exact delivery</summary><dl><dt>Receipt</dt><dd>${esc(d.receipt_id)}</dd><dt>Occurrence</dt><dd>${esc(d.occurrence_id)}</dd><dt>Envelope hash</dt><dd>${esc(d.envelope_hash)}</dd></dl><pre>${esc(d.envelope.text)}</pre></details></article>`).join("");
  const lessons = records.map(r => `<article><div class="eyebrow">${esc(r.kind)} · ${esc(r.recorded_at ?? "creation date unavailable")}</div><h3>${esc(r.title)}</h3><p class="lesson">${esc(r.lesson)}</p><details><summary>Original record identity</summary><p>${esc(r.record_id)}</p><code>${esc(r.content_hash)}</code></details></article>`).join("");
  const claims = report.claims.map(c => { const index = report.deliveries.findIndex(d => d.occurrence_id === c.occurrence_id); return `<article><span class="badge">${c.supported_by ? "RULE-SUPPORTED · AGENT-REPORTED" : "AGENT-REPORTED"}</span><h3>${esc(c.action)}</h3><p>${c.supported_by ? `This is the agent's attribution. Hunch separately evaluated the lesson's declared rule against the changed files and it held on the current source (<a href="#rule-${esc(c.supported_by)}">open the rule evaluation</a>).` : "This is the agent's attribution. No current, satisfied rule evaluation supports it; verification below establishes only the recorded command result."}</p><a href="#delivery-${index}">Open the lesson's delivery</a></article>`; }).join("");
  const rules = ruleStanding(report).map(r => { const label = r.outcome === "satisfied" ? (r.current ? "RULE HELD" : "RULE HELD · SOURCE CHANGED SINCE") : r.outcome === "violated" ? "RULE VIOLATED" : r.outcome === "not-exercised" ? "NOT EXERCISED" : "NO CHECKABLE RULE"; return `<article id="rule-${esc(r.event_id)}"><span class="badge">${label}</span><h3>${esc(recordTitle(report, r))}</h3><p>${esc(r.detail)}</p>${r.files.length ? `<p class="muted">Changed files in scope: ${esc(r.files.join(", "))}</p>` : ""}<details><summary>Inspect rule evaluation</summary><dl><dt>Rule</dt><dd>${esc(r.rule)}</dd><dt>Evaluated</dt><dd>${esc(r.at)}</dd><dt>Record revision</dt><dd>${esc(r.content_hash)}</dd><dt>Source snapshot</dt><dd>${esc(r.snapshot ?? "unavailable")}</dd></dl><p>Hunch evaluated the lesson's own declared rule on the files this task changed. A held rule shows the change conforms to that lesson; it is not proof the agent read it.</p></details></article>`; }).join("");
  const checks = report.checks.map(c => `<article><span class="badge">${c.cancelled ? "CANCELLED" : c.timed_out ? "TIMED OUT" : c.exit_code === 0 ? "COMMAND PASSED" : "COMMAND FAILED"}</span><h3>${esc(c.label)}</h3><p>${c.current ? "When this report was generated, source matched the snapshots observed before and after this command." : "At report generation, source verification was unavailable or the source had changed."}</p><pre>${esc(c.command.map(x => JSON.stringify(x)).join(" "))}</pre><details><summary>Inspect verification evidence</summary><dl><dt>Observed</dt><dd>${esc(c.at)}</dd><dt>Exit code</dt><dd>${esc(c.exit_code ?? "unavailable")}</dd><dt>Output digest (raw output not retained)</dt><dd>${esc(c.output_hash)}</dd><dt>Before snapshot</dt><dd>${esc(c.before_snapshot ?? "unavailable")}</dd><dt>After snapshot</dt><dd>${esc(c.after_snapshot ?? "unavailable")}</dd></dl>${c.snapshot_limitations.map(x => `<p>${esc(x)}</p>`).join("")}</details></article>`).join("");
  const saves = report.saves.map(s => `<article><span class="badge">${esc(s.durability.toUpperCase())}</span><h3>${esc(s.record.title)}</h3><p>${esc(s.operation)} in ${esc(s.home)} memory. Exact saved revision: <code>${esc(s.record.content_hash)}</code>.</p><p>${s.durability === "local" ? "No exact commit or push proof is retained for this revision." : "Git proof applies to this revision at the observed time, not the current remote state."}</p><details><summary>Inspect save evidence</summary><p>${esc(s.event_id)} · ${esc(s.at)}</p>${s.proofs.map(p => `<p>${esc(p.durability)} · ${esc(p.at)} · <code>${esc(p.commit)}</code>${p.publication ? ` · ${esc(p.publication.ref)} · ${esc(p.publication.basis)}` : ""}</p>`).join("")}</details></article>`).join("");
  const refusals = report.refusals.map(r => `<article><span class="badge">DENIAL EMITTED</span><h3>${esc(r.record_id)}</h3><p>Hunch emitted a ${esc(r.kind)} denial for ${esc(r.target)}.</p><p>This does not establish that the host honored the denial or that a bug was prevented.</p><details><summary>Inspect gate evidence</summary><dl><dt>Observed</dt><dd>${esc(r.at)}</dd><dt>Event</dt><dd>${esc(r.event_id)}</dd><dt>Exact response reason digest</dt><dd>${esc(r.reason_hash)}</dd></dl></details></article>`).join("");
  const history = histories === null ? empty("Lesson history is unavailable. The task evidence above is retained.") : histories.map(h => `<article><h3>${esc(h.entries[0]?.record.title ?? h.reference.record_id)}</h3><p>Save and delivery observations show where a lesson appeared; they do not prove use or additional impact.</p>${h.entries.map(e => `<details><summary>${esc(e.task.title)} · ${esc(e.task.state)}</summary><p>${e.event === "save" ? "Saved" : "Delivered"} ${esc(e.at)}</p><p class="lesson">${esc(e.record.lesson)}</p><dl><dt>Exact revision</dt><dd>${esc(e.record.content_hash)}</dd><dt>Evidence reference</dt><dd>${esc(e.receipt_id ?? e.event_id)}</dd></dl><p>Inspect this task: <code>hunch report ${esc(e.task.task_id)} --html</code></p></details>`).join("")}${!h.index_complete ? empty("History indexing is incomplete. Refresh for additional retained evidence.") : ""}${h.truncated ? empty("Additional deliveries are available through the lesson history command.") : ""}</article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Hunch · ${esc(report.task.title)}</title><style>
:root{color-scheme:light dark;--bg:#f4f7f4;--paper:#fff;--ink:#162e24;--muted:#53685b;--line:#d5e1d8;--accent:#276540}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,sans-serif}main{max-width:920px;margin:auto;padding:48px 24px 80px}header{border-top:5px solid var(--accent);padding-top:24px;margin-bottom:40px}.eyebrow{font-size:12px;letter-spacing:.09em;color:var(--muted);font-weight:650}h1{font-size:clamp(28px,5vw,46px);line-height:1.15;letter-spacing:-.035em;margin:16px 0}h2{font-size:22px;margin:32px 0 12px}h3{font-size:18px;margin:12px 0 6px}p{margin:8px 0}article{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:22px;margin:12px 0}.muted,dt{color:var(--muted)}.badge{font-size:11px;letter-spacing:.06em;border:1px solid var(--line);border-radius:30px;padding:5px 10px}.lesson{white-space:pre-wrap}a{color:var(--accent);text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:5px}summary{cursor:pointer;font-weight:600;padding:8px 0}details{margin-top:16px}pre,code,dd{overflow-wrap:anywhere;word-break:break-word}pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace;padding:14px;background:var(--bg);border-radius:8px}dd{margin:0 0 12px}footer{border-top:1px solid var(--line);margin-top:36px;padding-top:20px;font-size:12px;color:var(--muted)}@media(prefers-color-scheme:dark){:root{--bg:#101b16;--paper:#17271e;--ink:#e3eee6;--muted:#a7b9ac;--line:#365041;--accent:#9cdbb0}}@media print{details>*{display:block}body{background:white;color:black}article{break-inside:avoid}}
</style></head><body><main><header><div class="eyebrow">HUNCH · TASK EVIDENCE · LOCAL REPORT</div><h1>${esc(report.task.title)}</h1><p>${records.length ? "Project experience carried into this task." : "What Hunch could observe in this task."}</p><p class="muted">${esc(report.task.state)} · ${esc(report.task.started_at)} · ${esc(report.task.task_id)}</p></header>${section("1. What the project remembered", lessons || empty("No lesson snapshot is available for this task."))}${section("2. What reached the agent", deliveries || empty("No task-linked delivery was observed. This does not prove the agent was disconnected."))}${section("3. How the agent says it applied", claims || empty("Contribution is unverified. A context delivery alone does not establish use."))}${section("4. What was checked", checks || empty("No independent command result was recorded."))}${section("5. How the change conforms to delivered rules", rules || empty("No delivered rule was evaluated. Finishing a task, or hunch task conform, evaluates each delivered lesson's declared rule against the changed files."))}${saves ? section("What was saved for future tasks", saves) : ""}${refusals ? section("When Hunch intervened", refusals) : ""}${section("Where this lesson appeared", (history || empty("No lesson history is included in this view.")) + (histories && historyRecords(report).length > histories.length ? empty(`History shown for ${histories.length} of ${historyRecords(report).length} lesson revisions. Inspect another revision with hunch report --lesson <record-id> --kind <kind> --revision <content-hash>.`) : ""))}${section("What remains unknown", report.unknowns.length ? `<ul>${report.unknowns.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : empty("The report makes no additional causal claim."))}<footer>Generated ${esc(generatedAt)}. This is a saved snapshot, not a live source check.<br>After editing source, refresh with <code>hunch report ${esc(report.task.task_id)} --html</code>.<br>Observed evidence, not a score or an estimate of bugs prevented.<br>Report ${esc(report.content_hash)}<br>Local report may contain private project memory. Keep it within the project's authorized audience.</footer></main></body></html>`;
}
