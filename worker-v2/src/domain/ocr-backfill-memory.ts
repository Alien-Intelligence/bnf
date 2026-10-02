/**
 * In-memory OcrBackfillStore for unit tests. Single-threaded JS makes `request`
 * trivially atomic. The clock is injectable so the backoff and staleness rules
 * can be tested without waiting. Applies the same planRequest as the pg store
 * and is held to the same contract test (ocr-backfill.test.ts).
 */
import {
  OCR_BACKFILL_EXPIRED,
  OCR_BACKFILL_STATE,
  planRequest,
  validateOcrBackfillPolicy,
  type OcrBackfillCounts,
  type OcrBackfillPolicy,
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

  async request(ark: string, policy: OcrBackfillPolicy): Promise<OcrBackfillRequest> {
    validateOcrBackfillPolicy(policy);
    const now = new Date(this.now());
    const row = this.rows.get(ark) ?? null;
    const plan = planRequest(row, policy, now.getTime());
    switch (plan.action) {
      case "insert":
        this.rows.set(ark, {
          ark,
          state: OCR_BACKFILL_STATE.QUEUED,
          error: null,
          permanent: false,
          attempts: 0,
          requestedAt: now,
          updatedAt: now,
        });
        return { kind: "enqueue" };
      case "reopen":
        Object.assign(this.require(ark), {
          state: OCR_BACKFILL_STATE.QUEUED,
          error: null,
          permanent: false,
          attempts: plan.attempts,
          requestedAt: now,
          updatedAt: now,
        });
        return { kind: "enqueue" };
      case "expire":
        Object.assign(this.require(ark), {
          state: OCR_BACKFILL_STATE.FAILED,
          error: OCR_BACKFILL_EXPIRED,
          permanent: true,
          attempts: plan.attempts,
          updatedAt: now,
        });
        return { kind: "failed", reason: OCR_BACKFILL_EXPIRED, permanent: true };
      case "report":
        return plan.result;
    }
  }

  async markDone(ark: string): Promise<void> {
    Object.assign(this.require(ark), {
      state: OCR_BACKFILL_STATE.DONE,
      error: null,
      permanent: false,
      updatedAt: new Date(this.now()),
    });
  }

  async markFailed(ark: string, reason: string, opts: { permanent: boolean }): Promise<void> {
    const row = this.require(ark);
    Object.assign(row, {
      state: OCR_BACKFILL_STATE.FAILED,
      error: reason,
      permanent: opts.permanent,
      attempts: row.attempts + 1,
      updatedAt: new Date(this.now()),
    });
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
