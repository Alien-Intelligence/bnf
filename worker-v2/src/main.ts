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

import { loadConfig } from "./config.js";
import { buildPipeline } from "./build.js";
import { PgBossQueue } from "./core/queue-pgboss.js";
import { S3BlobStore } from "./core/blob.js";
import { RateLimiter } from "./core/rate.js";
import { createLogger } from "./core/logger.js";
import { PgDocState } from "./domain/doc-state-pg.js";
import { PgRunStore } from "./domain/run-store-pg.js";
import { LiveBnfClient } from "./bnf/client.js";
import { LiveDescriber } from "./live/describer.js";
import { LiveOcrEngine } from "./live/ocr.js";
import { LiveEmbedder } from "./live/embedder.js";
import { LiveClusterSink } from "./live/cluster.js";
import { TerminalEmitter } from "./live/progress-callback.js";
import { CompletionMonitor } from "./live/completion-monitor.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ worker: "bnf-ingest-v2" });

  const queue = new PgBossQueue(cfg.databaseUrl);
  await queue.start();

  const pool = new Pool({ connectionString: cfg.databaseUrl });
  const docState = new PgDocState(pool);
  await docState.migrate();
  const runStore = new PgRunStore(pool);

  const blob = new S3BlobStore({ ...cfg.s3, prefix: cfg.s3Prefix });

  const fetchRate = new RateLimiter({ ratePerMin: cfg.fetchRatePerMin });
  const manifestRate = new RateLimiter({ ratePerMin: cfg.manifestRatePerMin });

  // The terminal commit callback + the run-completion detector. The detector is
  // wired to the pipeline's onOutcome seam (below), so a doc reaching a terminal
  // status triggers a run-completeness check → one HMAC-signed terminal event.
  const emitter = new TerminalEmitter(docState, runStore, log);
  const completion = new CompletionMonitor(docState, runStore, emitter, log);

  const pipeline = buildPipeline({
    queue,
    blob,
    log,
    bnf: new LiveBnfClient(),
    docState,
    describer: new LiveDescriber(),
    ocr: new LiveOcrEngine(),
    embedder: new LiveEmbedder(),
    cluster: new LiveClusterSink(),
    onOutcome: (e) => completion.noteOutcome({ kind: e.kind, payload: e.payload }),
    rates: { fetch: fetchRate, manifest: manifestRate },
    config: {
      mistralEnabled: cfg.mistralEnabled,
      maxPages: cfg.maxPages,
      maxCanvases: cfg.maxCanvases,
      fetchConcurrency: cfg.fetchConcurrency,
      describeConcurrency: cfg.describeConcurrency,
      embedConcurrency: cfg.embedConcurrency,
      ocrSubmitConcurrency: cfg.ocrSubmitConcurrency,
      ocrPollConcurrency: cfg.ocrPollConcurrency,
      failRatio: cfg.failRatio,
    },
  });

  await pipeline.start();

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
    },
    cfg.httpPort,
  );

  log.info("worker_v2_up", {
    httpPort: cfg.httpPort,
    fetchRatePerMin: cfg.fetchRatePerMin,
    manifestRatePerMin: cfg.manifestRatePerMin,
    mistralEnabled: cfg.mistralEnabled,
  });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("worker_v2_shutdown", { sig });
    fetchRate.stop();
    manifestRate.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await pipeline.stop().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker-v2] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
