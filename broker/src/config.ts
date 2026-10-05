/**
 * Broker configuration, parsed from an environment. Pure: `loadConfig(env)`
 * reads only the object it is given, so tests load configs without touching
 * process.env; the one process-wide instance lives in env.ts.
 *
 * Two rules (platform CLAUDE_ERROR_PATTERNS §9/§10):
 * - Secrets (the BnF KEY/SECRET) and RATES are REQUIRED. Every bucket's rpm and
 *   burst is a BnF quota decision (helm `broker.config.rates`), so a missing
 *   one stops the broker at boot instead of running on a guessed number — and
 *   a new image with an old ConfigMap fails loudly instead of silently.
 * - Tuning knobs (timeouts, sizes, the call-log length) keep documented
 *   defaults: they are not quotas, and a wrong one cannot over-spend BnF.
 */
import { BUCKET_NAMES, type BucketName, type BucketRate } from "./plan.js";

/** An environment: process.env, or a plain object in tests. */
type Env = Readonly<Record<string, string | undefined>>;

/** The env stem of each bucket: `BNF_<STEM>_RPM` / `BNF_<STEM>_BURST`. */
export const RATE_ENV_STEM: Readonly<Record<BucketName, string>> = {
  global: "GLOBAL",
  manifest: "MANIFEST",
  external: "EXTERNAL",
  presentation: "PRESENTATION",
  image: "IMAGE",
  iiifLegacy: "IIIF_LEGACY",
  catalogue: "CATALOGUE",
  gallicaSru: "GALLICA_SRU",
  grapheData: "GRAPHE_DATA",
  datePeriodique: "DATE_PERIODIQUE",
  documentTdm: "DOCUMENT_TDM",
};

/** Every rate env var the broker requires (2 per bucket). */
export const RATE_ENV_VARS: readonly string[] = BUCKET_NAMES.flatMap((b) => [
  `BNF_${RATE_ENV_STEM[b]}_RPM`,
  `BNF_${RATE_ENV_STEM[b]}_BURST`,
]);

function required(env: Env, name: string): string {
  const v = env[name];
  if (v == null || v.trim() === "") {
    throw new Error(`Broker env not configured: ${name} is required (no default for secrets/credentials).`);
  }
  return v.trim();
}

/** A rate value: required, and a whole number ≥ 1 written in plain digits. */
function requiredPositiveInt(env: Env, name: string): number {
  const v = env[name];
  if (v == null || v.trim() === "") {
    throw new Error(`Broker env not configured: ${name} is required (no default for rate limits).`);
  }
  const text = v.trim();
  const n = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`Invalid ${name}=${v}: must be a positive integer.`);
  }
  return n;
}

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}=${raw}: must be a positive number.`);
  }
  return n;
}

/** Like `num`, but allows 0 (used for opt-out toggles like the call log). */
function numAllowingZero(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}=${raw}: must be >= 0 (0 disables).`);
  }
  return n;
}

function url(env: Env, name: string, fallback: string): string {
  const raw = env[name]?.trim() || fallback;
  try {
    new URL(raw);
  } catch {
    throw new Error(`Invalid ${name}=${raw}: must be a valid URL.`);
  }
  return raw.replace(/\/$/, "");
}

function rateOf(env: Env, bucket: BucketName): BucketRate {
  const stem = RATE_ENV_STEM[bucket];
  return {
    rpm: requiredPositiveInt(env, `BNF_${stem}_RPM`),
    burst: requiredPositiveInt(env, `BNF_${stem}_BURST`),
  };
}

export interface BrokerConfig {
  port: number;
  oauthTokenUrl: string;
  clientKey: string;
  clientSecret: string;
  tokenSkewSec: number;
  apiBaseUrl: string;
  /** Every bucket's pace — see plan.ts for what each bucket covers. */
  rates: Readonly<Record<BucketName, BucketRate>>;
  upstreamTimeoutMs: number;
  tokenTimeoutMs: number;
  acquireMaxWaitMs: number;
  forbiddenBackoffMs: number;
  tokenFailCooldownMs: number;
  maxBodyBytes: number;
  bodyReadTimeoutMs: number;
  callsLogSize: number;
}

export function loadConfig(env: Env): BrokerConfig {
  return {
    port: num(env, "PORT", 8792),

    // OAuth client_credentials (two-legged, ~1h bearer, no refresh).
    oauthTokenUrl: url(env, "BNF_OAUTH_TOKEN_URL", "https://apimauthproext.bnf.fr/oauth2/token"),
    clientKey: required(env, "BNF_CLIENT_KEY"),
    clientSecret: required(env, "BNF_CLIENT_SECRET"),
    /** Re-mint this many seconds BEFORE expiry so a token never lapses mid-flight. */
    tokenSkewSec: num(env, "BNF_TOKEN_SKEW_SEC", 60),

    // The AUTHENTICATED partner gateway is openapiproext.bnf.fr — NOT
    // openapi.bnf.fr. openapi.bnf.fr serves IIIF on a public, no-token,
    // anonymous-per-IP pool (our calls there wouldn't count against our
    // partner-API quota at all, and get throttled behind the shared egress IP
    // instead). openapiproext.bnf.fr requires the Bearer (401 without) and
    // attributes usage to our credential. Verified live 2026-06-24.
    apiBaseUrl: url(env, "BNF_API_BASE_URL", "https://openapiproext.bnf.fr"),

    // The ingestion subscription's per-minute model, one entry per bucket
    // (plan.ts). Values: helm `broker.config.rates`, where quota/rpm/burst are
    // checked against each other at render (rpm + burst ≤ quota: BnF counts
    // fixed clock-minute windows, and a token bucket can emit rpm + burst in
    // one). No defaults.
    rates: {
      global: rateOf(env, "global"),
      manifest: rateOf(env, "manifest"),
      external: rateOf(env, "external"),
      presentation: rateOf(env, "presentation"),
      image: rateOf(env, "image"),
      iiifLegacy: rateOf(env, "iiifLegacy"),
      catalogue: rateOf(env, "catalogue"),
      gallicaSru: rateOf(env, "gallicaSru"),
      grapheData: rateOf(env, "grapheData"),
      datePeriodique: rateOf(env, "datePeriodique"),
      documentTdm: rateOf(env, "documentTdm"),
    },

    /**
     * Per-attempt upstream timeout (ms). 120s, not 30s: under ingest load BnF can
     * take a long time to serve a folio image, and a 30s abort was the bulk of the
     * transient fetch failures (the worker then retries, burning the shared quota).
     * The worker's broker-call timeout (BNF_PAGE_TIMEOUT_MS, 135s) sits just ABOVE
     * this so the broker's own timeout fires first and returns a classifiable status.
     */
    upstreamTimeoutMs: num(env, "BNF_UPSTREAM_TIMEOUT_MS", 120_000),
    /** Token-mint timeout (ms). */
    tokenTimeoutMs: num(env, "BNF_TOKEN_TIMEOUT_MS", 10_000),

    /**
     * Max wall-clock a single `/fetch` may wait for ALL of its buckets before
     * the broker SHEDS it with a 429 (callers' retry policy treats 429 as
     * transient and backs off). ONE budget for the whole plan, measured from
     * the request's arrival (rate.ts acquireAll — F3, F-D5). Without it, a
     * far-future 429-freeze would serialize every queued request behind the
     * whole freeze window — the §14 unbounded-await anti-pattern. It must sit
     * well below every client's per-call timeout (worker: 45s metadata, 135s
     * page), so the honest shed 429 always beats an opaque client abort.
     */
    acquireMaxWaitMs: num(env, "BNF_ACQUIRE_MAX_WAIT_MS", 10_000),
    /**
     * Fixed back-off applied when an UNGATED host (gallica/oai/catalogue/data)
     * returns a captcha 403 — a Cloudflare/IP throttle with no Retry-After, NOT
     * an auth failure. Freezes the politeness bucket so we stop hammering the
     * blocked egress IP. See ai-memories bnf-gallica-ip-throttle.
     */
    forbiddenBackoffMs: num(env, "BNF_FORBIDDEN_BACKOFF_MS", 60_000),
    /**
     * After a failed OAuth mint, refuse new mints for this long (negative cache)
     * so a token-endpoint outage/429 isn't answered with a re-mint storm (mints
     * count against the partner quota too).
     */
    tokenFailCooldownMs: num(env, "BNF_TOKEN_FAIL_COOLDOWN_MS", 5_000),
    /**
     * Max request body the broker will buffer (bytes). Its own clients POST a
     * tiny JSON `{url, accept}`; anything larger is rejected (413) so a malformed
     * or hostile request can't grow memory without bound on this single replica.
     */
    maxBodyBytes: num(env, "BNF_MAX_BODY_BYTES", 64 * 1024),
    /** Max wall-clock to read a request body before 408 (slow-loris guard). */
    bodyReadTimeoutMs: num(env, "BNF_BODY_READ_TIMEOUT_MS", 10_000),
    /**
     * Rows kept in the in-memory call log exported at `GET /calls.csv` (every
     * /fetch outcome — for analysing rate-limiting behaviour). 0 disables it.
     * 200k ≈ a full multi-hour ingest; tens of MB on this single replica.
     */
    callsLogSize: numAllowingZero(env, "BNF_CALLS_LOG_SIZE", 200_000),
  };
}

/** Only *.bnf.fr upstreams are allowed — SSRF guard (the relay was an open proxy). */
export function isAllowedUpstream(target: URL): boolean {
  return target.hostname === "bnf.fr" || target.hostname.endsWith(".bnf.fr");
}
