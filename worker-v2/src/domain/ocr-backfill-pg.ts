/**
 * Postgres OcrBackfillStore — the production store (twin of the memory one).
 * Shares the worker's pg Pool; the table is applied by PgDocState.migrate()
 * (schema.sql). `request` is ONE statement: an INSERT … ON CONFLICT DO UPDATE
 * whose WHERE re-opens only a done row or a stale failed row, so concurrent
 * sync calls for the same ARK cannot both win the build.
 */
import type { Pool } from "pg";

import {
  OCR_BACKFILL_STATE,
  type OcrBackfillCounts,
  type OcrBackfillRequest,
  type OcrBackfillRow,
  type OcrBackfillState,
  type OcrBackfillStore,
} from "./ocr-backfill.js";

const TABLE = "sandbox_ingest_v2.ocr_quality_backfill";

interface Row {
  ark: string;
  state: OcrBackfillState;
  error: string | null;
  attempts: number;
  requested_at: Date;
  updated_at: Date;
}

function toRow(r: Row): OcrBackfillRow {
  return {
    ark: r.ark,
    state: r.state,
    error: r.error,
    attempts: Number(r.attempts),
    requestedAt: r.requested_at,
    updatedAt: r.updated_at,
  };
}

export class PgOcrBackfillStore implements OcrBackfillStore {
  constructor(private readonly pool: Pool) {}

  async request(ark: string, retryFailedOlderThanMs: number): Promise<OcrBackfillRequest> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO ${TABLE} AS t (ark, state) VALUES ($1, $2)
       ON CONFLICT (ark) DO UPDATE
         SET state = $2, error = NULL, requested_at = now(), updated_at = now()
         WHERE t.state = $3
            OR (t.state = $4 AND t.updated_at < now() - ($5::bigint * interval '1 millisecond'))`,
      [
        ark,
        OCR_BACKFILL_STATE.QUEUED,
        OCR_BACKFILL_STATE.DONE,
        OCR_BACKFILL_STATE.FAILED,
        retryFailedOlderThanMs,
      ],
    );
    if ((rowCount ?? 0) > 0) return { kind: "enqueue" };

    const existing = await this.get(ark);
    if (existing?.state === OCR_BACKFILL_STATE.FAILED) {
      return { kind: "failed", reason: existing.error ?? "unknown" };
    }
    return { kind: "queued" };
  }

  async markDone(ark: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE} SET state = $2, error = NULL, updated_at = now() WHERE ark = $1`,
      [ark, OCR_BACKFILL_STATE.DONE],
    );
  }

  async markFailed(ark: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE}
         SET state = $2, error = $3, attempts = attempts + 1, updated_at = now()
       WHERE ark = $1`,
      [ark, OCR_BACKFILL_STATE.FAILED, reason],
    );
  }

  async get(ark: string): Promise<OcrBackfillRow | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM ${TABLE} WHERE ark = $1`, [ark]);
    const r = rows[0];
    return r ? toRow(r) : null;
  }

  async counts(): Promise<OcrBackfillCounts> {
    const out: OcrBackfillCounts = { queued: 0, done: 0, failed: 0 };
    const { rows } = await this.pool.query<{ state: OcrBackfillState; n: string }>(
      `SELECT state, count(*) AS n FROM ${TABLE} GROUP BY state`,
    );
    for (const r of rows) {
      if (r.state in out) out[r.state] = Number(r.n);
    }
    return out;
  }
}
