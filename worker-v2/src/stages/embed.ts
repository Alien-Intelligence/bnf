/**
 * Embed stage — the convergence point of all three lanes. A PreparedDoc (text /
 * vision descriptions / mistral OCR — all the same shape by here) → embed every
 * page text → persist the vectors to S3 → emit an EmbeddedDoc pointer to register.
 *
 * Pure transform (embeddings S3 write + emit), so the base outcome cache gives
 * free resume: a redelivered doc re-emits without re-spending GPU time.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { RateGate, StageContext, StageOutcome } from "../core/types.js";
import type { Embedder } from "../ports.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { EmbeddedDoc, PreparedDoc } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

interface EmbeddingsBlob {
  dim: number;
  vectors: number[][];
}

export class EmbedStage extends PipelineStage<PreparedDoc, EmbeddedDoc> {
  readonly name = "embed";
  readonly inputQueue = Q.embed;
  override readonly outputQueue = Q.register;
  override readonly concurrency: number;
  override readonly rate?: RateGate;

  constructor(
    deps: StageDeps,
    private readonly embedder: Embedder,
    private readonly docState: DocStateStore,
    rate: RateGate | undefined,
    opts: { concurrency?: number } = {},
  ) {
    super(deps);
    this.rate = rate;
    this.concurrency = opts.concurrency ?? 4;
  }

  protected override async onExhausted(doc: PreparedDoc, reason: string): Promise<void> {
    await this.docState.setStatus(doc.docJobId, "failed", {
      error: `embed_failed_after_retries: ${reason}`,
    });
  }

  async process(doc: PreparedDoc, ctx: StageContext): Promise<StageOutcome<EmbeddedDoc>> {
    if (doc.pages.length === 0) {
      return failDoc(this.docState, doc.docJobId, "embed_no_pages");
    }
    // Resume from the embeddings artifact, NOT the base outcome cache (which would
    // replay a prior job's identity on a re-ingest). If the vectors are already in
    // S3 for this ARK (and align with the page count), skip the GPU call and emit
    // an EmbeddedDoc built from THIS message's identity.
    const cached = await this.blob.getJson<EmbeddingsBlob>(keys.embeddings(doc.ark));
    if (cached && cached.vectors.length === doc.pages.length) {
      ctx.log.info("embed_cache_hit", { ark: doc.ark, pages: doc.pages.length });
      return { kind: "emit", items: [this.emitted(doc)] };
    }

    const vectors = await this.embedder.embed(doc.pages.map((p) => p.text));
    if (vectors.length !== doc.pages.length) {
      // A vector/page count mismatch would misalign citations — fail loudly.
      return failDoc(
        this.docState,
        doc.docJobId,
        `embed_count_mismatch ${vectors.length}/${doc.pages.length}`,
      );
    }
    const blob: EmbeddingsBlob = { dim: this.embedder.dim, vectors };
    await this.blob.putJson(keys.embeddings(doc.ark), blob);
    ctx.log.info("embedded", { ark: doc.ark, pages: doc.pages.length, dim: this.embedder.dim });
    return { kind: "emit", items: [this.emitted(doc)] };
  }

  private emitted(doc: PreparedDoc): EmbeddedDoc {
    return {
      projectId: doc.projectId,
      docJobId: doc.docJobId,
      ark: doc.ark,
      meta: doc.meta,
      embeddingsKey: keys.embeddings(doc.ark),
      pageCount: doc.pages.length,
    };
  }
}
