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
  fetchConcurrency: number;
  /** IIIF manifest rate (per egress IP). */
  manifestRatePerMin: number;
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
    fetchConcurrency: optionalInt("BNF_FETCH_CONCURRENCY", 12),
    manifestRatePerMin: optionalInt("BNF_MANIFEST_RPM", 42),
    failRatio: Number(process.env.DOC_FAIL_RATIO ?? "0.25"),
  };
}
