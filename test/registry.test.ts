import { test } from "node:test";
import assert from "node:assert/strict";
import { publishedStatus, type NpmRunner } from "../src/integrations/registry.js";

const runner = (r: Partial<ReturnType<NpmRunner>>): NpmRunner => () => ({ status: 0, stdout: "", stderr: "", ...r });

test("a version npm serves is published", () => {
  assert.equal(publishedStatus("1.32.2", { run: runner({ stdout: '"1.32.2"\n' }) }), "published");
});

test("ETARGET / E404 from npm means unpublished — the state every npx launcher dies in", () => {
  assert.equal(publishedStatus("1.32.3", { run: runner({ status: 1, stderr: "npm error code ETARGET\nnpm error notarget No matching version found" }) }), "unpublished");
  assert.equal(publishedStatus("1.32.3", { run: runner({ status: 1, stderr: "npm error code E404\nnpm error 404 No match found for version 1.32.3" }) }), "unpublished");
});

test("offline, timeouts, and odd output are unknown, never unpublished", () => {
  assert.equal(publishedStatus("1.32.2", { run: runner({ status: 1, stderr: "npm error code ENOTFOUND\nregistry unreachable" }) }), "unknown");
  assert.equal(publishedStatus("1.32.2", { run: runner({ error: new Error("ETIMEDOUT") }) }), "unknown");
  assert.equal(publishedStatus("1.32.2", { run: runner({ stdout: "not json" }) }), "unknown");
  assert.equal(publishedStatus("1.32.2", { run: () => { throw new Error("spawn failed"); } }), "unknown");
  assert.equal(publishedStatus("latest", { run: runner({ stdout: '"1.32.2"' }) }), "unknown", "non-exact specs are never probed");
});

test("the runner is asked for exactly the pinned version", () => {
  let seen: string[] = [];
  publishedStatus("1.2.3", { run: (args) => { seen = args; return { status: 0, stdout: '"1.2.3"', stderr: "" }; } });
  assert.deepEqual(seen, ["view", "@davesheffer/hunch@1.2.3", "version", "--json"]);
});
