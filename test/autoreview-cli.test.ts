import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { hunchPaths } from "../src/core/paths.js";
import type { Decision } from "../src/core/types.js";
import { HunchStore } from "../src/store/hunchStore.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function draft(id: string, title: string, source = "llm_draft"): Decision {
  return {
    id,
    title,
    topic: null,
    status: "proposed",
    context: "fixture",
    decision: `Preserve the distinct ${title} behavior.`,
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
    provenance: { source, confidence: source.includes("human_confirmed") ? 0.95 : 0.5, evidence: [] },
    date: "2026-01-01T00:00:00.000Z",
  };
}

test("auto-review --apply refuses an incomplete harness batch without mutating drafts", { skip: process.platform === "win32" ? "fixture fakes the provider with a #!/bin/sh stub" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-autoreview-cli-"));
  const bin = join(root, "bin");
  const count = join(root, "judge-count");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli fixture"
  exit 0
fi
n=0
if [ -f "$HUNCH_FAKE_COUNTER" ]; then n=$(cat "$HUNCH_FAKE_COUNTER"); fi
n=$((n + 1))
echo "$n" > "$HUNCH_FAKE_COUNTER"
if [ "$n" -eq 1 ]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"relevant\\":true,\\"confidence\\":0.9,\\"duplicate_of\\":null,\\"reason\\":\\"fixture verdict\\"}"}}'
  exit 0
fi
echo "fixture provider outage" >&2
exit 1
`);
  chmodSync(fakeCodex, 0o755);

  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  store.json.put("decisions", draft("dec_first", "first subsystem choice"));
  store.json.put("decisions", draft("dec_second", "second transport choice"));
  store.close();
  const firstPath = join(root, ".hunch/decisions/dec_first.json");
  const secondPath = join(root, ".hunch/decisions/dec_second.json");
  const before = [readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8")];

  try {
    const env = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HUNCH_FAKE_COUNTER: count,
        HUNCH_PRIVATE_DIR: "",
        HUNCH_SYNTH_PROVIDER: "codex-cli",
    };
    const dryRun = spawnSync(process.execPath, [tsx, cli, "auto-review"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    const dryOutput = `${dryRun.stdout}${dryRun.stderr}`;
    assert.equal(dryRun.status, 0, dryOutput);
    assert.match(dryOutput, /incomplete harness batch/i);
    assert.match(dryOutput, /1\/2 judged/);
    assert.deepEqual(
      [readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8")],
      before,
      "an incomplete dry-run must remain inspectable and non-mutating",
    );

    rmSync(count, { force: true });
    const run = spawnSync(process.execPath, [tsx, cli, "auto-review", "--apply"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(output, /incomplete harness batch/i);
    assert.match(output, /1\/2 judged/);
    assert.deepEqual(
      [readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8")],
      before,
      "a partial judgment batch must leave every draft byte-identical",
    );

    const deterministic = spawnSync(process.execPath, [tsx, cli, "auto-review", "--no-llm", "--apply"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    const deterministicOutput = `${deterministic.stdout}${deterministic.stderr}`;
    assert.equal(deterministic.status, 0, deterministicOutput);
    assert.doesNotMatch(deterministicOutput, /incomplete harness batch/i);
    assert.deepEqual(
      [readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8")],
      before,
      "explicit deterministic-only triage remains available and does not invent judgments",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-review never deletes two proposed decisions merely because they duplicate each other", { skip: process.platform === "win32" ? "fixture fakes the provider with a #!/bin/sh stub" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-autoreview-proposals-"));
  const bin = join(root, "bin");
  const count = join(root, "judge-count");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli fixture"
  exit 0
fi
n=0
if [ -f "$HUNCH_FAKE_COUNTER" ]; then n=$(cat "$HUNCH_FAKE_COUNTER"); fi
n=$((n + 1))
echo "$n" > "$HUNCH_FAKE_COUNTER"
if [ "$n" -eq 1 ]; then
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"relevant\\":true,\\"confidence\\":0.99,\\"duplicate_of\\":\\"dec_benchmark_v2\\",\\"reason\\":\\"fixture reciprocal proposal\\"}"}}'
else
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"relevant\\":true,\\"confidence\\":0.99,\\"duplicate_of\\":\\"dec_benchmark_v1\\",\\"reason\\":\\"fixture reciprocal proposal\\"}"}}'
fi
`);
  chmodSync(fakeCodex, 0o755);
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  // Auto-trust world (v1.8): the review-draft set is UN-vouched llm_draft proposals —
  // a human_confirmed proposed record is roadmap intent and is never triaged. The
  // invariant under test is unchanged: two drafts that duplicate EACH OTHER (with no
  // accepted incumbent) must both be kept, never deleted.
  const title = "Benchmark evidence establishes the architectural enforcement boundary";
  store.json.put("decisions", draft("dec_benchmark_v1", title));
  store.json.put("decisions", draft("dec_benchmark_v2", title));
  store.close();
  const firstPath = join(root, ".hunch/decisions/dec_benchmark_v1.json");
  const secondPath = join(root, ".hunch/decisions/dec_benchmark_v2.json");

  try {
    const run = spawnSync(process.execPath, [tsx, cli, "auto-review", "--apply"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HUNCH_FAKE_COUNTER: count,
        HUNCH_PRIVATE_DIR: "",
        HUNCH_SYNTH_PROVIDER: "codex-cli",
      },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /Harness batch complete: 2\/2 judged/);
    assert.match(output, /0 accepted, 0 rejected, 2 kept/);
    assert.ok(existsSync(firstPath) && existsSync(secondPath), "both unresolved proposals remain for human review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-review applies accept and append-only reject, then pumps both lifecycle updates", { skip: process.platform === "win32" ? "fixture fakes the provider with a #!/bin/sh stub" : false }, () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-autoreview-pump-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli fixture"
  exit 0
fi
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"relevant\\":true,\\"confidence\\":0.99,\\"duplicate_of\\":null,\\"reason\\":\\"fixture says this memory matters\\"}"}}'
`);
  chmodSync(fakeCodex, 0o755);

  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Auto Review Fixture");
    git(root, "config", "user.email", "auto-review@pump.test");
    writeFileSync(join(root, "app.ts"), "export const pump = true;\n");
    writeFileSync(join(root, ".gitignore"), ".hunch/*.sqlite*\n.hunch/events.log\n.hunch/local.json\n.hunch/.hunch-commit.lock\n");

    const acceptedAnchor: Decision = {
      ...draft("dec_anchor", "Shared transport retries stay bounded"),
      status: "accepted",
      decision: "Shared transport retries stay bounded at three attempts.",
      related_files: ["app.ts"],
      provenance: { source: "human_confirmed", confidence: 0.95, evidence: [] },
    };
    const duplicate: Decision = {
      ...draft("dec_duplicate", acceptedAnchor.title),
      decision: acceptedAnchor.decision,
      related_files: ["app.ts"],
    };
    const ready: Decision = {
      ...draft("dec_ready", "Lifecycle pumps publish every successful review update"),
      decision: "Every successful review update is committed through its exact memory home.",
      related_files: ["src/review.ts"],
      provenance: {
        source: "llm_draft+verified",
        confidence: 0.8,
        evidence: ["synth: provider=fixture grounded=0.95 samples=3 agreement=1 pruned=0"],
      },
    };
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    store.json.put("decisions", acceptedAnchor);
    store.json.put("decisions", duplicate);
    store.json.put("decisions", ready);
    store.close();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "seed review lifecycle");

    const run = spawnSync(process.execPath, [tsx, cli, "auto-review", "--apply"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        HUNCH_PRIVATE_DIR: "",
        HUNCH_SYNTH_PROVIDER: "codex-cli",
        GIT_AUTHOR_NAME: "Auto Review Fixture",
        GIT_AUTHOR_EMAIL: "auto-review@pump.test",
        GIT_COMMITTER_NAME: "Auto Review Fixture",
        GIT_COMMITTER_EMAIL: "auto-review@pump.test",
      },
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, output);
    assert.match(output, /Harness batch complete: 2\/2 judged/);
    assert.match(output, /1 accepted, 1 rejected, 0 kept/);

    const accepted = JSON.parse(readFileSync(join(root, ".hunch/decisions/dec_ready.json"), "utf8")) as Decision;
    const rejected = JSON.parse(readFileSync(join(root, ".hunch/decisions/dec_duplicate.json"), "utf8")) as Decision;
    assert.equal(accepted.status, "accepted");
    assert.match(accepted.provenance.source, /human_confirmed/);
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.valid_to, "auto rejection is retained as a closed lifecycle record");
    assert.match(git(root, "log", "-1", "--format=%s"), /auto-review decision lifecycle/);
    assert.equal(git(root, "status", "--porcelain", "--", ".hunch"), "", "the pump leaves no pending memory mutation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
