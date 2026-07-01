import { test } from "node:test";
import assert from "node:assert/strict";
import { issueCaptureToken, consumeCaptureToken, CAPTURE_TOKEN_TTL_MS } from "../src/core/capturetoken.js";

let n = 0;
const mint = () => `tok_${n++}`;

test("a freshly issued token is consumable exactly once", () => {
  const t0 = 1_000_000;
  const token = issueCaptureToken(mint, t0);
  assert.equal(consumeCaptureToken(token, t0 + 1000), true, "valid within TTL");
  assert.equal(consumeCaptureToken(token, t0 + 2000), false, "one-time use — second consume fails");
});

test("an unknown/absent token never validates", () => {
  assert.equal(consumeCaptureToken(undefined, 1), false);
  assert.equal(consumeCaptureToken("never-issued", 1), false);
});

test("an expired token does not validate", () => {
  const t0 = 5_000_000;
  const token = issueCaptureToken(mint, t0);
  assert.equal(consumeCaptureToken(token, t0 + CAPTURE_TOKEN_TTL_MS + 1), false, "past TTL → invalid");
});

test("issuing prunes already-expired tokens (no unbounded growth)", () => {
  const t0 = 9_000_000;
  const stale = issueCaptureToken(mint, t0);
  // issue a new token far in the future — the prune pass drops the stale one
  issueCaptureToken(mint, t0 + CAPTURE_TOKEN_TTL_MS + 10);
  // the stale token is gone even within what would have been an on-time consume
  assert.equal(consumeCaptureToken(stale, t0 + 100), false, "stale token pruned at issue time");
});
