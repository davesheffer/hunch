/** Rendering for `hunch check` — pure, so the terminal output and the CI/PR
 *  comment share one source of truth and stay unit-testable. The CLI builds a
 *  CheckReport from the store (direct/near/regression + the hardened strict gate),
 *  then renders it as text (terminal, unchanged) or markdown (a PR comment posted
 *  by the GitHub Action). The exit-code decision lives with the caller. */

/** The causal chain behind an invariant — the WHY a diff-only reviewer can't see:
 *  the decision that motivated the guard, and the bug whose root cause spawned it.
 *  Resolved deterministically from the graph (constraint→source_decision→bug). */
export interface CausalWhy {
  constraint_id: string;
  decision?: { id: string; title: string; decision: string };
  bug?: { id: string; title: string; root_cause: string };
}

export interface CheckDirect {
  id: string;
  severity: string;
  statement: string;
  rationale: string;
  files: string[];
  /** Would this invariant FAIL the commit under --strict (direct + high-confidence + non-stale)? */
  strictBlocks: boolean;
  /** If a blocking invariant is downgraded to advisory under strict, why. */
  downgrade?: "stale" | "low-confidence";
  /** The causal citation (the "why this guard exists") — present when the graph links it. */
  why?: CausalWhy;
}
export interface CheckNear { id: string; severity: string; statement: string; via: string[]; }
export interface CheckRegression { kind: string; name: string; decision: string; title: string; reason: string; blocking: boolean; }

export interface CheckReport {
  fileCount: number;
  strict: boolean;
  direct: CheckDirect[];
  near: CheckNear[];
  regressions: CheckRegression[];
  /** Count of direct invariants that pass the hardened strict gate. */
  strictBlockers: number;
  /** Count of blocking-linked regressions. */
  regBlocking: number;
}

export function reportIsClean(r: CheckReport): boolean {
  return r.direct.length === 0 && r.near.length === 0 && r.regressions.length === 0;
}

/** True when --strict should FAIL the commit/PR. */
export function reportFailsStrict(r: CheckReport): boolean {
  return r.strict && (r.strictBlockers > 0 || r.regBlocking > 0);
}

const mark = (s: string): string => (s === "blocking" ? "⛔" : s === "warning" ? "⚠" : "·");

const clip = (s: string, n = 160): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** The deterministic VERDICT for a merge: block (a hard gate fired), warn (touches
 *  memory but nothing hard-blocks), or pass (touches no recorded memory at all). */
export function verdict(r: CheckReport): "block" | "warn" | "pass" {
  if (r.strictBlockers > 0 || r.regBlocking > 0) return "block";
  return reportIsClean(r) ? "pass" : "warn";
}

/** Causal "why" citation, terminal form (appended to a direct hit). */
function whyText(why?: CausalWhy): string {
  if (!why) return "";
  const out: string[] = [];
  if (why.decision) out.push(`\n      ↳ why: “${why.decision.title}” (${why.decision.id})${why.decision.decision ? ` — ${clip(why.decision.decision)}` : ""}`);
  if (why.bug) out.push(`\n      ↳ guards against: ${why.bug.title} — ${clip(why.bug.root_cause)} (${why.bug.id})`);
  return out.join("");
}

/** Causal "why" citation, markdown form (returns bullet lines). */
function whyMd(why?: CausalWhy): string[] {
  if (!why) return [];
  const out: string[] = [];
  if (why.decision) out.push(`  - 🧠 _why:_ “${why.decision.title}” (\`${why.decision.id}\`)`);
  if (why.bug) out.push(`  - 🐞 _guards against:_ ${clip(why.bug.title, 100)} — ${clip(why.bug.root_cause)} (\`${why.bug.id}\`)`);
  return out;
}

// ---------------------------------------------------------------------------
// Terminal text (unchanged from the inline CLI output it replaces)
// ---------------------------------------------------------------------------
export function renderText(r: CheckReport): string {
  if (reportIsClean(r)) {
    return `✓ ${r.fileCount} changed file(s) touch no recorded invariants (directly or via blast radius) and re-introduce nothing deliberately retired.`;
  }
  const out: string[] = [];
  if (r.direct.length) {
    out.push(`Directly touches ${r.direct.length} invariant(s):\n`);
    for (const c of r.direct) {
      const note = r.strict && c.severity === "blocking" && !c.strictBlocks
        ? c.downgrade === "stale" ? "  (advisory: stale)" : "  (advisory: low confidence)"
        : "";
      out.push(`  ${mark(c.severity)} [${c.severity}] ${c.statement}${note}\n      ${c.id} · in: ${c.files.join(", ")}\n      rationale: ${c.rationale || "—"}${whyText(c.why)}`);
    }
  }
  if (r.near.length) {
    out.push(`${r.direct.length ? "\n" : ""}Near ${r.near.length} invariant(s) via blast radius (a guarded dependency changed — review; never blocks):\n`);
    for (const c of r.near) {
      out.push(`  ${mark(c.severity)} [${c.severity}] ${c.statement}\n      ${c.id}\n      ${c.via.slice(0, 4).join("\n      ")}${c.via.length > 4 ? `\n      …+${c.via.length - 4} more path(s)` : ""}`);
    }
  }
  if (r.regressions.length) {
    out.push(`${r.direct.length || r.near.length ? "\n" : ""}Re-introduces ${r.regressions.length} deliberately-retired item(s):\n`);
    for (const h of r.regressions) {
      out.push(`  ${h.blocking ? "⛔" : "⚠"} re-adds ${h.kind} \`${h.name}\` — ${h.decision} removed it${h.blocking ? " (blocking-linked)" : ""}\n      “${h.title}”\n      ${h.reason}`);
    }
  }
  if (reportFailsStrict(r)) {
    const reasons = [
      r.strictBlockers ? `${r.strictBlockers} high-confidence blocking invariant(s) directly in scope` : "",
      r.regBlocking ? `${r.regBlocking} blocking-linked regression(s)` : "",
    ].filter(Boolean).join(" + ");
    out.push(`\n✗ ${reasons} — review before committing.`);
  } else if (r.strict) {
    out.push(`\nReview these — none are a direct, high-confidence, non-stale blocking invariant, so the commit is NOT blocked.`);
  } else {
    out.push(`\nReview that these invariants still hold. (Advisory — run with --strict to fail on direct, high-confidence, non-stale blocking invariants.)`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown (a PR comment posted by the CI Constraint Guard)
// ---------------------------------------------------------------------------
export function renderMarkdown(r: CheckReport): string {
  const H = "## 🧠 Hunch — Engineering Memory Guard";
  if (reportIsClean(r)) {
    return `${H}\n\n✅ This PR touches **no recorded invariants** (directly or via blast radius) and re-introduces nothing deliberately retired across ${r.fileCount} changed file(s).`;
  }
  const out: string[] = [H, ""];
  if (r.direct.length) {
    out.push(`### ⛔ Invariants directly in scope`);
    for (const c of r.direct) {
      const note = r.strict && c.severity === "blocking" && !c.strictBlocks
        ? c.downgrade === "stale" ? " _(advisory: record is stale)_" : " _(advisory: low confidence)_"
        : "";
      out.push(`- **[${c.severity}] ${c.statement}** — \`${c.id}\`${note}`);
      out.push(`  - in: ${c.files.map((f) => `\`${f}\``).join(", ")}`);
      if (c.rationale) out.push(`  - _${c.rationale}_`);
      for (const line of whyMd(c.why)) out.push(line);
    }
    out.push("");
  }
  if (r.near.length) {
    out.push(`### ⚠ Near-invariants (reached via blast radius — review, never blocks)`);
    for (const c of r.near) {
      out.push(`- **[${c.severity}] ${c.statement}** — \`${c.id}\``);
      out.push(`  - ${c.via.slice(0, 3).join("\n  - ")}${c.via.length > 3 ? `\n  - …+${c.via.length - 3} more path(s)` : ""}`);
    }
    out.push("");
  }
  if (r.regressions.length) {
    out.push(`### ♻️ Re-introduces deliberately-retired code`);
    for (const h of r.regressions) {
      out.push(`- ${h.blocking ? "⛔" : "⚠"} re-adds ${h.kind} \`${h.name}\` — \`${h.decision}\` removed it${h.blocking ? " **(blocking-linked)**" : ""}`);
      out.push(`  - _${h.title}_`);
    }
    out.push("");
  }
  out.push("---");
  if (reportFailsStrict(r)) {
    const reasons = [
      r.strictBlockers ? `${r.strictBlockers} high-confidence blocking invariant(s) directly in scope` : "",
      r.regBlocking ? `${r.regBlocking} blocking-linked regression(s)` : "",
    ].filter(Boolean).join(" + ");
    out.push(`❌ **This PR breaks ${reasons}.** Resolve or supersede the decision before merge.`);
  } else if (r.strict) {
    out.push(`ℹ️ Nothing here is a direct, high-confidence, non-stale blocking invariant — **not blocking** this PR.`);
  } else {
    out.push(`ℹ️ Advisory — review that these invariants still hold.`);
  }
  out.push(`\n<sub>🧠 Hunch · engineering memory · run \`hunch why <file>\` for the full reasoning.</sub>`);
  return out.join("\n");
}
