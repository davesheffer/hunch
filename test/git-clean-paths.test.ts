import { cleanupDir } from "./fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitCleanPaths, isGitCleanPath } from "../src/extractors/git.js";

const g = (cwd: string, ...a: string[]): void => { execFileSync("git", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); };

test("gitCleanPaths answers isGitCleanPath for every path in one status, from the toplevel or a subdirectory", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-gcp-"));
  try {
    g(root, "init", "-q");
    g(root, "config", "user.email", "t@example.com");
    g(root, "config", "user.name", "T");
    g(root, "config", "core.autocrlf", "false");
    const pkg = join(root, "pkg");
    mkdirSync(join(pkg, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(pkg, ".github"), { recursive: true });
    for (const f of ["CLAUDE.md", "AGENTS.md", "OLD.md", join(".cursor", "rules", "hunch.mdc"), join(".github", "copilot-instructions.md")]) {
      writeFileSync(join(pkg, f), "x\n");
    }
    writeFileSync(join(root, "CLAUDE.md"), "x\n");
    writeFileSync(join(root, "AGENTS.md"), "x\n");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "init");
    writeFileSync(join(pkg, "AGENTS.md"), "changed\n");                   // unstaged
    writeFileSync(join(pkg, ".cursor", "rules", "hunch.mdc"), "staged\n");
    g(root, "add", "pkg/.cursor/rules/hunch.mdc");                       // staged
    g(root, "mv", "pkg/OLD.md", "pkg/NEW.md");                            // staged rename
    writeFileSync(join(pkg, "UNTRACKED.md"), "u\n");                     // untracked
    writeFileSync(join(root, "AGENTS.md"), "top changed\n");             // same name, other dir
    const rels = ["CLAUDE.md", "AGENTS.md", "OLD.md", "NEW.md", "UNTRACKED.md", "MISSING.md",
      join(".cursor", "rules", "hunch.mdc"), join(".github", "copilot-instructions.md")];
    for (const cwd of [pkg, root]) {
      const batch = gitCleanPaths(cwd, rels);
      for (const rel of rels) assert.equal(batch.has(rel), isGitCleanPath(cwd, rel), `${cwd} ${rel}`);
    }
    assert.deepEqual([...gitCleanPaths(pkg, rels)].sort(), ["CLAUDE.md", "MISSING.md", join(".github", "copilot-instructions.md")].sort());
  } finally { cleanupDir(root); }
});

test("gitCleanPaths outside a repository reports nothing clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-gcp-none-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "x\n");
    for (const rel of ["CLAUDE.md"]) assert.equal(gitCleanPaths(dir, [rel]).has(rel), isGitCleanPath(dir, rel));
  } finally { cleanupDir(dir); }
});
