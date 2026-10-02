/**
 * OCR-quality backfill store — one row per ARK whose `ocr-quality/<slug>.json`
 * artifact the app asked for (POST /ocr-quality/sync) while S3 had no valid one.
 * It exists for three things:
 *   - dedupe: however many app sweeps ask for the same missing ARK, at most one
 *     build is queued at a time (`request` is the atomic gate);
 *   - bounded retries: a failed build is retried with exponential backoff up to
 *     OCR_BACKFILL_MAX_ATTEMPTS, a PERMANENT failure (no metadata, no pages,
 *     unclassifiable, a permanent BnF error) is never retried, and a `queued`
 *     row whose build never reported back (pg-boss expired the delivery, which
 *     runs no handler) is re-queued once it is stale — so no ARK stays
 *     `building` forever;
 *   - progress: `counts()` is what `npm run status` prints.
 *
 * The ARTIFACT is the truth about completion, not the row. `request` is called
 * ONLY when the artifact is missing or invalid (live/ocr-quality-sync.ts checks
 * it — the one place that does); a `done` row reaching `request` therefore lost
 * its artifact and is re-opened.
 *
 * Two implementations behind one interface (memory for tests, pg for prod), the
 * same split as doc-state and run-store. Both apply the SAME pure decision
 * (`planRequest`) and are held to one contract test (ocr-backfill.test.ts).
 */

export const OCR_BACKFILL_STATE = {
  QUEUED: "queued",
  DONE: "done",
  FAILED: "failed",
} as const;
export type OcrBackfillState = (typeof OCR_BACKFILL_STATE)[keyof typeof OCR_BACKFILL_STATE];

function isOcrBackfillState(v: unknown): v is OcrBackfillState {
  return (
    v === OCR_BACKFILL_STATE.QUEUED || v === OCR_BACKFILL_STATE.DONE || v === OCR_BACKFILL_STATE.FAILED
  );
}

/** A stored state, validated on read: an unknown value is a corrupt row and throws. */
export function parseOcrBackfillState(v: unknown, ark: string): OcrBackfillState {
  if (!isOcrBackfillState(v)) {
    throw new Error(`ocr_quality_backfill row ${ark}: unknown state ${JSON.stringify(v)}`);
  }
  return v;
}

/** Builds attempted per ARK before its failure is final (failures + expiries). */
export const OCR_BACKFILL_MAX_ATTEMPTS = 5;

/**
 * A `queued` row older than this has no live build: the backfill stage's
 * delivery ceiling is 1 h (expireInSeconds) and its transport retries add a few
 * minutes, so 6 h only ever matches a build that was expired or lost.
 */
export const OCR_BACKFILL_QUEUED_STALE_MS = 6 * 60 * 60 * 1_000;

/** Failure reason recorded when a queued build never reported back. */
export const OCR_BACKFILL_EXPIRED = "build_expired";

export interface OcrBackfillPolicy {
  /** Base backoff before a transient failure is retried; doubles per attempt. */
  retryFailedAfterMs: number;
  /** Total build attempts (failures + expiries) before a failure is final. */
  maxAttempts: number;
  /** Age after which a queued row is treated as an expired build. */
  queuedStaleAfterMs: number;
}

/** A policy with non-positive or fractional values is a configuration error. */
export function validateOcrBackfillPolicy(p: OcrBackfillPolicy): OcrBackfillPolicy {
  for (const [name, v] of Object.entries(p)) {
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new Error(`ocr-backfill policy: ${name} must be a positive integer, got ${String(v)}`);
    }
  }
  return p;
}

export interface OcrBackfillRow {
  ark: string;
  state: OcrBackfillState;
  /** The reason of the last failed build; null otherwise. */
  error: string | null;
  /** True when the last failure can never succeed on a retry. */
  permanent: boolean;
  /** Builds that failed or expired so far. */
  attempts: number;
  requestedAt: Date;
  updatedAt: Date;
}

/**
 * What `request` decided:
 *   - `enqueue`: the caller owns this ARK's build and must send it to the
 *     backfill queue — and must `markFailed` it if that send fails, so the claim
 *     is released instead of stranding a `queued` row;
 *   - `queued`: a build is already queued — do not send again;
 *   - `failed`: the last build failed and is not due for a retry (or never will
 *     be) — report the reason to the app and do not send.
 */
export type OcrBackfillRequest =
  | { kind: "enqueue" }
  | { kind: "queued" }
  | { kind: "failed"; reason: string; permanent: boolean };

/** How `request` must change the stored row — the shared pure decision. */
export type OcrBackfillPlan =
  | { action: "insert" }
  | { action: "reopen"; attempts: number }
  | { action: "expire"; attempts: number }
  | { action: "report"; result: OcrBackfillRequest };

/** Backoff before retrying after `attempts` failures: base × 2^(attempts−1). */
export function retryBackoffMs(policy: OcrBackfillPolicy, attempts: number): number {
  return policy.retryFailedAfterMs * 2 ** Math.max(0, attempts - 1);
}

/**
 * The ONE decision `request` makes, applied identically by both stores:
 *   - no row → insert a queued row (enqueue);
 *   - done → its artifact is gone (the caller checked) → re-open, attempts reset;
 *   - queued, fresh → already queued;
 *   - queued, stale → the build expired: count the attempt; re-open while
 *     attempts remain, else record a permanent `build_expired` failure;
 *   - failed, permanent or out of attempts → report the reason, forever;
 *   - failed, transient, past its backoff → re-open (same attempt count);
 *   - failed, transient, inside its backoff → report the reason.
 */
export function planRequest(
  row: OcrBackfillRow | null,
  policy: OcrBackfillPolicy,
  now: number,
): OcrBackfillPlan {
  if (row === null) return { action: "insert" };
  switch (row.state) {
    case OCR_BACKFILL_STATE.DONE:
      return { action: "reopen", attempts: 0 };
    case OCR_BACKFILL_STATE.QUEUED: {
      if (now - row.requestedAt.getTime() < policy.queuedStaleAfterMs) {
        return { action: "report", result: { kind: "queued" } };
      }
      const attempts = row.attempts + 1;
      return attempts >= policy.maxAttempts
        ? { action: "expire", attempts }
        : { action: "reopen", attempts };
    }
    case OCR_BACKFILL_STATE.FAILED: {
      const reason = requireReason(row);
      const final = row.permanent || row.attempts >= policy.maxAttempts;
      if (!final && now - row.updatedAt.getTime() >= retryBackoffMs(policy, row.attempts)) {
        return { action: "reopen", attempts: row.attempts };
      }
      return { action: "report", result: { kind: "failed", reason, permanent: final } };
    }
  }
}

/** A failed row always carries its reason; one without is a corrupt row. */
function requireReason(row: OcrBackfillRow): string {
  if (row.error === null) {
    throw new Error(`ocr_quality_backfill row ${row.ark}: failed without a reason`);
  }
  return row.error;
}

export interface OcrBackfillCounts {
  queued: number;
  done: number;
  failed: number;
}

export interface OcrBackfillStore {
  /**
   * Atomically decide and apply what a request for `ark` does (planRequest).
   * Call ONLY when the artifact is missing or invalid.
   */
  request(ark: string, policy: OcrBackfillPolicy): Promise<OcrBackfillRequest>;
  /** The build succeeded. Throws when no row exists for `ark`. */
  markDone(ark: string): Promise<void>;
  /**
   * The build failed: stores `reason` and whether it is permanent, increments
   * `attempts`. Also releases an `enqueue` claim whose queue send failed.
   * Throws when no row exists for `ark`.
   */
  markFailed(ark: string, reason: string, opts: { permanent: boolean }): Promise<void>;
  get(ark: string): Promise<OcrBackfillRow | null>;
  counts(): Promise<OcrBackfillCounts>;
}

/**
 * Everything the backfill needs, built ONCE from config (main.ts) and handed to
 * both buildPipeline (registers the stage iff `enabled`) and the HTTP server
 * (enqueues iff `enabled`) — so the endpoint can never queue a build no stage
 * consumes, and the stage never runs when the endpoint is told not to spend.
 */
export interface OcrBackfillWiring {
  store: OcrBackfillStore;
  /** OCR_BACKFILL_ENABLED. */
  enabled: boolean;
  policy: OcrBackfillPolicy;
  /** OCR_BACKFILL_CONCURRENCY — in-flight backfill documents (≥ 1). */
  concurrency: number;
}
