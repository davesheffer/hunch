/**
 * The committed grounding docs must match what THIS repo's graph generates.
 *
 * The release gate's repository-index stage runs `hunch index`, which regenerates
 * CLAUDE.md / AGENTS.md / copilot-instructions / hunch.mdc / hunch.md. If the committed
 * copies are stale the tree goes dirty mid-gate and the release fails with
 * "source-integrity failure: repository-index: the working tree changed during release
 * verification" — a message that names neither the file nor the cause.
 *
 * That check only runs on a TAG PUSH, so a repo can be green on every ordinary CI run
 * right up to the irreversible step. It cost two red cycles on 2026-08-09 (fnd_6391b4242f):
 * once when the video/ kit created a Video component whose record was never committed,
 * once when premises.ts + new tests moved the counts.
 *
 * The capture path already self-heals via refreshCommittableGrounding + alsoStage — but
 * ONLY when the post-commit hook runs with auto-commit on. A commit made on another
 * machine, in CI, with --no-verify, or from a clone without hooks installed leaves the
 * docs stale with nothing to notice. This test is that "something", and it fails in
 * ordinary CI with an actionable message instead of at tag time.
 *
 * Deterministic across platforms: the managed block carries RECORD counts (decisions,
 * bugs, constraints, components, policies, findings) which come from .hunch/*.json —
 * not the symbol/edge counts, which legitimately differ between Windows and Linux.
 *
 * Direction-aware since fnd_c402046ac7: two branches that each capture a record both
 * regenerate the same "N+1" counts line, the forge merges them without a conflict, and
 * the committed doc is one BEHIND the store — no hook ran, nobody erred, and the next
 * capture heals it. That lag is reported as a diagnostic, not a failure. A doc whose
 * prose differs, or whose append-only counts run AHEAD of the store (a record that was
 * never committed — the only defect the counts ever caught), still fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { renderHunchSection } from "../src/integrations/claudemd.js";
import { classifyGroundingBlock, describeGroundingFreshness } from "../src/core/groundingLag.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const END = "<!-- HUNCH:END -->";

/** The managed block's CONTENT, markers stripped. Applied to both sides:
 *  renderHunchSection() returns the section WITH its markers, so comparing its raw
 *  output against a marker-stripped extraction diffs at line 1 forever. */
function blockContent(text: string): string | null {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i === -1 || j === -1 || j < i) return null;
  return text.slice(i + START.length, j).trim();
}

function committedBlock(file: string): string | null {
  return existsSync(file) ? blockContent(readFileSync(file, "utf8")) : null;
}

test("the committed CLAUDE.md grounding block matches what the graph generates (merge lag tolerated)", (t) => {
  // PUBLIC-ONLY, exactly as the gate runs it (gateEnvironment points repository-index at
  // an empty private home). HUNCH_PRIVATE_DIR takes precedence over .hunch/local.json AND
  // the shared pointer in .git/hunch/, so this is deterministic on a dev machine with an
  // overlay attached — where the union would otherwise render 274 decisions instead of the
  // public 164, and "fix" the mismatch by writing private counts into a public doc.
  const emptyPrivate = mkdtempSync(join(tmpdir(), "hunch-grounding-freshness-"));
  const prior = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = emptyPrivate;
  const store = new HunchStore(hunchPaths(repoRoot));
  try {
    const rendered = renderHunchSection(store, repoRoot);
    const generated = blockContent(rendered) ?? rendered.trim();
    const committed = committedBlock(join(repoRoot, "CLAUDE.md"));
    assert.ok(committed !== null, "CLAUDE.md carries a managed HUNCH block");
    const verdict = classifyGroundingBlock(committed, generated);
    if (verdict.kind === "lagging") {
      // Records merged in behind the doc (fnd_c402046ac7). Transient by construction:
      // refreshCommittableGrounding folds the regenerated docs into the next capture
      // commit, and the release gate's repository-index stage regenerates them and
      // already treats the dirt as memory churn. Say so; do not go red.
      t.diagnostic(describeGroundingFreshness("CLAUDE.md", verdict));
      return;
    }
    assert.equal(
      verdict.kind,
      "fresh",
      `${describeGroundingFreshness("CLAUDE.md", verdict)}\n`
      + "Regenerate and commit it WITH the change that moved the counts:\n"
      + "    HUNCH_PRIVATE_DIR=<empty-dir> npx tsx src/cli/index.ts grounding --refresh\n"
      + "then commit CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, "
      + ".cursor/rules/hunch.mdc and .windsurf/rules/hunch.md.\n"
      + "Leaving it stale fails the release gate at TAG time with a message that names "
      + "neither the file nor the cause (fnd_6391b4242f).",
    );
    if (verdict.kind === "fresh") {
      // Belt and braces: the classifier's "fresh" must mean byte-equal.
      assert.equal(committed, generated);
    }
  } finally {
    store.close();
    process.env.HUNCH_PRIVATE_DIR = prior;
    if (prior === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    rmSync(emptyPrivate, { recursive: true, force: true });
  }
});

test("the record counts in the block are public-store numbers, never the overlay union", () => {
  // Guards the failure mode of the fix itself: regenerating with a private overlay
  // attached writes union counts into a committed PUBLIC doc. The public store is the
  // only legitimate source for this block.
  const committed = committedBlock(join(repoRoot, "CLAUDE.md"));
  assert.ok(committed, "block present");
  const m = /\*\*(\d+) decisions, (\d+) bugs?, (\d+) constraints?/.exec(committed!);
  assert.ok(m, `block states record counts, got: ${committed!.slice(0, 160)}`);

  const emptyPrivate = mkdtempSync(join(tmpdir(), "hunch-grounding-public-"));
  const prior = process.env.HUNCH_PRIVATE_DIR;
  process.env.HUNCH_PRIVATE_DIR = emptyPrivate;
  const store = new HunchStore(hunchPaths(repoRoot));
  try {
    // An overlay union can only push a count ABOVE the public store; merge lag
    // (fnd_c402046ac7) only ever leaves it below. So: never above.
    const decisions = store.json.loadAll("decisions").length;
    const constraints = store.json.loadAll("constraints").length;
    assert.ok(Number(m![1]) <= decisions, `decision count ${m![1]} exceeds the PUBLIC store's ${decisions} — an overlay union or an uncommitted record`);
    assert.ok(Number(m![3]) <= constraints, `constraint count ${m![3]} exceeds the PUBLIC store's ${constraints} — an overlay union or an uncommitted record`);
  } finally {
    store.close();
    process.env.HUNCH_PRIVATE_DIR = prior;
    if (prior === undefined) delete process.env.HUNCH_PRIVATE_DIR;
    rmSync(emptyPrivate, { recursive: true, force: true });
  }
});
