import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/vscode-marketplace.yml", "utf8");
const publisherToolManifest = JSON.parse(readFileSync("tooling/vscode-publish-tools/package.json", "utf8"));
const publisherToolLock = JSON.parse(readFileSync("tooling/vscode-publish-tools/package-lock.json", "utf8"));

const candidateArtifact = "vscode-release-candidate-${{ github.run_id }}";
const pins = {
  checkout: "93cb6efe18208431cddfb8368fd83d5badbf9bfd", // actions/checkout v5.0.1
  setupNode: "a0853c24544627f65ddf259abe73b1d18a591444", // actions/setup-node v5.0.0
  uploadArtifact: "ea165f8d65b6e75b540449e92b4886f43607fa02", // actions/upload-artifact v4.6.2
  downloadArtifact: "d3f86a106a0bac45b974a628896c90dbdf5c8093", // actions/download-artifact v4.3.0
  vsceIntegrity: "sha512-XSxMosEEDO6vLxELAHVkwmhC0qe0ijZni2jB9Rcs8kQsW4lhTDQ/wMzmwFs/buotAWSnpmUp/dRWD2ufG3UYKA==",
  ovsxIntegrity: "sha512-N0gWlINGgoOA2Sn0AhrF9L3ap40a/QbsFUpMDKR+CKYyZGJeTFEoNGngplLHjAYtcjrrZv2jX2K7ktPzxWjPNg==",
} as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jobBlock(source: string, name: string): string | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function stepBlocks(job: string): string[] {
  const lines = job.split("\n");
  const starts = lines
    .map((line, index) => (/^      - (?:name:|uses:)/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  return starts.map((start, position) => lines.slice(start, starts[position + 1] ?? lines.length).join("\n"));
}

function contractErrors(source: string): string[] {
  const errors: string[] = [];
  const validate = jobBlock(source, "validate");
  const publish = jobBlock(source, "publish");

  if (/^\s{2}workflow_dispatch:/m.test(source)) errors.push("manual branch dispatch is forbidden");
  if (!/tags: \["vscode-v\[0-9\]\*"\]/.test(source)) errors.push("push trigger is not restricted to extension-version tags");
  if (!validate) errors.push("missing no-secret validate job");
  if (!publish) errors.push("missing isolated publish job");
  if (!validate || !publish) return errors;

  if (/secrets\.|(?:VSCE|OVSX)_PAT/.test(validate)) errors.push("validation job can access registry credentials");
  if (!new RegExp(`actions/checkout@${pins.checkout}`).test(validate)) errors.push("checkout action is not immutably pinned");
  if (!new RegExp(`actions/setup-node@${pins.setupNode}`).test(validate)) errors.push("setup-node action is not immutably pinned");
  if (!/name: Install root \(locked; no registry credentials\)[\s\S]*?run: npm ci/.test(validate)) errors.push("root npm ci is missing");
  if (!/npm run gate:release -- --output vscode-release-gate\.json/.test(validate)) errors.push("full root release gate receipt is missing");
  if (!/releaseGate\.result !== "passed"[\s\S]*releaseGate\.candidate_ready !== true[\s\S]*releaseGate\.publish_ready !== false/.test(validate)
    || !/matrix\.result !== "passed" \|\| matrix\.release_ready !== true/.test(validate)
    || !/releaseGate\.source\?\.commit_after !== process\.env\.GITHUB_SHA/.test(validate)
    || !/releaseGate\.source\?\.tag !== null[\s\S]*releaseGate\.source\?\.tag_commit_matches !== null/.test(validate)
    || !/rootGate\.candidate_ready !== true[\s\S]*rootGate\.publish_ready !== false/.test(publish)) {
    errors.push("release/Matrix receipt is not fail-closed");
  }
  if (!/EXPECTED_TAG="vscode-v\$\{EXTENSION_VERSION\}"/.test(validate)
    || !/\$\{GITHUB_REF\}" != "refs\/tags\/\$\{EXPECTED_TAG\}"/.test(validate)
    || !/git rev-list -n 1 "\$\{EXPECTED_TAG\}"/.test(validate)
    || !/\$\{TAG_COMMIT\}" != "\$\{HEAD_COMMIT\}"/.test(validate)) {
    errors.push("tag, extension version, and HEAD are not bound exactly");
  }

  const packageCommands = validate.match(/tooling\/vscode-publish-tools\/node_modules\/\.bin\/vsce" package\b/g) ?? [];
  if (packageCommands.length !== 1) errors.push("validation must package exactly one VSIX with the locked vsce binary");
  if (!/npm ci --ignore-scripts[\s\S]*--prefix tooling\/vscode-publish-tools/.test(validate)
    || !/dependencies\?\.\["@vscode\/vsce"\] !== "3\.9\.2"/.test(validate)
    || !/dependencies\?\.ovsx !== "1\.0\.2"/.test(validate)
    || !new RegExp(escapeRegExp(pins.vsceIntegrity)).test(validate)
    || !new RegExp(escapeRegExp(pins.ovsxIntegrity)).test(validate)) {
    errors.push("publisher tools are not bound to the committed exact lock closure");
  }
  if (/\bnpm install\b|\bnpx\b/.test(source)) errors.push("floating publisher installation is forbidden");

  const inspections = source.match(/const inspectVsixEntries = \(vsixPath\) =>/g) ?? [];
  if (inspections.length !== 2
    || !/segment\.startsWith\("\.hunch"\)/.test(validate)
    || !/segment === "\.env"/.test(validate)
    || !/segment === "wiki"/.test(validate)
    || !/segment === "private"/.test(validate)
    || !/segment\.endsWith\("\.cache"\)/.test(validate)
    || !/segment === "\.npmrc"/.test(validate)
    || !/segment === "\.\."/.test(validate)
    || !validate.includes("(?:secrets?|credentials?|passwords?|tokens?|api[-_]?keys?|private[-_]?keys?)")
    || (source.match(/symlink or special-mode ZIP entry is forbidden/g) ?? []).length !== 2
    || (source.match(/fileType !== 0 && fileType !== expectedFileType/g) ?? []).length !== 2
    || !/VSIX path is outside the reviewed allowlist/.test(validate)
    || !/duplicate or case-colliding VSIX path/.test(validate)) {
    errors.push("VSIX traversal/private-path denylist and content allowlist are incomplete");
  }
  if (!/entry_manifest_sha256: vsixEntryManifestSha256/.test(validate)
    || !/entry_manifest: vsixEntryManifest/.test(validate)) {
    errors.push("sorted VSIX entry manifest is not bound into the candidate receipt");
  }

  if (!/hunch\.vscode-release-candidate\.v1/.test(validate)
    || !/artifact:[\s\S]*sha256: vsixSha256/.test(validate)
    || !/content_hash: contentHash\(body\)/.test(validate)) {
    errors.push("VSIX candidate lacks a content-addressed receipt");
  }
  if (!/copyFileSync\("vscode-release-gate\.json", resolve\(candidateDirectory, "root-release-gate\.json"\)\)/.test(validate)
    || !/root_release_gate:[\s\S]*content_hash: releaseGate\.content_hash[\s\S]*matrix_content_hash: matrix\.content_hash[\s\S]*file_sha256: sha256\(releaseGateBytes\)/.test(validate)) {
    errors.push("root gate and Matrix receipts are not carried into the immutable artifact");
  }
  if (!/copyFileSync\("tooling\/vscode-publish-tools\/package-lock\.json", resolve\(publisherToolsDirectory, "package-lock\.json"\)\)/.test(validate)
    || !/package_lock_sha256: sha256\(publisherToolsLockBytes\)/.test(validate)) {
    errors.push("reviewed publisher-tool lock is not carried into the immutable artifact");
  }
  if (!new RegExp(`name: ${escapeRegExp(candidateArtifact)}`).test(validate)
    || !new RegExp(`actions/upload-artifact@${pins.uploadArtifact}`).test(validate)
    || !/overwrite: true/.test(validate)
    || /name: vscode-release-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/.test(source)) {
    errors.push("validated VSIX candidate is not uploaded immutably");
  }

  if (!/needs: validate/.test(publish)) errors.push("publish job does not depend on validation");
  if (!/environment: vscode-publish/.test(publish)
    || !/Historical workflow revisions lack both this environment and these[\s\S]*names, so they receive no publisher credential/.test(source)) {
    errors.push("publisher credentials are not restricted to the new protected environment");
  }
  if (/actions\/checkout|npm run gate:release|\.bin\/vsce" package/.test(publish)) errors.push("publish job rebuilds repository bytes");
  if (!new RegExp(`actions/download-artifact@${pins.downloadArtifact}[\\s\\S]*name: ${escapeRegExp(candidateArtifact)}`).test(publish)) {
    errors.push("publish job does not download the exact validation artifact");
  }
  const verifyIndex = publish.indexOf("name: Verify exact candidate before registry access");
  const preflightIndex = publish.indexOf("name: Query exact public registry state");
  const firstPublishIndex = publish.indexOf("name: Publish to VS Code Marketplace");
  if (verifyIndex < 0 || preflightIndex < verifyIndex || firstPublishIndex < preflightIndex) {
    errors.push("artifact is not verified before any registry operation");
  }
  if (!/observedContentHash !== contentHash\(body\)/.test(publish)
    || !/actualVsixSha256 !== manifest\.artifact\.sha256/.test(publish)
    || !/vsixFiles\.length !== 1/.test(publish)
    || !/manifest\.source\.commit !== process\.env\.GITHUB_SHA/.test(publish)
    || !/rootGate\.source\?\.commit_after !== manifest\.source\.commit/.test(publish)
    || !/actualEntryManifestSha256 !== manifest\.artifact\.entry_manifest_sha256/.test(publish)) {
    errors.push("publish job does not reject receipt, byte, path-manifest, multiplicity, or source mismatches");
  }
  if (!/npm ci --ignore-scripts[\s\S]*--prefix vscode-release-candidate\/publish-tools/.test(publish)
    || !/publisher dependency is not fully locked to the official npm registry/.test(publish)) {
    errors.push("publish job does not consume the reviewed transitive lock with scripts disabled");
  }

  const secretSteps = stepBlocks(publish).filter((step) => /secrets\./.test(step));
  const secretReferences = [...source.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
  if (secretSteps.length !== 2
    || secretSteps.some((step) => !/name: Publish to (?:VS Code Marketplace|Open VSX)/.test(step))
    || JSON.stringify(secretReferences) !== JSON.stringify(["VSCODE_PUBLISH_OVSX_PAT", "VSCODE_PUBLISH_VSCE_PAT"])) {
    errors.push("environment-only registry credentials escape the two exact publish steps");
  }
  for (const [registry, preflightOutput] of [["VS Code Marketplace", "marketplace_present"], ["Open VSX", "open_vsx_present"]] as const) {
    const step = stepBlocks(publish).find((candidate) => candidate.includes(`name: Publish to ${registry}`));
    if (!step || !/continue-on-error: true/.test(step)
      || !new RegExp(`if: steps\\.registry-preflight\\.outputs\\.${preflightOutput} != 'true'`).test(step)) {
      errors.push(`${registry} failure is not isolated or an exact existing version is not idempotent`);
    }
  }

  if (!/marketplace\.visualstudio\.com\/_apis\/public\/gallery\/extensionquery/.test(publish)
    || !/open-vsx\.org\/api\/\$\{PUBLISHER\}\/\$\{NAME\}\/\$\{version\}/.test(publish)
    || !/poll\("VS Code Marketplace", checkMarketplace\)/.test(publish)
    || !/poll\("Open VSX", checkOpenVsx\)/.test(publish)
    || !/!marketplace\.verified \|\| !openVsx\.verified/.test(publish)
    || !/marketplace\.version !== version \|\| openVsx\.version !== version/.test(publish)
    || (source.match(/const verifyRegistryAsset = async/g) ?? []).length !== 2
    || (source.match(/response\.arrayBuffer\(\)/g) ?? []).length !== 2
    || (source.match(/assetSha256 !== expectedVsixSha256/g) ?? []).length !== 2
    || !/marketplace\.asset_sha256 !== expectedVsixSha256 \|\| openVsx\.asset_sha256 !== expectedVsixSha256/.test(publish)
    || !/asset_url: parsed\.href/.test(publish)
    || !/resolved_asset_url: response\.url/.test(publish)) {
    errors.push("both registries are not required to converge on the exact identity, version, and VSIX bytes");
  }
  if (!/"already_present"/.test(publish)
    || !/"converged_after_publish_error"/.test(publish)
    || !/schema: "hunch\.vscode-publication\.v1"/.test(publish)
    || !/result: "converged"/.test(publish)
    || !/vscode-publication-receipt\.json/.test(publish)
    || !new RegExp(`actions/upload-artifact@${pins.uploadArtifact}`).test(publish)) {
    errors.push("idempotent dual-registry publication lacks a content-addressed receipt");
  }

  const officialActionUses = [...source.matchAll(/uses: (actions\/[A-Za-z0-9_-]+)@([^\s#]+)/g)];
  if (officialActionUses.length < 5) errors.push("expected pinned checkout, setup, upload, and download actions");
  for (const [, action, pin] of officialActionUses) {
    if (!/^[0-9a-f]{40}$/.test(pin)) errors.push(`${action} is not pinned by a full SHA`);
  }

  return errors;
}

test("VSIX releases are gated, allowlisted, locked, environment-isolated, and dual-registry convergent", () => {
  assert.deepEqual(contractErrors(workflow), []);
});

test("committed publisher lock closes the exact official npm dependency tree", () => {
  assert.equal(publisherToolManifest.private, true);
  assert.deepEqual(publisherToolManifest.dependencies, { "@vscode/vsce": "3.9.2", ovsx: "1.0.2" });
  assert.equal(publisherToolLock.lockfileVersion, 3);
  assert.deepEqual(publisherToolLock.packages[""].dependencies, publisherToolManifest.dependencies);
  assert.equal(publisherToolLock.packages["node_modules/@vscode/vsce"].integrity, pins.vsceIntegrity);
  assert.equal(publisherToolLock.packages["node_modules/ovsx"].integrity, pins.ovsxIntegrity);
  assert.ok(Object.keys(publisherToolLock.packages).length > 250, "transitive closure is committed, not resolved in a PAT-bearing step");
  for (const [path, entry] of Object.entries<Record<string, string>>(publisherToolLock.packages)) {
    if (!path) continue;
    assert.match(entry.version, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
    assert.match(entry.integrity, /^sha512-/);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  }
});

test("contract rejects manual branch dispatch and missing root/Matrix evidence", () => {
  const withDispatch = workflow.replace("  push:\n", "  workflow_dispatch:\n  push:\n");
  assert.ok(contractErrors(withDispatch).includes("manual branch dispatch is forbidden"));

  const withoutGate = workflow.replace("npm run gate:release -- --output vscode-release-gate.json", "npm run build");
  assert.ok(contractErrors(withoutGate).includes("full root release gate receipt is missing"));

  const withoutReceipt = workflow.replace(
    'copyFileSync("vscode-release-gate.json", resolve(candidateDirectory, "root-release-gate.json"));',
    "",
  );
  assert.ok(contractErrors(withoutReceipt).includes("root gate and Matrix receipts are not carried into the immutable artifact"));

  const npmPublishCoupled = workflow.replace("releaseGate.publish_ready !== false", "releaseGate.publish_ready !== true");
  assert.ok(contractErrors(npmPublishCoupled).includes("release/Matrix receipt is not fail-closed"),
    "an extension tag cannot impersonate an npm package publication tag");
});

test("contract rejects unlocked tools, floating publishers, and wrong extension tags", () => {
  const unlocked = workflow.replace("npm ci --ignore-scripts", "npm install @vscode/vsce");
  assert.ok(contractErrors(unlocked).includes("publisher tools are not bound to the committed exact lock closure"));
  assert.ok(contractErrors(unlocked).includes("floating publisher installation is forbidden"));

  const wrongTag = workflow.replace('EXPECTED_TAG="vscode-v${EXTENSION_VERSION}"', 'EXPECTED_TAG="vscode-latest"');
  assert.ok(contractErrors(wrongTag).includes("tag, extension version, and HEAD are not bound exactly"));
});

test("contract rejects sensitive VSIX paths, traversal gaps, artifact substitution, and byte mismatch", () => {
  const noHunchDeny = workflow.replaceAll('segment.startsWith(".hunch")', "false");
  assert.ok(contractErrors(noHunchDeny).includes("VSIX traversal/private-path denylist and content allowlist are incomplete"));

  const noTraversal = workflow.replaceAll('segment === ".."', "false");
  assert.ok(contractErrors(noTraversal).includes("VSIX traversal/private-path denylist and content allowlist are incomplete"));

  const noCredentialBasenames = workflow.replaceAll("secrets?|credentials?", "safe-name");
  assert.ok(contractErrors(noCredentialBasenames).includes("VSIX traversal/private-path denylist and content allowlist are incomplete"));

  const allowsSymlinks = workflow.replaceAll("fileType !== 0 && fileType !== expectedFileType", "false");
  assert.ok(contractErrors(allowsSymlinks).includes("VSIX traversal/private-path denylist and content allowlist are incomplete"));

  const substituted = workflow.replace(`name: ${candidateArtifact}`, "name: vscode-release-candidate-untrusted");
  assert.ok(contractErrors(substituted).includes("validated VSIX candidate is not uploaded immutably"));

  const withoutByteCheck = workflow.replace("actualVsixSha256 !== manifest.artifact.sha256", "false");
  assert.ok(contractErrors(withoutByteCheck).includes("publish job does not reject receipt, byte, path-manifest, multiplicity, or source mismatches"));

  const unstableRerunArtifact = workflow.replaceAll(candidateArtifact, `${candidateArtifact}-\${{ github.run_attempt }}`);
  assert.ok(contractErrors(unstableRerunArtifact).includes("validated VSIX candidate is not uploaded immutably"));
});

test("contract rejects historical-secret access, non-idempotent republish, and one-registry success", () => {
  const noEnvironment = workflow.replace("    environment: vscode-publish\n", "");
  assert.ok(contractErrors(noEnvironment).includes("publisher credentials are not restricted to the new protected environment"));

  const nonIdempotent = workflow.replace(
    "id: vsce\n        if: steps.registry-preflight.outputs.marketplace_present != 'true'",
    "id: vsce\n        if: always()",
  );
  assert.ok(contractErrors(nonIdempotent).includes("VS Code Marketplace failure is not isolated or an exact existing version is not idempotent"));

  const oneRegistryEnough = workflow.replace("!marketplace.verified || !openVsx.verified", "!marketplace.verified && !openVsx.verified");
  assert.ok(contractErrors(oneRegistryEnough).includes("both registries are not required to converge on the exact identity, version, and VSIX bytes"));

  const noRegistryByteProof = workflow.replaceAll("assetSha256 !== expectedVsixSha256", "false");
  assert.ok(contractErrors(noRegistryByteProof).includes("both registries are not required to converge on the exact identity, version, and VSIX bytes"));

  const noPublicationReceipt = workflow.replace('schema: "hunch.vscode-publication.v1"', 'schema: "unverified"');
  assert.ok(contractErrors(noPublicationReceipt).includes("idempotent dual-registry publication lacks a content-addressed receipt"));
});
