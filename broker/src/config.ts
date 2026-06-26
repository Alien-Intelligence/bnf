/**
 * Broker configuration — read once at startup from the environment.
 *
 * Secrets (BnF KEY/SECRET) are REQUIRED and never defaulted (platform
 * CLAUDE_ERROR_PATTERNS §10). Caps and base URLs have safe defaults and are
 * env-overridable so a quota increase is a redeploy-free config bump.
 */

function required(name: string): string {
  const v = process.env[name];
  if (v == null || v.trim() === "") {
    throw new Error(`Broker env not configured: ${name} is required (no default for secrets/credentials).`);
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}=${raw}: must be a positive number.`);
  }
  return n;
}

/** Like `num`, but allows 0 (used for opt-out toggles like the call log). */
function numAllowingZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}=${raw}: must be >= 0 (0 disables).`);
  }
  return n;
}

function url(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  try {
    new URL(raw);
  } catch {
    throw new Error(`Invalid ${name}=${raw}: must be a valid URL.`);
  }
  return raw.replace(/\/$/, "");
}

export const config = {
  port: num("PORT", 8792),

  // OAuth client_credentials (two-legged, ~1h bearer, no refresh).
  oauthTokenUrl: url("BNF_OAUTH_TOKEN_URL", "https://apimauthproext.bnf.fr/oauth2/token"),
  clientKey: required("BNF_CLIENT_KEY"),
  clientSecret: required("BNF_CLIENT_SECRET"),
  /** Re-mint this many seconds BEFORE expiry so a token never lapses mid-flight. */
  tokenSkewSec: num("BNF_TOKEN_SKEW_SEC", 60),

  // Upstream hosts. Authenticated partner API vs the ungated OAI host.
  // The AUTHENTICATED partner gateway is openapiproext.bnf.fr — NOT openapi.bnf.fr.
  // openapi.bnf.fr serves IIIF on a public, no-token, anonymous-per-IP pool (our
  // calls there wouldn't count against the 300/min app quota and get throttled
  // behind the shared egress IP). openapiproext.bnf.fr requires the Bearer (401
  // without) and attributes usage to our credential. Verified live 2026-06-24.
  apiBaseUrl: url("BNF_API_BASE_URL", "https://openapiproext.bnf.fr"),

  // Rate buckets (requests/min), env-overridable (no rebuild). Global = 300, the
  // REAL provisioned quota (Ludovic fixed it 2026-06-25 — the earlier "100" was a
  // mis-clicked tier that 429'd us every minute, NOT BnF's true ceiling). Verified
  // live via the broker call log: freeze (real BnF 429) dropped to ~0 once the
  // quota was corrected. Manifest 40/min/IP. Fixed clock-minute windows. See
  // ai-memories bnf-partner-api-design.
  globalRpm: num("BNF_GLOBAL_RPM", 300), //   partner API, all endpoints combined
  globalBurst: num("BNF_GLOBAL_BURST", 20),
  manifestRpm: num("BNF_MANIFEST_RPM", 40), // IIIF manifest, per IP (BnF raised 12→40 on 2026-06-24)
  manifestBurst: num("BNF_MANIFEST_BURST", 4),
  externalRpm: num("BNF_EXTERNAL_RPM", 120), // ungated hosts (oai/catalogue/data) — politeness only
  externalBurst: num("BNF_EXTERNAL_BURST", 20),

  /**
   * Per-attempt upstream timeout (ms). 120s, not 30s: under ingest load BnF can
   * take a long time to serve a folio image, and a 30s abort was the bulk of the
   * transient fetch failures (the worker then retries, burning the shared quota).
   * The worker's broker-call timeout (BNF_PAGE_TIMEOUT_MS, 135s) sits just ABOVE
   * this so the broker's own timeout fires first and returns a classifiable status.
   */
  upstreamTimeoutMs: num("BNF_UPSTREAM_TIMEOUT_MS", 120_000),
  /** Token-mint timeout (ms). */
  tokenTimeoutMs: num("BNF_TOKEN_TIMEOUT_MS", 10_000),

  /**
   * Max wall-clock a single `/fetch` may wait for rate-bucket capacity before
   * the broker SHEDS it with a 429 (callers' retry policy treats 429 as
   * transient and backs off). Without this, a far-future 429-freeze would
   * serialize every queued request behind the whole freeze window — the §14
   * unbounded-await anti-pattern. Kept below the clients' 30s per-call timeout.
   */
  acquireMaxWaitMs: num("BNF_ACQUIRE_MAX_WAIT_MS", 10_000),
  /**
   * Fixed back-off applied when an UNGATED host (gallica/oai/catalogue/data)
   * returns a captcha 403 — a Cloudflare/IP throttle with no Retry-After, NOT
   * an auth failure. Freezes the politeness bucket so we stop hammering the
   * blocked egress IP. See ai-memories bnf-gallica-ip-throttle.
   */
  forbiddenBackoffMs: num("BNF_FORBIDDEN_BACKOFF_MS", 60_000),
  /**
   * After a failed OAuth mint, refuse new mints for this long (negative cache)
   * so a token-endpoint outage/429 isn't answered with a re-mint storm (mints
   * count against the partner quota too).
   */
  tokenFailCooldownMs: num("BNF_TOKEN_FAIL_COOLDOWN_MS", 5_000),
  /**
   * Max request body the broker will buffer (bytes). Its own clients POST a
   * tiny JSON `{url, accept}`; anything larger is rejected (413) so a malformed
   * or hostile request can't grow memory without bound on this single replica.
   */
  maxBodyBytes: num("BNF_MAX_BODY_BYTES", 64 * 1024),
  /** Max wall-clock to read a request body before 408 (slow-loris guard). */
  bodyReadTimeoutMs: num("BNF_BODY_READ_TIMEOUT_MS", 10_000),
  /**
   * Rows kept in the in-memory call log exported at `GET /calls.csv` (every
   * /fetch outcome — for analysing rate-limiting behaviour). 0 disables it.
   * 200k ≈ a full multi-hour ingest; ~24MB on this single replica.
   */
  callsLogSize: numAllowingZero("BNF_CALLS_LOG_SIZE", 200_000),
} as const;

/** The authenticated partner-API host, parsed once (used per request). */
export const partnerApiHost: string = new URL(config.apiBaseUrl).host;

/** Only *.bnf.fr upstreams are allowed — SSRF guard (the relay was an open proxy). */
export function isAllowedUpstream(target: URL): boolean {
  return target.hostname === "bnf.fr" || target.hostname.endsWith(".bnf.fr");
}

/** The authenticated partner API host (gets a Bearer token + the global cap). */
export function isPartnerApi(target: URL): boolean {
  return target.host === partnerApiHost;
}

/** A IIIF Presentation manifest — the 12/min-per-IP bucket. */
export function isManifest(target: URL): boolean {
  return /\/presentation\/v\d+\/.*\/manifest\.json$/.test(target.pathname);
}
