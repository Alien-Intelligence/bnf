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
// Tuned for "completes cleanly without tripping Gallica". A 205-doc run at high
// concurrency + 8 rps got our egress IP hard-blocked by Gallica, and a short
// retry base then failed the throttled docs inside the (sticky) block window.
// So the retry span is deliberately long — prevention is the concurrency/rate
// knobs (WORKER_CONCURRENCY / GALLICA_GENERAL_RPS); this is the safety net:
//   - jobExpireSeconds: per-doc-job wall-clock ceiling. Generous (4h) so the
//     rare slow book or ALTO fallback still finishes; bounded so a wedged job
//     can't run forever. MUST exceed the worst-case OCR time for maxOcrPages.
//   - retryLimit / retryDelaySeconds: a transiently-failed doc retries with
//     exponential backoff off a 60s base (60→120→240→480→960s, ~32 min span) —
//     long enough to OUTLAST a Gallica throttle window. Parked docs are visible
//     as "N en reprise" in the UI (stage-pipeline outcomes line), so the long
//     park no longer reads as a frozen bar the way it did before that landed.
//   - maxOcrPages: hard ceiling so the worst case is bounded (no unbounded loop
//     — see ../../CLAUDE_ERROR_PATTERNS.md §14).
export const ingest = {
  jobExpireSeconds: () => optionalInt("INGEST_JOB_EXPIRE_SECONDS", 4 * 60 * 60),
  retryLimit: () => optionalInt("INGEST_RETRY_LIMIT", 5),
  retryDelaySeconds: () => optionalInt("INGEST_RETRY_DELAY_SECONDS", 60),
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

// --- Mistral fallback OCR (Track 1, `sans_texte` documents) ---
//
// Paid OCR (Mistral Batch API) for digitized text with no BnF OCR layer. OFF by
// default. The APP is the spend gatekeeper — it only sends `sans_texte` ARKs to
// the worker once a human has confirmed the cost — so the worker runs Mistral
// for ANY such doc it receives when this flag is on. Keep MISTRAL_OCR_ENABLED
// here in lock-step with the project's paid-OCR confirmation flow, or a
// confirmed doc reaches a worker that can't transcribe it (it then skips).
//
//   - maxPages: hard per-doc folio ceiling (mirrors the app's
//     PAID_OCR_MAX_PAGES_PER_DOC); bounds the worst-case spend + upload size.
//   - batchTimeoutMs: wall-clock ceiling on the poll loop — MUST stay under the
//     doc-job ceiling (INGEST_JOB_EXPIRE_SECONDS) so a stuck batch fails the doc
//     (→ pg-boss retry) instead of wedging the worker (CLAUDE_ERROR_PATTERNS §14).
export const mistralOcr = {
  enabled: (): boolean => {
    const v = optional("MISTRAL_OCR_ENABLED", "false")!;
    if (v !== "true" && v !== "false") {
      throw new Error(`MISTRAL_OCR_ENABLED must be "true" or "false", got: ${v}`);
    }
    return v === "true";
  },
  apiKey: () => required("MISTRAL_API_KEY"),
  model: () => optional("MISTRAL_OCR_MODEL", "mistral-ocr-latest")!,
  maxPages: () => optionalInt("MISTRAL_OCR_MAX_PAGES", 300),
  pollIntervalMs: () => optionalInt("MISTRAL_OCR_POLL_INTERVAL_MS", 5_000),
  batchTimeoutMs: () => optionalInt("MISTRAL_OCR_BATCH_TIMEOUT_MS", 30 * 60 * 1_000),
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
