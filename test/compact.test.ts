import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCompaction } from "../src/store/compact.js";
import { hunchPaths } from "../src/core/paths.js";
import type { Bug, Constraint, Decision } from "../src/core/types.js";
import { JsonStore } from "../src/store/jsonStore.js";

const NOW = Date.parse("2026-06-15T00:00:00Z");
const OLD = "2025-01-01T00:00:00Z"; // ~530d before NOW
const NEW = "2026-06-14T00:00:00Z"; // 1d before NOW

function dec(over: Partial<Decision>): Decision {
  return {
    id: "dec_x", title: "t", status: "proposed", context: "", decision: "", consequences: [],
    alternatives_rejected: [], related_components: [], related_files: [], supersedes: null,
    caused_by_bug: null, commit: null, provenance: { source: "llm_draft", confidence: 0.3, evidence: [] },
    date: OLD, ...over,
  };
}
function bug(over: Partial<Bug>): Bug {
  return {
    id: "bug_x", title: "t", symptom: "", root_cause: "", severity: "medium", status: "open",
    affected_files: [], affected_symbols: [],
    lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: null },
    provenance: { source: "test_failure", confidence: 0.3, evidence: [] }, ...over,
  };
}
function con(over: Partial<Constraint>): Constraint {
  return {
    id: "con_x", type: "correctness", statement: "s", scope: [], severity: "warning",
    enforcement: "advisory_v1", rationale: "", source_decision: null, violations: [],
    provenance: { source: "derived", confidence: 0.9, evidence: [] }, ...over,
  };
}
function plan(input: { decisions?: Decision[]; bugs?: Bug[]; constraints?: Constraint[] }, opts = {}) {
  const p = planCompaction({ decisions: input.decisions ?? [], bugs: input.bugs ?? [], constraints: input.constraints ?? [] }, { now: NOW, ...opts });
  return new Set(p.remove.map((r) => r.id));
}

test("rejected drafts are pruned; accepted and human-confirmed are always kept", () => {
  const ids = plan({ decisions: [
    dec({ id: "rej", status: "rejected" }),
    dec({ id: "acc", status: "accepted", date: OLD, provenance: { source: "llm_draft", confidence: 0.3, evidence: [] } }),
    dec({ id: "hc", status: "proposed", date: OLD, provenance: { source: "llm_draft+human_confirmed", confidence: 0.3, evidence: [] } }),
  ] });
  assert.ok(ids.has("rej"));
  assert.ok(!ids.has("acc"), "accepted kept");
  assert.ok(!ids.has("hc"), "human-confirmed kept");
});

test("a proposed draft is pruned only when BOTH low-confidence AND old", () => {
  assert.ok(plan({ decisions: [dec({ id: "d", status: "proposed", date: OLD, provenance: { source: "llm_draft", confidence: 0.2, evidence: [] } })] }).has("d"));
  assert.ok(!plan({ decisions: [dec({ id: "d", status: "proposed", date: NEW, provenance: { source: "llm_draft", confidence: 0.2, evidence: [] } })] }).has("d"), "new draft kept");
  assert.ok(!plan({ decisions: [dec({ id: "d", status: "proposed", date: OLD, provenance: { source: "llm_draft", confidence: 0.9, evidence: [] } })] }).has("d"), "confident draft kept");
});

test("superseded old decisions are pruned; a referenced decision is never pruned", () => {
  assert.ok(plan({ decisions: [dec({ id: "old", status: "superseded", date: OLD })] }).has("old"));
  // 'old' is rejected (prunable) BUT another decision supersedes it → keep it as a lineage anchor
  const ids = plan({ decisions: [
    dec({ id: "old", status: "rejected" }),
    dec({ id: "new", status: "accepted", supersedes: "old" }),
  ] });
  assert.ok(!ids.has("old"), "referenced (supersedes target) is protected");
});

test("bugs: fixed + low-confidence pruned; open / constraint-spawning / decision-spawning / referenced bugs kept", () => {
  assert.ok(plan({ bugs: [bug({ id: "fx", status: "fixed", provenance: { source: "test_failure", confidence: 0.2, evidence: [] } })] }).has("fx"));
  assert.ok(!plan({ bugs: [bug({ id: "op", status: "open", provenance: { source: "test_failure", confidence: 0.2, evidence: [] } })] }).has("op"), "open bug kept");
  // a fixed bug that promoted a regression constraint keeps its lineage
  assert.ok(!plan({ bugs: [bug({ id: "sp", status: "fixed", provenance: { source: "test_failure", confidence: 0.2, evidence: [] }, lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: null, spawned_constraint: "con_9" } })] }).has("sp"));
  // a fixed bug that spawned a DECISION is the documented root cause — keep it (regression: only spawned_constraint protected before)
  assert.ok(!plan({ bugs: [bug({ id: "sd", status: "fixed", provenance: { source: "test_failure", confidence: 0.2, evidence: [] }, lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: null, spawned_decision: "dec_9", spawned_constraint: null } })] }).has("sd"), "spawned_decision anchor protected");
  // a bug another bug recurs from is a protected anchor
  const ids = plan({ bugs: [
    bug({ id: "orig", status: "fixed", provenance: { source: "test_failure", confidence: 0.2, evidence: [] } }),
    bug({ id: "again", status: "open", lineage: { introduced_commit: null, detected: null, fixed_commit: null, recurrence_of: "orig", spawned_decision: null, spawned_constraint: null } }),
  ] });
  assert.ok(!ids.has("orig"), "recurrence anchor protected");
});

test("a record being pruned does NOT protect another (fixpoint), and reference cycles still compact", () => {
  // 'pruned' (itself removable) supersedes 'victim' (also removable): victim must NOT
  // be kept just because a vanishing record points at it.
  const a = plan({ decisions: [
    dec({ id: "pruned", status: "rejected", supersedes: "victim" }),
    dec({ id: "victim", status: "rejected" }),
  ] });
  assert.deepEqual([...a].sort(), ["pruned", "victim"], "both removed; the doomed referrer doesn't protect victim");
  // two rejected drafts that supersede EACH OTHER (a cycle) are both removed
  const cyc = plan({ decisions: [
    dec({ id: "x", status: "rejected", supersedes: "y" }),
    dec({ id: "y", status: "rejected", supersedes: "x" }),
  ] });
  assert.deepEqual([...cyc].sort(), ["x", "y"], "reference cycle among removable records compacts");
  // but a SURVIVING (accepted) record's reference still protects its target
  const prot = plan({ decisions: [
    dec({ id: "anchor", status: "rejected" }),
    dec({ id: "keeper", status: "accepted", supersedes: "anchor" }),
  ] });
  assert.ok(!prot.has("anchor"), "referenced by a survivor → protected");
});

test("constraints are never auto-removed", () => {
  const p = planCompaction({ decisions: [], bugs: [], constraints: [con({ id: "c1", severity: "advisory" }), con({ id: "c2", severity: "blocking" })] }, { now: NOW });
  assert.equal(p.remove.length, 0);
});

test("compact --apply refuses physical deletion and leaves the additive memory pump live", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-compact-cli-"));
  const projectRoot = process.cwd();
  const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
  const cli = join(projectRoot, "src/cli/index.ts");
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const run = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic", NO_COLOR: "1" },
  });

  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "compact@test.invalid");
    git("config", "user.name", "Compact Test");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export function app(){ return true; }\n");
    writeFileSync(join(root, ".gitignore"), [
      ".hunch/*.sqlite*",
      ".hunch/local.json",
      ".hunch/events.log",
      ".hunch/.hunch-commit.lock",
      ".hunch-cache/",
      "",
    ].join("\n"));
    const json = new JsonStore(hunchPaths(root));
    json.ensureDirs();
    json.put("decisions", dec({ id: "dec_old_rejected", status: "rejected", date: OLD }));
    const decisionFile = join(root, ".hunch/decisions/dec_old_rejected.json");
    git("add", "-A");
    git("commit", "-qm", "fixture: source and rejected memory");

    const beforeHead = git("rev-parse", "HEAD");
    const beforeStatus = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
    const beforeDecision = readFileSync(decisionFile);
    const refused = run("compact", "--apply", "--max-age", "1");
    const refusedOutput = `${refused.stdout}${refused.stderr}`;

    assert.equal(refused.status, 1, refusedOutput);
    assert.match(refusedOutput, /compact --apply is disabled/i);
    assert.match(refusedOutput, /tombstone-based GC is not implemented/i);
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    assert.equal(git("status", "--porcelain=v1", "-z", "--untracked-files=all"), beforeStatus);
    assert.deepEqual(readFileSync(decisionFile), beforeDecision, "refusal happens before any record or store mutation");

    const preview = run("compact", "--max-age", "1");
    assert.equal(preview.status, 0, `${preview.stdout}${preview.stderr}`);
    assert.match(preview.stdout, /dec_old_rejected/);
    assert.match(preview.stdout, /Dry run only/i);
    assert.deepEqual(readFileSync(decisionFile), beforeDecision, "preview remains non-mutating");

    const recorded = run("record-constraint", "future memory still pumps", "--scope", "src/**");
    assert.equal(recorded.status, 0, `${recorded.stdout}${recorded.stderr}`);
    assert.notEqual(git("rev-parse", "HEAD"), beforeHead, "the next additive memory mutation still commits");
    assert.doesNotMatch(git("show", "--format=", "--name-status", "HEAD"), /^D\s+\.hunch\//m,
      "the next memory commit contains no stranded deletion");
    assert.deepEqual(readFileSync(decisionFile), beforeDecision, "the rejected record remains durable until tombstone GC exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
