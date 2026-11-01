// Check token identity before state so an unrelated token cannot be described as
// a consumed or expired token belonging to this instance.
export function pairingTokenFailure(pairing, token, now, ttl, equal) {
  if (!equal(token, pairing.token)) return "pairing.token_mismatch";
  if (pairing.consumedAt) return "pairing.token_used";
  if (now - pairing.issuedAt > ttl) return "pairing.token_expired";
  return null;
}
