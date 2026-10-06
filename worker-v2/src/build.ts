/**
 * Composition root — wires the ten stages into a Pipeline given the transport,
 * blob store, logger, the BnF client, the four downstream ports, the doc-state
 * store, and the per-stage rate gates. Both the real worker entrypoint and the
 * integration tests build the pipeline through here, so the topology lives in ONE
 * place and tests exercise the exact wiring that ships.
 */
import { Pipeline, type RunnableStage } from "./core/pipeline.js";
import type { BlobStore, Logger, QueueClient, RateGate } from "./core/types.js";
import type { StageDeps } from "./core/stage.js";
import type { BnfClient } from "./bnf/types.js";
import type { DocStateStore } from "./domain/doc-state.js";
import type { OcrBackfillWiring } from "./domain/ocr-backfill.js";
import type { ClusterSink, Describer, Embedder, OcrEngine } from "./ports.js";

import { MetadataStage } from "./stages/metadata.js";
import { ManifestStage } from "./stages/manifest.js";
import { FetchAltoStage, FetchImageStage } from "./stages/fetch.js";
import { MonitorStage } from "./stages/monitor.js";
import { AssembleStage } from "./stages/assemble.js";
import { DescribeStage } from "./stages/describe.js";
import { OcrSubmitStage } from "./stages/ocr-submit.js";
import { OcrPollStage } from "./stages/ocr-poll.js";
import { EmbedStage } from "./stages/embed.js";
import { RegisterStage } from "./stages/register.js";
import { OCR_BACKFILL_RATE_WAIT_MS, OcrQualityBackfillStage } from "./stages/ocr-quality-backfill.js";

export interface PipelineDeps {
  queue: QueueClient;
  blob: BlobStore;
  log: Logger;
  bnf: BnfClient;
  docState: DocStateStore;
  describer: Describer;
  ocr: OcrEngine;
  embedder: Embedder;
  cluster: ClusterSink;
  /**
   * The OCR-quality backfill as main.ts wired it — the SAME object the HTTP
   * server gets. The stage is registered exactly when `enabled`, on
   * `rates.fetchAlto` (required then), the SAME gate FetchAltoStage holds: the
   * backfill fetches ALTO on the Presentation API.
   */
  ocrBackfill: OcrBackfillWiring;
  /** Optional per-dispatch observability hook (also feeds the read-model). */
  onOutcome?: StageDeps["onOutcome"];
  /**
   * Per-stage rate gates (undefined → unthrottled, e.g. in tests). In
   * production each BnF gate is a CompositeRateGate mirroring the broker's
   * buckets (main.ts): manifest = manifest ∧ presentation ∧ global,
   * fetchAlto = presentation ∧ global, fetchImage = image ∧ global.
   */
  rates?: {
    manifest?: RateGate;
    fetchAlto?: RateGate;
    fetchImage?: RateGate;
    describe?: RateGate;
    embed?: RateGate;
  };
  config: {
    /** In-flight ALTO fetches (BNF_ALTO_FETCH_CONCURRENCY). */
    altoFetchConcurrency: number;
    /** In-flight image fetches (BNF_IMAGE_FETCH_CONCURRENCY). */
    imageFetchConcurrency: number;
    mistralEnabled?: boolean;
    maxPages?: number;
    maxCanvases?: number;
    metadataConcurrency?: number;
    registerConcurrency?: number;
    describeConcurrency?: number;
    describeCallConcurrency?: number;
    embedConcurrency?: number;
    ocrSubmitConcurrency?: number;
    ocrPollConcurrency?: number;
    failRatio?: number;
    ocrMaxPolls?: number;
    ocrPollDelayMs?: number;
  };
}

export function buildPipeline(deps: PipelineDeps): Pipeline {
  const { queue, blob, log, onOutcome } = deps;
  const base: StageDeps = { queue, blob, log, ...(onOutcome ? { onOutcome } : {}) };
  const cfg = deps.config;
  const rates = deps.rates ?? {};

  const stages: RunnableStage[] = [
    // rates.manifest is THE SAME RateGate instance passed to ManifestStage below —
    // that sharing is the invariant the 2026-08-11 rate-collapse fix depends on
    // (one manifest budget, one gate, no matter which stage needs the manifest
    // first). maxCanvases is likewise the SAME cfg value ManifestStage gets, so
    // the manifest blob the two stages share is produced identically either way.
    new MetadataStage(base, deps.bnf, deps.docState, rates.manifest, {
      mistralEnabled: cfg.mistralEnabled ?? false,
      ...(cfg.maxPages !== undefined ? { maxPages: cfg.maxPages } : {}),
      ...(cfg.maxCanvases !== undefined ? { maxCanvases: cfg.maxCanvases } : {}),
      ...(cfg.metadataConcurrency !== undefined ? { concurrency: cfg.metadataConcurrency } : {}),
    }),
    new ManifestStage(base, deps.bnf, deps.docState, rates.manifest, {
      ...(cfg.maxCanvases !== undefined ? { maxCanvases: cfg.maxCanvases } : {}),
    }),
    // Two fetch stages, two queues, two gates (stages/fetch.ts): images
    // waiting on the scarce Image quota never hold the slots ALTO needs.
    new FetchAltoStage(base, deps.bnf, rates.fetchAlto, { concurrency: cfg.altoFetchConcurrency }),
    new FetchImageStage(base, deps.bnf, rates.fetchImage, { concurrency: cfg.imageFetchConcurrency }),
    new MonitorStage(base, deps.docState, {
      ...(cfg.failRatio !== undefined ? { failRatio: cfg.failRatio } : {}),
    }),
    new AssembleStage(base, deps.docState),
    new DescribeStage(base, deps.describer, deps.docState, rates.describe, {
      ...(cfg.describeConcurrency !== undefined ? { concurrency: cfg.describeConcurrency } : {}),
      ...(cfg.describeCallConcurrency !== undefined ? { callConcurrency: cfg.describeCallConcurrency } : {}),
    }),
    new OcrSubmitStage(base, deps.ocr, deps.docState, {
      ...(cfg.ocrSubmitConcurrency !== undefined ? { concurrency: cfg.ocrSubmitConcurrency } : {}),
    }),
    new OcrPollStage(base, deps.ocr, deps.docState, {
      ...(cfg.ocrMaxPolls !== undefined ? { maxPolls: cfg.ocrMaxPolls } : {}),
      ...(cfg.ocrPollDelayMs !== undefined ? { pollDelayMs: cfg.ocrPollDelayMs } : {}),
      ...(cfg.ocrPollConcurrency !== undefined ? { concurrency: cfg.ocrPollConcurrency } : {}),
    }),
    new EmbedStage(base, deps.embedder, deps.docState, rates.embed, {
      ...(cfg.embedConcurrency !== undefined ? { concurrency: cfg.embedConcurrency } : {}),
    }),
    new RegisterStage(base, deps.cluster, deps.docState, {
      ...(cfg.registerConcurrency !== undefined ? { concurrency: cfg.registerConcurrency } : {}),
    }),
  ];

  // The backfill is not part of a run. It is registered exactly when the wiring
  // says enabled — the same flag the endpoint obeys — so OCR_BACKFILL_ENABLED=
  // false truly stops its BnF spend (D6) and an enabled endpoint always has a
  // consumer for what it enqueues.
  if (deps.ocrBackfill.enabled) {
    if (!rates.fetchAlto) {
      throw new Error("buildPipeline: the OCR backfill stage requires rates.fetchAlto (the shared ALTO fetch gate)");
    }
    stages.push(
      new OcrQualityBackfillStage(base, deps.bnf, deps.ocrBackfill.store, rates.fetchAlto, {
        concurrency: deps.ocrBackfill.concurrency,
        rateWaitMs: OCR_BACKFILL_RATE_WAIT_MS,
      }),
    );
  }

  return new Pipeline(queue, stages, log);
}
