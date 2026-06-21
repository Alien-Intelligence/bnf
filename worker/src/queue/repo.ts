/**
 * Thin, typed DB helpers over the three Track-2 tables.
 *
 * No ORM (sandbox). Every method takes a Pool or a PoolClient so transactional
 * call sites can pass a client; non-transactional ones get the pool.
 */

import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  DocumentIngestJobRow,
  DocumentIngestJobStatus,
  DocumentIngestStateRow,
  DocumentIngestStateStatus,
  IngestJobRow,
  IngestJobStatus,
} from "./types.js";

type Queryer = Pool | PoolClient;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface IngestJobDbRow extends QueryResultRow {
  id: string;
  project_id: string;
  status: string;
  total_docs: number;
  added_count: number;
  removed_count: number;
  done_count: number;
  failed_count: number;
  skipped_count: number;
  chunks_written: number;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function mapIngestJob(r: IngestJobDbRow): IngestJobRow {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status as IngestJobStatus,
    totalDocs: r.total_docs,
    addedCount: r.added_count,
    removedCount: r.removed_count,
    doneCount: r.done_count,
    failedCount: r.failed_count,
    skippedCount: r.skipped_count,
    chunksWritten: r.chunks_written,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

interface DocJobDbRow extends QueryResultRow {
  id: string;
  ingest_job_id: string;
  project_id: string;
  ark: string;
  pipeline: string | null;
  status: string;
  skip_reason: string | null;
  content_hash: string | null;
  entry_id: number | null;
  chunks_written: number;
  attempts: number;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

function mapDocJob(r: DocJobDbRow): DocumentIngestJobRow {
  return {
    id: r.id,
    ingestJobId: r.ingest_job_id,
    projectId: r.project_id,
    ark: r.ark,
    pipeline: r.pipeline,
    status: r.status as DocumentIngestJobStatus,
    skipReason: r.skip_reason,
    contentHash: r.content_hash,
    entryId: r.entry_id,
    chunksWritten: r.chunks_written,
    attempts: r.attempts,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

interface DocStateDbRow extends QueryResultRow {
  project_id: string;
  ark: string;
  status: string;
  pipeline: string | null;
  content_hash: string | null;
  last_job_id: string | null;
  entry_id: number | null;
  chunks_written: number;
  last_error: string | null;
  updated_at: Date;
}

function mapDocState(r: DocStateDbRow): DocumentIngestStateRow {
  return {
    projectId: r.project_id,
    ark: r.ark,
    status: r.status as DocumentIngestStateStatus,
    pipeline: r.pipeline,
    contentHash: r.content_hash,
    lastJobId: r.last_job_id,
    entryId: r.entry_id,
    chunksWritten: r.chunks_written,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export class Repo {
  constructor(private readonly pool: Pool) {}

  /** Run a callback inside a single transaction. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ----- ingest_job -----

  async createIngestJob(
    input: { projectId: string; totalDocs: number },
    q: Queryer = this.pool,
  ): Promise<IngestJobRow> {
    const { rows } = await q.query<IngestJobDbRow>(
      `INSERT INTO ingest_job (project_id, status, total_docs)
       VALUES ($1, 'queued', $2)
       RETURNING *`,
      [input.projectId, input.totalDocs],
    );
    return mapIngestJob(rows[0]!);
  }

  async getIngestJob(
    id: string,
    q: Queryer = this.pool,
  ): Promise<IngestJobRow | null> {
    const { rows } = await q.query<IngestJobDbRow>(
      `SELECT * FROM ingest_job WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapIngestJob(rows[0]) : null;
  }

  async markIngestJobRunning(id: string, q: Queryer = this.pool): Promise<void> {
    await q.query(
      `UPDATE ingest_job
         SET status = 'running',
             started_at = COALESCE(started_at, now())
       WHERE id = $1 AND status = 'queued'`,
      [id],
    );
  }

  /**
   * Apply an atomic delta to the parent job's counters.
   * `field` is constrained to the columns we increment.
   */
  async bumpIngestJobCounters(
    id: string,
    delta: Partial<{
      done: number;
      failed: number;
      skipped: number;
      chunks: number;
    }>,
    q: Queryer = this.pool,
  ): Promise<void> {
    const sets: string[] = [];
    const values: number[] = [];
    if (delta.done) {
      values.push(delta.done);
      sets.push(`done_count = done_count + $${values.length}`);
    }
    if (delta.failed) {
      values.push(delta.failed);
      sets.push(`failed_count = failed_count + $${values.length}`);
    }
    if (delta.skipped) {
      values.push(delta.skipped);
      sets.push(`skipped_count = skipped_count + $${values.length}`);
    }
    if (delta.chunks) {
      values.push(delta.chunks);
      sets.push(`chunks_written = chunks_written + $${values.length}`);
    }
    if (!sets.length) return;
    const params: (number | string)[] = [...values, id];
    await q.query(
      `UPDATE ingest_job SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
  }

  /**
   * Move parent job to a terminal state if every child doc-job is terminal.
   * Returns the new status if it transitioned, or null otherwise.
   */
  async finalizeIngestJobIfAllTerminal(
    id: string,
    q: Queryer = this.pool,
  ): Promise<IngestJobStatus | null> {
    const { rows } = await q.query<{ open: string }>(
      `SELECT COUNT(*)::text AS open
         FROM document_ingest_job
        WHERE ingest_job_id = $1
          AND status NOT IN ('done', 'failed', 'skipped')`,
      [id],
    );
    const open = parseInt(rows[0]?.open ?? "0", 10);
    if (open > 0) return null;
    const { rows: updated } = await q.query<IngestJobDbRow>(
      `UPDATE ingest_job
          SET status = 'done',
              finished_at = COALESCE(finished_at, now())
        WHERE id = $1 AND status IN ('queued', 'running')
        RETURNING *`,
      [id],
    );
    return updated[0] ? (updated[0].status as IngestJobStatus) : null;
  }

  // ----- document_ingest_job -----

  async createDocJobs(
    input: { ingestJobId: string; projectId: string; arks: string[] },
    q: Queryer = this.pool,
  ): Promise<DocumentIngestJobRow[]> {
    if (input.arks.length === 0) return [];
    const placeholders = input.arks
      .map((_, i) => `($1, $2, $${i + 3}, 'pending')`)
      .join(", ");
    const values: (string | string[])[] = [
      input.ingestJobId,
      input.projectId,
      ...input.arks,
    ];
    const { rows } = await q.query<DocJobDbRow>(
      `INSERT INTO document_ingest_job (ingest_job_id, project_id, ark, status)
       VALUES ${placeholders}
       RETURNING *`,
      values,
    );
    return rows.map(mapDocJob);
  }

  async getDocJob(
    id: string,
    q: Queryer = this.pool,
  ): Promise<DocumentIngestJobRow | null> {
    const { rows } = await q.query<DocJobDbRow>(
      `SELECT * FROM document_ingest_job WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapDocJob(rows[0]) : null;
  }

  async setDocJobStatus(
    id: string,
    status: DocumentIngestJobStatus,
    extras: Partial<{
      pipeline: string;
      skipReason: string;
      contentHash: string;
      entryId: number;
      chunksWritten: number;
      error: string;
      bumpAttempts: boolean;
      markStarted: boolean;
      markFinished: boolean;
    }> = {},
    q: Queryer = this.pool,
  ): Promise<void> {
    const sets: string[] = [`status = $1`];
    const values: (string | number)[] = [status];
    const push = (col: string, val: string | number) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };
    if (extras.pipeline !== undefined) push("pipeline", extras.pipeline);
    if (extras.skipReason !== undefined) push("skip_reason", extras.skipReason);
    if (extras.contentHash !== undefined) push("content_hash", extras.contentHash);
    if (extras.entryId !== undefined) push("entry_id", extras.entryId);
    if (extras.chunksWritten !== undefined)
      push("chunks_written", extras.chunksWritten);
    if (extras.error !== undefined) push("error", extras.error);
    if (extras.bumpAttempts) sets.push(`attempts = attempts + 1`);
    if (extras.markStarted) sets.push(`started_at = COALESCE(started_at, now())`);
    if (extras.markFinished) sets.push(`finished_at = now()`);
    values.push(id);
    await q.query(
      `UPDATE document_ingest_job SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values,
    );
  }

  // ----- document_ingest_state -----

  async getDocState(
    projectId: string,
    ark: string,
    q: Queryer = this.pool,
  ): Promise<DocumentIngestStateRow | null> {
    const { rows } = await q.query<DocStateDbRow>(
      `SELECT * FROM document_ingest_state WHERE project_id = $1 AND ark = $2`,
      [projectId, ark],
    );
    return rows[0] ? mapDocState(rows[0]) : null;
  }

  async upsertDocState(
    input: {
      projectId: string;
      ark: string;
      status: DocumentIngestStateStatus;
      pipeline?: string | null;
      contentHash?: string | null;
      lastJobId?: string | null;
      entryId?: number | null;
      chunksWritten?: number;
      lastError?: string | null;
    },
    q: Queryer = this.pool,
  ): Promise<void> {
    await q.query(
      `INSERT INTO document_ingest_state
         (project_id, ark, status, pipeline, content_hash,
          last_job_id, entry_id, chunks_written, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), $9, now())
       ON CONFLICT (project_id, ark) DO UPDATE SET
         status = EXCLUDED.status,
         pipeline = COALESCE(EXCLUDED.pipeline, document_ingest_state.pipeline),
         content_hash = COALESCE(EXCLUDED.content_hash, document_ingest_state.content_hash),
         last_job_id = COALESCE(EXCLUDED.last_job_id, document_ingest_state.last_job_id),
         entry_id = COALESCE(EXCLUDED.entry_id, document_ingest_state.entry_id),
         chunks_written = COALESCE(EXCLUDED.chunks_written, document_ingest_state.chunks_written),
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        input.projectId,
        input.ark,
        input.status,
        input.pipeline ?? null,
        input.contentHash ?? null,
        input.lastJobId ?? null,
        input.entryId ?? null,
        input.chunksWritten ?? null,
        input.lastError ?? null,
      ],
    );
  }
}
