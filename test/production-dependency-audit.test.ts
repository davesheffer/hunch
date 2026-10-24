import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertReviewedProductionImports,
  evaluateProductionAudit,
} from "../tooling/production-dependency-audit.mjs";

// Synthetic fixture, not a real advisory: it exercises the exact-match and
// fail-closed mechanism independently of live CVE data.
const FAKE_REVIEWED = Object.freeze({
  "fake-vulnerable-pkg": Object.freeze({
    severity: "moderate",
    isDirect: false,
    range: "<2.0.5",
    effects: Object.freeze(["fake-parent-pkg"]),
    nodes: Object.freeze(["node_modules/fake-parent-pkg/node_modules/fake-vulnerable-pkg"]),
    via: Object.freeze([Object.freeze({
      source: 9900001,
      name: "fake-vulnerable-pkg",
      dependency: "fake-vulnerable-pkg",
      title: "Test-only fake advisory, not a real vulnerability",
      url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx",
      severity: "moderate",
      cwe: Object.freeze(["CWE-22"]),
      cvss: Object.freeze({ score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N" }),
      range: "<2.0.5",
    })]),
    fixAvailable: Object.freeze({ name: "fake-parent-pkg", version: "9.9.9", isSemVerMajor: true }),
  }),
});

function reviewedReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "fake-vulnerable-pkg": {
        name: "fake-vulnerable-pkg",
        severity: "moderate",
        isDirect: false,
        via: [{
          source: 9900001,
          name: "fake-vulnerable-pkg",
          dependency: "fake-vulnerable-pkg",
          title: "Test-only fake advisory, not a real vulnerability",
          url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx",
          severity: "moderate",
          cwe: ["CWE-22"],
          cvss: { score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N" },
          range: "<2.0.5",
        }],
        effects: ["fake-parent-pkg"],
        range: "<2.0.5",
        nodes: ["node_modules/fake-parent-pkg/node_modules/fake-vulnerable-pkg"],
        fixAvailable: { name: "fake-parent-pkg", version: "9.9.9", isSemVerMajor: true },
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
    },
  };
}

test("production audit accepts only an exact reviewed exception", () => {
  const result = evaluateProductionAudit(reviewedReport(), [], FAKE_REVIEWED);
  assert.deepEqual(result, {
    status: "passed",
    reviewed_vulnerable_packages: ["fake-vulnerable-pkg"],
    reviewed_advisory_sources: [9900001],
    unreviewed_vulnerabilities: 0,
  });
  assert.deepEqual(evaluateProductionAudit({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  }, [], FAKE_REVIEWED), {
    status: "passed",
    reviewed_vulnerable_packages: [],
    reviewed_advisory_sources: [],
    unreviewed_vulnerabilities: 0,
  }, "a fully fixed dependency tree remains valid without changing the allowlist");
});

test("production audit fails closed on advisory drift, new findings, and HTTP/Hono reachability", () => {
  const changed = reviewedReport();
  changed.vulnerabilities["fake-vulnerable-pkg"].severity = "high";
  changed.metadata.vulnerabilities.moderate = 0;
  changed.metadata.vulnerabilities.high = 1;
  assert.throws(() => evaluateProductionAudit(changed, [], FAKE_REVIEWED), /changed identity/);

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
  unexpected.metadata.vulnerabilities.total = 2;
  assert.throws(() => evaluateProductionAudit(unexpected, [], FAKE_REVIEWED), /unreviewed production vulnerability/);
  // The real allowlist is empty, so the old finding shape is no longer accepted.
  assert.throws(() => evaluateProductionAudit(reviewedReport()), /unreviewed production vulnerability/);

  for (const specifier of [
    "@hono/node-server/serve-static",
    "hono",
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    "@modelcontextprotocol/sdk/server/express.js",
    "@modelcontextprotocol/sdk/server/auth/router.js",
  ]) {
    assert.throws(() => assertReviewedProductionImports([specifier]), /became reachable/,
      `${specifier} must stay disallowed regardless of the current reviewed-exception allowlist`);
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
