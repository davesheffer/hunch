import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hunchPaths } from "../src/core/paths.js";
import { HunchStore } from "../src/store/hunchStore.js";
import { syncCommit } from "../src/synthesis/synthesize.js";
import { commitOnlyRefreshesGrounding } from "../src/extractors/git.js";

process.env.HUNCH_SYNTH_PROVIDER = "deterministic";

const START = "<!-- HUNCH:START — auto-generated, do not edit by hand -->";
const END = "<!-- HUNCH:END -->";
const agents = (intro: string, stats: string, eol = "\n") =>
  [`# Agents`, "", intro, "", START, `Hunch holds ${stats}.`, END, "", "Team notes stay here.", ""].join(eol);

function repo(): { root: string; store: HunchStore; commit: (msg: string, files: Record<string, string>) => string; cleanup: () => void } {
  const sandbox = mkdtempSync(join(tmpdir(), "hunch-grounding-capture-"));
  const root = join(sandbox, "repository");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  const store = new HunchStore(hunchPaths(root));
  store.json.ensureDirs();
  const commit = (msg: string, files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), body);
      git("add", "--", rel);
    }
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD").trim();
  };
  return { root, store, commit, cleanup: () => { store.close(); cleanupDir(sandbox); } };
}

const BASE = {
  "AGENTS.md": agents("Follow the repo rules.", "651 decisions"),
  ".cursor/rules/hunch.mdc": "---\nalwaysApply: true\n---\nHunch holds 651 decisions.\n",
  "src/app.ts": "export const one = 1;\n",
};

test("a commit that only refreshes grounding blocks (with CRLF churn) is not captured (#658)", async () => {
  const { root, store, commit, cleanup } = repo();
  try {
    commit("docs: add agent instructions", BASE);
    const sha = commit("docs: refresh hunch grounding after records sync", {
      "AGENTS.md": agents("Follow the repo rules.", "652 decisions", "\r\n"),
      ".cursor/rules/hunch.mdc": "---\r\nalwaysApply: true\r\n---\r\nHunch holds 652 decisions.\r\n",
    });
    assert.equal(commitOnlyRefreshesGrounding(sha, ["AGENTS.md", ".cursor/rules/hunch.mdc"], root), true);
    const result = await syncCommit(store, root, sha);
    assert.equal(result.status, "skipped");
    assert.match(result.reason ?? "", /grounding/);
  } finally { cleanup(); }
});

test("a human edit to AGENTS.md's authored text stays a capture candidate", async () => {
  const { root, store, commit, cleanup } = repo();
  try {
    commit("docs: add agent instructions", BASE);
    const sha = commit("docs: require integration tests before merge", {
      "AGENTS.md": agents("Follow the repo rules. Run the integration suite before every merge, since unit tests miss the store wiring.", "652 decisions"),
    });
    assert.equal(commitOnlyRefreshesGrounding(sha, ["AGENTS.md"], root), false);
    const result = await syncCommit(store, root, sha);
    assert.equal(result.status, "written", result.reason);
  } finally { cleanup(); }
});

test("a grounding refresh riding along with a code change is still captured", async () => {
  const { root, store, commit, cleanup } = repo();
  try {
    commit("docs: add agent instructions", BASE);
    const sha = commit("feat: add a second constant for the pricing table", {
      "AGENTS.md": agents("Follow the repo rules.", "652 decisions"),
      "src/app.ts": "export const one = 1;\nexport const two = 2;\nexport const three = one + two;\n",
    });
    assert.equal(commitOnlyRefreshesGrounding(sha, ["AGENTS.md", "src/app.ts"], root), false);
    const result = await syncCommit(store, root, sha);
    assert.equal(result.status, "written", result.reason);
  } finally { cleanup(); }
});

test("a doc that loses or duplicates its managed region is not treated as generated", async () => {
  const { root, commit, cleanup } = repo();
  try {
    commit("docs: add agent instructions", BASE);
    const removed = commit("docs: drop the hunch block", { "AGENTS.md": "# Agents\n\nFollow the repo rules.\n\nTeam notes stay here.\n" });
    assert.equal(commitOnlyRefreshesGrounding(removed, ["AGENTS.md"], root), false);
    const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(commitOnlyRefreshesGrounding(rootCommit, ["AGENTS.md"], root), false, "an added doc has no parent to compare");
  } finally { cleanup(); }
});
