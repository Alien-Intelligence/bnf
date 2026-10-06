/**
 * The live pipeline, wired once: the OCR-backfill wiring, the BnF rate gates
 * (mirroring the broker's buckets) and the stages with their live ports. The
 * worker entrypoint (main.ts) starts it; the requeue-stranded CLI only declares
 * its queue policies, so a message it re-sends carries exactly the policy a
 * live worker would give it. No I/O here: constructing ports and gates opens
 * nothing.
 */
import type { Pool } from "pg";

import { etaFetchRatePerMin, gateRates, type IiifBases, type WorkerConfig } from "./config.js";
import { buildPipeline } from "./build.js";
import type { S3BlobStore } from "./core/blob.js";
import type { Pipeline } from "./core/pipeline.js";
import { CompositeRateGate, RateLimiter } from "./core/rate.js";
import type { Logger, QueueClient } from "./core/types.js";
import type { PgDocState } from "./domain/doc-state-pg.js";
import {
  OCR_BACKFILL_MAX_ATTEMPTS,
  OCR_BACKFILL_STARTED_STALE_MS,
  OCR_BACKFILL_UNSENT_STALE_MS,
  OCR_BACKFILL_UNSTARTED_STALE_MS,
  validateOcrBackfillPolicy,
  type OcrBackfillWiring,
} from "./domain/ocr-backfill.js";
import { PgOcrBackfillStore } from "./domain/ocr-backfill-pg.js";
import { LiveBnfClient } from "./bnf/client.js";
import { LiveDescriber } from "./live/describer.js";
import { LiveOcrEngine } from "./live/ocr.js";
import { LiveEmbedder } from "./live/embedder.js";
import { LiveClusterSink } from "./live/cluster.js";
import type { CompletionMonitor } from "./live/completion-monitor.js";

export type LivePipelineDeps = {
  cfg: WorkerConfig;
  iiif: IiifBases;
  queue: QueueClient;
  pool: Pool;
  docState: PgDocState;
  blob: S3BlobStore;
  log: Logger;
  completion: CompletionMonitor;
};

export type LivePipeline = {
  pipeline: Pipeline;
  ocrBackfill: OcrBackfillWiring;
  /** The limiters the gates compose — what shutdown stops. */
  limiters: RateLimiter[];
  fetchRatePerMin: number;
};

export function buildLivePipeline(deps: LivePipelineDeps): LivePipeline {
  const { cfg, iiif, queue, pool, docState, blob, log, completion } = deps;
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

  // The broker's buckets, mirrored (same values, same chart keys): one
  // limiter per quota, and one composite per kind of call, most specific
  // first. ALTO and image fetches also share a BULK limiter that keeps
  // global room for the metadata lookups of the same ingest, and the manifest
  // gate takes only the worker's share of the manifest bucket (gateRates,
  // config.ts — the 2026-10-06 starvation). The composites own nothing — the
  // five limiters are what shutdown stops.
  const shares = gateRates(cfg.rates);
  const globalRate = new RateLimiter({ ratePerMin: cfg.rates.globalRpm });
  const bulkRate = new RateLimiter({ ratePerMin: shares.bulkRpm });
  const presentationRate = new RateLimiter({ ratePerMin: cfg.rates.presentationRpm });
  const imageRate = new RateLimiter({ ratePerMin: cfg.rates.imageRpm });
  const manifestRate = new RateLimiter({ ratePerMin: shares.manifestRpm });
  const gates = {
    fetchAlto: new CompositeRateGate([presentationRate, bulkRate, globalRate]),
    fetchImage: new CompositeRateGate([imageRate, bulkRate, globalRate]),
    manifest: new CompositeRateGate([manifestRate, presentationRate, globalRate]),
  };
  const fetchRatePerMin = etaFetchRatePerMin(cfg.rates);

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
    rates: gates,
    config: {
      altoFetchConcurrency: cfg.altoFetchConcurrency,
      imageFetchConcurrency: cfg.imageFetchConcurrency,
      mistralEnabled: cfg.mistralEnabled,
      maxPages: cfg.maxPages,
      maxCanvases: cfg.maxCanvases,
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

  return {
    pipeline,
    ocrBackfill,
    limiters: [globalRate, bulkRate, presentationRate, imageRate, manifestRate],
    fetchRatePerMin,
  };
}
