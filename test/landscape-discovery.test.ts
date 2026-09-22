import { cleanupDir } from "./fixtures.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepositoryLandscape } from "../src/extractors/landscapeDiscovery.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeJson(root: string, path: string, value: unknown): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addGitlink(root: string, path: string, revision: string): void {
  git(root, "update-index", "--add", "--cacheinfo", `160000,${revision},${path}`);
}

function repository(t: test.TestContext, input: {
  rootManifest: Record<string, unknown>;
  manifests?: Array<{ path: string; value: unknown; raw?: boolean }>;
  files?: Array<{ path: string; value: unknown; raw?: boolean }>;
  remote?: string;
}): { root: string; revision: string } {
  const root = mkdtempSync(join(tmpdir(), "hunch-landscape-discovery-"));
  // Keep fixture repositories synchronous. Auto-maintenance may outlive the Git command that
  // triggered it and recreate .git entries while Node is removing the temporary repository.
  // The retry window is a bounded backstop for filesystem latency, not the primary coordination.
  t.after(() => cleanupDir(root));
  git(root, "init", "-q");
  git(root, "config", "maintenance.auto", "false");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "user.name", "Hunch Test");
  git(root, "config", "user.email", "hunch@example.test");
  writeJson(root, "package.json", input.rootManifest);
  for (const manifest of input.manifests ?? []) {
    if (manifest.raw) {
      const target = join(root, manifest.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, String(manifest.value), "utf8");
    } else {
      writeJson(root, manifest.path, manifest.value);
    }
  }
  for (const file of input.files ?? []) {
    if (file.raw) {
      const target = join(root, file.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, String(file.value), "utf8");
    } else {
      writeJson(root, file.path, file.value);
    }
  }
  git(root, "add", "--", "package.json",
    ...(input.manifests ?? []).map((manifest) => manifest.path),
    ...(input.files ?? []).map((file) => file.path));
  git(root, "commit", "-qm", "fixture");
  if (input.remote) git(root, "remote", "add", "origin", input.remote);
  return { root, revision: git(root, "rev-parse", "HEAD") };
}

test("HLG-2 discovers exact package/workspace and credential-free Git-remote candidates deterministically", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
      repository: "git+https://github.com/Acme/Platform.git",
    },
    manifests: [
      { path: "packages/api/package.json", value: { name: "@acme/api", version: "2.0.0" } },
      { path: "packages/web/package.json", value: { name: "@acme/web", version: "3.0.0" } },
      { path: "packages/nested/tool/package.json", value: { name: "@acme/not-a-direct-workspace" } },
    ],
    remote: "https://build-user:topsecret-token@github.com/Acme/Platform.git",
  });

  const first = discoverRepositoryLandscape(root, "HEAD");
  const second = discoverRepositoryLandscape(root, revision);
  assert.deepEqual(second, first, "the exact commit and canonical remote declaration are deterministic");
  assert.equal(first.schema, "hunch.landscape-discovery/1");
  assert.equal(first.authority, "candidate");
  assert.equal(first.sourceRevision, revision);
  assert.deepEqual(first.issues, []);
  assert.deepEqual(first.resources.map((item) => item.record.id), [
    "package:npm/@acme/api",
    "package:npm/@acme/platform",
    "package:npm/@acme/web",
    "repository:github.com/acme/platform",
  ]);
  assert.equal(first.relationships.length, 3);
  assert.ok(first.relationships.every((item) => item.record.type === "contains"));
  assert.ok(first.resources.every((item) => item.authority === "candidate"));
  assert.ok(first.resources.every((item) => item.record.metadata.discovery_authority === "candidate"));
  assert.ok(first.resources.every((item) => item.evidence.every((evidence) => evidence.sourceRevision === revision)));
  assert.match(first.resources.find((item) => item.record.kind === "repository")!.record.locator!, /^https:\/\/github\.com\/acme\/platform$/);
  assert.doesNotMatch(JSON.stringify(first), /topsecret|build-user/i, "credentials and transport usernames never enter candidates");
  assert.equal(existsSync(join(root, ".hunch")), false, "discovery is read-only and does not create graph state");

  const committedManifest = readFileSync(join(root, "package.json"), "utf8");
  writeJson(root, "package.json", { name: "@acme/working-copy", workspaces: [] });
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first, "working-tree manifest edits cannot change an exact-revision result");
  writeFileSync(join(root, "package.json"), committedManifest, "utf8");
});

test("HLG-2 treats a hostile ref as an operand, never as a Git output option", (t) => {
  const { root } = repository(t, { rootManifest: { name: "@acme/ref-boundary" } });
  const output = join(root, "REF_OPTION_MUST_NOT_WRITE");
  assert.throws(
    () => discoverRepositoryLandscape(root, `--output=${output}`),
    /requires a Git repository and an exact Git commit/,
  );
  assert.equal(existsSync(`${output}^{commit}`), false, "Git must not reinterpret the hostile ref as --output");
  assert.equal(existsSync(output), false);
});

test("HLG-2 preserves conflicting repository declarations as uncertainty instead of choosing authority", (t) => {
  const { root } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      workspaces: ["packages/*"],
      repository: "https://github.com/acme/platform.git",
    },
    manifests: [{ path: "packages/api/package.json", value: { name: "@acme/api" } }],
    remote: "git@github.com:acme/different-repository.git",
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "repository_identity_conflict"));
  assert.equal(result.resources.some((item) => item.record.kind === "repository"), false);
  assert.equal(result.relationships.length, 0, "packages remain unbound while repository identity is ambiguous");
  assert.ok(result.resources.every((item) => item.record.scope.length === 0));
});

test("HLG-2 shared tree snapshot preserves fail-closed modes for exact declaration paths", (t) => {
  const { root } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      repository: "https://github.com/acme/platform.git",
    },
    files: [
      { path: ".mcp.json/placeholder", value: "directory", raw: true },
      { path: ".github/CODEOWNERS/placeholder", value: "directory", raw: true },
      { path: ".gitmodules/placeholder", value: "directory", raw: true },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_config_mode"
    && issue.sourcePath === ".mcp.json"));
  assert.ok(result.issues.some((issue) => issue.code === "ownership_declaration_mode"
    && issue.sourcePath === ".github/CODEOWNERS"));
  assert.ok(result.issues.some((issue) => issue.code === "submodule_declaration_mode"
    && issue.sourcePath === ".gitmodules"));
});

test("HLG-2 dependency trees cannot manufacture or crowd out first-party declarations", (t) => {
  const dependencyRunbooks = Array.from({ length: 129 }, (_, index) => ({
    path: `node_modules/dependency-${index}/runbooks/private-${index}.md`,
    value: `# dependency-private-runbook-${index}\n`,
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      ...dependencyRunbooks,
      { path: "node_modules/dependency/openapi.yaml", value: "openapi: 3.1.0\n", raw: true },
      { path: "vendor/gem/db/migrate/20260826010101_private.rb", value: "class PrivateMigration; end\n", raw: true },
      { path: "third_party/service/Dockerfile", value: "FROM dependency-private-image\n", raw: true },
      { path: "third-party/service/runbooks/private.md", value: "# dependency-private-operations\n", raw: true },
      { path: "api/openapi.yaml", value: "openapi: 3.1.0\n", raw: true },
      { path: "RUNBOOK.md", value: "# First-party operations\n", raw: true },
      { path: "Dockerfile", value: "FROM node:24-alpine\n", raw: true },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.deepEqual(result.resources.filter((item) => item.record.kind === "api")
    .map((item) => item.record.locator), ["api/openapi.yaml"]);
  assert.deepEqual(result.resources.filter((item) => item.record.kind === "runbook")
    .map((item) => item.record.locator), ["RUNBOOK.md"]);
  assert.deepEqual(result.resources.filter((item) => item.record.kind === "artifact")
    .map((item) => item.record.locator), ["Dockerfile"]);
  assert.equal(result.issues.some((issue) => issue.code.endsWith("_declaration_limit")), false,
    "dependency-owned files must be ignored before first-party declaration caps");
  assert.doesNotMatch(JSON.stringify(result), /node_modules|third[_-]party|vendor\/gem|dependency-private/i);
});

test("HLG-2 discovers exact internal workspace dependencies without retaining version specifiers", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      version: "1.0.0",
      repository: "https://github.com/acme/platform.git",
      workspaces: ["packages/*"],
      dependencies: { "@acme/api": "https://private-user:private-token@registry.example.test/api.tgz" },
      devDependencies: { "@acme/api": "workspace:*", external: "private-external-specifier" },
    },
    manifests: [
      {
        path: "packages/api/package.json",
        value: { name: "@acme/api", peerDependencies: { "@acme/shared": "^2.0.0" } },
      },
      { path: "packages/shared/package.json", value: { name: "@acme/shared", version: "2.0.0" } },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const dependencies = first.relationships.filter((item) => item.record.type === "depends_on"
    && item.record.from.startsWith("package:"));
  assert.deepEqual(dependencies.map((item) => [item.record.from, item.record.to])
    .sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000"))), [
    ["package:npm/@acme/api", "package:npm/@acme/shared"],
    ["package:npm/@acme/platform", "package:npm/@acme/api"],
  ]);
  const platformDependency = dependencies.find((item) => item.record.from.endsWith("/@acme/platform"))!;
  assert.deepEqual(platformDependency.record.metadata.dependency_fields, ["dependencies", "devDependencies"]);
  assert.deepEqual(platformDependency.evidence.map((item) => item.sourceField), [
    "dependencies.@acme/api",
    "devDependencies.@acme/api",
    "name",
  ]);
  assert.ok(dependencies.every((item) => item.authority === "candidate"));
  assert.ok(dependencies.every((item) => item.evidence.every((evidence) => evidence.sourceRevision === revision)));
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /private-user|private-token|private-external-specifier|registry\.example/i);

  writeJson(root, "package.json", {
    name: "@acme/platform",
    workspaces: ["packages/*"],
    dependencies: { "@acme/shared": "working-copy-only" },
  });
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree dependency edits cannot alter exact-revision discovery");
});

test("HLG-2 leaves duplicate workspace package identities unresolved", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/root", workspaces: ["packages/*"] },
    manifests: [
      { path: "packages/a/package.json", value: { name: "@acme/duplicate" } },
      { path: "packages/b/package.json", value: { name: "@acme/duplicate" } },
      {
        path: "packages/consumer/package.json",
        value: { name: "@acme/consumer", dependencies: { "@acme/duplicate": "workspace:*" } },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "package_identity_conflict"));
  assert.equal(result.resources.some((item) => item.record.id === "package:npm/@acme/duplicate"), false);
  assert.equal(result.relationships.some((item) => item.record.type === "depends_on"), false);
  assert.equal(new Set(result.resources.map((item) => item.record.id)).size, result.resources.length);
});

test("HLG-2 reports malformed and self-referential workspace dependencies", (t) => {
  const { root } = repository(t, {
    rootManifest: {
      name: "@acme/root",
      workspaces: ["packages/*"],
      dependencies: { "@acme/root": "workspace:*", "@acme/tool": 42 },
      peerDependencies: ["@acme/tool"],
    },
    manifests: [{ path: "packages/tool/package.json", value: { name: "@acme/tool" } }],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.issues.filter((issue) => issue.code === "package_dependency_invalid").length, 3);
  assert.equal(result.relationships.some((item) => item.record.type === "depends_on"), false);
  assert.doesNotMatch(JSON.stringify(result), /workspace:\*/i, "dependency specifier bodies are never retained");
});

test("HLG-2 bounds internal workspace dependency relationships", (t) => {
  const names = ["@acme/root", ...Array.from({ length: 24 }, (_, index) => `@acme/package-${index}`)];
  const dependenciesFor = (name: string): Record<string, string> => Object.fromEntries(
    names.filter((candidate) => candidate !== name).map((candidate) => [candidate, "workspace:*"]),
  );
  const { root } = repository(t, {
    rootManifest: {
      name: names[0],
      workspaces: ["packages/*"],
      dependencies: dependenciesFor(names[0]!),
    },
    manifests: names.slice(1).map((name, index) => ({
      path: `packages/p${String(index).padStart(2, "0")}/package.json`,
      value: { name, dependencies: dependenciesFor(name) },
    })),
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "package_dependency_limit"));
  assert.equal(result.relationships.filter((item) => item.record.type === "depends_on").length, 512);
});

test("HLG-2 discovers exact committed network submodules without retaining credentials", (t) => {
  const { root, revision: gitlinkRevision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    remote: "git@github.com:acme/platform.git",
  });
  writeFileSync(join(root, ".gitmodules"), `[submodule "sdk-private-label"]
  path = vendor/sdk
  url = https://private-user:private-token@github.com/Acme/SDK.git?access_token=private-query
[submodule "sdk-mirror"]
  path = vendor/sdk-mirror
  url = git@github.com:acme/sdk.git
[submodule "other"]
  path = vendor/other
  url = https://gitlab.com/acme/other.git
`, "utf8");
  git(root, "add", "--", ".gitmodules");
  addGitlink(root, "vendor/sdk", gitlinkRevision);
  addGitlink(root, "vendor/sdk-mirror", gitlinkRevision);
  addGitlink(root, "vendor/other", gitlinkRevision);
  git(root, "commit", "-qm", "add network submodules");
  const revision = git(root, "rev-parse", "HEAD");

  const first = discoverRepositoryLandscape(root, revision);
  const external = first.resources.filter((item) => item.record.kind === "repository"
    && item.record.id !== "repository:github.com/acme/platform");
  assert.deepEqual(external.map((item) => item.record.id), [
    "repository:github.com/acme/sdk",
    "repository:gitlab.com/acme/other",
  ]);
  const sdk = external.find((item) => item.record.id.endsWith("/acme/sdk"))!;
  assert.equal(sdk.record.locator, "https://github.com/acme/sdk");
  assert.deepEqual(sdk.record.metadata.declaration_paths, ["vendor/sdk", "vendor/sdk-mirror"]);
  assert.deepEqual(sdk.record.metadata.gitlink_revisions, [gitlinkRevision]);
  assert.ok(sdk.evidence.every((item) => item.kind === "submodule_declaration"));
  assert.ok(sdk.evidence.every((item) => item.sourceRevision === revision));
  const dependencies = first.relationships.filter((item) => item.record.type === "depends_on"
    && item.record.to.startsWith("repository:"));
  assert.equal(dependencies.length, 2);
  assert.ok(dependencies.every((item) => item.record.from === "repository:github.com/acme/platform"));
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /sdk-private-label|private-user|private-token|private-query|access_token/i);

  writeFileSync(join(root, ".gitmodules"), "[submodule \"changed\"]\npath = changed\nurl = ../working-copy\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree .gitmodules edits cannot alter exact-revision discovery");
});

test("HLG-2 leaves local, missing-gitlink and self-referential submodules unresolved", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  writeFileSync(join(root, ".gitmodules"), `[submodule "local"]
  path = vendor/local
  url = ../private-local-repository
[submodule "missing"]
  path = vendor/missing
  url = https://github.com/acme/missing.git
[submodule "self"]
  path = vendor/self
  url = https://github.com/acme/platform.git
[submodule "unsupported"]
  path = vendor/unsupported
  url = data:text/plain,private-inline-repository
`, "utf8");
  git(root, "add", "--", ".gitmodules");
  addGitlink(root, "vendor/local", revision);
  addGitlink(root, "vendor/self", revision);
  addGitlink(root, "vendor/unsupported", revision);
  git(root, "commit", "-qm", "add invalid submodule declarations");

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.issues.filter((issue) => issue.code === "submodule_declaration_invalid").length, 4);
  assert.equal(result.resources.filter((item) => item.record.kind === "repository").length, 1);
  assert.equal(result.relationships.some((item) => item.record.to.startsWith("repository:")
    && item.record.type === "depends_on"), false);
  assert.doesNotMatch(JSON.stringify(result), /private-local-repository|private-inline-repository/i);
});

test("HLG-2 bounds committed Git submodule declarations", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  const declarations = Array.from({ length: 33 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return `[submodule "module-${suffix}"]\npath = vendor/module-${suffix}\nurl = https://github.com/acme/module-${suffix}.git\n`;
  }).join("");
  writeFileSync(join(root, ".gitmodules"), declarations, "utf8");
  git(root, "add", "--", ".gitmodules");
  for (let index = 0; index < 33; index += 1) {
    addGitlink(root, `vendor/module-${String(index).padStart(2, "0")}`, revision);
  }
  git(root, "commit", "-qm", "add many submodules");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "submodule_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "repository").length, 33,
    "the root plus the first 32 bounded external repositories remain");
  assert.equal(result.relationships.filter((item) => item.record.type === "depends_on"
    && item.record.to.startsWith("repository:")).length, 32);
  assert.equal(result.resources.some((item) => item.record.id.endsWith("/module-32")), false);
});

test("HLG-2 rejects oversized .gitmodules without retaining its body", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  writeFileSync(join(root, ".gitmodules"), `[submodule "private-oversized-module"]\npath = vendor/private\nurl = https://github.com/acme/private.git\n${"# private submodule context\n".repeat(12_000)}`, "utf8");
  git(root, "add", "--", ".gitmodules");
  git(root, "commit", "-qm", "add oversized .gitmodules");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "submodule_declaration_oversized"));
  assert.equal(result.resources.filter((item) => item.record.kind === "repository").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-oversized-module|private submodule context/i);
});

test("HLG-2 discovers the exact repository-wide GitHub team owner without retaining people or path rules", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      repository: "https://github.com/Acme/Platform.git",
    },
    files: [
      {
        path: ".github/CODEOWNERS",
        raw: true,
        value: `# private ownership notes are not evidence output
* @Acme/Platform @private-person private-owner@example.test
/services/payments/** @Acme/Payments
* @ACME/Final-Team @acme/final-team @another-person
`,
      },
      { path: "CODEOWNERS", raw: true, value: "* @acme/root-team\n" },
      { path: "docs/CODEOWNERS", raw: true, value: "* @acme/docs-team\n" },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const teams = first.resources.filter((item) => item.record.kind === "team_ref");
  assert.deepEqual(teams.map((item) => item.record.id), ["team_ref:github.com/acme/final-team"]);
  assert.equal(teams[0]!.record.name, "@acme/final-team");
  assert.equal(teams[0]!.record.locator, "https://github.com/orgs/acme/teams/final-team");
  assert.equal(teams[0]!.evidence[0]!.kind, "ownership_declaration");
  assert.equal(teams[0]!.evidence[0]!.sourcePath, ".github/CODEOWNERS");
  assert.equal(teams[0]!.evidence[0]!.sourceField, "default-owner");
  assert.equal(teams[0]!.evidence[0]!.sourceRevision, revision);
  const ownership = first.relationships.filter((item) => item.record.type === "owned_by");
  assert.equal(ownership.length, 1);
  assert.equal(ownership[0]!.record.from, "repository:github.com/acme/platform");
  assert.equal(ownership[0]!.record.to, "team_ref:github.com/acme/final-team");
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /private ownership notes|private-person|private-owner|payments|root-team|docs-team/i);

  writeFileSync(join(root, ".github/CODEOWNERS"), "* @acme/working-copy-team\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree CODEOWNERS changes cannot alter exact-revision discovery");
});

test("HLG-2 bounds repository-wide GitHub team owners deterministically", (t) => {
  const owners = Array.from({ length: 33 }, (_, index) => `@acme/team-${String(index).padStart(2, "0")}`);
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [{ path: ".github/CODEOWNERS", raw: true, value: `* ${owners.reverse().join(" ")}\n` }],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "ownership_declaration_limit"));
  const teams = result.resources.filter((item) => item.record.kind === "team_ref");
  assert.equal(teams.length, 32);
  assert.equal(teams.some((item) => item.record.id.endsWith("/team-32")), false);
  assert.equal(result.relationships.filter((item) => item.record.type === "owned_by").length, 32);
});

test("HLG-2 rejects oversized CODEOWNERS without retaining its body", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [{
      path: ".github/CODEOWNERS",
      raw: true,
      value: `* @acme/private-oversized-team\n${"# private ownership context\n".repeat(12_000)}`,
    }],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "ownership_declaration_oversized"));
  assert.equal(result.resources.some((item) => item.record.kind === "team_ref"), false);
  assert.doesNotMatch(JSON.stringify(result), /private-oversized-team|private ownership context/i);
});

test("HLG-2 rejects non-UTF-8 CODEOWNERS without returning its bytes", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github/CODEOWNERS"), Buffer.from([0x2a, 0x20, 0x40, 0xff, 0xfe, 0x0a]));
  git(root, "add", "--", ".github/CODEOWNERS");
  git(root, "commit", "-qm", "add non-UTF-8 CODEOWNERS");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "ownership_declaration_invalid"));
  assert.equal(result.resources.some((item) => item.record.kind === "team_ref"), false);
  assert.doesNotMatch(JSON.stringify(result), /�/);
});

test("HLG-2 never follows a precedence-selected CODEOWNERS symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [{ path: "CODEOWNERS", raw: true, value: "* @acme/lower-precedence-team\n" }],
  });
  mkdirSync(join(root, ".github"), { recursive: true });
  symlinkSync("../package.json", join(root, ".github/CODEOWNERS"));
  git(root, "add", "--", ".github/CODEOWNERS");
  git(root, "commit", "-qm", "add CODEOWNERS symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "ownership_declaration_mode"
    && issue.sourcePath === ".github/CODEOWNERS"));
  assert.equal(result.resources.some((item) => item.record.kind === "team_ref"), false);
  assert.doesNotMatch(JSON.stringify(result), /lower-precedence-team/i);
});

test("HLG-2 discovers exact committed runbooks without retaining operational bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "RUNBOOK.md", raw: true, value: "# Platform recovery\nUse private-root-password during the hidden step.\n" },
      { path: "docs/runbooks/payments-outage.mdx", raw: true, value: "# Payments\nBearer private-incident-token\n" },
      { path: "runbooks/README.md", raw: true, value: "private runbook index\n" },
      { path: "docs/architecture.md", raw: true, value: "# Not an operations declaration\n" },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const runbooks = first.resources.filter((item) => item.record.kind === "runbook");
  assert.deepEqual(runbooks.map((item) => item.record.id), [
    "runbook:repository/RUNBOOK.md",
    "runbook:repository/docs/runbooks/payments-outage.mdx",
  ]);
  assert.deepEqual(runbooks.map((item) => item.record.locator), [
    "RUNBOOK.md",
    "docs/runbooks/payments-outage.mdx",
  ]);
  assert.deepEqual(runbooks.map((item) => item.record.metadata.declaration_format), ["markdown", "mdx"]);
  assert.ok(runbooks.every((item) => item.evidence[0]!.kind === "operations_declaration"));
  assert.ok(runbooks.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("runbook:")).length, 2);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /private-root-password|private-incident-token|private runbook index|Not an operations declaration/i);

  writeFileSync(join(root, "RUNBOOK.md"), "# working-copy-only\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree runbook changes cannot alter exact-revision discovery");
});

test("HLG-2 reports unsafe, empty, oversized, and non-UTF-8 runbooks without returning their bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "docs/runbooks/empty.md", raw: true, value: "  \n\t\n" },
      { path: "docs/runbooks/token=private.md", raw: true, value: "private unsafe path body\n" },
      { path: "docs/runbooks/oversized.md", raw: true, value: "private oversized body\n".repeat(50_000) },
    ],
  });
  mkdirSync(join(root, "runbooks"), { recursive: true });
  writeFileSync(join(root, "runbooks/binary.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  git(root, "add", "--", "runbooks/binary.md");
  git(root, "commit", "-qm", "add binary runbook");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "operations_declaration_invalid"
    && issue.sourcePath === "docs/runbooks/empty.md"));
  assert.ok(result.issues.some((issue) => issue.code === "operations_declaration_invalid"
    && issue.sourcePath === "runbooks/binary.md"));
  assert.ok(result.issues.some((issue) => issue.code === "operations_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "operations_declaration_path"));
  assert.equal(result.resources.some((item) => item.record.kind === "runbook"), false);
  assert.doesNotMatch(JSON.stringify(result), /private unsafe path body|private oversized body|�/i);
});

test("HLG-2 bounds runbooks before blob hydration and never follows their symlinks", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `docs/runbooks/runbook-${String(index).padStart(3, "0")}.md`,
    value: `# Runbook ${index}\nprivate-body-${index}\n`,
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });
  symlinkSync("package.json", join(root, "RUNBOOK.md"));
  git(root, "add", "--", "RUNBOOK.md");
  git(root, "commit", "-qm", "add runbook symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "operations_declaration_limit"));
  assert.ok(result.issues.some((issue) => issue.code === "operations_declaration_mode"
    && issue.sourcePath === "RUNBOOK.md"));
  assert.equal(result.resources.filter((item) => item.record.kind === "runbook").length, 127,
    "the lexically first 128 declarations include the rejected symlink and 127 ordinary runbooks");
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("runbook:")).length, 127);
  assert.equal(result.resources.some((item) => item.record.id.endsWith("runbook-127.md")), false);
});

test("HLG-2 discovers exact committed JSON dashboards without retaining their bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "grafana/dashboards/team/payments.json",
        value: { title: "Private payments health", panels: [{ query: "private-payment-query" }] },
      },
      {
        path: "ops/dashboards/platform.json",
        value: { uid: "private-dashboard-uid", datasource: "private-datasource", links: ["https://private.example.test"] },
      },
      {
        path: "ops/dashboards/platform-copy.json",
        value: { uid: "private-dashboard-uid", datasource: "private-datasource", links: ["https://private.example.test"] },
      },
      { path: "dashboards/README.md", value: "private dashboard instructions", raw: true },
      { path: "dashboards/platform.yaml", value: "title: ignored-private-dashboard", raw: true },
      { path: "node_modules/dependency/dashboards/vendor.json", value: { title: "dependency-private-dashboard" } },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const dashboards = first.resources.filter((item) => item.record.kind === "dashboard");
  assert.deepEqual(dashboards.map((item) => item.record.locator), [
    "grafana/dashboards/team/payments.json",
    "ops/dashboards/platform-copy.json",
    "ops/dashboards/platform.json",
  ]);
  assert.ok(dashboards.every((item) => item.evidence[0]!.kind === "dashboard_declaration"));
  assert.ok(dashboards.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("dashboard:")).length, 3);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /Private payments|private-payment|private-dashboard|private-datasource|private\.example|dashboard instructions|ignored-private|dependency-private/i);

  writeJson(root, "ops/dashboards/platform.json", { title: "working-copy-only" });
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree dashboard changes cannot alter exact-revision discovery");
});

test("HLG-2 rejects unsafe, malformed, oversized, and non-UTF-8 dashboard declarations without returning bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "dashboards/malformed.json", value: "{ private malformed dashboard", raw: true },
      { path: "dashboards/array.json", value: ["private-array-dashboard"] },
      { path: "dashboards/token=private.json", value: { title: "private unsafe dashboard" } },
      { path: "dashboards/oversized.json", value: { privateBody: "x".repeat(1024 * 1024) } },
    ],
  });
  writeFileSync(join(root, "dashboards/binary.json"), Buffer.from([0xff, 0xfe, 0xfd]));
  git(root, "add", "--", "dashboards/binary.json");
  git(root, "commit", "-qm", "add binary dashboard");

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "dashboard"), false);
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_invalid"
    && issue.sourcePath === "dashboards/malformed.json"));
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_invalid"
    && issue.sourcePath === "dashboards/array.json"));
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_invalid"
    && issue.sourcePath === "dashboards/binary.json"));
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /private malformed|private-array|private unsafe|privateBody|�/i);
});

test("HLG-2 bounds dashboards before blob hydration and never follows their symlinks", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `dashboards/dashboard-${String(index).padStart(3, "0")}.json`,
    value: { title: `private-dashboard-body-${index}` },
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });
  symlinkSync("../package.json", join(root, "dashboards/000-symlink.json"));
  git(root, "add", "--", "dashboards/000-symlink.json");
  git(root, "commit", "-qm", "add dashboard symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_limit"));
  assert.ok(result.issues.some((issue) => issue.code === "dashboard_declaration_mode"
    && issue.sourcePath === "dashboards/000-symlink.json"));
  assert.equal(result.resources.filter((item) => item.record.kind === "dashboard").length, 127);
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("dashboard:")).length, 127);
  assert.equal(result.resources.some((item) => item.record.id.endsWith("dashboard-127.json")), false);
  assert.doesNotMatch(JSON.stringify(result), /private-dashboard-body/i);
});

test("HLG-2 discovers exact OpenSLO v1 declarations without retaining objective bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "slo/payments.yaml",
        raw: true,
        value: `apiVersion: openslo/v1
kind: SLO
metadata:
  name: private-payments-slo
spec:
  service: private-payments-service
  objectives:
    - target: 0.999
      query: private-payment-query
`,
      },
      {
        path: "services/catalog/openslo.json",
        value: {
          apiVersion: "openslo/v1",
          kind: "SLO",
          metadata: { name: "private-catalog-slo", labels: { team: "private-team" } },
          spec: { service: "private-catalog-service", objectives: [{ target: 0.98 }] },
        },
      },
      { path: "docs/reliability.yaml", raw: true, value: "apiVersion: openslo/v1\nkind: SLO\nprivate: ignored\n" },
      {
        path: "node_modules/dependency/slos/vendor.yaml",
        raw: true,
        value: "apiVersion: openslo/v1\nkind: SLO\nmetadata:\n  name: dependency-private-slo\n",
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const slos = first.resources.filter((item) => item.record.kind === "slo");
  assert.deepEqual(slos.map((item) => item.record.locator), [
    "services/catalog/openslo.json",
    "slo/payments.yaml",
  ]);
  assert.deepEqual(slos.map((item) => item.record.contract_version), ["openslo/v1", "openslo/v1"]);
  assert.deepEqual(slos.map((item) => item.record.metadata.declaration_format), ["json", "yaml"]);
  assert.ok(slos.every((item) => item.evidence[0]!.kind === "slo_declaration"));
  assert.ok(slos.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("slo:")).length, 2);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /private-payments|private-catalog|private-team|private-payment-query|dependency-private/i);

  writeFileSync(join(root, "slo/payments.yaml"), "working-copy-only\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree SLO changes cannot alter exact-revision discovery");
});

test("HLG-2 rejects unsafe, malformed, oversized, and non-UTF-8 OpenSLO declarations", (t) => {
  const validHeader = "apiVersion: openslo/v1\nkind: SLO\nmetadata:\n  name: private-slo\n";
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "slos/malformed.yaml", raw: true, value: "apiVersion: openslo/v1\nkind: [private malformed" },
      { path: "slos/wrong-kind.yaml", raw: true, value: "apiVersion: openslo/v1\nkind: Service\nmetadata:\n  name: private-service\n" },
      { path: "slos/multiple.yaml", raw: true, value: `${validHeader}---\n${validHeader}` },
      { path: "slos/missing-name.json", value: { apiVersion: "openslo/v1", kind: "SLO", metadata: {} } },
      { path: "slos/token=private.yaml", raw: true, value: `${validHeader}spec:\n  private: unsafe\n` },
      { path: "slos/oversized.yaml", raw: true, value: `${validHeader}${"# private oversized body\n".repeat(50_000)}` },
    ],
  });
  mkdirSync(join(root, "slos"), { recursive: true });
  writeFileSync(join(root, "slos/binary.yaml"), Buffer.from([0xff, 0xfe, 0xfd]));
  git(root, "add", "--", "slos/binary.yaml");
  git(root, "commit", "-qm", "add binary SLO");

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "slo"), false);
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_invalid"
    && issue.sourcePath === "slos/malformed.yaml"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_invalid"
    && issue.sourcePath === "slos/wrong-kind.yaml"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_invalid"
    && issue.sourcePath === "slos/multiple.yaml"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_invalid"
    && issue.sourcePath === "slos/missing-name.json"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_invalid"
    && issue.sourcePath === "slos/binary.yaml"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /private malformed|private-service|private oversized|spec.*private|�/i);
});

test("HLG-2 bounds OpenSLO declarations before hydration and never follows symlinks", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `slos/slo-${String(index).padStart(3, "0")}.yaml`,
    raw: true,
    value: `apiVersion: openslo/v1\nkind: SLO\nmetadata:\n  name: private-slo-${index}\n`,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });
  mkdirSync(join(root, ".openslo"), { recursive: true });
  symlinkSync("../package.json", join(root, ".openslo/000-symlink.yaml"));
  git(root, "add", "--", ".openslo/000-symlink.yaml");
  git(root, "commit", "-qm", "add SLO symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_limit"));
  assert.ok(result.issues.some((issue) => issue.code === "slo_declaration_mode"
    && issue.sourcePath === ".openslo/000-symlink.yaml"));
  assert.equal(result.resources.filter((item) => item.record.kind === "slo").length, 127);
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("slo:")).length, 127);
  assert.equal(result.resources.some((item) => item.record.id.endsWith("slo-127.yaml")), false);
  assert.doesNotMatch(JSON.stringify(result), /private-slo-/i);
});

test("HLG-2 bounds malformed manifests and unsafe workspace declarations as reviewable issues", (t) => {
  const { root } = repository(t, {
    rootManifest: {
      name: "@acme/platform",
      workspaces: ["packages/*", "../outside", 42],
    },
    manifests: [
      { path: "packages/missing/package.json", value: { version: "1.0.0" } },
      { path: "packages/broken/package.json", value: "{ definitely not json", raw: true },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "workspace_pattern_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "manifest_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "package_name_missing"));
  assert.equal(result.resources.filter((item) => item.record.kind === "package").length, 1);
  assert.equal(result.relationships.length, 1);
});

test("HLG-2 applies the manifest read cap before blob hydration while always retaining the root declaration", (t) => {
  const manifests = Array.from({ length: 130 }, (_, index) => ({
    path: `a${String(index).padStart(3, "0")}/package.json`,
    value: { name: `@acme/package-${index}` },
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/root", workspaces: ["a*"] },
    manifests,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "manifest_limit"));
  assert.ok(result.resources.some((item) => item.record.id === "package:npm/@acme/root"));
  assert.equal(result.resources.filter((item) => item.record.kind === "package").length, 128);
  assert.equal(result.relationships.length, 128);
});

test("HLG-2 discovers exact MCP declarations without exposing commands, arguments, environment, or credentials", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".mcp.json",
        value: { mcpServers: { billing: { url: "https://mcp.acme.test/api" } } },
      },
      {
        path: ".vscode/mcp.json",
        raw: true,
        value: `{
          // The same durable declaration through another supported client.
          "servers": { "billing": { "type": "http", "url": "https://mcp.acme.test/api" }, },
        }`,
      },
      {
        path: ".agents/mcp_config.json",
        value: {
          mcpServers: {
            worker: {
              command: "node",
              args: ["private-server.mjs"],
              env: { MCP_ACCESS_TOKEN: "supersecret-fixture-value" },
            },
          },
        },
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const mcp = first.resources.filter((item) => item.record.kind === "mcp_server");
  assert.deepEqual(mcp.map((item) => item.record.id), [
    "mcp_server:declared/billing",
    "mcp_server:declared/worker",
  ]);
  assert.equal(mcp.find((item) => item.record.id.endsWith("/billing"))!.record.locator, "https://mcp.acme.test/api");
  assert.deepEqual(mcp.find((item) => item.record.id.endsWith("/billing"))!.record.metadata.declaration_paths,
    [".mcp.json", ".vscode/mcp.json"]);
  assert.equal(first.relationships.filter((item) => item.record.type === "depends_on").length, 2);
  assert.ok(mcp.every((item) => item.authority === "candidate"));
  assert.ok(mcp.every((item) => item.evidence.every((evidence) => evidence.kind === "mcp_declaration")));
  assert.doesNotMatch(JSON.stringify(first), /private-server|MCP_ACCESS_TOKEN|supersecret-fixture-value/i);

  writeJson(root, ".mcp.json", { mcpServers: { replacement: { command: "changed-working-copy" } } });
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree MCP changes cannot alter exact-revision discovery");
});

test("HLG-2 discovers canonical Codex TOML and MCP registry declarations with correct edge direction", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".codex/config.toml",
        raw: true,
        value: `model = "gpt-5"

[mcp_servers.worker]
command = "node"
args = [
  "private-worker.mjs",
  "--token=supersecret-codex-argument",
]
env = { MCP_TOKEN = "supersecret-codex-environment" }

[mcp_servers."billing-http"]
url = "https://billing.acme.test/mcp"
`,
      },
      {
        path: "server.json",
        value: {
          $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          name: "io.github.acme/platform-mcp",
          version: "1.2.3",
          packages: [{
            registryType: "npm",
            identifier: "@acme/platform-mcp",
            version: "1.2.3",
            transport: { type: "stdio" },
            packageArguments: [{ type: "positional", value: "supersecret-registry-argument" }],
          }],
        },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.deepEqual(result.resources.filter((item) => item.record.kind === "mcp_server").map((item) => item.record.id), [
    "mcp_server:declared/billing-http",
    "mcp_server:declared/io.github.acme/platform-mcp",
    "mcp_server:declared/worker",
  ]);
  assert.equal(result.resources.find((item) => item.record.id.endsWith("/billing-http"))!.record.locator,
    "https://billing.acme.test/mcp");
  assert.equal(result.resources.find((item) => item.record.id.includes("io.github.acme"))!.record.locator, null);
  assert.deepEqual(result.relationships.filter((item) => item.record.type === "depends_on")
    .map((item) => item.record.to).sort(), [
    "mcp_server:declared/billing-http",
    "mcp_server:declared/worker",
  ]);
  assert.deepEqual(result.relationships.filter((item) => item.record.type === "provides").map((item) => item.record.to), [
    "mcp_server:declared/io.github.acme/platform-mcp",
  ]);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /private-worker|supersecret|MCP_TOKEN|packageArguments/i);
});

test("HLG-2 ignores an unrelated server.json and sanitizes invalid Codex TOML names", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "server.json", value: { name: "ordinary-application-server", port: 8080 } },
      {
        path: ".codex/config.toml",
        raw: true,
        value: `[mcp_servers."token=supersecret-codex-name"]
command = "node"
`,
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_server_name_invalid"));
  assert.equal(result.resources.some((item) => item.record.kind === "mcp_server"), false);
  assert.doesNotMatch(JSON.stringify(result), /supersecret|ordinary-application-server/i);
});

test("HLG-2 leaves conflicting or secret-bearing MCP declarations unresolved without echoing them", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".mcp.json",
        value: {
          mcpServers: {
            "token=supersecret-name": { command: "node" },
            unsafe: { url: "https://mcp.acme.test/api?token=supersecret-url" },
            search: { command: "first-private-command" },
          },
        },
      },
      {
        path: ".windsurf/mcp_config.json",
        value: { mcpServers: { search: { command: "second-private-command" } } },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_server_name_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "mcp_declaration_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "mcp_declaration_conflict"));
  assert.equal(result.resources.some((item) => item.record.kind === "mcp_server"), false);
  assert.doesNotMatch(JSON.stringify(result), /supersecret|first-private-command|second-private-command/i);
});

test("HLG-2 bounds MCP declaration count before candidate construction", (t) => {
  const mcpServers = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [
    `server-${String(index).padStart(3, "0")}`,
    { command: "node", args: [`server-${index}.mjs`] },
  ]));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: ".mcp.json", value: { mcpServers } },
      { path: "server.json", value: { name: "unrelated-server", port: 8080 } },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "mcp_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "mcp_server").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "depends_on").length, 128);
});

test("HLG-2 discovers exact OpenAPI YAML and Swagger JSON contracts without retaining operation bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "contracts/openapi.yaml",
        raw: true,
        value: `openapi: 3.1.0
info:
  title: Payments API
  version: 2026-08-26
paths:
  /payments:
    post:
      description: supersecret-operation-description
      x-private-command: never-retain-this-body
`,
      },
      {
        path: "legacy/petstore.swagger.json",
        value: {
          swagger: "2.0",
          info: { title: "Legacy Petstore", version: "1.0.0" },
          paths: { "/animals": { get: { description: "supersecret-legacy-operation" } } },
        },
      },
      {
        path: "contracts/api.yaml",
        raw: true,
        value: "openapi: 3.1.0\ninfo:\n  title: intentionally outside the fixed filename family\n",
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const apis = first.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:openapi/contracts/openapi.yaml",
    "api:openapi/legacy/petstore.swagger.json",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["3.1.0", "2.0"]);
  assert.deepEqual(apis.map((item) => item.record.metadata.api_dialect), ["openapi", "swagger"]);
  assert.deepEqual(apis.map((item) => item.evidence[0]!.sourceField), ["openapi", "swagger"]);
  assert.ok(apis.every((item) => item.evidence[0]!.kind === "api_declaration"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:")).length, 2);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /supersecret|never-retain-this-body|\/payments|\/animals/i,
    "titles, paths, operations, and extension bodies never enter the candidate fragment");

  writeFileSync(join(root, "contracts/openapi.yaml"), "openapi: 3.0.0\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree API edits cannot alter exact-revision discovery");
});

test("HLG-2 discovers exact AsyncAPI 2/3 contracts without retaining channels, operations, or servers", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/events", repository: "https://github.com/acme/events.git" },
    files: [
      {
        path: "contracts/asyncapi.yaml",
        raw: true,
        value: `asyncapi: 3.0.0
info:
  title: Private Event Mesh
  version: 1.0.0
servers:
  production:
    host: token=never-retain.example.test
channels:
  secret-orders:
    address: private-orders-stream
operations:
  consumeSecretOrders:
    action: receive
`,
      },
      {
        path: "contracts/legacy.orders.asyncapi.json",
        value: {
          asyncapi: "2.6.0",
          info: { title: "Legacy Orders", version: "1.0.0" },
          channels: { "private/orders": { subscribe: { operationId: "neverRetainLegacyOperation" } } },
        },
      },
      {
        path: "contracts/events.yaml",
        raw: true,
        value: "asyncapi: 3.0.0\ninfo:\n  title: outside the fixed filename family\n",
      },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const apis = result.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:asyncapi/contracts/asyncapi.yaml",
    "api:asyncapi/contracts/legacy.orders.asyncapi.json",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["3.0.0", "2.6.0"]);
  assert.ok(apis.every((item) => item.record.metadata.api_dialect === "asyncapi"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceField === "asyncapi"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:asyncapi/")).length, 2);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /never-retain|neverRetain|secret-orders|private-orders|private\/orders/i);
});

test("HLG-2 rejects unsupported, duplicate, and mixed AsyncAPI identities without echoing bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/events", repository: "https://github.com/acme/events.git" },
    files: [
      { path: "contracts/future.asyncapi.yaml", raw: true, value: "asyncapi: 4.0.0\ninfo:\n  title: future-private-title\n" },
      { path: "contracts/mixed.asyncapi.json", value: { asyncapi: "3.0.0", openapi: "3.1.0", private: "mixed-private-body" } },
      { path: "contracts/duplicate.asyncapi.json", raw: true, value: "{\"asyncapi\":\"2.6.0\",\"asyncapi\":\"3.0.0\",\"private\":\"duplicate-private-body\"}" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 3);
  assert.doesNotMatch(JSON.stringify(result), /future-private|mixed-private|duplicate-private/i);
});

test("HLG-2 discovers proto2/proto3 contracts without retaining messages, fields, services, or options", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/rpc", repository: "https://github.com/acme/rpc.git" },
    files: [
      {
        path: "proto/payments.proto",
        raw: true,
        value: `// committed contract, not runtime proof
syntax = "proto3";
package private.payments.v1;
option java_package = "token.never.retain";
message SecretPayment { string private_card = 1; }
service PaymentsService { rpc Charge(SecretPayment) returns (SecretPayment); }
`,
      },
      {
        path: "proto/legacy/orders.proto",
        raw: true,
        value: `/* legacy contract */
syntax="proto2";
package private.legacy;
message LegacyOrder { required string never_retain_field = 1; }
`,
      },
      {
        path: "proto/ignored.proto.txt",
        raw: true,
        value: "syntax = \"proto3\";\nmessage OutsideFixedExtension {}\n",
      },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const apis = result.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:protobuf/proto/legacy/orders.proto",
    "api:protobuf/proto/payments.proto",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["proto2", "proto3"]);
  assert.ok(apis.every((item) => item.record.metadata.api_dialect === "protobuf"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceField === "syntax"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:protobuf/")).length, 2);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|card|Charge|never_retain|token\.never/i);
});

test("HLG-2 rejects missing, unsupported, duplicated, and structurally unclosed protobuf headers", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/rpc", repository: "https://github.com/acme/rpc.git" },
    files: [
      { path: "proto/missing.proto", raw: true, value: "package private.missing;\nmessage NeverRetain {}\n" },
      { path: "proto/unsupported.proto", raw: true, value: "edition = \"2023\";\nmessage PrivateEdition {}\n" },
      { path: "proto/duplicate.proto", raw: true, value: "syntax = \"proto3\";\nsyntax = \"proto2\";\nmessage PrivateDuplicate {}\n" },
      { path: "proto/late.proto", raw: true, value: "package private.first;\nsyntax = \"proto3\";\nmessage PrivateLate {}\n" },
      { path: "proto/unclosed.proto", raw: true, value: "syntax = \"proto3\";\nmessage PrivateUnclosed { string secret = 1;\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 5);
  assert.doesNotMatch(JSON.stringify(result), /NeverRetain|PrivateEdition|PrivateDuplicate|PrivateLate|PrivateUnclosed|secret/i);
});

test("HLG-2 discovers fixed-name JSON Schema dialects without retaining IDs, properties, examples, or bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/contracts", repository: "https://github.com/acme/contracts.git" },
    files: [
      {
        path: "schemas/payment.schema.json",
        value: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://token=never-retain.example.test/private/payment",
          title: "Private Payment",
          properties: { secretCard: { type: "string", examples: ["never-retain-example"] } },
        },
      },
      {
        path: "schemas/legacy.schema.json",
        value: {
          $schema: "http://json-schema.org/draft-07/schema#",
          definitions: { PrivateOrder: { type: "object" } },
        },
      },
      {
        path: "schemas/schema.yaml",
        raw: true,
        value: "$schema: https://json-schema.org/draft/2020-12/schema\ntitle: ignored non-JSON family\n",
      },
      {
        path: "schemas/arbitrary.json",
        value: { $schema: "https://json-schema.org/draft/2020-12/schema", title: "ignored fixed-name miss" },
      },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const apis = result.resources.filter((item) => item.record.kind === "api");
  assert.deepEqual(apis.map((item) => item.record.id), [
    "api:json-schema/schemas/legacy.schema.json",
    "api:json-schema/schemas/payment.schema.json",
  ]);
  assert.deepEqual(apis.map((item) => item.record.contract_version), ["draft-07", "2020-12"]);
  assert.ok(apis.every((item) => item.record.metadata.api_dialect === "jsonschema"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceField === "$schema"));
  assert.ok(apis.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:json-schema/")).length, 2);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /never-retain|secretCard|PrivateOrder|token=|Private Payment/i);
});

test("HLG-2 rejects unsupported, duplicate, and mixed JSON Schema identities without echoing bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/contracts", repository: "https://github.com/acme/contracts.git" },
    files: [
      { path: "schemas/old.schema.json", value: { $schema: "http://json-schema.org/draft-04/schema#", private: "old-private-body" } },
      { path: "schemas/mixed.schema.json", value: { $schema: "https://json-schema.org/draft/2020-12/schema", openapi: "3.1.0", private: "mixed-private-body" } },
      { path: "schemas/duplicate.schema.json", raw: true, value: "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$schema\":\"https://json-schema.org/draft/2019-09/schema\",\"private\":\"duplicate-private-body\"}" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 3);
  assert.doesNotMatch(JSON.stringify(result), /old-private|mixed-private|duplicate-private/i);
});

test("HLG-2 discovers committed Prisma migration artifacts without retaining SQL bodies or inferring a database", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "prisma/migrations/20260826090000_initial/migration.sql",
        raw: true,
        value: "CREATE TABLE PrivateCustomer (secret_card TEXT);\n",
      },
      {
        path: "packages/billing/prisma/migrations/20260826100000_add_invoice/migration.sql",
        raw: true,
        value: "ALTER TABLE PrivateInvoice ADD COLUMN hidden_token TEXT;\n",
      },
      { path: "prisma/migrations/migration_lock.toml", raw: true, value: "provider = \"postgresql\"\n" },
      { path: "db/migrations/20260826_not_prisma.sql", raw: true, value: "SELECT 'ignored-private-body';\n" },
      { path: "prisma/migrations/20260826110000_wrong/custom.sql", raw: true, value: "SELECT 'ignored-custom-body';\n" },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const migrations = first.resources.filter((item) => item.record.metadata.artifact_type === "database_migration");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/prisma/packages/billing/prisma/migrations/20260826100000_add_invoice/migration.sql",
    "artifact:migration/prisma/prisma/migrations/20260826090000_initial/migration.sql",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), [
    "20260826100000_add_invoice",
    "20260826090000_initial",
  ]);
  assert.ok(migrations.every((item) => item.record.kind === "artifact"));
  assert.ok(migrations.every((item) => item.record.metadata.migration_framework === "prisma"));
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceField === "path"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("artifact:migration/prisma/")).length, 2);
  assert.equal(first.resources.some((item) => item.record.kind === "database"), false);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /PrivateCustomer|secret_card|PrivateInvoice|hidden_token|ignored-private|ignored-custom/i);

  writeFileSync(join(root, "prisma/migrations/20260826090000_initial/migration.sql"), "DROP PRIVATE WORKING COPY;\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree migration edits cannot alter exact-revision discovery");
});

test("HLG-2 rejects empty and oversized Prisma migrations without echoing SQL bodies", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "prisma/migrations/20260826090000_empty/migration.sql", raw: true, value: "  \n\t" },
      {
        path: "prisma/migrations/20260826100000_oversized/migration.sql",
        raw: true,
        value: `-- private migration body\n${"SELECT 'never-retain-oversized';\n".repeat(40_000)}`,
      },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.metadata.artifact_type === "database_migration"), false);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_invalid"));
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_oversized"));
  assert.doesNotMatch(JSON.stringify(result), /never-retain-oversized|private migration body/i);
});

test("HLG-2 rejects non-UTF-8 Prisma migration data without returning its bytes", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  const migrationPath = "prisma/migrations/20260826103000_binary/migration.sql";
  const target = join(root, migrationPath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, Buffer.from([0xff, 0xfe, 0x53, 0x45, 0x43, 0x52, 0x45, 0x54]));
  git(root, "add", "--", migrationPath);
  git(root, "commit", "-qm", "add invalid migration bytes");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_invalid"
    && issue.sourcePath === migrationPath));
  assert.equal(result.resources.some((item) => item.record.metadata.artifact_type === "database_migration"), false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/i);
});

test("HLG-2 bounds Prisma migration count before candidate construction", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `prisma/migrations/20260826${String(index).padStart(6, "0")}_bounded/migration.sql`,
    value: "SELECT 1;\n",
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.metadata.artifact_type === "database_migration").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/prisma/")).length, 128);
});

test("HLG-2 discovers standard Flyway versioned, undo, and repeatable migrations without retaining SQL", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "src/main/resources/db/migration/V1__initial.sql",
        raw: true,
        value: "CREATE TABLE PrivateAccount (hidden_password TEXT);\n",
      },
      {
        path: "db/migration/V2_1__add_invoice.sql",
        raw: true,
        value: "ALTER TABLE PrivateInvoice ADD COLUMN secret_token TEXT;\n",
      },
      {
        path: "db/migration/U2_1__undo_invoice.sql",
        raw: true,
        value: "DROP TABLE NeverRetainUndo;\n",
      },
      {
        path: "db/migration/R__refresh_views.sql",
        raw: true,
        value: "CREATE VIEW PrivateRevenue AS SELECT hidden_total;\n",
      },
      { path: "db/migration/v3__lowercase.sql", raw: true, value: "SELECT 'ignored-lowercase';\n" },
      { path: "db/migration/V3_missing_separator.sql", raw: true, value: "SELECT 'ignored-separator';\n" },
      { path: "db/migration/nested/V4__nested.sql", raw: true, value: "SELECT 'ignored-nested';\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const migrations = result.resources.filter((item) => item.record.metadata.migration_framework === "flyway");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/flyway/db/migration/R__refresh_views.sql",
    "artifact:migration/flyway/db/migration/U2_1__undo_invoice.sql",
    "artifact:migration/flyway/db/migration/V2_1__add_invoice.sql",
    "artifact:migration/flyway/src/main/resources/db/migration/V1__initial.sql",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.metadata.migration_type), [
    "repeatable",
    "undo",
    "versioned",
    "versioned",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), [undefined, "2_1", "2_1", "1"]);
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/flyway/")).length, 4);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /PrivateAccount|hidden_password|PrivateInvoice|secret_token|NeverRetainUndo|PrivateRevenue|hidden_total|ignored-/i);
});

test("HLG-2 discovers conventional Rails migrations without retaining Ruby bodies or inferring schema effects", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "db/migrate/20260826090000_create_records.rb",
        raw: true,
        value: "class CreatePrivateAccounts < ActiveRecord::Migration[8.0]\n  def change; create_table :secret_accounts; end\nend\n",
      },
      {
        path: "services/billing/db/migrate/20260826100000_add_invoice_field.rb",
        raw: true,
        value: "class AddHiddenToken < ActiveRecord::Migration[8.0]\n  def change; add_column :private_invoices, :hidden_token, :string; end\nend\n",
      },
      { path: "db/migrate/123_create_legacy.rb", raw: true, value: "class IgnoredLegacy; end\n" },
      { path: "db/migrate/20260826110000_CreateUpper.rb", raw: true, value: "class IgnoredUpper; end\n" },
      { path: "db/migrations/20260826120000_wrong_directory.rb", raw: true, value: "class IgnoredDirectory; end\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const migrations = result.resources.filter((item) => item.record.metadata.migration_framework === "rails");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/rails/db/migrate/20260826090000_create_records.rb",
    "artifact:migration/rails/services/billing/db/migrate/20260826100000_add_invoice_field.rb",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), ["20260826090000", "20260826100000"]);
  assert.ok(migrations.every((item) => item.record.metadata.migration_type === "versioned"));
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/rails/")).length, 2);
  assert.equal(result.resources.some((item) => item.record.kind === "database"), false);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /CreatePrivateAccounts|secret_accounts|AddHiddenToken|private_invoices|hidden_token|Ignored/i);
});

test("HLG-2 discovers conventional Django migrations without retaining Python bodies or inferring dependencies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "billing/migrations/0001_initial.py",
        raw: true,
        value: "from django.db import migrations, models\nclass Migration(migrations.Migration):\n    operations = [migrations.CreateModel(name='PrivateAccount', fields=[('secret_token', models.TextField())])]\n",
      },
      {
        path: "services/payments/payments/migrations/0002_add_invoice_field.py",
        raw: true,
        value: "from django.db import migrations\nclass Migration(migrations.Migration):\n    dependencies = [('billing', '0001_private_dependency')]\n    operations = []\n",
      },
      { path: "billing/migrations/__init__.py", raw: true, value: "PRIVATE_INIT = True\n" },
      { path: "billing/migrations/012_too_short.py", raw: true, value: "PRIVATE_SHORT = True\n" },
      { path: "billing/migrations/0003-unsafe-name.py", raw: true, value: "PRIVATE_DASH = True\n" },
      { path: "billing/migration/0004_wrong_directory.py", raw: true, value: "PRIVATE_DIRECTORY = True\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const migrations = result.resources.filter((item) => item.record.metadata.migration_framework === "django");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/django/billing/migrations/0001_initial.py",
    "artifact:migration/django/services/payments/payments/migrations/0002_add_invoice_field.py",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), ["0001", "0002"]);
  assert.deepEqual(migrations.map((item) => item.record.metadata.migration_id), ["0001_initial", "0002_add_invoice_field"]);
  assert.ok(migrations.every((item) => item.record.metadata.migration_type === "versioned"));
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/django/")).length, 2);
  assert.equal(result.resources.some((item) => item.record.kind === "database"), false);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /PrivateAccount|secret_token|0001_private_dependency|PRIVATE_INIT|PRIVATE_SHORT|PRIVATE_DASH|PRIVATE_DIRECTORY/i);
});

test("HLG-2 discovers conventional Laravel migrations without retaining PHP bodies or inferring schema effects", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "database/migrations/2026_08_26_090000_create_private_accounts.php",
        raw: true,
        value: "<?php use Illuminate\\Database\\Migrations\\Migration; return new class extends Migration { public function up(): void { Schema::create('secret_accounts', fn ($table) => $table->text('hidden_token')); } };\n",
      },
      {
        path: "services/billing/database/migrations/2026_08_26_100000_add_invoice_field.php",
        raw: true,
        value: "<?php return new class extends Migration { public function up(): void { Schema::table('private_invoices', fn ($table) => $table->string('secret_card')); } };\n",
      },
      { path: "database/migrations/2026_08_26_1000_too_short.php", raw: true, value: "<?php // PRIVATE_SHORT\n" },
      { path: "database/migrations/2026_08_26_110000_CreateUpper.php", raw: true, value: "<?php // PRIVATE_UPPER\n" },
      { path: "database/migration/2026_08_26_120000_wrong_directory.php", raw: true, value: "<?php // PRIVATE_DIRECTORY\n" },
      { path: "migrations/2026_08_26_130000_generic.php", raw: true, value: "<?php // PRIVATE_GENERIC\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const migrations = result.resources.filter((item) => item.record.metadata.migration_framework === "laravel");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/laravel/database/migrations/2026_08_26_090000_create_private_accounts.php",
    "artifact:migration/laravel/services/billing/database/migrations/2026_08_26_100000_add_invoice_field.php",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), ["2026_08_26_090000", "2026_08_26_100000"]);
  assert.deepEqual(migrations.map((item) => item.record.metadata.migration_id), [
    "2026_08_26_090000_create_private_accounts",
    "2026_08_26_100000_add_invoice_field",
  ]);
  assert.ok(migrations.every((item) => item.record.metadata.migration_type === "versioned"));
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/laravel/")).length, 2);
  assert.equal(result.resources.some((item) => item.record.kind === "database"), false);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /secret_accounts|hidden_token|private_invoices|secret_card|PRIVATE_SHORT|PRIVATE_UPPER|PRIVATE_DIRECTORY|PRIVATE_GENERIC/i);
});

test("HLG-2 discovers conventional Alembic revisions without retaining Python bodies or inferring revision edges", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "alembic/versions/1a2b3c4d5e6f_create_private_accounts.py",
        raw: true,
        value: "from alembic import op\nrevision = '1a2b3c4d5e6f'\ndown_revision = None\ndef upgrade(): op.create_table('secret_accounts')\n",
      },
      {
        path: "services/billing/alembic/versions/abcdef123456_add_invoice_field.py",
        raw: true,
        value: "from alembic import op\nrevision = 'abcdef123456'\ndown_revision = 'private_parent'\ndef upgrade(): op.add_column('private_invoices', 'hidden_token')\n",
      },
      { path: "alembic/versions/abc123_too_short.py", raw: true, value: "PRIVATE_SHORT = True\n" },
      { path: "alembic/versions/ABCDEF123456_upper_revision.py", raw: true, value: "PRIVATE_UPPER = True\n" },
      { path: "alembic/version/123456abcdef_wrong_directory.py", raw: true, value: "PRIVATE_DIRECTORY = True\n" },
      { path: "versions/123456abcdef_generic.py", raw: true, value: "PRIVATE_GENERIC = True\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root, revision);
  const migrations = result.resources.filter((item) => item.record.metadata.migration_framework === "alembic");
  assert.deepEqual(migrations.map((item) => item.record.id), [
    "artifact:migration/alembic/alembic/versions/1a2b3c4d5e6f_create_private_accounts.py",
    "artifact:migration/alembic/services/billing/alembic/versions/abcdef123456_add_invoice_field.py",
  ]);
  assert.deepEqual(migrations.map((item) => item.record.contract_version), ["1a2b3c4d5e6f", "abcdef123456"]);
  assert.deepEqual(migrations.map((item) => item.record.metadata.migration_id), [
    "1a2b3c4d5e6f_create_private_accounts",
    "abcdef123456_add_invoice_field",
  ]);
  assert.ok(migrations.every((item) => item.record.metadata.migration_type === "versioned"));
  assert.ok(migrations.every((item) => item.evidence[0]!.kind === "migration_declaration"));
  assert.ok(migrations.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(result.relationships.filter((item) => item.record.to.startsWith("artifact:migration/alembic/")).length, 2);
  assert.equal(result.resources.some((item) => item.record.kind === "database"), false);
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(JSON.stringify(result), /secret_accounts|private_parent|private_invoices|hidden_token|PRIVATE_SHORT|PRIVATE_UPPER|PRIVATE_DIRECTORY|PRIVATE_GENERIC/i);
});

test("HLG-2 reports malformed, unsupported, oversized, and unsafe OpenAPI declarations without echoing content", (t) => {
  const oversized = `openapi: 3.1.0\ninfo:\n  description: |\n${"    bounded declaration data\n".repeat(40_000)}`;
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "contracts/broken.openapi.yaml", raw: true, value: "openapi: 3.1.0\ninfo: [unterminated-private-value" },
      { path: "contracts/future.openapi.yaml", raw: true, value: "openapi: 4.0.0\ninfo:\n  title: unsupported-private-value\n" },
      { path: "contracts/ambiguous.openapi.json", value: { openapi: "3.1.0", swagger: "2.0", private: "do-not-retain" } },
      { path: "contracts/duplicate.openapi.json", raw: true, value: "{\"openapi\":\"3.0.0\",\"openapi\":\"3.1.0\",\"private\":\"duplicate-private-value\"}" },
      { path: "contracts/token=supersecret.openapi.yaml", raw: true, value: "openapi: 3.1.0\n" },
      { path: "contracts/oversized.openapi.yaml", raw: true, value: oversized },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "api_declaration_invalid").length, 4);
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret|unterminated-private|unsupported-private|do-not-retain|duplicate-private/i);
});

test("HLG-2 bounds OpenAPI declaration count before blob hydration and candidate construction", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `contracts/service-${String(index).padStart(3, "0")}.openapi.yaml`,
    value: `openapi: 3.1.0\ninfo:\n  title: Service ${index}\n`,
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "api").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("api:")).length, 128);
});

test("HLG-2 discovers exact CI, container artifact, and Compose deployment candidates without retaining declaration bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: ".github/workflows/release.yml",
        raw: true,
        value: `name: Release
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo supersecret-github-command
`,
      },
      {
        path: ".gitlab-ci.yml",
        raw: true,
        value: `build:
  script:
    - echo supersecret-gitlab-command
`,
      },
      {
        path: ".circleci/config.yml",
        raw: true,
        value: `version: 2.1
jobs:
  build:
    docker:
      - image: private.example.test/supersecret-circle-image
    steps:
      - checkout
`,
      },
      {
        path: ".buildkite/pipeline.yaml",
        raw: true,
        value: `steps:
  - command: echo supersecret-buildkite-command
`,
      },
      {
        path: "Jenkinsfile",
        raw: true,
        value: `pipeline {
  stages { stage('Build') { steps { sh 'echo supersecret-jenkins-command' } } }
}
`,
      },
      {
        path: "Dockerfile",
        raw: true,
        value: `FROM node:24-alpine
ARG PRIVATE_BUILD_VALUE=supersecret-docker-argument
RUN echo "$PRIVATE_BUILD_VALUE"
`,
      },
      {
        path: "deploy/compose.yaml",
        raw: true,
        value: `services:
  api:
    image: private.example.test/supersecret-compose-image
    environment:
      PASSWORD: supersecret-compose-password
`,
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const delivery = first.resources.filter((item) => ["pipeline", "artifact", "deployment_target"].includes(item.record.kind));
  assert.deepEqual(delivery.map((item) => item.record.id), [
    "artifact:container-image/Dockerfile",
    "deployment_target:docker-compose/deploy/compose.yaml",
    "pipeline:buildkite/.buildkite/pipeline.yaml",
    "pipeline:circleci/.circleci/config.yml",
    "pipeline:github-actions/.github/workflows/release.yml",
    "pipeline:gitlab-ci/.gitlab-ci.yml",
    "pipeline:jenkins/Jenkinsfile",
  ]);
  assert.deepEqual(first.issues, []);
  assert.equal(first.relationships.filter((item) => item.record.type === "builds").length, 1);
  assert.equal(first.relationships.filter((item) => item.record.type === "deploys").length, 1);
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("pipeline:")).length, 5);
  assert.ok(delivery.every((item) => item.authority === "candidate"));
  assert.ok(delivery.every((item) => item.evidence.length === 1));
  assert.ok(delivery.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.ok(delivery.every((item) => ["ci_declaration", "deployment_declaration"].includes(item.evidence[0]!.kind)));
  assert.doesNotMatch(JSON.stringify(first), /supersecret|PRIVATE_BUILD_VALUE|PASSWORD/i,
    "commands, images, arguments, and environment values never enter the candidate fragment");

  writeFileSync(join(root, "Dockerfile"), "FROM changed-working-copy\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree delivery edits cannot alter exact-revision discovery");
});

test("HLG-2 discovers exact Helm chart artifacts without retaining chart bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "charts/payments/Chart.yaml",
        raw: true,
        value: `apiVersion: v2
name: private-payments-chart
version: 1.2.3
description: supersecret-chart-description
dependencies:
  - name: private-dependency
    repository: https://private.example.test/charts
`,
      },
      {
        path: "deploy/legacy/Chart.yaml",
        raw: true,
        value: `apiVersion: v1
name: private-legacy-chart
version: 0.9.0
`,
      },
      {
        path: "charts/broken/Chart.yaml",
        raw: true,
        value: "apiVersion: v2\nname: private-broken-chart\n",
      },
      {
        path: "node_modules/dependency/Chart.yaml",
        raw: true,
        value: "apiVersion: v2\nname: private-vendored-chart\nversion: 9.9.9\n",
      },
      {
        path: "charts/ignored/Chart.yml",
        raw: true,
        value: "apiVersion: v2\nname: private-wrong-filename\nversion: 1.0.0\n",
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const charts = first.resources.filter((item) => item.record.kind === "artifact"
    && item.record.metadata.provider === "helm");
  assert.deepEqual(charts.map((item) => item.record.id), [
    "artifact:helm/charts/payments/Chart.yaml",
    "artifact:helm/deploy/legacy/Chart.yaml",
  ]);
  assert.deepEqual(charts.map((item) => item.record.contract_version), ["v2", "v1"]);
  assert.deepEqual(charts.map((item) => item.record.locator), [
    "charts/payments/Chart.yaml",
    "deploy/legacy/Chart.yaml",
  ]);
  assert.ok(charts.every((item) => item.evidence[0]!.kind === "deployment_declaration"));
  assert.ok(charts.every((item) => item.evidence[0]!.sourceRevision === revision));
  assert.equal(first.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("artifact:helm/")).length, 2);
  assert.ok(first.issues.some((issue) => issue.code === "delivery_declaration_invalid"
    && issue.sourcePath === "charts/broken/Chart.yaml"));
  assert.doesNotMatch(JSON.stringify(first), /private-payments|private-legacy|private-broken|private-vendored|private-wrong|supersecret|private\.example/i);

  writeFileSync(join(root, "charts/payments/Chart.yaml"), "working-copy-only\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree Helm chart edits cannot alter exact-revision discovery");
});

test("HLG-2 discovers structured Kubernetes workloads and systemd units without retaining operational bodies", (t) => {
  const { root, revision } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      {
        path: "k8s/workloads.yaml",
        raw: true,
        value: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  template:
    spec:
      containers:
        - name: api
          image: private.example.test/supersecret-kubernetes-image
          env:
            - name: PASSWORD
              value: supersecret-kubernetes-password
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: reconcile
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: job
              image: private.example.test/supersecret-cron-image
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: intentionally-not-a-workload
data:
  private-value: supersecret-config-value
`,
      },
      {
        path: "systemd/hunch-worker.service",
        raw: true,
        value: `[Unit]
Description=Hunch worker

[Service]
Environment=ACCESS_TOKEN=supersecret-systemd-value
ExecStart=/private/path/hunch-worker --private-argument
`,
      },
    ],
  });

  const first = discoverRepositoryLandscape(root, revision);
  const targets = first.resources.filter((item) => item.record.kind === "deployment_target");
  assert.deepEqual(targets.map((item) => item.record.id), [
    "deployment_target:kubernetes/k8s/workloads.yaml#apps/v1/deployment/payments/payments-api",
    "deployment_target:kubernetes/k8s/workloads.yaml#batch/v1/cronjob/default/reconcile",
    "deployment_target:systemd/systemd/hunch-worker.service",
  ]);
  assert.deepEqual(targets.map((item) => item.record.contract_version), ["apps/v1", "batch/v1", undefined]);
  assert.deepEqual(targets.slice(0, 2).map((item) => item.record.metadata.kubernetes_kind), ["Deployment", "CronJob"]);
  assert.deepEqual(targets.slice(0, 2).map((item) => item.record.metadata.kubernetes_namespace), ["payments", "default"]);
  assert.deepEqual(targets.slice(0, 2).map((item) => item.evidence[0]!.sourceField), [
    "documents[0].metadata.name",
    "documents[1].metadata.name",
  ]);
  assert.equal(first.relationships.filter((item) => item.record.type === "deploys").length, 3);
  assert.deepEqual(first.issues, []);
  assert.doesNotMatch(JSON.stringify(first), /supersecret|ACCESS_TOKEN|PASSWORD|private-argument|private\/path/i,
    "images, commands, environment values, and non-workload data never enter the candidate fragment");

  writeFileSync(join(root, "k8s/workloads.yaml"), "apiVersion: v1\nkind: Pod\nmetadata:\n  name: changed-working-copy\n", "utf8");
  assert.deepEqual(discoverRepositoryLandscape(root, revision), first,
    "working-tree Kubernetes changes cannot alter exact-revision discovery");
});

test("HLG-2 leaves unsafe, malformed, templated, and duplicate deployment identities unresolved", (t) => {
  const duplicate = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: duplicate-api
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: duplicate-api
`;
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: "k8s/broken.yaml", raw: true, value: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: [unterminated" },
      { path: "k8s/duplicate.yaml", raw: true, value: duplicate },
      { path: "k8s/templated.yaml", raw: true, value: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Values.privateName }}\n" },
      { path: "k8s/configmap.yaml", raw: true, value: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: safe-config\n" },
      { path: "systemd/broken.service", raw: true, value: "[Unit]\nDescription=No service section\n" },
      { path: "systemd/token=supersecret-path.service", raw: true, value: "[Service]\nExecStart=/safe/path\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => item.record.kind === "deployment_target"), false);
  assert.equal(result.issues.filter((issue) => issue.code === "delivery_declaration_invalid").length, 3);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_conflict"));
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret-path|privateName|unterminated/i);
});

test("HLG-2 reports malformed, oversized, and secret-bearing delivery declarations without echoing unsafe content", (t) => {
  const oversized = `jobs:\n  build:\n    steps:\n${"      - run: echo bounded\n".repeat(12_000)}`;
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [
      { path: ".github/workflows/broken.yml", raw: true, value: "jobs: [unterminated" },
      { path: ".github/workflows/token=supersecret-path.yml", raw: true, value: "jobs:\n  safe: {}\n" },
      { path: ".circleci/config.yml", raw: true, value: oversized },
      { path: "Dockerfile", raw: true, value: "RUN echo no-base-image\n" },
      { path: "compose.yml", raw: true, value: "volumes: {}\n" },
    ],
  });

  const result = discoverRepositoryLandscape(root);
  assert.equal(result.resources.some((item) => ["pipeline", "artifact", "deployment_target"].includes(item.record.kind)), false);
  assert.equal(result.issues.filter((issue) => issue.code === "delivery_declaration_invalid").length, 3);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_oversized"));
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_path"));
  assert.doesNotMatch(JSON.stringify(result), /supersecret-path|unterminated|no-base-image/i);
});

test("HLG-2 bounds delivery declaration count before blob hydration and candidate construction", (t) => {
  const files = Array.from({ length: 129 }, (_, index) => ({
    path: `.github/workflows/workflow-${String(index).padStart(3, "0")}.yml`,
    value: `jobs:\n  build-${index}:\n    runs-on: ubuntu-latest\n`,
    raw: true,
  }));
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files,
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "pipeline").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "contains"
    && item.record.to.startsWith("pipeline:")).length, 128);
});

test("HLG-2 bounds logical workloads when one Kubernetes file contains more than the declaration cap", (t) => {
  const workloads = Array.from({ length: 129 }, (_, index) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: workload-${String(index).padStart(3, "0")}
`).join("---\n");
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
    files: [{ path: "k8s/workloads.yaml", raw: true, value: workloads }],
  });

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_limit"));
  assert.equal(result.resources.filter((item) => item.record.kind === "deployment_target").length, 128);
  assert.equal(result.relationships.filter((item) => item.record.type === "deploys").length, 128);
});

test("HLG-2 never follows a delivery declaration symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  symlinkSync("package.json", join(root, "Dockerfile"));
  git(root, "add", "--", "Dockerfile");
  git(root, "commit", "-qm", "add delivery symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "delivery_declaration_mode" && issue.sourcePath === "Dockerfile"));
  assert.equal(result.resources.some((item) => item.record.kind === "artifact"), false);
});

test("HLG-2 never follows an OpenAPI declaration symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  mkdirSync(join(root, "contracts"), { recursive: true });
  symlinkSync("../package.json", join(root, "contracts/openapi.yaml"));
  git(root, "add", "--", "contracts/openapi.yaml");
  git(root, "commit", "-qm", "add OpenAPI symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "api_declaration_mode"
    && issue.sourcePath === "contracts/openapi.yaml"));
  assert.equal(result.resources.some((item) => item.record.kind === "api"), false);
});

test("HLG-2 never follows a Prisma migration symlink", (t) => {
  const { root } = repository(t, {
    rootManifest: { name: "@acme/platform", repository: "https://github.com/acme/platform.git" },
  });
  const migrationDir = join(root, "prisma/migrations/20260826120000_linked");
  mkdirSync(migrationDir, { recursive: true });
  symlinkSync("../../../package.json", join(migrationDir, "migration.sql"));
  git(root, "add", "--", "prisma/migrations/20260826120000_linked/migration.sql");
  git(root, "commit", "-qm", "add Prisma migration symlink");

  const result = discoverRepositoryLandscape(root);
  assert.ok(result.issues.some((issue) => issue.code === "migration_declaration_mode"
    && issue.sourcePath === "prisma/migrations/20260826120000_linked/migration.sql"));
  assert.equal(result.resources.some((item) => item.record.metadata.artifact_type === "database_migration"), false);
});
