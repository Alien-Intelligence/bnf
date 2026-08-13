/**
 * Infra config for the worker-v2 entrypoint — DB, S3, broker, the paid-OCR flag,
 * and the per-stage rate knobs. Required vars THROW at startup if missing (no
 * empty defaults — platform CLAUDE_ERROR_PATTERNS §10). The downstream live
 * clients (vision/mistral/embed/cluster) read their OWN secrets from env, mirroring
 * V1's names, so they are not duplicated here.
 */
function required(name: string): string {
  const v = process.env[name];
  if (v == null || v.trim() === "") throw new Error(`Missing required env var ${name}`);
  return v.trim();
}
function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${v}`);
  return Math.floor(n);
}
function optionalBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === "") return fallback;
  if (v !== "true" && v !== "false") throw new Error(`${name} must be "true"|"false", got ${v}`);
  return v === "true";
}
/** A ratio var (0 < v <= 1) — NaN or an out-of-range value throws rather than
 *  silently disabling whatever gate reads it (F23,
 *  ai-memories/tech/repos/bnf/ingest-hardening: `Number(env ?? fallback)` let a
 *  typo'd DOC_FAIL_RATIO become NaN, which compares false against every ratio
 *  and quietly turns the Monitor's fail-ratio gate off). */
function optionalFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${name} must be a number in (0, 1], got ${v}`);
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
}

export function loadConfig(): WorkerConfig {
  return {
    databaseUrl: required("DATABASE_URL"),
    httpPort: optionalInt("WORKER_HTTP_PORT", 7777),
    s3: {
      bucket: required("SCW_S3_BUCKET"),
      endpoint: required("SCW_S3_ENDPOINT_URL"),
      region: required("SCW_S3_REGION"),
      accessKeyId: required("SCW_S3_ACCESS_KEY"),
      secretAccessKey: required("SCW_S3_SECRET_KEY"),
    },
    s3Prefix: process.env.V2_S3_PREFIX?.trim() || "v2/",
    mistralEnabled: optionalBool("MISTRAL_OCR_ENABLED", false),
    maxPages: optionalInt("MAX_OCR_PAGES", 300),
    maxCanvases: optionalInt("MISTRAL_OCR_MAX_PAGES", 300),
    fetchRatePerMin: optionalInt("BNF_GLOBAL_RPM", 300),
    fetchConcurrency: optionalInt("BNF_FETCH_CONCURRENCY", 32),
    manifestRatePerMin: optionalInt("BNF_MANIFEST_RPM", 42),
    visionImageSize: process.env.VISION_IMAGE_SIZE?.trim() || "pct:33",
    mistralImageSize: process.env.MISTRAL_IMAGE_SIZE?.trim() || "max",
    describeConcurrency: optionalInt("DESCRIBE_CONCURRENCY", 16),
    // 64: the vision lane is the bottleneck and the paid OpenRouter key has no
    // per-key RPM cap — push concurrency hard and let the in-call 429/timeout
    // backoff (vision.ts) ride the provider's capacity edge. See hardening-pass-2.
    describeCallConcurrency: optionalInt("DESCRIBE_CALL_CONCURRENCY", 64),
    metadataConcurrency: optionalInt("METADATA_CONCURRENCY", 16),
    registerConcurrency: optionalInt("REGISTER_CONCURRENCY", 24),
    embedConcurrency: optionalInt("EMBED_CONCURRENCY", 8),
    ocrSubmitConcurrency: optionalInt("OCR_SUBMIT_CONCURRENCY", 12),
    ocrPollConcurrency: optionalInt("OCR_POLL_CONCURRENCY", 16),
    failRatio: optionalFloat("DOC_FAIL_RATIO", 0.25),
    reconcilerIntervalMs: optionalInt("RECONCILER_INTERVAL_MS", 60_000),
    reconcilerMaxRequeues: optionalInt("RECONCILER_MAX_REQUEUES", 3),
    reconcilerMaxCallbackFailures: optionalInt("RECONCILER_MAX_CALLBACK_FAILURES", 120),
  };
}
