import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tsxLoaderUrl } from "./helpers.js";
import {
  ensureGitignore,
  ignoreHunchMemory,
  upgradeManagedGitignore,
  describeGitignoreUpgrade,
  HUNCH_MEMORY_DIRS,
} from "../src/integrations/gitignore.js";
import { ENTITY_KINDS } from "../src/core/types.js";

function inTmp(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "hunch-gi-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const read = (root: string) => readFileSync(join(root, ".gitignore"), "utf8");

/** The release gate's soak lane compares each clone's .gitignore BYTE-EXACTLY against
 *  its own copy of the managed block (tooling/matrix-release-verification.mjs,
 *  OVERLAY_IGNORE). Adding an entry on one side only doesn't fail any unit test — it
 *  fails the release gate, in CI, with "Matrix release verification failed" and a
 *  content hash that points at nothing. Shipped exactly that by adding
 *  .hunch/events.log to ENTRIES alone. This guard makes the drift local and obvious. */
test("the release gate's OVERLAY_IGNORE mirrors the managed block byte-for-byte", async () => {
  const { OVERLAY_IGNORE } = await import("../tooling/matrix-release-verification.mjs");
  inTmp((root) => {
    ensureGitignore(root);
    assert.equal(
      read(root),
      OVERLAY_IGNORE,
      "tooling/matrix-release-verification.mjs OVERLAY_IGNORE drifted from ENTRIES in src/integrations/gitignore.ts — update BOTH",
    );
  });
});

test("ensureGitignore ignores the local-only pending-commit-repairs queue", () => {
  inTmp((root) => {
    ensureGitignore(root);
    assert.match(read(root), /\.hunch\/pending-commit-repairs\.json/);
  });
});

test("ensureGitignore ignores the local-only dropped-commit-repairs tombstone file", () => {
  inTmp((root) => {
    ensureGitignore(root);
    assert.match(read(root), /\.hunch\/dropped-commit-repairs\.json/);
  });
});

test("ensureGitignore creates a managed block when no .gitignore exists", () => {
  inTmp((root) => {
    assert.equal(ensureGitignore(root).action, "created");
    assert.match(read(root), /# >>> hunch/);
  });
});

test("ensureGitignore is idempotent when its own managed block is present", () => {
  inTmp((root) => {
    ensureGitignore(root);
    assert.equal(ensureGitignore(root).action, "unchanged");
    assert.equal((read(root).match(/# >>> hunch/g) ?? []).length, 1, "never a second managed block");
  });
});

test("ensureGitignore adds NO redundant block when the user already lists every entry", () => {
  inTmp((root) => {
    writeFileSync(
      join(root, ".gitignore"),
      ["node_modules/", "# Hunch derived index", ".hunch/*.sqlite", ".hunch/*.sqlite-shm", ".hunch/*.sqlite-wal", ".hunch/*.sqlite-journal", ".hunch/**/*.tmp*", ".hunch-cache/", ".hunch/local.json", ".hunch/events.log", ".hunch/pending-commit-repairs.json", ".hunch/dropped-commit-repairs.json", ".hunch-private/", ""].join("\n"),
    );
    assert.equal(ensureGitignore(root).action, "unchanged", "all entries present → no-op");
    assert.doesNotMatch(read(root), /# >>> hunch/, "no duplicate managed block");
  });
});

test("ensureGitignore appends when at least one entry is missing", () => {
  inTmp((root) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.hunch/*.sqlite\n"); // only 1 of 5
    assert.equal(ensureGitignore(root).action, "appended");
    assert.match(read(root), /# >>> hunch/);
  });
});

// ---- managed blocks written by an older release are upgraded in place (#312) ----

const BASE_MARK = "# >>> hunch (derived runtime index — regenerable from .hunch/*.json) >>>";
const BASE_END = "# <<< hunch <<<";
const MEM_MARK = "# >>> hunch private-only (engineering memory kept in a private overlay; not published here) >>>";
const MEM_END = "# <<< hunch private-only <<<";

/** The base block as an early release wrote it: no local.json, cache, events log or repair queues. */
const OLD_BASE_BLOCK = [BASE_MARK, ".hunch/*.sqlite", ".hunch/*.sqlite-shm", ".hunch/*.sqlite-wal", ".hunch/*.sqlite-journal", ".hunch/**/*.tmp*", ".hunch-private/", BASE_END];
/** The private-only block before tasks/ and the state kinds existed. */
const OLD_MEM_BLOCK = [MEM_MARK, ".hunch/decisions/", ".hunch/bugs/", ".hunch/constraints/", ".hunch/components/", ".hunch/symbols/", ".hunch/edges/", ".hunch/runbooks/", ".hunch/findings/", MEM_END];

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

function inRepo(fn: (root: string) => void) {
  inTmp((root) => {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    git(root, "config", "core.autocrlf", "false");
    fn(root);
  });
}

test("an old base block gains later entries in place; user lines outside the markers are untouched", () => {
  inTmp((root) => {
    const before = ["node_modules/", "# my own section", "dist/", ...OLD_BASE_BLOCK, "", "# trailing user rule", "*.log", ""].join("\n");
    writeFileSync(join(root, ".gitignore"), before);
    const result = ensureGitignore(root);
    assert.equal(result.action, "updated");
    assert.ok(result.added.includes(".hunch/local.json"));
    assert.ok(result.added.includes(".hunch-cache/"));
    assert.ok(!result.added.includes(".hunch/*.sqlite"), "entries already present are not reported as added");
    const after = read(root);
    assert.ok(after.startsWith("node_modules/\n# my own section\ndist/\n"), "content above the block is byte-identical");
    assert.ok(after.endsWith(`${BASE_END}\n\n# trailing user rule\n*.log\n`), "content below the block is byte-identical");
    for (const line of [".hunch/local.json", ".hunch-cache/", ".hunch/events.log", ".hunch/pending-commit-repairs.json", ".hunch/dropped-commit-repairs.json"]) {
      assert.ok(after.split("\n").includes(line), `${line} is now ignored`);
    }
    assert.equal((after.match(/# >>> hunch \(/g) ?? []).length, 1, "still exactly one managed block");

    // The upgraded block is exactly what a fresh install writes.
    inTmp((fresh) => {
      ensureGitignore(fresh);
      assert.ok(after.includes(read(fresh)), "upgraded block equals a freshly written block");
    });

    assert.equal(ensureGitignore(root).action, "unchanged");
    assert.equal(read(root), after, "a second run is byte-identical");
  });
});

test("a CRLF .gitignore keeps CRLF line endings when its managed block is upgraded", () => {
  inTmp((root) => {
    const before = ["node_modules/", ...OLD_BASE_BLOCK, "*.log", ""].join("\r\n");
    writeFileSync(join(root, ".gitignore"), before);
    assert.equal(ensureGitignore(root).action, "updated");
    const after = read(root);
    assert.doesNotMatch(after.replace(/\r\n/g, ""), /\n/, "no bare LF was introduced");
    assert.ok(after.startsWith("node_modules/\r\n") && after.endsWith(`${BASE_END}\r\n*.log\r\n`));
    assert.match(after, /\r\n\.hunch\/local\.json\r\n/);
    assert.equal(ensureGitignore(root).action, "unchanged");
    assert.equal(read(root), after, "idempotent on CRLF too");
  });
});

test("a CRLF .gitignore without a managed block gets a CRLF block appended", () => {
  inTmp((root) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\r\n");
    assert.equal(ensureGitignore(root).action, "appended");
    assert.doesNotMatch(read(root).replace(/\r\n/g, ""), /\n/);
  });
});

test("ensureGitignore({ upgradeExisting: false }) leaves an existing old block byte-identical", () => {
  inTmp((root) => {
    const before = ["node_modules/", ...OLD_BASE_BLOCK, ""].join("\n");
    writeFileSync(join(root, ".gitignore"), before);
    assert.equal(ensureGitignore(root, { upgradeExisting: false }).action, "unchanged");
    assert.equal(read(root), before);
  });
});

test("a managed block whose end marker was removed is left alone (never guessed at)", () => {
  inTmp((root) => {
    const before = ["node_modules/", ...OLD_BASE_BLOCK.slice(0, -1), "*.log", ""].join("\n");
    writeFileSync(join(root, ".gitignore"), before);
    assert.equal(ensureGitignore(root).action, "unchanged");
    assert.equal(read(root), before);
  });
});

test("every ENTITY_KINDS directory is covered by the private-only memory block", () => {
  const dirs = new Set(HUNCH_MEMORY_DIRS);
  const missing = ENTITY_KINDS.filter((kind) => !dirs.has(`.hunch/${kind}`));
  assert.deepEqual(missing, [], "add these kinds to MEM_ENTRIES in src/integrations/gitignore.ts");
  for (const dir of ["evidence", "corpora", "policies", "proofs", "plans", "dispositions", "shadow", "changes"]) {
    assert.ok(dirs.has(`.hunch/${dir}`), `non-entity memory dir .hunch/${dir} stays covered`);
  }
});

test("an old private-only block is upgraded and its newly ignored tracked memory is untracked, not deleted", () => {
  inRepo((root) => {
    writeFileSync(join(root, ".gitignore"), ["node_modules/", ...OLD_BASE_BLOCK, "", ...OLD_MEM_BLOCK, ""].join("\n"));
    mkdirSync(join(root, ".hunch", "tasks"), { recursive: true });
    mkdirSync(join(root, ".hunch", "receipts"), { recursive: true });
    writeFileSync(join(root, ".hunch", "tasks", "x.json"), "{}\n");
    writeFileSync(join(root, ".hunch", "receipts", "r.json"), "{}\n");
    writeFileSync(join(root, ".hunch", "manifest.json"), "{\"schema_version\":2}\n");
    writeFileSync(join(root, "src.ts"), "export {};\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "seed");

    const upgrade = upgradeManagedGitignore(root);
    assert.equal(upgrade.base?.action, "updated");
    assert.equal(upgrade.memory?.action, "updated");
    assert.ok(upgrade.memory!.added.includes(".hunch/tasks/"));
    assert.ok(upgrade.memory!.added.includes(".hunch/workspaces/"));
    assert.deepEqual([...upgrade.untracked].sort(), [".hunch/receipts/r.json", ".hunch/tasks/x.json"]);

    const tracked = git(root, "ls-files").split("\n").filter(Boolean).sort();
    assert.deepEqual(tracked, [".gitignore", ".hunch/manifest.json", "src.ts"], "code + manifest stay tracked; newly ignored memory is untracked");
    assert.ok(existsSync(join(root, ".hunch", "tasks", "x.json")), "files are kept on disk");
    assert.equal(git(root, "status", "--porcelain", "--untracked-files=all", "--", ".hunch/tasks").trim(), "D  .hunch/tasks/x.json", "the removal is staged and the file is now ignored");

    const lines = describeGitignoreUpgrade(upgrade);
    assert.ok(lines.some((l) => l.includes("private-only memory block updated") && l.includes(".hunch/tasks/")));
    assert.ok(lines.some((l) => l.includes("removed 2 newly ignored memory file(s)")));

    const text = read(root);
    const second = upgradeManagedGitignore(root);
    assert.equal(second.base?.action, "unchanged");
    assert.equal(second.memory?.action, "unchanged");
    assert.deepEqual(second.untracked, []);
    assert.deepEqual(describeGitignoreUpgrade(second), []);
    assert.equal(read(root), text, "second run is byte-identical");
  });
});

test("upgradeManagedGitignore never adds a block the repository did not have", () => {
  inRepo((root) => {
    writeFileSync(join(root, ".gitignore"), ["node_modules/", ...OLD_BASE_BLOCK, ""].join("\n"));
    mkdirSync(join(root, ".hunch", "tasks"), { recursive: true });
    writeFileSync(join(root, ".hunch", "tasks", "x.json"), "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "seed");
    const upgrade = upgradeManagedGitignore(root);
    assert.equal(upgrade.memory, null, "no private-only block → public memory stays published");
    assert.doesNotMatch(read(root), /private-only/);
    assert.match(git(root, "ls-files"), /\.hunch\/tasks\/x\.json/);
  });
  inTmp((bare) => {
    assert.deepEqual(upgradeManagedGitignore(bare), { base: null, memory: null, untracked: [] }, "no .gitignore → nothing created");
    assert.equal(existsSync(join(bare, ".gitignore")), false);
  });
});

test("ignoreHunchMemory upgrades an old private-only block in place", () => {
  inTmp((root) => {
    writeFileSync(join(root, ".gitignore"), ["node_modules/", ...OLD_MEM_BLOCK, ""].join("\n"));
    const result = ignoreHunchMemory(root);
    assert.equal(result.action, "updated");
    const text = read(root);
    for (const dir of HUNCH_MEMORY_DIRS) assert.ok(text.split("\n").includes(`${dir}/`), `${dir}/ is ignored`);
    assert.equal(ignoreHunchMemory(root).action, "unchanged");
    assert.equal(read(root), text);
  });
});

test("`hunch integrations repair-pins` (run by `hunch update`) upgrades managed blocks and reports it", () => {
  inRepo((root) => {
    writeFileSync(join(root, ".gitignore"), ["node_modules/", ...OLD_BASE_BLOCK, ...OLD_MEM_BLOCK, ""].join("\n"));
    mkdirSync(join(root, ".hunch", "tasks"), { recursive: true });
    writeFileSync(join(root, ".hunch", "tasks", "x.json"), "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "seed");
    const cli = resolve("src/cli/index.ts");
    const run = () => spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "integrations", "repair-pins"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    const result = run();
    assert.match(result.stdout, /Hunch runtime block updated \(added [^)]*\.hunch\/local\.json/, result.stderr);
    assert.match(result.stdout, /private-only memory block updated \(added [^)]*\.hunch\/tasks\//);
    assert.match(result.stdout, /removed 1 newly ignored memory file\(s\) from the git index, kept on disk/);
    assert.doesNotMatch(git(root, "ls-files"), /\.hunch\/tasks/);
    assert.ok(existsSync(join(root, ".hunch", "tasks", "x.json")));
    assert.doesNotMatch(run().stdout, /\.gitignore/, "nothing to report on the second run");
  });
});

test("re-running `hunch private <dir>` on a repo migrated by an older release upgrades its private-only block", () => {
  inRepo((root) => {
    inTmp((overlayParent) => {
      writeFileSync(join(root, ".gitignore"), ["node_modules/", ...OLD_BASE_BLOCK, ...OLD_MEM_BLOCK, ""].join("\n"));
      mkdirSync(join(root, ".hunch", "tasks"), { recursive: true });
      writeFileSync(join(root, ".hunch", "tasks", "x.json"), "{}\n");
      writeFileSync(join(root, "app.ts"), "export {};\n");
      git(root, "add", "-A");
      git(root, "commit", "-qm", "seed");
      const cli = resolve("src/cli/index.ts");
      const result = spawnSync(process.execPath, ["--import", tsxLoaderUrl(), cli, "private", join(overlayParent, ".hunch"), "--no-hook", "--no-auto-commit"], {
        cwd: root,
        env: { ...process.env, HUNCH_PRIVATE_DIR: "" },
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /private-only memory block updated/);
      assert.match(result.stdout, /removed 1 newly ignored memory file\(s\)/);
      assert.ok(read(root).split("\n").includes(".hunch/tasks/"));
      assert.doesNotMatch(git(root, "ls-files"), /\.hunch\/tasks/);
      assert.ok(existsSync(join(root, ".hunch", "tasks", "x.json")), "kept on disk");
      assert.match(git(root, "ls-files"), /app\.ts/, "code stays tracked");
    });
  });
});
