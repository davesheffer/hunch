import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitAndPushHunch, pullHunch, pullHunchStatus, syncExistingHunch } from "../src/extractors/git.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };
const cfg = (repo: string): void => { g(repo, "config", "user.email", "t@example.com"); g(repo, "config", "user.name", "T"); };
const decFiles = (hunchDir: string): string[] => { try { return readdirSync(join(hunchDir, "decisions")).sort(); } catch { return []; } };
const writeDec = (repo: string, id: string, body = "{}"): void => {
  const dir = join(repo, ".hunch", "decisions");
  mkdirSync(dir, { recursive: true }); // git doesn't track empty dirs, so the clone may lack it
  writeFileSync(join(dir, `${id}.json`), body + "\n");
};

/** A bare "GitHub" remote + two clones A and B (two machines), each a hunch-overlay repo. */
function setup(): { A: string; B: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "hunch-sync-"));
  const remote = join(base, "remote.git");
  g(base, "init", "--bare", "-b", "main", remote);
  const seed = join(base, "seed");
  mkdirSync(join(seed, ".hunch", "decisions"), { recursive: true });
  g(seed, "init", "-b", "main", "."); cfg(seed);
  writeFileSync(join(seed, ".hunch", "manifest.json"), '{"schema_version":1}\n');
  g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "seed");
  g(seed, "remote", "add", "origin", remote); g(seed, "push", "-q", "origin", "main");
  const A = join(base, "A"), B = join(base, "B");
  g(base, "clone", "-q", remote, A); cfg(A);
  g(base, "clone", "-q", remote, B); cfg(B);
  return { A, B, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A local overlay with one commit-capable branch pointing at a genuinely empty bare remote. */
function setupEmptyRemote(): {
  overlay: string;
  hunchDir: string;
  protectedRoot: string;
  remote: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), "hunch-sync-empty-"));
  const remote = join(base, "memory.git");
  g(base, "init", "--bare", "-b", "main", remote);

  const protectedRoot = join(base, "code");
  mkdirSync(protectedRoot, { recursive: true });
  g(protectedRoot, "init", "-b", "main", ".");
  cfg(protectedRoot);
  writeFileSync(join(protectedRoot, "README.md"), "code repository\n");
  g(protectedRoot, "add", "README.md");
  g(protectedRoot, "commit", "-q", "-m", "code seed");

  const overlay = join(base, "overlay");
  mkdirSync(join(overlay, ".hunch", "decisions"), { recursive: true });
  g(overlay, "init", "-b", "main", ".");
  cfg(overlay);
  g(overlay, "remote", "add", "origin", remote);
  return {
    overlay,
    hunchDir: join(overlay, ".hunch"),
    protectedRoot,
    remote,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test("two-way sync: two clones each write a DIFFERENT decision → both converge after a sync", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    writeDec(A, "dec_a"); commitAndPushHunch(ah, "A: dec_a", { push: true, protectedRepoRoot: join(A, "..") }); // A pushes dec_a
    writeDec(B, "dec_b"); commitAndPushHunch(bh, "B: dec_b", { push: true, protectedRepoRoot: join(B, "..") }); // B pulls dec_a (clean merge), pushes BOTH
    pullHunch(ah);                                            // A pulls dec_b
    assert.deepEqual(decFiles(ah), ["dec_a.json", "dec_b.json"], "machine A converged to both records");
    assert.deepEqual(decFiles(bh), ["dec_a.json", "dec_b.json"], "machine B converged to both records");
  } finally {
    cleanup();
  }
});

test("two-way sync: push can't be rejected non-fast-forward — B's write survives A's prior push", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    // A pushes first; B (now behind) writes and flushes — the OLD bug was B's push rejected → B's
    // record stranded. With pull-before-push, B merges A's then pushes, so nothing is stranded.
    writeDec(A, "dec_a"); commitAndPushHunch(ah, "A: dec_a", { push: true, protectedRepoRoot: join(A, "..") });
    writeDec(B, "dec_b"); commitAndPushHunch(bh, "B: dec_b", { push: true, protectedRepoRoot: join(B, "..") });
    pullHunch(ah);
    assert.ok(decFiles(ah).includes("dec_b.json"), "B's record reached the remote and back to A");
    // and B is NOT left ahead/unpushed
    const sb = execFileSync("git", ["-C", bh, "status", "-sb"], { encoding: "utf8" });
    assert.ok(!/ahead/.test(sb), "B fully pushed — nothing stranded");
  } finally {
    cleanup();
  }
});

test("two-way sync: one bounded retry closes a remote advance between B's pull and push", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    // Prepare A's commit locally, then use a test-only receive-pack wrapper to publish
    // it in the exact seam after B has pulled but before B's first push reaches the
    // remote. Automatic Hunch pushes deliberately disable repository pre-push hooks,
    // so the race belongs at the transport fixture rather than a user hook.
    writeDec(A, "dec_a");
    g(A, "add", ".hunch/decisions/dec_a.json");
    g(A, "commit", "-q", "-m", "A: race dec_a");
    const marker = join(B, "race-receive-pack-fired");
    const invocations = join(B, "race-receive-pack-invocations");
    const receivePack = join(B, "race-receive-pack");
    writeFileSync(receivePack, [
      "#!/bin/sh",
      `echo x >> '${invocations}'`,
      `if [ ! -f '${marker}' ]; then`,
      `  : > '${marker}'`,
      `  git -C '${A}' push -q origin main`,
      "fi",
      "exec git-receive-pack \"$1\"",
      "",
    ].join("\n"));
    chmodSync(receivePack, 0o755);
    g(B, "config", "remote.origin.receivepack", receivePack);

    writeDec(B, "dec_b");
    const result = commitAndPushHunch(bh, "B: race dec_b", { push: true, protectedRepoRoot: join(B, "..") });
    assert.equal(result, "pushed", "B must merge the newly advanced upstream and retry exactly once");
    pullHunch(ah);
    assert.deepEqual(decFiles(ah), ["dec_a.json", "dec_b.json"]);
    assert.deepEqual(decFiles(bh), ["dec_a.json", "dec_b.json"]);
    const sb = execFileSync("git", ["-C", bh, "status", "-sb"], { encoding: "utf8" });
    assert.doesNotMatch(sb, /ahead|behind/, "the bounded retry leaves B fully converged");
    assert.equal(readFileSync(invocations, "utf8").trim().split("\n").length, 2,
      "the first rejected push gets exactly one retry");
  } finally {
    cleanup();
  }
});

test("two-way sync: an unchanged-upstream transport rejection is not retried", () => {
  const { B, cleanup } = setup();
  try {
    const bh = join(B, ".hunch");
    const invocations = join(B, "reject-receive-pack-invocations");
    const receivePack = join(B, "reject-receive-pack");
    writeFileSync(receivePack, ["#!/bin/sh", `echo x >> '${invocations}'`, "exit 1", ""].join("\n"));
    chmodSync(receivePack, 0o755);
    g(B, "config", "remote.origin.receivepack", receivePack);
    writeDec(B, "dec_rejected");
    const result = commitAndPushHunch(bh, "B: rejected", { push: true, protectedRepoRoot: join(B, "..") });
    assert.equal(result, "committed");
    assert.equal(readFileSync(invocations, "utf8").trim().split("\n").length, 1,
      "a policy/auth rejection with no upstream movement must not loop");
  } finally {
    cleanup();
  }
});

test("explicit sync publishes a clean overlay commit stranded by an earlier failure", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    writeDec(B, "dec_stranded");
    g(B, "add", ".hunch/decisions/dec_stranded.json");
    g(B, "commit", "-q", "-m", "B: locally committed while offline");
    assert.equal(syncExistingHunch(bh, join(B, "..")), "pushed");
    pullHunch(ah);
    assert.ok(decFiles(ah).includes("dec_stranded.json"));
    assert.doesNotMatch(execFileSync("git", ["-C", B, "status", "-sb"], { encoding: "utf8" }), /ahead|behind/);
  } finally {
    cleanup();
  }
});

test("first capture establishes an upstream and publishes to a truly empty shared remote", () => {
  const { overlay, hunchDir, protectedRoot, remote, cleanup } = setupEmptyRemote();
  try {
    writeDec(overlay, "dec_first", '{"id":"dec_first"}');
    assert.equal(
      commitAndPushHunch(hunchDir, "first shared capture", { push: true, protectedRepoRoot: protectedRoot }),
      "pushed",
    );
    assert.equal(
      execFileSync("git", ["--git-dir", remote, "show", "main:.hunch/decisions/dec_first.json"], { encoding: "utf8" }),
      '{"id":"dec_first"}\n',
    );
    assert.equal(
      execFileSync("git", ["-C", overlay, "rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8" }).trim(),
      "origin/main",
    );
  } finally {
    cleanup();
  }
});

test("explicit retry establishes an upstream and publishes stranded history to a truly empty shared remote", () => {
  const { overlay, hunchDir, protectedRoot, remote, cleanup } = setupEmptyRemote();
  try {
    writeDec(overlay, "dec_stranded_first", '{"id":"dec_stranded_first"}');
    g(overlay, "add", ".hunch/decisions/dec_stranded_first.json");
    g(overlay, "commit", "-q", "-m", "first capture committed while remote unavailable");
    assert.equal(syncExistingHunch(hunchDir, protectedRoot), "pushed");
    assert.equal(
      execFileSync("git", ["--git-dir", remote, "show", "main:.hunch/decisions/dec_stranded_first.json"], { encoding: "utf8" }),
      '{"id":"dec_stranded_first"}\n',
    );
    assert.equal(
      execFileSync("git", ["-C", overlay, "rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8" }).trim(),
      "origin/main",
    );
  } finally {
    cleanup();
  }
});

test("upstream establishment fails closed when the shared remote already has an unrelated ref", () => {
  const { overlay, hunchDir, protectedRoot, remote, cleanup } = setupEmptyRemote();
  try {
    const foreign = join(overlay, "..", "foreign");
    mkdirSync(foreign, { recursive: true });
    g(foreign, "init", "-b", "existing", ".");
    cfg(foreign);
    writeFileSync(join(foreign, "foreign.txt"), "foreign history\n");
    g(foreign, "add", "foreign.txt");
    g(foreign, "commit", "-q", "-m", "foreign seed");
    g(foreign, "remote", "add", "origin", remote);
    g(foreign, "push", "-q", "origin", "HEAD:refs/heads/existing");

    writeDec(overlay, "dec_must_not_publish", '{"id":"dec_must_not_publish"}');
    g(overlay, "add", ".hunch/decisions/dec_must_not_publish.json");
    g(overlay, "commit", "-q", "-m", "local history without an upstream");
    assert.equal(syncExistingHunch(hunchDir, protectedRoot), "failed");
    assert.throws(() => execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"], {
      stdio: "ignore",
    }), "guarded establishment must not add a branch to a non-empty remote");
    assert.match(execFileSync("git", ["--git-dir", remote, "show", "existing:foreign.txt"], { encoding: "utf8" }),
      /foreign history/);
  } finally {
    cleanup();
  }
});

test("read-side sync refuses dirty memory without invoking the structured merge driver or changing bytes", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    const id = "dec_dirty_local";
    const record = (context: string, confidence: number): string => JSON.stringify({
      id,
      context,
      provenance: { source: "llm_draft", confidence, evidence: [] },
    }, null, 2);

    writeDec(A, id, record("shared base", 0.5));
    assert.equal(commitAndPushHunch(ah, "seed dirty-read probe", {
      push: true,
      protectedRepoRoot: join(A, ".."),
    }), "pushed");
    assert.equal(pullHunchStatus(bh), "updated");

    // Wire the real Hunch structured merge driver into B. The old read path's
    // --autostash applied the lower-confidence dirty bytes through this driver
    // after pulling the higher-confidence remote version, silently losing them.
    const marker = join(B, "merge-driver-invoked");
    const wrapper = join(B, "hunch-merge-driver");
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const cli = join(process.cwd(), "src", "cli", "index.ts");
    writeFileSync(wrapper, [
      "#!/bin/sh",
      `printf x >> "${marker}"`,
      `exec "${tsx}" "${cli}" merge-driver "$@"`,
      "",
    ].join("\n"));
    chmodSync(wrapper, 0o755);
    mkdirSync(join(B, ".git", "info"), { recursive: true });
    writeFileSync(join(B, ".git", "info", "attributes"), ".hunch/**/*.json merge=hunch\n");
    g(B, "config", "merge.hunch.name", "hunch structured JSON merge");
    g(B, "config", "merge.hunch.driver", `${wrapper} "%O" "%A" "%B" "%P"`);
    assert.match(execFileSync("git", ["-C", B, "check-attr", "merge", "--", `.hunch/decisions/${id}.json`], {
      encoding: "utf8",
    }), /merge: hunch/);

    writeDec(B, id, record("lower-confidence local bytes must survive", 0.1));
    const localPath = join(bh, "decisions", `${id}.json`);
    const localBytes = readFileSync(localPath, "utf8");
    const localHead = execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    writeDec(A, id, record("higher-confidence remote bytes", 0.9));
    assert.equal(commitAndPushHunch(ah, "advance dirty-read probe", {
      push: true,
      protectedRepoRoot: join(A, ".."),
    }), "pushed");

    assert.equal(pullHunchStatus(bh), "failed", "dirty .hunch must make a request-time pull fail closed");
    assert.equal(readFileSync(localPath, "utf8"), localBytes, "the local bytes remain exact");
    assert.equal(execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), localHead,
      "a refused read pull does not advance HEAD");
    assert.equal(existsSync(marker), false, "refusal happens before the structured merge driver can choose a winner");
    assert.equal(existsSync(join(B, ".git", "MERGE_HEAD")), false);
    assert.match(execFileSync("git", ["-C", B, "status", "--porcelain", "--", `.hunch/decisions/${id}.json`], {
      encoding: "utf8",
    }), /^ M /, "the caller's dirty memory remains visibly uncommitted");
  } finally {
    cleanup();
  }
});

test("read-side sync rejects a later unsafe remote tree and preserves the prior checked-out bytes", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    const id = "dec_shape_change";
    writeDec(A, id, JSON.stringify({ id, decision: "safe prior state" }));
    assert.equal(commitAndPushHunch(ah, "seed safe shape", {
      push: true,
      protectedRepoRoot: join(A, ".."),
    }), "pushed");
    assert.equal(pullHunchStatus(bh), "updated");

    const localPath = join(bh, "decisions", `${id}.json`);
    const priorBytes = readFileSync(localPath, "utf8");
    const priorHead = execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(lstatSync(localPath).isFile(), true);
    assert.equal(lstatSync(localPath).isSymbolicLink(), false);

    const outside = join(A, "..", "outside-memory.json");
    writeFileSync(outside, "outside must remain untouched\n");
    rmSync(join(ah, "decisions", `${id}.json`));
    symlinkSync(outside, join(ah, "decisions", `${id}.json`));
    g(A, "add", "-A");
    g(A, "commit", "-q", "-m", "remote changes a record into a symlink");
    g(A, "push", "-q", "origin", "main");

    assert.equal(pullHunchStatus(bh), "failed", "an unsafe fetched tree must never reach the live checkout");
    assert.equal(execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), priorHead);
    assert.equal(lstatSync(localPath).isFile(), true, "the prior ordinary file remains checked out");
    assert.equal(lstatSync(localPath).isSymbolicLink(), false);
    assert.equal(readFileSync(localPath, "utf8"), priorBytes, "the prior record bytes remain exact");
    assert.equal(readFileSync(outside, "utf8"), "outside must remain untouched\n");
    assert.equal(existsSync(join(B, ".git", "MERGE_HEAD")), false);
  } finally {
    cleanup();
  }
});

test("read-side sync suppresses an ambient global attributes file before materializing JSON", () => {
  const { A, B, cleanup } = setup();
  try {
    const marker = join(B, "ambient-smudge-ran");
    const filter = join(B, "ambient-smudge");
    const attrs = join(B, "ambient-attributes");
    const globalConfig = join(B, "ambient-gitconfig");
    writeFileSync(filter, ["#!/bin/sh", `printf x >> '${marker}'`, "cat", ""].join("\n"));
    chmodSync(filter, 0o755);
    writeFileSync(attrs, "*.json filter=pwn\n");
    g(B, "config", "--file", globalConfig, "core.attributesFile", attrs);
    g(B, "config", "--file", globalConfig, "filter.pwn.smudge", filter);
    g(B, "config", "--file", globalConfig, "filter.pwn.clean", "cat");
    g(B, "config", "--file", globalConfig, "filter.pwn.required", "true");

    writeDec(A, "dec_global_attr", '{"id":"dec_global_attr"}');
    assert.equal(commitAndPushHunch(join(A, ".hunch"), "advance under hostile ambient attrs", {
      push: true,
      protectedRepoRoot: join(A, ".."),
    }), "pushed");

    assert.equal(pullHunchStatus(join(B, ".hunch"), {
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    }), "updated");
    assert.equal(existsSync(join(B, ".hunch/decisions/dec_global_attr.json")), true);
    assert.equal(existsSync(marker), false, "global core.attributesFile never selects the smudge command");
  } finally {
    cleanup();
  }
});

test("read-side sync rejects unsafe info/attributes before fetch can materialize bytes", () => {
  const { A, B, cleanup } = setup();
  try {
    const marker = join(B, "info-smudge-ran");
    const filter = join(B, "info-smudge");
    writeFileSync(filter, ["#!/bin/sh", `printf x >> '${marker}'`, "cat", ""].join("\n"));
    chmodSync(filter, 0o755);
    g(B, "config", "filter.pwn.smudge", filter);
    g(B, "config", "filter.pwn.clean", "cat");
    g(B, "config", "filter.pwn.required", "true");
    mkdirSync(join(B, ".git", "info"), { recursive: true });
    const infoAttributes = join(B, ".git/info/attributes");
    writeFileSync(infoAttributes, "*.json filter=pwn\n");

    writeDec(A, "dec_info_attr", '{"id":"dec_info_attr"}');
    assert.equal(commitAndPushHunch(join(A, ".hunch"), "advance for info attrs", {
      push: true,
      protectedRepoRoot: join(A, ".."),
    }), "pushed");
    const priorHead = execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    assert.equal(pullHunchStatus(join(B, ".hunch")), "failed");
    assert.equal(execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), priorHead);
    assert.equal(existsSync(join(B, ".hunch/decisions/dec_info_attr.json")), false);
    assert.equal(existsSync(marker), false);

    rmSync(infoAttributes);
    assert.equal(pullHunchStatus(join(B, ".hunch")), "updated", "removing the unsafe local source restores sync");
    assert.equal(existsSync(join(B, ".hunch/decisions/dec_info_attr.json")), true);
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup();
  }
});

test("read-side sync rejects a later remote .gitattributes command selector before checkout", () => {
  const { A, B, cleanup } = setup();
  try {
    const marker = join(B, "remote-smudge-ran");
    const filter = join(B, "remote-smudge");
    writeFileSync(filter, ["#!/bin/sh", `printf x >> '${marker}'`, "cat", ""].join("\n"));
    chmodSync(filter, 0o755);
    g(B, "config", "filter.pwn.smudge", filter);
    g(B, "config", "filter.pwn.clean", "cat");
    g(B, "config", "filter.pwn.required", "true");
    const priorHead = execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    writeFileSync(join(A, ".gitattributes"), "*.json filter=pwn\n");
    writeDec(A, "dec_remote_attr", '{"id":"dec_remote_attr"}');
    g(A, "add", "-A");
    g(A, "commit", "-q", "-m", "hostile remote attributes");
    g(A, "push", "-q", "origin", "main");

    assert.equal(pullHunchStatus(join(B, ".hunch")), "failed");
    assert.equal(execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), priorHead);
    assert.equal(existsSync(join(B, ".gitattributes")), false);
    assert.equal(existsSync(join(B, ".hunch/decisions/dec_remote_attr.json")), false);
    assert.equal(existsSync(marker), false, "the remote selector and its target never reach the worktree");
  } finally {
    cleanup();
  }
});

test("read-side sync rejects a remote-controlled lock hook path without executing it", () => {
  const { A, B, cleanup } = setup();
  try {
    const marker = join(B, "tracked-post-merge-ran");
    const hook = join(A, ".hunch/.hunch-commit.lock/disabled-hooks/post-merge");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, ["#!/bin/sh", `printf x >> '${marker}'`, ""].join("\n"));
    chmodSync(hook, 0o755);
    writeDec(A, "dec_tracked_hook", '{"id":"dec_tracked_hook"}');
    g(A, "add", "-f", ".hunch/.hunch-commit.lock/disabled-hooks/post-merge", ".hunch/decisions/dec_tracked_hook.json");
    g(A, "commit", "-q", "-m", "hostile tracked sync hook");
    g(A, "push", "-q", "origin", "main");
    const priorHead = execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    assert.equal(pullHunchStatus(join(B, ".hunch")), "failed");
    assert.equal(execFileSync("git", ["-C", B, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), priorHead);
    assert.equal(existsSync(join(B, ".hunch/decisions/dec_tracked_hook.json")), false);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(B, ".hunch/.hunch-commit.lock")), false, "the local serialization lock is released");
  } finally {
    cleanup();
  }
});

test("shared publication force-stages exact JSON despite hostile ignore sources", () => {
  const { A, B, cleanup } = setup();
  try {
    writeFileSync(join(A, ".gitignore"), ".hunch/**/*.json\n");
    g(A, "add", ".gitignore");
    g(A, "commit", "-q", "-m", "remote ignores graph JSON");
    g(A, "push", "-q", "origin", "main");
    assert.equal(pullHunchStatus(join(B, ".hunch")), "updated");

    mkdirSync(join(B, ".git", "info"), { recursive: true });
    writeFileSync(join(B, ".git/info/exclude"), ".hunch/decisions/*.json\n");
    const excludes = join(B, "ambient-excludes");
    writeFileSync(excludes, "*.json\n");
    g(B, "config", "core.excludesFile", excludes);
    writeDec(B, "dec_ignored_everywhere", '{"id":"dec_ignored_everywhere"}');
    assert.doesNotThrow(() => execFileSync("git", ["-C", B, "check-ignore", "-q", ".hunch/decisions/dec_ignored_everywhere.json"]));

    assert.equal(commitAndPushHunch(join(B, ".hunch"), "pump ignored shared record", {
      push: true,
      protectedRepoRoot: join(B, ".."),
    }), "pushed");
    assert.equal(pullHunchStatus(join(A, ".hunch")), "updated");
    assert.equal(readFileSync(join(A, ".hunch/decisions/dec_ignored_everywhere.json"), "utf8"),
      '{"id":"dec_ignored_everywhere"}\n');
  } finally {
    cleanup();
  }
});

test("read-side sync times out a slow remote and releases its lock cleanly", () => {
  const { B, cleanup } = setup();
  try {
    const bh = join(B, ".hunch");
    const fakeSsh = join(B, "slow-ssh");
    writeFileSync(fakeSsh, ["#!/bin/sh", "sleep 2", "exit 1", ""].join("\n"));
    chmodSync(fakeSsh, 0o755);
    g(B, "remote", "set-url", "origin", "ssh://matrix.invalid/repo");
    const started = Date.now();
    const status = pullHunchStatus(bh, {
      timeoutMs: 100,
      env: { ...process.env, GIT_SSH_COMMAND: fakeSsh },
    });
    const elapsed = Date.now() - started;
    assert.equal(status, "failed");
    assert.ok(elapsed < 1_500, `slow remote should be bounded, took ${elapsed}ms`);
    assert.equal(existsSync(join(bh, ".hunch-commit.lock")), false);
    assert.equal(existsSync(join(B, ".git", "MERGE_HEAD")), false);
  } finally {
    cleanup();
  }
});

test("two-way sync: a same-file conflict aborts to a CLEAN tree (no corruption); local record is kept to retry", () => {
  const { A, B, cleanup } = setup();
  try {
    const ah = join(A, ".hunch"), bh = join(B, ".hunch");
    writeDec(A, "dec_x", '{"v":"A"}'); commitAndPushHunch(ah, "A: dec_x", { push: true, protectedRepoRoot: join(A, "..") }); // A pushes dec_x = A
    writeDec(B, "dec_x", '{"v":"B"}'); commitAndPushHunch(bh, "B: dec_x", { push: true, protectedRepoRoot: join(B, "..") }); // B: add/add conflict on dec_x → abort, skip push
    const status = execFileSync("git", ["-C", bh, "status", "--porcelain"], { encoding: "utf8" }).trim();
    assert.equal(status, "", "B's tree is clean after the aborted merge (no conflict markers left)");
    assert.ok(!existsSync(join(B, ".git", "MERGE_HEAD")), "no merge left in progress");
    assert.ok(existsSync(join(bh, "decisions", "dec_x.json")), "B keeps its local record (not lost — retries next write)");
  } finally {
    cleanup();
  }
});
