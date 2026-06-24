/**
 * OAuth2 client_credentials token manager — single-flight, in-memory cache.
 *
 * Two-legged flow: exchange the long-lived KEY/SECRET (HTTP Basic) for a
 * short-lived (~1h) bearer; re-mint at expiry − skew. There is NO refresh token
 * ("refresh" = a fresh POST). Concurrent callers that find the token stale
 * coalesce onto ONE in-flight mint (mints count against quota too).
 */
import { fetch as undiciFetch } from "undici";

import { config } from "./config.js";

interface CachedToken {
  accessToken: string;
  tokenType: string;
  /** Absolute epoch-ms after which the token must be re-minted (incl. skew). */
  expiresAtMs: number;
}

let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

function isFresh(t: CachedToken | null): t is CachedToken {
  return t !== null && Date.now() < t.expiresAtMs;
}

/** Returns a valid "Authorization" header value, minting/refreshing as needed. */
export async function getAuthHeader(): Promise<string> {
  const t = await getToken();
  return `${t.tokenType} ${t.accessToken}`;
}

async function getToken(): Promise<CachedToken> {
  if (isFresh(cached)) return cached;
  // Single-flight: the first stale caller mints; the rest await the same promise.
  if (inflight) return inflight;
  inflight = mint().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function mint(): Promise<CachedToken> {
  const basic = Buffer.from(`${config.clientKey}:${config.clientSecret}`).toString("base64");
  const res = await undiciFetch(config.oauthTokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(config.tokenTimeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OAuth mint failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!body.access_token || !body.expires_in) {
    throw new Error("OAuth mint returned no access_token / expires_in");
  }
  cached = {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "Bearer",
    expiresAtMs: Date.now() + (body.expires_in - config.tokenSkewSec) * 1000,
  };
  return cached;
}
