/**
 * Worker V2 entrypoint — the production composition. Wires the durable transport
 * (pg-boss), the per-doc state (Postgres), the artifact store (S3), the live BnF
 * client + the four downstream live ports, and the BnF rate gates (mirroring the
 * broker's buckets: global, Presentation, Image, manifest), then starts the
 * pipeline. Long-running: every stage
 * long-polls its bucket forever; the process stays up until SIGINT/SIGTERM.
 *
 * This file does I/O only — all behaviour lives in the stages + buildPipeline,
 * which the fake-mode integration test exercises with the exact same wiring.
 */
import { Pool } from "pg";

import { loadBrokerUrl, loadConfig, loadIiifBases, pgPoolConfig } from "./config.js";
import { configureBrokerUrl } from "./bnf/broker-client.js";
import { buildLivePipeline } from "./live-pipeline.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { S3BlobStore } from "./core/blob.js";
import { createLogger } from "./core/logger.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { OCR_SYNC_BODY_READ_MS, OCR_SYNC_DEADLINE_MS } from "./live/ocr-quality-sync.js";
import { PgRunStore } from "./domain/run-store-pg.js";
import { TerminalEmitter } from "./live/progress-callback.js";
import { CompletionMonitor } from "./live/completion-monitor.js";
import { Reconciler } from "./live/reconciler.js";
import { startServer } from "./server.js";
import { SHUTDOWN_BUDGETS, shutdownWorker } from "./shutdown.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  // The worker runtime — and only it — needs the broker and the IIIF API
  // bases: validated here, once, before anything starts.
  configureBrokerUrl(loadBrokerUrl(process.env));
  const iiif = loadIiifBases(process.env);
  const log = createLogger({ worker: "bnf-ingest-v2" });

  const queue = new PgBossQueue(pgPoolConfig(cfg.databaseUrl));
  await queue.start();

  // Both pg timeouts (pgPoolConfig): a stuck query or an exhausted pool must not
  // park a stage handler until pg-boss expires the job, nor the sweep/endpoint.
  const pool = new Pool(pgPoolConfig(cfg.databaseUrl));
  const docState = new PgDocState(pool);
  await docState.migrate();
  const runStore = new PgRunStore(pool);
  const blob = new S3BlobStore({ ...cfg.s3, prefix: cfg.s3Prefix });

  // The terminal commit callback + the run-completion detector. The detector is
  // wired to the pipeline's onOutcome seam (in buildLivePipeline), so a doc
  // reaching a terminal status triggers a run-completeness check → one
  // HMAC-signed terminal event.
  const emitter = new TerminalEmitter(docState, runStore, log, {
    maxCallbackFailures: cfg.reconcilerMaxCallbackFailures,
  });
  const completion = new CompletionMonitor(docState, runStore, emitter, log);

  const { pipeline, ocrBackfill, limiters, fetchRatePerMin } = buildLivePipeline({
    cfg,
    iiif,
    queue,
    pool,
    docState,
    blob,
    log,
    completion,
  });

  await pipeline.start();

  // The reconciliation sweep — started AFTER the stages, so anything it re-drives
  // has a consumer waiting. Its first sweep runs now: that is what un-wedges a run
  // whose docs were orphaned by the previous pod (see live/reconciler.ts).
  const reconciler = new Reconciler(
    { runStore, docState, queue, blob, completion, log },
    { intervalMs: cfg.reconcilerIntervalMs, maxRequeues: cfg.reconcilerMaxRequeues },
  );
  reconciler.start();

  // The app↔worker HTTP ingress: POST /ingest (open a run + seed) + GET
  // /progress/:runId (the Ingérer poll read-model) + cancel + health.
  const server = await startServer(
    {
      runStore,
      docState,
      queue,
      completion,
      log,
      fetchRatePerMin,
      manifestRatePerMin: cfg.rates.manifestRpm,
      blob,
      ocrBackfill,
      ocrSyncDeadlineMs: OCR_SYNC_DEADLINE_MS,
      ocrSyncBodyReadMs: OCR_SYNC_BODY_READ_MS,
    },
    cfg.httpPort,
  );

  log.info("worker_v2_up", {
    httpPort: cfg.httpPort,
    rates: cfg.rates,
    altoFetchConcurrency: cfg.altoFetchConcurrency,
    imageFetchConcurrency: cfg.imageFetchConcurrency,
    iiif,
    mistralEnabled: cfg.mistralEnabled,
    reconcilerIntervalMs: cfg.reconcilerIntervalMs,
    ocrBackfillEnabled: cfg.ocrBackfill.enabled,
    ocrBackfillConcurrency: cfg.ocrBackfill.concurrency,
    ocrBackfillRetryFailedAfterMs: cfg.ocrBackfill.retryFailedAfterMs,
  });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("worker_v2_shutdown", { sig });
    // The order is shutdownWorker's (src/shutdown.ts): intake, drain with the
    // transport alive, gates (hand-backs through a working send), transport.
    await shutdownWorker(
      {
        log,
        stopIntake: async () => {
          reconciler.stop();
          await new Promise<void>((r) => server.close(() => r()));
        },
        pipeline,
        gates: limiters,
        closePools: () => pool.end(),
      },
      SHUTDOWN_BUDGETS,
    ).catch((err: unknown) =>
      log.error("shutdown_failed", { error: err instanceof Error ? err.message : String(err) }),
    );
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker-v2] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
