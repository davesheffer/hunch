import { cleanupDir } from "./fixtures.js";
/**
 * The overlay flush force-adds only allowlisted JSON that git reports as changed (one `git status`
 * instead of 5,000+ paths through `git add -f`), and falls back to the full allowlist whenever the
 * status probe is in doubt. Differential: every scenario builds two identical twin overlays, flushes
 * one through the old full-allowlist path (failStatus) and one through the probe, and requires the
 * same commit outcome, the same HEAD tree and the same index — never fewer files staged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commitAndPushHunch, overlayFlushTestHooks } from "../src/extractors/git.js";

type Repo = { root: string; dir: string; git: (...a: string[]) => string };

function makeRepo(base: string, name: string, seed: (r: Repo) => void, change: (r: Repo) => void): Repo {
  const root = join(base, name);
  mkdirSync(root);
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "overlay\n");
  const dir = join(root, ".hunch");
  mkdirSync(dir);
  const repo = { root, dir, git };
  seed(repo);
  git("add", "-A");
  git("commit", "-qm", "seed");
  change(repo);
  return repo;
}

const write = (dir: string, rel: string, body: string) => {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
const seedDecisions = (count: number) => (r: Repo) => {
  for (let i = 0; i < count; i++) write(r.dir, `decisions/dec_${i}.json`, JSON.stringify({ id: `dec_${i}` }));
};
const exclude = (r: Repo, line: string) => appendFileSync(join(r.root, ".git", "info", "exclude"), `${line}\n`);

function flush(r: Repo, failStatus: boolean, trace: string): string | null {
  const savedTrace = process.env.GIT_TRACE;
  overlayFlushTestHooks.failStatus = failStatus;
  process.env.GIT_TRACE = trace;
  try {
    return commitAndPushHunch(r.dir, "hunch: flush", { push: true, protectedRepoRoot: join(r.root, "..", "protected-code") });
  } finally {
    overlayFlushTestHooks.failStatus = false;
    if (savedTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = savedTrace;
  }
}

/** Paths passed to every `git add -f` the flush ran, read from a GIT_TRACE file. */
function tracedAddPaths(trace: string): string[] {
  if (!existsSync(trace)) return [];
  const paths: string[] = [];
  for (const line of readFileSync(trace, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("trace: built-in: git add -f ");
    if (at < 0) continue;
    const args = line.slice(at).split(/\s+/);
    const dash = args.indexOf("--");
    if (dash >= 0) paths.push(...args.slice(dash + 1).filter(Boolean));
  }
  return paths;
}

type Twins = { fallback: Repo; probe: Repo; probeResult: string | null; fallbackTrace: string; probeTrace: string };

/** Build identical twins, flush one via the full allowlist and one via the probe, require equal outcomes. */
function differential(label: string, seed: (r: Repo) => void, change: (r: Repo) => void, check?: (t: Twins) => void): void {
  const base = mkdtempSync(join(tmpdir(), "hunch-changed-add-"));
  try {
    const fallback = makeRepo(base, "fallback", seed, change);
    const probe = makeRepo(base, "probe", seed, change);
    const fallbackTrace = join(base, "fallback.trace");
    const probeTrace = join(base, "probe.trace");
    const fallbackResult = flush(fallback, true, fallbackTrace);
    const probeResult = flush(probe, false, probeTrace);
    assert.equal(probeResult, fallbackResult, `${label}: commit outcome`);
    assert.equal(probe.git("ls-tree", "-r", "HEAD"), fallback.git("ls-tree", "-r", "HEAD"), `${label}: HEAD tree`);
    assert.equal(probe.git("ls-files", "-s"), fallback.git("ls-files", "-s"), `${label}: index`);
    check?.({ fallback, probe, probeResult, fallbackTrace, probeTrace });
  } finally {
    overlayFlushTestHooks.failStatus = false;
    cleanupDir(base);
  }
}

const headFiles = (r: Repo) => r.git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);

test("a: a new untracked file alongside tracked files", () => {
  differential("a", seedDecisions(5), (r) => write(r.dir, "decisions/dec_new.json", "{}"), ({ probe, probeResult }) => {
    assert.equal(probeResult, "committed");
    assert.ok(headFiles(probe).includes(".hunch/decisions/dec_new.json"));
  });
});

test("b: a new file in a brand-new subdirectory", () => {
  differential("b", seedDecisions(3), (r) => write(r.dir, "bugs/bug_1.json", "{}"), ({ probe, probeResult }) => {
    assert.equal(probeResult, "committed");
    assert.ok(headFiles(probe).includes(".hunch/bugs/bug_1.json"));
  });
});

test("c: info/exclude hides all of .hunch/ and nothing under it is tracked yet", () => {
  differential("c", () => {}, (r) => {
    exclude(r, ".hunch/");
    write(r.dir, "decisions/dec_1.json", "{}");
    write(r.dir, "constraints/con_1.json", "{}");
  }, ({ probe, probeResult }) => {
    assert.equal(probeResult, "committed");
    assert.deepEqual(headFiles(probe).filter((f) => f.startsWith(".hunch/")).sort(), [".hunch/constraints/con_1.json", ".hunch/decisions/dec_1.json"]);
  });
});

test("d: info/exclude is `*` and nothing under .hunch/ is tracked yet", () => {
  differential("d", () => {}, (r) => {
    exclude(r, "*");
    write(r.dir, "decisions/dec_1.json", "{}");
    write(r.dir, "bugs/bug_1.json", "{}");
  }, ({ probe, probeResult }) => {
    assert.equal(probeResult, "committed");
    assert.deepEqual(headFiles(probe).filter((f) => f.startsWith(".hunch/")).sort(), [".hunch/bugs/bug_1.json", ".hunch/decisions/dec_1.json"]);
  });
});

test("e: an ignored whole new subdirectory collapses to one status entry", () => {
  differential("e", seedDecisions(3), (r) => {
    exclude(r, "bugs/");
    write(r.dir, "bugs/bug_1.json", "{}");
    write(r.dir, "bugs/bug_2.json", "{}");
    write(r.dir, "bugs/deep/bug_3.json", "{}");
  }, ({ probe, probeResult }) => {
    assert.equal(probeResult, "committed");
    const files = headFiles(probe);
    for (const f of [".hunch/bugs/bug_1.json", ".hunch/bugs/bug_2.json", ".hunch/bugs/deep/bug_3.json"]) assert.ok(files.includes(f), f);
  });
});

test("f: modify + delete + a new file hidden by .gitignore", () => {
  differential("f", seedDecisions(10), (r) => {
    writeFileSync(join(r.root, ".gitignore"), "hidden.json\n");
    write(r.dir, "decisions/dec_1.json", JSON.stringify({ id: "dec_1", changed: true }));
    rmSync(join(r.dir, "decisions", "dec_2.json"));
    write(r.dir, "decisions/hidden.json", "{}");
  }, ({ probe }) => {
    const lines = probe.git("show", "--name-status", "--format=", "HEAD").split("\n").map((l) => l.replace(/\s+/g, " ")).sort();
    assert.deepEqual(lines, ["A .hunch/decisions/hidden.json", "D .hunch/decisions/dec_2.json", "M .hunch/decisions/dec_1.json"]);
  });
});

test("g: an assume-unchanged tracked file modified on disk", () => {
  differential("g", seedDecisions(4), (r) => {
    r.git("update-index", "--assume-unchanged", ".hunch/decisions/dec_1.json");
    write(r.dir, "decisions/dec_1.json", JSON.stringify({ id: "dec_1", changed: true }));
    write(r.dir, "decisions/dec_new.json", "{}");
  }, ({ probeResult }) => {
    assert.equal(probeResult, "committed");
  });
});

for (const pattern of [".hunch/", "*"]) {
  test(`steady state: tracked records stay committable when \`${pattern}\` is excluded`, () => {
    differential(`steady ${pattern}`, seedDecisions(4), (r) => {
      exclude(r, pattern);
      write(r.dir, "decisions/dec_2.json", JSON.stringify({ id: "dec_2", changed: true }));
      write(r.dir, "decisions/dec_new.json", "{}");
      write(r.dir, "bugs/bug_1.json", "{}");
    }, ({ probe, probeResult, probeTrace }) => {
      assert.equal(probeResult, "committed");
      const committed = probe.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
      assert.deepEqual(committed, [".hunch/bugs/bug_1.json", ".hunch/decisions/dec_2.json", ".hunch/decisions/dec_new.json"]);
      assert.equal(probe.git("show", "HEAD:.hunch/decisions/dec_2.json"), JSON.stringify({ id: "dec_2", changed: true }));
      // The probe must surface the two hidden new records (plus the tracked modification), nothing else.
      assert.deepEqual(tracedAddPaths(probeTrace).sort(), ["bugs/bug_1.json", "decisions/dec_2.json", "decisions/dec_new.json"]);
    });
  });
}

test("a record path beyond MAX_PATH with core.longpaths=false falls back to the full add", { skip: process.platform !== "win32" ? "MAX_PATH is a Windows limit" : false }, () => {
  const seg = "d".repeat(60);
  const long = [seg, seg, seg, seg, "long_record.json"].join("/");
  differential("longpath", (r) => {
    r.git("config", "core.longpaths", "false");
    seedDecisions(2)(r);
  }, (r) => {
    write(r.dir, long, JSON.stringify({ important: true }));
    write(r.dir, "decisions/dec_new.json", "{}");
  }, ({ probe, fallback, probeResult, probeTrace }) => {
    // differential() already pinned probe == fallback (outcome, HEAD tree, index): the probe stood down.
    assert.equal(probeResult, null);
    assert.equal(probe.git("ls-files").includes("long_record.json"), fallback.git("ls-files").includes("long_record.json"));
    assert.ok(tracedAddPaths(probeTrace).length >= 3, "probe twin fell back to the full allowlist");
  });
});

test("the probe path is taken and narrows the add to the one changed file", () => {
  differential("narrow", seedDecisions(300), (r) => write(r.dir, "decisions/dec_new.json", "{}"), ({ probe, probeResult, fallbackTrace, probeTrace }) => {
    assert.equal(probeResult, "committed");
    assert.equal(probe.git("show", "--name-only", "--format=", "HEAD"), ".hunch/decisions/dec_new.json");
    const probeStatus = /trace: built-in: git status [^\n]*--ignored=matching/;
    assert.ok(probeStatus.test(readFileSync(probeTrace, "utf8")), "probe twin ran the changed-path status");
    assert.ok(!probeStatus.test(readFileSync(fallbackTrace, "utf8")), "fallback twin skipped the probe");
    assert.deepEqual(tracedAddPaths(probeTrace), ["decisions/dec_new.json"]);
    assert.ok(tracedAddPaths(fallbackTrace).length >= 301, "fallback twin adds the full allowlist");
  });
});
