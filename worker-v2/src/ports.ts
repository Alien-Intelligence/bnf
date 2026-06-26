/**
 * External-service ports — the narrow seams between the pipeline stages and the
 * heavy third-party clients (Holo/Gemini vision, Mistral OCR, RunPod embeddings,
 * the data-cluster sink). Every stage depends ONLY on these interfaces, so:
 *   - the dataflow is unit-testable end-to-end with in-memory fakes, and
 *   - the live clients (ported/vendored from V1) are the only code that does I/O.
 *
 * The BnF seam lives in ./bnf/types.ts (BnfClient); these are the downstream lanes.
 * All methods throw on hard failure — the stage base coerces a throw into a
 * non-terminal fail (→ retry); a stage maps a known-terminal condition to a
 * terminal fail itself.
 */
import type { DocMeta, PreparedPage } from "./domain/types.js";

/** Vision lane — describe ONE folio image (Holo/Gemini), returning page text. */
export interface Describer {
  describe(input: {
    ark: string;
    ordre: number;
    image: Buffer;
    meta: DocMeta;
  }): Promise<string>;
}

/** Mistral OCR lane — async Batch API: submit once, poll until complete. */
export interface OcrEngine {
  /** Submit one batch (one doc's folios). Returns the provider batch id. */
  submitBatch(input: {
    ark: string;
    folios: Array<{ ordre: number; image: Buffer }>;
  }): Promise<{ batchId: string }>;
  /** Poll a batch. `pending` → keep polling; `done`/`failed` are terminal. */
  pollBatch(batchId: string): Promise<OcrBatchStatus>;
}

export type OcrBatchStatus =
  | { state: "pending" }
  | { state: "done"; pages: PreparedPage[] }
  | { state: "failed"; reason: string };

/** RunPod (or any) embedder — vectors for a doc's page texts. */
export interface Embedder {
  /** Embed N texts → N vectors (same order). */
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
}

/** The data-cluster sink — ensure the project dataset, then upsert the doc. */
export interface ClusterSink {
  ensureDataset(input: { projectId: string }): Promise<{ datasetId: number }>;
  upsert(input: {
    datasetId: number;
    ark: string;
    meta: DocMeta;
    pages: PreparedPage[];
    embeddings: number[][];
  }): Promise<{ entryId: number }>;
}
