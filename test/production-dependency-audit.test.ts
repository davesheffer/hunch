import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertReviewedProductionImports,
  evaluateProductionAudit,
} from "../tooling/production-dependency-audit.mjs";

function reviewedReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "@hono/node-server": {
        name: "@hono/node-server",
        severity: "moderate",
        isDirect: false,
        via: [{
          source: 1124006,
          name: "@hono/node-server",
          dependency: "@hono/node-server",
          title: "Node.js Adapter for Hono: Path traversal in `serve-static` on Windows via encoded backslash (`%5C`)",
          url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
          severity: "moderate",
          cwe: ["CWE-22"],
          cvss: {
            score: 5.9,
            vectorString: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N",
          },
          range: "<2.0.5",
        }],
        effects: ["@modelcontextprotocol/sdk"],
        range: "<2.0.5",
        nodes: ["node_modules/@modelcontextprotocol/sdk/node_modules/@hono/node-server"],
        fixAvailable: {
          name: "@modelcontextprotocol/sdk",
          version: "1.24.3",
          isSemVerMajor: true,
        },
      },
      "@modelcontextprotocol/sdk": {
        name: "@modelcontextprotocol/sdk",
        severity: "moderate",
        isDirect: true,
        via: ["@hono/node-server"],
        effects: [],
        range: ">=1.25.0",
        nodes: ["node_modules/@modelcontextprotocol/sdk"],
        fixAvailable: {
          name: "@modelcontextprotocol/sdk",
          version: "1.24.3",
          isSemVerMajor: true,
        },
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 0, total: 2 },
    },
  };
}

test("production audit accepts only the exact reviewed stdio-unreachable advisory", () => {
  const result = evaluateProductionAudit(reviewedReport(), [
    "@modelcontextprotocol/sdk/server/mcp.js",
    "@modelcontextprotocol/sdk/server/stdio.js",
  ]);
  assert.deepEqual(result, {
    status: "passed",
    reviewed_vulnerable_packages: ["@hono/node-server", "@modelcontextprotocol/sdk"],
    reviewed_advisory_sources: [1124006],
    unreviewed_vulnerabilities: 0,
  });
  assert.deepEqual(evaluateProductionAudit({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  }), {
    status: "passed",
    reviewed_vulnerable_packages: [],
    reviewed_advisory_sources: [],
    unreviewed_vulnerabilities: 0,
  }, "a fully fixed dependency tree remains valid without changing the allowlist");
});

test("production audit fails closed on advisory drift, new findings, and HTTP/Hono reachability", () => {
  const changed = reviewedReport();
  changed.vulnerabilities["@hono/node-server"].severity = "high";
  changed.metadata.vulnerabilities.moderate = 1;
  changed.metadata.vulnerabilities.high = 1;
  assert.throws(() => evaluateProductionAudit(changed), /changed identity/);

  const unexpected = reviewedReport();
  unexpected.vulnerabilities["new-package"] = {
    name: "new-package",
    severity: "critical",
    isDirect: false,
    via: [],
    effects: [],
    range: "*",
    nodes: ["node_modules/new-package"],
  };
  unexpected.metadata.vulnerabilities.critical = 1;
  unexpected.metadata.vulnerabilities.total = 3;
  assert.throws(() => evaluateProductionAudit(unexpected), /unreviewed production vulnerability/);

  for (const specifier of [
    "@hono/node-server/serve-static",
    "hono",
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    "@modelcontextprotocol/sdk/server/express.js",
    "@modelcontextprotocol/sdk/server/auth/router.js",
  ]) {
    assert.throws(() => assertReviewedProductionImports([specifier]), /became reachable/,
      `${specifier} must invalidate the reviewed stdio-only exception`);
  }
});

test("production dependency audit command validates the current lock and source boundary", () => {
  const run = spawnSync(process.execPath, ["tooling/production-dependency-audit.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.unreviewed_vulnerabilities, 0);
});
