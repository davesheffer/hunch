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
/** A conversation-tab comment or a review body: PR-level text with no file anchor. */
const entrySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["comment", "review"]),
  body: z.string().trim().min(1).max(65536),
  html_url: z.string().url(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  commit_id: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  user: z.object({ login: z.string().min(1).max(100), type: z.enum(["User", "Bot"]) }),
}).strict();
type DiscussionEntry = z.infer<typeof entrySchema>;
const pullSchema = z.object({ number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  files: z.array(pathSchema).max(100), entries: z.array(entrySchema).max(200) }).strict();
export interface ReviewCandidate {
  id: string;
  evidence_hash: string;
  file: string;
  comments: Comment[];
}
export interface DiscussionCandidate {
  id: string;
  evidence_hash: string;
  pr: number;
  files: string[];
  entries: DiscussionEntry[];
}
export interface ReviewPacket {
  schema: "hunch.review-memory/1";
  repository: string;
  authority: "none";
  candidates: ReviewCandidate[];
  excluded_bots: number;
  discussions?: DiscussionCandidate[];
  incomplete_discussions?: number;
}

const graphqlAuthor = z.object({ login: z.string(), __typename: z.string() }).nullable();
const graphqlText = { databaseId: z.number().nullable(), body: z.string(), url: z.string(), createdAt: z.string(),
  updatedAt: z.string(), author: graphqlAuthor };
const graphqlPull = z.object({
  number: z.number(),
  comments: z.object({ totalCount: z.number(), nodes: z.array(z.object(graphqlText)) }),
  reviews: z.object({ totalCount: z.number(), nodes: z.array(z.object({ ...graphqlText,
    commit: z.object({ oid: z.string() }).nullable().optional() })) }),
  files: z.object({ totalCount: z.number(), nodes: z.array(z.object({ path: z.string() })) }).nullable(),
});

/** Normalize `gh api graphql --paginate --slurp` pull-request pages. A truncated discussion is dropped, never sliced. */
export function pullDiscussionsFromGraphql(pages: unknown): { pull_requests: z.infer<typeof pullSchema>[]; incomplete_discussions: number } {
  const nodes = z.array(z.object({ data: z.object({ repository: z.object({ pullRequests: z.object({
    nodes: z.array(graphqlPull) }) }) }) })).parse(pages).flatMap(page => page.data.repository.pullRequests.nodes);
  const pull_requests: z.infer<typeof pullSchema>[] = [];
  let incomplete = 0;
  for (const pr of nodes) {
    // A missing or truncated file list only costs a pull request that had something human to analyze.
    const analyzable = [...pr.comments.nodes, ...pr.reviews.nodes].some(n => n.author?.__typename !== "Bot" && n.body.trim());
    if (pr.comments.totalCount > pr.comments.nodes.length || pr.reviews.totalCount > pr.reviews.nodes.length
      || (analyzable && (!pr.files || pr.files.totalCount > pr.files.nodes.length))
      || [...pr.comments.nodes, ...pr.reviews.nodes].some(n => n.databaseId === null)) { incomplete++; continue; }
    const entry = (kind: "comment" | "review", n: z.infer<typeof graphqlPull>["reviews"]["nodes"][number]) => ({
      id: n.databaseId ?? 0, kind, body: n.body, html_url: n.url, created_at: n.createdAt, updated_at: n.updatedAt,
      ...(n.commit?.oid ? { commit_id: n.commit.oid } : {}),
      // GraphQL reports a deleted account as a null author; REST calls it ghost.
      user: n.author ? { login: n.author.login, type: n.author.__typename === "Bot" ? "Bot" as const : "User" as const }
        : { login: "ghost", type: "User" as const },
    });
    const entries = [...pr.comments.nodes.map(n => entry("comment", n)), ...pr.reviews.nodes.map(n => entry("review", n))]
      .filter(e => e.body.trim());
    // Paths a literal scope cannot express are not offered as rule anchors.
    const files = (pr.files?.nodes ?? []).map(f => f.path).filter(p => pathSchema.safeParse(p).success);
    pull_requests.push({ number: pr.number, files, entries });
  }
  return { pull_requests, incomplete_discussions: incomplete };
}

function prepareDiscussions(repository: string, input: unknown[]): { discussions: DiscussionCandidate[]; excluded: number } {
  const pulls = z.array(pullSchema).max(10000).parse(input);
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const seen = new Set<number>();
  const discussions: DiscussionCandidate[] = [];
  let excluded = 0;
  for (const pull of pulls) {
    if (seen.has(pull.number)) throw new Error(`duplicate pull request ${pull.number}`);
    seen.add(pull.number);
    for (const entry of pull.entries) {
      const url = new URL(entry.html_url);
      const anchor = entry.kind === "comment" ? `#issuecomment-${entry.id}` : `#pullrequestreview-${entry.id}`;
      if (url.origin !== "https://github.com" || url.username || url.password || url.search
        || !new RegExp(`^/${escaped}/pull/${pull.number}$`, "i").test(url.pathname) || url.hash !== anchor) {
        throw new Error(`${entry.kind} ${entry.id} does not belong to ${repository} pull ${pull.number}`);
      }
    }
    const humans = pull.entries.filter(e => e.user.type !== "Bot");
    excluded += pull.entries.length - humans.length;
    if (!humans.length || !pull.files.length) continue;
    humans.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.kind.localeCompare(b.kind) || a.id - b.id);
    const files = [...new Set(pull.files)].sort();
    discussions.push({ id: `review_pr_${pull.number}`, pr: pull.number, files, entries: humans,
      evidence_hash: canonicalHash({ repository: repository.toLowerCase(), pr: pull.number, files, entries: humans }) });
  }
  discussions.sort((a, b) => a.pr - b.pr);
  return { discussions, excluded };
}

/**
 * Accept GitHub REST review-comment exports, including gh --paginate --slurp pages, or
 * `{ review_comments, pull_requests }` where pull_requests carry conversation comments and review bodies.
 */
export function prepareReviewMemory(repository: string, input: unknown): ReviewPacket {
  repositorySchema.parse(repository);
  if (Array.isArray(input)) return prepareThreads(repository, input);
  const raw = z.object({ review_comments: z.array(z.unknown()), pull_requests: z.array(z.unknown()),
    incomplete_discussions: z.number().int().nonnegative().optional() }).strict().parse(input);
  const packet = prepareThreads(repository, raw.review_comments);
  const { discussions, excluded } = prepareDiscussions(repository, raw.pull_requests);
  return { ...packet, excluded_bots: packet.excluded_bots + excluded, discussions,
    incomplete_discussions: raw.incomplete_discussions ?? 0 };
}

function prepareThreads(repository: string, input: unknown[]): ReviewPacket {
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
    discussions: z.array(z.object({ id: z.string(), evidence_hash: z.string(), pr: z.number().int().positive(),
      files: z.array(pathSchema).min(1).max(100), entries: z.array(entrySchema).min(1).max(200) }).strict()).max(10000).optional(),
    incomplete_discussions: z.number().int().nonnegative().optional(),
  }).strict().parse(input);
  const comments = packet.candidates.flatMap(c => c.comments);
  const rebuilt = packet.discussions ? prepareReviewMemory(packet.repository, { review_comments: comments,
    pull_requests: packet.discussions.map(d => ({ number: d.pr, files: d.files, entries: d.entries })) })
    : prepareReviewMemory(packet.repository, comments);
  if (canonicalHash(rebuilt.candidates) !== canonicalHash(packet.candidates)
    || canonicalHash(rebuilt.discussions ?? null) !== canonicalHash(packet.discussions ?? null)) {
    throw new Error("review packet evidence hash or membership changed; prepare it again");
  }
  return packet;
}

/** A separate, explicit selection supplies the actual rule and how to check it. */
export function compileReviewRules(packetInput: unknown, selections: unknown, now: string): Constraint[] {
  const packet = validateReviewPacket(packetInput);
  const rules = z.array(z.object({
    candidate_id: z.string(), evidence_hash: z.string(),
    rule: z.string().trim().min(10).max(2000),
    check: z.string().trim().min(10).max(4000),
    file: pathSchema.optional(),
  }).strict()).min(1).max(100).parse(selections);
  const results = rules.map(selection => {
    const thread = packet.candidates.find(c => c.id === selection.candidate_id);
    const discussion = packet.discussions?.find(d => d.id === selection.candidate_id);
    const candidate = thread ?? discussion;
    if (!candidate || candidate.evidence_hash !== selection.evidence_hash) throw new Error(`stale or missing review selection ${selection.candidate_id}`);
    // A thread is anchored to its file; a PR discussion must name one of the PR's files.
    const file = thread ? thread.file : selection.file;
    if (!file || (thread && selection.file && selection.file !== thread.file) || (discussion && !discussion.files.includes(file))) {
      throw new Error(`review selection ${selection.candidate_id} needs a file from its own evidence`);
    }
    const record = buildCorrectionConstraint({ rule: selection.rule, scope_hint_file: file,
      severity: "warning", vouched: false, rationale: `Review check: ${selection.check}` }, now);
    // Prose cannot silently create a regex/import matcher or earn a human signature.
    record.forbids = null;
    record.provenance.evidence = [packet.repository, candidate.id, candidate.evidence_hash,
      ...(thread ? thread.comments.flatMap(c => [c.html_url, `git:${c.commit_id}`])
        : discussion!.entries.flatMap(e => [e.html_url, ...(e.commit_id ? [`git:${e.commit_id}`] : [])]))];
    return record;
  });
  if (new Set(results.map(r => r.id)).size !== results.length) throw new Error("duplicate rule statements; select one thread per rule");
  return results;
}
