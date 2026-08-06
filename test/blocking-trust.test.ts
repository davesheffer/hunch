/**
 * A BLOCKING constraint denies edits under strict firmness, so it must never be
 * minted from an unverified input (round-3 audit #2 and #3).
 *
 * Two paths reached `severity: "blocking"` without a trust gate:
 *  #2 — hunch_record_correction with an ABSOLUTE scope_hint_file: agents naturally send
 *       absolute paths, but every consumer matches repo-relative, so the rule was
 *       blocking-but-inert while reporting itself enforced — and it wrote the developer's
 *       local filesystem path into the committed graph and CLAUDE.md.
 *  #3 — a bug promotion where BOTH the severity label and the file scope are untrusted:
 *       `severity` is the synthesis provider's LLM enum, `affected_files` is empty when
 *       suspect ranking resolves nothing → scope ["**"] + blocking = a repo-wide deny on
 *       every subsequent edit, from a label no human ever saw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorrectionConstraint } from "../src/core/correction.js";
import { shouldBlockOnPromotion } from "../src/synthesis/synthesize.js";
import { pathMatchesGlob } from "../src/core/glob.js";

/** The exact predicate HunchStore.checkConstraints uses to decide whether an
 *  invariant is in scope for a file — the thing an absolute scope silently failed. */
const firesOn = (scope: string[], file: string): boolean =>
  scope.some((g) => pathMatchesGlob(file, g) || pathMatchesGlob(g, file) || g === file);

const NOW = "2026-08-06T00:00:00.000Z";
const ROOT = process.platform === "win32" ? "C:\\repo\\proj" : "/repo/proj";
const inRoot = (rel: string): string => (process.platform === "win32" ? `${ROOT}\\${rel.replace(/\//g, "\\")}` : `${ROOT}/${rel}`);

test("an absolute scope_hint_file is relativized, so the rule actually matches (#2)", () => {
  const con = buildCorrectionConstraint(
    { rule: "never widen this API", scope_hint_file: inRoot("src/core/check.ts"), severity: "blocking", root: ROOT },
    NOW,
  );
  assert.deepEqual(con.scope, ["src/core/check.ts"], "scope is repo-relative POSIX");
  assert.equal(con.severity, "blocking", "a properly scoped blocking rule stays blocking");

  // The point of the fix: it must actually FIRE on the file it was scoped to.
  assert.ok(firesOn(con.scope, "src/core/check.ts"), "blocking-and-enforced, not blocking-but-inert");
});

test("no local filesystem path leaks into the committed record (#2)", () => {
  const con = buildCorrectionConstraint(
    { rule: "never widen this API", scope_hint_file: inRoot("src/core/check.ts"), severity: "blocking", root: ROOT },
    NOW,
  );
  const serialized = JSON.stringify(con);
  assert.ok(!serialized.includes("repo/proj") && !serialized.includes("repo\\\\proj"), "the developer's local path is not published");
});

test("an absolute hint OUTSIDE the repo never becomes a blocking scope (#2)", () => {
  const outside = process.platform === "win32" ? "C:\\elsewhere\\other.ts" : "/elsewhere/other.ts";
  const con = buildCorrectionConstraint(
    { rule: "never do the bad thing", scope_hint_file: outside, severity: "blocking", root: ROOT },
    NOW,
  );
  assert.deepEqual(con.scope, ["**"], "an unrelativizable hint falls back to repo-wide");
  assert.equal(con.severity, "warning", "…and the existing scope guard then refuses to make it a deny");
  assert.ok(!JSON.stringify(con).includes("elsewhere"), "and the foreign path is not published either");
});

test("a relative hint is untouched (no regression) (#2)", () => {
  const con = buildCorrectionConstraint(
    { rule: "never widen this API", scope_hint_file: "src/core/check.ts", severity: "blocking", root: ROOT },
    NOW,
  );
  assert.deepEqual(con.scope, ["src/core/check.ts"]);
  assert.equal(con.severity, "blocking");
});

// ---- #3: bug promotion ----

test("a model-labeled critical bug with NO resolvable suspects never mints a repo-wide deny (#3)", () => {
  // The exact catastrophic composition: the provider's enum said "critical", suspect
  // ranking resolved nothing (→ scope "**"), and it's a first sighting. Before the
  // gate this produced a repo-wide BLOCKING constraint that denied every later edit.
  assert.equal(shouldBlockOnPromotion("critical", [], false), false);
  assert.equal(shouldBlockOnPromotion("critical", [], true), false, "even a recurrence must not deny repo-wide");
});

test("a model 'critical' label alone is not enough to deny — it needs deterministic corroboration (#3)", () => {
  assert.equal(shouldBlockOnPromotion("critical", ["src/pay.ts"], false), false, "a first-sighting LLM label stays a warning");
  assert.equal(shouldBlockOnPromotion("critical", ["src/pay.ts"], true), true, "scoped + recurrence may block");
});

test("non-critical severities never block, whatever the scope (#3)", () => {
  for (const sev of ["low", "medium", "high"] as const) {
    assert.equal(shouldBlockOnPromotion(sev, ["src/pay.ts"], true), false, `${sev} must not auto-deny`);
  }
});

test("the store never accumulates an auto-derived repo-wide deny end to end (#3)", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hunchPaths } = await import("../src/core/paths.js");
  const { HunchStore } = await import("../src/store/hunchStore.js");
  const { recordFailure } = await import("../src/synthesis/synthesize.js");

  process.env.HUNCH_SYNTH_PROVIDER = "deterministic";
  const root = mkdtempSync(join(tmpdir(), "hunch-blocking-"));
  try {
    mkdirSync(join(root, ".hunch"), { recursive: true });
    writeFileSync(join(root, ".hunch", "local.json"), JSON.stringify({ autoCommit: false }) + "\n");
    const store = new HunchStore(hunchPaths(root));
    store.json.ensureDirs();
    try {
      // No symbols indexed → rankSuspects resolves nothing → affected_files is empty.
      // Twice, so the second is a recurrence (the one path allowed to block).
      const msg = "AssertionError: expected 200, got 500 — data loss in the ledger";
      await recordFailure(store, root, { test: "payments integration", message: msg });
      await recordFailure(store, root, { test: "payments checkout", message: msg });

      const repoWideDenies = store.json
        .loadAll("constraints")
        .filter((c) => c.severity === "blocking" && c.scope.includes("**"))
        .map((c) => c.id);
      assert.deepEqual(repoWideDenies, [], "no auto-derived repo-wide blocking constraint was written");
    } finally { store.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
