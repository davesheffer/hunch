import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

function runScripts(workflow: string): string[] {
  const lines = workflow.split("\n");
  const scripts: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const body = [match[2]];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next.trim() && next.length - next.trimStart().length <= indent) break;
      body.push(next);
      index += 1;
    }
    scripts.push(body.join("\n"));
  }
  return scripts;
}

function jobBlock(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `workflow is missing the ${name} job`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function publishDependencies(workflow: string): string[] {
  const publish = jobBlock(workflow, "publish");
  const match = /^    needs:\s*\[([^\]]*)\]\s*$/m.exec(publish);
  assert.ok(match, "publish must declare its complete dependency set on one auditable line");
  return match[1].split(",").map((dependency) => dependency.trim()).filter(Boolean).sort();
}

function assertPublishDependencies(workflow: string): void {
  assert.deepEqual(
    publishDependencies(workflow),
    ["platform-matrix-safety", "validate"],
    "publish must depend on exactly candidate validation and tagged Windows/macOS safety",
  );
}

test("PR CI proves the full gate, Node 24 package candidate, and Windows team Matrix", () => {
  assert.match(ci, /pull_request:/);
  assert.match(ci, /node-version: \[22, 24\]/,
    "Ubuntu runs the complete content-addressed release gate on Node 22 and Node 24");
  assert.match(ci, /npm run gate:release -- --output release-gate\.json/);
  assert.match(ci, /if: matrix\.node-version == 24[\s\S]*npm run prepublishOnly[\s\S]*npm pack --dry-run --json/,
    "Node 24 exercises the publish lifecycle and exact package manifest before tagging");
  assert.match(ci, /npm-package-candidate-receipt\.json[\s\S]*uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(ci, /os: \[windows-latest, macos-latest\]/);
  assert.match(ci, /test\/team-matrix-e2e\.test\.ts/,
    "Windows exercises the real multi-clone team Matrix");
  assert.match(ci, /platform-matrix-safety\.json[\s\S]*uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.equal((ci.match(/actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/g) ?? []).length, 2,
    "every CI checkout is pinned to the reviewed action commit");
  assert.equal((ci.match(/fetch-depth: 0/g) ?? []).length, 2,
    "every CI checkout has the pinned compatibility tag and its full history");
  assert.equal((ci.match(/actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/g) ?? []).length, 2,
    "every CI runtime setup is pinned to the reviewed action commit");
  for (const [, action, pin] of ci.matchAll(/uses: (actions\/[A-Za-z0-9_-]+)@([^\s#]+)/g)) {
    assert.match(pin, /^[0-9a-f]{40}$/, `${action} must be pinned by full commit SHA`);
  }
});

test("npm publication isolates OIDC from repository code and publishes only validated bytes", () => {
  const validate = jobBlock(release, "validate");
  const platformSafety = jobBlock(release, "platform-matrix-safety");
  const publish = jobBlock(release, "publish");

  assert.match(release, /tags: \["v\[0-9\]\*"\]/);
  assert.match(release, /^permissions:\n  contents: read$/m,
    "OIDC is denied by default for every job");
  assert.match(release, /group: hunch-npm-package$/m,
    "all package versions serialize through one publication lane");
  assert.doesNotMatch(release, /group:.*github\.(?:ref|ref_name)/,
    "historical tags must not bypass newer package publications in a separate lane");

  assert.match(validate, /permissions:\n      contents: read/);
  assert.doesNotMatch(validate, /id-token:/,
    "checkout, install, tests, build, and pack have no OIDC authority");
  assert.match(validate, /npm ci/);
  assert.match(validate, /npm run gate:release -- --tag "\$\{GITHUB_REF_NAME\}" --output release-gate\.json/);
  assert.match(validate, /npm pack --ignore-scripts --json --pack-destination release-candidate/,
    "the package candidate is packed with lifecycle scripts disabled");
  assert.match(validate, /manifest\.name !== PACKAGE_NAME/);
  assert.match(validate, /process\.env\.GITHUB_REF_NAME !== `v\$\{manifest\.version\}`/,
    "the fixed package version must exactly match the pushed package tag");
  assert.match(validate, /matrix\.packages\?\.candidate\?\.sha256 !== tarballSha256/,
    "the tarball exercised by the Matrix must be byte-identical to the publication candidate");
  assert.match(validate, /releaseGate\.source\?\.commit_after !== process\.env\.GITHUB_SHA/,
    "publication requires the release gate to finish on the exact tagged commit it started with");
  assert.match(validate, /forbiddenPaths = packagePaths\.filter/);
  assert.match(validate, /\.hunch\(\?:-cache\)\?/,
    "private/team memory and runtime caches are explicitly denied from the npm tarball");
  assert.match(validate, /\\\.env/,
    "environment and credential-shaped files are explicitly denied from the npm tarball");
  assert.match(validate, /package_path_manifest_sha256/,
    "the content-addressed candidate binds the complete allowed package path set");
  assert.match(validate, /release_gate_content_hash/);
  assert.match(validate, /matrix_content_hash/);
  assert.match(validate, /content_hash/);
  assert.match(validate, /release-candidate-manifest\.json/);
  assert.match(validate, /name: npm-release-candidate-\$\{\{ github\.run_id \}\}[\s\S]*overwrite: true/,
    "a full rerun replaces the candidate while rerun-failed can reuse the prior successful validation artifact");
  assert.doesNotMatch(validate, /npm-release-candidate-.*run_attempt/);

  assert.match(platformSafety, /os: \[windows-latest, macos-latest\]/);
  assert.match(platformSafety, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(platformSafety, /permissions:\n      contents: read/);
  assert.match(platformSafety, /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10[\s\S]*fetch-depth: 0[\s\S]*persist-credentials: false/,
    "tagged platform tests receive the source but do not retain the checkout credential");
  assert.match(platformSafety, /GITHUB_REF!==`refs\/tags\/\$\{tag\}`/);
  assert.match(platformSafety, /\["rev-list","-n","1",tag\]/);
  assert.match(platformSafety, /actual!==process\.env\.GITHUB_SHA \|\| tagged!==process\.env\.GITHUB_SHA/,
    "both checkout HEAD and the pushed tag resolve to the exact event commit");
  assert.match(platformSafety, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38[\s\S]*node-version: 22[\s\S]*cache: npm/);
  assert.match(platformSafety, /^        run: npm ci$/m,
    "the platform gate uses the repository's exact integrity-locked dependency tree");
  const platformTestCommand = "npx --no-install tsx --test --test-concurrency=1 test/parse.test.ts test/io.test.ts test/migrate.test.ts test/matrix-release-verification.test.ts test/team-matrix-e2e.test.ts";
  assert.ok(platformSafety.includes(`run: ${platformTestCommand}`),
    "the tagged release reruns native, atomic-write, and real team-Matrix safety on both non-Linux platforms");
  assert.ok(jobBlock(ci, "platform-matrix-safety").includes(`run: ${platformTestCommand}`),
    "release platform safety must stay byte-for-byte aligned with the proven CI test command");
  assert.match(platformSafety, /tagged-platform-matrix-safety\.v1[\s\S]*tagged-platform-matrix-safety-\$\{\{ matrix\.os \}\}-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}/,
    "each platform uploads a content-addressed receipt bound to the tag commit");
  assert.match(platformSafety, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.doesNotMatch(platformSafety, /id-token:|environment:|\$\{\{\s*secrets\.|(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_AUTH_TOKEN)/,
    "cross-platform validation has neither publication authority nor a configured secret");
  assertPublishDependencies(release);
  assert.match(publish, /environment: npm-publish/,
    "the npm trusted publisher is bound to a protected, explicitly named environment");
  assert.match(publish, /permissions:[\s\S]*contents: read[\s\S]*id-token: write/,
    "only the minimal publication job can mint an OIDC token");
  assert.equal([...release.matchAll(/id-token: write/g)].length, 1,
    "OIDC authority appears exactly once in the entire workflow");
  assert.doesNotMatch(publish, /actions\/checkout|npm ci|npm run|prepublishOnly/,
    "the OIDC job neither checks out nor executes repository/dependency code");
  assert.doesNotMatch(publish, /from ["']\.\.?\/|node\s+\.\//,
    "the OIDC job imports no module from the downloaded artifact or repository");
  assert.match(publish, /"install", `\$\{PACKAGE_NAME\}@\$\{manifest\.package\.version\}`[\s\S]*"--ignore-scripts"[\s\S]*"--no-audit"/,
    "the post-publication signature audit installs the exact version with every lifecycle script disabled");
  assert.match(publish, /delete nonPublishingEnvironment\.ACTIONS_ID_TOKEN_REQUEST_URL;[\s\S]*delete nonPublishingEnvironment\.ACTIONS_ID_TOKEN_REQUEST_TOKEN;/,
    "every subprocess except the exact npm publish command is denied OIDC request capability");
  assert.match(publish, /spawnSync\("npm", \["view"[\s\S]*env: nonPublishingEnvironment/);
  assert.match(publish, /spawnSync\("tar"[\s\S]*env: nonPublishingEnvironment/);
  assert.match(publish, /const auditEnvironment = nonPublishingEnvironment/);
  assert.match(publish, /"audit", "signatures", "--json", `--registry=\$\{REGISTRY\}`/,
    "npm cryptographically verifies registry signatures and Sigstore provenance");
  assert.doesNotMatch(publish, /include-attestations|audit\.verified|attestationBundles/,
    "the workflow uses npm audit signatures' real output contract rather than invented fields or flags");
  assert.match(publish, /requireFromNpm\("sigstore"\)/,
    "the exact fetched DSSE bundle is verified with the Sigstore implementation bundled in the trusted npm CLI");
  assert.match(publish, /certificateIssuer: "https:\/\/token\.actions\.githubusercontent\.com"/);
  assert.match(publish, /certificateIdentityURI: new RegExp\(process\.argv\[2\]\)/,
    "the signing certificate is constrained to the exact repository workflow and tag identity");
  assert.match(publish, /env: nonPublishingEnvironment[\s\S]*exact Sigstore bundle verification failed/,
    "cryptographic verification runs without access to the job's OIDC request capability");
  assert.match(publish, /audit\.invalid\.length !== 0 \|\| audit\.missing\.length !== 0/,
    "any invalid or missing cryptographic evidence fails publication verification");
  assert.match(publish, /installedPackage\?\.integrity !== manifest\.artifact\.tarball_integrity/,
    "the cryptographic audit is bound to the exact validated tarball integrity");
  assert.match(publish, /node --input-type=module <<'NODE'/,
    "artifact verification is trusted inline workflow logic, not downloaded repository code");
  assert.match(publish, /name: npm-release-candidate-\$\{\{ github\.run_id \}\}/);
  assert.match(publish, /npm", \["publish", tarballPath[\s\S]*"--ignore-scripts"[\s\S]*"--provenance"[\s\S]*"--tag", distTag/,
    "npm publishes the exact validated tgz with scripts disabled and provenance enabled");

  const actionPins = [...release.matchAll(/uses: (actions\/[A-Za-z0-9_-]+)@([^\s#]+)/g)];
  assert.ok(actionPins.length >= 5, "the workflow uses pinned official artifact, checkout, and Node actions");
  for (const [, action, pin] of actionPins) {
    assert.match(pin, /^[0-9a-f]{40}$/, `${action} must be pinned by full commit SHA`);
  }
  assert.match(validate, /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/);
  assert.match(validate, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(validate, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(publish, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(publish, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(publish, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);

  assert.match(publish, /candidate version .* is not newer than current .* dist-tag/,
    "a historical workflow cannot downgrade latest or next");
  assert.match(publish, /npm registry lookup failed closed/,
    "a registry outage cannot be mistaken for an unpublished version or absent dist-tag");
  assert.match(publish, /mode: publicationMode/);
  assert.match(publish, /observed_dist_tag/,
    "an idempotent rerun records the moving tag without requiring or restoring it");
  assert.doesNotMatch(publish, /npm dist-tag|dist-tag add/);
  assert.match(publish, /registry_integrity/);
  assert.match(publish, /attestation_sha256/);
  assert.match(publish, /cryptographic_attestation_verified/);
  assert.match(publish, /raw_and_cryptographic_bundle_match/);
  assert.match(publish, /cryptographic_attestation_bundle_sha256/);
  assert.match(publish, /attestation_bundle_sha256/);
  assert.match(publish, /signature_audit_sha256/);
  assert.match(publish, /dependency\.uri === expectedDependencyUri/,
    "provenance binds the exact repository, ref, and commit rather than any matching hash");
  assert.match(publish, /releaseGate\.source\?\.commit_after !== manifest\.source\.commit/,
    "the downloaded release receipt must preserve its final-HEAD binding");
  assert.match(publish, /provenance_predicate_type/);
  assert.match(publish, /release_gate_content_hash/);
  assert.match(publish, /matrix_content_hash/);
  assert.match(publish, /tarball_sha256/);
  assert.match(publish, /tarball_integrity/);
  assert.match(publish, /npm-publication-receipt\.json/);

  assert.match(release, /trusted-publisher binding without an[\s\S]*environment[\s\S]*`npm-publish`/i,
    "npm must revoke the old no-environment trust binding so historical workflow tags cannot authenticate");
  assert.match(release, /trusted publishing requires npm >=11\.5\.1/);
  assert.match(publish, /long-lived npm credential .* is forbidden/,
    "the OIDC job refuses a credential injected outside trusted publishing");
  assert.doesNotMatch(release, /(?:NODE_AUTH_TOKEN|NPM_TOKEN):\s*\$\{\{|secrets\.NPM/,
    "trusted publishing must not silently fall back to a long-lived npm token");

  for (const script of runScripts(release)) {
    assert.doesNotMatch(script, /\$\{\{\s*steps\.metadata\.outputs\.(?:name|version|dist_tag)\s*\}\}/,
      "validated package metadata enters commands through environment variables, never shell source text");
  }
});

test("release dependency attacks cannot bypass either publication gate", () => {
  const withoutValidation = release.replace(
    "needs: [validate, platform-matrix-safety]",
    "needs: [platform-matrix-safety]",
  );
  const withoutPlatformSafety = release.replace(
    "needs: [validate, platform-matrix-safety]",
    "needs: [validate]",
  );

  assert.notEqual(withoutValidation, release, "validation-dependency attack fixture must mutate the workflow");
  assert.notEqual(withoutPlatformSafety, release, "platform-dependency attack fixture must mutate the workflow");
  assert.throws(() => assertPublishDependencies(withoutValidation), /publish must depend on exactly/);
  assert.throws(() => assertPublishDependencies(withoutPlatformSafety), /publish must depend on exactly/);
});
