/**
 * Required-env validator. Throws at startup if anything is missing.
 *
 * Each Track only reads the slice it owns; an empty value for a Track-3 env
 * does not crash Track 1 — required() is called lazily by each module.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var: ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

/** Read a positive integer env var, or fall back. Throws on a present-but-junk value. */
function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}=${raw}: must be a positive integer.`);
  }
  return n;
}

// --- Postgres / pg-boss ---
export const db = {
  url: () => required("DATABASE_URL"),
};

// --- Blob storage ---
export const blob = {
  driver: (): "s3" | "local" => {
    const v = optional("BLOB_STORE", "s3");
    if (v !== "s3" && v !== "local") {
      throw new Error(`BLOB_STORE must be "s3" or "local", got: ${v}`);
    }
    return v;
  },
  s3: {
    bucket: () => required("SCW_S3_BUCKET"),
    accessKey: () => required("SCW_S3_ACCESS_KEY"),
    secretKey: () => required("SCW_S3_SECRET_KEY"),
    endpoint: () => required("SCW_S3_ENDPOINT_URL"),
    region: () => required("SCW_S3_REGION"),
  },
  localRoot: () => optional("LOCAL_BLOB_ROOT", "./data")!,
};

// --- Ingest reliability knobs (Track 2) ---
//
// Tuned for "slow but always completes". Gallica's ALTO endpoint is capped at
// ~5 req/min (GALLICA_RPS), so a long OCR book legitimately takes tens of
// minutes. These knobs make pg-boss patient enough to let that finish instead
// of force-expiring and looping:
//   - jobExpireSeconds: per-doc-job wall-clock ceiling. MUST exceed the
//     worst-case time to OCR `maxOcrPages` at the configured rate (with
//     concurrency contention on the shared token bucket). Default 4h.
//   - retryLimit / retryDelaySeconds: a transiently-throttled doc gets retried
//     several times with exponential backoff, spreading attempts across ~1h so
//     Gallica's throttle window has cleared by the time we come back.
//   - maxOcrPages: hard ceiling so the worst case is bounded (no unbounded loop
//     — see ../../CLAUDE_ERROR_PATTERNS.md §14).
export const ingest = {
  jobExpireSeconds: () => optionalInt("INGEST_JOB_EXPIRE_SECONDS", 4 * 60 * 60),
  retryLimit: () => optionalInt("INGEST_RETRY_LIMIT", 5),
  retryDelaySeconds: () => optionalInt("INGEST_RETRY_DELAY_SECONDS", 120),
  maxOcrPages: () => optionalInt("MAX_OCR_PAGES", 300),
};

// --- Scaleway GenAI / Holo2 (Track 1, primary vision) ---
export const genai = {
  apiKey: () => required("SCW_API_KEY"),
  baseUrl: () => required("SCW_GENAI_BASE_URL"),
  holoModel: () => required("HOLO_MODEL"),
};

// --- Google AI (Track 1, vision provider) ---
// gemma-4-31b-it is a reasoning model: it burns "thoughts" tokens, so the
// output budget must be generous (see vision.ts).
export const google = {
  apiKey: () => required("GOOGLE_AI_API_KEY"),
  visionModel: () => optional("GEMINI_VISION_MODEL", "gemma-4-31b-it")!,
};

// --- Vision provider order ---
// "holo" → Scaleway Holo2 primary, Gemini fallback (long-term default).
// "gemini" → Gemini primary, Holo fallback (use while Holo/Scaleway is down,
//   so we don't waste a round-trip on a known-bad endpoint).
export const vision = {
  primary: (): "holo" | "gemini" => {
    const v = optional("VISION_PRIMARY", "holo");
    if (v !== "holo" && v !== "gemini") {
      throw new Error(`VISION_PRIMARY must be "holo" or "gemini", got: ${v}`);
    }
    return v;
  },
};

// --- RunPod embedder (Track 3) ---
export const runpod = {
  apiKey: () => required("RUNPOD_API_KEY"),
  endpointId: () => required("RUNPOD_EMBEDDING_ENDPOINT_ID"),
  model: () => optional("RUNPOD_EMBEDDING_MODEL", "BAAI/bge-m3")!,
};

// --- Data cluster (Track 3) ---
export const cluster = {
  backendUrl: () => required("BACKEND_API_URL"),
  clusterId: () => required("CLUSTER_ID"),
  bearerToken: () => required("CLUSTER_BEARER_TOKEN"),
  /** The proxy URL data-api calls go through. */
  baseUrl: () =>
    `${required("BACKEND_API_URL").replace(/\/+$/, "")}/clusters/${required("CLUSTER_ID")}/proxy`,
};
