/**
 * Status CLI — print the progress read-model once (the same payload the Ingérer
 * UI would poll). Used during the integration gates to confirm the counters
 * reconcile and the ETA tracks the fetch backlog.
 *
 *   npx tsx src/status.ts [projectId]
 */
import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { buildProgress } from "./observability.js";

async function main(): Promise<void> {
  const projectId = process.argv[2];
  const cfg = loadConfig();
  const queue = new PgBossQueue(cfg.databaseUrl);
  await queue.start();
  const pool = new Pool({ connectionString: cfg.databaseUrl });
  const docState = new PgDocState(pool);

  const report = await buildProgress(docState, queue, {
    ...(projectId ? { projectId } : {}),
    fetchRatePerMin: cfg.fetchRatePerMin,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.reconciles) {
    console.error("WARNING: doc totals do not reconcile");
    process.exitCode = 1;
  }

  await queue.stop();
  await pool.end();
}

main().catch((err) => {
  console.error("[status] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
