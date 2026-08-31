import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProjectDnaMatch,
  assertProjectDnaProfile,
  discoverProjectDna,
  evaluateProjectDnaMatch,
} from "../src/core/projectDna.js";
import {
  assertProjectDnaHostEvidence,
  sealProjectDnaHostEvidence,
  type ProjectDnaHostEvidenceCandidate,
} from "../src/core/projectDnaHostEvidence.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch DNA test",
  GIT_AUTHOR_EMAIL: "hunch-dna@example.test",
  GIT_COMMITTER_NAME: "Hunch DNA test",
  GIT_COMMITTER_EMAIL: "hunch-dna@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(root: string, subject: string, content: string): void {
  writeFileSync(join(root, "src.txt"), `${content}\n`);
  git(root, "add", "src.txt");
  git(root, "commit", "-qm", subject);
}

function fixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never): { root: string; revision: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "CONTRIBUTING.md"), [
    "# Contributing",
    "",
    "Please keep pull requests small and focused. Avoid unrelated cleanup.",
    "Behavior changes must include tests.",
    "Please explain why the change is needed in the pull request.",
    "Breaking changes require explicit backward compatibility consideration.",
    "Update documentation for user-visible changes.",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src.txt"), "base\n");
  git(root, "add", "CONTRIBUTING.md", "src.txt");
  git(root, "commit", "-qm", "feat: add mutation runner");
  const subjects = [
    "fix: handle mutation timeout",
    "test: cover mutation timeout",
    "docs: explain mutation timeout",
    "refactor: simplify mutation runner",
    "fix: preserve mutation result",
    "test: exercise mutation result",
    "feat: add mutation filter",
    "fix: validate mutation filter",
    "chore: refresh mutation fixture",
  ];
  subjects.forEach((subject, index) => commit(root, subject, String(index)));
  return { root, revision: git(root, "rev-parse", "HEAD") };
}

test("project DNA is deterministic and bound to one exact revision", (t) => {
  const { root, revision } = fixture(t);
  const first = discoverProjectDna(root, revision);
  const second = discoverProjectDna(root, revision);

  assert.deepEqual(first, second);
  assert.equal(first.repository_revision, revision);
  assert.match(first.repository_id, /^pdnar_[a-f0-9]{24}$/);
  assert.equal(first.history_sample_count, 10);
  assert.deepEqual(first.source_files, ["CONTRIBUTING.md"]);
  assert.doesNotThrow(() => assertProjectDnaProfile(first));

  const keys = new Set(first.traits.map((trait) => trait.key));
  assert.equal(keys.has("commit.conventional"), true);
  assert.equal(keys.has("subject.no_terminal_punctuation"), true);
  assert.equal(keys.has("subject.lowercase_lead"), true);
  assert.equal(keys.has("review.tests_expected"), true);
  assert.equal(keys.has("review.focused_changes"), true);
  assert.equal(keys.has("culture.backward_compatibility"), true);
  assert.equal(keys.has("engineering.documentation_expected"), true);
  assert.equal(keys.has("pr.explain_why"), true);
  assert.equal(keys.has("term.mutation"), true);
  assert.equal(first.traits.every((trait) => trait.observation_state === "observed"
    && trait.freshness === "current" && trait.contradiction === "none"), true);
  assert.equal(first.traits.flatMap((trait) => trait.evidence).every((evidence) =>
    evidence.provenance === "committed-repository" && evidence.visibility === "repository"), true);

  writeFileSync(join(root, "CONTRIBUTING.md"), "uncommitted local instructions must not affect DNA\n");
  assert.deepEqual(discoverProjectDna(root, revision), first, "worktree state is outside the exact-revision profile");

  commit(root, "BREAK ALL STYLE RULES.", "later");
  assert.deepEqual(discoverProjectDna(root, revision), first, "later commits cannot rewrite a pinned profile");
  assert.notEqual(discoverProjectDna(root, "HEAD").profile_id, first.profile_id);
});

test("project DNA match scores only deterministic applicable traits", (t) => {
  const { root, revision } = fixture(t);
  const profile = discoverProjectDna(root, revision);

  const native = evaluateProjectDnaMatch(profile, { kind: "commit", title: "fix: handle mutation cache" });
  assert.equal(native.score, 100);
  assert.equal(native.applicable_checks >= 3, true);
  assert.doesNotThrow(() => assertProjectDnaMatch(native));

  const foreign = evaluateProjectDnaMatch(profile, { kind: "commit", title: "Handle Mutation Cache." });
  assert.equal((foreign.score ?? 100) < 50, true);

  const pr = evaluateProjectDnaMatch(profile, {
    kind: "pull_request",
    title: "fix mutation cache",
    body: "Why: this preserves the existing mutation execution contract.",
  });
  assert.equal(pr.checks.find((check) => check.key === "pr.explain_why")?.passed, true);

  const tampered = structuredClone(profile);
  tampered.traits[0]!.claim = "invented project culture";
  assert.throws(() => assertProjectDnaProfile(tampered), /identity|seal/);

  const tamperedMatch = structuredClone(native);
  tamperedMatch.checks[0]!.passed = false;
  assert.throws(() => assertProjectDnaMatch(tamperedMatch), /identity|seal/);

  const malformedMatch = structuredClone(native);
  malformedMatch.checks[0]!.passed = null;
  assert.throws(() => assertProjectDnaMatch(malformedMatch), /fields/);
});

test("small histories do not manufacture communication conventions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-small-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "value.txt"), "1\n");
  git(root, "add", "value.txt");
  git(root, "commit", "-qm", "fix: one sample is not culture");

  const profile = discoverProjectDna(root);
  assert.equal(profile.history_sample_count, 1);
  assert.equal(profile.traits.some((trait) => trait.key.startsWith("commit.") || trait.key.startsWith("subject.")), false);
});

function hostCandidates(): ProjectDnaHostEvidenceCandidate[] {
  return [
    {
      kind: "pull_request",
      ref: "github:pull-request:101",
      disposition: "merged",
      author_role: "contributor",
      title: "feat: add quorum planner #101",
      body: "Why this change matters: quorum planning prevents split decisions.",
    },
    {
      kind: "pull_request",
      ref: "github:pull-request:102",
      disposition: "merged",
      author_role: "maintainer",
      title: "fix: preserve quorum decision #102",
      body: "Why this change is needed: it preserves the accepted decision.",
    },
    {
      kind: "pull_request",
      ref: "github:pull-request:103",
      disposition: "merged",
      author_role: "contributor",
      title: "test: cover quorum fallback #103",
      body: "Why this change helps: fallback behavior now has regression coverage.",
    },
    {
      kind: "pull_request",
      ref: "github:pull-request:104",
      disposition: "merged",
      author_role: "contributor",
      title: "docs: explain quorum policy #104",
      body: "Why this change belongs here: users need the same quorum vocabulary.",
    },
    {
      kind: "pull_request",
      ref: "github:pull-request:105",
      disposition: "merged",
      author_role: "contributor",
      title: "refactor: simplify quorum evidence",
      body: "This rearranges the implementation without changing behavior.",
    },
    {
      kind: "pull_request",
      ref: "github:pull-request:106",
      disposition: "merged",
      author_role: "contributor",
      title: "chore: refresh quorum fixture",
      body: null,
    },
    {
      kind: "review_comment",
      ref: "github:review-comment:201",
      disposition: "changes_requested",
      author_role: "maintainer",
      title: null,
      body: "Please include tests when behavior changes.",
    },
    {
      kind: "review_comment",
      ref: "github:review-comment:202",
      disposition: "commented",
      author_role: "maintainer",
      title: null,
      body: "Ensure this includes tests for the changed behavior.",
    },
  ];
}

test("host evidence is bounded, canonical, deterministic, and tamper evident", () => {
  const revision = "a".repeat(40);
  const candidates = hostCandidates();
  const first = sealProjectDnaHostEvidence(revision, candidates);
  const second = sealProjectDnaHostEvidence(revision, [...candidates].reverse());

  assert.deepEqual(first, second);
  assert.doesNotThrow(() => assertProjectDnaHostEvidence(first));
  assert.match(first.evidence_set_id, /^pdnah_[a-f0-9]{24}$/);
  assert.equal(first.items.every((item) => item.ref.startsWith("github:") && !item.ref.includes("https://")), true);

  const tampered = structuredClone(first);
  tampered.items[0]!.body = "invented review culture";
  assert.throws(() => assertProjectDnaHostEvidence(tampered), /seal/);
  assert.throws(() => sealProjectDnaHostEvidence(revision, [{
    ...candidates[0]!,
    kind: "review_comment",
    disposition: "merged",
  }]), /fields/);
});

test("authorized host evidence extends DNA without retaining raw PR or review text", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "value.txt"), "1\n");
  git(root, "add", "value.txt");
  git(root, "commit", "-qm", "initial import");
  const revision = git(root, "rev-parse", "HEAD");
  const base = discoverProjectDna(root, revision);
  const hostEvidence = sealProjectDnaHostEvidence(revision, hostCandidates());
  const profile = discoverProjectDna(root, revision, { hostEvidence });
  const keys = new Set(profile.traits.map((trait) => trait.key));

  assert.equal(base.traits.some((trait) => trait.key.startsWith("pull_request.")), false);
  assert.equal(keys.has("pull_request.conventional_title"), true);
  assert.equal(keys.has("pull_request.no_terminal_punctuation"), true);
  assert.equal(keys.has("pull_request.lowercase_lead"), true);
  assert.equal(keys.has("pull_request.issue_reference"), true);
  assert.equal(keys.has("term.quorum"), true);
  assert.equal(keys.has("review.tests_expected"), true);
  assert.equal(keys.has("pr.explain_why"), true);
  assert.equal(profile.traits.filter((trait) => trait.key.startsWith("pull_request.") || trait.key === "term.quorum")
    .flatMap((trait) => trait.evidence)
    .every((evidence) => evidence.kind === "host-evidence"
      && evidence.provenance === "host-provided"
      && evidence.ref === `host:${hostEvidence.evidence_set_id}`), true);
  assert.doesNotMatch(JSON.stringify(profile), /split decisions|include tests when behavior changes/);
  assert.doesNotThrow(() => assertProjectDnaProfile(profile));
  assert.deepEqual(discoverProjectDna(root, revision), base, "omitting host evidence preserves the base profile");

  const nativePr = evaluateProjectDnaMatch(profile, {
    kind: "pull_request",
    title: "fix: preserve quorum identity #107",
    body: "Why: the profile must remain revision-bound.",
  });
  assert.equal(nativePr.checks.find((check) => check.key === "pull_request.conventional_title")?.passed, true);
  const commit = evaluateProjectDnaMatch(profile, { kind: "commit", title: "fix: preserve quorum identity #107" });
  assert.equal(commit.checks.find((check) => check.key === "pull_request.conventional_title")?.applicable, false);

  const wrongRevision = sealProjectDnaHostEvidence("b".repeat(40), hostCandidates());
  assert.throws(() => discoverProjectDna(root, revision, { hostEvidence: wrongRevision }), /revision does not match/);
});
