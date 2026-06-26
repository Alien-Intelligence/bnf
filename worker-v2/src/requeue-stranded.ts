/**
 * Recovery CLI — requeue stranded docs back into their lane.
 *
 * A "stranded" doc is one the Monitor already routed (status `ready`) but whose
 * lane message died in the queue (e.g. exhausted retries during a provider
 * outage, or a worker restart mid-call) and will never redeliver. Such a doc sits
 * non-terminal forever, so the run can never complete. This re-sends a fresh
 * DocReady (rebuilt from the persisted plan + landed folios) to the doc's lane
 * queue; the running worker picks it up and drives it to done/failed.
 *
 *   node --import tsx src/requeue-stranded.ts <runId>
 *
 * Idempotent-ish: re-sending a DocReady for a doc that later succeeds is harmless
 * (register dedups on its S3 receipt). Only `ready` docs are requeued — pre-route
 * stranding (queued/planned) would need a metadata re-seed instead.
 */
import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { Q, type Lane } from "./domain/queues.js";
import type { DocReady } from "./domain/types.js";

const LANE_QUEUE: Record<Lane, string> = {
  text: Q.assemble,
  vision: Q.describe,
  mistral: Q.ocrSubmit,
};

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: node --import tsx src/requeue-stranded.ts <runId>");
    process.exit(2);
  }

  const cfg = loadConfig();
  const queue = new PgBossQueue(cfg.databaseUrl);
  await queue.start();
  const pool = new Pool({ connectionString: cfg.databaseUrl });
  const docState = new PgDocState(pool);

  const { rows } = await pool.query<{ doc_job_id: string }>(
    `SELECT doc_job_id FROM sandbox_ingest_v2.document_ingest_job_v2
     WHERE run_id = $1 AND status = 'ready'`,
    [runId],
  );
  console.log(`[requeue] ${rows.length} routed-but-stranded (status=ready) docs in run ${runId}`);

  let requeued = 0;
  for (const { doc_job_id } of rows) {
    const row = await docState.get(doc_job_id);
    if (!row || !row.lane || !row.meta || row.pagesExpected == null) {
      console.warn(`[requeue] skip ${doc_job_id}: incomplete plan (lane/meta/pagesExpected)`);
      continue;
    }
    const folios = await docState.listOkFolios(doc_job_id);
    const ready: DocReady = {
      projectId: row.projectId,
      docJobId: row.docJobId,
      ark: row.ark,
      runId: row.runId,
      lane: row.lane,
      pagesExpected: row.pagesExpected,
      meta: row.meta,
      folios,
    };
    await queue.send(LANE_QUEUE[row.lane], ready);
    requeued++;
    console.log(`[requeue] ${row.ark} (${row.lane}, ${folios.length} folios) → ${LANE_QUEUE[row.lane]}`);
  }
  console.log(`[requeue] done — requeued ${requeued} docs`);

  await queue.stop();
  await pool.end();
}

main().catch((err) => {
  console.error("[requeue] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
