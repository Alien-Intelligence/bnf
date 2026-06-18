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
  const expected = signCallback(body, secret)
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}
