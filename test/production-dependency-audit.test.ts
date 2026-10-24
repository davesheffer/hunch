import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertReviewedProductionImports,
  evaluateProductionAudit,
} from "../tooling/production-dependency-audit.mjs";

@@CLEANROOM_HOLE_1@@
function reviewedReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
@@CLEANROOM_HOLE_2@@
        severity: "moderate",
        isDirect: false,
        via: [{
@@CLEANROOM_HOLE_3@@
          severity: "moderate",
          cwe: ["CWE-22"],
@@CLEANROOM_HOLE_4@@
          range: "<2.0.5",
        }],
@@CLEANROOM_HOLE_5@@
        range: "<2.0.5",
@@CLEANROOM_HOLE_6@@
      },
    },
    metadata: {
@@CLEANROOM_HOLE_7@@
    },
  };
}

@@CLEANROOM_HOLE_8@@
  assert.deepEqual(result, {
    status: "passed",
@@CLEANROOM_HOLE_9@@
    unreviewed_vulnerabilities: 0,
  });
  assert.deepEqual(evaluateProductionAudit({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
@@CLEANROOM_HOLE_10@@
    status: "passed",
    reviewed_vulnerable_packages: [],
    reviewed_advisory_sources: [],
    unreviewed_vulnerabilities: 0,
  }, "a fully fixed dependency tree remains valid without changing the allowlist");
});

test("production audit fails closed on advisory drift, new findings, and HTTP/Hono reachability", () => {
  const changed = reviewedReport();
@@CLEANROOM_HOLE_11@@
  changed.metadata.vulnerabilities.high = 1;
@@CLEANROOM_HOLE_12@@

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
@@CLEANROOM_HOLE_13@@

  for (const specifier of [
    "@hono/node-server/serve-static",
    "hono",
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    "@modelcontextprotocol/sdk/server/express.js",
    "@modelcontextprotocol/sdk/server/auth/router.js",
  ]) {
    assert.throws(() => assertReviewedProductionImports([specifier]), /became reachable/,
@@CLEANROOM_HOLE_14@@
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
