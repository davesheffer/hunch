/**
 * Pull-request context for commit synthesis (#562 phase 1).
 *
 * On squash-merge repos the *why* often lives in the PR description, not the commit
 * that lands. When a commit subject names its PR ("Title (#N)", or GitHub's
 * "Merge pull request #N from owner/branch"), fetch that PR's description through the
 * user's own `gh` CLI and hand it to synthesis as a separate, bounded, labeled section.
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

export interface PrContext {
  number: number;
  title: string;
  body: string;
  /** true when the body was cut to PR_BODY_MAX_CHARS */
  truncated: boolean;
}

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

const memo = new Map<string, PrContext | null>();
const MAX_CONSECUTIVE_FAILURES = 2;
let failures = 0;

/** The PR context for one commit, or null. One fetch per (repo, PR, sha) per process. */
export async function prContextFor(
  root: string,
  commit: { sha: string; subject: string },
  opts: { fetcher?: PrFetcher; repository?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<PrContext | null> {
  const env = opts.env ?? process.env;
  if (env.HUNCH_PR_CONTEXT === "0") return null;
  const pr = prNumberFromSubject(commit.subject);
  if (pr === undefined) return null;
  const repository = opts.repository !== undefined ? opts.repository : await githubRepositoryOf(root);
  if (!repository) return null;
  const key = `${repository.toLowerCase()}#${pr}@${commit.sha}`;
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
    if (body) {
      ctx = {
        number: pr,
        title: rec.title.replace(/\s+/g, " ").trim().slice(0, 300),
        body: body.slice(0, PR_BODY_MAX_CHARS),
        truncated: body.length > PR_BODY_MAX_CHARS,
      };
    }
  }
  memo.set(key, ctx);
  return ctx;
}

/** Test seam: forget memoized fetches, origins and the failure count. */
export function clearPrContextMemo(): void { memo.clear(); origins.clear(); failures = 0; }
