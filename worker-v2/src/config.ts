/**
 * Infra config for the worker-v2 entrypoint — DB, S3, broker, the paid-OCR flag,
 * and the per-stage rate knobs. Required vars THROW at startup if missing (no
 * empty defaults — platform CLAUDE_ERROR_PATTERNS §10). The downstream live
 * clients (vision/mistral/embed/cluster) read their OWN secrets from env, mirroring
 * V1's names, so they are not duplicated here.
 */
// ---------------------------------------------------------------------------
// The ONE family of env readers. Every knob goes through one of them: unset or
// blank means the documented default, anything set must be well-formed — a
// typo, a zero, a negative or a fraction THROWS at startup instead of being
// floored, ignored or silently disabling a gate (F23, CLAUDE_ERROR_PATTERNS
// §10/§12). Each takes the env, so loadConfigFrom is pure and unit-tested.
// ---------------------------------------------------------------------------

type Env = NodeJS.ProcessEnv;

function isBlank(v: string | undefined): v is undefined {
  return v == null || v.trim() === "";
}

/** A required string: missing or blank throws. */
function requiredFrom(env: Env, name: string): string {
  const v = env[name];
  if (isBlank(v)) throw new Error(`Missing required env var ${name}`);
  return v.trim();
}

/** A non-empty string, or `fallback` when unset/blank. */
function stringFrom(env: Env, name: string, fallback: string): string {
  const v = env[name];
  return isBlank(v) ? fallback : v.trim();
}

/**
 * A strict integer in [min, max] (min defaults to 1), or `fallback` when
 * unset/blank; a fraction, a non-number or an out-of-range value throws.
 */
function positiveIntFrom(
  env: Env,
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const v = env[name];
  if (isBlank(v)) return fallback;
  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    const range = bounds.max === undefined ? `an integer ≥ ${min}` : `an integer in [${min}, ${max}]`;
    throw new Error(`${name} must be ${range}, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** A strict "true" / "false", or `fallback` when unset/blank; anything else throws. */
function boolFrom(env: Env, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (isBlank(v)) return fallback;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(v)}`);
}

/**
 * A ratio in (0, 1], or `fallback` when unset/blank — NaN or an out-of-range
 * value throws rather than silently disabling whatever gate reads it (F23,
 * ai-memories/tech/repos/bnf/ingest-hardening: `Number(env ?? fallback)` let a
 * typo'd DOC_FAIL_RATIO become NaN, which compares false against every ratio
 * and quietly turns the Monitor's fail-ratio gate off).
 */
function ratioFrom(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (isBlank(v)) return fallback;
  const n = Number(v.trim());
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${name} must be a number in (0, 1], got ${JSON.stringify(v)}`);
  }
  return n;
}

export interface WorkerConfig {
  databaseUrl: string;
  /** Port the app↔worker HTTP ingress listens on (the app's WORKER_RUNNER_URL). */
  httpPort: number;
  s3: { bucket: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string };
  /** S3 key prefix isolating V2 artifacts from V1's (shared bucket). */
  s3Prefix: string;
  mistralEnabled: boolean;
  maxPages: number;
  maxCanvases: number;
  /**
   * BnF fetch rate (folios/min) — part of the 1000/min GLOBAL partner-API
   * budget (everything except IIIF manifests, which has its own separate
   * 40/min bucket — see manifestRatePerMin). Authoritative quota per Leo,
   * 2026-08-11 (ai-memories/tech/repos/bnf/ingest-hardening).
   */
  fetchRatePerMin: number;
  /** In-flight folio fetches. Must be high enough that fetches-in-progress keep
   *  the 300/min token bucket drained (≈ rate/60 × per-fetch latency). 12 measured
   *  ~178/min (latency ~4s); 24 is the floor to approach the cap. */
  fetchConcurrency: number;
  /**
   * IIIF manifest rate (per egress IP) — a SEPARATE, scarcer budget from
   * fetchRatePerMin's 1000/min (40/min, authoritative per Leo, 2026-08-11).
   * Shared by MetadataStage and ManifestStage through ONE RateLimiter instance
   * (build.ts `rates.manifest`) — see F1/F2 in
   * ai-memories/tech/repos/bnf/ingest-hardening for what happens when it isn't
   * (the 2026-08-11 broker queue collapse). The code default below (42) is the
   * historical value; prod actually sets BNF_MANIFEST_RPM=40 to match the real
   * quota exactly.
   */
  manifestRatePerMin: number;
  /** IIIF size for VISION-lane images (pct:N — BnF-safe downscale). Full-res
   *  ("max") images time out the vision API under concurrency; vision only needs
   *  a description. Mistral OCR keeps full res. */
  visionImageSize: string;
  /**
   * IIIF size for the MISTRAL-lane (OCR) images — FetchStage's `imageSize` opt
   * (fetch.ts: "max" for every lane except vision, which gets its own
   * downscale above). Sizing-experiment prep (F13 §6,
   * ai-memories/tech/repos/bnf/ingest-hardening): full-res dense 1949
   * broadsheets are the hypothesized cause of Mistral OCR's hallucination on
   * the Nice-Matin corpus (analogous to why the vision lane already downscales
   * to pct:33). Defaults to today's behaviour ("max") — the live A/B
   * (max vs pct:50 vs tiling) runs in the validation phase, not here; this only
   * makes the knob configurable without a code change once a winner is chosen.
   */
  mistralImageSize: string;
  /** Vision-lane DOC concurrency — how many docs the describe stage processes at
   *  once. */
  describeConcurrency: number;
  /** Vision-lane CALL concurrency — the shared cap on total in-flight vision API
   *  calls across all docs (a doc fans its folios out up to this). The real
   *  OpenRouter/Holo ceiling; keep under the provider's rate/DDoS limit. */
  describeCallConcurrency: number;
  /**
   * Doc-resolution concurrency. Does NOT multiply into manifest demand — on a
   * manifest cache MISS, MetadataStage waits on the shared 40/min manifest gate
   * (rates.manifest, the SAME instance ManifestStage uses) before calling
   * getManifest, so raising this only helps keep cache HITS and the OAI
   * fallback fed faster; it can no longer flood the manifest budget the way it
   * did pre-fix (F1, ai-memories/tech/repos/bnf/ingest-hardening: 16 concurrent
   * ungated resolutions collapsed the broker's queue).
   */
  metadataConcurrency: number;
  /** Data-cluster register (indexing) concurrency — the cluster autoscales, so this
   *  can be pushed to drain the register backlog. */
  registerConcurrency: number;
  /** Embed (RunPod) concurrency. */
  embedConcurrency: number;
  /** Mistral OCR batch-submit concurrency (how many docs OCR in parallel). */
  ocrSubmitConcurrency: number;
  /** Mistral OCR batch-poll concurrency (cheap GETs). */
  ocrPollConcurrency: number;
  failRatio: number;
  /**
   * Reconciliation sweep cadence (ms). The sweep is what makes a lost queue job
   * (a pg-boss expiration, a pod killed mid-delivery) self-healing instead of a
   * permanent wedge — see live/reconciler.ts. 60s: fast enough that a wedge is
   * measured in a minute, slow enough that the two queries per active run are
   * noise. Lower it only with an eye on those queries.
   */
  reconcilerIntervalMs: number;
  /**
   * How many times the sweep may re-drive ONE doc before failing it terminally
   * with `stranded_after_requeues`. 3: enough to ride out a rolling redeploy that
   * catches the same doc twice, few enough that a genuinely poisoned doc stops
   * consuming quota and lets its run complete.
   */
  reconcilerMaxRequeues: number;
  /**
   * How many consecutive terminal-callback POST failures a run may accumulate
   * (across every sweep's retry, TerminalEmitter.emit's catch path) before the
   * worker gives up and marks it canceled instead of retrying forever. 120 ≈ 2h
   * of sweeps at the default 60s cadence — long enough to ride out a transient
   * app outage, short enough that a permanently-dead callback URL stops
   * spamming the log every sweep. The app-side watchdog independently fails the
   * app job on its own ~30min ceiling, so by the time this fires the app has
   * already moved on; a human can resurrect via resetTerminalEmitted +
   * un-canceling the row manually if ever needed. See the dead-callback
   * give-up item, ai-memories/tech/repos/bnf/ingest-hardening.
   */
  reconcilerMaxCallbackFailures: number;
  /** The OCR-quality backfill knobs — see OcrBackfillConfig / loadOcrBackfillConfig. */
  ocrBackfill: OcrBackfillConfig;
}

/**
 * statement_timeout for every pg Pool the worker opens (main.ts, status.ts): pg
 * has NO query timeout by default, so a lock wait or a bad plan parks whatever
 * awaited it. Every query is small OLTP work measured in milliseconds, so 30 s
 * only ever fires on something genuinely stuck (CLAUDE_ERROR_PATTERNS §14).
 */
export const PG_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * connectionTimeoutMillis for every pg Pool: by default pg waits FOREVER for a
 * free client (pool exhausted) or a TCP connect — the one await
 * statement_timeout does not cover. 10 s is far above a healthy checkout.
 */
export const PG_CONNECTION_TIMEOUT_MS = 10_000;

/** The options of every pg Pool the worker opens — both timeouts, one place. */
export function pgPoolConfig(databaseUrl: string): {
  connectionString: string;
  statement_timeout: number;
  connectionTimeoutMillis: number;
} {
  return {
    connectionString: databaseUrl,
    statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
  };
}

/**
 * OCR-quality backfill (ai-memories/tech/repos/bnf/feedback-2026-09-29, Track B).
 * The defaults are explicit, named and documented in RUN.md, helm/DEPLOY.md and
 * values.yaml — the plan (D6) fixes them; nothing else in the worker restates
 * them.
 */
export interface OcrBackfillConfig {
  /**
   * OCR_BACKFILL_ENABLED (default true). False leaves the stage unregistered AND
   * makes /ocr-quality/sync answer missing ARKs `unavailable: backfill_disabled`
   * — the switch that stops the BnF spend without a rollback; artifacts that
   * already exist are still served.
   */
  enabled: boolean;
  /**
   * OCR_BACKFILL_CONCURRENCY (default 2, plan D6): in-flight backfill docs. Each
   * text doc costs one Presentation (ALTO) call per indexed folio, once, through
   * the SAME fetch gate live ingests use — raise it off-hours to drain the
   * backlog. Must be a positive integer: turning the stage off is `enabled`'s
   * job, not a zero that would wedge its queue consumer.
   */
  concurrency: number;
  /**
   * OCR_BACKFILL_RETRY_FAILED_AFTER_MS (default 24 h): the BASE backoff before a
   * transiently failed build is retried; it doubles per attempt
   * (domain/ocr-backfill.ts). Integer milliseconds, at least
   * MIN_OCR_BACKFILL_RETRY_FAILED_AFTER_MS: the value is milliseconds, and a
   * "60" meant as minutes would otherwise re-spend BnF quota every sweep.
   */
  retryFailedAfterMs: number;
}

/** The floor of OCR_BACKFILL_RETRY_FAILED_AFTER_MS: one minute. */
export const MIN_OCR_BACKFILL_RETRY_FAILED_AFTER_MS = 60_000;

export const DEFAULT_OCR_BACKFILL_ENABLED = true;
export const DEFAULT_OCR_BACKFILL_CONCURRENCY = 2;
export const DEFAULT_OCR_BACKFILL_RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1_000;

/** The OCR backfill knobs, validated. Pure (takes the env) so it is unit-tested. */
export function loadOcrBackfillConfig(env: NodeJS.ProcessEnv): OcrBackfillConfig {
  return {
    enabled: boolFrom(env, "OCR_BACKFILL_ENABLED", DEFAULT_OCR_BACKFILL_ENABLED),
    concurrency: positiveIntFrom(env, "OCR_BACKFILL_CONCURRENCY", DEFAULT_OCR_BACKFILL_CONCURRENCY),
    retryFailedAfterMs: positiveIntFrom(
      env,
      "OCR_BACKFILL_RETRY_FAILED_AFTER_MS",
      DEFAULT_OCR_BACKFILL_RETRY_FAILED_AFTER_MS,
      { min: MIN_OCR_BACKFILL_RETRY_FAILED_AFTER_MS },
    ),
  };
}

/** The highest TCP port. */
const MAX_PORT = 65_535;

/** The whole worker config from `env`, validated. Pure, so it is unit-tested. */
export function loadConfigFrom(env: Env): WorkerConfig {
  return {
    databaseUrl: requiredFrom(env, "DATABASE_URL"),
    httpPort: positiveIntFrom(env, "WORKER_HTTP_PORT", 7777, { max: MAX_PORT }),
    s3: {
      bucket: requiredFrom(env, "SCW_S3_BUCKET"),
      endpoint: requiredFrom(env, "SCW_S3_ENDPOINT_URL"),
      region: requiredFrom(env, "SCW_S3_REGION"),
      accessKeyId: requiredFrom(env, "SCW_S3_ACCESS_KEY"),
      secretAccessKey: requiredFrom(env, "SCW_S3_SECRET_KEY"),
    },
    s3Prefix: stringFrom(env, "V2_S3_PREFIX", "v2/"),
    mistralEnabled: boolFrom(env, "MISTRAL_OCR_ENABLED", false),
    maxPages: positiveIntFrom(env, "MAX_OCR_PAGES", 300),
    maxCanvases: positiveIntFrom(env, "MISTRAL_OCR_MAX_PAGES", 300),
    fetchRatePerMin: positiveIntFrom(env, "BNF_GLOBAL_RPM", 300),
    fetchConcurrency: positiveIntFrom(env, "BNF_FETCH_CONCURRENCY", 32),
    manifestRatePerMin: positiveIntFrom(env, "BNF_MANIFEST_RPM", 42),
    visionImageSize: stringFrom(env, "VISION_IMAGE_SIZE", "pct:33"),
    mistralImageSize: stringFrom(env, "MISTRAL_IMAGE_SIZE", "max"),
    describeConcurrency: positiveIntFrom(env, "DESCRIBE_CONCURRENCY", 16),
    // 64: the vision lane is the bottleneck and the paid OpenRouter key has no
    // per-key RPM cap — push concurrency hard and let the in-call 429/timeout
    // backoff (vision.ts) ride the provider's capacity edge. See hardening-pass-2.
    describeCallConcurrency: positiveIntFrom(env, "DESCRIBE_CALL_CONCURRENCY", 64),
    metadataConcurrency: positiveIntFrom(env, "METADATA_CONCURRENCY", 16),
    registerConcurrency: positiveIntFrom(env, "REGISTER_CONCURRENCY", 24),
    embedConcurrency: positiveIntFrom(env, "EMBED_CONCURRENCY", 8),
    ocrSubmitConcurrency: positiveIntFrom(env, "OCR_SUBMIT_CONCURRENCY", 12),
    ocrPollConcurrency: positiveIntFrom(env, "OCR_POLL_CONCURRENCY", 16),
    failRatio: ratioFrom(env, "DOC_FAIL_RATIO", 0.25),
    reconcilerIntervalMs: positiveIntFrom(env, "RECONCILER_INTERVAL_MS", 60_000),
    reconcilerMaxRequeues: positiveIntFrom(env, "RECONCILER_MAX_REQUEUES", 3),
    reconcilerMaxCallbackFailures: positiveIntFrom(env, "RECONCILER_MAX_CALLBACK_FAILURES", 120),
    ocrBackfill: loadOcrBackfillConfig(env),
  };
}

export function loadConfig(): WorkerConfig {
  return loadConfigFrom(process.env);
}
