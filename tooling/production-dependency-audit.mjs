#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

@@CLEANROOM_HOLE_1@@

const DISALLOWED_PRODUCTION_IMPORTS = Object.freeze([
  /^@hono\/node-server(?:\/|$)/,
  /^hono(?:\/|$)/,
  /^@modelcontextprotocol\/sdk\/server\/(?:express|streamableHttp)(?:\.js)?$/,
  /^@modelcontextprotocol\/sdk\/server\/auth(?:\/|\.js$)/,
]);

function sameArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function normalizedVia(via) {
  if (typeof via === "string") return via;
  if (!via || typeof via !== "object") return null;
  return {
    source: via.source,
    name: via.name,
    dependency: via.dependency,
    title: via.title,
    url: via.url,
    severity: via.severity,
    cwe: via.cwe,
    cvss: via.cvss,
    range: via.range,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function sameVia(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const normalize = (entry) => JSON.stringify(normalizedVia(entry));
  return left.map(normalize).sort().every((value, index) => value === right.map(normalize).sort()[index]);
}

/** `fixAvailable` is npm PRESENTATION, not vulnerability identity: the same lock
 *  yields `{name, version, isSemVerMajor}` on some npm majors and a bare boolean
 *  on others. Compare exactly when both sides carry the object; otherwise only
 *  that a fix exists/doesn't. Advisory identity (source, range, severity, nodes,
 *  effects, via) stays byte-exact above. */
function sameFixAvailable(left, right) {
  if (left && right && typeof left === "object" && typeof right === "object") return sameJson(left, right);
  return Boolean(left) === Boolean(right);
}

export function assertReviewedProductionImports(imports) {
  const violations = imports.filter((specifier) =>
    DISALLOWED_PRODUCTION_IMPORTS.some((pattern) => pattern.test(specifier)));
  if (violations.length > 0) {
    throw new Error(`reviewed Hono advisory became reachable through production import(s): ${violations.join(", ")}`);
  }
  return true;
}

@@CLEANROOM_HOLE_2@@
  if (!report || report.auditReportVersion !== 2 || !report.vulnerabilities
    || typeof report.vulnerabilities !== "object") {
    throw new Error("npm audit returned an unsupported or malformed JSON report");
  }
  assertReviewedProductionImports(productionImports);

  const names = Object.keys(report.vulnerabilities).sort();
  for (const name of names) {
    const actual = report.vulnerabilities[name];
@@CLEANROOM_HOLE_3@@
    if (!reviewed) throw new Error(`unreviewed production vulnerability: ${name}`);
    if (actual?.name !== name
      || actual.severity !== reviewed.severity
      || actual.isDirect !== reviewed.isDirect
      || actual.range !== reviewed.range
      || !sameArray(actual.effects, reviewed.effects)
      || !sameArray(actual.nodes, reviewed.nodes)
      || !sameVia(actual.via, reviewed.via)
      || !sameFixAvailable(actual.fixAvailable, reviewed.fixAvailable)) {
      throw new Error(`reviewed production vulnerability changed identity: ${name}`);
    }
  }

  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: names.length };
  for (const name of names) {
    const severity = report.vulnerabilities[name]?.severity;
    if (!(severity in counts) || severity === "total") {
      throw new Error(`npm audit returned an unknown severity for ${name}`);
    }
    counts[severity] += 1;
  }
  const reportedCounts = report.metadata?.vulnerabilities;
  if (!reportedCounts || Object.entries(counts).some(([key, value]) => reportedCounts[key] !== value)) {
    throw new Error("npm audit vulnerability totals do not match its package findings");
  }

  const advisorySources = [...new Set(names.flatMap((name) =>
    (report.vulnerabilities[name].via ?? [])
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => entry.source)))].sort((left, right) => left - right);
  return {
    status: "passed",
    reviewed_vulnerable_packages: names,
    reviewed_advisory_sources: advisorySources,
    unreviewed_vulnerabilities: 0,
  };
}

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

export function productionImportSpecifiers(root = join(projectRoot, "src")) {
  const imports = new Set();
  const pattern = /(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports].sort();
}

function runAudit() {
  const args = ["audit", "--omit=dev", "--json"];
  const child = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm audit --omit=dev --json"], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsVerbatimArguments: true,
        maxBuffer: 16 * 1024 * 1024,
      })
    : spawnSync("npm", args, {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
  if (child.error) throw child.error;
  let report;
  try {
    report = JSON.parse(child.stdout);
  } catch {
    throw new Error(`npm audit did not return JSON (exit ${String(child.status)}): ${child.stderr.trim()}`);
  }
  return evaluateProductionAudit(report, productionImportSpecifiers());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runAudit();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Production dependency audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
