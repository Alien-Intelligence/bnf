/**
 * Recovery CLI — force a reconciliation sweep of ONE run, right now.
 *
 *   node --import tsx src/requeue-stranded.ts <runId>
 *
 * The worker sweeps every run on a timer (live/reconciler.ts), so this is no
 * longer the only line of defence it used to be — it is the "don't wait 60s"
 * button for an operator looking at a specific stuck run. It runs the SAME code
 * path as the in-worker sweep, so there is exactly one definition of "how a
 * stranded doc gets re-driven":
 *
 *   queued          → re-seed the metadata bucket
 *   planned/fetching→ re-enqueue the folios that never landed
 *   ready/processing→ re-send the lane message (what this CLI used to do, and
 *                     only that — the prod wedge was a `queued` doc, F9)
 *
 * A doc past its requeue budget is failed terminally rather than re-driven, so
 * running this repeatedly cannot loop forever.
 *
 * Note it does NOT need the worker to be down; every re-drive is idempotent and
 * the running worker is the consumer of whatever this enqueues.
 */
import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { S3BlobStore } from "./core/blob.js";
import { createLogger } from "./core/logger.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { PgRunStore } from "./domain/run-store-pg.js";
import { TerminalEmitter } from "./live/progress-callback.js";
import { CompletionMonitor } from "./live/completion-monitor.js";
import { Reconciler } from "./live/reconciler.js";

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: node --import tsx src/requeue-stranded.ts <runId>");
    process.exit(2);
  }

  const cfg = loadConfig();
  const log = createLogger({ worker: "requeue-stranded" });
  const queue = new PgBossQueue(cfg.databaseUrl);
  await queue.start();
  const pool = new Pool({ connectionString: cfg.databaseUrl, statement_timeout: 30_000 });
  const docState = new PgDocState(pool);
  const runStore = new PgRunStore(pool);
  const blob = new S3BlobStore({ ...cfg.s3, prefix: cfg.s3Prefix });
  const completion = new CompletionMonitor(
    docState,
    runStore,
    new TerminalEmitter(docState, runStore, log),
    log,
  );

  const run = await runStore.get(runId);
  if (!run) {
    console.error(`[requeue] no such run: ${runId}`);
    process.exit(1);
  }
  if (run.terminalEmitted || run.canceled) {
    console.log(
      `[requeue] run ${runId} is already finished ` +
        `(terminalEmitted=${run.terminalEmitted}, canceled=${run.canceled}) — nothing to do`,
    );
  } else {
    const reconciler = new Reconciler(
      { runStore, docState, queue, blob, completion, log },
      { maxRequeues: cfg.reconcilerMaxRequeues },
    );
    // sweepRun, not the full sweep: an operator asked about THIS run.
    const summary = await reconciler.sweepRun(run);
    console.log(`[requeue] run ${runId}: ${JSON.stringify(summary)}`);
  }

  await queue.stop();
  await pool.end();
}

main().catch((err) => {
  console.error("[requeue] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
