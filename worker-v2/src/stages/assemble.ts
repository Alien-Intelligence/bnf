/**
 * Assemble stage — text lane. The doc's ALTO folios are all in S3 (the Monitor
 * routed it here once fan-in completed). Read them back in folio order, build the
 * doc's text pages (dropping legitimately-empty folios), persist the pages to S3,
 * and emit a PreparedDoc to the embedding queue. Folio order is preserved from
 * DocReady.folios (sorted ordres) so citations stay folio-accurate.
 *
 * Re-reads the ALTO folios from S3 each run (cheap) and emits a PreparedDoc built
 * from the INCOMING DocReady's identity — it does NOT use the base outcome cache,
 * whose replayed payload would carry a prior job's docJobId/projectId on a
 * re-ingest (the fetch-cache identity bug, 2026-06-26).
 */
import { PipelineStage, type StageDeps } from "../core/stage.js";
import type { StageContext, StageOutcome } from "../core/types.js";
import type { DocStateStore } from "../domain/doc-state.js";
import { keys } from "../domain/keys.js";
import { Q } from "../domain/queues.js";
import type { DocReady, PreparedDoc, PreparedPage } from "../domain/types.js";
import { failDoc } from "./doc-fail.js";

export class AssembleStage extends PipelineStage<DocReady, PreparedDoc> {
  readonly name = "assemble";
  readonly inputQueue = Q.assemble;
  override readonly outputQueue = Q.embed;
  override readonly concurrency = 8;

  constructor(
    deps: StageDeps,
    private readonly docState: DocStateStore,
  ) {
    super(deps);
  }

  async process(doc: DocReady, ctx: StageContext): Promise<StageOutcome<PreparedDoc>> {
    const pages: PreparedPage[] = [];
    for (const ordre of doc.folios) {
      const bytes = await this.blob.getBytes(keys.alto(doc.ark, ordre));
      const text = bytes ? bytes.toString("utf8").trim() : "";
      if (text.length > 0) pages.push({ ordre, text });
    }
    if (pages.length === 0) {
      return failDoc(this.docState, doc.docJobId, "assemble_no_text");
    }
    await this.blob.putJson(keys.pages(doc.ark), pages);
    ctx.log.info("assembled", { ark: doc.ark, pages: pages.length });
    const prepared: PreparedDoc = {
      projectId: doc.projectId,
      docJobId: doc.docJobId,
      ark: doc.ark,
      lane: "text",
      meta: doc.meta,
      pages,
    };
    return { kind: "emit", items: [prepared] };
  }
}
