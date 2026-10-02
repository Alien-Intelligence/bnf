/**
 * Postgres OcrBackfillStore — the production store (twin of the memory one).
 * Shares the worker's pg Pool; the table is applied by PgDocState.migrate()
 * (schema.sql), with a CHECK on `state`.
 *
 * `request` runs in ONE transaction: insert-if-absent, otherwise lock the row
 * (SELECT … FOR UPDATE), apply the shared planRequest decision and write it —
 * so concurrent sync calls for the same ARK cannot both win the build. The
 * clock is the caller's (injectable), as in the memory store, so both apply the
 * backoff and staleness rules against the same time source.
 */
import type { Pool, PoolClient } from "pg";

import {
  OCR_BACKFILL_EXPIRED,
  OCR_BACKFILL_STATE,
  parseOcrBackfillState,
  planRequest,
  validateOcrBackfillPolicy,
  type OcrBackfillCounts,
  type OcrBackfillPolicy,
  type OcrBackfillRequest,
  type OcrBackfillRow,
  type OcrBackfillStore,
} from "./ocr-backfill.js";

export const OCR_BACKFILL_TABLE = "sandbox_ingest_v2.ocr_quality_backfill";

interface Row {
  ark: string;
  state: unknown;
  error: string | null;
  permanent: boolean;
  attempts: number;
  requested_at: Date;
  updated_at: Date;
}

function toRow(r: Row): OcrBackfillRow {
  return {
    ark: r.ark,
    state: parseOcrBackfillState(r.state, r.ark),
    error: r.error,
    permanent: r.permanent,
    attempts: Number(r.attempts),
    requestedAt: r.requested_at,
    updatedAt: r.updated_at,
  };
}

export class PgOcrBackfillStore implements OcrBackfillStore {
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  async request(ark: string, policy: OcrBackfillPolicy): Promise<OcrBackfillRequest> {
    validateOcrBackfillPolicy(policy);
    const now = new Date(this.now());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.requestIn(client, ark, policy, now);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  private async requestIn(
    client: PoolClient,
    ark: string,
    policy: OcrBackfillPolicy,
    now: Date,
  ): Promise<OcrBackfillRequest> {
    const inserted = await client.query(
      `INSERT INTO ${OCR_BACKFILL_TABLE} (ark, state, requested_at, updated_at)
       VALUES ($1, $2, $3, $3) ON CONFLICT (ark) DO NOTHING`,
      [ark, OCR_BACKFILL_STATE.QUEUED, now],
    );
    if (inserted.rowCount === 1) return { kind: "enqueue" };

    const { rows } = await client.query<Row>(
      `SELECT * FROM ${OCR_BACKFILL_TABLE} WHERE ark = $1 FOR UPDATE`,
      [ark],
    );
    const existing = rows[0];
    if (!existing) {
      throw new Error(`ocr-backfill: ${ark} neither inserted nor found (concurrent delete?)`);
    }
    const plan = planRequest(toRow(existing), policy, now.getTime());
    switch (plan.action) {
      case "insert":
        throw new Error(`ocr-backfill: planRequest asked to insert an existing row for ${ark}`);
      case "reopen":
        await this.updateOne(
          client,
          `UPDATE ${OCR_BACKFILL_TABLE}
             SET state = $2, error = NULL, permanent = false, attempts = $3,
                 requested_at = $4, updated_at = $4
           WHERE ark = $1`,
          [ark, OCR_BACKFILL_STATE.QUEUED, plan.attempts, now],
        );
        return { kind: "enqueue" };
      case "expire":
        await this.updateOne(
          client,
          `UPDATE ${OCR_BACKFILL_TABLE}
             SET state = $2, error = $3, permanent = true, attempts = $4, updated_at = $5
           WHERE ark = $1`,
          [ark, OCR_BACKFILL_STATE.FAILED, OCR_BACKFILL_EXPIRED, plan.attempts, now],
        );
        return { kind: "failed", reason: OCR_BACKFILL_EXPIRED, permanent: true };
      case "report":
        return plan.result;
    }
  }

  async markDone(ark: string): Promise<void> {
    await this.updateOne(
      this.pool,
      `UPDATE ${OCR_BACKFILL_TABLE}
         SET state = $2, error = NULL, permanent = false, updated_at = $3
       WHERE ark = $1`,
      [ark, OCR_BACKFILL_STATE.DONE, new Date(this.now())],
    );
  }

  async markFailed(ark: string, reason: string, opts: { permanent: boolean }): Promise<void> {
    await this.updateOne(
      this.pool,
      `UPDATE ${OCR_BACKFILL_TABLE}
         SET state = $2, error = $3, permanent = $4, attempts = attempts + 1, updated_at = $5
       WHERE ark = $1`,
      [ark, OCR_BACKFILL_STATE.FAILED, reason, opts.permanent, new Date(this.now())],
    );
  }

  async get(ark: string): Promise<OcrBackfillRow | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM ${OCR_BACKFILL_TABLE} WHERE ark = $1`, [ark]);
    const r = rows[0];
    return r ? toRow(r) : null;
  }

  async counts(): Promise<OcrBackfillCounts> {
    const out: OcrBackfillCounts = { queued: 0, done: 0, failed: 0 };
    const { rows } = await this.pool.query<{ state: unknown; n: string }>(
      `SELECT state, count(*) AS n FROM ${OCR_BACKFILL_TABLE} GROUP BY state`,
    );
    for (const r of rows) out[parseOcrBackfillState(r.state, "(counts)")] += Number(r.n);
    return out;
  }

  /** An UPDATE that must touch exactly one row — a missing row is an error, as in the memory store. */
  private async updateOne(db: Pool | PoolClient, sql: string, params: unknown[]): Promise<void> {
    const { rowCount } = await db.query(sql, params);
    if (rowCount !== 1) {
      throw new Error(`ocr-backfill: no row for ${String(params[0])} (updated ${String(rowCount)})`);
    }
  }
}
