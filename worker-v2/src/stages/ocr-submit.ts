/**
 * OCR submit stage — mistral lane, step 1 of 2. The doc's image folios are in S3.
 * Submit ONE Mistral Batch over them (folio custom_id integrity), persist the
 * batch handle, and emit an OcrBatchRef to the poll queue. Returns immediately —
 * the ~25-min Batch-API latency lives entirely off the critical path (the poll
 * stage waits, not a worker slot — V1's killer bug, fixed structurally).
 *
 * Paid operation → MUST NOT re-submit on redelivery. Dedupe explicitly via the
 * batch handle in S3 (keys.ocrBatch): a redelivered submit reuses the existing
 * batch_id and re-emits the poll pointer rather than paying twice. (So it does
 * NOT use the base outcome cache, whose re-dispatch could mask a re-submit.)
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import type { OcrEngine } from "../ports.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { DocReady, OcrBatchRef } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

interface BatchHandle {
  batchId: string;
  folios: number[];
}

export class OcrSubmitStage extends PipelineStage<DocReady, OcrBatchRef> {
  readonly name = "ocr-submit";
  readonly inputQueue = Q.ocrSubmit;
  override readonly outputQueue = Q.ocrPoll;
  override readonly concurrency = 4;

  constructor(
    deps: StageDeps,
    private readonly ocr: OcrEngine,
    private readonly docState: DocStateStore,
  ) {
    super(deps);
  }

  async process(doc: DocReady, ctx: StageContext): Promise<StageOutcome<OcrBatchRef>> {
    let handle = await this.blob.getJson<BatchHandle>(keys.ocrBatch(doc.ark));
    if (!handle) {
      const folios: Array<{ ordre: number; image: Buffer }> = [];
      for (const ordre of doc.folios) {
        const image = await this.blob.getBytes(keys.image(doc.ark, ordre));
        if (image) folios.push({ ordre, image });
      }
      if (folios.length === 0) {
        return failDoc(this.docState, doc.docJobId, "ocr_submit_no_images");
      }
      const { batchId } = await this.ocr.submitBatch({ ark: doc.ark, folios });
      handle = { batchId, folios: folios.map((f) => f.ordre) };
      await this.blob.putJson(keys.ocrBatch(doc.ark), handle);
      ctx.log.info("ocr_submitted", { ark: doc.ark, batchId, folios: handle.folios.length });
    } else {
      ctx.log.info("ocr_submit_dedup", { ark: doc.ark, batchId: handle.batchId });
    }
    const ref: OcrBatchRef = {
      projectId: doc.projectId,
      docJobId: doc.docJobId,
      ark: doc.ark,
      lane: "mistral",
      meta: doc.meta,
      batchId: handle.batchId,
      folios: handle.folios,
      pollAttempt: 0,
    };
    return { kind: "emit", items: [ref] };
  }
}
