/**
 * Worker V2 entrypoint — the production composition. Wires the durable transport
 * (pg-boss), the per-doc state (Postgres), the artifact store (S3), the live BnF
 * client + the four downstream live ports, and the two binding rate gates (BnF
 * fetch + IIIF manifest), then starts the pipeline. Long-running: every stage
 * long-polls its bucket forever; the process stays up until SIGINT/SIGTERM.
 *
 * This file does I/O only — all behaviour lives in the stages + buildPipeline,
 * which the fake-mode integration test exercises with the exact same wiring.
 */
import { Pool } from "pg";

import { loadBrokerUrl, loadConfig, loadIiifBases, pgPoolConfig } from "./config.js";
import { configureBrokerUrl } from "./bnf/broker-client.js";
import { buildPipeline } from "./build.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { S3BlobStore } from "./core/blob.js";
import { RateLimiter } from "./core/rate.js";
import { createLogger } from "./core/logger.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import {
  OCR_BACKFILL_MAX_ATTEMPTS,
  OCR_BACKFILL_STARTED_STALE_MS,
  OCR_BACKFILL_UNSENT_STALE_MS,
  OCR_BACKFILL_UNSTARTED_STALE_MS,
  validateOcrBackfillPolicy,
  type OcrBackfillWiring,
} from "./domain/ocr-backfill.js";
import { PgOcrBackfillStore } from "./domain/ocr-backfill-pg.js";
import { OCR_SYNC_BODY_READ_MS, OCR_SYNC_DEADLINE_MS } from "./live/ocr-quality-sync.js";
import { PgRunStore } from "./domain/run-store-pg.js";
import { LiveBnfClient } from "./bnf/client.js";
import { LiveDescriber } from "./live/describer.js";
import { LiveOcrEngine } from "./live/ocr.js";
import { LiveEmbedder } from "./live/embedder.js";
import { LiveClusterSink } from "./live/cluster.js";
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
  // ONE wiring object for the backfill, handed to both the pipeline (stage) and
  // the server (endpoint) so their enable decision cannot diverge.
  const ocrBackfill: OcrBackfillWiring = {
    store: new PgOcrBackfillStore(pool),
    enabled: cfg.ocrBackfill.enabled,
    concurrency: cfg.ocrBackfill.concurrency,
    policy: validateOcrBackfillPolicy({
      retryFailedAfterMs: cfg.ocrBackfill.retryFailedAfterMs,
      maxAttempts: OCR_BACKFILL_MAX_ATTEMPTS,
      startedStaleAfterMs: OCR_BACKFILL_STARTED_STALE_MS,
      unstartedStaleAfterMs: OCR_BACKFILL_UNSTARTED_STALE_MS,
      unsentStaleAfterMs: OCR_BACKFILL_UNSENT_STALE_MS,
    }),
  };

  const blob = new S3BlobStore({ ...cfg.s3, prefix: cfg.s3Prefix });

  const fetchRate = new RateLimiter({ ratePerMin: cfg.fetchRatePerMin });
  const manifestRate = new RateLimiter({ ratePerMin: cfg.manifestRatePerMin });

  // The terminal commit callback + the run-completion detector. The detector is
  // wired to the pipeline's onOutcome seam (below), so a doc reaching a terminal
  // status triggers a run-completeness check → one HMAC-signed terminal event.
  const emitter = new TerminalEmitter(docState, runStore, log, {
    maxCallbackFailures: cfg.reconcilerMaxCallbackFailures,
  });
  const completion = new CompletionMonitor(docState, runStore, emitter, log);

  const pipeline = buildPipeline({
    queue,
    blob,
    log,
    bnf: new LiveBnfClient(iiif),
    docState,
    describer: new LiveDescriber(),
    ocr: new LiveOcrEngine(),
    embedder: new LiveEmbedder(),
    cluster: new LiveClusterSink(),
    ocrBackfill,
    onOutcome: (e) => completion.noteOutcome({ kind: e.kind, payload: e.payload }),
    rates: { fetch: fetchRate, manifest: manifestRate },
    config: {
      mistralEnabled: cfg.mistralEnabled,
      maxPages: cfg.maxPages,
      maxCanvases: cfg.maxCanvases,
      // FetchStage's `imageSize` opt is the mistral/text-lane size (fetch.ts
      // defaults it to "max" itself); `visionImageSize` is the separate,
      // already-downscaled vision-lane size. See config.ts's mistralImageSize doc.
      imageSize: cfg.mistralImageSize,
      visionImageSize: cfg.visionImageSize,
      fetchConcurrency: cfg.fetchConcurrency,
      metadataConcurrency: cfg.metadataConcurrency,
      registerConcurrency: cfg.registerConcurrency,
      describeConcurrency: cfg.describeConcurrency,
      describeCallConcurrency: cfg.describeCallConcurrency,
      embedConcurrency: cfg.embedConcurrency,
      ocrSubmitConcurrency: cfg.ocrSubmitConcurrency,
      ocrPollConcurrency: cfg.ocrPollConcurrency,
      failRatio: cfg.failRatio,
    },
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
      fetchRatePerMin: cfg.fetchRatePerMin,
      manifestRatePerMin: cfg.manifestRatePerMin,
      blob,
      ocrBackfill,
      ocrSyncDeadlineMs: OCR_SYNC_DEADLINE_MS,
      ocrSyncBodyReadMs: OCR_SYNC_BODY_READ_MS,
    },
    cfg.httpPort,
  );

  log.info("worker_v2_up", {
    httpPort: cfg.httpPort,
    fetchRatePerMin: cfg.fetchRatePerMin,
    manifestRatePerMin: cfg.manifestRatePerMin,
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
        gates: [fetchRate, manifestRate],
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
