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

// --- Ingest reliability knobs: REMOVED (V1 leftovers) ---
//
// `ingest.jobExpireSeconds` / `retryLimit` / `retryDelaySeconds` (env
// INGEST_JOB_EXPIRE_SECONDS / INGEST_RETRY_LIMIT / INGEST_RETRY_DELAY_SECONDS)
// were V1's pg-boss knobs and had ZERO callers in v2 — while the prod configmap
// still set them, so operators believed jobs had a 4h ceiling when the real
// ceiling was pg-boss's silent 15-minute default and the wedge that followed from
// it (F10, ai-memories/tech/repos/bnf/ingest-hardening). In v2 each STAGE declares
// its own retry policy and per-delivery expiration (PipelineStage.retry /
// .expireInSeconds), and `MAX_OCR_PAGES` is read by config.ts. Dead config that
// looks live is worse than no config.

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

// --- OpenRouter (Track 1, PRIMARY vision provider) ---
// OpenAI-compatible gateway — the reliable primary (Scaleway Holo flakes). Called
// via raw undici against /chat/completions (same reason as Holo: keep the OpenAI
// SDK out). Key shared with the app's agent (OPENROUTER_API_KEY).
// google/gemini-2.5-flash: a FAST multimodal model, not a reasoning model. The
// previous default (gemma-4-31b-it) burns hidden "thoughts" tokens on every image —
// 30s+ per describe — which made the vision lane the pipeline bottleneck. For image
// DESCRIPTION (not deep reasoning) flash is sub-5s typical, strong French + clean
// JSON, and OpenRouter has no per-key RPM cap on this paid key, so the only ceiling
// is upstream provider capacity (handled by the in-call 429/timeout backoff).
export const openrouter = {
  apiKey: () => required("OPENROUTER_API_KEY"),
  baseUrl: () => optional("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")!,
  model: () => optional("OPENROUTER_VISION_MODEL", "google/gemini-2.5-flash")!,
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
//     OCR stages' per-delivery expiration (PipelineStage.expireInSeconds) so a
//     stuck batch fails the doc (→ pg-boss retry) instead of being killed from
//     outside by an expiration, which runs no handler code and orphans the doc
//     (CLAUDE_ERROR_PATTERNS §14, plus F7 in the ingest-hardening audit).
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
