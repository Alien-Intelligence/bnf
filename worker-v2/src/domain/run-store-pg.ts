/**
 * Postgres RunStore — the production ingest_run store (twin of MemoryRunStore).
 * Shares the worker's pg Pool; the schema is applied by PgDocState.migrate()
 * (ingest_run lives in the same schema.sql), so this class does no migration of
 * its own.
 *
 * markTerminalEmitted is a single conditional UPDATE (… WHERE NOT terminal_emitted
 * AND NOT canceled RETURNING) so exactly one concurrent completion check wins the
 * terminal callback — no read-modify-write race.
 */
import type { Pool } from "pg";

import type { IngestRun, IngestRunInput, RunStore } from "./run.js";

const SCHEMA = "sandbox_ingest_v2";
const RUNS = `${SCHEMA}.ingest_run`;

export class PgRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async create(input: IngestRunInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${RUNS}
         (run_id, app_job_id, project_id, callback_url, callback_secret,
          target_version_id, total_docs)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        input.runId,
        input.appJobId,
        input.projectId,
        input.callbackUrl,
        input.callbackSecret,
        input.targetVersionId,
        input.totalDocs,
      ],
    );
  }

  async get(runId: string): Promise<IngestRun | null> {
    const { rows } = await this.pool.query<{
      run_id: string;
      app_job_id: string;
      project_id: string;
      callback_url: string;
      callback_secret: string;
      target_version_id: string;
      total_docs: number;
      terminal_emitted: boolean;
      canceled: boolean;
    }>(`SELECT * FROM ${RUNS} WHERE run_id = $1`, [runId]);
    const r = rows[0];
    if (!r) return null;
    return {
      runId: r.run_id,
      appJobId: r.app_job_id,
      projectId: r.project_id,
      callbackUrl: r.callback_url,
      callbackSecret: r.callback_secret,
      targetVersionId: r.target_version_id,
      totalDocs: r.total_docs,
      terminalEmitted: r.terminal_emitted,
      canceled: r.canceled,
    };
  }

  async markTerminalEmitted(runId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${RUNS}
         SET terminal_emitted = true, updated_at = now()
       WHERE run_id = $1 AND NOT terminal_emitted AND NOT canceled`,
      [runId],
    );
    return (rowCount ?? 0) > 0;
  }

  async resetTerminalEmitted(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${RUNS} SET terminal_emitted = false, updated_at = now() WHERE run_id = $1`,
      [runId],
    );
  }

  async markCanceled(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${RUNS} SET canceled = true, updated_at = now() WHERE run_id = $1`,
      [runId],
    );
  }
}
