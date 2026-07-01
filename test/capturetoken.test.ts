import { test } from "node:test";
import assert from "node:assert/strict";
import { issueCaptureToken, consumeCaptureToken, CAPTURE_TOKEN_TTL_MS } from "../src/core/capturetoken.js";

let n = 0;
const mint = () => `tok_${n++}`;

test("a freshly issued token is consumable exactly once", () => {
  const t0 = 1_000_000;
  const token = issueCaptureToken(mint, t0);
  assert.equal(consumeCaptureToken(token, t0 + 1000), true);
  assert.equal(consumeCaptureToken(token, t0 + 2000), false, "one-time use");
});

test("an unknown/absent token never validates", () => {
  assert.equal(consumeCaptureToken(undefined, 1), false);
  assert.equal(consumeCaptureToken("never-issued", 1), false);
});

test("an expired token does not validate", () => {
  const t0 = 5_000_000;
  const token = issueCaptureToken(mint, t0);
  assert.equal(consumeCaptureToken(token, t0 + CAPTURE_TOKEN_TTL_MS + 1), false);
});

test("issuing prunes already-expired tokens (no unbounded growth)", () => {
  const t0 = 9_000_000;
  const stale = issueCaptureToken(mint, t0);
  issueCaptureToken(mint, t0 + CAPTURE_TOKEN_TTL_MS + 10);
  assert.equal(consumeCaptureToken(stale, t0 + 100), false, "stale token pruned at issue time");
});
