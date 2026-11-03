/**
 * Pull-request context for commit synthesis (#562 phase 1).
 *
 * On squash-merge repos the *why* often lives in the PR description, not the commit
 * that lands. When a commit subject names its PR ("Title (#N)", or GitHub's
 * "Merge pull request #N from owner/branch"), fetch that PR's description through the
 * user's own `gh` CLI and hand it to synthesis as a separate, bounded, labeled section.
 *
 * Phase 2: when the caller asks (only the Critic-verified path does), also fetch the
 * PR's human review/comment thread as a second bounded section. Bots are dropped; a
 * thread lookup that fails keeps the description.
 *
 * Everything here degrades to `null` silently: no GitHub `origin`, no `gh`, offline,
 * unauthenticated, a PR that does not match the commit, or HUNCH_PR_CONTEXT=0.
 * PR text is untrusted author-written data; the prompt labels it as such.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalRemoteRepositoryIdentity } from "../extractors/git.js";

/** Upper bound on PR description characters that reach a prompt. */
export const PR_BODY_MAX_CHARS = 8000;
/** Upper bound on rendered review-thread characters that reach a prompt. */
export const PR_THREAD_MAX_CHARS = 14000;

export interface PrContext {
  number: number;
  title: string;
  /** may be "" when only a review thread exists */
  body: string;
  /** true when the body was cut to PR_BODY_MAX_CHARS */
  truncated: boolean;
  /** the rendered human review thread, oldest first (only when requested) */
  thread?: string;
  /** true when the thread was cut to PR_THREAD_MAX_CHARS */
  threadTruncated?: boolean;
}

/** One review-thread message: a conversation comment, a review body, or an inline comment. */
export interface PrThreadMessage {
  author: string;
  bot: boolean;
  kind: "comment" | "review" | "inline";
  state?: string;
  body: string;
  at: string;
}

/** A PR's review thread as fetched: the newest messages, and whether older ones exist. */
export interface PrThread {
  messages: PrThreadMessage[];
  /** true when GitHub holds older messages than were fetched */
  truncated: boolean;
}

/** (owner/repo, PR number, cwd) → the PR's thread, or null when GitHub has no such PR;
 *  throws when the lookup itself fails. Same contract as PrFetcher. */
export type PrThreadFetcher = (repository: string, pr: number, cwd: string) => Promise<PrThread | null>;

/** What the fetcher returns: the raw GitHub pull-request fields we use. */
export interface PrRecord {
  title: string;
  body: string | null;
  merge_commit_sha: string | null;
  merged_at: string | null;
}

/** (owner/repo, PR number, cwd) → the PR, or null when GitHub has none; throws when the
 *  lookup itself fails. Injectable for tests. */
export type PrFetcher = (repository: string, pr: number, cwd: string) => Promise<PrRecord | null>;

const SQUASH_SUBJECT = /\s\(#(\d{1,9})\)$/;
const MERGE_SUBJECT = /^Merge pull request #(\d{1,9}) from \S+$/;

/** The PR number a commit subject names: squash "Title (#N)" or a GitHub merge commit. */
export function prNumberFromSubject(subject: string): number | undefined {
  const s = subject.trim();
  const m = SQUASH_SUBJECT.exec(s) ?? MERGE_SUBJECT.exec(s);
  return m ? Number(m[1]) : undefined;
}

const run = promisify(execFile);

const origins = new Map<string, string | null>();

/** owner/repo of a GitHub `origin`, or null for any other host or no origin. Memoized per root. */
export async function githubRepositoryOf(root: string): Promise<string | null> {
  if (origins.has(root)) return origins.get(root)!;
  let repository: string | null = null;
  try {
    const { stdout } = await run("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const m = /^provider:github:([a-z0-9-]+\/[a-z0-9._-]+)$/i.exec(canonicalRemoteRepositoryIdentity(stdout.trim(), root));
    repository = m ? m[1]! : null;
  } catch { /* no origin */ }
  origins.set(root, repository);
  return repository;
}

/** One `gh api` call. `gh` brings the user's own auth, so no token passes through Hunch.
 *  Resolves null when GitHub answers but has no usable PR (404, an issue number);
 *  THROWS when gh itself is unusable (missing, offline, timed out, unauthenticated). */
export const ghPrFetcher: PrFetcher = async (repository, pr, cwd) => {
  let out: string;
  try {
    // --hostname: the origin is github.com even when the user's gh defaults to an Enterprise host.
    ({ stdout: out } = await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/pulls/${pr}`], {
      cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    }));
  } catch (err) {
    // gh exits non-zero on an HTTP error but still prints GitHub's JSON error body.
    const e = err as { code?: unknown; stdout?: string };
    let answer: { status?: unknown; message?: unknown } = {};
    try { answer = JSON.parse(e.stdout ?? "") as typeof answer; } catch { /* not an API answer */ }
    if (typeof e.code === "number" && (answer.status === "404" || answer.status === "422" || answer.message === "Not Found")) return null;
    throw err;
  }
  const raw = JSON.parse(out) as Partial<PrRecord>;
  if (typeof raw.title !== "string") return null;
  return {
    title: raw.title,
    body: typeof raw.body === "string" ? raw.body : null,
    merge_commit_sha: typeof raw.merge_commit_sha === "string" ? raw.merge_commit_sha : null,
    merged_at: typeof raw.merged_at === "string" ? raw.merged_at : null,
  };
};

// `last:`, not `first:`: a review thread converges at its end, so a long one keeps
// its newest messages and reports the older ones as truncated.
const THREAD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    comments(last: 40) { pageInfo { hasPreviousPage } nodes { author { login __typename } body createdAt } }
    reviews(last: 30) { pageInfo { hasPreviousPage } nodes { author { login __typename } state body submittedAt
      comments(last: 30) { pageInfo { hasPreviousPage } nodes { author { login __typename } body createdAt } } } }
  } }
}`;

interface GqlAuthor { login?: unknown; __typename?: unknown }
interface GqlNote { author?: GqlAuthor | null; body?: unknown; createdAt?: unknown; submittedAt?: unknown; state?: unknown }
interface GqlPage<T> { pageInfo?: { hasPreviousPage?: unknown } | null; nodes?: (T | null)[] }
interface GqlReview extends GqlNote { comments?: GqlPage<GqlNote> }

/** Does this failed `gh api graphql` run carry GitHub's NOT_FOUND answer? (GraphQL
 *  errors exit non-zero but still print the JSON answer on stdout.) */
export function isNotFoundAnswer(err: unknown): boolean {
  const e = err as { code?: unknown; stdout?: unknown } | null;
  if (typeof e?.code !== "number" || typeof e.stdout !== "string") return false;
  try {
    const answer = JSON.parse(e.stdout) as { errors?: { type?: unknown }[] };
    return Array.isArray(answer.errors) && answer.errors.some((x) => x?.type === "NOT_FOUND");
  } catch { return false; }
}

/** The thread out of a successful THREAD_QUERY answer, or null when there is no such PR. */
export function parseThreadAnswer(stdout: string): PrThread | null {
  const raw = JSON.parse(stdout) as { data?: { repository?: { pullRequest?: { comments?: GqlPage<GqlNote>; reviews?: GqlPage<GqlReview> } | null } | null } };
  const pull = raw.data?.repository?.pullRequest;
  if (!pull) return null;
  const message = (n: GqlNote, kind: PrThreadMessage["kind"], at: unknown): PrThreadMessage => {
    const login = typeof n.author?.login === "string" ? n.author.login : "";
    return {
      author: login || "ghost",
      bot: !n.author || !login || n.author.__typename === "Bot" || /\[bot\]$/i.test(login),
      kind,
      ...(kind === "review" && typeof n.state === "string" ? { state: n.state } : {}),
      body: typeof n.body === "string" ? n.body : "",
      at: typeof at === "string" ? at : "",
    };
  };
  const older = (page: GqlPage<unknown> | undefined): boolean => page?.pageInfo?.hasPreviousPage === true;
  let truncated = older(pull.comments) || older(pull.reviews);
  const messages: PrThreadMessage[] = [];
  for (const c of pull.comments?.nodes ?? []) if (c) messages.push(message(c, "comment", c.createdAt));
  for (const r of pull.reviews?.nodes ?? []) {
    if (!r) continue;
    messages.push(message(r, "review", r.submittedAt));
    truncated ||= older(r.comments);
    for (const c of r.comments?.nodes ?? []) if (c) messages.push(message(c, "inline", c.createdAt));
  }
  return { messages, truncated };
}

/** One `gh api graphql` call for the PR's conversation comments, review bodies, and
 *  inline review comments. Resolves null when GitHub has no such PR; throws when gh
 *  itself is unusable, exactly like ghPrFetcher. */
export const ghPrThreadFetcher: PrThreadFetcher = async (repository, pr, cwd) => {
  const [owner, name] = repository.split("/");
  let out: string;
  try {
    // `-f` (raw string) for owner/name: `-F` would coerce a repo named "2048" to an Int.
    ({ stdout: out } = await run("gh", [
      "api", "graphql", "--hostname", "github.com",
      "-f", `query=${THREAD_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`,
    ], { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }));
  } catch (err) {
    if (isNotFoundAnswer(err)) return null;
    throw err;
  }
  return parseThreadAnswer(out);
};

/** Template comments and runs of blank lines carry no intent; drop them before bounding. */
function cleanBody(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Does this PR belong to this commit? A same-numbered PR in another repo (a fork,
 *  a cherry-pick) must never lend its description. Accept the exact squash/merge
 *  sha, or GitHub's default squash subject "<PR title> (#N)". */
function prMatchesCommit(rec: PrRecord, sha: string, subject: string, pr: number): boolean {
  if (!rec.merged_at) return false;
  if (rec.merge_commit_sha && rec.merge_commit_sha.toLowerCase() === sha.toLowerCase()) return true;
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(subject) === norm(`${rec.title} (#${pr})`);
}

/** Human messages only, oldest first, one `[login …] body` block each. */
function renderThread(messages: PrThreadMessage[]): string {
  const time = (m: PrThreadMessage): number => Date.parse(m.at) || 0;
  return messages
    .filter((m) => !m.bot)
    .map((m) => ({ ...m, body: cleanBody(m.body) }))
    .filter((m) => m.body)
    .sort((a, b) => time(a) - time(b))
    .map((m) => `[${m.author}${m.kind === "review" ? ` review${m.state ? ` ${m.state}` : ""}` : m.kind === "inline" ? " inline" : ""}] ${m.body}`)
    .join("\n\n---\n");
}

/** Bound a rendered thread: keep its opening (the question) and its end (where review
 *  converges), dropping the middle. */
function boundThread(thread: string): string {
  if (thread.length <= PR_THREAD_MAX_CHARS) return thread;
  const gap = "\n\n[… middle of the review thread omitted …]\n\n";
  const head = Math.floor(PR_THREAD_MAX_CHARS / 4);
  return thread.slice(0, head) + gap + thread.slice(thread.length - (PR_THREAD_MAX_CHARS - head - gap.length));
}

const memo = new Map<string, PrContext | null>();
const MAX_CONSECUTIVE_FAILURES = 2;
let failures = 0;
// Separate from `failures`: a GraphQL-only problem (its own rate limit, a token REST
// accepts but GraphQL refuses) must stop thread lookups, not the working descriptions.
let threadFailures = 0;

/** The PR context for one commit, or null. One fetch per (repo, PR, sha, thread?) per
 *  process. `thread` also fetches the human review thread for a matching PR. */
export async function prContextFor(
  root: string,
  commit: { sha: string; subject: string },
  opts: { fetcher?: PrFetcher; threadFetcher?: PrThreadFetcher; thread?: boolean; repository?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<PrContext | null> {
  const env = opts.env ?? process.env;
  if (env.HUNCH_PR_CONTEXT === "0") return null;
  const pr = prNumberFromSubject(commit.subject);
  if (pr === undefined) return null;
  const repository = opts.repository !== undefined ? opts.repository : await githubRepositoryOf(root);
  if (!repository) return null;
  // A description-only answer must never satisfy a thread lookup.
  const key = `${repository.toLowerCase()}#${pr}@${commit.sha}${opts.thread ? "+thread" : ""}`;
  if (memo.has(key)) return memo.get(key)!;
  // Offline or without gh, every fetch would wait out its timeout: after a couple of
  // straight lookup failures, stop asking for the rest of this process (e.g. a long
  // backfill). A PR GitHub simply doesn't have is an answer, not a failure.
  if (failures >= MAX_CONSECUTIVE_FAILURES) return null;
  let rec: PrRecord | null;
  try {
    rec = await (opts.fetcher ?? ghPrFetcher)(repository, pr, root);
    failures = 0;
  } catch {
    failures++;
    return null;
  }
  let ctx: PrContext | null = null;
  if (rec && prMatchesCommit(rec, commit.sha, commit.subject, pr)) {
    const body = cleanBody(rec.body ?? "");
    const described: PrContext = {
      number: pr,
      title: rec.title.replace(/\s+/g, " ").trim().slice(0, 300),
      body: body.slice(0, PR_BODY_MAX_CHARS),
      truncated: body.length > PR_BODY_MAX_CHARS,
    };
    let thread = "";
    let olderOmitted = false;
    if (opts.thread && threadFailures < MAX_CONSECUTIVE_FAILURES) {
      try {
        const fetched = await (opts.threadFetcher ?? ghPrThreadFetcher)(repository, pr, root);
        threadFailures = 0;
        thread = renderThread(fetched?.messages ?? []);
        olderOmitted = !!fetched?.truncated;
      } catch {
        // A failed thread lookup trips only the thread breaker and keeps the description.
        threadFailures++;
        return body ? described : null;
      }
    }
    if (thread) {
      ctx = { ...described, thread: boundThread(thread), threadTruncated: olderOmitted || thread.length > PR_THREAD_MAX_CHARS };
    } else if (body) {
      ctx = described;
    }
  }
  memo.set(key, ctx);
  return ctx;
}

/** Test seam: forget memoized fetches, origins and the failure count. */
export function clearPrContextMemo(): void { memo.clear(); origins.clear(); failures = 0; threadFailures = 0; }
