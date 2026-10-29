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
import { execFileSync } from "node:child_process";
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

/** (owner/repo, PR number, cwd) → the PR, or null on any failure. Injectable for tests. */
export type PrFetcher = (repository: string, pr: number, cwd: string) => PrRecord | null;

const SQUASH_SUBJECT = /\s\(#(\d{1,9})\)$/;
const MERGE_SUBJECT = /^Merge pull request #(\d{1,9}) from \S+$/;

/** The PR number a commit subject names: squash "Title (#N)" or a GitHub merge commit. */
export function prNumberFromSubject(subject: string): number | undefined {
  const s = subject.trim();
  const m = SQUASH_SUBJECT.exec(s) ?? MERGE_SUBJECT.exec(s);
  return m ? Number(m[1]) : undefined;
}

/** owner/repo of a GitHub `origin`, or null for any other host or no origin. */
export function githubRepositoryOf(root: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
  } catch { return null; }
  const id = canonicalRemoteRepositoryIdentity(url, root);
  const m = /^provider:github:([a-z0-9-]+\/[a-z0-9._-]+)$/i.exec(id);
  return m ? m[1]! : null;
}

/** One `gh api` call; never throws. `gh` brings the user's own auth, so no token
 *  ever passes through Hunch. */
export const ghPrFetcher: PrFetcher = (repository, pr, cwd) => {
  try {
    const out = execFileSync("gh", ["api", `repos/${repository}/pulls/${pr}`], {
      cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    const raw = JSON.parse(out) as Partial<PrRecord>;
    if (typeof raw.title !== "string") return null;
    return {
      title: raw.title,
      body: typeof raw.body === "string" ? raw.body : null,
      merge_commit_sha: typeof raw.merge_commit_sha === "string" ? raw.merge_commit_sha : null,
      merged_at: typeof raw.merged_at === "string" ? raw.merged_at : null,
    };
  } catch { return null; }
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

/** The PR context for one commit, or null. One fetch per (repo, PR, sha) per process. */
export function prContextFor(
  root: string,
  commit: { sha: string; subject: string },
  opts: { fetcher?: PrFetcher; repository?: string | null; env?: NodeJS.ProcessEnv } = {},
): PrContext | null {
  const env = opts.env ?? process.env;
  if (env.HUNCH_PR_CONTEXT === "0") return null;
  const pr = prNumberFromSubject(commit.subject);
  if (pr === undefined) return null;
  const repository = opts.repository !== undefined ? opts.repository : githubRepositoryOf(root);
  if (!repository) return null;
  const key = `${repository.toLowerCase()}#${pr}@${commit.sha}`;
  if (memo.has(key)) return memo.get(key)!;
  const rec = (opts.fetcher ?? ghPrFetcher)(repository, pr, root);
  let ctx: PrContext | null = null;
  if (rec && prMatchesCommit(rec, commit.sha, commit.subject, pr)) {
    const body = cleanBody(rec.body ?? "");
    if (body) {
      ctx = {
        number: pr,
        title: rec.title.slice(0, 300),
        body: body.slice(0, PR_BODY_MAX_CHARS),
        truncated: body.length > PR_BODY_MAX_CHARS,
      };
    }
  }
  memo.set(key, ctx);
  return ctx;
}

/** Test seam: forget memoized fetches. */
export function clearPrContextMemo(): void { memo.clear(); }
