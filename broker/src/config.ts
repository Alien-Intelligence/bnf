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
  apiBaseUrl: url("BNF_API_BASE_URL", "https://openapi.bnf.fr"),

  // Rate buckets (requests/min). The caps WILL rise — bump these, no redeploy.
  // Defaults set from LIVE MEASUREMENT (2026-06-24, sandbox credential), NOT the
  // onboarding brief: the brief says 300/min global, but the enforced ceiling
  // measured ~150–185/min (5 clean clock-minute windows) — so the default is a
  // safe 150, below the observed floor. Manifest verified at exactly 12/min/IP.
  // Both are fixed clock-minute windows. Raise via env once BnF confirms the
  // provisioned prod tier. See ai-memories bnf-partner-api-design.
  globalRpm: num("BNF_GLOBAL_RPM", 150), //   partner API, all endpoints combined
  globalBurst: num("BNF_GLOBAL_BURST", 20),
  manifestRpm: num("BNF_MANIFEST_RPM", 12), // IIIF manifest, per IP (verified exact)
  manifestBurst: num("BNF_MANIFEST_BURST", 4),
  externalRpm: num("BNF_EXTERNAL_RPM", 120), // ungated hosts (oai/catalogue/data) — politeness only
  externalBurst: num("BNF_EXTERNAL_BURST", 20),

  /** Per-attempt upstream timeout (ms). */
  upstreamTimeoutMs: num("BNF_UPSTREAM_TIMEOUT_MS", 30_000),
  /** Token-mint timeout (ms). */
  tokenTimeoutMs: num("BNF_TOKEN_TIMEOUT_MS", 10_000),
} as const;

/** Only *.bnf.fr upstreams are allowed — SSRF guard (the relay was an open proxy). */
export function isAllowedUpstream(target: URL): boolean {
  return target.hostname === "bnf.fr" || target.hostname.endsWith(".bnf.fr");
}

/** The authenticated partner API host (gets a Bearer token + the global cap). */
export function isPartnerApi(target: URL): boolean {
  return target.host === new URL(config.apiBaseUrl).host;
}

/** A IIIF Presentation manifest — the 12/min-per-IP bucket. */
export function isManifest(target: URL): boolean {
  return /\/presentation\/v\d+\/.*\/manifest\.json$/.test(target.pathname);
}
