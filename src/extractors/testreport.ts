/**
 * Parse a test run's output into pass/fail signals for the failure-learning loop
 * (`hunch test`). Test-framework-agnostic: it recognizes both common shapes that
 * `node:test` (this repo), mocha, ava, vitest, jest, and `prove` emit:
 *
 *  - TAP:  `ok 12 - name` / `not ok 3 - name`, with an optional indented YAML
 *          diagnostic block (error + stack) under a failure.
 *  - spec: node:test's default non-TTY reporter — `✔ name (1.2ms)` /
 *          `✖ name (1.2ms)`, failures followed by an indented error block.
 *          (Also accepts ✓/✗.)
 *
 * Design choices:
 *  - A failure's `message` is the test name plus its indented diagnostic block —
 *    exactly the context recordFailure() feeds the synthesizer for root-cause and
 *    suspect ranking.
 *  - If NEITHER shape is recognized, we return empty lists + recognized=false so
 *    the caller falls back to a coarse "the suite failed" bug from the raw tail —
 *    never silently reports success.
 *  - Results are deduped by name (a spec reporter can echo a failing test in its
 *    end-of-run recap).
 */

export interface TestFailure {
  /** Stable test identifier (the description) — seeds the bug id. */
  test: string;
  /** Name + diagnostic block; the root-cause/suspect context for synthesis. */
  message: string;
}

export interface TestReport {
  failures: TestFailure[];
  /** Names of tests that passed — used to mark previously-open bugs as fixed. */
  passed: string[];
  /** True iff at least one result line (TAP or spec) was recognized. */
  recognized: boolean;
}

// TAP: `ok 12 - desc` / `not ok 3 - desc` (the "- " separator is optional).
const TAP = /^(not ok|ok)\s+\d+\s*-?\s*(.*)$/;
// spec: `✔ desc (1.2ms)` (pass) or `✖ desc (1.2ms)` (fail). ✓/✗ accepted too.
const SPEC = /^([✔✓✖✗])\s+(.*)$/;
const DURATION = /\s+\(\d+(?:\.\d+)?ms\)\s*$/; // trailing " (1.2ms)" spec suffix
const DIRECTIVE = /#\s*(SKIP|TODO)\b/i;

/** Parse TAP-or-spec text. Pure + synchronous so it's trivially unit-testable. */
export function parseTestReport(output: string): TestReport {
  const lines = output.split(/\r?\n/);
  const failMap = new Map<string, TestFailure>();
  const passSet = new Set<string>();
  let recognized = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    const tap = TAP.exec(trimmed);
    const spec = tap ? null : SPEC.exec(trimmed);
    if (!tap && !spec) continue;
    recognized = true;

    const isFail = tap ? tap[1] === "not ok" : (spec![1] === "✖" || spec![1] === "✗");
    let name = (tap ? tap[2] : spec![2]) ?? "";
    name = name.replace(DURATION, "").trim();
    if (!name) name = `test #${i + 1}`;
    if (DIRECTIVE.test(name)) continue; // skipped/todo — neither pass nor fail
    name = stripDirective(name);

    if (!isFail) {
      passSet.add(name);
      continue;
    }
    if (failMap.has(name)) continue; // dedupe recap echoes
    // Collect the following more-indented diagnostic block as the message.
    const baseIndent = leadingSpaces(raw);
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j]!;
      if (ln.trim() === "") {
        block.push("");
        continue;
      }
      if (leadingSpaces(ln) <= baseIndent) break;
      block.push(ln.slice(baseIndent + 1));
    }
    const diag = block.join("\n").trim();
    failMap.set(name, { test: name, message: diag ? `${name}\n${diag}` : name });
  }

  // A test can legitimately appear as both (flaky retry) — trust the failure.
  for (const name of failMap.keys()) passSet.delete(name);
  return { failures: [...failMap.values()], passed: [...passSet], recognized };
}

function leadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === " ") n++;
  return n;
}

function stripDirective(name: string): string {
  const hash = name.indexOf("#");
  return (hash === -1 ? name : name.slice(0, hash)).trim();
}
