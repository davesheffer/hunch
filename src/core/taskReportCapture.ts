/** Observes the return of an actual store write. A missing report cannot roll
 * back durable memory or turn the primary successful capture into an error. */
import { execFileSync } from "node:child_process";
import { foreignRepoEnv, type GitMemoryObserver } from "../extractors/git.js";
import { ReportRecordSchema, recordReportSave, recordReportDurability, reportHash } from "./taskReport.js";

export function observeReportCapture(root: string, taskId: string | undefined, kind: "decisions" | "constraints" | "findings", stored: { id: string }, home: "public" | "private", existed: boolean, hunchDir?: string): { saveId: string | null; note: string; observe?: GitMemoryObserver } {
  if (!taskId) return { saveId: null, note: "" };
  try {
    // The store's atomic JSON writer omits undefined properties. Match those
    // persisted bytes' semantic value, not an in-memory optional-property shape.
    const raw = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    const text = (...keys: string[]) => keys.map(k => raw[k]).find(v => typeof v === "string") as string | undefined;
    const record = ReportRecordSchema.parse({ record_id: stored.id, kind, content_hash: reportHash(raw),
      title: (text("title", "statement") ?? stored.id).slice(0, 500),
      lesson: (text("decision", "statement", "observation", "title") ?? stored.id).slice(0, 12_000),
      recorded_at: text("date", "observed_at", "valid_from") ?? null });
    const saveId = recordReportSave(root, taskId, { source: "store-write", record, home, operation: existed ? "updated" : "created" });
    const observe: GitMemoryObserver | undefined = hunchDir ? event => {
      try {
        const env = { ...foreignRepoEnv(process.env), GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
        const prefix = execFileSync("git", ["-C", hunchDir, "rev-parse", "--show-prefix"], { env, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        const rawBlob = execFileSync("git", ["-C", hunchDir, "show", `${event.commitSha}:${prefix}${kind}/${stored.id}.json`], { env, encoding: "utf8", timeout: 2_000, maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "ignore"] });
        if (reportHash(JSON.parse(rawBlob)) !== record.content_hash) return;
        recordReportDurability(root, taskId, { save_id: saveId, durability: event.kind === "published" ? "pushed" : "committed", commit: event.commitSha, record_hash: record.content_hash, source: "git-record-proof", ...(event.kind === "published" ? { publication: { ref: event.ref, basis: event.basis } } : {}) });
      } catch { /* skipped, changed, or unavailable proof remains unverified */ }
    } : undefined;
    return { saveId, observe, note: `\nTask evidence: saved revision retained in ${taskId}.` };
  } catch {
    return { saveId: null, note: "\nTask report unavailable for this capture. The primary memory write succeeded; its task association is unverified." };
  }
}
