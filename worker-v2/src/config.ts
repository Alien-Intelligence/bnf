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
  /** BnF fetch rate (folios/min) — 300 today; 1000 if the per-IP raise lands. */
  fetchRatePerMin: number;
  /** In-flight folio fetches. Must be high enough that fetches-in-progress keep
   *  the 300/min token bucket drained (≈ rate/60 × per-fetch latency). 12 measured
   *  ~178/min (latency ~4s); 24 is the floor to approach the cap. */
  fetchConcurrency: number;
  /** IIIF manifest rate (per egress IP). */
  manifestRatePerMin: number;
  /** IIIF size for VISION-lane images (pct:N — BnF-safe downscale). Full-res
   *  ("max") images time out the vision API under concurrency; vision only needs
   *  a description. Mistral OCR keeps full res. */
  visionImageSize: string;
  /** Vision-lane DOC concurrency — how many docs the describe stage processes at
   *  once. */
  describeConcurrency: number;
  /** Vision-lane CALL concurrency — the shared cap on total in-flight vision API
   *  calls across all docs (a doc fans its folios out up to this). The real
   *  OpenRouter/Holo ceiling; keep under the provider's rate/DDoS limit. */
  describeCallConcurrency: number;
  /** Embed (RunPod) concurrency. */
  embedConcurrency: number;
  /** Mistral OCR batch-submit concurrency (how many docs OCR in parallel). */
  ocrSubmitConcurrency: number;
  /** Mistral OCR batch-poll concurrency (cheap GETs). */
  ocrPollConcurrency: number;
  failRatio: number;
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
    describeConcurrency: optionalInt("DESCRIBE_CONCURRENCY", 16),
    describeCallConcurrency: optionalInt("DESCRIBE_CALL_CONCURRENCY", 24),
    embedConcurrency: optionalInt("EMBED_CONCURRENCY", 8),
    ocrSubmitConcurrency: optionalInt("OCR_SUBMIT_CONCURRENCY", 12),
    ocrPollConcurrency: optionalInt("OCR_POLL_CONCURRENCY", 16),
    failRatio: Number(process.env.DOC_FAIL_RATIO ?? "0.25"),
  };
}
