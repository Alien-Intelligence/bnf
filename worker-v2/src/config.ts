/**
 * Infra config for the worker-v2 entrypoint — DB, S3, broker, the paid-OCR flag,
 * and the per-stage rate knobs. Required vars THROW at startup if missing (no
 * empty defaults — platform CLAUDE_ERROR_PATTERNS §10). The downstream live
 * clients (vision/mistral/embed/cluster) read their OWN secrets from env, mirroring
 * V1's names, so they are not duplicated here.
 *
 * Env readers that remain OUTSIDE this family (not routed through it; listed so
 * the claim above stays true):
 *   - bnf/client.ts `optionalIntEnv` (BNF_META_TIMEOUT_MS, BNF_PAGE_TIMEOUT_MS);
 *   - live/vendor/broker-client.ts `brokerUrl()` reads BNF_BROKER_URL per call
 *     (vendored V1, the vision path); bnf/broker-client.ts takes it ONCE from
 *     loadBrokerUrl at boot (main.ts);
 *   - live/vendor/{env,fetch-gate,rate-limiter,vision,gallica-relay}.ts — V1
 *     code vendored verbatim (its own floors and silent defaults; fetch-gate.ts
 *     still parses the retired BNF_FETCH_CONCURRENCY, which loadConfigFrom now
 *     refuses — inert either way: the describer hands vision data URLs, never a
 *     broker URL);
 *   - live/cluster-http.ts and live/ocr.ts — the downstream clients' secrets.
 */
// ---------------------------------------------------------------------------
// The ONE family of env readers for every knob in WorkerConfig: unset or
// blank means the documented default (or, for a REQUIRED value — the BnF
// rates and fetch concurrencies — a startup error), anything set must be
// well-formed — a
// typo, a zero, a negative or a fraction THROWS at startup instead of being
// floored, ignored or silently disabling a gate (F23, CLAUDE_ERROR_PATTERNS
// §10/§12). Each takes the env, so loadConfigFrom is pure and unit-tested.
// ---------------------------------------------------------------------------

type Env = NodeJS.ProcessEnv;

/** An integer knob is written in plain decimal digits — nothing else. */
const DIGITS_ONLY = /^[0-9]+$/;
/** A ratio knob is a plain decimal (no exponent, sign or hex). */
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

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

/** `v` as a strict integer in [min, max] (min defaults to 1); anything else throws, naming `name`. */
function parsePositiveInt(name: string, v: string, bounds: { min?: number; max?: number }): number {
  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  const text = v.trim();
  // Digits only: Number() would also read "0x10", "1e1", "+5" or "6e4".
  const n = DIGITS_ONLY.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    const range = bounds.max === undefined ? `an integer ≥ ${min}` : `an integer in [${min}, ${max}]`;
    throw new Error(`${name} must be ${range}, got ${JSON.stringify(v)}`);
  }
  return n;
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
  return parsePositiveInt(name, v, bounds);
}

/** A strict integer ≥ 1 that MUST be set — a rate or a sizing decision, never defaulted. */
function requiredPositiveIntFrom(env: Env, name: string): number {
  return parsePositiveInt(name, requiredFrom(env, name), {});
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
  const text = v.trim();
  const n = PLAIN_DECIMAL.test(text) ? Number(text) : Number.NaN;
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
   * The worker's own BnF gates, derived from the broker's buckets for the
   * ingestion subscription (broker/src/plan.ts), read from the same chart keys
   * (helm `broker.config.rates`). The broker is the rate authority; these keep
   * the worker from offering more than it grants (every broker shed is a
   * wasted round trip). The six bucket rpms are REQUIRED, no defaults (a rate
   * is a BnF quota decision, CLAUDE_ERROR_PATTERNS §9/§10); bulkRpm and
   * workerManifestRpm are derived from them, BELOW the broker's own values.
   * live-pipeline.ts composes them: ALTO = presentation ∧ bulk ∧ global,
   * images = image ∧ bulk ∧ global, manifests = the worker's manifest share ∧
   * presentation ∧ global. bulkRpm and workerManifestRpm are derived and
   * checked at load (gateRates): the worker never takes the whole global or
   * manifest budget.
   */
  rates: {
    /** BNF_RATES.global.rpm — the subscription's cap over every partner API. */
    globalRpm: number;
    /** BNF_RATES.presentation.rpm — the Presentation API (manifests, ALTO). */
    presentationRpm: number;
    /** BNF_RATES.image.rpm — the Image API (folio images). */
    imageRpm: number;
    /**
     * BNF_RATES.manifest.rpm — the broker's per-IP manifest sub-limit. The
     * worker's gate runs at workerManifestRpm (its share), shared by MetadataStage
     * and ManifestStage through ONE gate (build.ts `rates.manifest`) — see F1/F2
     * in ai-memories/tech/repos/bnf/ingest-hardening for what happens when it
     * isn't (the 2026-08-11 broker queue collapse).
     */
    manifestRpm: number;
    /** BNF_RATES.catalogue.rpm — reserved out of global for metadata lookups (gateRates). */
    catalogueRpm: number;
    /** BNF_RATES.grapheData.rpm — reserved out of global like catalogue (gateRates). */
    grapheDataRpm: number;
    /** ALTO + image fetches together (gateRates): global minus the reserved buckets. */
    bulkRpm: number;
    /** The worker's manifest gate (gateRates): its share of the manifest bucket. */
    workerManifestRpm: number;
  };
  /**
   * BNF_ALTO_FETCH_CONCURRENCY — in-flight ALTO fetches. Sized so in-progress
   * fetches keep the ALTO gate drained: permits ≈ rpm × latency_s / 60 with
   * headroom. REQUIRED.
   */
  altoFetchConcurrency: number;
  /** BNF_IMAGE_FETCH_CONCURRENCY — in-flight image fetches, same rule. REQUIRED. */
  imageFetchConcurrency: number;
  /** Vision-lane DOC concurrency — how many docs the describe stage processes at
   *  once. */
  describeConcurrency: number;
  /** Vision-lane CALL concurrency — the shared cap on total in-flight vision API
   *  calls across all docs (a doc fans its folios out up to this). The real
   *  OpenRouter/Holo ceiling; keep under the provider's rate/DDoS limit. */
  describeCallConcurrency: number;
  /**
   * Doc-resolution concurrency. Does NOT multiply into manifest demand — on a
   * manifest cache MISS, MetadataStage waits on the shared manifest gate
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
 * The fetch rate the progress read-model's ETA assumes: ALTO's binding rate,
 * min(bulk, presentation). ALTO is ≥ 90 % of folios (2.2 M ALTO against
 * 172 k images in the DSI log), so image-heavy runs keep an approximate ETA —
 * their Mistral or vision tail dominates anyway. One definition, used by the
 * worker's /progress (main.ts) and the status CLI.
 */
export function etaFetchRatePerMin(rates: WorkerConfig["rates"]): number {
  return Math.min(rates.bulkRpm, rates.presentationRpm);
}

/**
 * The share of the broker's manifest bucket the worker's manifest gate takes.
 * The app reads Presentation manifests through the SAME bucket, unpaced by
 * the worker (lib/bnf/direct.ts, called by the stub resolver, the
 * canonicalizer and the buffer enricher): at 100 % the two
 * oversubscribed it and the broker shed the worker's metadata lookups until
 * documents failed for good (2026-10-06, 0.19.0: 3 804 manifest sheds, 55
 * documents failed in 3 h). The rest is LEFT for the app, which does not pace
 * itself: a sustained app burst above it can still shed the worker. Holding
 * the app to its share needs an app-side manifest limiter (follow-up).
 */
export const WORKER_MANIFEST_SHARE = 0.75;

/** The broker buckets the worker reads, before its gate shares are derived. */
export type BrokerBucketRates = {
  globalRpm: number;
  presentationRpm: number;
  imageRpm: number;
  manifestRpm: number;
  catalogueRpm: number;
  grapheDataRpm: number;
};

/**
 * The rates the worker's gates run at, derived from the broker's buckets.
 *
 * - bulkRpm caps ALTO + image fetches TOGETHER below the global bucket, by the
 *   rpm of every bucket that must still get through global while a big ingest
 *   fetches: manifests, catalogue, graphe. Without it ALTO alone (Presentation
 *   1425 > global 950) took the whole global budget and the broker shed the
 *   metadata lookups of the same ingest (2026-10-06: 471 global sheds of
 *   manifests, 412 of catalogue calls).
 * - workerManifestRpm is WORKER_MANIFEST_SHARE of the manifest bucket, floored.
 *
 * Pure. Returns the problems instead of a share that cannot hold: a bulk
 * share or a manifest share below 1/min is a chart mistake, refused at config
 * load (workerRatesFrom) — never rounded up, which would take the app's part.
 */
export function gateRates(
  rates: BrokerBucketRates,
): { bulkRpm: number; workerManifestRpm: number } | { problems: string[] } {
  const problems: string[] = [];
  const reserved = rates.manifestRpm + rates.catalogueRpm + rates.grapheDataRpm;
  const bulkRpm = rates.globalRpm - reserved;
  if (bulkRpm < 1) {
    problems.push(
      `global.rpm (${rates.globalRpm}) leaves no room for ALTO and image fetches once ` +
        `manifest + catalogue + grapheData (${reserved}) are reserved`,
    );
  }
  const workerManifestRpm = Math.floor(rates.manifestRpm * WORKER_MANIFEST_SHARE);
  if (workerManifestRpm < 1) {
    problems.push(
      `manifest.rpm (${rates.manifestRpm}) is too small to share: the worker's ` +
        `${WORKER_MANIFEST_SHARE * 100} % is below 1/min`,
    );
  }
  return problems.length > 0 ? { problems } : { bulkRpm, workerManifestRpm };
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

/** A required http(s) URL; a trailing slash is dropped. */
function requiredHttpUrlFrom(env: Env, name: string): string {
  const raw = requiredFrom(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * BNF_BROKER_URL — the egress chokepoint every BnF call goes through. Required
 * by the worker RUNTIME only (main.ts hands it to bnf/broker-client.ts once,
 * at boot): unset or malformed, every BnF call would fail as a per-ARK
 * PERMANENT error and a deployment mistake would permanently fail the
 * backfill. The read-only scripts (status, seed, requeue-stranded) make no
 * BnF call and do not need it. An http(s) URL; a trailing slash is dropped.
 */
export function loadBrokerUrl(env: Env): string {
  return requiredHttpUrlFrom(env, "BNF_BROKER_URL");
}

/** The two BnF IIIF APIs the ingestion reads (LiveBnfClient's constructor). */
export interface IiifBases {
  /** PRESENTATION_IIIF_GALLICA — manifests and ALTO. */
  presentationBaseUrl: string;
  /** IMAGE_IIIF_GALLICA — folio images. */
  imageBaseUrl: string;
}

/**
 * BNF_IIIF_PRESENTATION_BASE_URL / BNF_IIIF_IMAGE_BASE_URL — the BnF
 * Presentation and Image APIs, each with its own quota (they replaced the
 * combined Gallica-IIIF API, 2026-09-30). Both REQUIRED, no default: the base
 * carries the API version (…/presentation/iiif/gallica/1.0.0), and a default
 * would hide a chart that forgot the move. Like the broker URL, required by
 * the worker RUNTIME and the scripts that call BnF — not by the read-only
 * status/seed/requeue scripts. Helm: `bnfIiif.*`.
 */
export function loadIiifBases(env: Env): IiifBases {
  return {
    presentationBaseUrl: requiredHttpUrlFrom(env, "BNF_IIIF_PRESENTATION_BASE_URL"),
    imageBaseUrl: requiredHttpUrlFrom(env, "BNF_IIIF_IMAGE_BASE_URL"),
  };
}

/**
 * BNF_RATES: the broker's whole bucket table as one JSON object (helm
 * `broker.config.rates`, the SAME object the broker reads), of which the
 * worker reads six buckets' rpm: global, presentation, image and manifest for
 * its gates, catalogue and grapheData for the global room it leaves them
 * (gateRates). REQUIRED. The other buckets are the broker's business and are
 * not read here; the six this worker needs must be present with an rpm that is
 * a whole number ≥ 1 (a JSON number, never a string), or the worker refuses to
 * boot naming each one.
 */
export const RATES_ENV = "BNF_RATES";

/** The broker buckets the worker reads: four its gates use, plus catalogue and grapheData, reserved out of global (gateRates). */
const WORKER_RATE_BUCKETS = {
  globalRpm: "global",
  presentationRpm: "presentation",
  imageRpm: "image",
  manifestRpm: "manifest",
  catalogueRpm: "catalogue",
  grapheDataRpm: "grapheData",
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function workerRatesFrom(env: Env): WorkerConfig["rates"] {
  const raw = env[RATES_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`Missing required env var ${RATES_ENV} (the broker's rate buckets as one JSON object; no default for a rate)`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${RATES_ENV} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(json)) throw new Error(`${RATES_ENV} is not a JSON object`);
  const problems: string[] = [];
  const rpmOf = (bucket: string): number => {
    const entry = json[bucket];
    const rpm = isRecord(entry) ? entry.rpm : undefined;
    if (typeof rpm === "number" && Number.isSafeInteger(rpm) && rpm >= 1) return rpm;
    problems.push(`${bucket}.rpm must be a whole number >= 1`);
    return 0;
  };
  const rates = {
    globalRpm: rpmOf(WORKER_RATE_BUCKETS.globalRpm),
    presentationRpm: rpmOf(WORKER_RATE_BUCKETS.presentationRpm),
    imageRpm: rpmOf(WORKER_RATE_BUCKETS.imageRpm),
    manifestRpm: rpmOf(WORKER_RATE_BUCKETS.manifestRpm),
    catalogueRpm: rpmOf(WORKER_RATE_BUCKETS.catalogueRpm),
    grapheDataRpm: rpmOf(WORKER_RATE_BUCKETS.grapheDataRpm),
  };
  if (problems.length > 0) throw new Error(`${RATES_ENV} is invalid — ${problems.join("; ")}`);
  const shares = gateRates(rates);
  if ("problems" in shares) throw new Error(`${RATES_ENV} is invalid — ${shares.problems.join("; ")}`);
  return { ...rates, ...shares };
}

/**
 * Env vars a previous release read and this one does not, with what replaced
 * each. Set, they mean a stale chart or .env: the worker refuses to boot
 * rather than look configured by a value nothing reads (the F-D3 class).
 */
export const RETIRED_ENV: Readonly<Record<string, string>> = {
  BNF_API_BASE_URL: "BNF_IIIF_PRESENTATION_BASE_URL and BNF_IIIF_IMAGE_BASE_URL",
  BNF_GLOBAL_RPM: `${RATES_ENV}.global.rpm`,
  BNF_PRESENTATION_RPM: `${RATES_ENV}.presentation.rpm`,
  BNF_IMAGE_RPM: `${RATES_ENV}.image.rpm`,
  BNF_MANIFEST_RPM: `${RATES_ENV}.manifest.rpm`,
  BNF_FETCH_CONCURRENCY: "BNF_ALTO_FETCH_CONCURRENCY and BNF_IMAGE_FETCH_CONCURRENCY",
  MISTRAL_IMAGE_SIZE: "nothing: the Mistral image size is chosen per canvas (bnf/image-size.ts MISTRAL_MAX_EDGE_PX)",
  VISION_IMAGE_SIZE: "nothing: the vision image size is chosen per canvas (bnf/image-size.ts VISION_MAX_EDGE_PX)",
};

/** Throw, naming the replacement, when a retired env var is set at all (an empty value included). */
export function rejectRetiredEnv(env: Env): void {
  for (const [name, replacement] of Object.entries(RETIRED_ENV)) {
    if (env[name] !== undefined) throw new Error(`${name} is retired — use ${replacement}`);
  }
}

/** The highest TCP port. */
const MAX_PORT = 65_535;

/**
 * The documented default of every knob (RUN.md, helm values) — named here once,
 * so loadConfigFrom below states only which env var feeds which field. The
 * reasons for each value are on the WorkerConfig field it fills.
 */
export const CONFIG_DEFAULTS = {
  httpPort: 7777,
  s3Prefix: "v2/",
  mistralEnabled: false,
  maxPages: 300,
  maxCanvases: 300,
  describeConcurrency: 16,
  describeCallConcurrency: 64,
  metadataConcurrency: 16,
  registerConcurrency: 24,
  embedConcurrency: 8,
  ocrSubmitConcurrency: 12,
  ocrPollConcurrency: 16,
  failRatio: 0.25,
  reconcilerIntervalMs: 60_000,
  reconcilerMaxRequeues: 3,
  reconcilerMaxCallbackFailures: 120,
} as const;

/** The whole worker config from `env`, validated. Pure, so it is unit-tested. */
export function loadConfigFrom(env: Env): WorkerConfig {
  rejectRetiredEnv(env);
  return {
    databaseUrl: requiredFrom(env, "DATABASE_URL"),
    httpPort: positiveIntFrom(env, "WORKER_HTTP_PORT", CONFIG_DEFAULTS.httpPort, { max: MAX_PORT }),
    s3: {
      bucket: requiredFrom(env, "SCW_S3_BUCKET"),
      endpoint: requiredFrom(env, "SCW_S3_ENDPOINT_URL"),
      region: requiredFrom(env, "SCW_S3_REGION"),
      accessKeyId: requiredFrom(env, "SCW_S3_ACCESS_KEY"),
      secretAccessKey: requiredFrom(env, "SCW_S3_SECRET_KEY"),
    },
    s3Prefix: stringFrom(env, "V2_S3_PREFIX", CONFIG_DEFAULTS.s3Prefix),
    mistralEnabled: boolFrom(env, "MISTRAL_OCR_ENABLED", CONFIG_DEFAULTS.mistralEnabled),
    maxPages: positiveIntFrom(env, "MAX_OCR_PAGES", CONFIG_DEFAULTS.maxPages),
    maxCanvases: positiveIntFrom(env, "MISTRAL_OCR_MAX_PAGES", CONFIG_DEFAULTS.maxCanvases),
    rates: workerRatesFrom(env),
    altoFetchConcurrency: requiredPositiveIntFrom(env, "BNF_ALTO_FETCH_CONCURRENCY"),
    imageFetchConcurrency: requiredPositiveIntFrom(env, "BNF_IMAGE_FETCH_CONCURRENCY"),
    describeConcurrency: positiveIntFrom(env, "DESCRIBE_CONCURRENCY", CONFIG_DEFAULTS.describeConcurrency),
    // 64: the vision lane is the bottleneck and the paid OpenRouter key has no
    // per-key RPM cap — push concurrency hard and let the in-call 429/timeout
    // backoff (vision.ts) ride the provider's capacity edge. See hardening-pass-2.
    describeCallConcurrency: positiveIntFrom(env, "DESCRIBE_CALL_CONCURRENCY", CONFIG_DEFAULTS.describeCallConcurrency),
    metadataConcurrency: positiveIntFrom(env, "METADATA_CONCURRENCY", CONFIG_DEFAULTS.metadataConcurrency),
    registerConcurrency: positiveIntFrom(env, "REGISTER_CONCURRENCY", CONFIG_DEFAULTS.registerConcurrency),
    embedConcurrency: positiveIntFrom(env, "EMBED_CONCURRENCY", CONFIG_DEFAULTS.embedConcurrency),
    ocrSubmitConcurrency: positiveIntFrom(env, "OCR_SUBMIT_CONCURRENCY", CONFIG_DEFAULTS.ocrSubmitConcurrency),
    ocrPollConcurrency: positiveIntFrom(env, "OCR_POLL_CONCURRENCY", CONFIG_DEFAULTS.ocrPollConcurrency),
    failRatio: ratioFrom(env, "DOC_FAIL_RATIO", CONFIG_DEFAULTS.failRatio),
    reconcilerIntervalMs: positiveIntFrom(env, "RECONCILER_INTERVAL_MS", CONFIG_DEFAULTS.reconcilerIntervalMs),
    reconcilerMaxRequeues: positiveIntFrom(env, "RECONCILER_MAX_REQUEUES", CONFIG_DEFAULTS.reconcilerMaxRequeues),
    reconcilerMaxCallbackFailures: positiveIntFrom(env, "RECONCILER_MAX_CALLBACK_FAILURES", CONFIG_DEFAULTS.reconcilerMaxCallbackFailures),
    ocrBackfill: loadOcrBackfillConfig(env),
  };
}

export function loadConfig(): WorkerConfig {
  return loadConfigFrom(process.env);
}
