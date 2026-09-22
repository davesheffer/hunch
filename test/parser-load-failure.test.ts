/**
 * A dead PARSER must never be mistaken for a repo full of bad files.
 *
 * The native tree-sitter addons load on first parse (not at import), so a
 * broken load — unwritable/full TMPDIR, a missing or wrong-arch prebuild, an
 * addon already loaded past the isolation guard, npm swapping the package out
 * mid-session — throws from inside parseSource(). The indexer's per-file catch
 * ("one bad file must never abort the run") used to convert that into
 * parse_failed for EVERY file, after which indexRepo replaced symbols, edges
 * and components with empty arrays and exited 0: the graph silently wiped by a
 * transient environment fault. These cases assert the opposite contract — the
 * run dies before the first store write and says why, and `hunch doctor`
 * reports the same failure rather than calling the environment healthy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HunchStore } from "../src/store/hunchStore.js";
import { hunchPaths } from "../src/core/paths.js";
import { isParserLoadError } from "../src/extractors/nativeTreeSitter.js";
import { ConstitutionService } from "../src/constitution/service.js";
import { bootstrapStructuralPolicies } from "../src/constitution/structural.js";
import { buildG2CandidateReview } from "../src/constitution/g2Candidates.js";
import type { Decision } from "../src/core/types.js";
import { cleanupDir } from "./helpers.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

/** chmod cannot model an unwritable directory for the owner on Windows, and
 *  root ignores the 0555 bits outright (Docker, CI images and sudo runs all hit
 *  this), so the TMPDIR cases are POSIX-non-root only — otherwise they would
 *  FAIL there rather than skip. The preloaded-addon case below breaks the SAME
 *  loader without chmod and runs everywhere — the contract stays covered on
 *  every platform and every user. */
const CHMOD_SKIP: boolean | string =
  process.platform === "win32"
    ? "chmod cannot make a directory unwritable on Windows"
    : process.getuid?.() === 0
      ? "root ignores the 0555 mode bits, so TMPDIR cannot be made unwritable"
      : false;

interface Fixture {
  root: string;
  /** Symbols/edges as they stood before the failing run, for a byte comparison. */
  before: { symbols: string; edges: string };
  cleanup: () => void;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hunch(root: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
  const child = spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
}

/** A real repo with a real, non-empty index — the only state in which the
 *  regression is visible (an empty graph overwritten with nothing looks fine). */
function indexedRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hunch-parser-load-"));
  writeFileSync(join(root, "alpha.ts"), "export function alpha(): number { return 1; }\n");
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "Fixture");
  git(root, "add", "alpha.ts");
  git(root, "commit", "-qm", "init");
  const seeded = hunch(root, ["index", "--no-auto-commit"]);
  assert.equal(seeded.status, 0, seeded.out);
  const read = (kind: string): string => readFileSync(join(root, ".hunch", kind, "index.json"), "utf8");
  const before = { symbols: read("symbols"), edges: read("edges") };
  assert.ok(before.symbols.includes("alpha"), `fixture index is empty before the failing run: ${before.symbols}`);
  return { root, before, cleanup: () => cleanupDir(root) };
}

function assertIndexUntouched(fixture: Fixture): void {
  const read = (kind: string): string => readFileSync(join(fixture.root, ".hunch", kind, "index.json"), "utf8");
  assert.equal(read("symbols"), fixture.before.symbols, "symbols/index.json was rewritten by a run that could not parse");
  assert.equal(read("edges"), fixture.before.edges, "edges/index.json was rewritten by a run that could not parse");
}

/** A TMPDIR the loader cannot mkdtemp into. tsx needs its own cache dir under
 *  TMPDIR before it can start at all, so create that first, then lock the
 *  directory — only Hunch's own copy dir is then impossible. */
function unwritableTmpdir(): { dir: string; env: NodeJS.ProcessEnv; release: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hunch-unwritable-tmp-"));
  mkdirSync(join(dir, `tsx-${process.getuid?.() ?? 0}`), { recursive: true });
  chmodSync(dir, 0o555);
  return {
    dir,
    env: { TMPDIR: dir, TEMP: dir, TMP: dir },
    release: () => { chmodSync(dir, 0o755); cleanupDir(dir); },
  };
}

/** A CJS module that trips the loader's fail-closed isolation guard, so the SAME
 *  load failure is reproducible on every platform and every user without chmod.
 *  Written into a scratch dir OUTSIDE any fixture repo: `hunch index` refuses a
 *  dirty indexed tree, and a preload script committed into the fixture would be
 *  its own failure rather than the parser's. */
function deadParserEnv(scratch: string): NodeJS.ProcessEnv {
  const preload = join(scratch, "preload-addon.cjs");
  writeFileSync(preload, `require(${JSON.stringify(join(projectRoot, "node_modules/tree-sitter"))});\n`);
  return { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
}

test("index refuses and preserves the graph when the native parser cannot load", { skip: CHMOD_SKIP }, () => {
  const fixture = indexedRepo();
  const broken = unwritableTmpdir();
  try {
    const run = hunch(fixture.root, ["index", "--no-auto-commit"], broken.env);
    assert.notEqual(run.status, 0, `index exited 0 with a dead parser:\n${run.out}`);
    assert.match(run.out, /native tree-sitter parser unavailable/, run.out);
    assertIndexUntouched(fixture);
  } finally {
    broken.release();
    fixture.cleanup();
  }
});

// Same contract, no chmod: preloading an installed addon trips the loader's own
// fail-closed isolation guard (issue #52), which is a production load failure on
// every platform. Runs on Windows, where the TMPDIR case above cannot.
test("index refuses and preserves the graph when the isolation guard fails the load", () => {
  const fixture = indexedRepo();
  const scratch = mkdtempSync(join(tmpdir(), "hunch-preload-addon-"));
  try {
    const run = hunch(fixture.root, ["index", "--no-auto-commit"], deadParserEnv(scratch));
    assert.notEqual(run.status, 0, `index exited 0 with a dead parser:\n${run.out}`);
    assert.match(run.out, /native tree-sitter parser unavailable[\s\S]*loaded before Hunch could isolate it/, run.out);
    assertIndexUntouched(fixture);
  } finally {
    cleanupDir(scratch);
    fixture.cleanup();
  }
});

test("doctor reports a parser that cannot load instead of a healthy environment", { skip: CHMOD_SKIP }, () => {
  const fixture = indexedRepo();
  const broken = unwritableTmpdir();
  try {
    const run = hunch(fixture.root, ["doctor"], broken.env);
    assert.match(run.out, /parser: +⛔ native tree-sitter parser unavailable/, run.out);
    assert.notEqual(run.status, 0, `doctor exited 0 with a dead parser:\n${run.out}`);
  } finally {
    broken.release();
    fixture.cleanup();
  }
});

/** A repo whose only interesting content is one VALID OpenSLO declaration —
 *  the discovery path that parses YAML through the native parser. */
function sloRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-parser-load-slo-"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "probe", version: "1.0.0" }, null, 2)}\n`);
  mkdirSync(join(root, "slos"));
  writeFileSync(join(root, "slos", "checkout.yaml"),
    "apiVersion: openslo/v1\nkind: SLO\nmetadata:\n  name: checkout-availability\nspec:\n  service: checkout\n");
  git(root, "init", "-q", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "Fixture");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return { root, cleanup: () => cleanupDir(root) };
}

test("landscape review discovers a valid SLO declaration when the parser is healthy", () => {
  const fixture = sloRepo();
  try {
    const run = hunch(fixture.root, ["landscape", "review"]);
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /slo:repository\/slos\/checkout\.yaml/, run.out);
    assert.doesNotMatch(run.out, /slo_declaration_invalid/, run.out);
  } finally {
    fixture.cleanup();
  }
});

// The control above is what a dead parser silently destroys: `validYamlOpenSlo`
// parses through the native parser, and the swallowing catch turned a load
// failure into "this file is invalid" — the resource dropped, the user's valid
// file blamed, exit 0, and a ready-made `landscape adopt --acknowledge-issues`
// line inviting a store write of that false verdict.
test("landscape review refuses rather than calling a valid SLO invalid when the parser cannot load", () => {
  const fixture = sloRepo();
  const scratch = mkdtempSync(join(tmpdir(), "hunch-preload-addon-"));
  try {
    const run = hunch(fixture.root, ["landscape", "review"], deadParserEnv(scratch));
    assert.notEqual(run.status, 0, `landscape review exited 0 with a dead parser:\n${run.out}`);
    assert.match(run.out, /native tree-sitter parser unavailable/, run.out);
    assert.doesNotMatch(run.out, /slo_declaration_invalid/, `a dead parser was reported as an invalid SLO file:\n${run.out}`);
  } finally {
    cleanupDir(scratch);
    fixture.cleanup();
  }
});

// `hunch worktree` is the one caller where refusing is WORSE than continuing:
// git has already created the worktree and branch by the time anything parses,
// so dying there left external state behind with no success line, no ledger
// entry, and a re-run blocked by "path already exists". The code graph it
// builds is an advertised convenience, not the promise, so a dead parser is
// downgraded to the same note channel the other optional steps use.
test("worktree completes and reports a skipped index when the parser cannot load", () => {
  const fixture = indexedRepo();
  const scratch = mkdtempSync(join(tmpdir(), "hunch-preload-addon-"));
  try {
    const run = hunch(fixture.root, ["worktree", "wt-a", "-b", "feature-a"], deadParserEnv(scratch));
    assert.equal(run.status, 0, `worktree failed instead of skipping the optional index:\n${run.out}`);
    assert.match(run.out, /✓ worktree created/, run.out);
    assert.match(run.out, /code graph skipped — native tree-sitter parser unavailable/, run.out);
    assert.ok(existsSync(join(fixture.root, "wt-a")), "the worktree git already created must still be there");
    // Re-runnable: the command finished, so nothing is half-done for the user.
    const again = hunch(fixture.root, ["worktree", "wt-a", "-b", "feature-b"], deadParserEnv(scratch));
    assert.notEqual(again.status, 0, "a second worktree at the same path must still be refused");
    assert.match(again.out, /path already exists/, again.out);
  } finally {
    cleanupDir(scratch);
    fixture.cleanup();
  }
});

/** Kill the parser IN this process, the production way: preloading an installed
 *  addon trips the loader's own fail-closed isolation guard (issue #52), so the
 *  error these cases meet is a real NativeTreeSitterLoadError from the real
 *  loader — no injection seam is added to production code for the test. Only
 *  loader SUCCESS is memoized, so this must run before anything here parses,
 *  and the fixtures below therefore never index. It is also IRREVERSIBLE for
 *  the rest of this process: every in-process case added after the two below
 *  must expect a dead parser, or run the CLI in a subprocess like the rest of
 *  this file. */
function killParserInProcess(): void {
  createRequire(import.meta.url)("tree-sitter");
}

/** A repo with one fixing commit over a parseable source file — the state both
 *  constitution readers need before they parse. Deliberately NOT indexed: the
 *  rethrow under test happens at the first structural parse, and indexing here
 *  would memoize a working parser that can no longer be killed. */
function structuralRepo(opts: { emptyWorkingTree?: boolean } = {}):
{ root: string; store: HunchStore; commit: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hunch-parser-load-structural-"));
  const run = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/charge.ts"), "export function charge(u){ return u; }\n");
  run("init", "-q", ".");
  run("config", "maintenance.auto", "false");
  run("config", "gc.auto", "0");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "Fixture");
  run("add", "-A");
  run("commit", "-qm", "init");
  writeFileSync(join(root, "src/charge.ts"),
    "export function verifySession(u){ return u; }\nexport function charge(u){ return verifySession(u); }\n");
  run("add", "-A");
  run("commit", "-qm", "fix: charge must verify the session");
  const commit = run("rev-parse", "HEAD");
  // The G2 reader indexes the WORKING TREE before it grounds decisions, and the
  // indexer has a rethrow of its own. Removing the source afterwards leaves
  // nothing for that scan to parse, so the first parse of the run is the one
  // under test — the decision still points at the commit that holds the code.
  if (opts.emptyWorkingTree) {
    run("rm", "-q", "--", "src/charge.ts");
    run("commit", "-qm", "chore: retire the fixture source");
  }
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  return { root, store, commit, cleanup: () => { store.close(); cleanupDir(root); } };
}

/** A commit-anchored, human-confirmed fixing decision: eligible for both the
 *  bootstrap compiler and the G2 private grounding pass. */
function fixingDecision(id: string, commit: string, now: string): Decision {
  return {
    id,
    title: "charge must call verifySession",
    topic: `parser-load.${id}`,
    status: "accepted",
    context: "The charge path skipped verifySession.",
    decision: "Keep the exact charge -> verifySession call in the static graph.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: ["src/charge.ts"],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: "bug_session_bypass",
    commit,
    valid_from: now,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    conformance: [],
    provenance: { source: "human_confirmed", confidence: 1, evidence: ["review-1"] },
    date: now,
  };
}

// "uncompilable" is a verdict about the DECISION and it is written to evidence.
// A dead parser says nothing about the decision, so it must abort the bootstrap
// rather than stamp every eligible decision uncompilable with a loader error as
// the stated reason (src/constitution/structural.ts).
test("constitution bootstrap rethrows a parser load failure instead of recording it as uncompilable", () => {
  const fixture = structuralRepo();
  const now = new Date().toISOString();
  try {
    fixture.store.json.put("decisions", fixingDecision("dec_parser_load", fixture.commit, now));
    fixture.store.reindex();
    const service = new ConstitutionService(fixture.store, fixture.root);
    killParserInProcess();
    assert.throws(
      () => bootstrapStructuralPolicies(fixture.store, fixture.root, service.repository, { since: "3650d", now }),
      (error: Error) => isParserLoadError(error),
      "a dead parser was swallowed into an uncompilable verdict",
    );
  } finally {
    fixture.cleanup();
  }
});

// A dead parser makes EVERY private decision look structurally unbindable, so
// the review packet would silently downgrade exact human grounding to
// unattested coincidence (src/constitution/g2Candidates.ts).
test("G2 candidate grounding rethrows a parser load failure instead of under-attesting", () => {
  const fixture = structuralRepo({ emptyWorkingTree: true });
  const now = new Date().toISOString();
  try {
    fixture.store.close();
    const privateRoot = join(fixture.root, "private-parser-load/.hunch");
    mkdirSync(privateRoot, { recursive: true });
    execFileSync("git", ["init", "-q", join(fixture.root, "private-parser-load")], { stdio: "ignore" });
    writeFileSync(join(fixture.root, ".hunch/local.json"),
      JSON.stringify({ privateDir: privateRoot, autoCommit: false, mode: "private" }));
    const store = new HunchStore(hunchPaths(fixture.root));
    try {
      store.putPrivate("decisions", fixingDecision("dec_parser_load_g2", fixture.commit, now));
      store.reindex();
      killParserInProcess();
      assert.throws(
        () => buildG2CandidateReview(store, fixture.root, { since: "3650d" }),
        (error: Error) => isParserLoadError(error),
        "a dead parser was swallowed into a missing grounding entry",
      );
    } finally {
      store.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("doctor confirms the parser loads in a healthy environment", () => {
  const fixture = indexedRepo();
  try {
    const run = hunch(fixture.root, ["doctor"]);
    assert.match(run.out, /parser: +native tree-sitter addons load/, run.out);
  } finally {
    fixture.cleanup();
  }
});
