/**
 * Register stage — terminal. Reads the doc's pages + embeddings back from S3 and
 * upserts them into the project's data-cluster dataset (the RAG store). On success
 * it writes a registration receipt to S3 and flips the doc-state row to `done`.
 *
 * Registration is distinct from embedding (it can lag or fail independently — the
 * observability model counts it separately). Idempotent via the receipt: a
 * redelivered doc whose receipt already exists just confirms `done` and stops, so
 * it never double-inserts into the cluster.
 *
 * Receipt identity (F16, ai-memories/tech/repos/bnf/ingest-hardening): the receipt
 * is scoped by (projectId, ark) — see keys.registered's doc comment for why and
 * for the migration decision on pre-existing global receipts (ignored, not read).
 * Trusting a receipt additionally requires its `datasetId` to match the project's
 * CURRENT dataset (via `ensureDataset`): a project whose dataset was deleted and
 * recreated gets a new numeric id, and a receipt pointing at the old id must be
 * treated as stale — re-upsert and overwrite it, rather than silently no-op.
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
  override readonly concurrency: number;

  /**
   * Per-project dataset id, memoized for this process's lifetime.
   * `cluster.ensureDataset` is a real network round-trip (GET dataset-by-slug,
   * POST create on a miss) against the data-cluster proxy — and with the F16
   * receipt check now needing it on EVERY delivery (not only the fresh-upsert
   * path), memoizing avoids doubling that cost per doc for the common case of
   * one project's docs streaming through this stage in the same run.
   *
   * Accepted trade-off: if a project's dataset is deleted and recreated WHILE
   * this process already holds a memoized id for that project, the memo is
   * stale until something evicts it — a receipt compared against a stale memo
   * can read as a spurious match. Dataset deletion is an out-of-band app
   * action, not a thing that races a live register call, so this window is
   * narrow; and the failure mode on the other side (an upsert against a dead
   * datasetId) fails LOUDLY rather than silently, which is what evicts the
   * memo (see the catch block below) so the next delivery re-resolves fresh.
   * No TTL, no explicit bust hook — simple over clever.
   */
  private readonly datasetIdByProject = new Map<string, number>();

  constructor(
    deps: StageDeps,
    private readonly cluster: ClusterSink,
    private readonly docState: DocStateStore,
    opts: { concurrency?: number } = {},
  ) {
    super(deps);
    // Indexing into the data cluster (which autoscales). Default 4; raise to drain
    // the register backlog when the cluster can take the load.
    this.concurrency = opts.concurrency ?? 4;
  }

  private async resolveDatasetId(projectId: string): Promise<number> {
    const cached = this.datasetIdByProject.get(projectId);
    if (cached !== undefined) return cached;
    const { datasetId } = await this.cluster.ensureDataset({ projectId });
    this.datasetIdByProject.set(projectId, datasetId);
    return datasetId;
  }

  async process(doc: EmbeddedDoc, ctx: StageContext): Promise<StageOutcome<never>> {
    const receiptKey = keys.registered(doc.projectId, doc.ark);
    const existing = await this.blob.getJson<Receipt>(receiptKey);

    let datasetId: number;
    try {
      datasetId = await this.resolveDatasetId(doc.projectId);
    } catch (e) {
      this.datasetIdByProject.delete(doc.projectId);
      if (ctx.attempt >= this.retry.attempts) {
        const reason = `register_ensure_dataset_failed_after_retries: ${e instanceof Error ? e.message : String(e)}`;
        return failDoc(this.docState, doc.docJobId, reason);
      }
      throw e;
    }

    if (existing && existing.datasetId === datasetId) {
      await this.docState.setStatus(doc.docJobId, "done");
      ctx.log.info("register_dedup", {
        ark: doc.ark,
        projectId: doc.projectId,
        entryId: existing.entryId,
      });
      return { kind: "done" };
    }
    if (existing) {
      // Receipt exists but points at a dataset that is no longer this project's
      // current one (deleted/recreated) — fall through and re-upsert.
      ctx.log.info("register_receipt_stale", {
        ark: doc.ark,
        projectId: doc.projectId,
        receiptDatasetId: existing.datasetId,
        currentDatasetId: datasetId,
      });
    }

    const pages = await this.blob.getJson<PreparedPage[]>(keys.pages(doc.ark));
    const embeddings = await this.blob.getJson<EmbeddingsBlob>(doc.embeddingsKey);
    if (!pages || !embeddings) {
      return failDoc(this.docState, doc.docJobId, "register_missing_artifacts");
    }

    try {
      const { entryId } = await this.cluster.upsert({
        datasetId,
        ark: doc.ark,
        meta: doc.meta,
        pages,
        embeddings: embeddings.vectors,
      });
      await this.blob.putJson(receiptKey, { datasetId, entryId } satisfies Receipt);
      await this.docState.setStatus(doc.docJobId, "done");
      ctx.log.info("registered", {
        ark: doc.ark,
        projectId: doc.projectId,
        datasetId,
        entryId,
        pages: pages.length,
      });
      return { kind: "done" };
    } catch (e) {
      // The cluster sink is flaky/slow (real backend), OR datasetId is stale
      // (evicted below so the next delivery re-resolves it). Retry while
      // attempts remain; on the last attempt mark the doc failed so it reaches
      // a terminal state rather than orphaning in 'ready' when the queue
      // exhausts its retries.
      this.datasetIdByProject.delete(doc.projectId);
      if (ctx.attempt >= this.retry.attempts) {
        const reason = `register_failed_after_retries: ${e instanceof Error ? e.message : String(e)}`;
        return failDoc(this.docState, doc.docJobId, reason);
      }
      throw e;
    }
  }
}
