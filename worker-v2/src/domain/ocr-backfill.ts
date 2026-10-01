/**
 * OCR-quality backfill store — one row per ARK whose `ocr-quality/<slug>.json`
 * artifact the app asked for (POST /ocr-quality/sync) and S3 lacked. It exists
 * for two things only:
 *   - dedupe: however many app sweeps ask for the same missing ARK, exactly one
 *     build is queued (`request` is the atomic gate the endpoint sends behind);
 *   - progress: `counts()` is what `npm run status` prints for the backfill.
 * The ARTIFACT is the truth about completion, not the row — a `done` row whose
 * artifact has vanished is re-queued on the next request.
 *
 * Two implementations behind one interface (memory for tests, pg for prod),
 * the same split as doc-state and run-store.
 */

export const OCR_BACKFILL_STATE = {
  QUEUED: "queued",
  DONE: "done",
  FAILED: "failed",
} as const;
export type OcrBackfillState = (typeof OCR_BACKFILL_STATE)[keyof typeof OCR_BACKFILL_STATE];

export interface OcrBackfillRow {
  ark: string;
  state: OcrBackfillState;
  /** The terminal reason of the last failed build; null otherwise. */
  error: string | null;
  /** Terminal failures so far (one per failed build, across re-queues). */
  attempts: number;
  requestedAt: Date;
  updatedAt: Date;
}

/**
 * What `request` decided:
 *   - `enqueue`: the caller owns this ARK's build and must send it to the
 *     backfill queue (new row, or a failed/done row that was re-opened);
 *   - `queued`: a build is already queued — do not send again;
 *   - `failed`: a build failed recently (younger than the retry age) — report
 *     the reason to the app and do not send.
 */
export type OcrBackfillRequest =
  | { kind: "enqueue" }
  | { kind: "queued" }
  | { kind: "failed"; reason: string };

export interface OcrBackfillCounts {
  queued: number;
  done: number;
  failed: number;
}

export interface OcrBackfillStore {
  /**
   * Atomically claim a build for `ark`. Inserts a queued row when none exists;
   * re-opens a `done` row (its artifact is gone) or a `failed` row older than
   * `retryFailedOlderThanMs`. Any other existing row is left as it is and
   * reported (`queued` / `failed`).
   */
  request(ark: string, retryFailedOlderThanMs: number): Promise<OcrBackfillRequest>;
  markDone(ark: string): Promise<void>;
  /** Terminal failure of one build: stores `reason`, increments `attempts`. */
  markFailed(ark: string, reason: string): Promise<void>;
  get(ark: string): Promise<OcrBackfillRow | null>;
  counts(): Promise<OcrBackfillCounts>;
}
