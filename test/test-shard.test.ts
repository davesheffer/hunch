import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { git, RELEASE_CLEAN_STATUS_ARGS, statusWithoutMemoryChurn } from "../tooling/release-gate.mjs";
import {
  parseShardProfile,
  parseShardSpec,
  SHARD_PROFILES,
  selectShard,
  verifyDelegatedGateReceipt,
  verifyNode24Evidence,
  verifyShardManifests,
} from "../tooling/test-shard.mjs";

const COMMIT = "a".repeat(40);

function manifestsFor(input: string[], total: number, runtime: { node: string; platform: string } = { node: "v24.0.0", platform: "linux" }, profile: string | null = null) {
  const sorted = [...new Set(input)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return Array.from({ length: total }, (_, offset) => ({
    schema: "hunch.test-shard.v1",
    shard: `${offset + 1}/${total}`,
    index: offset + 1,
    total,
    profile,
    commit: COMMIT,
    input: sorted,
    selected: selectShard(sorted, { index: offset + 1, total }, profile),
    exit_code: 0,
    source_unchanged: true,
    ...runtime,
  }));
}

test("parseShardSpec accepts only i/n with 1 <= i <= n <= 64", () => {
  assert.deepEqual(parseShardSpec("1/1"), { index: 1, total: 1 });
  assert.deepEqual(parseShardSpec("3/4"), { index: 3, total: 4 });
  assert.deepEqual(parseShardSpec("64/64"), { index: 64, total: 64 });
  for (const bad of ["", "0/4", "5/4", "1/0", "1/65", "65/65", "a/b", "1/2/3", " 1/2", "1/2 ", "-1/2", "1.0/2", "1"]) {
    assert.throws(() => parseShardSpec(bad), new RegExp(`invalid test shard ${JSON.stringify(bad).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`), bad);
  }
});

test("selectShard is deterministic, disjoint, and exhaustive across every shard", () => {
  const files = Array.from({ length: 20 }, (_, n) => `test/f${String((n * 7) % 20).padStart(2, "0")}.test.ts`);
  const input = [...files.slice(10), "test/f03.test.ts", ...files.slice(0, 10), "test/Z.test.ts", "test/f03.test.ts"];
  const unique = [...new Set(input)];
  for (const total of [1, 2, 3, 4, 7]) {
    const shards = Array.from({ length: total }, (_, offset) => selectShard(input, { index: offset + 1, total }));
    assert.deepEqual(shards, Array.from({ length: total }, (_, offset) => selectShard([...input].reverse(), { index: offset + 1, total })),
      `input order never changes the split (n=${total})`);
    const all = shards.flat();
    assert.equal(all.length, new Set(all).size, `no file runs twice (n=${total})`);
    assert.deepEqual([...all].sort(), [...unique].sort(), `every file runs exactly once (n=${total})`);
  }
  assert.deepEqual(selectShard(["b", "a", "C"], { index: 1, total: 2 }), ["C", "b"], "code-unit order puts uppercase first");
  assert.deepEqual(selectShard(["a", "b"], { index: 3, total: 4 }), [], "a shard past the file count is empty");
  assert.deepEqual(selectShard([], { index: 1, total: 1 }), []);
  assert.throws(() => selectShard(["a"], { index: 0, total: 2 }));
});

/** The platform-matrix-safety step's file list, read from ci.yml. */
function platformList(): string[] {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const step = /- name: Native bindings, atomic writes, and the team Matrix stay safe\n([\s\S]*?)\n\s+- name: /.exec(workflow);
  assert.ok(step, "ci.yml has the platform-matrix-safety test step");
  assert.match(step[1], /^\s+HUNCH_TEST_SHARD_PROFILE: platform$/m, "the platform step splits under the platform profile");
  const line = /^\s+run: node tooling\/run-tests\.mjs --test-concurrency=1 (.+)$/m.exec(step[1]);
  assert.ok(line, "the platform step runs run-tests.mjs over an explicit file list");
  return line[1].trim().split(/\s+/);
}

test("the platform profile splits by weight: deterministic, disjoint, exhaustive, heaviest file alone", () => {
  const input = platformList();
  const { weights, defaultWeight } = SHARD_PROFILES.platform;
  for (const file of Object.keys(weights)) {
    assert.ok(existsSync(file), `weighted file ${file} exists`);
    assert.ok(input.includes(file), `weighted file ${file} is on the platform list`);
  }
  const weightOf = (file: string) => (weights as Record<string, number>)[file] ?? defaultWeight;
  const loadOf = (files: string[]) => files.reduce((sum, file) => sum + weightOf(file), 0);
  for (const total of [1, 2, 3, 4, 7]) {
    const shards = Array.from({ length: total }, (_, offset) => selectShard(input, { index: offset + 1, total }, "platform"));
    assert.deepEqual(shards, Array.from({ length: total }, (_, offset) => selectShard([...input].reverse(), { index: offset + 1, total }, "platform")),
      `input order never changes the split (n=${total})`);
    const all = shards.flat();
    assert.equal(all.length, new Set(all).size, `no file runs twice (n=${total})`);
    assert.deepEqual([...all].sort(), [...new Set(input)].sort(), `every file runs exactly once (n=${total})`);
    for (const shard of shards) assert.deepEqual(shard, [...shard].sort(), "each shard runs its files in sorted order");
  }
  const three = Array.from({ length: 3 }, (_, offset) => selectShard(input, { index: offset + 1, total: 3 }, "platform"));
  const count = Array.from({ length: 3 }, (_, offset) => selectShard(input, { index: offset + 1, total: 3 }));
  // Greedy least-loaded bound: no shard exceeds an even share plus one file,
  // or the single heaviest file when that alone is more.
  const heaviest = Math.max(...input.map(weightOf));
  const worst = Math.max(...three.map(loadOf));
  assert.ok(worst <= Math.max(heaviest, loadOf(input) / 3 + heaviest), `weighted worst shard ${worst} stays within the greedy bound`);
  assert.ok(worst <= Math.max(...count.map(loadOf)), "the weighted split is never worse than the count split");
  // Least-loaded wins, ties to the lowest index; unlisted files weigh the default.
  assert.deepEqual([1, 2].map((index) => selectShard(["b", "a", "c"], { index, total: 2 }, "platform")), [["a", "c"], ["b"]]);
  assert.throws(() => selectShard(input, { index: 1, total: 3 }, "nope"), /unknown test shard profile "nope"/);
  assert.equal(parseShardProfile(""), null);
  assert.equal(parseShardProfile(undefined), null);
  assert.equal(parseShardProfile("platform"), "platform");
  assert.throws(() => parseShardProfile("toString"), /unknown test shard profile/);
  assert.throws(() => parseShardProfile(["platform"]), /unknown test shard profile/);
  assert.deepEqual(selectShard(["b", "a"], { index: 1, total: 2 }, ""), ["a"], "an empty profile is the count split");
});

test("verifyShardManifests proves coverage and names every way it can fail", () => {
  const input = Array.from({ length: 9 }, (_, n) => `test/t${n}.test.ts`);
  const ok = manifestsFor(input, 3);
  assert.deepEqual(verifyShardManifests(ok, { total: 3, commit: COMMIT, expectedInput: [...input].reverse() }), []);
  assert.deepEqual(verifyShardManifests(ok, { total: 3, commit: COMMIT }), []);

  const fails = (manifests: unknown[], pattern: RegExp, expectedInput: string[] | undefined = input) => {
    const errors = verifyShardManifests(manifests, { total: 3, commit: COMMIT, expectedInput });
    assert.ok(errors.some((error) => pattern.test(error)), `expected ${pattern} in:\n${errors.join("\n")}`);
  };
  fails(ok.slice(0, 2), /shard 3\/3 is missing/);
  fails(ok.slice(0, 2), /ran in no shard/);
  fails([ok[0], ok[1], { ...ok[1] }], /shard 2\/3 appears 2 times/);
  fails([ok[0], ok[1], { ...ok[2], commit: "b".repeat(40) }], /ran on commit/);
  fails(ok, /shard input differs from the expected suite; missing: test\/extra\.test\.ts/, [...input, "test/extra.test.ts"]);
  fails(ok, /unexpected: test\/t8\.test\.ts/, input.slice(0, 8));
  const moved = ok[0].selected[0];
  fails([{ ...ok[0], selected: ok[0].selected.slice(1) }, { ...ok[1], selected: [...ok[1].selected, moved] }, ok[2]],
    /shard 1\/3: ran a different file set/);
  fails([{ ...ok[0], selected: ok[0].selected.slice(1) }, ok[1], ok[2]], new RegExp(`${moved.replace(/[.]/g, "\\.")} ran in no shard`));
  fails([ok[0], { ...ok[1], input: input.slice(1) }, ok[2]], /was given a different input list/);
  fails([ok[0], { ...ok[1], exit_code: 1 }, ok[2]], /shard 2\/3: tests exited 1/);
  fails([ok[0], ok[1], { ...ok[2], exit_code: null }], /tests exited null/);
  fails([ok[0], { ...ok[1], source_unchanged: false }, ok[2]], /source tree changed/);
  fails([ok[0], ok[1], { ...ok[2], total: 4, shard: "3/4" }], /total is 4, expected 3/);
  fails([ok[0], ok[1], { ...ok[2], schema: "other" }], /schema is "other"/);
  fails([ok[0], ok[1], null], /not a manifest object/);

  const onNode = (manifests: unknown[], node: number, platform?: string) => verifyShardManifests(manifests, { total: 3, commit: COMMIT, node, platform });
  assert.deepEqual(onNode(ok, 24, "linux"), []);
  assert.ok(onNode([ok[0], { ...ok[1], node: "v22.11.0" }, ok[2]], 24).some((error) => /shard 2\/3: ran on Node "v22\.11\.0", expected Node 24/.test(error)));
  assert.ok(onNode([ok[0], ok[1], { ...ok[2], node: undefined }], 24).some((error) => /shard 3\/3: ran on Node undefined, expected Node 24/.test(error)));
  assert.ok(onNode(ok, 24, "win32").some((error) => /shard 1\/3: ran on platform "linux", expected win32/.test(error)));

  // A profile is part of the proof: the verdict recomputes each shard's
  // selection under the profile it expects, and the manifest must name it.
  const files = ["test/team-matrix-e2e.test.ts", "test/workspaces.test.ts", "test/task-selection.test.ts", "test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
  const weighted = manifestsFor(files, 3, { node: "v22.0.0", platform: "win32" }, "platform");
  assert.deepEqual(verifyShardManifests(weighted, { total: 3, commit: COMMIT, profile: "platform" }), []);
  const asCount = verifyShardManifests(weighted, { total: 3, commit: COMMIT });
  assert.ok(asCount.some((error) => /split by profile "platform", expected null/.test(error)), asCount.join("\n"));
  assert.ok(asCount.some((error) => /ran a different file set than its deterministic selection/.test(error)), asCount.join("\n"));
  const relabeled = manifestsFor(files, 3, { node: "v22.0.0", platform: "win32" }).map((manifest) => ({ ...manifest, profile: "platform" }));
  const forgedLabel = verifyShardManifests(relabeled, { total: 3, commit: COMMIT, profile: "platform" });
  assert.ok(forgedLabel.some((error) => /ran a different file set than its deterministic selection/.test(error)),
    `a count split labeled "platform" is still caught: ${forgedLabel.join("\n")}`);
  const unlabeled = weighted.map(({ profile: _profile, ...manifest }) => manifest);
  assert.ok(verifyShardManifests(unlabeled, { total: 3, commit: COMMIT, profile: "platform" }).some((error) => /split by profile null, expected "platform"/.test(error)));
});

test("verify-node24 rejects shard manifests recorded on another Node line", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-test-shard-node24-"));
  try {
    const suite = readdirSync("test").filter((name) => name.endsWith(".test.ts")).map((name) => `test/${name}`);
    manifestsFor(suite, 4, { node: "v22.11.0", platform: "linux" }).forEach((manifest, offset) => {
      mkdirSync(join(dir, `test-shard-node-24-${offset + 1}-${COMMIT}`), { recursive: true });
      writeFileSync(join(dir, `test-shard-node-24-${offset + 1}-${COMMIT}`, "test-shard-manifest.json"), JSON.stringify(manifest));
    });
    const { errors } = verifyNode24Evidence({ dir, commit: COMMIT, total: 4 });
    for (let index = 1; index <= 4; index += 1) {
      assert.ok(errors.includes(`shard ${index}/4: ran on Node "v22.11.0", expected Node 24`), errors.join("\n"));
    }
    assert.ok(!errors.some((error) => /shard input differs|ran in no shard/.test(error)), "only the Node line is wrong here");
  } finally {
    cleanupDir(dir);
  }
});

test("verifyDelegatedGateReceipt refuses anything but an authentic partial gate", () => {
  assert.ok(verifyDelegatedGateReceipt(null, COMMIT).some((error) => /does not self-verify/.test(error)));
  const failed = verifyDelegatedGateReceipt({ schema: "hunch.constitution.release-gate.v1", result: "failed", source: { commit: COMMIT }, gates: [] }, COMMIT);
  assert.ok(failed.some((error) => /does not self-verify/.test(error)));
  assert.ok(failed.some((error) => /result is "failed", expected "partial"/.test(error)));
  assert.ok(failed.some((error) => /release-gate stages are \[\]/.test(error)));
});

test("verify-platform accepts one green receipt + manifest per shard and rejects a tampered receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-test-shard-platform-"));
  try {
    const tests = ["test/parse.test.ts", "test/io.test.ts", "test/migrate.test.ts", "test/ui.test.ts"];
    const put = (path: string, value: unknown) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(value, null, 2) + "\n");
    };
    // Exactly the receipt the workflow's inline writer produces.
    const receipt = (shard: string, overrides: Record<string, unknown> = {}) => {
      const body = { schema: "hunch.platform-matrix-safety.v1", commit: COMMIT, node: "v22.11.0", runner_os: "Windows", shard, outcome: "success", tests, ...overrides };
      return { ...body, content_hash: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` };
    };
    manifestsFor(tests, 3, { node: "v22.11.0", platform: "win32" }, "platform").forEach((manifest, offset) => {
      put(`platform-matrix-safety-windows-latest-${offset + 1}-${COMMIT}/test-shard-manifest.json`, manifest);
      put(`platform-matrix-safety-windows-latest-${offset + 1}-${COMMIT}/platform-matrix-safety.json`, receipt(`${offset + 1}/3`));
    });
    const verify = (os = "windows-latest") => spawnSync(process.execPath,
      ["tooling/test-shard.mjs", "verify-platform", "--dir", dir, "--commit", COMMIT, "--total", "3", "--os", os], { encoding: "utf8" });
    const ok = verify();
    assert.equal(ok.status, 0, ok.stderr);
    const wrongOs = verify("macos-latest");
    assert.equal(wrongOs.status, 1);
    assert.match(wrongOs.stderr, /runner_os is "Windows", expected macOS/);
    assert.match(wrongOs.stderr, /shard 1\/3: ran on platform "win32", expected darwin/);
    const shardDir = (shard: number) => `platform-matrix-safety-windows-latest-${shard}-${COMMIT}`;
    const [firstManifest] = manifestsFor(tests, 3, { node: "v22.11.0", platform: "win32" }, "platform");
    put(`${shardDir(1)}/platform-matrix-safety.json`, receipt("1/3", { node: "v24.0.0" }));
    put(`${shardDir(1)}/test-shard-manifest.json`, { ...firstManifest, node: "v24.0.0" });
    const wrongNode = verify();
    assert.equal(wrongNode.status, 1);
    assert.match(wrongNode.stderr, /platform receipt 1\/3: ran on Node "v24\.0\.0", expected Node 22/);
    assert.match(wrongNode.stderr, /shard 1\/3: ran on Node "v24\.0\.0", expected Node 22/);
    put(`${shardDir(1)}/platform-matrix-safety.json`, receipt("1/3", { runner_os: "macOS" }));
    put(`${shardDir(1)}/test-shard-manifest.json`, { ...firstManifest, platform: "darwin" });
    const otherRunner = verify();
    assert.equal(otherRunner.status, 1, "a macOS shard's evidence never stands in for a Windows shard");
    assert.match(otherRunner.stderr, /platform receipt 1\/3: runner_os is "macOS", expected Windows/);
    assert.match(otherRunner.stderr, /shard 1\/3: ran on platform "darwin", expected win32/);
    put(`${shardDir(1)}/platform-matrix-safety.json`, receipt("1/3"));
    put(`${shardDir(1)}/test-shard-manifest.json`, firstManifest);
    const restored = verify();
    assert.equal(restored.status, 0, restored.stderr);
    const forged = { ...receipt("2/3"), outcome: "failure" };
    put(`platform-matrix-safety-windows-latest-2-${COMMIT}/platform-matrix-safety.json`, forged);
    const tampered = verify();
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /platform receipt 2\/3: content_hash does not match/);
    assert.match(tampered.stderr, /platform receipt 2\/3: outcome is "failure"/);
    put(`platform-matrix-safety-windows-latest-2-${COMMIT}/platform-matrix-safety.json`, receipt("1/3"));
    const duplicate = verify();
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /shard 1\/3 appears 2 times[\s\S]*shard 2\/3 appears 0 times/);
  } finally {
    cleanupDir(dir);
  }
});

test("run-tests.mjs shards its file arguments, writes the manifest, and never leaks the shard to tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-test-shard-e2e-"));
  // A nested `node --test` that inherits the runner's context skips every file.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  try {
    const marker = (name: string) => join(dir, `${name}.ran`);
    const body = (name: string) => [
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      'import test from "node:test";',
      `test(${JSON.stringify(name)}, () => {`,
      "  assert.equal(process.env.HUNCH_TEST_SHARD, undefined);",
      "  assert.equal(process.env.HUNCH_TEST_SHARD_MANIFEST, undefined);",
      "  assert.equal(process.env.HUNCH_TEST_SHARD_PROFILE, undefined);",
      `  writeFileSync(${JSON.stringify(marker(name))}, "1");`,
      "});",
      "",
    ].join("\n");
    const first = join(dir, "a.test.ts");
    const second = join(dir, "b.test.ts");
    writeFileSync(first, body("a"));
    writeFileSync(second, body("b"));
    const manifestPath = join(dir, "out", "manifest.json");
    // The same memory-churn filter the shard's own guard uses: a concurrent
    // test's .hunch/ churn is not this fixture's doing.
    const sourceStatus = () => statusWithoutMemoryChurn(git(RELEASE_CLEAN_STATUS_ARGS));
    const statusBefore = sourceStatus();
    const headBefore = git(["rev-parse", "HEAD"]);
    const run = spawnSync(process.execPath, ["tooling/run-tests.mjs", "--test-concurrency=1", second, first, first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "1/2", HUNCH_TEST_SHARD_MANIFEST: manifestPath },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(existsSync(marker("a")), true, `the shard ran its selected file:
${run.stdout}
${run.stderr}`);
    assert.equal(existsSync(marker("b")), false, "the shard did not run the other shard's file");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual({ ...manifest, node: undefined, platform: undefined }, {
      schema: "hunch.test-shard.v1",
      shard: "1/2",
      index: 1,
      total: 2,
      profile: null,
      commit: headBefore,
      input: [first, second],
      selected: [first],
      exit_code: 0,
      source_unchanged: true,
      node: undefined,
      platform: undefined,
    });
    assert.equal(manifest.node, process.version);
    assert.equal(sourceStatus(), statusBefore, "the e2e fixture lives outside the repository");

    const empty = spawnSync(process.execPath, ["tooling/run-tests.mjs", first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "2/2", HUNCH_TEST_SHARD_MANIFEST: join(dir, "empty.json") },
    });
    assert.equal(empty.status, 0, `${empty.stdout}\n${empty.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "empty.json"), "utf8")).selected, [], "an empty shard spawns nothing and still proves it");

    const orphan = spawnSync(process.execPath, ["tooling/run-tests.mjs", first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "", HUNCH_TEST_SHARD_MANIFEST: join(dir, "orphan.json") },
    });
    assert.equal(orphan.status, 2, "a manifest without a shard is a configuration error");
    const orphanProfile = spawnSync(process.execPath, ["tooling/run-tests.mjs", first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "", HUNCH_TEST_SHARD_PROFILE: "platform" },
    });
    assert.equal(orphanProfile.status, 2, "a profile without a shard is a configuration error");
    assert.match(orphanProfile.stderr, /HUNCH_TEST_SHARD_PROFILE is set without HUNCH_TEST_SHARD/);
    const unknownProfile = spawnSync(process.execPath, ["tooling/run-tests.mjs", first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "1/2", HUNCH_TEST_SHARD_PROFILE: "nope", HUNCH_TEST_SHARD_MANIFEST: join(dir, "nope.json") },
    });
    assert.equal(unknownProfile.status, 2);
    assert.match(unknownProfile.stderr, /unknown test shard profile "nope"/);
    assert.equal(existsSync(join(dir, "nope.json")), false, "a refused profile writes no manifest");
    const weighted = spawnSync(process.execPath, ["tooling/run-tests.mjs", "--test-concurrency=1", second, first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "2/2", HUNCH_TEST_SHARD_PROFILE: "platform", HUNCH_TEST_SHARD_MANIFEST: join(dir, "weighted.json") },
    });
    assert.equal(weighted.status, 0, `${weighted.stdout}\n${weighted.stderr}`);
    const weightedManifest = JSON.parse(readFileSync(join(dir, "weighted.json"), "utf8"));
    assert.equal(weightedManifest.profile, "platform");
    assert.deepEqual(weightedManifest.selected, selectShard([first, second], { index: 2, total: 2 }, "platform"));
    const invalid = spawnSync(process.execPath, ["tooling/run-tests.mjs", first], {
      encoding: "utf8",
      env: { ...inherited, HUNCH_TEST_SHARD: "3/2" },
    });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /invalid test shard "3\/2"/);
    // A shell that left the glob unexpanded would hand shard 1 one bogus "file"
    // and every other shard nothing, all green: refuse it before anything runs.
    for (const glob of [join(dir, "*.test.ts"), join(dir, "?.test.ts"), join(dir, "[ab].test.ts"), join(dir, "{a,b}.test.ts")]) {
      const unexpanded = spawnSync(process.execPath, ["tooling/run-tests.mjs", "--test-concurrency=1", glob], {
        encoding: "utf8",
        env: { ...inherited, HUNCH_TEST_SHARD: "2/2", HUNCH_TEST_SHARD_MANIFEST: join(dir, "glob.json") },
      });
      assert.equal(unexpanded.status, 2, `${glob}: ${unexpanded.stdout}
${unexpanded.stderr}`);
      assert.match(unexpanded.stderr, /unexpanded glob/);
      assert.equal(existsSync(join(dir, "glob.json")), false, "a refused shard writes no manifest");
    }
  } finally {
    cleanupDir(dir);
  }
});
