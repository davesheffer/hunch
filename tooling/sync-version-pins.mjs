#!/usr/bin/env node
/**
 * Keep every committed exact-version pin in lockstep with package.json.
 *
 * `npm version` only touches package.json; plugin/.mcp.json pins the exact npm
 * release its launcher installs, and server.json (the MCP registry manifest)
 * carries the version twice. A missed pin fails the release gate's version
 * test — but only ~25 minutes into a full run (con_d56f17a941). Wired into the
 * npm "version" lifecycle so the bump itself keeps the pins true.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(projectRoot, rel), "utf8");

// Use the same bounded config writer as `hunch integrations repair-pins`.
// Source loading works before dist exists during a fresh checkout's npm version.
// Committed pins (.windsurf/hooks.json) follow package.json — the release gate
// tests them. Machine-local (git-ignored) launch config only moves once npm can
// serve the version: a pin ahead of publication makes every hook and MCP launch
// on this machine fail with ETARGET, silently, until the release lands.
execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", [
  "import { repairIntegrationPins, machineLocalIntegrationFiles } from './src/integrations/health.ts';",
  "import { publishedStatus } from './src/integrations/registry.ts';",
  "import { HUNCH_VERSION } from './src/core/version.ts';",
  "const root = process.cwd();",
  "const status = publishedStatus(HUNCH_VERSION);",
  "const local = new Set(status === 'published' ? [] : machineLocalIntegrationFiles(root));",
  "const repaired = repairIntegrationPins(root, { skip: (file) => local.has(file) });",
  "if (repaired.length) console.log(`sync-version-pins: repaired ${repaired.join(', ')}`);",
  "if (local.size) console.log(`sync-version-pins: kept machine-local pins (${[...local].join(', ')}) on their current release: ${HUNCH_VERSION} is ${status === 'unpublished' ? 'not published on npm yet' : 'not confirmed on npm'}. Run hunch integrations repair-pins once it publishes.`);",
].join(" ")], { cwd: projectRoot, stdio: "inherit" });

const { name, version } = JSON.parse(read("package.json"));
const changed = [];

const rewrite = (rel, transform) => {
  const before = read(rel);
  const after = transform(before);
  if (after !== before) {
    writeFileSync(join(projectRoot, rel), after);
    changed.push(rel);
  }
};

const semverPattern = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const pinPattern = new RegExp(`(${name.replace("/", "\\/")}@)${semverPattern}`, "g");
rewrite("plugin/.mcp.json", (text) => text.replace(pinPattern, `$1${version}`));
rewrite("server.json", (text) => text.replace(new RegExp(`("version":\\s*")${semverPattern}(")`, "g"), `$1${version}$2`));

for (const rel of ["plugin/.mcp.json", "server.json"]) {
  if (!read(rel).includes(version)) {
    process.stderr.write(`sync-version-pins: ${rel} does not carry ${version} after rewrite\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(changed.length
  ? `sync-version-pins: ${changed.join(", ")} -> ${version}\n`
  : `sync-version-pins: pins already at ${version}\n`);
