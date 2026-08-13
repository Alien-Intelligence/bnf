/**
 * Postgres DocStateStore — the production fan-in/lifecycle store (twin of
 * MemoryDocState, same contract, so stages and tests are impl-agnostic). Reads its
 * connection from a shared pg Pool; `migrate()` applies schema.sql idempotently.
 *
 * Idempotency + concurrency safety, the two properties the Monitor relies on:
 *  - recordFolio is an INSERT … ON CONFLICT DO NOTHING (first write wins) so a
 *    redelivered FolioResult never double-counts; the tally is re-derived each call.
 *  - claimRoute is a single conditional UPDATE (… WHERE status IN pre-routed …
 *    RETURNING) so exactly one caller wins the route even under concurrent
 *    folio-result deliveries — no read-modify-write race.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";

import type { DocMeta } from "./types.js";
import type { Lane } from "./queues.js";
import type {
  DocRow,
  DocScope,
  DocStateStore,
  DocStatus,
  DroppedPagesDoc,
  FailedDoc,
  FolioRecord,
  FolioTally,
} from "./doc-state.js";
import { NON_TERMINAL_STATUSES } from "./doc-state.js";

const SCHEMA = "sandbox_ingest_v2";
const JOBS = `${SCHEMA}.document_ingest_job_v2`;
const FOLIOS = `${SCHEMA}.document_folio_v2`;
const PRE_ROUTED = ["queued", "planned", "fetching"];

/** The columns of a doc row, plus the derived folio tallies (the DocRow shape). */
interface JobRow {
  doc_job_id: string;
  run_id: string | null;
  project_id: string;
  ark: string;
  lane: Lane | null;
  status: DocStatus;
  pages_expected: number | null;
  meta: DocMeta | null;
  error: string | null;
  skip_reason: string | null;
  requeues: number;
  pages_dropped: number;
  drop_reason: string | null;
  pages_done: string;
  pages_failed: string;
}

function toDocRow(r: JobRow): DocRow {
  return {
    docJobId: r.doc_job_id,
    runId: r.run_id,
    projectId: r.project_id,
    ark: r.ark,
    lane: r.lane,
    status: r.status,
    pagesExpected: r.pages_expected,
    pagesDone: Number(r.pages_done),
    pagesFailed: Number(r.pages_failed),
    meta: r.meta,
    error: r.error,
    skipReason: r.skip_reason,
    requeues: Number(r.requeues),
    pagesDropped: Number(r.pages_dropped),
    dropReason: r.drop_reason,
  };
}

export class PgDocState implements DocStateStore {
  constructor(private readonly pool: Pool) {}

  /** Apply schema.sql (idempotent). Call once at startup. */
  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, "schema.sql"), "utf8");
    await this.pool.query(sql);
  }

  async upsertDoc(d: {
    docJobId: string;
    projectId: string;
    ark: string;
    runId?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${JOBS} (doc_job_id, run_id, project_id, ark, status)
       VALUES ($1, $2, $3, $4, 'queued')
       ON CONFLICT (doc_job_id) DO NOTHING`,
      [d.docJobId, d.runId ?? null, d.projectId, d.ark],
    );
  }

  /**
   * Batch-seed doc rows in chunks of 1000 — one multi-row INSERT per chunk
   * instead of N sequential awaits (F19: seeding hundreds of docs one at a
   * time can straddle the app's client timeout on `POST /ingest`). Same
   * ON CONFLICT DO NOTHING idempotency as upsertDoc.
   */
  async upsertDocs(
    refs: { docJobId: string; projectId: string; ark: string; runId?: string | null }[],
  ): Promise<void> {
    const CHUNK = 1000;
    for (let i = 0; i < refs.length; i += CHUNK) {
      const batch = refs.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      batch.forEach((ref, idx) => {
        const base = idx * 4;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'queued')`);
        params.push(ref.docJobId, ref.runId ?? null, ref.projectId, ref.ark);
      });
      await this.pool.query(
        `INSERT INTO ${JOBS} (doc_job_id, run_id, project_id, ark, status)
         VALUES ${values.join(", ")}
         ON CONFLICT (doc_job_id) DO NOTHING`,
        params,
      );
    }
  }

  async recordPlan(
    docJobId: string,
    plan: { lane: Lane; pagesExpected: number; meta: DocMeta },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${JOBS}
         SET lane = $2, pages_expected = $3, meta = $4, status = 'planned', updated_at = now()
       WHERE doc_job_id = $1`,
      [docJobId, plan.lane, plan.pagesExpected, JSON.stringify(plan.meta)],
    );
  }

  async recordFolio(docJobId: string, ordre: number, ok: boolean): Promise<FolioTally> {
    await this.pool.query(
      `INSERT INTO ${FOLIOS} (doc_job_id, ordre, ok)
       VALUES ($1, $2, $3)
       ON CONFLICT (doc_job_id, ordre) DO NOTHING`,
      [docJobId, ordre, ok],
    );
    const { rows } = await this.pool.query<{
      done: string;
      failed: string;
      expected: number | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE f.ok)       AS done,
         count(*) FILTER (WHERE NOT f.ok)   AS failed,
         j.pages_expected                    AS expected
       FROM ${JOBS} j
       LEFT JOIN ${FOLIOS} f ON f.doc_job_id = j.doc_job_id
       WHERE j.doc_job_id = $1
       GROUP BY j.pages_expected`,
      [docJobId],
    );
    const r = rows[0];
    const done = r ? Number(r.done) : 0;
    const failed = r ? Number(r.failed) : 0;
    const expected = r?.expected ?? 0;
    return { expected, done, failed, complete: expected > 0 && done + failed >= expected };
  }

  async setStatus(
    docJobId: string,
    status: DocStatus,
    extra?: { error?: string; skipReason?: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${JOBS}
         SET status = $2,
             error = COALESCE($3, error),
             skip_reason = COALESCE($4, skip_reason),
             updated_at = now()
       WHERE doc_job_id = $1`,
      [docJobId, status, extra?.error ?? null, extra?.skipReason ?? null],
    );
  }

  async claimRoute(
    docJobId: string,
    status: "ready" | "failed",
    extra?: { error?: string; skipReason?: string },
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${JOBS}
         SET status = $2,
             error = COALESCE($3, error),
             skip_reason = COALESCE($4, skip_reason),
             updated_at = now()
       WHERE doc_job_id = $1 AND status = ANY($5)`,
      [docJobId, status, extra?.error ?? null, extra?.skipReason ?? null, PRE_ROUTED],
    );
    return (rowCount ?? 0) > 0;
  }

  async get(docJobId: string): Promise<DocRow | null> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT j.*,
              count(f.*) FILTER (WHERE f.ok)     AS pages_done,
              count(f.*) FILTER (WHERE NOT f.ok) AS pages_failed
       FROM ${JOBS} j
       LEFT JOIN ${FOLIOS} f ON f.doc_job_id = j.doc_job_id
       WHERE j.doc_job_id = $1
       GROUP BY j.doc_job_id`,
      [docJobId],
    );
    const r = rows[0];
    return r ? toDocRow(r) : null;
  }

  async listNonTerminalDocs(runId: string): Promise<DocRow[]> {
    // (run_id, status) is indexed (document_ingest_job_v2_run_status_idx), so this
    // stays cheap even when the run's terminal docs vastly outnumber the live ones.
    const { rows } = await this.pool.query<JobRow>(
      `SELECT j.*,
              count(f.*) FILTER (WHERE f.ok)     AS pages_done,
              count(f.*) FILTER (WHERE NOT f.ok) AS pages_failed
       FROM ${JOBS} j
       LEFT JOIN ${FOLIOS} f ON f.doc_job_id = j.doc_job_id
       WHERE j.run_id = $1 AND j.status = ANY($2)
       GROUP BY j.doc_job_id
       ORDER BY j.ark ASC`,
      [runId, NON_TERMINAL_STATUSES as DocStatus[]],
    );
    return rows.map(toDocRow);
  }

  async incrementRequeues(docJobId: string): Promise<number> {
    const { rows } = await this.pool.query<{ requeues: number }>(
      `UPDATE ${JOBS}
         SET requeues = requeues + 1, updated_at = now()
       WHERE doc_job_id = $1
       RETURNING requeues`,
      [docJobId],
    );
    const r = rows[0];
    if (!r) throw new Error(`doc-state: unknown docJobId ${docJobId}`);
    return Number(r.requeues);
  }

  async listOkFolios(docJobId: string): Promise<number[]> {
    const { rows } = await this.pool.query<{ ordre: number }>(
      `SELECT ordre FROM ${FOLIOS} WHERE doc_job_id = $1 AND ok ORDER BY ordre ASC`,
      [docJobId],
    );
    return rows.map((r) => r.ordre);
  }

  async listFolios(docJobId: string): Promise<FolioRecord[]> {
    const { rows } = await this.pool.query<{ ordre: number; ok: boolean }>(
      `SELECT ordre, ok FROM ${FOLIOS} WHERE doc_job_id = $1 ORDER BY ordre ASC`,
      [docJobId],
    );
    return rows.map((r) => ({ ordre: r.ordre, ok: r.ok }));
  }

  async statusCounts(scope?: DocScope): Promise<Record<DocStatus, number>> {
    const out: Record<DocStatus, number> = {
      queued: 0,
      planned: 0,
      fetching: 0,
      ready: 0,
      processing: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      excluded: 0,
    };
    // At most one scope dimension applies (run is the narrower; the ingress sets it).
    let where = "";
    const params: string[] = [];
    if (scope?.runId !== undefined) {
      params.push(scope.runId);
      where = `WHERE run_id = $1`;
    } else if (scope?.projectId !== undefined) {
      params.push(scope.projectId);
      where = `WHERE project_id = $1`;
    }
    const { rows } = await this.pool.query<{ status: DocStatus; n: string }>(
      `SELECT status, count(*) AS n FROM ${JOBS} ${where} GROUP BY status`,
      params,
    );
    for (const r of rows) {
      if (r.status in out) out[r.status] = Number(r.n);
    }
    return out;
  }

  async listFailedDocs(runId: string): Promise<FailedDoc[]> {
    const { rows } = await this.pool.query<{
      ark: string;
      lane: Lane | null;
      error: string | null;
    }>(
      `SELECT ark, lane, error FROM ${JOBS}
       WHERE run_id = $1 AND status = 'failed'
       ORDER BY ark ASC`,
      [runId],
    );
    return rows.map((r) => ({ ark: r.ark, lane: r.lane, error: r.error }));
  }

  async recordPageDrops(
    docJobId: string,
    drop: { dropped: number; expected: number; reason: string },
  ): Promise<void> {
    const dropped = Math.min(drop.dropped, drop.expected);
    await this.pool.query(
      `UPDATE ${JOBS}
         SET pages_dropped = $2, drop_reason = $3, updated_at = now()
       WHERE doc_job_id = $1`,
      [docJobId, dropped, drop.reason],
    );
  }

  async listDoneWithDrops(runId: string): Promise<DroppedPagesDoc[]> {
    const { rows } = await this.pool.query<{
      ark: string;
      lane: Lane | null;
      pages_dropped: number;
      pages_expected: number | null;
      drop_reason: string | null;
    }>(
      `SELECT ark, lane, pages_dropped, pages_expected, drop_reason FROM ${JOBS}
       WHERE run_id = $1 AND status = 'done' AND pages_dropped > 0
       ORDER BY ark ASC`,
      [runId],
    );
    return rows.map((r) => ({
      ark: r.ark,
      lane: r.lane,
      pagesDropped: Number(r.pages_dropped),
      pagesExpected: r.pages_expected,
      dropReason: r.drop_reason,
    }));
  }

  async donePageCount(runId: string): Promise<number> {
    const { rows } = await this.pool.query<{ pages: string | null }>(
      `SELECT count(f.*) FILTER (WHERE f.ok) AS pages
       FROM ${JOBS} j
       LEFT JOIN ${FOLIOS} f ON f.doc_job_id = j.doc_job_id
       WHERE j.run_id = $1 AND j.status = 'done'`,
      [runId],
    );
    return rows[0]?.pages ? Number(rows[0].pages) : 0;
  }

  async folioCounts(
    runId: string,
  ): Promise<{ expected: number; done: number; failed: number }> {
    const expectedRes = await this.pool.query<{ expected: string | null }>(
      `SELECT COALESCE(sum(pages_expected), 0) AS expected
       FROM ${JOBS} WHERE run_id = $1`,
      [runId],
    );
    const landedRes = await this.pool.query<{ done: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE f.ok)     AS done,
              count(*) FILTER (WHERE NOT f.ok) AS failed
       FROM ${FOLIOS} f
       JOIN ${JOBS} j ON j.doc_job_id = f.doc_job_id
       WHERE j.run_id = $1`,
      [runId],
    );
    return {
      expected: Number(expectedRes.rows[0]?.expected ?? 0),
      done: Number(landedRes.rows[0]?.done ?? 0),
      failed: Number(landedRes.rows[0]?.failed ?? 0),
    };
  }

  async docJobIdsForRun(runId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ doc_job_id: string }>(
      `SELECT doc_job_id FROM ${JOBS} WHERE run_id = $1`,
      [runId],
    );
    return rows.map((r) => r.doc_job_id);
  }
}
