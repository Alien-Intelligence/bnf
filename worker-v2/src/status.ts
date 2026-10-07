/**
 * Status CLI — print the progress read-model once (the same payload the Ingérer
 * UI would poll) plus the OCR-quality backfill counts (queued / done / failed —
 * the backfill's progress output). Used during the integration gates to confirm
 * the counters reconcile and the ETA tracks the fetch backlog.
 *
 *   npx tsx src/status.ts [projectId]
 */
import { Pool } from "pg";

import { etaFetchRatePerMin, loadConfig, pgPoolConfig } from "./config.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { PgOcrBackfillStore } from "./domain/ocr-backfill-pg.js";
import { buildProgress } from "./observability.js";

async function main(): Promise<void> {
  const projectId = process.argv[2];
  const cfg = loadConfig();
  const queue = new PgBossQueue(pgPoolConfig(cfg.databaseUrl));
  await queue.start();
  const pool = new Pool(pgPoolConfig(cfg.databaseUrl));
  // Both are closed whatever happens: a failed read (a statement_timeout)
  // must not leave pg-boss started and the pool open (CLAUDE_ERROR_PATTERNS §12).
  try {
    const docState = new PgDocState(pool);
    const report = await buildProgress(docState, queue, {
      ...(projectId ? { projectId } : {}),
      // The same rates the worker's /progress reports (main.ts).
      fetchRatePerMin: etaFetchRatePerMin(cfg.rates),
      manifestRatePerMin: cfg.rates.workerManifestRpm,
    });
    const ocrBackfill = await new PgOcrBackfillStore(pool).counts();
    console.log(JSON.stringify({ ...report, ocrBackfill }, null, 2));
    if (!report.reconciles) {
      console.error("WARNING: doc totals do not reconcile");
      process.exitCode = 1;
    }
  } finally {
    // Both close whatever happens, and a close failure never hides the error
    // that got us here: allSettled runs both; a failed close is logged and
    // fails the run (exit code 1) without replacing an earlier error.
    const closed = await Promise.allSettled([queue.stop(), pool.end()]);
    for (const c of closed) {
      if (c.status === "rejected") {
        console.error("[status] close failed:", c.reason);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error("[status] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
