/**
 * In-memory OcrBackfillStore for unit tests. Single-threaded JS makes `request`
 * trivially atomic. The clock is injectable so the backoff and staleness rules
 * can be tested without waiting. Applies the same planRequest as the pg store
 * and is held to the same contract test (ocr-backfill.test.ts).
 */
import {
  OCR_BACKFILL_MARK,
  OCR_BACKFILL_STATE,
  planRequest,
  validateOcrBackfillPolicy,
  type OcrBackfillCounts,
  type OcrBackfillMark,
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

  async request(ark: string, policy: OcrBackfillPolicy, signal: AbortSignal): Promise<OcrBackfillRequest> {
    validateOcrBackfillPolicy(policy);
    signal.throwIfAborted();
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
          startedAt: null,
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
          startedAt: null,
          updatedAt: now,
        });
        return { kind: "enqueue" };
      case "expire":
        Object.assign(this.require(ark), {
          state: OCR_BACKFILL_STATE.FAILED,
          error: plan.reason,
          permanent: true,
          attempts: plan.attempts,
          updatedAt: now,
        });
        return { kind: "failed", reason: plan.reason, permanent: true };
      case "report":
        return plan.result;
    }
  }

  async markStarted(ark: string): Promise<OcrBackfillMark> {
    const now = new Date(this.now());
    return this.markQueued(ark, { startedAt: now, updatedAt: now });
  }

  async markDone(ark: string): Promise<OcrBackfillMark> {
    return this.markQueued(ark, {
      state: OCR_BACKFILL_STATE.DONE,
      error: null,
      permanent: false,
      updatedAt: new Date(this.now()),
    });
  }

  async markFailed(ark: string, reason: string, opts: { permanent: boolean }): Promise<OcrBackfillMark> {
    const row = this.require(ark);
    return this.markQueued(ark, {
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

  /** Apply `change` to a QUEUED row only — the same guard as the pg store's `AND state = 'queued'`. */
  private markQueued(ark: string, change: Partial<OcrBackfillRow>): OcrBackfillMark {
    const row = this.require(ark);
    if (row.state !== OCR_BACKFILL_STATE.QUEUED) return OCR_BACKFILL_MARK.NOT_QUEUED;
    Object.assign(row, change);
    return OCR_BACKFILL_MARK.APPLIED;
  }

  private require(ark: string): OcrBackfillRow {
    const row = this.rows.get(ark);
    if (!row) throw new Error(`ocr-backfill: no row for ${ark}`);
    return row;
  }
}
