/** Review text is evidence, never executable instructions or policy authority. */
import { z } from "zod";
import { canonicalHash } from "../constitution/canonical.js";
import { buildCorrectionConstraint } from "./correction.js";
import type { Constraint } from "./types.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const pathSchema = z.string().min(1).max(500).refine(p =>
  !p.startsWith("/") && !/[\\:*?\[\]{}\x00-\x1f]/.test(p)
  && p.split("/").every(part => part !== ".." && part !== "." && part !== ""), "expected a literal repository-relative file");
const commentSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  body: z.string().trim().min(1).max(32000),
  path: pathSchema,
  html_url: z.string().url(),
  commit_id: z.string().regex(/^[a-f0-9]{40,64}$/),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  in_reply_to_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  user: z.object({ login: z.string().min(1).max(100), type: z.enum(["User", "Bot"]) }),
});
type Comment = z.infer<typeof commentSchema>;
export interface ReviewCandidate {
  id: string;
  evidence_hash: string;
  file: string;
  comments: Comment[];
}
export interface ReviewPacket {
  schema: "hunch.review-memory/1";
  repository: string;
  authority: "none";
  candidates: ReviewCandidate[];
  excluded_bots: number;
}

/** Accept GitHub REST review-comment exports, including gh --paginate --slurp pages. */
export function prepareReviewMemory(repository: string, input: unknown): ReviewPacket {
  repositorySchema.parse(repository);
  if (!Array.isArray(input)) throw new Error("expected a GitHub review-comment array");
  const comments = z.array(commentSchema).max(10000).parse(input.flat());
  const unique = new Map<number, Comment>();
  for (const comment of comments) {
    const url = new URL(comment.html_url);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search
      || !new RegExp(`^/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/[1-9][0-9]*$`, "i").test(url.pathname)
      || url.hash !== `#discussion_r${comment.id}`) throw new Error(`comment ${comment.id} does not belong to ${repository}`);
    const previous = unique.get(comment.id);
    if (previous && canonicalHash(previous) !== canonicalHash(comment)) throw new Error(`conflicting versions of comment ${comment.id}`);
    unique.set(comment.id, comment);
  }
  const groups = new Map<number, Comment[]>();
  let excluded = 0;
  for (const comment of unique.values()) {
    if (comment.user.type === "Bot") { excluded++; continue; }
    const rootId = comment.in_reply_to_id ?? comment.id;
    const group = groups.get(rootId) ?? [];
    group.push(comment);
    groups.set(rootId, group);
  }
  const candidates: ReviewCandidate[] = [];
  for (const [rootId, group] of groups) {
    // Do not misrepresent a reply as the original request when an export is partial.
    const root = group.find(comment => comment.id === rootId && !comment.in_reply_to_id);
    if (!root) throw new Error(`missing human root comment ${rootId}; export the complete thread`);
    if (group.some(comment => comment.path !== root.path || new URL(comment.html_url).pathname !== new URL(root.html_url).pathname)) {
      throw new Error(`inconsistent thread ${rootId}`);
    }
    group.sort((a, b) => a.id - b.id);
    const evidenceHash = canonicalHash({ repository: repository.toLowerCase(), comments: group });
    candidates.push({ id: `review_${rootId}`, evidence_hash: evidenceHash, file: root.path, comments: group });
  }
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { schema: "hunch.review-memory/1", repository: repository.toLowerCase(), authority: "none", candidates, excluded_bots: excluded };
}

export function validateReviewPacket(input: unknown): ReviewPacket {
  const packet = z.object({
    schema: z.literal("hunch.review-memory/1"), repository: repositorySchema,
    authority: z.literal("none"), excluded_bots: z.number().int().nonnegative(),
    candidates: z.array(z.object({ id: z.string(), evidence_hash: z.string(), file: pathSchema, comments: z.array(commentSchema).min(1) }).strict()).max(10000),
  }).strict().parse(input);
  const rebuilt = prepareReviewMemory(packet.repository, packet.candidates.flatMap(c => c.comments));
  if (canonicalHash(rebuilt.candidates) !== canonicalHash(packet.candidates)) throw new Error("review packet evidence hash or membership changed; prepare it again");
  return packet;
}

/** A separate, explicit selection supplies the actual rule and how to check it. */
export function compileReviewRules(packetInput: unknown, selections: unknown, now: string): Constraint[] {
  const packet = validateReviewPacket(packetInput);
  const rules = z.array(z.object({
    candidate_id: z.string(), evidence_hash: z.string(),
    rule: z.string().trim().min(10).max(2000),
    check: z.string().trim().min(10).max(4000),
  }).strict()).min(1).max(100).parse(selections);
  const results = rules.map(selection => {
    const candidate = packet.candidates.find(c => c.id === selection.candidate_id);
    if (!candidate || candidate.evidence_hash !== selection.evidence_hash) throw new Error(`stale or missing review selection ${selection.candidate_id}`);
    const record = buildCorrectionConstraint({ rule: selection.rule, scope_hint_file: candidate.file,
      severity: "warning", vouched: false, rationale: `Review check: ${selection.check}` }, now);
    // Prose cannot silently create a regex/import matcher or earn a human signature.
    record.forbids = null;
    record.provenance.evidence = [packet.repository, candidate.id, candidate.evidence_hash,
      ...candidate.comments.flatMap(c => [c.html_url, `git:${c.commit_id}`])];
    return record;
  });
  if (new Set(results.map(r => r.id)).size !== results.length) throw new Error("duplicate rule statements; select one thread per rule");
  return results;
}
