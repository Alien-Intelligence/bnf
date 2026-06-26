/**
 * OCR poll stage — mistral lane, step 2 of 2. A cheap poller: check the batch's
 * status; while it's pending, re-enqueue the pointer to itself (with a delay in
 * prod via the queue's startAfter; the memory queue re-delivers immediately) so
 * the wait costs a queue row, not a worker slot. On completion, fetch the
 * folio-aligned OCR pages, persist them, and emit a PreparedDoc to embedding.
 *
 * Does NOT use the base outcome cache: the pending path's effect is a self
 * re-enqueue, which a cached `done` re-dispatch would silently drop (polling would
 * stall). Idempotency comes from the downstream embed stage's artifact cache.
 * `maxPolls` bounds a stuck batch → terminal `ocr_timeout` (no unbounded loop).
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import type { OcrEngine } from "../ports.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { OcrBatchRef, PreparedDoc } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

export interface OcrPollOpts {
  /** Cap on poll iterations before declaring the batch stuck (terminal). */
  maxPolls?: number;
  /** Delay between polls (ms) — pg-boss startAfter; memory queue ignores it. */
  pollDelayMs?: number;
  /** In-flight poll concurrency (cheap GETs). */
  concurrency?: number;
}

export class OcrPollStage extends PipelineStage<OcrBatchRef, PreparedDoc> {
  readonly name = "ocr-poll";
  readonly inputQueue = Q.ocrPoll;
  override readonly outputQueue = Q.embed;
  override readonly concurrency: number;

  private readonly maxPolls: number;
  private readonly pollDelayMs: number;

  constructor(
    deps: StageDeps,
    private readonly ocr: OcrEngine,
    private readonly docState: DocStateStore,
    opts: OcrPollOpts = {},
  ) {
    super(deps);
    this.maxPolls = opts.maxPolls ?? 240; // ~ default poll cap (tune per pollDelayMs)
    this.pollDelayMs = opts.pollDelayMs ?? 15_000;
    this.concurrency = opts.concurrency ?? 8;
  }

  async process(ref: OcrBatchRef, ctx: StageContext): Promise<StageOutcome<PreparedDoc>> {
    const status = await this.ocr.pollBatch(ref.batchId);

    if (status.state === "failed") {
      return failDoc(this.docState, ref.docJobId, `ocr_batch_failed: ${status.reason}`);
    }

    if (status.state === "pending") {
      const attempt = (ref.pollAttempt ?? 0) + 1;
      if (attempt > this.maxPolls) {
        ctx.log.warn("ocr_poll_timeout", { ark: ref.ark, batchId: ref.batchId, attempt });
        return failDoc(this.docState, ref.docJobId, "ocr_timeout");
      }
      await this.queue.send(
        Q.ocrPoll,
        { ...ref, pollAttempt: attempt },
        { startAfterMs: this.pollDelayMs },
      );
      return { kind: "done" }; // this delivery is consumed; the re-enqueue carries on
    }

    // done
    const pages = status.pages.filter((p) => p.text.trim().length > 0);
    if (pages.length === 0) {
      return failDoc(this.docState, ref.docJobId, "ocr_no_text");
    }
    await this.blob.putJson(keys.pages(ref.ark), pages);
    ctx.log.info("ocr_done", { ark: ref.ark, batchId: ref.batchId, pages: pages.length });
    const prepared: PreparedDoc = {
      projectId: ref.projectId,
      docJobId: ref.docJobId,
      ark: ref.ark,
      lane: "mistral",
      meta: ref.meta,
      pages,
    };
    return { kind: "emit", items: [prepared] };
  }
}
