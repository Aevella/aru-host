import test from "node:test";
import assert from "node:assert/strict";
import { pairingTokenFailure } from "../src/server/pairing-token.mjs";

test("pairing differentiates current, used, expired and different tokens", () => {
  const equal = (a, b) => a === b;
  const current = { token: "current", issuedAt: 100, consumedAt: null };
  assert.equal(pairingTokenFailure(current, "current", 200, 100, equal), null);
  assert.equal(pairingTokenFailure(current, "current", 201, 100, equal), "pairing.token_expired");
  assert.equal(pairingTokenFailure({ ...current, consumedAt: 150 }, "current", 200, 100, equal), "pairing.token_used");
  assert.equal(pairingTokenFailure({ ...current, consumedAt: 150 }, "other", 201, 100, equal), "pairing.token_mismatch");
});
