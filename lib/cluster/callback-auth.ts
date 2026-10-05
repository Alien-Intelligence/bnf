// lib/cluster/callback-auth.ts
// HMAC sign + verify helpers for cluster progress callbacks.
// Used both when building the callback URL (sign) and when receiving it (verify).
import crypto from "node:crypto"

/**
 * Returns the HMAC-SHA256 signature for a request body.
 * Format: "sha256=<hex-digest>" — same convention as GitHub webhooks.
 */
export function signCallback(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
}

/**
 * Verifies that the given signature matches the body using the shared secret.
 * Uses `timingSafeEqual` to prevent timing attacks.
 * Returns false if the signature is absent, malformed, or does not match.
 */
export function verifyCallback(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false
  const given = Buffer.from(signature)
  const expected = Buffer.from(signCallback(body, secret))
  // timingSafeEqual requires equal lengths; a wrong-length signature is
  // malformed, and the expected length is public (sha256= + 64 hex).
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(given, expected)
}

/** The one answer to every rejected callback: unknown job, no secret, bad signature. */
export const CALLBACK_REJECTED_MESSAGE = "invalid callback signature"

/**
 * A secret no caller can know (random per process), verified against when the
 * job is unknown or carries no secret — so every rejected callback costs the
 * same HMAC and answers the same message, and the endpoint is no oracle for
 * which job ids exist or how they were submitted.
 */
const UNKNOWN_JOB_SECRET = crypto.randomBytes(32).toString("hex")

/**
 * Verify a callback against its job's secret, or — for an unknown job or one
 * with no secret (`null`) — run the same verification against
 * UNKNOWN_JOB_SECRET and reject. True only for a real secret and a matching
 * signature.
 */
export function verifyJobCallback(
  body: string,
  signature: string | null,
  secret: string | null,
): boolean {
  const usable = secret !== null && secret !== ""
  const verified = verifyCallback(body, signature, usable ? secret : UNKNOWN_JOB_SECRET)
  return usable && verified
}
