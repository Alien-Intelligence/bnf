/**
 * In-memory OcrBackfillStore for unit tests. Single-threaded JS makes `request`
 * trivially atomic. The clock is injectable so the retry-age rule can be tested
 * without waiting.
 */
import {
  OCR_BACKFILL_STATE,
  type OcrBackfillCounts,
  type OcrBackfillRequest,
  type OcrBackfillRow,
  type OcrBackfillStore,
} from "./ocr-backfill.js";

export class MemoryOcrBackfillStore implements OcrBackfillStore {
  private readonly rows = new Map<string, OcrBackfillRow>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async request(ark: string, retryFailedOlderThanMs: number): Promise<OcrBackfillRequest> {
    const now = this.now();
    const row = this.rows.get(ark);
    if (!row) {
      this.rows.set(ark, {
        ark,
        state: OCR_BACKFILL_STATE.QUEUED,
        error: null,
        attempts: 0,
        requestedAt: new Date(now),
        updatedAt: new Date(now),
      });
      return { kind: "enqueue" };
    }
    const reopen =
      row.state === OCR_BACKFILL_STATE.DONE ||
      (row.state === OCR_BACKFILL_STATE.FAILED &&
        row.updatedAt.getTime() < now - retryFailedOlderThanMs);
    if (reopen) {
      row.state = OCR_BACKFILL_STATE.QUEUED;
      row.error = null;
      row.requestedAt = new Date(now);
      row.updatedAt = new Date(now);
      return { kind: "enqueue" };
    }
    if (row.state === OCR_BACKFILL_STATE.FAILED) {
      return { kind: "failed", reason: row.error ?? "unknown" };
    }
    return { kind: "queued" };
  }

  async markDone(ark: string): Promise<void> {
    const row = this.require(ark);
    row.state = OCR_BACKFILL_STATE.DONE;
    row.error = null;
    row.updatedAt = new Date(this.now());
  }

  async markFailed(ark: string, reason: string): Promise<void> {
    const row = this.require(ark);
    row.state = OCR_BACKFILL_STATE.FAILED;
    row.error = reason;
    row.attempts += 1;
    row.updatedAt = new Date(this.now());
  }

  async get(ark: string): Promise<OcrBackfillRow | null> {
    const row = this.rows.get(ark);
    return row ? { ...row } : null;
  }

  async counts(): Promise<OcrBackfillCounts> {
    const out: OcrBackfillCounts = { queued: 0, done: 0, failed: 0 };
    for (const row of this.rows.values()) out[row.state] += 1;
    return out;
  }

  private require(ark: string): OcrBackfillRow {
    const row = this.rows.get(ark);
    if (!row) throw new Error(`ocr-backfill: no row for ${ark}`);
    return row;
  }
}
