import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/core/types.js";
import { tempStore } from "./helpers.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function reviewDecision(id: string, status: Decision["status"]): Decision {
  return {
    id,
    title: `${status} review fixture`,
    topic: null,
    status,
    context: "fixture",
    decision: "Preserve the review lifecycle boundary.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: {
      source: status === "accepted" ? "human_confirmed" : "llm_draft",
      confidence: status === "accepted" ? 0.95 : 0.5,
      evidence: [],
    },
    date: "2026-01-01T00:00:00.000Z",
  };
}

function review(root: string, id: string) {
  return spawnSync(process.execPath, [tsx, cli, "review", "--reject", id], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
}

function reviewArgs(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsx, cli, "review", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HUNCH_PRIVATE_DIR: "",
      HUNCH_SYNTH_PROVIDER: "deterministic",
      GIT_AUTHOR_NAME: "Review Fixture",
      GIT_AUTHOR_EMAIL: "review@pump.test",
      GIT_COMMITTER_NAME: "Review Fixture",
      GIT_COMMITTER_EMAIL: "review@pump.test",
    },
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("review rejection preserves accepted decisions and closes proposed drafts with a lifecycle tombstone", () => {
  const fixture = tempStore();
  const accepted = reviewDecision("dec_accepted", "accepted");
  const proposed = reviewDecision("dec_proposed", "proposed");
  fixture.store.json.put("decisions", accepted);
  fixture.store.json.put("decisions", proposed);
  fixture.store.close();
  const acceptedPath = join(fixture.root, ".hunch/decisions/dec_accepted.json");
  const proposedPath = join(fixture.root, ".hunch/decisions/dec_proposed.json");

  try {
    const protectedRun = review(fixture.root, accepted.id);
    const protectedOutput = `${protectedRun.stdout}${protectedRun.stderr}`;
    assert.notEqual(protectedRun.status, 0, protectedOutput);
    assert.match(protectedOutput, /refusing to reject accepted decision dec_accepted/i);
    assert.ok(existsSync(acceptedPath), "the accepted record remains intact");

    const draftRun = review(fixture.root, proposed.id);
    const draftOutput = `${draftRun.stdout}${draftRun.stderr}`;
    assert.equal(draftRun.status, 0, draftOutput);
    assert.match(draftOutput, /rejected dec_proposed/);
    assert.ok(existsSync(proposedPath), "the proposed draft remains as append-only lifecycle history");
    const rejected = JSON.parse(readFileSync(proposedPath, "utf8")) as Decision;
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.valid_to, "rejection closes the proposal's validity window");
    assert.ok(existsSync(acceptedPath), "rejecting a draft cannot affect the accepted record");
  } finally {
    fixture.cleanup();
  }
});

test("review accept, duplicate rejection, and verified batch update each pump the public home", () => {
  const fixture = tempStore();
  const acceptedAnchor: Decision = {
    ...reviewDecision("dec_anchor", "accepted"),
    title: "Shared transport retries stay bounded",
    decision: "Shared transport retries stay bounded at three attempts.",
    related_files: ["src/app.ts"],
    alternatives_rejected: ["Use axios directly instead of the shared transport."],
  };
  const duplicate: Decision = {
    ...reviewDecision("dec_duplicate", "proposed"),
    title: acceptedAnchor.title,
    decision: acceptedAnchor.decision,
    related_files: ["src/app.ts"],
  };
  const acceptedById: Decision = {
    ...reviewDecision("dec_accept_by_id", "proposed"),
    title: "Exact-home updates remain single-source",
    decision: "A review update writes back to the record's existing memory home.",
    related_files: ["src/review.ts"],
  };
  const verified: Decision = {
    ...reviewDecision("dec_verified", "proposed"),
    title: "Verified review batches remain grounded",
    decision: "Batch acceptance requires Critic verification and grounded evidence.",
    related_files: ["src/verified.ts"],
    provenance: {
      source: "llm_draft+verified",
      confidence: 0.8,
      evidence: ["synth: provider=fixture grounded=0.95 samples=3 agreement=1 pruned=0"],
    },
  };
  fixture.store.json.put("decisions", acceptedAnchor);
  fixture.store.json.put("decisions", duplicate);
  fixture.store.json.put("decisions", acceptedById);
  fixture.store.json.put("decisions", verified);
  fixture.store.close();

  try {
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "config", "user.name", "Review Fixture");
    git(fixture.root, "config", "user.email", "review@pump.test");
    writeFileSync(join(fixture.root, ".gitignore"), ".hunch/*.sqlite*\n.hunch/events.log\n.hunch/local.json\n.hunch/.hunch-commit.lock\n");
    writeFileSync(join(fixture.root, "app.ts"), "export const reviewPump = true;\n");
    writeFileSync(join(fixture.root, "package.json"), "{\"dependencies\":{\"axios\":\"1.0.0\"}}\n");
    writeFileSync(join(fixture.root, "CLAUDE.md"), "# Review fixture\n");
    git(fixture.root, "add", "-A");
    git(fixture.root, "commit", "-qm", "seed review records");

    const accept = reviewArgs(fixture.root, "--accept", acceptedById.id);
    assert.equal(accept.status, 0, `${accept.stdout}${accept.stderr}`);
    assert.equal((JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${acceptedById.id}.json`), "utf8")) as Decision).status, "accepted");
    const afterAccept = git(fixture.root, "rev-parse", "HEAD");
    assert.match(git(fixture.root, "log", "-1", "--format=%s"), /review decision lifecycle/);

    const rejectDuplicates = reviewArgs(fixture.root, "--reject-duplicates");
    assert.equal(rejectDuplicates.status, 0, `${rejectDuplicates.stdout}${rejectDuplicates.stderr}`);
    const rejected = JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${duplicate.id}.json`), "utf8")) as Decision;
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.valid_to);
    const afterReject = git(fixture.root, "rev-parse", "HEAD");
    assert.notEqual(afterReject, afterAccept, "duplicate rejection receives its own durable pump commit");

    const acceptVerified = reviewArgs(fixture.root, "--accept-verified");
    assert.equal(acceptVerified.status, 0, `${acceptVerified.stdout}${acceptVerified.stderr}`);
    assert.equal((JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${verified.id}.json`), "utf8")) as Decision).status, "accepted");
    const afterVerified = git(fixture.root, "rev-parse", "HEAD");
    assert.notEqual(afterVerified, afterReject, "verified batch updates are pumped too");

    const repairRef = spawnSync(process.execPath, [tsx, cli, "repair-ref", acceptedById.id, "--from", "src/review.ts", "--to", "src/review-v2.ts"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    assert.equal(repairRef.status, 0, `${repairRef.stdout}${repairRef.stderr}`);
    assert.deepEqual((JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${acceptedById.id}.json`), "utf8")) as Decision).related_files, ["src/review-v2.ts"]);
    const afterRepairRef = git(fixture.root, "rev-parse", "HEAD");
    assert.notEqual(afterRepairRef, afterVerified, "repair-ref pumps the record's pre-write home");

    const vetoBackfill = spawnSync(process.execPath, [tsx, cli, "veto", "backfill"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    assert.equal(vetoBackfill.status, 0, `${vetoBackfill.stdout}${vetoBackfill.stderr}`);
    const backfilled = JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${acceptedAnchor.id}.json`), "utf8")) as Decision;
    assert.ok(backfilled.rejected_tripwires.length > 0);
    const afterVeto = git(fixture.root, "rev-parse", "HEAD");
    assert.notEqual(afterVeto, afterRepairRef, "veto backfill pumps its exact mutation home");

    const supersede = spawnSync(process.execPath, [tsx, cli, "supersede", acceptedAnchor.id, "--by", acceptedById.id], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    assert.equal(supersede.status, 0, `${supersede.stdout}${supersede.stderr}`);
    assert.equal((JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${acceptedAnchor.id}.json`), "utf8")) as Decision).status, "superseded");
    assert.notEqual(git(fixture.root, "rev-parse", "HEAD"), afterVeto, "supersede pumps its public record and derived edge");
    assert.equal(git(fixture.root, "status", "--porcelain", "--", ".hunch"), "");
    assert.equal(git(fixture.root, "status", "--porcelain"), "", "central public flush commits clean grounding with the memory update");
  } finally {
    fixture.cleanup();
  }
});

test("public veto backfill never overwrites an identically-named private decision", () => {
  const fixture = tempStore();
  const overlay = mkdtempSync(join(tmpdir(), "hunch-veto-duplicate-home-"));
  const id = "dec_duplicate_home";
  const publicDecision: Decision = {
    ...reviewDecision(id, "accepted"),
    title: "Public transport choice",
    alternatives_rejected: ["Use axios directly."],
    related_files: ["app.ts"],
  };
  const privateDecision: Decision = {
    ...reviewDecision(id, "accepted"),
    title: "PRIVATE SENTINEL — never replace from public selection",
    decision: "This private record has unrelated meaning.",
  };
  fixture.store.json.put("decisions", publicDecision);
  fixture.store.close();
  try {
    git(fixture.root, "init", "-q", "-b", "main");
    git(fixture.root, "config", "user.name", "Review Fixture");
    git(fixture.root, "config", "user.email", "review@pump.test");
    writeFileSync(join(fixture.root, ".gitignore"), ".hunch/*.sqlite*\n.hunch/events.log\n.hunch/local.json\n.hunch/.hunch-commit.lock\n");
    writeFileSync(join(fixture.root, "package.json"), "{\"dependencies\":{\"axios\":\"1.0.0\"}}\n");
    git(fixture.root, "add", "-A");
    git(fixture.root, "commit", "-qm", "seed public decision");

    git(overlay, "init", "-q", "-b", "main");
    git(overlay, "config", "user.name", "Private Fixture");
    git(overlay, "config", "user.email", "private@pump.test");
    mkdirSync(join(overlay, ".hunch/decisions"), { recursive: true });
    const privatePath = join(overlay, `.hunch/decisions/${id}.json`);
    writeFileSync(privatePath, `${JSON.stringify(privateDecision, null, 2)}\n`);
    git(overlay, "add", "-A");
    git(overlay, "commit", "-qm", "seed private collision");
    const privateBefore = readFileSync(privatePath, "utf8");
    const privateHead = git(overlay, "rev-parse", "HEAD");
    writeFileSync(join(fixture.root, ".hunch/local.json"), `${JSON.stringify({ privateDir: join(overlay, ".hunch"), autoCommit: true, mode: "private" })}\n`);

    const run = spawnSync(process.execPath, [tsx, cli, "veto", "backfill"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const updatedPublic = JSON.parse(readFileSync(join(fixture.root, `.hunch/decisions/${id}.json`), "utf8")) as Decision;
    assert.ok(updatedPublic.rejected_tripwires.length > 0);
    assert.equal(readFileSync(privatePath, "utf8"), privateBefore, "public selection cannot rewrite private collision bytes");
    assert.equal(git(overlay, "rev-parse", "HEAD"), privateHead, "the private home is neither written nor pumped");
  } finally {
    fixture.cleanup();
    rmSync(overlay, { recursive: true, force: true });
  }
});
