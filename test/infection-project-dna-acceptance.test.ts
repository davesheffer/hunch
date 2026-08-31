import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertProjectDnaProfile,
  discoverProjectDna,
  type ProjectDnaProfile,
} from "../src/core/projectDna.js";

interface AcceptanceReceipt {
  schema: "hunch.project-dna-acceptance/1";
  repository: string;
  revision: string;
  profile: ProjectDnaProfile;
}

const receipt = JSON.parse(readFileSync(
  new URL("../bench/infection/project-dna-acceptance-v1.json", import.meta.url),
  "utf8",
)) as AcceptanceReceipt;

test("the frozen Infection Project DNA receipt is sealed and repository-scale", () => {
  assert.equal(receipt.schema, "hunch.project-dna-acceptance/1");
  assert.equal(receipt.repository, "https://github.com/infection/infection");
  assert.equal(receipt.revision, "49a4923cc01da30d165b100d6270b77c0a54429e");
  assert.equal(receipt.profile.repository_revision, receipt.revision);
  assert.equal(receipt.profile.history_sample_count, 200);
  assert.deepEqual(receipt.profile.source_files, [
    ".github/CONTRIBUTING.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "AGENTS.md",
  ]);
  assert.deepEqual(receipt.profile.traits.map((trait) => trait.key), [
    "subject.no_terminal_punctuation",
    "review.focused_changes",
    "review.tests_expected",
    "term.conductor",
    "term.phpstan",
    "term.phpunit",
  ]);
  assert.equal(receipt.profile.traits.flatMap((trait) => trait.evidence).every((evidence) =>
    evidence.provenance === "committed-repository" && evidence.revision === receipt.revision), true);
  assert.doesNotThrow(() => assertProjectDnaProfile(receipt.profile));
});

const infectionRoot = process.env.HUNCH_INFECTION_REPO;
test("the pinned Infection checkout reproduces the frozen Project DNA profile", {
  skip: infectionRoot ? false : "set HUNCH_INFECTION_REPO to a full pinned infection/infection checkout",
}, () => {
  const root = resolve(infectionRoot!);
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "--is-shallow-repository"), "false");
  assert.equal(git("rev-parse", "HEAD"), receipt.revision);
  assert.deepEqual(discoverProjectDna(root, receipt.revision), receipt.profile);
});
