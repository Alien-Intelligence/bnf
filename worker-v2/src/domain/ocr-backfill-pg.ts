/**
 * Postgres OcrBackfillStore — the production store (twin of the memory one).
 * Shares the worker's pg Pool (bounded: connectionTimeoutMillis and
 * statement_timeout, main.ts); the table is applied by PgDocState.migrate()
 * (schema.sql), with CHECKs on `state`, `attempts >= 0` and
 * `failed ⇒ error NOT NULL`.
 *
 * `request` runs in ONE transaction: insert-if-absent, otherwise lock the row
 * (SELECT … FOR UPDATE), apply the shared planRequest decision and write it —
 * so concurrent sync calls for the same ARK cannot both win the build. Every
 * mark is one UPDATE guarded on `state = 'queued'`, so a late or stray
 * delivery never flips a terminal row. The clock is the caller's (injectable),
 * as in the memory store, so both apply the backoff and staleness rules
 * against the same time source.
 */
import type { Pool, PoolClient } from "pg";

import {
  OCR_BACKFILL_MARK,
  OCR_BACKFILL_STATE,
  parseOcrBackfillState,
  planRequest,
  validateOcrBackfillPolicy,
  type OcrBackfillClaim,
  type OcrBackfillCounts,
  type OcrBackfillMark,
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
  sent_at: Date | null;
  started_at: Date | null;
  generation: number;
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
    sentAt: r.sent_at,
    startedAt: r.started_at,
    generation: Number(r.generation),
    updatedAt: r.updated_at,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class PgOcrBackfillStore implements OcrBackfillStore {
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  async request(ark: string, policy: OcrBackfillPolicy, signal: AbortSignal): Promise<OcrBackfillRequest> {
    validateOcrBackfillPolicy(policy);
    signal.throwIfAborted();
    const now = new Date(this.now());
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      try {
        signal.throwIfAborted();
        const result = await this.requestIn(client, ark, policy, now);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        // The ORIGINAL error is what the caller must see; a failed ROLLBACK
        // means the connection is unusable — it is logged into the error and
        // the client is destroyed on release instead of returned to the pool.
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          broken = rollbackError instanceof Error ? rollbackError : new Error(errMsg(rollbackError));
          throw new Error(`${errMsg(e)} (and ROLLBACK failed: ${broken.message})`, { cause: e });
        }
        throw e;
      }
    } finally {
      client.release(broken);
    }
  }

  private async requestIn(
    client: PoolClient,
    ark: string,
    policy: OcrBackfillPolicy,
    now: Date,
  ): Promise<OcrBackfillRequest> {
    const inserted = await client.query(
      `INSERT INTO ${OCR_BACKFILL_TABLE} (ark, state, requested_at, updated_at, generation)
       VALUES ($1, $2, $3, $3, 1) ON CONFLICT (ark) DO NOTHING`,
      [ark, OCR_BACKFILL_STATE.QUEUED, now],
    );
    if (inserted.rowCount === 1) return { kind: "enqueue", generation: 1 };

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
      case "reopen": {
        const generation = Number(existing.generation) + 1;
        await this.updateOne(
          client,
          `UPDATE ${OCR_BACKFILL_TABLE}
             SET state = $2, error = NULL, permanent = false, attempts = $3,
                 requested_at = $4, sent_at = NULL, started_at = NULL, updated_at = $4,
                 generation = $5
           WHERE ark = $1`,
          [ark, OCR_BACKFILL_STATE.QUEUED, plan.attempts, now, generation],
        );
        return { kind: "enqueue", generation };
      }
      case "expire":
        await this.updateOne(
          client,
          `UPDATE ${OCR_BACKFILL_TABLE}
             SET state = $2, error = $3, permanent = true, attempts = $4, updated_at = $5
           WHERE ark = $1`,
          [ark, OCR_BACKFILL_STATE.FAILED, plan.reason, plan.attempts, now],
        );
        return { kind: "failed", reason: plan.reason, permanent: true };
      case "report":
        return plan.result;
    }
  }

  async markSent(claim: OcrBackfillClaim): Promise<OcrBackfillMark> {
    return this.markClaim(claim, "sent_at = $3, updated_at = $3", [new Date(this.now())]);
  }

  async markStarted(claim: OcrBackfillClaim): Promise<OcrBackfillMark> {
    return this.markClaim(claim, "started_at = $3, updated_at = $3", [new Date(this.now())]);
  }

  async markDone(claim: OcrBackfillClaim): Promise<OcrBackfillMark> {
    return this.markClaim(claim, "state = $3, error = NULL, permanent = false, updated_at = $4", [
      OCR_BACKFILL_STATE.DONE,
      new Date(this.now()),
    ]);
  }

  async markFailed(
    claim: OcrBackfillClaim,
    reason: string,
    opts: { permanent: boolean },
  ): Promise<OcrBackfillMark> {
    return this.markClaim(
      claim,
      "state = $3, error = $4, permanent = $5, attempts = attempts + 1, updated_at = $6",
      [OCR_BACKFILL_STATE.FAILED, reason, opts.permanent, new Date(this.now())],
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

  /**
   * One UPDATE guarded on the claim — `state = 'queued' AND generation = $2`
   * ($1 the ARK, $2 the generation, `set` numbering from $3): one row updated
   * → applied; none → the row left the claim (not_queued), or there is no row
   * at all (an error, as in the memory store).
   */
  private async markClaim(claim: OcrBackfillClaim, set: string, values: unknown[]): Promise<OcrBackfillMark> {
    const queuedParam = `$${values.length + 3}`;
    const { rowCount } = await this.pool.query(
      `UPDATE ${OCR_BACKFILL_TABLE} SET ${set} WHERE ark = $1 AND generation = $2 AND state = ${queuedParam}`,
      [claim.ark, claim.generation, ...values, OCR_BACKFILL_STATE.QUEUED],
    );
    if (rowCount === 1) return OCR_BACKFILL_MARK.APPLIED;
    if (rowCount !== 0) throw new Error(`ocr-backfill: ${claim.ark} matched ${String(rowCount)} rows`);
    const row = await this.get(claim.ark);
    if (row === null) throw new Error(`ocr-backfill: no row for ${claim.ark}`);
    return OCR_BACKFILL_MARK.NOT_QUEUED;
  }

  /** An UPDATE that must touch exactly one row — a missing row is an error, as in the memory store. */
  private async updateOne(db: PoolClient, sql: string, params: unknown[]): Promise<void> {
    const { rowCount } = await db.query(sql, params);
    if (rowCount !== 1) {
      throw new Error(`ocr-backfill: no row for ${String(params[0])} (updated ${String(rowCount)})`);
    }
  }
}
