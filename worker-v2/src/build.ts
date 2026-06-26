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
import type { ClusterSink, Describer, Embedder, OcrEngine } from "./ports.js";

import { MetadataStage } from "./stages/metadata.js";
import { ManifestStage } from "./stages/manifest.js";
import { FetchStage } from "./stages/fetch.js";
import { MonitorStage } from "./stages/monitor.js";
import { AssembleStage } from "./stages/assemble.js";
import { DescribeStage } from "./stages/describe.js";
import { OcrSubmitStage } from "./stages/ocr-submit.js";
import { OcrPollStage } from "./stages/ocr-poll.js";
import { EmbedStage } from "./stages/embed.js";
import { RegisterStage } from "./stages/register.js";

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
  /** Optional per-dispatch observability hook (also feeds the read-model). */
  onOutcome?: StageDeps["onOutcome"];
  /** Per-stage rate gates (undefined → unthrottled, e.g. in tests). */
  rates?: {
    manifest?: RateGate;
    fetch?: RateGate;
    describe?: RateGate;
    embed?: RateGate;
  };
  config?: {
    mistralEnabled?: boolean;
    maxPages?: number;
    maxCanvases?: number;
    imageSize?: string;
    visionImageSize?: string;
    fetchConcurrency?: number;
    describeConcurrency?: number;
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
  const cfg = deps.config ?? {};
  const rates = deps.rates ?? {};

  const stages: RunnableStage[] = [
    new MetadataStage(base, deps.bnf, deps.docState, {
      mistralEnabled: cfg.mistralEnabled ?? false,
      ...(cfg.maxPages !== undefined ? { maxPages: cfg.maxPages } : {}),
    }),
    new ManifestStage(base, deps.bnf, deps.docState, rates.manifest, {
      ...(cfg.maxCanvases !== undefined ? { maxCanvases: cfg.maxCanvases } : {}),
    }),
    new FetchStage(base, deps.bnf, rates.fetch, {
      ...(cfg.imageSize !== undefined ? { imageSize: cfg.imageSize } : {}),
      ...(cfg.visionImageSize !== undefined ? { visionImageSize: cfg.visionImageSize } : {}),
      ...(cfg.fetchConcurrency !== undefined ? { concurrency: cfg.fetchConcurrency } : {}),
    }),
    new MonitorStage(base, deps.docState, {
      ...(cfg.failRatio !== undefined ? { failRatio: cfg.failRatio } : {}),
    }),
    new AssembleStage(base, deps.docState),
    new DescribeStage(base, deps.describer, deps.docState, rates.describe, {
      ...(cfg.describeConcurrency !== undefined ? { concurrency: cfg.describeConcurrency } : {}),
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
    new RegisterStage(base, deps.cluster, deps.docState),
  ];

  return new Pipeline(queue, stages, log);
}
