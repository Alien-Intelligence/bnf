/**
 * Register stage — terminal. Reads the doc's pages + embeddings back from S3 and
 * upserts them into the project's data-cluster dataset (the RAG store). On success
 * it writes a registration receipt to S3 and flips the doc-state row to `done`.
 *
 * Registration is distinct from embedding (it can lag or fail independently — the
 * observability model counts it separately). Idempotent via the receipt: a
 * redelivered doc whose receipt already exists just confirms `done` and stops, so
 * it never double-inserts into the cluster.
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import type { ClusterSink } from "../ports.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { EmbeddedDoc, PreparedPage } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

interface EmbeddingsBlob {
  dim: number;
  vectors: number[][];
}
interface Receipt {
  datasetId: number;
  entryId: number;
}

export class RegisterStage extends PipelineStage<EmbeddedDoc, never> {
  readonly name = "register";
  readonly inputQueue = Q.register;
  override readonly concurrency = 4;

  constructor(
    deps: StageDeps,
    private readonly cluster: ClusterSink,
    private readonly docState: DocStateStore,
  ) {
    super(deps);
  }

  async process(doc: EmbeddedDoc, ctx: StageContext): Promise<StageOutcome<never>> {
    const existing = await this.blob.getJson<Receipt>(keys.registered(doc.ark));
    if (existing) {
      await this.docState.setStatus(doc.docJobId, "done");
      ctx.log.info("register_dedup", { ark: doc.ark, entryId: existing.entryId });
      return { kind: "done" };
    }

    const pages = await this.blob.getJson<PreparedPage[]>(keys.pages(doc.ark));
    const embeddings = await this.blob.getJson<EmbeddingsBlob>(doc.embeddingsKey);
    if (!pages || !embeddings) {
      return failDoc(this.docState, doc.docJobId, "register_missing_artifacts");
    }

    try {
      const { datasetId } = await this.cluster.ensureDataset({ projectId: doc.projectId });
      const { entryId } = await this.cluster.upsert({
        datasetId,
        ark: doc.ark,
        meta: doc.meta,
        pages,
        embeddings: embeddings.vectors,
      });
      await this.blob.putJson(keys.registered(doc.ark), { datasetId, entryId } satisfies Receipt);
      await this.docState.setStatus(doc.docJobId, "done");
      ctx.log.info("registered", { ark: doc.ark, datasetId, entryId, pages: pages.length });
      return { kind: "done" };
    } catch (e) {
      // The cluster sink is flaky/slow (real backend). Retry while attempts remain;
      // on the last attempt mark the doc failed so it reaches a terminal state
      // rather than orphaning in 'ready' when the queue exhausts its retries.
      if (ctx.attempt >= this.retry.attempts) {
        const reason = `register_failed_after_retries: ${e instanceof Error ? e.message : String(e)}`;
        return failDoc(this.docState, doc.docJobId, reason);
      }
      throw e;
    }
  }
}
