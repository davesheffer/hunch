import { cleanupDir } from "./fixtures.js";
/**
 * #426: the change under review must not make its own guarding decision stale.
 *
 * `hunch check --base <ref> --strict` (the Hunch Guard CI mode) and `--commit` judge a
 * decision's freshness by its files' last change. Before the fix that was read at HEAD,
 * so the PR's own commit (newer than the decision's last_verified) marked the decision
 * stale and disarmed a human-confirmed rejected-alternative veto that `--staged --strict`
 * still blocked. Freshness is now read at the revision the change starts from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import type { Decision } from "../src/core/types.js";
import { hunchCliArgs } from "./cli-invocation.js";

const FILE = "src/auth/rateLimit.ts";
const ADDED = 'const key = req.ip ?? "unknown";';

function git(root: string, date: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function decision(lastVerified: string): Decision {
  return {
    id: "dec_per_account", title: "Rate-limit logins per account, not per client IP", status: "accepted",
    context: "", decision: "Key the login limiter by account id.", consequences: [],
    alternatives_rejected: ["Per-IP limiting"],
    rejected_tripwires: [{
      alternative: "Per-IP limiting", scope: ["src/auth/**"],
      forbids: { deps: [], symbols: [], patterns: ["req\\.ip", "x-forwarded-for"] },
      provenance: { source: "llm_draft+human_confirmed", confidence: 0.9, evidence: [] },
    }],
    related_components: [], related_files: [FILE], supersedes: null, superseded_by: null,
    caused_by_bug: null, commit: null, valid_from: "2026-01-01T00:00:00Z", valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: lastVerified },
    date: "2026-01-01T00:00:00Z",
  } as Decision;
}

/** main: FILE committed at `baseDate`; branch `pr`: the rejected approach committed later. */
function repo(baseDate: string, lastVerified: string, record: "decision" | "constraint" = "decision"): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-base-veto-"));
  git(root, baseDate, "init", "-q", "-b", "main");
  git(root, baseDate, "config", "user.email", "veto@test.invalid");
  git(root, baseDate, "config", "user.name", "Veto Test");
  git(root, baseDate, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".hunch/\n");
  mkdirSync(join(root, "src/auth"), { recursive: true });
  writeFileSync(join(root, FILE), "export function limit(req) { return 1; }\n");
  git(root, baseDate, "add", "-A");
  git(root, baseDate, "commit", "-qm", "base");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }));
  if (record === "decision") store.json.put("decisions", decision(lastVerified));
  else store.json.put("constraints", {
    id: "con_auth_limiter", statement: "Login rate limiting must stay keyed by account", scope: ["src/auth/**"],
    severity: "blocking", rationale: "shared NAT users lock each other out",
    provenance: { source: "human_confirmed", confidence: 1, evidence: [], last_verified: lastVerified },
  } as never);
  store.close();
  return { root, cleanup: () => cleanupDir(root) };
}

function addRejectedApproach(root: string): void {
  writeFileSync(join(root, FILE), `export function limit(req) { ${ADDED} return key; }\n`);
}

function hunch(root: string, ...args: string[]) {
  const run = spawnSync(process.execPath, hunchCliArgs(...args), {
    cwd: root, encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const BASE = "2026-01-01T00:00:00Z";
const VERIFIED = "2026-02-01T00:00:00.000Z";
const PR = "2026-03-01T00:00:00Z";

test("#426: a human-confirmed veto blocks the same in --staged, --commit and --base under --strict", () => {
  const { root, cleanup } = repo(BASE, VERIFIED);
  try {
    addRejectedApproach(root);
    git(root, PR, "add", FILE);
    const staged = hunch(root, "check", "--staged", "--strict");
    assert.equal(staged.status, 1, staged.out);
    assert.match(staged.out, /dec_per_account rejected this approach \(human-confirmed\)/);

    git(root, PR, "checkout", "-qb", "pr");
    git(root, PR, "commit", "-qm", "per-ip limiter");
    for (const args of [["check", "--base", "main", "--strict"], ["check", "--commit", "HEAD", "--strict"], ["veto", "--base", "main", "--strict"]]) {
      const run = hunch(root, ...args);
      assert.equal(run.status, 1, `${args.join(" ")} must block like --staged:\n${run.out}`);
      assert.match(run.out, /dec_per_account/);
      assert.doesNotMatch(run.out, /advisory/i, `${args.join(" ")} must not downgrade the veto:\n${run.out}`);
    }
    const md = hunch(root, "check", "--base", "main", "--strict", "--format", "markdown");
    assert.equal(md.status, 1, md.out);
    assert.match(md.out, /`dec_per_account` rejected this approach \*\*\(human-confirmed\)\*\*/);
  } finally { cleanup(); }
});

test("#426: a decision already stale BEFORE the change stays disarmed in --base --strict (freshness still applies)", () => {
  // The file changed on main AFTER the decision was last verified: genuinely stale.
  const { root, cleanup } = repo("2026-02-15T00:00:00Z", VERIFIED);
  try {
    git(root, PR, "checkout", "-qb", "pr");
    addRejectedApproach(root);
    git(root, PR, "commit", "-qam", "per-ip limiter");
    const run = hunch(root, "check", "--base", "main", "--strict");
    assert.equal(run.status, 0, `a stale decision must not block:\n${run.out}`);
    assert.match(run.out, /dec_per_account/, "still surfaced");
  } finally { cleanup(); }
});

test("#426: a blocking constraint in scope blocks --base/--commit --strict as it does --staged (the PR's own commit is not staleness)", () => {
  const { root, cleanup } = repo(BASE, VERIFIED, "constraint");
  try {
    addRejectedApproach(root);
    git(root, PR, "add", FILE);
    const staged = hunch(root, "check", "--staged", "--strict");
    assert.equal(staged.status, 1, staged.out);
    assert.match(staged.out, /con_auth_limiter/);
    git(root, PR, "checkout", "-qb", "pr");
    git(root, PR, "commit", "-qm", "touch the limiter");
    for (const args of [["check", "--base", "main", "--strict"], ["check", "--commit", "HEAD", "--strict"]]) {
      const run = hunch(root, ...args);
      assert.equal(run.status, 1, `${args.join(" ")} must block like --staged:
${run.out}`);
      assert.match(run.out, /con_auth_limiter/);
    }
  } finally { cleanup(); }
});
